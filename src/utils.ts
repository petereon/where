import * as vscode from 'vscode';

// Module-level constants
export const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

// Utility functions
export function stripAnsiCodes(text: string): string {
    return text.replace(ANSI_REGEX, '');
}

export function parseSearchLine(line: string): { file: string; line: number; content: string } | null {
    const match = line.match(/^([^:]+):(\d+):(.*)$/);
    if (!match) return null;
    return { file: match[1], line: parseInt(match[2], 10), content: match[3] };
}

export async function openFileAtLine(filePath: string, line: number) {
    const document = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(document);
    const position = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenter
    );
}

export interface SearchConfig {
    rgPath: string;
    fzfPath: string;
    rgPathSet: boolean;
    fzfPathSet: boolean;
    rgArgs: string;
    respectGitignore: boolean;
    maxResults: number;
}

export function getSearchConfig(): SearchConfig {
    const config = vscode.workspace.getConfiguration('where');
    const inspect = config.inspect<string>('rgPath');
    const fzfInspect = config.inspect<string>('fzfPath');

    // Check if the user has explicitly set the paths
    const rgPathSet = !!(inspect?.workspaceValue || inspect?.globalValue);
    const fzfPathSet = !!(fzfInspect?.workspaceValue || fzfInspect?.globalValue);

    return {
        rgPath: config.get<string>('rgPath', 'rg'),
        fzfPath: config.get<string>('fzfPath', 'fzf'),
        rgPathSet,
        fzfPathSet,
        rgArgs: config.get<string>('rgArgs', ''),
        respectGitignore: config.get<boolean>('respectGitignore', true),
        maxResults: config.get<number>('maxResults', 100)
    };
}
