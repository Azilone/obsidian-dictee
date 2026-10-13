/** Audio inputs: the microphone (Web Audio) and system output (native helper over stdout). */

import { SAMPLE_RATE } from './track';

export type PcmHandler = (pcm: Int16Array) => void;

export interface AudioSource {
	start(): Promise<void>;
	stop(): void;
}

// Runs on the audio thread: downmix, resample to 16 kHz (linear), convert to s16, post batches.
const WORKLET = `
class PcmTap extends AudioWorkletProcessor {
	constructor(opts) {
		super();
		this.ratio = sampleRate / opts.processorOptions.target;
		this.pos = 0;
		this.prev = 0;
		this.out = new Int16Array(1600);
		this.len = 0;
	}
	process(inputs) {
		const chans = inputs[0];
		if (!chans || !chans.length) return true;
		const n = chans[0].length;
		const mono = new Float32Array(n);
		for (const c of chans) for (let i = 0; i < n; i++) mono[i] += c[i] / chans.length;
		while (this.pos < n) {
			const i = Math.floor(this.pos);
			const f = this.pos - i;
			const a = i === 0 ? this.prev : mono[i - 1];
			const b = mono[i];
			const v = Math.max(-1, Math.min(1, a + (b - a) * f));
			this.out[this.len++] = v < 0 ? v * 32768 : v * 32767;
			if (this.len === this.out.length) {
				this.port.postMessage(this.out, [this.out.buffer]);
				this.out = new Int16Array(1600);
				this.len = 0;
			}
			this.pos += this.ratio;
		}
		this.pos -= n;
		this.prev = mono[n - 1];
		return true;
	}
}
registerProcessor('pcm-tap', PcmTap);
`;

export class MicSource implements AudioSource {
	private ctx: AudioContext | null = null;
	private stream: MediaStream | null = null;

	constructor(
		private deviceId: string,
		private onPcm: PcmHandler,
	) {}

	async start() {
		this.ctx = new AudioContext();
		const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
		try {
			await this.ctx.audioWorklet.addModule(url);
		} finally {
			URL.revokeObjectURL(url);
		}
		await this.connect();
	}

	private node: AudioWorkletNode | null = null;

	private async connect() {
		const ctx = this.ctx!;
		this.stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				deviceId: this.deviceId ? { exact: this.deviceId } : undefined,
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true,
				channelCount: 1,
			},
		});
		const node = new AudioWorkletNode(ctx, 'pcm-tap', { processorOptions: { target: SAMPLE_RATE } });
		node.port.onmessage = (e) => this.onPcm(e.data as Int16Array);
		ctx.createMediaStreamSource(this.stream).connect(node);
		// The node must reach the destination to be pulled; a muted gain keeps it silent.
		const mute = ctx.createGain();
		mute.gain.value = 0;
		node.connect(mute).connect(ctx.destination);
		this.node = node;
	}

	/**
	 * Mobile: the OS suspends the web view's audio when the app leaves the foreground or the
	 * screen locks. Back in front, resume the context and re-open the mic if its track ended.
	 */
	async revive() {
		const ctx = this.ctx;
		if (!ctx) return;
		if (ctx.state !== 'running') await ctx.resume().catch(() => {});
		if (this.stream?.getAudioTracks().some((t) => t.readyState === 'live')) return;
		this.stream?.getTracks().forEach((t) => t.stop());
		this.node?.disconnect();
		await this.connect();
	}

	stop() {
		this.stream?.getTracks().forEach((t) => t.stop());
		this.node?.disconnect();
		void this.ctx?.close();
		this.ctx = null;
		this.stream = null;
		this.node = null;
	}
}

/** Keeps the screen on while recording on mobile, where a locked screen cuts the mic. */
export class ScreenLock {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private lock: any = null;
	private wanted = false;

	async acquire() {
		this.wanted = true;
		if (!('wakeLock' in navigator) || this.lock) return;
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			this.lock = await (navigator as any).wakeLock.request('screen');
			this.lock.addEventListener('release', () => (this.lock = null));
		} catch {
			this.lock = null;
		}
	}

	/** The OS drops the lock whenever the page is hidden; take it again once visible. */
	async refresh() {
		if (this.wanted && document.visibilityState === 'visible') await this.acquire();
	}

	release() {
		this.wanted = false;
		void this.lock?.release?.();
		this.lock = null;
	}
}

export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
	try {
		const devices = await navigator.mediaDevices.enumerateDevices();
		return devices.filter((d) => d.kind === 'audioinput');
	} catch {
		return [];
	}
}

/* eslint-disable @typescript-eslint/no-var-requires */
export interface HelperEvent {
	event?: string;
	message?: string;
	ratio?: number;
}

/**
 * The native helper as an audio source: raw s16le 16 kHz mono PCM on stdout, JSON status lines
 * on stderr. Used for system audio capture (no args) and for decoding files (`--decode <path>`).
 */
export class HelperSource implements AudioSource {
	private proc: import('child_process').ChildProcess | null = null;
	private carry: Buffer | null = null;
	private stopping = false;
	/** Resolves when the helper exits (after `started`). */
	readonly done: Promise<number | null>;
	private resolveDone!: (code: number | null) => void;
	onEvent?: (e: HelperEvent) => void;

	constructor(
		private binary: string,
		private args: string[],
		private onPcm: PcmHandler,
		private onError: (message: string) => void,
	) {
		this.done = new Promise((r) => (this.resolveDone = r));
	}

	start(): Promise<void> {
		const { spawn } = require('child_process') as typeof import('child_process');
		const fs = require('fs') as typeof import('fs');
		if (!fs.existsSync(this.binary)) {
			return Promise.reject(new Error(`Helper audio introuvable : ${this.binary}`));
		}
		try {
			fs.chmodSync(this.binary, 0o755);
		} catch {
			/* read-only is fine if already executable */
		}
		return new Promise((resolve, reject) => {
			let started = false;
			const proc = spawn(this.binary, this.args, { stdio: ['pipe', 'pipe', 'pipe'] });
			this.proc = proc;
			proc.stdout!.on('data', (buf: Buffer) => {
				if (this.carry) {
					buf = Buffer.concat([this.carry, buf]);
					this.carry = null;
				}
				const even = buf.length & ~1;
				if (even < buf.length) this.carry = buf.subarray(even);
				if (!even) return;
				const pcm = new Int16Array(even / 2);
				for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(i * 2);
				this.onPcm(pcm);
			});
			let errBuf = '';
			proc.stderr!.on('data', (d: Buffer) => {
				errBuf += d.toString();
				let nl;
				while ((nl = errBuf.indexOf('\n')) >= 0) {
					const line = errBuf.slice(0, nl);
					errBuf = errBuf.slice(nl + 1);
					let msg: HelperEvent;
					try {
						msg = JSON.parse(line);
					} catch {
						continue;
					}
					if (msg.event === 'started' && !started) {
						started = true;
						resolve();
					} else if (msg.event === 'error') {
						if (!started) reject(new Error(msg.message));
						else this.onError(msg.message ?? 'Erreur de capture');
					}
					this.onEvent?.(msg);
				}
			});
			proc.on('error', (e) => (started ? this.onError(e.message) : reject(e)));
			proc.on('exit', (code) => {
				this.proc = null;
				if (!started) reject(new Error(`Le helper audio s'est arrêté (code ${code})`));
				else if (!this.stopping && code !== 0) this.onError('La capture du son système s’est arrêtée');
				this.resolveDone(code);
			});
		});
	}

	stop() {
		this.stopping = true;
		// Closing stdin is the helper's signal to tear down its tap cleanly.
		this.proc?.stdin?.end();
		const p = this.proc;
		window.setTimeout(() => p?.kill('SIGTERM'), 1500);
	}
}

export class SystemSource extends HelperSource {
	constructor(binary: string, onPcm: PcmHandler, onError: (message: string) => void) {
		super(binary, [], onPcm, onError);
	}
}
