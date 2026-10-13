/**
 * A meeting being recorded: owns the audio sources, the per-track chunkers, the background
 * transcription queue and the on-disk state (`<meeting>/.raw/meeting.json`), so a crash or a
 * failed API call never loses anything — processing can always be re-run from `.raw/`.
 */

import { Mp3Encoder } from '@breezystack/lamejs';
import { App, Notice, Platform, TFile, normalizePath } from 'obsidian';
import type { OpenRouter } from './openrouter';
import type { SttResult } from './pipeline/merge';
import { MicSource, ScreenLock, SystemSource, type AudioSource } from './recorder/sources';
import { SAMPLE_RATE, Track, type ChunkMeta, type ChunkSink, type TrackId } from './recorder/track';
import type { MeetingMode, MeetingSettings } from './settings';

export interface ChunkState extends ChunkMeta {
	status: 'pending' | 'done' | 'error';
	error?: string;
	cost?: number;
}

export interface MeetingState {
	version: 1;
	title: string;
	folder: string;
	startedAt: string;
	language: string;
	mode: MeetingMode;
	template: string;
	duration: number;
	status: 'recording' | 'processing' | 'done' | 'error';
	chunks: ChunkState[];
	/** First time (s) each notes line was typed, keyed by its final text. */
	noteTimes: Record<string, number>;
	error?: string;
	/** Speaker label → name, once known. */
	speakerNames?: Record<string, string>;
	/** `import`: built from an existing audio file instead of a live recording. */
	source?: 'live' | 'import';
	/** Vault-relative path of the imported audio, for reference. */
	sourceFile?: string;
	/** `voice`: a solo voice note, summarised as a bullet journal into the daily note. */
	kind?: MeetingKind;
	/** The title is a placeholder: the LLM names the meeting (and its folder) once the summary is written. */
	autoTitle?: boolean;
}

export type MeetingKind = 'meeting' | 'voice';

/** Only the user speaks: the mic is not diarized and is attributed to them. */
export function micIsMe(state: MeetingState): boolean {
	return state.mode === 'call' || state.kind === 'voice';
}

export const RAW = '.raw';

export function rawPath(folder: string, name: string) {
	return normalizePath(`${folder}/${RAW}/${name}`);
}

export async function loadState(app: App, folder: string): Promise<MeetingState | null> {
	const p = rawPath(folder, 'meeting.json');
	if (!(await app.vault.adapter.exists(p))) return null;
	return JSON.parse(await app.vault.adapter.read(p)) as MeetingState;
}

export async function saveState(app: App, state: MeetingState) {
	await app.vault.adapter.write(rawPath(state.folder, 'meeting.json'), JSON.stringify(state, null, '\t'));
}

/** Transcribes pending chunks one by one; safe to call repeatedly. */
export class TranscriptionQueue {
	private running: Promise<void> | null = null;
	onProgress?: () => void;

	constructor(
		private app: App,
		private api: OpenRouter,
		private settings: MeetingSettings,
		private state: MeetingState,
	) {}

	get counts() {
		const c = this.state.chunks;
		return { done: c.filter((x) => x.status === 'done').length, total: c.length };
	}

	kick(retryErrors = false): Promise<void> {
		if (retryErrors) for (const c of this.state.chunks) if (c.status === 'error') c.status = 'pending';
		if (!this.running) {
			this.running = this.loop().finally(() => (this.running = null));
		}
		return this.running;
	}

	private async loop() {
		for (;;) {
			const chunk = this.state.chunks.find((c) => c.status === 'pending');
			if (!chunk) return;
			const name = `${chunk.track}-${chunk.index}`;
			try {
				const mp3 = await this.app.vault.adapter.readBinary(rawPath(this.state.folder, `${name}.mp3`));
				const result = await this.api.transcribe(new Uint8Array(mp3), {
					model: this.settings.sttModel,
					language: this.state.language || undefined,
					// In a call or a voice note the mic is only you; diarizing would just split your own voice.
					diarize: !(chunk.track === 'mic' && micIsMe(this.state)),
				});
				await this.app.vault.adapter.write(rawPath(this.state.folder, `${name}.json`), JSON.stringify(result));
				chunk.status = 'done';
				chunk.cost = result.usage?.cost;
				chunk.error = undefined;
			} catch (e) {
				chunk.status = 'error';
				chunk.error = (e as Error).message;
				console.error('[meeting-notes] transcription failed', name, e);
			}
			await saveState(this.app, this.state);
			this.onProgress?.();
		}
	}
}

export async function readChunkResult(app: App, folder: string, c: ChunkMeta): Promise<SttResult> {
	return JSON.parse(await app.vault.adapter.read(rawPath(folder, `${c.track}-${c.index}.json`))) as SttResult;
}

/** Writes finished chunks to `.raw/` and queues them; shared by live sessions and imports. */
export class ChunkWriter {
	private writes: Promise<void>[] = [];
	onChunk?: () => void;

	constructor(
		private app: App,
		private state: MeetingState,
		private queue: TranscriptionQueue,
	) {}

	add(meta: ChunkMeta, mp3: Uint8Array): Promise<void> {
		const p = (async () => {
			await this.app.vault.adapter.writeBinary(
				rawPath(this.state.folder, `${meta.track}-${meta.index}.mp3`),
				mp3.buffer as ArrayBuffer,
			);
			this.state.chunks.push({ ...meta, status: 'pending' });
			await saveState(this.app, this.state);
			void this.queue.kick();
			this.onChunk?.();
		})();
		this.writes.push(p);
		return p;
	}

	/** Resolves once every chunk handed over so far is on disk. */
	flush(): Promise<void> {
		return Promise.all(this.writes).then(() => undefined);
	}
}

class Mp3ChunkSink implements ChunkSink {
	private enc: Mp3Encoder | null = null;
	private parts: Uint8Array[] = [];

	constructor(private writer: ChunkWriter) {}

	open() {
		this.enc = new Mp3Encoder(1, SAMPLE_RATE, 48);
		this.parts = [];
	}
	write(pcm: Int16Array) {
		const out = this.enc!.encodeBuffer(pcm);
		if (out.length) this.parts.push(out.slice());
	}
	close(meta: ChunkMeta, keep: boolean) {
		const tail = this.enc!.flush();
		if (tail.length) this.parts.push(tail.slice());
		this.enc = null;
		if (keep) void this.writer.add(meta, concat(this.parts));
		this.parts = [];
	}
}

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

/** Mixes both sources into one mono MP3 streamed to `.raw/audio.mp3`. */
class AudioArchive {
	private enc = new Mp3Encoder(1, SAMPLE_RATE, 64);
	private queues: Record<TrackId, Int16Array[]> = { mic: [], system: [] };
	private lens: Record<TrackId, number> = { mic: 0, system: 0 };
	private pendingWrite: Promise<void> = Promise.resolve();
	private buffered: Uint8Array[] = [];

	constructor(
		private app: App,
		private path: string,
		private tracks: TrackId[],
	) {}

	push(id: TrackId, pcm: Int16Array) {
		this.queues[id].push(pcm);
		this.lens[id] += pcm.length;
	}

	private take(id: TrackId, n: number): Int16Array {
		const out = new Int16Array(n);
		let o = 0;
		const q = this.queues[id];
		while (o < n && q.length) {
			const head = q[0];
			const k = Math.min(head.length, n - o);
			out.set(head.subarray(0, k), o);
			o += k;
			if (k === head.length) q.shift();
			else q[0] = head.subarray(k);
		}
		this.lens[id] -= o;
		return out;
	}

	/** Mix what both sources have in common; a source lagging > 3 s is padded with silence. */
	pump(final = false) {
		const lens = this.tracks.map((t) => this.lens[t]);
		const max = Math.max(...lens);
		let n = Math.min(...lens);
		if (final || max - n > 3 * SAMPLE_RATE) n = max;
		if (n > 0) {
			const mix = new Int32Array(n);
			for (const t of this.tracks) {
				const pcm = this.take(t, Math.min(n, this.lens[t]));
				for (let i = 0; i < pcm.length; i++) mix[i] += pcm[i];
			}
			const out = Int16Array.from(mix, (v) => Math.max(-32768, Math.min(32767, v)));
			for (let i = 0; i < out.length; i += 1152) {
				const b = this.enc.encodeBuffer(out.subarray(i, i + 1152));
				if (b.length) this.buffered.push(b.slice());
			}
		}
		if (final) {
			const t = this.enc.flush();
			if (t.length) this.buffered.push(t.slice());
		}
		const data = concat(this.buffered);
		this.buffered = [];
		if (data.length) {
			this.pendingWrite = this.pendingWrite.then(() =>
				this.app.vault.adapter.appendBinary(this.path, data.buffer as ArrayBuffer),
			);
		}
		return this.pendingWrite;
	}
}

export class RecordingSession {
	readonly tracks: Partial<Record<TrackId, Track>> = {};
	readonly queue: TranscriptionQueue;
	paused = false;
	systemError: string | null = null;

	private sources: AudioSource[] = [];
	private archive: AudioArchive | null = null;
	private pumpTimer = 0;
	private writer: ChunkWriter;
	private t0 = 0;
	private pausedAt = 0;
	private pausedTotal = 0;
	private mic: MicSource | null = null;
	private screen = new ScreenLock();
	private onVisible = () => void this.wake();
	/** Seconds of meeting clock with no audio (mobile: app in background or screen locked). */
	lostSeconds = 0;
	onChange?: () => void;

	constructor(
		private app: App,
		api: OpenRouter,
		private settings: MeetingSettings,
		readonly state: MeetingState,
		private helperPath: string,
	) {
		this.queue = new TranscriptionQueue(app, api, settings, state);
		this.queue.onProgress = () => this.onChange?.();
		this.writer = new ChunkWriter(app, state, this.queue);
		this.writer.onChunk = () => this.onChange?.();
	}

	get notesPath() {
		return normalizePath(`${this.state.folder}/Notes.md`);
	}

	/** Seconds of recorded time (pauses excluded). */
	get elapsed(): number {
		if (!this.t0) return 0;
		const now = this.paused ? this.pausedAt : performance.now();
		return (now - this.t0 - this.pausedTotal) / 1000;
	}

	level(id: TrackId): number | null {
		return this.tracks[id]?.level ?? null;
	}

	/** Seconds since anyone last spoke on any track (meeting clock). */
	get idleSeconds(): number {
		let last = 0;
		for (const t of Object.values(this.tracks)) if (t && t.lastSpeechAt > last) last = t.lastSpeechAt;
		return Math.max(0, this.elapsed - last);
	}

	/** Seconds of compacted audio sent (or about to be) for transcription, all tracks. */
	get sentSeconds(): number {
		let n = 0;
		for (const t of Object.values(this.tracks)) if (t) n += t.sentSeconds;
		return n;
	}

	get estimatedCost(): number {
		return (this.sentSeconds / 60) * this.settings.sttPricePerMinute;
	}

	async start() {
		const s = this.settings;
		const opts = chunkOptions(s);
		const ids: TrackId[] = this.state.mode === 'call' ? ['mic', 'system'] : ['mic'];
		await this.app.vault.adapter.mkdir(normalizePath(`${this.state.folder}/${RAW}`));
		await saveState(this.app, this.state);

		for (const id of ids) this.tracks[id] = new Track(id, new Mp3ChunkSink(this.writer), opts);
		if (s.keepAudio) this.archive = new AudioArchive(this.app, rawPath(this.state.folder, 'audio.mp3'), ids);

		this.t0 = performance.now();
		const feed = (id: TrackId) => {
			let first = true;
			return (pcm: Int16Array) => {
				if (this.paused) return;
				const track = this.tracks[id]!;
				// Align a late-starting source with the meeting clock, and close any gap left by
				// the OS suspending audio (mobile in background), so timestamps stay true.
				const late = Math.round(this.elapsed * SAMPLE_RATE) - Math.round(track.position * SAMPLE_RATE);
				if (late > (first ? SAMPLE_RATE / 4 : Platform.isMobile ? 2 * SAMPLE_RATE : Infinity)) {
					track.skip(late);
					this.archive?.push(id, new Int16Array(late));
					if (!first) {
						this.lostSeconds += late / SAMPLE_RATE;
						this.onChange?.();
					}
				}
				first = false;
				track.push(pcm);
				this.archive?.push(id, pcm);
			};
		};

		const mic = new MicSource(s.micDevice, feed('mic'));
		await mic.start();
		this.sources.push(mic);
		this.mic = mic;
		if (Platform.isMobile) {
			void this.screen.acquire();
			document.addEventListener('visibilitychange', this.onVisible);
		}

		if (ids.includes('system')) {
			const sys = new SystemSource(this.helperPath, feed('system'), (msg) => {
				this.systemError = msg;
				new Notice(`Meeting Notes : ${msg}. L’enregistrement continue avec le micro seul.`);
				this.onChange?.();
			});
			try {
				await sys.start();
				this.sources.push(sys);
			} catch (e) {
				this.systemError = (e as Error).message;
				delete this.tracks.system;
				this.archive = s.keepAudio ? new AudioArchive(this.app, rawPath(this.state.folder, 'audio.mp3'), ['mic']) : null;
				new Notice(
					`Son de l’ordinateur indisponible (${this.systemError}). Enregistrement du micro seul — les autres participants ne seront entendus que via tes haut-parleurs.`,
					10000,
				);
			}
		}
		this.pumpTimer = window.setInterval(() => void this.archive?.pump(), 5000);
	}

	private async wake() {
		if (document.visibilityState !== 'visible') return;
		await this.screen.refresh();
		try {
			await this.mic?.revive();
		} catch (e) {
			new Notice(`Micro indisponible : ${(e as Error).message}`);
		}
	}

	setPaused(paused: boolean) {
		if (paused === this.paused) return;
		if (paused) this.pausedAt = performance.now();
		else this.pausedTotal += performance.now() - this.pausedAt;
		this.paused = paused;
		this.onChange?.();
	}

	noteTyped(text: string, at: number) {
		const t = text.trim();
		if (t && !(t in this.state.noteTimes)) this.state.noteTimes[t] = at;
	}

	/** Stop capturing; returns once every chunk is written to disk (not yet transcribed). */
	async stop() {
		window.clearInterval(this.pumpTimer);
		document.removeEventListener('visibilitychange', this.onVisible);
		this.screen.release();
		this.mic = null;
		this.state.duration = this.elapsed;
		for (const src of this.sources) src.stop();
		this.sources = [];
		for (const t of Object.values(this.tracks)) t?.flush();
		await this.writer.flush();
		if (this.archive) {
			await this.archive.pump(true);
			const from = rawPath(this.state.folder, 'audio.mp3');
			const to = normalizePath(`${this.state.folder}/audio.mp3`);
			if (await this.app.vault.adapter.exists(from)) await this.app.vault.adapter.rename(from, to);
		}
		this.state.status = 'processing';
		await saveState(this.app, this.state);
	}

	async openNotes() {
		const file = this.app.vault.getAbstractFileByPath(this.notesPath);
		if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
	}
}

export function chunkOptions(s: MeetingSettings) {
	return { chunkSeconds: s.chunkMinutes * 60, maxChunkSeconds: s.chunkMinutes * 60 + 120 };
}

/**
 * Build a meeting from an existing audio file: the decoded PCM goes through the same VAD and
 * chunking as a live microphone (one diarized track), then the usual transcription queue.
 */
export async function importRecording(
	app: App,
	api: OpenRouter,
	settings: MeetingSettings,
	state: MeetingState,
	decode: (onPcm: (pcm: Int16Array) => void) => Promise<void>,
): Promise<TranscriptionQueue> {
	await app.vault.adapter.mkdir(normalizePath(`${state.folder}/${RAW}`));
	await saveState(app, state);
	const queue = new TranscriptionQueue(app, api, settings, state);
	const writer = new ChunkWriter(app, state, queue);
	const track = new Track('mic', new Mp3ChunkSink(writer), chunkOptions(settings));
	await decode((pcm) => track.push(pcm));
	track.flush();
	await writer.flush();
	state.duration = track.position;
	state.status = 'processing';
	await saveState(app, state);
	return queue;
}
