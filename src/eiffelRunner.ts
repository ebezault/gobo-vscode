import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as https from 'https';
import * as tar from 'tar';
import { path7za } from '7zip-bin';

const outputChannel = vscode.window.createOutputChannel("Gobo Eiffel compilation");
const goboEiffelDiagnostics = vscode.languages.createDiagnosticCollection('gobo-eiffel');

export function activateEiffelCompiler(context: vscode.ExtensionContext) {
	context.subscriptions.push(outputChannel);
	context.subscriptions.push(goboEiffelDiagnostics);
}

/**
 * Compile an Eiffel file.
 * @param filePath Path to the Eiffel source file
 * @param outputDir Path to Eiffel file binary executable
 * @param context VSCode extension context
 * Returns the exit code
 */
export async function compileEiffelFile(filePath: string, outputDir: string, context: vscode.ExtensionContext): Promise<number> {
	const goboEiffelPath = await getOrInstallOrUpdateGoboEiffel(context);
	if (!goboEiffelPath) {
		return -1;
	}

	const compiler = path.join(goboEiffelPath, 'bin', 'gec' + (os.platform() === 'win32' ? '.exe' : ''));
	try {
		if (!fs.existsSync(compiler)) {
			throw new Error(`File not found: ${compiler}`);
		}
		try {
			fs.accessSync(compiler, fs.constants.X_OK);
		} catch {
			throw new Error(`File is not executable: ${compiler}`);
		}
	} catch (err: any) {
		vscode.window.showErrorMessage(`Failed to launch Gobo Eiffel compiler: ${err.message}`);
		return -1;
	}

	goboEiffelDiagnostics.clear();
	outputChannel.clear();
	outputChannel.show(true);
	outputChannel.appendLine(`Compiling ${filePath}...`);

	let error_code: number = 0;
	try {
		error_code = await spawnWithZigProgress(
			compiler,
			[filePath],
			outputDir
		);
	} catch (err: any) {
		if (error_code === 0) {
			error_code = -1;
		}
		vscode.window.showErrorMessage(err.message);
	}
	return error_code;
}

/**
 * Runs an already-compiled Eiffel file binary in Terminal.
 * @param filePath Path to the Eiffel source file
 * @param outputDir Path to Eiffel file binary executable
 * Returns a Promise that resolves when the process exits.
 */
export async function runEiffelFileBinary(filePath: string, outputDir: string): Promise<void> {
	// Original file path, e.g., "x/y/z/hello_world.e"
	const baseName = path.basename(filePath, path.extname(filePath)); // "hello_world"
	const exeFile = (os.platform() === 'win32' ? `.\\"${baseName}.exe"` : `./"${baseName}"`);

	// Run executable in terminal
	const terminal = vscode.window.createTerminal({
		name: 'Gobo Eiffel Run',
		cwd: outputDir,
	});
	terminal.show();
	terminal.sendText(exeFile);
	return;
}

/**
 * Compile and/or run an Eiffel file.
 * @param filePath Path to the Eiffel source file
 * @param outputDir Path to Eiffel file binary executable
 * @param context VSCode extension context
 * Returns a Promise that resolves when the process exits.
 */
export async function compileAndRunEiffelFile(filePath: string, outputDir: string, context: vscode.ExtensionContext): Promise<void> {
	compileEiffelFile(filePath, outputDir, context).then((code) => {
		if (code === 0) {
			runEiffelFileBinary(filePath, outputDir);
		}
	});
	return;
}

async function getOrInstallOrUpdateGoboEiffel(context: vscode.ExtensionContext): Promise<string | undefined> {
	// 1. Check $GOBO
	if (process.env.GOBO && fs.existsSync(process.env.GOBO)) {
		return process.env.GOBO;
	}

	// 2. Check previously stored path
	let goboPath = vscode.workspace.getConfiguration('gobo-eiffel').get<string>('goboEiffelPath');
	if (!goboPath) {
		goboPath = context.globalState.get<string>('goboEiffelPath');
	}

	if (goboPath && fs.existsSync(path.join(goboPath, 'bin', 'gec' + (os.platform() === 'win32' ? '.exe' : '')))) {
		// If we have a stored version, check update
		return await checkForUpdates(context, goboPath);
	}

	// 3. Ask user
	let message: string;
	if (goboPath) {
		message = `Gobo Eiffel installation not found in ${goboPath}.`;
	} else {
		message = 'Gobo Eiffel installation not found.';
	}
	const choice = await vscode.window.showInformationMessage(
		message,
		{ modal: true },
		'Download & Install',
		'Select Existing Installation'
	);

	if (choice === 'Select Existing Installation') {
		const uris = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			openLabel: 'Select Gobo Eiffel Folder',
		});
		if (uris && uris.length > 0) {
			const chosen = uris[0].fsPath;
			context.globalState.update('goboEiffelPath', chosen);
			return chosen;
		}
		return;
	}

	if (choice === 'Download & Install') {
		const latestRelease = await fetchLatestRelease();
		if (!latestRelease) {
			vscode.window.showErrorMessage('Could not fetch latest Gobo Eiffel release');
			return;
		}
		return await downloadAndExtract(latestRelease.assetUrl, latestRelease.assetName, context, latestRelease.tag);
	}

	return; // Cancel
}

// How long to wait between checks (ms)
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function checkForUpdates(context: vscode.ExtensionContext, goboPath: string) {
	// Read configuration
	const automaticUpdateCheck = vscode.workspace.getConfiguration('gobo-eiffel').get<boolean>('automaticUpdateCheck');
	if (!automaticUpdateCheck) {
		return goboPath; // No auto check
	}

	// Read last check timestamp from global state
	const lastCheck = context.globalState.get<number>('lastGoboEiffelUpdateCheck', 0);
	const now = Date.now();

	if (now - lastCheck < ONE_DAY_MS) {
		// Last check was within the last day — skip
		return goboPath;
	}

	// Update stored timestamp before doing network call
	await context.globalState.update('lastGoboEiffelUpdateCheck', now);

	// Fetch release
	const latestRelease = await fetchLatestRelease();
	if (!latestRelease) {
		vscode.window.showErrorMessage('Could not fetch latest Gobo Eiffel release');
		return goboPath;
	}

	const goboVersion = (await getLocalGoboVersion(goboPath)) ?? '';

	if (latestRelease && goboVersion && latestRelease.tag !== goboVersion) {
		const choice = await vscode.window.showInformationMessage(
			`A newer release of Gobo Eiffel (${latestRelease.tag}) is available.`,
			{ modal: true },
			'Update',
			'Skip'
		);
		if (choice === 'Update') {
			return await downloadAndExtract(latestRelease.assetUrl, latestRelease.assetName, context);
		}
		if (choice === 'Skip') {
			return goboPath;
		}
		return; // Cancel
	}

	return goboPath;
}

async function downloadAndExtract(assetUrl: string, assetName: string, context: vscode.ExtensionContext, version?: string): Promise<string | undefined> {
	const installUris = await vscode.window.showOpenDialog({
		canSelectFiles: false,
		canSelectFolders: true,
		openLabel: 'Select Install Folder',
	});
	if (!installUris || installUris.length === 0) {
		return;
	}
	const installDir = installUris[0].fsPath;
	try {
		ensureEmptyDir(installDir); // throws if not empty
	} catch (err: any) {
		vscode.window.showErrorMessage(`Installation cannot continue: ${err.message}`);
		return;
	}

	const destFile = path.join(installDir, assetName);

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `Downloading ${assetName}`,
			cancellable: false
		},
		async (progress) => {
			let lastFloor = 0;
			await downloadFile(assetUrl, destFile, (percent) => {
				const floor = Math.floor(percent);
				const delta = floor - lastFloor;
				if (delta > 0) {
					progress.report({ increment: delta, message: `${floor}%` });
					lastFloor = floor;
				}
			});
			// final report to reach 100%
			progress.report({ increment: 100 - lastFloor, message: '100%' });
		}
	);

	try {
		if (!fs.existsSync(destFile)) {
			throw new Error(`File not found: ${destFile}`);
		}
		const stats = fs.statSync(destFile);
		if (stats.size === 0) {
			throw new Error(`File is empty: ${destFile}`);
		}
	} catch (err: any) {
		vscode.window.showErrorMessage(`Download failed: ${err.message}`);
		return;
	}

	// Detect extension and extract accordingly
	if (assetName.endsWith('.tar.xz')) {
		try {
			await extractTarXzWithProgress(destFile, installDir);
		} catch (err) {
			vscode.window.showErrorMessage('Extraction failed: ' + String(err));
			return;
		}
	} else if (assetName.endsWith('.7z')) {
		try {
			await extract7zWithProgress(destFile, installDir);
		} catch (err) {
			vscode.window.showErrorMessage('Extraction failed: ' + String(err));
			return;
		}
	} else {
		vscode.window.showErrorMessage('Unknown archive format: ' + assetName);
		return;
	}

	// Move content up if it’s in a "gobo" folder
	const goboFolder = path.join(installDir, 'gobo');
	if (fs.existsSync(goboFolder) && fs.lstatSync(goboFolder).isDirectory()) {
		const files = fs.readdirSync(goboFolder);
		for (const file of files) {
			const src = path.join(goboFolder, file);
			const dest = path.join(installDir, file);
			fs.renameSync(src, dest);
		}
		// Remove inner gobo folder
		fs.rmSync(goboFolder, { recursive: true, force: true });
	}
	// Cleanup archive
	fs.rmSync(destFile, { force: true });

	const gecPath = path.join(installDir, 'bin', 'gec' + (os.platform() === 'win32' ? '.exe' : ''));
	try {
		if (!fs.existsSync(gecPath)) {
			throw new Error(`File not found: ${gecPath}`);
		}
	} catch (err: any) {
		vscode.window.showErrorMessage(`Failed to install Gobo Eiffel: ${err.message}`);
		return;
	}

	context.globalState.update('goboEiffelPath', installDir);
	return installDir;
}

/**
 * Get the Gobo Eiffel version for a given installation folder
 * @param goboPath folder containing bin/gec
 * @returns version string like "gobo-25.09" or undefined on error
 */
async function getLocalGoboVersion(goboPath: string): Promise<string | undefined> {
	const gecPath = path.join(goboPath, 'bin', 'gec' + (os.platform() === 'win32' ? '.exe' : ''));
	try {
		if (!fs.existsSync(gecPath)) {
			throw new Error(`File not found: ${gecPath}`);
		}
		try {
			fs.accessSync(gecPath, fs.constants.X_OK);
		} catch {
			throw new Error(`File is not executable: ${gecPath}`);
		}
	} catch (err: any) {
		return;
	}
	return new Promise((resolve) => {
		cp.exec(`"${gecPath}" --version`, (err, stdout) => {
			if (err) {
				resolve(undefined);
			}

			// stdout might be like: "gec version 25.09.02+27e7bdab2"
			const match = stdout.match(/gec version (\d+)\.(\d+)/);
			if (match) {
				const major = match[1];
				const minor = match[2];
				resolve(`gobo-${major}.${minor}`);
			} else {
				resolve(undefined);
			}
		});
	});
}

async function fetchLatestRelease(): Promise<{ tag: string; assetUrl: string; assetName: string } | undefined> {
	const apiUrl = 'https://api.github.com/repos/gobo-eiffel/gobo/releases/latest';
	return new Promise((resolve) => {
		https
			.get(apiUrl, { headers: { 'User-Agent': 'VSCode-GoboEiffel' } }, (res) => {
				let data = '';
				res.on('data', (chunk) => (data += chunk));
				res.on('end', () => {
					try {
						const release = JSON.parse(data);
						const nodePlatform = os.platform();
						let platformForPackage: string;
						if (nodePlatform === 'win32') {
							platformForPackage = 'windows';
						} else if (nodePlatform === 'darwin') {
							platformForPackage = 'macos';
						} else if (nodePlatform === 'linux') {
							platformForPackage = 'linux';
						} else {
							platformForPackage = nodePlatform; // fallback
						}
						const nodeArch = os.arch();
						let archForPackage: string;
						if (nodeArch === 'x64') {
							archForPackage = 'x86_64';
						} else if (nodeArch === 'arm64') {
							archForPackage = 'arm64';
						} else {
							archForPackage = nodeArch;
						}

						const asset = release.assets.find((a: any) =>
							a.name.includes(platformForPackage) && a.name.includes(archForPackage)
						);
						if (asset) {
							resolve({
								tag: release.tag_name,
								assetUrl: asset.browser_download_url,
								assetName: asset.name,
							});
						} else {
							resolve(undefined);
						}
					} catch {
						resolve(undefined);
					}
				});
			})
			.on('error', () => resolve(undefined));
	});
}

/**
 * Download a URL to dest. Follows redirects and reports absolute percent (0..100).
 * @param url remote URL
 * @param dest local destination file path
 * @param onProgress optional callback(percent:number) where percent is 0..100 (absolute)
 */
export function downloadFile(
	url: string,
	dest: string,
	onProgress?: (percent: number) => void
): Promise<void> {
	return new Promise((resolve, reject) => {
		const maxRedirects = 10;
		let redirects = 0;

		// ensure dest directory exists
		try {
			fs.mkdirSync(path.dirname(dest), { recursive: true });
		} catch (err) {
			// ignore
		}

		function doGet(u: string) {
			const opts = new URL(u);
			const req = https.get(
				{
					hostname: opts.hostname,
					path: opts.pathname + opts.search,
					port: opts.port ? Number(opts.port) : undefined,
					protocol: opts.protocol,
					headers: {
						'User-Agent': 'VSCode-GoboEiffel',
						'Accept': 'application/octet-stream'
					}
				},
				(res) => {
					// follow redirects
					if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode)) {
						const loc = res.headers.location;
						res.resume(); // consume and discard
						if (loc && redirects < maxRedirects) {
							redirects++;
							const next = new URL(loc, u).toString();
							doGet(next);
							return;
						} else {
							reject(new Error('Too many redirects or missing Location header'));
							return;
						}
					}

					if (res.statusCode !== 200) {
						reject(new Error(`Download failed: HTTP ${res.statusCode}`));
						return;
					}

					const total = parseInt((res.headers['content-length'] || '0') as string, 10);
					let downloaded = 0;
					let lastReportedPercent = 0;

					const fileStream = fs.createWriteStream(dest);
					fileStream.on('error', (err) => {
						// cleanup partial file
						try { fs.unlinkSync(dest); } catch (_) {}
						reject(err);
					});

					res.on('data', (chunk: Buffer) => {
						downloaded += chunk.length;
						if (total > 0 && typeof onProgress === 'function') {
							const percent = Math.min(100, (downloaded / total) * 100);
							// only call back if percent went up by at least 1%
							if (Math.floor(percent) !== Math.floor(lastReportedPercent)) {
								lastReportedPercent = percent;
								try { onProgress(percent); } catch (_) {}
							}
						}
					});

					res.pipe(fileStream);

					fileStream.on('finish', () => {
						fileStream.close(() => resolve());
					});

					res.on('error', (err) => {
						try { fileStream.close(); } catch (_) {}
						try { fs.unlinkSync(dest); } catch (_) {}
						reject(err);
					});
				}
			);

			req.on('error', (err) => {
				reject(err);
			});
		}

		doGet(url);
	});
}

/**
 * Extract a .7z archive using the embedded 7za binary from 7zip-bin.
 * Reports progress via vscode.withProgress (percentage).
 */
export async function extract7zWithProgress(
	compressedFile: string,
	extractedDir: string
): Promise<void> {
	if (!fs.existsSync(compressedFile)) {
		throw new Error(`Archive not found: ${compressedFile}`);
	}
	if (!path7za || typeof path7za !== 'string') {
		throw new Error('7za binary not available');
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `Installing ${path.basename(compressedFile)}`,
			cancellable: false
		},
		(progress) => {
			return new Promise<void>((resolve, reject) => {
				let totalFiles = 0;
				let lastPercent = -1;

				// First, list the archive contents to count files
				const listProc = cp.spawn(path7za, ['l', '-ba', compressedFile], { stdio: ['ignore', 'pipe', 'pipe'] });
				let listOutput = '';
				listProc.stdout.on('data', (buf: Buffer) => { listOutput += buf.toString(); });
				listProc.stderr.on('data', (buf: Buffer) => { listOutput += buf.toString(); });

				listProc.on('close', (code) => {
					if (code !== 0) {
						return reject(new Error(`7z list failed with code ${code}`));
					}

					// Count lines that look like files (skip header/footer)
					const entries = listOutput.split(/\r?\n/);
					totalFiles = entries.length;
					if (totalFiles === 0) {
						totalFiles = 1; // avoid div by zero
					}

					// Extract with output parsing
					const args = ['x', compressedFile, `-o${extractedDir}`, '-y', '-bsp1'];
					const extractProc = cp.spawn(path7za, args, { stdio: ['ignore', 'pipe', 'pipe'] });

					extractProc.stdout.on('data', (buf: Buffer) => {
						const s = buf.toString();
						const lines = s.split(/\r?\n/);
						for (const line of lines) {
							const matchProgress = line.match(/\d+%\s*(\d+)/);
							if (matchProgress) {
								const extractedFiles = matchProgress[1];
								const percent = Math.floor((Number(extractedFiles) / totalFiles) * 100);
								if (percent > lastPercent) {
									progress.report({ increment: percent - lastPercent, message: `${percent}%` });
									lastPercent = percent;
								}
							}
						}
					});

					extractProc.on('close', (code) => {
						if (lastPercent < 100) {
							progress.report({ increment: 100 - lastPercent, message: '100%' });
						}
						if (code === 0) {
							resolve();
						} else {
							reject(new Error(`7z extraction failed with code ${code}`));
						}
					});

					extractProc.on('error', (err) => reject(err));
				});
			});
		}
	);
}

/**
 * Extract a .tar.xz archive with approximate progress
 */
export async function extractTarXzWithProgress(
	compressedFile: string,
	extractedDir: string
): Promise<void> {
	if (!fs.existsSync(compressedFile)) {
		throw new Error(`Archive file not found: ${compressedFile}`);
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: `Installing ${path.basename(compressedFile)}`,
			cancellable: false
		},
		async (progress) => {
			// 1. Count total files
			let totalFiles = 0;
			await tar.list({
				file: compressedFile,
				onentry: () => { totalFiles++; }
			});

			if (totalFiles === 0) {
				totalFiles = 1; // prevent division by zero
			}

			// 2. Extract with progress
			let extractedFiles = 0;
			let lastPercent = -1;

			await tar.x({
				file: compressedFile,
				cwd: extractedDir,
				onentry: () => {
					extractedFiles++;
					const percent = Math.floor((extractedFiles / totalFiles) * 100);
					if (percent > lastPercent) {
						progress.report({ increment: percent - lastPercent, message: `${percent}%` });
						lastPercent = percent;
					}
				}
			});
		}
	);
}

/**
 * Ensures that a directory exists and is empty.
 * - If it does not exist → creates it.
 * - If it exists but is not empty → throws an error (or optionally clears it).
 */
export function ensureEmptyDir(dirPath: string, clearIfNotEmpty = false): void {
	// If directory does not exist → create it
	if (!fs.existsSync(dirPath)) {
		fs.mkdirSync(dirPath, { recursive: true });
		return;
	}

	// It exists → check contents
	const files = fs.readdirSync(dirPath);
	if (files.length === 0) {
		return; // Already empty
	}

	if (clearIfNotEmpty) {
		// Remove everything inside
		for (const file of files) {
			const filePath = path.join(dirPath, file);
			fs.rmSync(filePath, { recursive: true, force: true });
		}
	} else {
		// Fail if not empty
		throw new Error(`Installation folder "${dirPath}" is not empty.`);
	}
}

export async function spawnWithZigProgress(
	compilerPath: string,
	args: string[],
	cwd: string
): Promise<number> {
	const childEnv = { ...process.env, ZIG_PROGRESS: '3', ZIG_VERBOSE_CC: 'true' };

	let error_code: number = 0;
	await new Promise<void>((resolve, reject) => {
		const child = cp.spawn(
			compilerPath,
			args,
			{ cwd: cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }
		);

		const diagnosticsByFile = new Map<string, vscode.Diagnostic[]>();
		let lastDiagnosticMessage: string | undefined;
		let lastDiagnosticLine: number = 1;
		let lastDiagnosticColumn: number = 1;
		let lastDiagnosticCode: string | undefined;
		let lastDiagnosticFile: string | undefined;
		let outBuffer = '';
		if (child.stdout) {
			child.stdout.setEncoding('utf8');
			child.stdout.on('data', (d: string) => {
				let needDiagnosticsUpdate: boolean = false;
				outBuffer += d.replace(/\r/g, '');
				let idx: number;
				while ((idx = outBuffer.indexOf('\n')) !== -1) {
					const line = outBuffer.slice(0, idx);
					outBuffer = outBuffer.slice(idx + 1);
					outputChannel.appendLine(line);

					const validityErrorMatch = line.match(/^\[([^\]]+)\] (class [a-zA-Z][a-zA-Z0-9_]*) \((([a-zA-Z][a-zA-Z0-9_]*),)?(\d+),(\d+)\)(: .*)$/);
					const syntaxErrorMatch = line.match(/^(Syntax error:)$/);
					if (validityErrorMatch) {
						lastDiagnosticLine = Number(validityErrorMatch[5]);
						lastDiagnosticColumn = Number(validityErrorMatch[6]);
						lastDiagnosticMessage = validityErrorMatch[2];
						if (validityErrorMatch[4]) {
							lastDiagnosticMessage += ` (${validityErrorMatch[4]})`;
						}
						lastDiagnosticMessage += validityErrorMatch[7];
						lastDiagnosticCode = validityErrorMatch[1];
					} else if (syntaxErrorMatch) {
						lastDiagnosticMessage = syntaxErrorMatch[1];
					} else if (lastDiagnosticMessage) {
						if (line === '----') {
							if (lastDiagnosticFile) {
								let endColumn: number = lastDiagnosticColumn + 1;
								let errorLine = getNthLineSync(lastDiagnosticFile, lastDiagnosticLine);
								if (errorLine) {
									errorLine = errorLine.slice(lastDiagnosticColumn - 1);
									const identifierOrIntegerMatch = errorLine.match(/^([a-zA-Z0-9_]+)/); // Possibly with lexical error.
									if (identifierOrIntegerMatch) {
										endColumn = lastDiagnosticColumn + identifierOrIntegerMatch[1].length;
									}
								}
								const lastDiagnostic = new vscode.Diagnostic(
									new vscode.Range(lastDiagnosticLine - 1, lastDiagnosticColumn - 1, lastDiagnosticLine - 1, endColumn - 1),
									lastDiagnosticMessage,
									vscode.DiagnosticSeverity.Error
								);
								lastDiagnostic.source = 'Eiffel';
								if (lastDiagnosticCode) {
									lastDiagnostic.code = lastDiagnosticCode;
								}
								if (!diagnosticsByFile.has(lastDiagnosticFile)) {
									diagnosticsByFile.set(lastDiagnosticFile, []);
								}
								diagnosticsByFile.get(lastDiagnosticFile)!.push(lastDiagnostic);
								needDiagnosticsUpdate = true;
							}
							lastDiagnosticFile = undefined;
							lastDiagnosticMessage = undefined;
							lastDiagnosticLine = 1;
							lastDiagnosticColumn = 1;
							lastDiagnosticCode = undefined;
						} else {
							const validityErrorFileMatch = line.match(/^\tclass [a-zA-Z0-9_]+: (.*)$/);
							const SyntaxErrorFileMatch = line.match(/^line (\d+) column (\d+) in (.*)$/);
							if (validityErrorFileMatch) {
								lastDiagnosticFile = validityErrorFileMatch[1];
							} else if (SyntaxErrorFileMatch) {
								lastDiagnosticLine = Number(SyntaxErrorFileMatch[1]);
								lastDiagnosticColumn = Number(SyntaxErrorFileMatch[2]);
								lastDiagnosticFile = SyntaxErrorFileMatch[3];
							} else {
								lastDiagnosticMessage += '\n' + line;
							}
						}
					}
				}

				// If buffer grows very large without newline, try to handle as a single message (fallback)
				const MAX_BUF = 1024 * 64; // 64KB
				if (outBuffer.length > MAX_BUF) {
					outBuffer = '';
				}

				// Real-time update
				if (needDiagnosticsUpdate) {
					goboEiffelDiagnostics.clear();
					for (const [file, diags] of diagnosticsByFile) {
						const uri = vscode.Uri.file(file);
						goboEiffelDiagnostics.set(uri, diags);
					}
				}
			});
		}

		let errBuffer = '';
		if (child.stderr) {
			child.stderr.setEncoding('utf8');
			child.stderr.on('data', (d: string) => {
				// Try to split by newline; if no newline, accumulate in buffer
				errBuffer += d;
				// If we have newline(s), process each line
				let idx: number;
				while ((idx = errBuffer.indexOf('\n')) !== -1) {
					const line = errBuffer.slice(0, idx);
					errBuffer = errBuffer.slice(idx + 1);
					const matchCFile = line.match(/[\/\\]zig[\/\\]zig(\.exe)? clang (.*[\/\\])?([^\/\\]+\.[cS]) /);
					const matchIgnore = line.match(/^(output path: )|(include dir: )|(def file: )/);
					if (matchCFile) {
						const cFile = matchCFile[3];
						outputChannel.appendLine(cFile);
					} else if (!matchIgnore) {
						outputChannel.appendLine(line);
					}
				}

				// If buffer grows very large without newline, try to handle as a single message (fallback)
				const MAX_BUF = 1024 * 64; // 64KB
				if (errBuffer.length > MAX_BUF) {
					outputChannel.append(errBuffer);
					errBuffer = '';
				}
			});
		}

		child.on('error', (err) => {
			error_code = -1;
			reject(err);
		});
		child.on('close', (code) => {
			if (code !== null) {
				error_code = code;
			}
			if (code === 0){
				resolve();
			} else {
				reject(new Error(`Compilation failed with code ${code}`));
			}
		});
	});
	return error_code;
}

function getNthLineSync(filePath: string, n: number): string | undefined {
	if (n <= 0) {
		return undefined;
	}

	const fd = fs.openSync(filePath, 'r'); // open file descriptor
	const buffer = Buffer.alloc(1024);     // read in chunks
	let line = '';
	let lineCount = 0;
	let bytesRead: number;

	try {
		do {
			bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead > 0) {
				let chunk = buffer.toString('utf8', 0, bytesRead);
				for (let i = 0; i < chunk.length; i++) {
					const char = chunk[i];
					if (char === '\n') {
						lineCount++;
						if (lineCount === n) {
							// strip trailing \r if Windows line endings
							return line.replace(/\r$/, '');
						}
						line = '';
					} else {
						line += char;
					}
				}
			}
		} while (bytesRead > 0);

		// if file ended but maybe last line without newline
		if (line && lineCount + 1 === n) {
			return line.replace(/\r$/, '');
		}
	} catch (err) {
		return undefined;
	} finally {
		fs.closeSync(fd);
	}
	return undefined;
}
