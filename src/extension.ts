import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import * as yamlAst from 'yaml-ast-parser';

class YamlTreeItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly startPosition: number,
        public readonly endPosition: number,
        public readonly children: YamlTreeItem[] = []
    ) {
        super(label, collapsibleState);
        this.command = {
            command: 'yamltree.revealYaml',
            title: 'Reveal in YAML',
            arguments: [startPosition, endPosition]
        };
    }
}

// Helper types for output parsing
interface OutputNode {
    label: string;
    type: 'expandable' | 'leaf';
    children: OutputNode[];
    indent: number;
}

function parseExampleOutput(output: string): OutputNode[] {
    const lines = output.split(/\r?\n/);
    const stack: {node: OutputNode, indent: number}[] = [];
    const root: OutputNode[] = [];
    for (let rawLine of lines) {
        if (!rawLine.trim()) continue;
        const match = rawLine.match(/^(\s*)([>-])\s*(.*)$/);
        let indent = 0, type: 'expandable'|'leaf' = 'expandable', label = rawLine.trim();
        if (match) {
            indent = match[1].length;
            type = match[2] === '>' ? 'expandable' : 'leaf';
            label = match[3];
        } else {
            // top-level or non-prefixed
            const m2 = rawLine.match(/^(\s*)([^>-].*)$/);
            if (m2) {
                indent = m2[1].length;
                label = m2[2].trim();
                type = 'expandable';
            }
        }
        const node: OutputNode = { label, type, children: [], indent };
        while (stack.length && indent <= stack[stack.length-1].indent) stack.pop();
        if (stack.length) {
            stack[stack.length-1].node.children.push(node);
        } else {
            root.push(node);
        }
        stack.push({node, indent});
    }
    return root;
}

class YamlTreeProvider implements vscode.TreeDataProvider<YamlTreeItem> {
    private document: vscode.TextDocument | undefined;
    private yamlPath: string | undefined;
    constructor(arg: vscode.TextDocument | string) {
        if (typeof arg === 'string') {
            this.yamlPath = arg;
            this.refresh();
        } else {
            this.document = arg;
        }
    }
    public setDocument(document: vscode.TextDocument | undefined) {
        this.document = document;
    }
    // ...existing fields...
    // Recursively walk the output structure, find corresponding YAML AST node, and build tree
    private buildTreeFromOutput(outputNodes: OutputNode[], yamlNode: yamlAst.YAMLNode, content: string): YamlTreeItem[] {
        const result: YamlTreeItem[] = [];
        for (const outNode of outputNodes) {
            const {label, type, children} = outNode;
            // Find the YAML AST node that matches this label
            let matchNode: yamlAst.YAMLNode | undefined;
            let displayLabel = label;
            if (yamlNode && yamlNode.kind === yamlAst.Kind.MAP) {
                // Look for mapping by key
                const mapNode = yamlNode as yamlAst.YamlMap;
                for (const mapping of mapNode.mappings) {
                    if (mapping.key.value === label.replace(/:$/, '')) {
                        matchNode = mapping.value;
                        break;
                    }
                }
            } else if (yamlNode && yamlNode.kind === yamlAst.Kind.SEQ) {
                // Look for sequence item by name or value
                const seqNode = yamlNode as yamlAst.YAMLSequence;
                for (const item of seqNode.items) {
                    if (item && item.kind === yamlAst.Kind.MAP) {
                        const mapNode = item as yamlAst.YamlMap;
                        const nameMapping = mapNode.mappings.find(m => m.key.value && ('name: ' + m.value.value) === label);
                        if (nameMapping) {
                            matchNode = item;
                            break;
                        }
                    } else if (item && label.startsWith('-')) {
                        // For leaf array item
                        const value = content.substring(item.startPosition, item.endPosition).trim();
                        if (('- ' + value) === label) {
                            matchNode = item;
                            break;
                        }
                    }
                }
            }
            // If not found, fallback to the parent node
            if (!matchNode) matchNode = yamlNode;
            // If children, recurse; else, leaf
            let treeChildren: YamlTreeItem[] = [];
            if (children && children.length > 0 && matchNode) {
                treeChildren = this.buildTreeFromOutput(children, matchNode, content);
            }
            // Determine start/end position for navigation
            let start = matchNode ? matchNode.startPosition : 0;
            let end = matchNode ? matchNode.endPosition : 0;
            // For expandable, do not show children unless present in output
            const collapsible = type === 'expandable' && treeChildren.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
            result.push(new YamlTreeItem(label, collapsible, start, end, treeChildren));
        }
        return result;
    }

    private _onDidChangeTreeData: vscode.EventEmitter<YamlTreeItem | undefined | void> = new vscode.EventEmitter<YamlTreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<YamlTreeItem | undefined | void> = this._onDidChangeTreeData.event;
    private rootItems: YamlTreeItem[] = [];

    refresh(): void {
        console.log('refresh called');
        this.rootItems = [];
        if (!this.document) {
            this._onDidChangeTreeData.fire();
            return;
        }
        try {
            const content = this.document.getText();
            const ast = yamlAst.load(content);
            this.rootItems = this.parseAstNode(ast, content);
            this.debugPrintTree(this.rootItems);
        } catch (e) {
            vscode.window.showErrorMessage('Failed to parse YAML: ' + (e as Error).message);
        }
        this._onDidChangeTreeData.fire();
    }

    private debugPrintTree(items: YamlTreeItem[], depth: number = 0): void {
        console.log('debugPrintTree called');
        for (const item of items) {
            console.log(' '.repeat(depth * 2) + item.label);
            if (item.children && item.children.length > 0) {
                this.debugPrintTree(item.children, depth + 1);
            }
        }
    }

    getTreeItem(element: YamlTreeItem): vscode.TreeItem {
        return element;
    }

    public getChildren(element?: YamlTreeItem): Thenable<YamlTreeItem[]> {
        if (!this.document) {
            return Promise.resolve([]);
        }
        if (!element) {
            return Promise.resolve(this.rootItems);
        }
        return Promise.resolve(element.children);
    }

    private parseAstNode(node: yamlAst.YAMLNode, content: string): YamlTreeItem[] {
        if (!node) return [];
        if (node.kind === yamlAst.Kind.MAP) {
            const mapNode = node as yamlAst.YamlMap;
            // Only show keys whose value is a map or sequence (expandable)
            return mapNode.mappings
                .filter(mapping => {
                    const valueNode = mapping.value;
                    return valueNode && (valueNode.kind === yamlAst.Kind.MAP || valueNode.kind === yamlAst.Kind.SEQ);
                })
                .map(mapping => {
                    const key = mapping.key.value;
                    const valueNode = mapping.value;
                    const children = this.parseAstNode(valueNode, content);
                    return new YamlTreeItem(
                        key + ':',
                        children.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                        mapping.startPosition,
                        mapping.endPosition,
                        children
                    );
                });
        } else if (node.kind === yamlAst.Kind.SEQ) {
            const seqNode = node as yamlAst.YAMLSequence;
            // Only show items that are maps or sequences (expandable)
            return seqNode.items
                .filter(item => item && (item.kind === yamlAst.Kind.MAP || item.kind === yamlAst.Kind.SEQ))
                .map(item => {
                    if (item.kind === yamlAst.Kind.MAP) {
                        const mapNode = item as yamlAst.YamlMap;
                        // Use the first key as the label, or fallback to the raw YAML if not present
                        let label = '';
                        if (mapNode.mappings.length > 0) {
                            const firstMapping = mapNode.mappings[0];
                            label = `${firstMapping.key.value}: ${firstMapping.value.value}`;
                        } else {
                            label = content.substring(item.startPosition, item.endPosition).trim();
                        }
                        const children = this.parseAstNode(item, content);
                        return new YamlTreeItem(
                            label,
                            vscode.TreeItemCollapsibleState.Collapsed,
                            item.startPosition,
                            item.endPosition,
                            children
                        );
                    } else if (item.kind === yamlAst.Kind.SEQ) {
                        // For nested sequences, show the raw YAML as label
                        let raw = content.substring(item.startPosition, item.endPosition).trim();
                        const children = this.parseAstNode(item, content);
                        return new YamlTreeItem(
                            raw,
                            vscode.TreeItemCollapsibleState.Collapsed,
                            item.startPosition,
                            item.endPosition,
                            children
                        );
                    } else {
                        return null;
                    }
                })
                .filter(Boolean) as YamlTreeItem[];
        }
        return [];
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('yamltree extension activated');
    vscode.window.showInformationMessage('yamltree extension activated');
    let treeProvider: YamlTreeProvider | undefined;

    function refreshTreeForActiveEditor() {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === 'yaml') {
            if (!treeProvider) {
                treeProvider = new YamlTreeProvider(editor.document);
                vscode.window.registerTreeDataProvider('yamltree', treeProvider);
            } else {
                treeProvider.setDocument(editor.document);
            }
            treeProvider.refresh();
        } else if (treeProvider) {
            treeProvider.setDocument(undefined);
            treeProvider.refresh();
        }
    }

    vscode.window.onDidChangeActiveTextEditor(() => {
        refreshTreeForActiveEditor();
    }, null, context.subscriptions);

    vscode.workspace.onDidOpenTextDocument(() => {
        refreshTreeForActiveEditor();
    }, null, context.subscriptions);

    context.subscriptions.push(vscode.commands.registerCommand('yamltree.showYamlTree', () => {
        refreshTreeForActiveEditor();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('yamltree.revealYaml', async (start: number, end: number, uri?: vscode.Uri) => {
        let doc: vscode.TextDocument;
        if (uri) {
            doc = await vscode.workspace.openTextDocument(uri);
        } else {
            doc = vscode.window.activeTextEditor?.document!;
        }
        const editor = await vscode.window.showTextDocument(doc, { preview: false });
        let startPos = doc.positionAt(start);
        startPos = new vscode.Position(startPos.line, 0);
        editor.selection = new vscode.Selection(startPos, startPos);
        editor.revealRange(new vscode.Range(startPos, startPos), vscode.TextEditorRevealType.InCenter);
    }));

    // Clear the tree when the YAML document is closed
    vscode.workspace.onDidCloseTextDocument((closedDoc) => {
        if (
            treeProvider &&
            treeProvider['document'] &&
            closedDoc === treeProvider['document']
        ) {
            treeProvider.setDocument(undefined as any); // Clear document
            treeProvider.refresh();
        }
    }, null, context.subscriptions);

    // Initial tree load
    refreshTreeForActiveEditor();
}

export function deactivate() {}
