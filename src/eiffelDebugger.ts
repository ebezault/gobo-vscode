import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface } from 'readline';
import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

export interface EiffelApplicationReply {
	id: number;
	success: boolean;
	body?: any;
	message?: string;
}

export interface EiffelApplicationOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export class EiffelApplication extends EventEmitter {
	private child?: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private pending = new Map<number, {
		resolve: (reply: EiffelApplicationReply) => void;
		reject: (error: Error) => void;
	}>();

	public get isRunning(): boolean {
		return !!this.child &&
			this.child.exitCode === null &&
			this.child.signalCode === null;
	}

	public start(
		program: string,
		args: string[],
		options: EiffelApplicationOptions
	): void {
		if (this.child) {
			throw new Error('Eiffel application has already been started.');
		}

		this.child = spawn(program, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe']
		});

		const child = this.child;

		// FD 3: Eiffel application -> adapter.
		const eiffelApplicationOutput = child.stdio[3];
		if (!(eiffelApplicationOutput instanceof Readable)) {
			throw new Error('Could not open Eiffel application output pipe.');
		}

		const lines = createInterface({ input: eiffelApplicationOutput });

		lines.on('line', line => {
			let message: any;

			try {
				message = JSON.parse(line);
			} catch {
				this.emit('protocolError', `Invalid Eiffel application message: ${line}`);
				return;
			}

			if (typeof message.id === 'number') {
				const request = this.pending.get(message.id);
				if (request) {
					this.pending.delete(message.id);
					request.resolve(message as EiffelApplicationReply);
				}
			} else if (typeof message.event === 'string') {
				this.emit('runtimeEvent', message);
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
			this.emit('runtimeError', error);
		});

		child.on('exit', (code, signal) => {
			for (const request of this.pending.values()) {
				request.reject(new Error('Eiffel process exited.'));
			}
			this.pending.clear();

			this.emit('exit', { code, signal });
		});
	}

	public request(
		command: string,
		args: Record<string, unknown> = {}
	): Promise<EiffelApplicationReply> {
		const child = this.child;

		if (!child || !this.isRunning) {
			return Promise.reject(
				new Error('Eiffel application is not running.')
			);
		}

		// FD 4: adapter -> Eiffel application.
		const eiffelApplicationInput = child.stdio[4];
		if (!(eiffelApplicationInput instanceof Writable) || !eiffelApplicationInput.writable) {
			return Promise.reject(new Error('Eiffel application input pipe is closed.'));
		}

		const id = this.nextId++;
		const message = JSON.stringify({ id, command, ...args });

		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });

			eiffelApplicationInput.write(message + '\n', error => {
				if (error) {
					this.pending.delete(id);
					reject(error);
				}
			});
		});
	}

	public writeInput(text: string): boolean {
		const stdin = this.child?.stdin;
		if (!stdin || !stdin.writable) {
			return false;
		}
		return stdin.write(text);
	}

	public stop(): void {
		if (this.isRunning) {
			this.child?.kill();
		}
	}
}
