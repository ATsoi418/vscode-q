/**
 * Copyright (c) 2020 Jo Shinonome
 *
 * This software is released under the MIT License.
 * https://opensource.org/licenses/MIT
 */

// import * as fs from 'fs';
import Fuse from 'fuse.js';
import {
    Connection, Diagnostic, DiagnosticSeverity,
    DocumentUri, Location, ParameterInformation,
    Range, SignatureHelp, SignatureInformation, SymbolInformation, SymbolKind, TextDocument
} from 'vscode-languageserver';
import * as Parser from 'web-tree-sitter';
import * as TreeSitterUtil from '../util/tree-sitter';


import klaw = require('klaw');
import fs = require('graceful-fs');
import picomatch = require('picomatch');

type nameToSymbolInfo = Map<string, SymbolInformation[]>;

export type word = {
    type: string,
    text: string,
    range: Range,
    containerName: string,
}
/**
 * The Analyzer analyze Abstract Syntax Trees of tree-sitter-q
 */
export default class QAnalyzer {
    static matchFile: (test: string) => boolean;
    private connection: Connection;
    private rootPath: string | undefined | null;

    public static async fromRoot(
        connection: Connection,
        rootPath: string | undefined | null,
        parser: Parser
    ): Promise<QAnalyzer> {
        return new QAnalyzer(parser, connection, rootPath);
    }

    private parser: Parser
    private uriToTextDocument = new Map<string, TextDocument>();
    private uriToTree = new Map<DocumentUri, Parser.Tree>();
    private uriToFileContent = new Map<DocumentUri, string>();
    private uriToDefinition = new Map<DocumentUri, nameToSymbolInfo>();
    private uriToSymbol = new Map<DocumentUri, string[]>();
    private nameToSigHelp = new Map<string, SignatureHelp>();
    private serverIds: string[] = [];
    private serverSyms: string[] = [];

    public constructor(parser: Parser, connection: Connection, rootPath: string | undefined | null) {
        this.parser = parser;
        this.connection = connection;
        this.rootPath = rootPath;
    }

    /**
     * Find all the definition locations
     */
    public findDefinition(word: word, uri: string): Location[] {
        let symbols: SymbolInformation[] = [];

        if (word.type === 'global_identifier' || word.containerName === '') {
            this.uriToDefinition.forEach(nameToSymInfo => {
                symbols = symbols.concat(nameToSymInfo.get(word.text) || []);
            });
        } else {
            // limited to current file, current function
            symbols = this.uriToDefinition.get(uri)?.get(word.text)?.filter(
                sym => sym.containerName === word.containerName
            ) ?? [];
        }
        return symbols.map(s => s.location);
    }

    /**
     * Find all the symbols matching the query using fuzzy search.
     */
    public search(query: string): SymbolInformation[] {
        const fuse = new Fuse(this.getAllSymbols(), { keys: ['name'] });
        return fuse.search(query).map(result => result.item);
    }

    /**
     * Find all the reference locations
     */
    public findReferences(word: word, uri: string): Location[] {
        let locations: Location[] = [];

        if (word.type === 'global_identifier' || word.containerName === '') {
            // find in all files
            this.uriToTree.forEach((_, u) => locations = locations.concat(this.findSynNodeLocations(u, word)));
        } else {
            // find in current file
            locations = this.findSynNodeLocations(uri, word);
        }
        return locations;
    }


    /**
     * Find all syntax nodes of name in the given file.
     */
    public findSynNodes(uri: string, word: word): Parser.SyntaxNode[] {
        const tree = this.uriToTree.get(uri);
        const content = this.uriToFileContent.get(uri);
        const synNodes: Parser.SyntaxNode[] = [];

        if (tree && content) {
            TreeSitterUtil.forEach(tree.rootNode, n => {
                if (TreeSitterUtil.isReference(n) && n.text.trim() === word.text)
                    synNodes.push(n);
            });
        }

        if (word.type === 'global_identifier' || word.containerName === '') {
            return synNodes;
        } else {
            return synNodes.filter(syn => this.getContainerName(syn) === word.containerName);
        }
    }

    public findSynNodeLocations(uri: string, word: word): Location[] {
        const synNodes = this.findSynNodes(uri, word);
        return synNodes.map(syn => Location.create(uri, TreeSitterUtil.range(syn)));
    }


    public findSynNodeByType(uri: string, type: string): Parser.SyntaxNode[] {
        const tree = this.uriToTree.get(uri);
        const synNodes: Parser.SyntaxNode[] = [];
        if (tree) {
            TreeSitterUtil.forEach(tree.rootNode, n => {
                if (n.type === type) {
                    synNodes.push(n);
                }
            });
        }
        return synNodes;
    }

    /**
     * Find all occurrences of name in the given file.
     * It's currently not scope-aware.
     */
    public findOccurrences(uri: string, query: string): Location[] {
        const tree = this.uriToTree.get(uri);
        const content = this.uriToFileContent.get(uri);
        const locations: Location[] = [];

        if (tree && content) {
            TreeSitterUtil.forEach(tree.rootNode, n => {
                if (TreeSitterUtil.isReference(n) && n.text.trim() === query) {
                    locations.push(Location.create(uri, TreeSitterUtil.range(n)));
                }
            });
        }
        return locations;
    }

    /**
     * Find all symbol definitions in the given file.
     */
    public findSymbolsForFile(uri: string): SymbolInformation[] {
        const nameToSymInfos = this.uriToDefinition.get(uri)?.values();
        return nameToSymInfos ? Array.from(nameToSymInfos).flat() : [];
    }

    /**
     * Find symbol completions for the given word.
     */
    public findSymbolsMatchingWord(
        exactMatch: boolean,
        word: string,
    ): SymbolInformation[] {
        let symbols: SymbolInformation[] = [];

        this.uriToDefinition.forEach((nameToSymInfo) => {
            nameToSymInfo.forEach((syms, name) => {
                const match = exactMatch ? name === word : name.startsWith(word);
                if (match) {
                    symbols = symbols.concat(syms);
                }
            });
        });

        return symbols;
    }

    public analyzeWorkspace(cfg: { globsPattern: string[]; ignorePattern: string[] }): void {
        if (this.rootPath && fs.existsSync(this.rootPath)) {

            this.uriToTextDocument = new Map<string, TextDocument>();
            this.uriToTree = new Map<DocumentUri, Parser.Tree>();
            this.uriToFileContent = new Map<DocumentUri, string>();
            this.uriToDefinition = new Map<DocumentUri, nameToSymbolInfo>();
            this.uriToSymbol = new Map<DocumentUri, string[]>();
            this.nameToSigHelp = new Map<string, SignatureHelp>();

            const globsPattern = cfg.globsPattern ?? ['**/src/**/*.q'];
            const ignorePattern = cfg.ignorePattern ?? ['**/tmp'];

            this.connection.console.info(
                `Analyzing files matching glob "${globsPattern}" inside ${this.rootPath}`,
            );

            const lookupStartTime = Date.now();
            const getTimePassed = (): string =>
                `${(Date.now() - lookupStartTime) / 1000} seconds`;

            const ignoreMatch = picomatch(ignorePattern);
            const includeMatch = picomatch(globsPattern);
            QAnalyzer.matchFile = (test) => !ignoreMatch(test) && includeMatch(test);
            const qSrcFiles: string[] = [];
            klaw(this.rootPath, { filter: item => !ignoreMatch(item) })
                .on('error', (err: Error, _item: klaw.Item) => {
                    this.connection.console.warn(err.message);
                })
                .on('data', item => { if (includeMatch(item.path)) qSrcFiles.push(item.path); })
                .on('end', () => {
                    if (qSrcFiles.length == 0) {
                        this.connection.window.showWarningMessage(
                            `Failed to find any q source files using the glob "${globsPattern}". Some feature will not be available.`,
                        );
                    }

                    this.connection.console.info(
                        `Glob found ${qSrcFiles.length} files after ${getTimePassed()}`,
                    );

                    qSrcFiles.forEach((filepath: string) => {
                        const uri = `file://${filepath}`;
                        try {
                            const fileContent = fs.readFileSync(filepath, 'utf8');
                            this.analyzeDoc(uri, TextDocument.create(uri, 'q', 1, fileContent));
                        } catch (error) {
                            this.connection.console.warn(`Failed analyzing ${uri}.`);
                            this.connection.console.warn(`Error: ${error.message}`);
                        }
                    });

                    this.connection.console.info(`Analyzing took ${getTimePassed()}`);
                });
        }

    }

    /**
     * Analyze the given document, cache the tree-sitter AST, and iterate over the
     * tree to find declarations.
     * Returns all, if any, syntax errors that occurred while parsing the file.
     */
    public analyzeDoc(uri: DocumentUri, document: TextDocument): Diagnostic[] {
        this.connection.console.info(`Analyzing ${uri}`);
        const content = document.getText();
        const tree = this.parser.parse(content);

        this.uriToTextDocument.set(uri, document);
        this.uriToTree.set(uri, tree);
        this.uriToDefinition.set(uri, new Map<string, SymbolInformation[]>());
        this.uriToFileContent.set(uri, content);
        this.uriToSymbol.set(uri, []);

        const problems: Diagnostic[] = [];

        let namespace = '';
        TreeSitterUtil.forEach(tree.rootNode, (n: Parser.SyntaxNode) => {
            if (n.type === 'ERROR') {
                problems.push(
                    Diagnostic.create(
                        TreeSitterUtil.range(n),
                        'Failed to parse expression',
                        DiagnosticSeverity.Error,
                    ),
                );
                return;
            } else if (TreeSitterUtil.isDefinition(n)) {
                const named = n.firstChild;
                if (named === null) {
                    return;
                }
                const containerName = this.getContainerName(n) ?? '';
                // WON'T include local identifier in functions
                if (containerName !== '' && namespace !== '' && named.type === 'local_identifier')
                    return;
                const name = (namespace === '' || named.type === 'global_identifier') ? named.text.trim() : `${namespace}.${named.text.trim()}`;
                const definitions = this.uriToDefinition.get(uri)?.get(name) || [];
                const functionNode = n.children[2]?.firstChild;
                const symbolKind = functionNode?.type === 'function_body' ? SymbolKind.Function : SymbolKind.Variable;

                definitions.push(
                    SymbolInformation.create(
                        name,
                        // only variable, may change to function/variable later
                        symbolKind,
                        TreeSitterUtil.range(n),
                        uri,
                        containerName,
                    ),
                );

                this.uriToDefinition.get(uri)?.set(name, definitions);

                if (symbolKind === SymbolKind.Function && functionNode?.firstNamedChild?.type === 'formal_parameters') {
                    const params = functionNode.firstNamedChild.namedChildren.map(n => ParameterInformation.create(n.text));
                    if (params.length > 0) {
                        const sigInfo = SignatureInformation.create(`${name}[${params.map(p => p.label).join(';')}]`, undefined, ...params);
                        this.nameToSigHelp.set(name, {
                            signatures: [sigInfo],
                            activeParameter: 0,
                            activeSignature: 0
                        });
                    }
                }

            } else if (TreeSitterUtil.isSeparator(n)) {
                if (n.text[0] !== ';') {
                    problems.push(
                        Diagnostic.create(
                            TreeSitterUtil.range(n),
                            'Missing a semicolon',
                            DiagnosticSeverity.Hint,
                        ),
                    );
                }
            } else if (TreeSitterUtil.isNamespace(n)) {
                namespace = n.firstChild?.text ?? '';
            } else if (TreeSitterUtil.isNamespaceEnd(n)) {
                namespace = '';
            } else if (TreeSitterUtil.isSymbol(n)) {
                this.uriToSymbol.get(uri)?.push(n.text.trim());
            }
        });

        function findMissingNodes(node: Parser.SyntaxNode) {
            if (node.isMissing()) {
                problems.push(
                    Diagnostic.create(
                        TreeSitterUtil.range(node),
                        `Syntax error: expected "${node.type}" somewhere in the file`,
                        DiagnosticSeverity.Warning,
                    ),
                );
            } else if (node.hasError()) {
                node.children.forEach(findMissingNodes);
            }
        }

        findMissingNodes(tree.rootNode);

        return problems;
    }

    public analyzeServerCache(content: string): void {
        const tree = this.parser.parse(content);
        this.serverIds = [];
        this.serverSyms = [];
        TreeSitterUtil.forEach(tree.rootNode, (n: Parser.SyntaxNode) => {
            if (TreeSitterUtil.isDefinition(n)) {
                const named = n.firstChild;
                if (named === null) {
                    return;
                }
                const name = named.text.trim();
                const functionNode = n.children[2]?.firstChild;
                const symbolKind = functionNode?.type === 'function_body' ? SymbolKind.Function : SymbolKind.Variable;

                this.serverIds.push(name);

                if (symbolKind === SymbolKind.Function && functionNode?.firstNamedChild?.type === 'formal_parameters') {
                    const params = functionNode.firstNamedChild.namedChildren.map(n => ParameterInformation.create(n.text));
                    if (params.length > 0) {
                        const sigInfo = SignatureInformation.create(`${name}[${params.map(p => p.label).join(';')}]`, undefined, ...params);
                        this.nameToSigHelp.set(name, {
                            signatures: [sigInfo],
                            activeParameter: 0,
                            activeSignature: 0
                        });
                    }
                }
            } else if (TreeSitterUtil.isSymbol(n)) {
                if (this.getContainerName(n) === '')
                    this.serverSyms.push(n.text.trim());
            }
        });
    }

    public remove(uri: string): void {
        this.uriToTextDocument.delete(uri);
        this.uriToTree.delete(uri);
        this.uriToDefinition.delete(uri);
        this.uriToFileContent.delete(uri);
    }

    /**
     * find its container, basically the function name
     * @param n
     * @param content
     */
    private getContainerName(n: Parser.SyntaxNode): string {
        const body = TreeSitterUtil.findParent(n, p => p.type === 'function_body');
        if (body?.parent?.type === 'expression_statement') {
            if (body?.parent?.parent?.type === 'assignment') {
                const assignment = body.parent.parent;
                // 2nd - right side is body itself
                if (assignment?.namedChild(1)?.firstNamedChild?.type === 'function_body') {
                    const functionNamed = assignment.firstNamedChild;
                    return functionNamed?.text.trim() ?? '';
                }
            } else {
                return `LAMBDA-${body.parent.startPosition.row}-${body.parent.startPosition.column}`;
            }
        }
        return '';
    }

    /**
     * Find the full word at the given point.
     */
    public wordAtPoint(uri: string, line: number, column: number): word | null {
        const document = this.uriToTree.get(uri);

        if (!document?.rootNode) {
            return null;
        }

        const node = document.rootNode.descendantForPosition({ row: line, column });

        if (!node || node.childCount > 0 || node.text.trim() === '') {
            return null;
        }

        return {
            type: node.type,
            text: node.text.trim(),
            range: TreeSitterUtil.range(node),
            containerName: this.getContainerName(node)
        };
    }

    public getCallNode(n: Parser.SyntaxNode): Parser.SyntaxNode | null {
        const call = TreeSitterUtil.findParentNotInTypes(n,
            ['table', 'exit_statement', 'function_exit_expression', 'ctrl_statement', 'function_ctrl_expression', 'formal_parameters'],
            p => p.type === 'call');
        return call;
    }

    public getNodeAtPoint(uri: string, line: number, column: number): Parser.SyntaxNode | null {
        const document = this.uriToTree.get(uri);

        if (!document?.rootNode) {
            return null;
        }

        const node = document.rootNode.descendantForPosition({ row: line, column });

        if (!node || node.childCount > 0 || node.text.trim() === '') {
            return null;
        }

        return node;
    }

    public getAllVariableSymbols(): SymbolInformation[] {
        return this.getAllSymbols().filter(symbol => symbol.kind === SymbolKind.Variable);
    }

    public getAllSymbols(): SymbolInformation[] {
        let symbols: SymbolInformation[] = [];
        this.uriToDefinition.forEach((nameToSymInfo) => {
            nameToSymInfo.forEach((sym) => symbols = symbols.concat(sym));
        });
        return symbols;
    }

    public getSigHelp(query: string): SignatureHelp | undefined {
        return this.nameToSigHelp.get(query);
    }

    public getServerIds(): string[] {
        return this.serverIds;
    }

    public getSyms(uri: DocumentUri): string[] {
        return this.serverSyms.concat(this.uriToSymbol.get(uri) ?? []);
    }

    public getLocalIds(uri: DocumentUri, containerName: string): string[] {
        const ids = this.getAllSymbols().filter(s => s.containerName === '' && !s.name.startsWith('.')).map(s => s.name);
        if (containerName !== '') {
            this.uriToDefinition.get(uri)?.forEach(symInfos => symInfos.forEach(s => {
                if (s.containerName === containerName)
                    ids.push(s.name);
            }));
        }
        return ids;
    }

}
