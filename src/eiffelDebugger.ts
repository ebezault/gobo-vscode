import { spawn } from 'child_process';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import { encodeUint16 } from './eiffelUtilities';

export interface DebugAdapterResponse {
	id: number;
	success: boolean;
	body?: any;
	message?: string;
}

export interface EiffelApplicationOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export class DebugAdapterProtocol extends EventEmitter {
	private child?: ChildProcessWithoutNullStreams;
	private eiffelDebuggerOutput?: Readable;
	private eiffelDebuggerInput?: Writable;
	private eiffelDebuggerProtocol?: EiffelDebuggerProtocol;
	private nextId = 1;
	private exited = false;
	private pending = new Map<number, {
		resolve: (reply: DebugAdapterResponse) => void;
		reject: (error: Error) => void;
	}>();

	public get isRunning(): boolean {
		return !!this.child &&
			!this.exited &&
			this.child.exitCode === null &&
			this.child.signalCode === null;
	}

	public async start(
		program: string,
		args: string[],
		options: EiffelApplicationOptions
	): Promise<void> {
		if (this.child) {
			throw new Error('Eiffel application has already been started.');
		}

		this.child = spawn(program, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe']
		});

		const child = this.child;

		// FD 3: Eiffel application -> Debug adapter.
		this.eiffelDebuggerOutput = child.stdio[3] as Readable;
		if (!this.eiffelDebuggerOutput) {
			throw new Error('Could not open Eiffel debugger output pipe.');
		}
		// FD 4: Debug adapter -> Eiffel application.
		this.eiffelDebuggerInput = child.stdio[4] as Writable;
		if (!this.eiffelDebuggerInput ) {
			throw new Error('Could not open Eiffel debugger input pipe.');;
		}
		const eiffelDebuggerProtocol = new EiffelDebuggerProtocol(
			this.eiffelDebuggerOutput,
			this.eiffelDebuggerInput
		);
		this.eiffelDebuggerProtocol = eiffelDebuggerProtocol;

		const lines = createInterface({ input: this.eiffelDebuggerOutput });
		lines.on('line', line => {
			let message: any;
			try {
				message = JSON.parse(line);
			} catch {
				this.emit('eiffelDebuggerProtocolError', `Invalid Eiffel debugger message: ${line}`);
				return;
			}
			if (typeof message.id === 'number') {
				const request = this.pending.get(message.id);
				if (request) {
					this.pending.delete(message.id);
					request.resolve(message as DebugAdapterResponse);
				}
			} else if (typeof message.event === 'string') {
				this.emit('eiffelDebuggerEvent', message);
			}
		});

		child.stdout.on('data', data => {
			this.emit('output', {
				category: 'stdout',
				output: data.toString()
			});
		});

		child.stderr.on('data', data => {
			this.emit('output', {
				category: 'stderr',
				output: data.toString()
			});
		});

		child.on('error', error => {
			this.emit('eiffelDebuggerError', error);
			this.finish(null, null);
		});

		child.on('exit', (code, signal) => {
			for (const request of this.pending.values()) {
				request.reject(new Error('Eiffel application exited.'));
			}
			this.pending.clear();
			this.finish(code, signal);
		});
		await eiffelDebuggerProtocol.initialize();
	}

	private finish(
		code: number | null,
		signal: NodeJS.Signals | null
	): void {
		if (this.exited) {
			return;
		}
		this.exited = true;
		this.emit('exit', { code, signal });
	}

	public async request(
		command: string,
		args: Record<string, unknown> = {}
	): Promise<DebugAdapterResponse> {

		const child = this.child;
		if (!child || !this.isRunning) {
			return Promise.reject(new Error('Eiffel application is not running.'));
		}
		const id = this.nextId++;
		let body: any = {};

		switch (command) {
		case 'setBreakpoints':
			body = {
				breakpoints: Array.isArray(args.breakpoints)
					? (args.breakpoints as Array<{ line?: number; column?: number }>).map(bp => ({
						verified: false,
						line: bp.line,
						column: bp.column,
						message: 'Eiffel application debugging is not implemented yet.'
					}))
					: []
			};
			break;
		case 'configurationDone': {
			const eiffelDebuggerProtocol = this.eiffelDebuggerProtocol;
			if (!eiffelDebuggerProtocol) {
				throw new Error('Eiffel debugger is not available.');
			}
			await eiffelDebuggerProtocol.configurationDone();
			body = {};
			break;
		}
		case 'threads':
			body = { threads: [] };
			break;

		case 'stackTrace':
			body = {
				stackFrames: [],
				totalFrames: 0
			};
			break;

		case 'scopes':
			body = { scopes: [] };
			break;

		case 'variables':
			body = { variables: [] };
			break;

		case 'evaluate':
			body = {
				result: '<debug evaluation unavailable>',
				variablesReference: 0
			};
			break;

		case 'continue':
			body = { allThreadsContinued: true };
			break;

		case 'next':
		case 'stepIn':
		case 'stepOut':
		case 'pause':
			body = {};
			break;

		case 'disconnect': {
			const eiffelDebuggerProtocol = this.eiffelDebuggerProtocol;
			if (!eiffelDebuggerProtocol) {
				throw new Error('Eiffel debugger is not available.');
			}
			await eiffelDebuggerProtocol.disconnect();
			body = {};
			break;
		}
		default:
			return Promise.resolve({
				id,
				success: false,
				message: `Unsupported Eiffel debugger command: ${command}`
			});
		}

		return Promise.resolve({
			id,
			success: true,
			body
		});
	}

	public writeInput(text: string): boolean {
		const stdin = this.child?.stdin;
		if (!this.isRunning || !stdin || !stdin.writable) {
			return false;
		}
		return stdin.write(text);
	}

	public stop(): void {
		this.eiffelDebuggerProtocol?.abort(new Error('Eiffel debugging session stopped.'));
		if (this.isRunning) {
			this.child?.kill();
		}
	}
}

interface EiffelDebuggerRequest {
	type: 'request';
	id: number;
	command: string;
	arguments?: Record<string, unknown>;
}

interface EiffelDebuggerResponse {
	type: 'response';
	id: number;
	success: boolean;
	body?: Record<string, unknown>;
	message?: string;
}

interface EiffelDebuggerEvent {
	type: 'event';
	event: string;
	body?: Record<string, unknown>;
	message?: string;
}

type EiffelDebuggerMessage = EiffelDebuggerResponse | EiffelDebuggerEvent;

interface EiffelDebuggerPendingRequest {
	resolve: (response: EiffelDebuggerResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

class EiffelDebuggerProtocol extends EventEmitter {
	private nextId = 1;
	private buffer = '';
	private pending = new Map<number, EiffelDebuggerPendingRequest>();
	private closed = false;
	private startedEvent?: EiffelDebuggerEvent;
	private static readonly REQUEST_TIMEOUT_MS = 10_000;

	constructor(
		private readonly eiffelDebuggerOutput: Readable,
		private readonly eiffelDebuggerInput: Writable
	) {
		super();

		eiffelDebuggerOutput.setEncoding('utf8');

		eiffelDebuggerOutput.on('data', (chunk: string | Buffer) => {
			this.receive(chunk.toString());
		});

		eiffelDebuggerOutput.on('end', () => {
			this.close(new Error('Eiffel debugger protocol pipe closed.'));
		});

		eiffelDebuggerOutput.on('error', error => {
			this.close(error);
		});

		eiffelDebuggerInput.on('error', error => {
			this.close(error);
		});
	}

	public async initialize(): Promise<void> {
		// The Eiffel debugger sends this event once its Eiffel debugger protocol is ready.
		await this.waitForEvent('started');
		const response = await this.request('initialize', { protocolVersion: 1 });
		if (!response.success) {
			throw new Error(response.message ?? 'Eiffel debugger initialization failed.');
		}
		const version = response.body?.protocolVersion;
		if (version !== 1) {
			throw new Error(`Unsupported Eiffel debugger protocol version: ${String(version)}`);
		}
	}

	public async configurationDone(): Promise<void> {
		const response = await this.request('configurationDone');
		if (!response.success) {
			throw new Error(response.message ?? 'Eiffel debugger configuration failed.');
		}
	}

	public async disconnect(): Promise<void> {
		if (this.closed) {
			return;
		}
		try {
			await this.request('disconnect');
		} finally {
			this.close(new Error('Eiffel debugger protocol disconnected.'));
		}
	}

	public abort(error: Error): void {
		this.close(error);
	}

	private request(
		command: string,
		args: Record<string, unknown> = {},
		timeoutMs = EiffelDebuggerProtocol.REQUEST_TIMEOUT_MS
	): Promise<EiffelDebuggerResponse> {
		if (this.closed) {
			return Promise.reject(new Error('Eiffel debugger protocol is closed.'));
		}
		const id = this.nextId++;
		const message: EiffelDebuggerRequest = {
			type: 'request',
			id,
			command,
			arguments: args
		};
		return new Promise<EiffelDebuggerResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				const pending = this.pending.get(id);
				if (!pending) {
					return;
				}
				this.pending.delete(id);
				pending.reject(
					new Error(`Timed out waiting for Eiffel debugger response to '${command}'.`)
				);
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });

			let bytes;
			let length;

			bytes = Buffer.from(message.type, 'utf8');
			length = encodeUint16(bytes.length);
			this.eiffelDebuggerInput.write(length);
			this.eiffelDebuggerInput.write(bytes);
			bytes = Buffer.from(message.id.toString(), 'utf8');
			length = encodeUint16(bytes.length);
			this.eiffelDebuggerInput.write(length);
			this.eiffelDebuggerInput.write(bytes);
			bytes = Buffer.from(message.command, 'utf8');
			length = encodeUint16(bytes.length);
			this.eiffelDebuggerInput.write(length);
			this.eiffelDebuggerInput.write(bytes);
			switch (message.command) {
			case 'initialize':
				bytes = Buffer.from(String(message.arguments?.protocolVersion), 'utf8');
				length = encodeUint16(bytes.length);
				this.eiffelDebuggerInput.write(length);
				this.eiffelDebuggerInput.write(bytes);
			}
		});
	}

	private receive(chunk: string): void {
		this.buffer += chunk;
		while (true) {
			const newline = this.buffer.indexOf('\n');
			if (newline < 0) {
				break;
			}
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line.length === 0) {
				continue;
			}
			let message: EiffelDebuggerMessage;
			try {
				message = JSON.parse(line) as EiffelDebuggerMessage;
			} catch {
				this.close(new Error(`Invalid JSON from Eiffel debugger: ${line}`));
				return;
			}
			if (message.type === 'response') {
				const pending = this.pending.get(message.id);
				if (!pending) {
					this.emit(
						'eiffelDebuggerprotocolWarning',
						`Response for unknown request ${message.id}`
					);
					continue;
				}
				clearTimeout(pending.timer);
				this.pending.delete(message.id);
				pending.resolve(message);
			} else if (message.type === 'event') {
				if (message.event === 'started') {
					this.startedEvent = message;
				}
				this.emit('eiffelDebuggerEvent', message);
			} else {
				this.close(new Error('Unknown Eiffel debugger message type.'));
				return;
			}
		}
	}

	private waitForEvent(
		eventName: string,
		timeoutMs = 10_000
	): Promise<EiffelDebuggerEvent> {
		if (eventName === 'started' && this.startedEvent) {
			const event = this.startedEvent;
			this.startedEvent = undefined;
			return Promise.resolve(event);
		}
		if (this.closed) {
			return Promise.reject(new Error('Eiffel debugger protocol is closed.'));
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`Timed out waiting for Eiffel debugger event '${eventName}'.`));
			}, timeoutMs);
			const onEvent = (event: EiffelDebuggerEvent) => {
				if (event.event === eventName) {
					cleanup();
					resolve(event);
				}
			};
			const onClosed = (error: Error) => {
				cleanup();
				reject(error);
			};
			const cleanup = () => {
				clearTimeout(timer);
				this.removeListener('eiffelDebuggerEvent', onEvent);
				this.removeListener('closed', onClosed);
			};
			this.on('eiffelDebuggerEvent', onEvent);
			this.on('closed', onClosed);
		});
	}

	private close(error: Error): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		this.emit('closed', error);
	}
}
