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
		this.stream = await navigator.mediaDevices.getUserMedia({
			audio: {
				deviceId: this.deviceId ? { exact: this.deviceId } : undefined,
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true,
				channelCount: 1,
			},
		});
		this.ctx = new AudioContext();
		const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
		try {
			await this.ctx.audioWorklet.addModule(url);
		} finally {
			URL.revokeObjectURL(url);
		}
		const node = new AudioWorkletNode(this.ctx, 'pcm-tap', { processorOptions: { target: SAMPLE_RATE } });
		node.port.onmessage = (e) => this.onPcm(e.data as Int16Array);
		this.ctx.createMediaStreamSource(this.stream).connect(node);
		// The node must reach the destination to be pulled; a muted gain keeps it silent.
		const mute = this.ctx.createGain();
		mute.gain.value = 0;
		node.connect(mute).connect(this.ctx.destination);
	}

	stop() {
		this.stream?.getTracks().forEach((t) => t.stop());
		void this.ctx?.close();
		this.ctx = null;
		this.stream = null;
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
export class SystemSource implements AudioSource {
	private proc: import('child_process').ChildProcess | null = null;
	private carry: Buffer | null = null;
	private stopping = false;

	constructor(
		private binary: string,
		private onPcm: PcmHandler,
		private onError: (message: string) => void,
	) {}

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
			const proc = spawn(this.binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
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
					let msg: { event?: string; message?: string };
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
				}
			});
			proc.on('error', (e) => (started ? this.onError(e.message) : reject(e)));
			proc.on('exit', (code) => {
				this.proc = null;
				if (!started) reject(new Error(`Le helper audio s'est arrêté (code ${code})`));
				else if (!this.stopping) this.onError('La capture du son système s’est arrêtée');
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
