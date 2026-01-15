import * as child_process from 'child_process';
import { stripAnsiCodes } from './utils';
import { convertGitignoreToRgGlobs } from './gitignore';

export interface RawSearchResult {
    rawLine: string;
}

export function executeSearch(
    rgPath: string,
    rgArgs: string,
    fzfPath: string,
    query: string,
    filenameFilter: string,
    cwd: string,
    respectGitignore: boolean = true
): Promise<RawSearchResult[]> {
    return new Promise((resolve, reject) => {
        // Build ripgrep arguments
        const baseArgs = ['--line-number']; // Always required for parsing

        // Add user's additional arguments if any
        if (rgArgs.trim()) {
            baseArgs.push(...rgArgs.split(' ').filter(arg => arg.trim()));
        }

        // Add gitignore globs if enabled
        const gitignoreGlobs = respectGitignore ? convertGitignoreToRgGlobs(cwd) : [];

        // Combine all arguments
        const allArgs = [...baseArgs, ...gitignoreGlobs, '\\S'];

        // First, run ripgrep to get all non-empty lines
        // Using \S to match lines with at least one non-whitespace character
        const rgProcess = child_process.spawn(rgPath, allArgs, {
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
