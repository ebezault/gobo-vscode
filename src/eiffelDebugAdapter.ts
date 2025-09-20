import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { compileEiffelFile } from './eiffelCompiler';

export function activateEiffelDebugAdapter(context: vscode.ExtensionContext) {
	// Register debug configuration provider
	const provider: vscode.DebugConfigurationProvider = {
		resolveDebugConfiguration(folder, config, token) {
			if (!config.type) {
				config.type = 'eiffel';
			}
			if (!config.name) {
				config.name = 'Compile & Run Eiffel File';
			}
			if (!config.request) {
				config.request = 'launch';
			}
			if (!config.program) {
				const editor = vscode.window.activeTextEditor;
				if (!editor) {
					vscode.window.showErrorMessage('No active editor to run');
					return undefined;
				}
				config.program = editor.document.fileName;
			}
			return config;
		}
	};
	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider('eiffel', provider)
	);

	// Register debug adapter factory
	const factory: vscode.DebugAdapterDescriptorFactory = {
		createDebugAdapterDescriptor(session: vscode.DebugSession) {
			// Minimal stub DebugAdapter
			const emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
			const runCtx: RunContext = {};

			const stubAdapter: vscode.DebugAdapter = {
				onDidSendMessage: emitter.event, // <-- required property
				handleMessage: (message: any) => {
					// Only handle requests
					if (message?.type !== 'request') {
						return;
					}
					const cmd = message.command;
					// Stop button pressed
					if (cmd === 'disconnect') {
						if (runCtx.child) {
							try { runCtx.child.kill(); } catch (e) { /* ignore */ }
						}
						// Acknowledge disconnect request
						emitter.fire({
							type: 'response',
							request_seq: message.seq,
							success: true,
							command: 'disconnect'
						});
						// End session
						emitter.fire({ type: 'event', event: 'terminated', body: {} });
						return;
					}

					// Input from Debug Console → program stdin
					if (cmd === 'evaluate') {
						const expr: string | undefined = message.arguments?.expression;
						const context: string | undefined = message.arguments?.context;

						// Only treat REPL evaluate as stdin input (guard by context if you want)
						if (typeof expr === 'string' && (context === 'repl' || context === undefined)) {
							if (runCtx.child?.stdin && runCtx.child.stdin.writable) {
								// Send the expression as a line to stdin
								runCtx.child.stdin.write(expr + '\n');
							}
							// Respond to the evaluate request so VSCode is happy
							emitter.fire({
								type: 'response',
								request_seq: message.seq,
								success: true,
								command: 'evaluate',
								body: { result: '', variablesReference: 0 }
							});
						} else {
							// Not handled — send a default response
							emitter.fire({
								type: 'response',
								request_seq: message.seq,
								success: true,
								command: 'evaluate',
								body: { result: '', variablesReference: 0 }
							});
						}
						return;
					}
					// Older/custom 'input' request fallback (some clients)
					if (cmd === 'input') {
						const inputData = message.arguments?.text ?? '';
						if (runCtx.child?.stdin && runCtx.child.stdin.writable) {
							runCtx.child.stdin.write(inputData + '\n');
						}
						emitter.fire({
							type: 'response',
							request_seq: message.seq,
							success: true,
							command: 'input'
						});
						return;
					}
				},
				dispose: () => emitter.dispose()
			};

			// Original file path, e.g., "x/y/z/hello_world.e"
			const filePath = session.configuration.program;
			const baseName = path.basename(filePath, path.extname(filePath)); // "hello_world"
			const exeFile = (os.platform() === 'win32' ? `${baseName}.exe` : baseName);
			const fileDir = path.dirname(filePath);
			
			const runBinaryOnly = session.configuration.runBinaryOnly ?? false;
			if (runBinaryOnly) {
				runWithPipes(exeFile, fileDir, emitter, runCtx);
			} else {
				compileEiffelFile(filePath, fileDir, context).then((code) => {
					if (code === 0) {
						runWithPipes(exeFile, fileDir, emitter, runCtx);
					} else {
						// End session
						emitter.fire({ type: 'event', event: 'terminated', body: {} });
					}
				});
			}

			return new vscode.DebugAdapterInlineImplementation(stubAdapter);
		}
	};

	context.subscriptions.push(
		vscode.debug.registerDebugAdapterDescriptorFactory('eiffel', factory)
	);
}

interface RunContext {
	child?: cp.ChildProcessWithoutNullStreams;
}

// helper: run program directly with pipes
async function runWithPipes(
	program: string,
	cwd: string,
	emitter: vscode.EventEmitter<vscode.DebugProtocolMessage>,
	runCtx: RunContext
) {
	// Ensure the Debug Console (REPL) is visible
	vscode.commands.executeCommand('workbench.debug.action.toggleRepl');

	const child = cp.spawn(program, [], {
		cwd,
		stdio: ['pipe', 'pipe', 'pipe']
	});
	runCtx.child = child;

	// stdout → Debug Console
	child.stdout.on('data', (data) => {
		emitter.fire({
			type: 'event',
			event: 'output',
			body: {
				category: 'stdout',
				output: data.toString()
			}
		});
	});

	// stderr → Debug Console
	child.stderr.on('data', (data) => {
		emitter.fire({
			type: 'event',
			event: 'output',
			body: {
				category: 'stderr',
				output: data.toString()
			}
		});
	});

	child.on('exit', (code) => {
		emitter.fire({
			type: 'event',
			event: 'output',
			body: {
				category: 'console',
				output: `\nProcess exited with code ${code}\n`
			}
		});
		emitter.fire({ type: 'event', event: 'terminated', body: {} });
	});
}
