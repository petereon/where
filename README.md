# Where - VS Code Extension

A VS Code extension that wraps the powerful combination of `rg` (ripgrep) and `fzf` for blazingly fast project-wide search.

## Features

- **Dedicated sidebar panel** with search input
- **Instant search as you type** - results appear automatically
- **Infinite scrolling** - load more results on demand with a "Load More" button
- **Batched result loading** for responsive UI even with large result sets
- Fast project-wide search using ripgrep
- Fuzzy filtering with fzf (supports exact match with `'term`, etc.)
- Search results displayed in a collapsible tree view grouped by file (like native VS Code search)
- Click any result to open the file at the exact line
- Always visible and accessible from the activity bar
- Configurable binary paths and arguments
- Keybinding: `Cmd+Shift+Alt+F` (Mac) / `Ctrl+Shift+Alt+F` (Windows/Linux) to focus search
- Automatically excludes common directories (node_modules, .git, dist, out, build)

## Requirements

This extension requires the following binaries:

- `rg` (ripgrep)
- `fzf`

**Automatic Installation**: When you first activate the extension, if these binaries are not found in your system PATH, you'll be prompted to download and install them automatically. This works on macOS, Linux, and Windows.

**Manual Installation**: If you prefer to install manually or if automatic installation fails:
- `rg` (ripgrep) - [Installation guide](https://github.com/BurntSushi/ripgrep#installation)
- `fzf` - [Installation guide](https://github.com/junegunn/fzf#installation)

## Usage

1. Open a workspace/folder in VS Code
2. Click the search icon (🔍) in the activity bar to open the "Where" panel
   - Or press `Cmd+Shift+Alt+F` (Mac) / `Ctrl+Shift+Alt+F` (Windows/Linux)
3. Start typing your search query - results appear automatically as you type
   - Use fzf syntax: `'test` for exact match, `^prefix`, `suffix$`, etc.
   - Clear the input to clear results
4. Results appear in the "Results" section below as a collapsible tree view
   - Files are grouped with the number of matches
   - Expand files to see individual match lines
   - First 100 results load automatically
   - Click "Load More" at the bottom to load additional results (100 at a time)
5. Click on any result to open the file at that line

## Configuration

You can customize the extension in VS Code settings:

```json
{
  "where.rgPath": "rg",
  "where.fzfPath": "fzf",
  "where.rgArgs": "--line-number --glob=!node_modules --glob=!.git --glob=!dist --glob=!out --glob=!build"
}
```

## Development

To build and run the extension:

```bash
npm install
npm run compile
```

Then press F5 in VS Code to launch the Extension Development Host.

## How it works

The extension executes the following workflow:

1. **ripgrep** searches all files: `rg --line-number -u --hidden .`
2. **fzf** filters results: `fzf --filter="<query>" --ansi`
3. **JavaScript** parses the output to extract file, line number, and content
4. **TreeView** displays results in a collapsible panel grouped by file
5. **VS Code API** opens files when you click on results

Only `rg` and `fzf` binaries are used; all parsing, UI rendering, and file opening is handled in JavaScript using Node.js and VS Code APIs.
