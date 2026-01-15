import * as vscode from 'vscode';
import { getSearchConfig, openFileAtLine } from './utils';
import { resolveBinaryPaths } from './binaryManager';
import { executeSearch } from './search';
import { SearchInputViewProvider, SearchResultsProvider } from './providers';

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

    // Check binaries on activation (but don't block)
    resolveBinaryPaths(context).then(result => {
        if (result) {
            // Binaries are ready
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

        const { rgArgs, respectGitignore } = getSearchConfig();

        // Get binary paths with proper fallback logic
        const binaryPaths = await resolveBinaryPaths(context);
        if (!binaryPaths) {
            searchInputProvider.showMessage('Required binaries not available');
            return;
        }

        const { rgPath, fzfPath } = binaryPaths;

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
                workspacePath,
                respectGitignore
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

export function deactivate() {}
