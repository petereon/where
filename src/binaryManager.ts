import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import { promisify } from 'util';
import { getSearchConfig } from './utils';

const chmod = promisify(fs.chmod);
const mkdir = promisify(fs.mkdir);

export function checkBinaryExists(binaryPath: string): Promise<boolean> {
    return new Promise((resolve) => {
        child_process.exec(`command -v ${binaryPath}`, (error) => {
            resolve(!error);
        });
    });
}

export function getBinariesDir(context: vscode.ExtensionContext): string {
    return path.join(context.globalStorageUri.fsPath, 'bin');
}

export async function ensureBinariesDir(context: vscode.ExtensionContext): Promise<string> {
    const binDir = getBinariesDir(context);
    if (!fs.existsSync(binDir)) {
        await mkdir(binDir, { recursive: true });
    }
    return binDir;
}

export function getPlatformInfo(): { platform: string; arch: string; isSupported: boolean } {
    const platform = os.platform();
    const arch = os.arch();
    const isSupported = ['darwin', 'linux', 'win32'].includes(platform);
    return { platform, arch, isSupported };
}

export function getRipgrepDownloadUrl(): { url: string; filename: string } | null {
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

export function getFzfDownloadUrl(): { url: string; filename: string } | null {
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

export function downloadFile(url: string, destPath: string): Promise<void> {
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

export function extractArchive(archivePath: string, destDir: string, binaryName: string): Promise<string> {
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

export async function downloadAndInstallBinary(
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

export async function resolveBinaryPaths(context: vscode.ExtensionContext): Promise<{ rgPath: string; fzfPath: string } | null> {
    const config = getSearchConfig();
    let rgPath = config.rgPath;
    let fzfPath = config.fzfPath;

    // If paths are explicitly set by user, only use those
    if (config.rgPathSet) {
        const exists = await checkBinaryExists(rgPath);
        if (!exists) {
            vscode.window.showErrorMessage(`Configured ripgrep binary not found at: ${rgPath}`);
            return null;
        }
    } else {
        // Try to find global binary first
        const globalExists = await checkBinaryExists('rg');
        if (!globalExists) {
            // Check if we have a downloaded binary
            const binDir = getBinariesDir(context);
            const ext = os.platform() === 'win32' ? '.exe' : '';
            const downloadedPath = path.join(binDir, 'rg' + ext);

            if (fs.existsSync(downloadedPath)) {
                rgPath = downloadedPath;
            } else {
                // Offer to download
                const downloaded = await offerToDownloadBinary('rg', context);
                if (!downloaded) {
                    return null;
                }
                rgPath = downloaded;
            }
        }
        // else use global 'rg'
    }

    if (config.fzfPathSet) {
        const exists = await checkBinaryExists(fzfPath);
        if (!exists) {
            vscode.window.showErrorMessage(`Configured fzf binary not found at: ${fzfPath}`);
            return null;
        }
    } else {
        // Try to find global binary first
        const globalExists = await checkBinaryExists('fzf');
        if (!globalExists) {
            // Check if we have a downloaded binary
            const binDir = getBinariesDir(context);
            const ext = os.platform() === 'win32' ? '.exe' : '';
            const downloadedPath = path.join(binDir, 'fzf' + ext);

            if (fs.existsSync(downloadedPath)) {
                fzfPath = downloadedPath;
            } else {
                // Offer to download
                const downloaded = await offerToDownloadBinary('fzf', context);
                if (!downloaded) {
                    return null;
                }
                fzfPath = downloaded;
            }
        }
        // else use global 'fzf'
    }

    return { rgPath, fzfPath };
}

export async function offerToDownloadBinary(name: 'rg' | 'fzf', context: vscode.ExtensionContext): Promise<string | null> {
    // Check if platform is supported
    const { isSupported } = getPlatformInfo();
    if (!isSupported) {
        const displayName = name === 'rg' ? 'ripgrep (rg)' : 'fzf';
        vscode.window.showWarningMessage(
            `Required binary ${displayName} not found. Please install it manually.`,
            'Learn More'
        ).then(selection => {
            if (selection === 'Learn More') {
                vscode.env.openExternal(vscode.Uri.parse('https://github.com/petereon/where#requirements'));
            }
        });
        return null;
    }

    const displayName = name === 'rg' ? 'ripgrep (rg)' : 'fzf';
    const action = await vscode.window.showInformationMessage(
        `The where extension requires ${displayName} to function. Would you like to download and install it automatically?`,
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
    return await downloadAndInstallBinary(name, context);
}
