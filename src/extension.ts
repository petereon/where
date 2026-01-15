import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import { promisify } from 'util';

const chmod = promisify(fs.chmod);
const mkdir = promisify(fs.mkdir);

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

class SearchResultsProvider implements vscode.TreeDataProvider<SearchResultItem> {
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

class SearchResultItem extends vscode.TreeItem {
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

    // Check and offer to install binaries on activation
    checkAndOfferToInstallBinaries(context).then(result => {
        if (result) {
            vscode.window.showInformationMessage('Where extension is ready to use!');
        }
    });

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

        const { rgPath, fzfPath, rgArgs } = getSearchConfig();

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

            // Load all results into provider (will display first batch)
            resultsProvider.setAllResults(rawResults, workspacePath);

            // Show message
            const displayed = resultsProvider.getDisplayedResultCount();
            const total = resultsProvider.getTotalResultCount();
            let message = `Found ${total} result${total !== 1 ? 's' : ''}`;
            if (displayed < total) {
                message += ` (showing first ${displayed})`;
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

    // Register command to load more results
    context.subscriptions.push(
        vscode.commands.registerCommand('where.loadMore', () => {
            resultsProvider.loadMoreResults(100);
            const displayed = resultsProvider.getDisplayedResultCount();
            const total = resultsProvider.getTotalResultCount();
            let message = `Showing ${displayed} of ${total} result${total !== 1 ? 's' : ''}`;
            searchInputProvider.showMessage(message);
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

function getBinariesDir(context: vscode.ExtensionContext): string {
    return path.join(context.globalStorageUri.fsPath, 'bin');
}

async function ensureBinariesDir(context: vscode.ExtensionContext): Promise<string> {
    const binDir = getBinariesDir(context);
    if (!fs.existsSync(binDir)) {
        await mkdir(binDir, { recursive: true });
    }
    return binDir;
}

function getPlatformInfo(): { platform: string; arch: string; isSupported: boolean } {
    const platform = os.platform();
    const arch = os.arch();
    const isSupported = ['darwin', 'linux', 'win32'].includes(platform);
    return { platform, arch, isSupported };
}

function getRipgrepDownloadUrl(): { url: string; filename: string } | null {
    const { platform, arch } = getPlatformInfo();
    const version = '14.1.0';
    let filename: string;

    if (platform === 'darwin') {
        if (arch === 'arm64') {
            filename = `ripgrep-${version}-aarch64-apple-darwin.tar.gz`;
        } else {
            filename = `ripgrep-${version}-x86_64-apple-darwin.tar.gz`;
        }
    } else if (platform === 'linux') {
        if (arch === 'x64') {
            filename = `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`;
        } else if (arch === 'arm64') {
            filename = `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`;
        } else {
            return null;
        }
    } else if (platform === 'win32') {
        filename = `ripgrep-${version}-x86_64-pc-windows-msvc.zip`;
    } else {
        return null;
    }

    return {
        url: `https://github.com/BurntSushi/ripgrep/releases/download/${version}/${filename}`,
        filename
    };
}

function getFzfDownloadUrl(): { url: string; filename: string } | null {
    const { platform, arch } = getPlatformInfo();
    const version = '0.56.3';
    let filename: string;

    if (platform === 'darwin') {
        if (arch === 'arm64') {
            filename = 'fzf-' + version + '-darwin_arm64.tar.gz';
        } else {
            filename = 'fzf-' + version + '-darwin_amd64.tar.gz';
        }
    } else if (platform === 'linux') {
        if (arch === 'x64') {
            filename = 'fzf-' + version + '-linux_amd64.tar.gz';
        } else if (arch === 'arm64') {
            filename = 'fzf-' + version + '-linux_arm64.tar.gz';
        } else {
            return null;
        }
    } else if (platform === 'win32') {
        filename = 'fzf-' + version + '-windows_amd64.zip';
    } else {
        return null;
    }

    return {
        url: `https://github.com/junegunn/fzf/releases/download/v${version}/${filename}`,
        filename
    };
}

function downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        https.get(url, (response) => {
            if (response.statusCode === 302 || response.statusCode === 301) {
                // Handle redirect
                const redirectUrl = response.headers.location;
                if (redirectUrl) {
                    file.close();
                    fs.unlinkSync(destPath);
                    downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
                    return;
                }
            }

            if (response.statusCode !== 200) {
                file.close();
                fs.unlinkSync(destPath);
                reject(new Error(`Failed to download: ${response.statusCode}`));
                return;
            }

            response.pipe(file);
            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            file.close();
            fs.unlinkSync(destPath);
            reject(err);
        });
    });
}

function extractArchive(archivePath: string, destDir: string, binaryName: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const isZip = archivePath.endsWith('.zip');
        const command = isZip
            ? `unzip -o "${archivePath}" -d "${destDir}"`
            : `tar -xzf "${archivePath}" -C "${destDir}"`;

        child_process.exec(command, async (error) => {
            if (error) {
                reject(error);
                return;
            }

            // Find the binary in the extracted files
            const findBinary = (dir: string): string | null => {
                const files = fs.readdirSync(dir);
                for (const file of files) {
                    const fullPath = path.join(dir, file);
                    const stat = fs.statSync(fullPath);
                    if (stat.isDirectory()) {
                        const found = findBinary(fullPath);
                        if (found) return found;
                    } else if (file === binaryName || file === `${binaryName}.exe`) {
                        return fullPath;
                    }
                }
                return null;
            };

            const binaryPath = findBinary(destDir);
            if (!binaryPath) {
                reject(new Error(`Binary ${binaryName} not found in archive`));
                return;
            }

            // Make executable (Unix only)
            if (os.platform() !== 'win32') {
                await chmod(binaryPath, 0o755);
            }

            // Move to bin dir if not already there
            const ext = os.platform() === 'win32' ? '.exe' : '';
            const finalPath = path.join(destDir, binaryName + ext);
            if (binaryPath !== finalPath) {
                fs.renameSync(binaryPath, finalPath);
            }

            resolve(finalPath);
        });
    });
}

async function downloadAndInstallBinary(
    name: 'rg' | 'fzf',
    context: vscode.ExtensionContext
): Promise<string | null> {
    const binDir = await ensureBinariesDir(context);
    const downloadInfo = name === 'rg' ? getRipgrepDownloadUrl() : getFzfDownloadUrl();

    if (!downloadInfo) {
        vscode.window.showErrorMessage(`Your platform is not supported for automatic ${name} installation`);
        return null;
    }

    const archivePath = path.join(binDir, downloadInfo.filename);
    const binaryName = name === 'rg' ? 'rg' : 'fzf';

    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Downloading ${name}...`,
            cancellable: false
        }, async (progress) => {
            progress.report({ message: 'Downloading...' });
            await downloadFile(downloadInfo.url, archivePath);

            progress.report({ message: 'Extracting...' });
            const installedPath = await extractArchive(archivePath, binDir, binaryName);

            // Clean up archive
            fs.unlinkSync(archivePath);

            return installedPath;
        });

        const ext = os.platform() === 'win32' ? '.exe' : '';
        const binaryPath = path.join(binDir, binaryName + ext);

        vscode.window.showInformationMessage(`${name} installed successfully`);
        return binaryPath;
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to install ${name}: ${error}`);
        return null;
    }
}

async function checkAndOfferToInstallBinaries(context: vscode.ExtensionContext): Promise<{ rgPath: string; fzfPath: string } | null> {
    const config = getSearchConfig();
    let rgPath = config.rgPath;
    let fzfPath = config.fzfPath;

    // Check if using default paths
    const usingDefaultRg = rgPath === 'rg';
    const usingDefaultFzf = fzfPath === 'fzf';

    // Check if binaries exist
    const [rgExists, fzfExists] = await Promise.all([
        checkBinaryExists(rgPath),
        checkBinaryExists(fzfPath)
    ]);

    const missingBinaries: ('rg' | 'fzf')[] = [];
    if (!rgExists && usingDefaultRg) missingBinaries.push('rg');
    if (!fzfExists && usingDefaultFzf) missingBinaries.push('fzf');

    if (missingBinaries.length === 0) {
        return { rgPath, fzfPath };
    }

    // Check if platform is supported
    const { isSupported } = getPlatformInfo();
    if (!isSupported) {
        const binaryNames = missingBinaries.join(' and ');
        vscode.window.showWarningMessage(
            `Required binaries (${binaryNames}) not found. Please install them manually.`,
            'Learn More'
        ).then(selection => {
            if (selection === 'Learn More') {
                vscode.env.openExternal(vscode.Uri.parse('https://github.com/petereon/where#requirements'));
            }
        });
        return null;
    }

    // Offer to download
    const binaryNames = missingBinaries.map(b => b === 'rg' ? 'ripgrep (rg)' : 'fzf').join(' and ');
    const action = await vscode.window.showInformationMessage(
        `The where extension requires ${binaryNames} to function. Would you like to download and install them automatically?`,
        'Yes',
        'No',
        'Manual Installation'
    );

    if (action === 'Manual Installation') {
        vscode.env.openExternal(vscode.Uri.parse('https://github.com/petereon/where#requirements'));
        return null;
    }

    if (action !== 'Yes') {
        return null;
    }

    // Download and install
    for (const binary of missingBinaries) {
        const installedPath = await downloadAndInstallBinary(binary, context);
        if (installedPath) {
            if (binary === 'rg') {
                rgPath = installedPath;
                await vscode.workspace.getConfiguration('where').update('rgPath', installedPath, vscode.ConfigurationTarget.Global);
            } else {
                fzfPath = installedPath;
                await vscode.workspace.getConfiguration('where').update('fzfPath', installedPath, vscode.ConfigurationTarget.Global);
            }
        } else {
            return null;
        }
    }

    return { rgPath, fzfPath };
}

export function deactivate() {}
