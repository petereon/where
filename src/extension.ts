import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';

// Module-level constants
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

// Utility functions
function stripAnsiCodes(text: string): string {
    return text.replace(ANSI_REGEX, '');
}

function parseSearchLine(line: string): { file: string; line: number; content: string } | null {
    const match = line.match(/^([^:]+):(\d+):(.*)$/);
    if (!match) return null;
    return { file: match[1], line: parseInt(match[2], 10), content: match[3] };
}

function getSearchConfig() {
    const config = vscode.workspace.getConfiguration('where');
    return {
        rgPath: config.get<string>('rgPath', 'rg'),
        fzfPath: config.get<string>('fzfPath', 'fzf'),
        rgArgs: config.get<string>('rgArgs', '--line-number --glob=!node_modules --glob=!.git --glob=!dist --glob=!out --glob=!build'),
        maxResults: config.get<number>('maxResults', 100)
    };
}

async function openFileAtLine(filePath: string, line: number) {
    const document = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(document);
    const position = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenter
    );
}

class SearchInputViewProvider implements vscode.WebviewViewProvider {
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

    public formatResultMessage(current: number, total: number, max: number): string {
        let msg = `Found ${current}`;
        if (current < total || total > max) {
            msg += ` of ${total > max ? max + '+' : total}`;
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

class SearchResultsProvider implements vscode.TreeDataProvider<SearchResultItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<SearchResultItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private results: Map<string, SearchResult[]> = new Map();

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    clear(): void {
        this.results.clear();
        this.refresh();
    }

    setResults(results: SearchResult[]): void {
        this.results.clear();

        // Group results by file
        for (const result of results) {
            if (!this.results.has(result.file)) {
                this.results.set(result.file, []);
            }
            this.results.get(result.file)!.push(result);
        }

        this.refresh();
    }

    addResults(results: SearchResult[]): void {
        // Group results by file
        for (const result of results) {
            if (!this.results.has(result.file)) {
                this.results.set(result.file, []);
            }
            this.results.get(result.file)!.push(result);
        }

        this.refresh();
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

class SearchResultItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly filePath: string,
        public readonly matchCount: number,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly type: 'file' | 'match',
        public readonly line?: number
    ) {
        super(label, collapsibleState);

        if (type === 'file') {
            this.description = `${matchCount} ${matchCount === 1 ? 'match' : 'matches'}`;
            this.contextValue = 'file';
            this.resourceUri = vscode.Uri.file(filePath);
            this.tooltip = filePath;
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

export function activate(context: vscode.ExtensionContext) {
    const resultsProvider = new SearchResultsProvider();
    const treeView = vscode.window.createTreeView('whereSearchResults', {
        treeDataProvider: resultsProvider,
        showCollapseAll: true
    });
    context.subscriptions.push(treeView);

    const searchInputProvider = new SearchInputViewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('whereSearchInput', searchInputProvider)
    );

    // Set up event handlers
    context.subscriptions.push(
        searchInputProvider.onClear(() => {
            resultsProvider.clear();
        })
    );

    context.subscriptions.push(
        searchInputProvider.onSearch(async ({ query, filter }) => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            searchInputProvider.showMessage('No workspace folder open');
            return;
        }

        if (!query.trim() && !filter.trim()) {
            searchInputProvider.showMessage('Please enter a search query or filename filter');
            return;
        }

        const { rgPath, fzfPath, rgArgs, maxResults } = getSearchConfig();

        const binaries = [
            { name: 'rg', path: rgPath },
            { name: 'fzf', path: fzfPath }
        ];

        const checks = binaries.map(b => checkBinaryExists(b.path));
        const results = await Promise.all(checks);
        const missingBinary = binaries.find((_, i) => !results[i]);
        if (missingBinary) {
            searchInputProvider.showMessage(`Binary '${missingBinary.name}' not found`);
            return;
        }

        resultsProvider.clear();
        searchInputProvider.showMessage('Searching...');

        try {
            const workspacePath = workspaceFolder.uri.fsPath;
            const rawResults = await executeSearch(
                rgPath,
                rgArgs,
                fzfPath,
                query,
                filter,
                workspacePath
            );

            if (rawResults.length === 0) {
                searchInputProvider.showMessage('No results found');
                return;
            }

            // Process results in batches for responsiveness
            const batchSize = 20;
            const totalToShow = Math.min(rawResults.length, maxResults);

            for (let i = 0; i < totalToShow; i += batchSize) {
                const batch = rawResults.slice(i, Math.min(i + batchSize, totalToShow));
                const searchResults: SearchResult[] = batch.map((result: RawSearchResult) => {
                    const parsed = parseSearchLine(result.rawLine);
                    if (!parsed) {
                        const parts = result.rawLine.split(':');
                        const file = path.isAbsolute(parts[0]) ? parts[0] : path.join(workspacePath, parts[0]);
                        const line = parseInt(parts[1], 10);
                        const content = parts.slice(2).join(':').trim();
                        return { file, line, content };
                    }
                    const file = path.isAbsolute(parsed.file) ? parsed.file : path.join(workspacePath, parsed.file);
                    return { file, line: parsed.line, content: parsed.content.trim() };
                });

                if (i === 0) {
                    resultsProvider.setResults(searchResults);
                } else {
                    resultsProvider.addResults(searchResults);
                }

                // Update current count
                const currentCount = Math.min(i + batchSize, totalToShow);
                searchInputProvider.showMessage(
                    searchInputProvider.formatResultMessage(currentCount, rawResults.length, maxResults)
                );

                // Small delay between batches for UI responsiveness
                if (i + batchSize < totalToShow) {
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
            }

            // Final message
            let message = `Found ${totalToShow} result${totalToShow !== 1 ? 's' : ''}`;
            if (rawResults.length > maxResults) {
                message += ` (showing first ${maxResults} of ${rawResults.length})`;
            }
            searchInputProvider.showMessage(message);
        } catch (error) {
            searchInputProvider.showMessage(`Search failed: ${error}`);
        }
    })
    );

    // Register command to open a result
    context.subscriptions.push(
        vscode.commands.registerCommand('where.openResult', async (filePath: string, line: number) => {
            await openFileAtLine(filePath, line);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('where.focusSearch', () => {
            vscode.commands.executeCommand('whereSearchInput.focus');
            searchInputProvider.focusSearch();
        })
    );
}

interface RawSearchResult {
    rawLine: string;
}

function runRipgrep(rgPath: string, rgArgs: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const rgProcess = child_process.spawn(rgPath, [...rgArgs.split(' '), '\\S'], {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let rgOutput = '';
        let rgError = '';

        rgProcess.stdout.on('data', (data) => {
            rgOutput += data.toString();
        });

        rgProcess.stderr.on('data', (data) => {
            rgError += data.toString();
        });

        rgProcess.on('close', (rgCode) => {
            if (rgCode !== 0 && rgCode !== 1) {
                reject(new Error(`ripgrep failed: ${rgError}`));
                return;
            }
            resolve(rgOutput);
        });
    });
}

function filterByFilename(fzfPath: string, filenames: string[], filter: string, cwd: string): Promise<Set<string>> {
    return new Promise((resolve, reject) => {
        const fzfProcess = child_process.spawn(fzfPath, ['--filter', filter, '--ansi'], {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let fzfOutput = '';
        let fzfError = '';

        fzfProcess.stdout.on('data', (data) => {
            fzfOutput += data.toString();
        });

        fzfProcess.stderr.on('data', (data) => {
            fzfError += data.toString();
        });

        fzfProcess.on('close', (code) => {
            if (code !== 0 && code !== 1) {
                reject(new Error(`fzf filename filter failed: ${fzfError}`));
                return;
            }

            const matchedFilenames = new Set(
                fzfOutput
                    .split('\n')
                    .filter(line => line.trim())
                    .map(line => stripAnsiCodes(line))
            );
            resolve(matchedFilenames);
        });

        fzfProcess.stdin.write(filenames.join('\n'));
        fzfProcess.stdin.end();
    });
}

function filterByContent(fzfPath: string, contentLines: string[], query: string, cwd: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
        const fzfProcess = child_process.spawn(fzfPath, ['--filter', query, '--ansi'], {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let fzfOutput = '';
        let fzfError = '';

        fzfProcess.stdout.on('data', (data) => {
            fzfOutput += data.toString();
        });

        fzfProcess.stderr.on('data', (data) => {
            fzfError += data.toString();
        });

        fzfProcess.on('close', (code) => {
            if (code !== 0 && code !== 1) {
                reject(new Error(`fzf failed: ${fzfError}`));
                return;
            }

            const matched = fzfOutput
                .split('\n')
                .filter(line => line.trim())
                .map(line => stripAnsiCodes(line));
            resolve(matched);
        });

        fzfProcess.stdin.write(contentLines.join('\n'));
        fzfProcess.stdin.end();
    });
}

function executeSearch(
    rgPath: string,
    rgArgs: string,
    fzfPath: string,
    query: string,
    filenameFilter: string,
    cwd: string
): Promise<RawSearchResult[]> {
    return new Promise((resolve, reject) => {
        // First, run ripgrep to get all non-empty lines
        // Using \S to match lines with at least one non-whitespace character
        const rgProcess = child_process.spawn(rgPath, [...rgArgs.split(' '), '\\S'], {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let rgOutput = '';
        let rgError = '';

        rgProcess.stdout.on('data', (data) => {
            rgOutput += data.toString();
        });

        rgProcess.stderr.on('data', (data) => {
            rgError += data.toString();
        });

        rgProcess.on('close', async (rgCode) => {
            if (rgCode !== 0 && rgCode !== 1) {
                // ripgrep returns 1 when no matches found
                reject(new Error(`ripgrep failed: ${rgError}`));
                return;
            }

            if (!rgOutput.trim()) {
                resolve([]);
                return;
            }

            // Parse ripgrep output to separate file:line from content
            const rgLines = rgOutput.split('\n').filter(line => line.trim());
            const contentLines: string[] = [];
            const lineMapping: Map<number, string> = new Map();

            rgLines.forEach((line, index) => {
                // Strip ANSI codes first
                const cleanLine = line.replace(/\x1b\[[0-9;]*m/g, '');
                const match = cleanLine.match(/^([^:]+):(\d+):(.*)$/);
                if (match) {
                    const content = match[3];
                    if (content && content.trim().length > 0) {
                        contentLines.push(content);
                        lineMapping.set(index, cleanLine);
                    }
                }
            });

            if (contentLines.length === 0) {
                resolve([]);
                return;
            }

            // Filter by filename first if provided
            let filteredMapping = lineMapping;
            if (filenameFilter.trim()) {
                // Extract unique filenames
                const filenames = new Set<string>();
                for (const fullLine of lineMapping.values()) {
                    const match = fullLine.match(/^([^:]+):/);
                    if (match) {
                        filenames.add(match[1]);
                    }
                }

                // Filter filenames through fzf
                const filenameArray = Array.from(filenames);
                const fzfFilenameProcess = child_process.spawn(fzfPath, [
                    '--filter',
                    filenameFilter,
                    '--ansi'
                ], {
                    cwd,
                    stdio: ['pipe', 'pipe', 'pipe']
                });

                let fzfFilenameOutput = '';
                let fzfFilenameError = '';

                fzfFilenameProcess.stdout.on('data', (data) => {
                    fzfFilenameOutput += data.toString();
                });

                fzfFilenameProcess.stderr.on('data', (data) => {
                    fzfFilenameError += data.toString();
                });

                await new Promise<void>((resolveFilename, rejectFilename) => {
                    fzfFilenameProcess.on('close', (code) => {
                        if (code !== 0 && code !== 1) {
                            rejectFilename(new Error(`fzf filename filter failed: ${fzfFilenameError}`));
                            return;
                        }

                        const matchedFilenames = new Set(
                            fzfFilenameOutput
                                .split('\n')
                                .filter(line => line.trim())
                                .map(line => line.replace(/\x1b\[[0-9;]*m/g, ''))
                        );

                        if (matchedFilenames.size === 0) {
                            // No filenames matched, clear the mapping
                            filteredMapping = new Map();
                        } else {
                            // Filter lineMapping to only include matched filenames
                            filteredMapping = new Map();
                            for (const [index, fullLine] of lineMapping) {
                                const match = fullLine.match(/^([^:]+):/);
                                if (match && matchedFilenames.has(match[1])) {
                                    filteredMapping.set(index, fullLine);
                                }
                            }
                        }

                        resolveFilename();
                    });

                    fzfFilenameProcess.stdin.write(filenameArray.join('\n'));
                    fzfFilenameProcess.stdin.end();
                });

                if (filteredMapping.size === 0) {
                    resolve([]);
                    return;
                }
            }

            // Build content lines only from filtered files
            const filteredContentLines: string[] = [];
            const filteredContentMapping: Map<number, { index: number, fullLine: string }> = new Map();
            let contentIndex = 0;
            for (const [originalIndex, fullLine] of filteredMapping) {
                const match = fullLine.match(/^([^:]+):(\d+):(.*)$/);
                if (match) {
                    filteredContentLines.push(match[3]);
                    filteredContentMapping.set(contentIndex, { index: originalIndex, fullLine });
                    contentIndex++;
                }
            }

            if (filteredContentLines.length === 0 || !query.trim()) {
                // If no content query, return all filtered results
                if (!query.trim()) {
                    const results = Array.from(filteredMapping.values()).map(fullLine => ({ rawLine: fullLine }));
                    resolve(results);
                    return;
                }
                resolve([]);
                return;
            }

            // Now pipe only the filtered content through fzf for content filtering
            const fzfProcess = child_process.spawn(fzfPath, [
                '--filter',
                query,
                '--ansi'
            ], {
                cwd,
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let fzfOutput = '';
            let fzfError = '';

            fzfProcess.stdout.on('data', (data) => {
                fzfOutput += data.toString();
            });

            fzfProcess.stderr.on('data', (data) => {
                fzfError += data.toString();
            });

            fzfProcess.on('close', (fzfCode) => {
                if (fzfCode !== 0 && fzfCode !== 1) {
                    reject(new Error(`fzf failed: ${fzfError}`));
                    return;
                }

                // Match fzf results back to original lines
                const matchedContents = fzfOutput
                    .split('\n')
                    .filter(line => line.trim())
                    .map(line => line.replace(/\x1b\[[0-9;]*m/g, ''));

                const results: RawSearchResult[] = [];

                for (const matchedContent of matchedContents) {
                    // Find the original line with this content
                    for (const [contentIdx, { fullLine }] of filteredContentMapping) {
                        const contentMatch = fullLine.match(/^([^:]+):(\d+):(.*)$/);
                        if (contentMatch && contentMatch[3] === matchedContent) {
                            results.push({ rawLine: fullLine });
                            filteredContentMapping.delete(contentIdx); // Remove to avoid duplicates
                            break;
                        }
                    }
                }

                resolve(results);
            });

            // Write only filtered content to fzf
            fzfProcess.stdin.write(filteredContentLines.join('\n'));
            fzfProcess.stdin.end();
        });
    });
}


function checkBinaryExists(binaryPath: string): Promise<boolean> {
    return new Promise((resolve) => {
        child_process.exec(`command -v ${binaryPath}`, (error) => {
            resolve(!error);
        });
    });
}

export function deactivate() {}
