import * as fs from 'fs';
import * as path from 'path';

export function parseGitignore(gitignorePath: string): string[] {
    if (!fs.existsSync(gitignorePath)) {
        return [];
    }

    const content = fs.readFileSync(gitignorePath, 'utf8');
    const patterns: string[] = [];

    for (let line of content.split('\n')) {
        // Remove comments and trim
        const commentIndex = line.indexOf('#');
        if (commentIndex >= 0) {
            line = line.substring(0, commentIndex);
        }
        line = line.trim();

        // Skip empty lines
        if (!line) {
            continue;
        }

        // Handle negation patterns (ripgrep doesn't support them well in globs)
        if (line.startsWith('!')) {
            continue;
        }

        patterns.push(line);
    }

    return patterns;
}

export function convertGitignoreToRgGlobs(workspacePath: string): string[] {
    const globs: string[] = [];
    const gitignorePath = path.join(workspacePath, '.gitignore');

    const patterns = parseGitignore(gitignorePath);

    for (const pattern of patterns) {
        // Convert gitignore pattern to ripgrep glob
        let glob = pattern;

        // If pattern ends with /, it's a directory
        if (glob.endsWith('/')) {
            glob = glob.slice(0, -1);
            globs.push(`--glob=!${glob}`);
            globs.push(`--glob=!${glob}/**`);
        } else if (glob.includes('/')) {
            // Path-specific pattern
            globs.push(`--glob=!${glob}`);
        } else {
            // Pattern matches anywhere in tree
            globs.push(`--glob=!**/${glob}`);
            globs.push(`--glob=!${glob}`);
        }
    }

    // Always exclude .git directory
    globs.push('--glob=!.git');
    globs.push('--glob=!.git/**');

    return globs;
}
