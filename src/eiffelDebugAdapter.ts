import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { compileEiffelSystem, getExecutableName, getEnvironmentVariables } from './eiffelCompiler';
import { expandEnvVars } from './eiffelUtilities';
import { EiffelDebugger, EiffelApplicationOptions } from './eiffelDebugger';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { Readable, Writable } from 'stream';

export function activateEiffelDebugAdapter(context: vscode.ExtensionContext) {
	// Register debug configuration provider
	const provider: vscode.DebugConfigurationProvider = {
		async resolveDebugConfiguration(folder, config) {
			// Add missing parts to the Launch config before executing it.
			config = config || {};
			if (!config.type) {
				config.type = 'eiffel';
			}
			if (!config.name) {
				config.name = 'Compile & Run Eiffel System';
			}
			if (!config.request) {
				config.request = 'launch';
			}
			if (!config.ecfFile) {
				const editor = vscode.window.activeTextEditor;
				if (!editor) {
					vscode.window.showErrorMessage('No active editor to run');
					return undefined;
				}
				config.ecfFile = editor.document.fileName;
			} else {
				config.ecfFile = await expandEnvVars(config.ecfFile, await getEnvironmentVariables(context), context);
			}
			if (config.buildDir) {
				config.buildDir = await expandEnvVars(config.buildDir, await getEnvironmentVariables(context), context);
			}
			if (config.workingDir) {
				config.workingDir = await expandEnvVars(config.workingDir, await getEnvironmentVariables(context), context);
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
;			const emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
			let child: ChildProcessWithoutNullStreams | undefined = undefined;
			let eiffelDebugger: EiffelDebugger | undefined = undefined;
			let exited = false;
			let terminated = false;
			let launched = false;
			let linesStartAt1 = true;
			let columnsStartAt1 = true;
			let nextFrameId = 1;
			let nextVariablesReference = 1;

			// These maps are used by the DAP scopes/variables requests.
			const variablesReferences = new Map<number, { kind: string, id: string, threadId?: number, typeId?: number }>();
			const frameIds = new Map<number, { threadId: number, frameId: string }>();

			function sendEvent(event: string, body: Record<string, unknown> = {}) {
				emitter.fire({
					type: 'event',
					event,
					body
				} as vscode.DebugProtocolMessage);
			}

			function sendResponse(
				request: any,
				success: boolean,
				body?: unknown,
				message?: string
			) {
				const response: any = {
					type: 'response',
					request_seq: request.seq,
					success,
					command: request.command
				};
				if (body !== undefined) {
					response.body = body;
				}
				if (message) {
					response.message = message;
				}
				emitter.fire(response);
			}

			function sendErrorResponse(
				request: any,
				message: string
			) {
				sendResponse(request, false, undefined, message);
			}

			function sendOutput(
				output: string,
				category: string = 'console'
			) {
				sendEvent('output', { category, output });
			}

			async function handleRequest(request: any): Promise<void> {
				const args = request.arguments ?? {};

				try {
					switch (request.command) {
					case 'initialize': {
						linesStartAt1 = request.linesStartAt1 ?? true;
						columnsStartAt1 = request.columnsStartAt1 ?? true;
						sendResponse(request, true, {
							supportsConfigurationDoneRequest: true,
							supportsEvaluateForHovers: false,
							supportsSetVariable: false,
							supportsVariablePaging: true,
							supportsTerminateRequest: true,
							supportsFunctionBreakpoints: false,
							supportsConditionalBreakpoints: false,
							supportsHitConditionalBreakpoints: false,
							supportsDelayedStackTraceLoading: true,
							supportsStepBack: false,
							supportsRestartRequest: false,
							supportsRestartFrame: false,
							supportsGotoTargetsRequest: false,
							supportsStepInTargetsRequest: false,
							supportsCompletionsRequest: false,
							supportsModulesRequest: false,
							supportsCancelRequest: false,
							supportsSingleThreadExecutionRequests: false
							//exceptionBreakpointFilters: [
								// {
								// 	filter: 'raised',
								// 	label: 'Raised Exceptions',
								// 	default: false
								// },
								// {
								// 	filter: 'uncaught',
								// 	label: 'Uncaught Exceptions',
								// 	default: false
								// },
								// {
								// 	filter: 'userUncaught',
								// 	label: 'User Uncaught Exceptions',
								// 	default: false
								// }
							//]
						});
						return;
					}
					case 'launch': {
						try {
							if (launched) {
								throw new Error('Eiffel application has already been launched.');
							}
							launched = true;

							const filePath = session.configuration.ecfFile ?? '';
							const defaultCwd = fs.existsSync(filePath) ? path.dirname(filePath) : '.';
							const ecfTarget = session.configuration.ecfTarget;
							const compilationOptions = session.configuration.compilationOptions ?? [];
							const buildDir = session.configuration.buildDir || defaultCwd;
							const workingDir = session.configuration.workingDir || defaultCwd;
							const args: string[] = session.configuration.args ?? [];
							const userEnv = session.configuration.environmentVariables ?? {};
							const environmentVariables: NodeJS.ProcessEnv = {...process.env, ...userEnv};
							const compileOnly = session.configuration.compileOnly ?? false;
							const runOnly = session.configuration.runOnly ?? false;
							if (!runOnly) {
								const code = await compileEiffelSystem(
									filePath,
									ecfTarget,
									compilationOptions,
									buildDir,
									environmentVariables,
									context
								);

								if (compileOnly || code !== 0) {
									sendResponse(request, true);
									sendOutput(
										code !== 0
											? `Compilation failed with exit code ${code}.\n`
											: 'Compilation completed; execution skipped.\n'
									);
									terminate();
									return;
								}
							}

							// Ensure the Debug Console (REPL) is visible
							vscode.commands.executeCommand('workbench.debug.action.toggleRepl');

							const name = await getExecutableName(filePath, ecfTarget, context);
							if (!name) {
								throw new Error(`No executable name found for ${filePath}`);
							}
							const exeFile = path.join(buildDir, name + (os.platform() === 'win32' ? '.exe' : ''));
							if (!fs.existsSync(exeFile)) {
								throw new Error(`Executable not found: ${exeFile}`);
							}
							if (os.platform() !== 'win32') {
								try {
									fs.accessSync(exeFile, fs.constants.X_OK);
								} catch {
									throw new Error(`File is not executable: ${exeFile}`);
								}
							}
							await start(exeFile, args, {
								cwd: workingDir,
								env: environmentVariables
							});
							sendResponse(request, true);
							sendEvent('initialized');
						} catch (error) {
							stop();
							sendErrorResponse(request, error instanceof Error ? error.message : String(error));
						}
						return;
					}

					case 'setBreakpoints': {
						if (!child || !isRunning()) {
							throw new Error('Eiffel application is not running.');
						}
						if (!eiffelDebugger) {
							throw new Error('Eiffel debugger is not available.');
						}
						const sourcePath = args.source?.path;
						if (typeof sourcePath !== 'string') {
							sendResponse(request, true, { breakpoints: [] });
							return;
						}
						const requestedBreakpoints = Array.isArray(args.breakpoints)
							? (args.breakpoints as Array<{ line: number }>).map(bp => ({
								line: (linesStartAt1 ? bp.line : bp.line + 1)
							}))
							: [];
						const reply = await eiffelDebugger.setBreakpoints(sourcePath, requestedBreakpoints);
						const breakpoints = Array.isArray(reply.body?.breakpoints) ? reply.body?.breakpoints : [];
						if (!linesStartAt1) {
							for (const breakpoint of breakpoints) {
								if (breakpoint.line && typeof breakpoint.line === 'number') {
									breakpoint.line--;
								}
							}
						}
						sendResponse(request, true, {
							breakpoints: breakpoints
						});
						return;
					}

					case 'configurationDone': {
						try {
							if (!child || !isRunning()) {
								throw new Error('Eiffel application is not running.');
							}
							if (!eiffelDebugger) {
								throw new Error('Eiffel debugger is not available.');
							}
							await eiffelDebugger.configurationDone();
							sendResponse(request, true);
						} catch (error) {
							stop();
							sendErrorResponse(
								request,
								error instanceof Error ? error.message : String(error)
							);
						}
						return;
					}

					case 'threads': {
						if (!child || !isRunning()) {
							throw new Error('Eiffel application is not running.');
						}
						if (!eiffelDebugger) {
							throw new Error('Eiffel debugger is not available.');
						}
						const reply = await eiffelDebugger.threads();
						sendResponse(request, true, {
							threads: reply.body?.threads ?? []
						});
						return;
					}

					case 'stackTrace': {
						if (!child || !isRunning()) {
							throw new Error('Eiffel application is not running.');
						}
						if (!eiffelDebugger) {
							throw new Error('Eiffel debugger is not available.');
						}
						const threadId = args.threadId;
						const startFrame = args.startFrame ?? 0;
						const levels = args.levels ?? 0;
						const reply = await eiffelDebugger.stackTrace(threadId, startFrame + 1, levels);
						const stackFrames = Array.isArray(reply.body?.stackFrames) ? reply.body?.stackFrames : [];
						const totalFrames = reply.body?.totalFrames ?? 0;
						for (const stackFrame of stackFrames) {
							if (typeof stackFrame.id !== 'number') {
								frameIds.set(
									nextFrameId,
									stackFrame.id
								);
								stackFrame.id = nextFrameId;
								nextFrameId++;
							}
						}
						sendResponse(request, true, {
							stackFrames: stackFrames,
							totalFrames: totalFrames
						});
						return;
					}

					case 'scopes': {
						if (!child || !isRunning()) {
							throw new Error('Eiffel application is not running.');
						}
						if (!eiffelDebugger) {
							throw new Error('Eiffel debugger is not available.');
						}
						const frameId = frameIds.get(args.frameId);
						if (!frameId) {
							throw new Error(`Unknown frame id ${args.frameId}.`);
						}
						const reply = await eiffelDebugger.scopes(frameId.threadId, frameId.frameId);
						const scopes = Array.isArray(reply.body?.scopes) ? reply.body?.scopes : [];
						for (const scope of scopes) {
							if (typeof scope.variablesReference !== 'number') {
								variablesReferences.set(
									nextVariablesReference,
									scope.variablesReference
								);
								scope.variablesReference = nextVariablesReference;
								nextVariablesReference++;
							}
						}
						sendResponse(request, true, { scopes });
						return;
					}

					case 'variables': {
						if (!child || !isRunning()) {
							throw new Error('Eiffel application is not running.');
						}
						if (!eiffelDebugger) {
							throw new Error('Eiffel debugger is not available.');
						}
						const filter = args.filter ?? "all";
						const start = args.start ?? 0;
						const count = args.count ?? 0;
						const variablesReference = variablesReferences.get(args.variablesReference);
						if (!variablesReference) {
							throw new Error(`Unknown variables reference ${args.variablesReference}.`);
						}
						let reply;
						switch (variablesReference.kind) {
							case 'arguments': {
								const threadId = variablesReference.threadId ?? 0;
								reply = await eiffelDebugger.argumentVariables(threadId, variablesReference.id, filter, start, count);
								break;
							}
							case 'locals': {
								const threadId = variablesReference.threadId ?? 0;
								reply = await eiffelDebugger.localVariables(threadId, variablesReference.id, filter, start, count);
								break;
							}
							case 'attributes': {
								const typeId = variablesReference.typeId ?? 0;
								reply = await eiffelDebugger.attributeVariables(variablesReference.id, typeId, filter, start, count);
								break;
							}
							default: {
								throw new Error(`Unknown variable kind ${variablesReference.kind}.`);
							}
						}
						const variables = Array.isArray(reply.body?.variables) ? reply.body?.variables : [];
						for (const variable of variables) {
							if (typeof variable.variablesReference !== 'number') {
								variablesReferences.set(
									nextVariablesReference,
									variable.variablesReference
								);
								variable.variablesReference = nextVariablesReference;
								nextVariablesReference++;
							}
						}
						sendResponse(request, true, { variables });
						return;
					}

					case 'continue': {
						if (!child || !isRunning()) {
							throw new Error('Eiffel application is not running.');
						}
						if (!eiffelDebugger) {
							throw new Error('Eiffel debugger is not available.');
						}
						const threadId = args.threadId;
						const reply = await eiffelDebugger.continue();
						frameIds.clear();
						variablesReferences.clear();
						sendResponse(request, true, reply.body);
						return;
					}

					case 'pause': {
						if (!child || !isRunning()) {
							throw new Error('Eiffel application is not running.');
						}
						if (!eiffelDebugger) {
							throw new Error('Eiffel debugger is not available.');
						}
						const threadId = args.threadId;
						const reply = await eiffelDebugger.pause();
						frameIds.clear();
						variablesReferences.clear();
						sendResponse(request, true, {});
						return;
					}

					case 'next': {
						if (!child || !isRunning()) {
							throw new Error('Eiffel application is not running.');
						}
						if (!eiffelDebugger) {
							throw new Error('Eiffel debugger is not available.');
						}
						const threadId = args.threadId;
						const reply = await eiffelDebugger.next(threadId);
						frameIds.clear();
						variablesReferences.clear();
						sendResponse(request, true, reply.body);
						return;
					}

					case 'stepIn': {
						if (!child || !isRunning()) {
							throw new Error('Eiffel application is not running.');
						}
						if (!eiffelDebugger) {
							throw new Error('Eiffel debugger is not available.');
						}
						const threadId = args.threadId;
						const reply = await eiffelDebugger.stepIn(threadId);
						frameIds.clear();
						variablesReferences.clear();
						sendResponse(request, true, reply.body);
						return;
					}

					case 'stepOut': {
						if (!child || !isRunning()) {
							throw new Error('Eiffel application is not running.');
						}
						if (!eiffelDebugger) {
							throw new Error('Eiffel debugger is not available.');
						}
						const threadId = args.threadId;
						const reply = await eiffelDebugger.stepOut(threadId);
						frameIds.clear();
						variablesReferences.clear();
						sendResponse(request, true, reply.body);
						return;
					}

					case 'evaluate': {
						if (!child || !isRunning()) {
							throw new Error('Eiffel application is not running.');
						}
						if (!eiffelDebugger) {
							throw new Error('Eiffel debugger is not available.');
						}
						const expression = args.expression;
						const frameId = args.frameId;
						const context = args.context;
						if (typeof expression !== 'string') {
							sendResponse(request, false, undefined, 'Missing expression.');
							return;
						}
						if (args.context === 'repl') {
							// Keep the existing behavior: Debug Console REPL input
							// is sent to the running program's standard input.
							writeInput(expression + '\n');
							return;
						}
						sendResponse(request, true, {
							result: '<debug evaluation unavailable>',
							variablesReference: 0
						});
						return;
					}

					case 'disconnect': {
						try {
							if (!child || !isRunning()) {
								throw new Error('Eiffel application is not running.');
							}
							if (!eiffelDebugger) {
								throw new Error('Eiffel debugger is not available.');
							}
							await eiffelDebugger.disconnect();
						} catch {
							// The runtime may already have exited or closed its pipes.
						} finally {
							stop();
							sendResponse(request, true);
							terminate();
						}
						return;
					}

					case 'terminate': {
						stop();
						sendResponse(request, true);
						terminate();
						return;
					}

					default:
						sendErrorResponse(request, `Unsupported DAP request: ${request.command}`);
						return;
					}

				} catch (error) {
					sendErrorResponse(request, error instanceof Error ? error.message : String(error));
				}
			}

			function isRunning(): boolean {
				return !!(child) &&
					!exited &&
					child.exitCode === null &&
					child.signalCode === null;
			}

			async function start(
				program: string,
				args: string[],
				options: EiffelApplicationOptions
			): Promise<void> {
				if (child) {
					throw new Error('Eiffel application has already been started.');
				}

				const GOBO_DEBUG_PIPE_IN = 4;
				const GOBO_DEBUG_PIPE_OUT = 3;
				child = spawn(program, args, {
					cwd: options.cwd,
					env: { ...options.env, GOBO_DEBUG_PIPE_IN: GOBO_DEBUG_PIPE_IN.toString(), GOBO_DEBUG_PIPE_OUT: GOBO_DEBUG_PIPE_OUT.toString() },
					stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe']
				});
	
				// FD 3: Eiffel application -> Debug adapter.
				const eiffelDebuggerOutput = child.stdio[GOBO_DEBUG_PIPE_OUT] as Readable;
				if (!eiffelDebuggerOutput) {
					throw new Error('Could not open Eiffel debugger output pipe.');
				}
				// FD 4: Debug adapter -> Eiffel application.
				const eiffelDebuggerInput = child.stdio[GOBO_DEBUG_PIPE_IN] as Writable;
				if (!eiffelDebuggerInput ) {
					throw new Error('Could not open Eiffel debugger input pipe.');;
				}
				eiffelDebugger = new EiffelDebugger(
					eiffelDebuggerOutput,
					eiffelDebuggerInput
				);

				eiffelDebugger.on('output', (output: {
					category: string;
					output: string;
				}) => {
					sendOutput(output.output, output.category);
				});

				eiffelDebugger.on('eiffelDebuggerEvent', (message: any) => {
					// Eiffel debugger event bodies should follow the DAP event schema.
					// For example: { event: "stopped", body: { reason: "breakpoint", threadId: 1 } }
					if (typeof message.event === 'string') {
						sendEvent(message.event, message.body ?? {});
					}
				});

				eiffelDebugger.on('eiffelDebuggerError', (error: Error) => {
					sendOutput(`Failed to run Eiffel application: ${error.message}\n`);
					terminate();
				});

				eiffelDebugger.on('eiffelDebuggerProtocolError', (message: string) => {
					sendOutput(`Eiffel debugger protocol error: ${message}\n`);
				});

				eiffelDebugger.on('eiffelDebuggerProtocolWarning', (message: string) => {
					sendOutput(`Eiffel debugger protocol warning: ${message}\n`);
				});

				eiffelDebugger.on('exit', ({ code, signal }: {
					code: number | null;
					signal: NodeJS.Signals | null;
				}) => {
					sendOutput(`\nProcess exited with code ${code}` + (signal ? ` (signal ${signal})` : '') + '\n');
					terminate();
				});

				child.stdout.on('data', data => {
					sendOutput(data.toString(), 'stdout');
				});

				child.stderr.on('data', data => {
					sendOutput(data.toString(), 'stderr');
				});

				child.on('error', error => {
					sendOutput(`Failed to run Eiffel application: ${error.message}\n`);
					terminate();
					finish();
				});

				child.on('exit', (code, signal) => {
					eiffelDebugger?.abort(
						new Error('Eiffel application exited.')
					);
					terminate();
					exit(code, signal);
				});
				await eiffelDebugger.initialize();
			}

			function stop() {
				eiffelDebugger?.abort(new Error('Eiffel debugging session stopped.'));
				if (isRunning()) {
					child?.kill();
				}
			}
			function terminate() {
				if (terminated) {
					return;
				}
				terminated = true;
				sendEvent('terminated');
			}

			function exit(
				code: number | null,
				signal: NodeJS.Signals | null
			): void {
				finish();
				sendOutput(`\nProcess exited with code ${code}` + (signal ? ` (signal ${signal})` : '') + '\n');
				sendEvent('exited', { exitCode: code });
			}

			function finish(): void {
				if (exited) {
					return;
				}
				exited = true;
			}

			function writeInput(text: string): boolean {
				const stdin = child?.stdin;
				if (!isRunning() || !stdin || !stdin.writable) {
					return false;
				}
				return stdin.write(text);
			}

			const adapter: vscode.DebugAdapter = {
				onDidSendMessage: emitter.event,

				handleMessage(message: any) {
					if (message?.type === 'request') {
						void handleRequest(message);
					}
				},

				dispose() {
					stop();
					emitter.dispose();
				}
			};

			return new vscode.DebugAdapterInlineImplementation(adapter);
		}
	};

	context.subscriptions.push(
		vscode.debug.registerDebugAdapterDescriptorFactory('eiffel', factory)
	);
}
