import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { compileEiffelSystem, getExecutableName, getEnvironmentVariables } from './eiffelCompiler';
import { expandEnvVars } from './eiffelUtilities';
import { DebugAdapterProtocol, DebugAdapterResponse } from './eiffelDebugger';

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
			const emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
			const eiffelDebugger = new DebugAdapterProtocol();

			let terminated = false;
			let launched = false;
			let configurationDone = false;
			let nextVariableReference = 1;

			// These maps are used by the DAP scopes/variables requests.
			const variableHandles = new Map<number, unknown>();

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

			async function eiffelDebuggerRequest(
				command: string,
				args: Record<string, unknown> = {}
			): Promise<DebugAdapterResponse> {
				const reply = await eiffelDebugger.request(command, args);
				if (!reply.success) {
					throw new Error(reply.message || `Eiffel debugger command failed: ${command}`);
				}
				return reply;
			}

			async function handleRequest(request: any): Promise<void> {
				const args = request.arguments ?? {};

				try {
					switch (request.command) {
					case 'initialize': {
						sendResponse(request, true, {
							supportsConfigurationDoneRequest: true,
							supportsEvaluateForHovers: true,
							supportsSetVariable: false,
							supportsTerminateRequest: true,
							supportsConditionalBreakpoints: false,
							supportsHitConditionalBreakpoints: false,
							supportsFunctionBreakpoints: false,
							supportsStepBack: false,
							supportsRestartRequest: false,
							exceptionBreakpointFilters: [
								{
									filter: 'raised',
									label: 'Raised Exceptions',
									default: false
								},
								{
									filter: 'uncaught',
									label: 'Uncaught Exceptions',
									default: false
								},
								{
									filter: 'userUncaught',
									label: 'User Uncaught Exceptions',
									default: false
								}
							]
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
										compileOnly
											? 'Compilation completed; execution skipped.\n'
											: `Compilation failed with exit code ${code}.\n`
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
							await eiffelDebugger.start(exeFile, args, {
								cwd: workingDir,
								env: environmentVariables
							});
							sendResponse(request, true);
							sendEvent('initialized');
						} catch (error) {
							eiffelDebugger.stop();
							sendErrorResponse(request, error instanceof Error ? error.message : String(error));
						}
						return;
					}

					case 'setBreakpoints': {
						const sourcePath = args.source?.path;
						if (typeof sourcePath !== 'string') {
							sendResponse(request, true, { breakpoints: [] });
							return;
						}

						const requestedBreakpoints = Array.isArray(args.breakpoints)
							? args.breakpoints.map((bp: any) => ({
								line: bp.line,
								column: bp.column
							}))
							: [];

						const reply = await eiffelDebuggerRequest('setBreakpoints', {
							sourcePath: sourcePath,
							breakpoints: requestedBreakpoints
						});

						sendResponse(request, true, {
							breakpoints: reply.body?.breakpoints ?? []
						});
						return;
					}

					case 'setExceptionBreakpoints':
						// Exception handling is not implemented in the Eiffel runtime yet.
						// Acknowledge the request so VS Code can continue the debug session.
						sendResponse(request, true);
						return;

					case 'configurationDone': {
						try {
							await eiffelDebuggerRequest('configurationDone');
							configurationDone = true;
							sendResponse(request, true);
						} catch (error) {
							eiffelDebugger.stop();
							sendErrorResponse(
								request,
								error instanceof Error ? error.message : String(error)
							);
						}
						return;
					}
					case 'threads': {
						const reply = await eiffelDebuggerRequest('threads');
						sendResponse(request, true, {
							threads: reply.body?.threads ?? []
						});
						return;
					}

					case 'stackTrace': {
						const reply = await eiffelDebuggerRequest('stackTrace', {
							threadId: args.threadId,
							startFrame: args.startFrame ?? 0,
							levels: args.levels ?? 0
						});
						sendResponse(request, true, reply.body ?? {
							stackFrames: [],
							totalFrames: 0
						});
						return;
					}

					case 'scopes': {
						const reply = await eiffelDebuggerRequest('scopes', {
							frameId: args.frameId
						});
						const scopes = reply.body?.scopes ?? [];

						// Preserve runtime-supplied variable references.
						for (const scope of scopes) {
							if (typeof scope.variablesReference === 'number') {
								variableHandles.set(
									scope.variablesReference,
									{ kind: 'runtime', reference: scope.variablesReference }
								);
							}
						}
						sendResponse(request, true, { scopes });
						return;
					}

					case 'variables': {
						const reply = await eiffelDebuggerRequest('variables', {
							variablesReference: args.variablesReference,
							filter: args.filter,
							start: args.start,
							count: args.count
						});
						sendResponse(request, true, {
							variables: reply.body?.variables ?? []
						});
						return;
					}

					case 'continue':
					case 'next':
					case 'stepIn':
					case 'stepOut':
					case 'pause': {
	
						// The Eiffel application should acknowledge the command promptly.
						// The eventual stop/continue is reported as a runtime event.
						const reply = await eiffelDebuggerRequest(request.command, {
							threadId: args.threadId
						});
						sendResponse(request, true, reply.body);
						return;
					}

					case 'evaluate': {
						const expression = args.expression;
						if (typeof expression !== 'string') {
							sendResponse(request, false, undefined, 'Missing expression.');
							return;
						}

						if (args.context === 'repl') {
							// Keep the existing behavior: Debug Console REPL input
							// is sent to the running program's standard input.
							eiffelDebugger.writeInput(expression + '\n');
							sendResponse(request, true, {
								result: '',
								variablesReference: 0
							});
							return;
						}

						const reply = await eiffelDebuggerRequest('evaluate', {
							expression,
							frameId: args.frameId,
							context: args.context
						});
						sendResponse(request, true, reply.body ?? {
							result: '',
							variablesReference: 0
						});
						return;
					}
					case 'disconnect': {
						try {
							await eiffelDebuggerRequest('disconnect');
						} catch {
							// The runtime may already have exited or closed its pipes.
						} finally {
							eiffelDebugger.stop();
							sendResponse(request, true);
							terminate();
						}
						return;
					}
					case 'terminate': {
						eiffelDebugger.stop();
						sendResponse(request, true);
						terminate();
						return;
					}
					default:
						sendErrorResponse(request, `Unsupported DAP request: ${request.command}`);
						return;
					}
				} catch (error) {
					sendErrorResponse(request,error instanceof Error ? error.message : String(error));
				}
			}

			function terminate() {
				if (terminated) {
					return;
				}
				terminated = true;
				sendEvent('terminated');
			}

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

			eiffelDebugger.on('exit', ({ code, signal }: {
				code: number | null;
				signal: NodeJS.Signals | null;
			}) => {
				sendOutput(`\nProcess exited with code ${code}` + (signal ? ` (signal ${signal})` : '') + '\n');
				terminate();
			});

			const adapter: vscode.DebugAdapter = {
				onDidSendMessage: emitter.event,

				handleMessage(message: any) {
					if (message?.type === 'request') {
						void handleRequest(message);
					}
				},

				dispose() {
					eiffelDebugger.stop();
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
