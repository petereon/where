import * as vscode from 'vscode';
import * as path from 'path';
import { parseSearchLine, openFileAtLine } from './utils';
import { RawSearchResult } from './search';

export class SearchInputViewProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    private readonly _onSearch = new vscode.EventEmitter<{ query: string; filter: string }>();
    private readonly _onClear = new vscode.EventEmitter<void>();

    readonly onSearch = this._onSearch.event;
    readonly onClear = this._onClear.event;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview();

        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case 'search':
                    this.handleSearch(data.query, data.filenameFilter);
                    break;
                case 'clear':
                    this.handleClear();
                    break;
                case 'openFile':
                    await this.openFile(data.file, data.line);
                    break;
            }
        });
    }

    public focusSearch() {
        this._view?.show?.(true);
        this._view?.webview.postMessage({ type: 'focus' });
    }

    private async openFile(file: string, line: number) {
        try {
            await openFileAtLine(file, line);
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open file: ${error}`);
        }
    }

    public showMessage(text: string) {
        this._view?.webview.postMessage({ type: 'message', text });
    }

    public formatResultMessage(current: number, total: number): string {
        let msg = `Found ${total}`;
        if (current < total) {
            msg += ` of ${total}`;
        }
        return msg;
    }

    private handleSearch(query: string, filenameFilter: string) {
        this._onSearch.fire({ query, filter: filenameFilter });
    }

    private handleClear() {
        this._onClear.fire();
    }

    private _getHtmlForWebview() {
        return this._getHtmlTemplate();
    }

    private _getHtmlTemplate() {
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body {
                    padding: 10px;
                    font-family: var(--vscode-font-family);
                }
                .search-container {
                    padding-bottom: 10px;
                }
                input {
                    width: 100%;
                    padding: 6px;
                    background: var(--vscode-input-background);
                    color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border);
                    border-radius: 2px;
                    font-family: var(--vscode-font-family);
                    font-size: 13px;
                    box-sizing: border-box;
                    margin-bottom: 8px;
                }
                input:focus {
                    outline: 1px solid var(--vscode-focusBorder);
                    outline-offset: -1px;
                }
                label {
                    display: block;
                    font-size: 11px;
                    color: var(--vscode-descriptionForeground);
                    margin-bottom: 4px;
                    font-weight: 500;
                }
                .message {
                    margin-top: 10px;
                    font-size: 12px;
                    color: var(--vscode-descriptionForeground);
                }
            </style>
        </head>
        <body>
            <div class="search-container">
                <label for="searchInput">Search Content</label>
                <input type="text" id="searchInput" placeholder="Type to search content..." />

                <label for="filenameInput">Filter by Filename</label>
                <input type="text" id="filenameInput" placeholder="Filter files (e.g., .ts, component)..." />
            </div>
            <div id="message" class="message"></div>
            <script>
                const vscode = acquireVsCodeApi();
                const filenameInput = document.getElementById('filenameInput');
                const searchInput = document.getElementById('searchInput');
                const message = document.getElementById('message');
                let debounceTimer;

                function search() {
                    const query = searchInput.value.trim();
                    const filenameFilter = filenameInput.value.trim();

                    if (query || filenameFilter) {
                        message.textContent = 'Searching...';
                        vscode.postMessage({ type: 'search', query, filenameFilter });
                    } else {
                        message.textContent = '';
                        vscode.postMessage({ type: 'clear' });
                    }
                }

                searchInput.addEventListener('input', () => {
                    clearTimeout(debounceTimer);
                    debounceTimer = setTimeout(search, 300);
                });

                filenameInput.addEventListener('input', () => {
                    clearTimeout(debounceTimer);
                    debounceTimer = setTimeout(search, 300);
                });

                window.addEventListener('message', event => {
                    const msg = event.data;
                    if (msg.type === 'focus') {
                        searchInput.focus();
                    } else if (msg.type === 'message') {
                        message.textContent = msg.text;
                    }
                });

                // Focus input on load
                setTimeout(() => searchInput.focus(), 100);
            </script>
        </body>
        </html>`;
    }
}

interface SearchResult {
    file: string;
    line: number;
    content: string;
}

export class SearchResultsProvider implements vscode.TreeDataProvider<SearchResultItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SearchResultItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private results: Map<string, SearchResult[]> = new Map();
    private allRawResults: RawSearchResult[] = [];
    private currentlyDisplayed: number = 0;
    private workspacePath: string = '';
    private batchSize: number = 100;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    clear(): void {
        this.results.clear();
        this.allRawResults = [];
        this.currentlyDisplayed = 0;
        this.refresh();
    }

    setAllResults(rawResults: RawSearchResult[], workspacePath: string): void {
        this.allRawResults = rawResults;
        this.workspacePath = workspacePath;
        this.results.clear();
        this.currentlyDisplayed = 0;
        this.loadMoreResults(this.batchSize);
    }

    loadMoreResults(count: number): boolean {
        const startIndex = this.currentlyDisplayed;
        const endIndex = Math.min(startIndex + count, this.allRawResults.length);

        if (startIndex >= this.allRawResults.length) {
            return false; // No more results to load
        }

        const batch = this.allRawResults.slice(startIndex, endIndex);
        const searchResults: SearchResult[] = batch.map((result: RawSearchResult) => {
            const parsed = parseSearchLine(result.rawLine);
            if (!parsed) {
                const parts = result.rawLine.split(':');
                const file = path.isAbsolute(parts[0]) ? parts[0] : path.join(this.workspacePath, parts[0]);
                const line = parseInt(parts[1], 10);
                const content = parts.slice(2).join(':').trim();
                return { file, line, content };
            }
            const file = path.isAbsolute(parsed.file) ? parsed.file : path.join(this.workspacePath, parsed.file);
            return { file, line: parsed.line, content: parsed.content.trim() };
        });

        // Add to results
        for (const result of searchResults) {
            if (!this.results.has(result.file)) {
                this.results.set(result.file, []);
            }
            this.results.get(result.file)!.push(result);
        }

        this.currentlyDisplayed = endIndex;
        this.refresh();
        return endIndex < this.allRawResults.length; // Return true if more results available
    }

    hasMoreResults(): boolean {
        return this.currentlyDisplayed < this.allRawResults.length;
    }

    getTotalResultCount(): number {
        return this.allRawResults.length;
    }

    getDisplayedResultCount(): number {
        return this.currentlyDisplayed;
    }

    getTreeItem(element: SearchResultItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: SearchResultItem): Thenable<SearchResultItem[]> {
        if (!element) {
            if (this.results.size === 0) {
                return Promise.resolve([]);
            }

            const items: SearchResultItem[] = [];
            for (const [file, matches] of this.results) {
                items.push(new SearchResultItem(
                    path.basename(file),
                    file,
                    matches.length,
                    vscode.TreeItemCollapsibleState.Expanded,
                    'file'
                ));
            }

            // Add "Load More" item if there are more results
            if (this.hasMoreResults()) {
                items.push(new SearchResultItem(
                    `Load More (${this.currentlyDisplayed} of ${this.allRawResults.length} shown)`,
                    '',
                    0,
                    vscode.TreeItemCollapsibleState.None,
                    'loadMore'
                ));
            }

            return Promise.resolve(items);
        }

        if (element.type !== 'file') {
            return Promise.resolve([]);
        }

        const matches = this.results.get(element.filePath);
        if (!matches) {
            return Promise.resolve([]);
        }

        return Promise.resolve(matches.map(match =>
            new SearchResultItem(
                match.content,
                element.filePath,
                match.line,
                vscode.TreeItemCollapsibleState.None,
                'match',
                match.line
            )
        ));
    }
}

export class SearchResultItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly filePath: string,
        public readonly matchCount: number,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: 'file' | 'match' | 'loadMore',
        public readonly line?: number
    ) {
        super(label, collapsibleState);

        if (type === 'file') {
            this.description = `${matchCount} ${matchCount === 1 ? 'match' : 'matches'}`;
            this.contextValue = 'file';
            this.resourceUri = vscode.Uri.file(filePath);
            this.tooltip = filePath;
        } else if (type === 'loadMore') {
            this.contextValue = 'loadMore';
            this.command = {
                command: 'where.loadMore',
                title: 'Load More'
            };
            this.iconPath = new vscode.ThemeIcon('unfold');
            this.tooltip = 'Click to load more results';
        } else {
            this.contextValue = 'match';
            this.description = `Line ${line}`;
            this.command = {
                command: 'where.openResult',
                title: 'Open',
                arguments: [filePath, line! - 1]
            };
            this.tooltip = `${filePath}:${line}`;
        }
    }
}
