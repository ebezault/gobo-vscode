import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';
import { encodeUint16 } from './eiffelUtilities';

export interface EiffelApplicationOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
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

export class EiffelDebugger extends EventEmitter {
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

	public async setBreakpoints(sourcePath: string, breakpoints: any): Promise<EiffelDebuggerResponse> {
		const response = await this.request('setBreakpoints', { sourcePath, breakpoints });
		if (!response.success) {
			throw new Error(response.message ?? 'Eiffel debugger configuration failed.');
		}
		return response;
	}

	public async threads(): Promise<EiffelDebuggerResponse> {
		const response = await this.request('threads');
		if (!response.success) {
			throw new Error(response.message ?? 'Eiffel debugger configuration failed.');
		}
		return response;
	}

	public async stackTrace(threadId: number, startFrame: number, levels: number): Promise<EiffelDebuggerResponse> {
		const response = await this.request('stackTrace', { threadId, startFrame, levels });
		if (!response.success) {
			throw new Error(response.message ?? 'Eiffel debugger configuration failed.');
		}
		return response;
	}

	public async scopes(threadId: number, frameId: string): Promise<EiffelDebuggerResponse> {
		const response = await this.request('scopes', { threadId, frameId });
		if (!response.success) {
			throw new Error(response.message ?? 'Eiffel debugger configuration failed.');
		}
		return response;
	}

	public async argumentVariables(frameId: string, filter: string, start: number, count: number): Promise<EiffelDebuggerResponse> {
		const response = await this.request('argumentVariables', { frameId, filter, start, count });
		if (!response.success) {
			throw new Error(response.message ?? 'Eiffel debugger configuration failed.');
		}
		return response;
	}

	public async localVariables(frameId: string, filter: string, start: number, count: number): Promise<EiffelDebuggerResponse> {
		const response = await this.request('localVariables', { frameId, filter, start, count });
		if (!response.success) {
			throw new Error(response.message ?? 'Eiffel debugger configuration failed.');
		}
		return response;
	}

	public async attributeVariables(objectAddress: string, typeId: number, filter: string, start: number, count: number): Promise<EiffelDebuggerResponse> {
		const response = await this.request('attributeVariables', { objectAddress, typeId, filter, start, count });
		if (!response.success) {
			throw new Error(response.message ?? 'Eiffel debugger configuration failed.');
		}
		return response;
	}

	public async continue(): Promise<EiffelDebuggerResponse> {
		const response = await this.request('continue');
		if (!response.success) {
			throw new Error(response.message ?? 'Eiffel debugger configuration failed.');
		}
		return response;
	}

	public async pause(): Promise<EiffelDebuggerResponse> {
		const response = await this.request('pause');
		if (!response.success) {
			throw new Error(response.message ?? 'Eiffel debugger configuration failed.');
		}
		return response;
	}

	public async next(threadId: number): Promise<EiffelDebuggerResponse> {
		const response = await this.request('next', { threadId });
		if (!response.success) {
			throw new Error(response.message ?? 'Eiffel debugger configuration failed.');
		}
		return response;
	}

	public async stepIn(threadId: number): Promise<EiffelDebuggerResponse> {
		const response = await this.request('stepIn', { threadId });
		if (!response.success) {
			throw new Error(response.message ?? 'Eiffel debugger configuration failed.');
		}
		return response;
	}

	public async stepOut(threadId: number): Promise<EiffelDebuggerResponse> {
		const response = await this.request('stepOut', { threadId });
		if (!response.success) {
			throw new Error(response.message ?? 'Eiffel debugger configuration failed.');
		}
		return response;
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

	private async request(
		command: string,
		args: Record<string, unknown> = {},
		timeoutMs = EiffelDebugger.REQUEST_TIMEOUT_MS
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
				break;
			case 'setBreakpoints':
				bytes = Buffer.from(String(message.arguments?.sourcePath), 'utf8');
				length = encodeUint16(bytes.length);
				this.eiffelDebuggerInput.write(length);
				this.eiffelDebuggerInput.write(bytes);
				const breakpoints = Array.isArray(message.arguments?.breakpoints)
					? message.arguments?.breakpoints as Array<{ line?: number }>
					: [];
				if (!breakpoints) {
					bytes = Buffer.from(String(0), 'utf8');
					length = encodeUint16(bytes.length);
					this.eiffelDebuggerInput.write(length);
					this.eiffelDebuggerInput.write(bytes);
				} else {
					bytes = Buffer.from(String(breakpoints.length), 'utf8');
					length = encodeUint16(bytes.length);
					this.eiffelDebuggerInput.write(length);
					this.eiffelDebuggerInput.write(bytes);
					for (const breakpoint of breakpoints) {
						bytes = Buffer.from(String(breakpoint.line), 'utf8');
						length = encodeUint16(bytes.length);
						this.eiffelDebuggerInput.write(length);
						this.eiffelDebuggerInput.write(bytes);
					}
				}
				break;
			case 'stackTrace':
				bytes = Buffer.from(String(message.arguments?.threadId), 'utf8');
				length = encodeUint16(bytes.length);
				this.eiffelDebuggerInput.write(length);
				this.eiffelDebuggerInput.write(bytes);
				bytes = Buffer.from(String(message.arguments?.startFrame), 'utf8');
				length = encodeUint16(bytes.length);
				this.eiffelDebuggerInput.write(length);
				this.eiffelDebuggerInput.write(bytes);
				bytes = Buffer.from(String(message.arguments?.levels), 'utf8');
				length = encodeUint16(bytes.length);
				this.eiffelDebuggerInput.write(length);
				this.eiffelDebuggerInput.write(bytes);
				break;
			case 'next':
			case 'stepIn':
			case 'stepOut':
				bytes = Buffer.from(String(message.arguments?.threadId), 'utf8');
				length = encodeUint16(bytes.length);
				this.eiffelDebuggerInput.write(length);
				this.eiffelDebuggerInput.write(bytes);
				break;
			case 'scopes':
				bytes = Buffer.from(String(message.arguments?.threadId), 'utf8');
				length = encodeUint16(bytes.length);
				this.eiffelDebuggerInput.write(length);
				this.eiffelDebuggerInput.write(bytes);
				bytes = Buffer.from(String(message.arguments?.frameId), 'utf8');
				length = encodeUint16(bytes.length);
				this.eiffelDebuggerInput.write(length);
				this.eiffelDebuggerInput.write(bytes);
				break;
			case 'argumentVariables':
			case 'localVariables':
				bytes = Buffer.from(String(message.arguments?.frameId), 'utf8');
				length = encodeUint16(bytes.length);
				this.eiffelDebuggerInput.write(length);
				this.eiffelDebuggerInput.write(bytes);
				bytes = Buffer.from(String(message.arguments?.filter), 'utf8');
				length = encodeUint16(bytes.length);
				this.eiffelDebuggerInput.write(length);
				this.eiffelDebuggerInput.write(bytes);
				bytes = Buffer.from(String(message.arguments?.start), 'utf8');
				length = encodeUint16(bytes.length);
				this.eiffelDebuggerInput.write(length);
				this.eiffelDebuggerInput.write(bytes);
				bytes = Buffer.from(String(message.arguments?.count), 'utf8');
				length = encodeUint16(bytes.length);
				this.eiffelDebuggerInput.write(length);
				this.eiffelDebuggerInput.write(bytes);
				break;
			case 'attributeVariables':
				bytes = Buffer.from(String(message.arguments?.objectAddress), 'utf8');
				length = encodeUint16(bytes.length);
				this.eiffelDebuggerInput.write(length);
				this.eiffelDebuggerInput.write(bytes);
				bytes = Buffer.from(String(message.arguments?.typeId), 'utf8');
				length = encodeUint16(bytes.length);
				this.eiffelDebuggerInput.write(length);
				this.eiffelDebuggerInput.write(bytes);
				bytes = Buffer.from(String(message.arguments?.filter), 'utf8');
				length = encodeUint16(bytes.length);
				this.eiffelDebuggerInput.write(length);
				this.eiffelDebuggerInput.write(bytes);
				bytes = Buffer.from(String(message.arguments?.start), 'utf8');
				length = encodeUint16(bytes.length);
				this.eiffelDebuggerInput.write(length);
				this.eiffelDebuggerInput.write(bytes);
				bytes = Buffer.from(String(message.arguments?.count), 'utf8');
				length = encodeUint16(bytes.length);
				this.eiffelDebuggerInput.write(length);
				this.eiffelDebuggerInput.write(bytes);
				break;
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

	private async waitForEvent(
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
