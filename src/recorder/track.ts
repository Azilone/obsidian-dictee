/**
 * One audio source (mic or system) cut into transcription chunks.
 *
 * Silence is stripped before anything is sent (MAI-Transcribe bills per second): a simple energy
 * VAD keeps speech plus short pre-roll/hang-over pads, and drops longer silent runs. Each chunk
 * carries a time map so timestamps in the compacted audio map back to the real meeting clock.
 * Chunks are cut inside silences, so no word is ever split across two chunks.
 */

export const SAMPLE_RATE = 16000;
const FRAME = 320; // 20 ms
const ATTACK_FRAMES = 4; // 80 ms

export interface TimeMapEntry {
	/** Sample offset inside the compacted chunk. */
	out: number;
	/** Absolute sample offset on the meeting clock. */
	src: number;
}

export interface ChunkMeta {
	track: TrackId;
	index: number;
	/** Seconds of audio actually sent. */
	duration: number;
	/** Seconds of speech detected. */
	speech: number;
	map: TimeMapEntry[];
}

export type TrackId = 'mic' | 'system';

export interface ChunkSink {
	/** A new chunk starts; frames follow through `write`. */
	open(index: number): void;
	write(pcm: Int16Array): void;
	/** The chunk is complete (`keep` false: it held no real speech and should be discarded). */
	close(meta: ChunkMeta, keep: boolean): void;
}

export interface TrackOptions {
	/** Target seconds of compacted audio per chunk; cut at the next silence after this. */
	chunkSeconds: number;
	/** Hard limit even without silence (diarization breaks above ~15 min). */
	maxChunkSeconds: number;
	/** Minimum threshold in dBFS; raised automatically above the noise floor. */
	thresholdDb: number;
	preRollMs: number;
	hangMs: number;
	/** Chunks with less speech than this are dropped. */
	minSpeechSeconds: number;
}

export const DEFAULT_TRACK_OPTIONS: TrackOptions = {
	chunkSeconds: 8 * 60,
	maxChunkSeconds: 10 * 60,
	thresholdDb: -50,
	preRollMs: 300,
	hangMs: 500,
	minSpeechSeconds: 1,
};

export function frameDb(frame: Int16Array): number {
	let sum = 0;
	for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
	const rms = Math.sqrt(sum / Math.max(1, frame.length)) / 32768;
	return rms > 0 ? 20 * Math.log10(rms) : -120;
}

/** Map a time (s) in a compacted chunk back to the meeting clock (s). */
export function remapTime(map: TimeMapEntry[], t: number): number {
	const s = t * SAMPLE_RATE;
	let e = map[0];
	for (const m of map) {
		if (m.out <= s) e = m;
		else break;
	}
	return e ? (e.src + (s - e.out)) / SAMPLE_RATE : t;
}

export class Track {
	readonly opts: TrackOptions;
	/** Level of the last frame in dBFS, for meters. */
	level = -120;
	/** Meeting-clock position (s) of the last frame detected as speech; -1 before any speech. */
	lastSpeechAt = -1;
	/** Seconds of compacted audio handed to the sink so far (sent or about to be). */
	sentSeconds = 0;

	private pending = new Int16Array(FRAME);
	private pendingLen = 0;
	private abs = 0; // absolute sample position of the next incoming frame
	private noiseFloor = -70;
	private hang = 0;
	private loudRun = 0;
	private ring: { frame: Int16Array; abs: number }[] = [];

	private index = 0;
	private open = false;
	private chunkLen = 0;
	private speechFrames = 0;
	private map: TimeMapEntry[] = [];
	private lastEmittedEnd = -1;

	constructor(
		readonly id: TrackId,
		private sink: ChunkSink,
		opts: Partial<TrackOptions> = {},
		startIndex = 0,
	) {
		this.opts = { ...DEFAULT_TRACK_OPTIONS, ...opts };
		this.index = startIndex;
	}

	/** Seconds of meeting clock consumed so far. */
	get position(): number {
		return (this.abs + this.pendingLen) / SAMPLE_RATE;
	}

	push(pcm: Int16Array) {
		let i = 0;
		while (i < pcm.length) {
			const n = Math.min(FRAME - this.pendingLen, pcm.length - i);
			this.pending.set(pcm.subarray(i, i + n), this.pendingLen);
			this.pendingLen += n;
			i += n;
			if (this.pendingLen === FRAME) {
				this.frame(this.pending.slice());
				this.pendingLen = 0;
			}
		}
	}

	/** Advance the clock without audio (e.g. a source that started late). */
	skip(samples: number) {
		this.abs += samples;
	}

	/** Flush everything; the track can keep receiving audio afterwards. */
	flush() {
		if (this.pendingLen) {
			this.frame(this.pending.slice(0, this.pendingLen));
			this.pendingLen = 0;
		}
		this.closeChunk();
	}

	private frame(frame: Int16Array) {
		const at = this.abs;
		this.abs += frame.length;
		const db = frameDb(frame);
		this.level = db;
		// Noise floor follows quiet frames quickly and loud frames slowly.
		this.noiseFloor += (db < this.noiseFloor ? 0.2 : 0.002) * (db - this.noiseFloor);
		const threshold = Math.max(this.opts.thresholdDb, this.noiseFloor + 12);
		const loud = db > threshold;
		// Speech needs a few loud frames in a row; isolated clicks (typing on the keyboard) don't count.
		this.loudRun = loud ? this.loudRun + 1 : 0;
		const speech = loud && (this.hang > 0 || this.loudRun >= ATTACK_FRAMES);

		if (speech) {
			this.lastSpeechAt = at / SAMPLE_RATE;
			this.hang = Math.round(this.opts.hangMs / 20);
			for (const r of this.ring) this.emit(r.frame, r.abs, false);
			this.ring = [];
			this.emit(frame, at, true);
		} else if (this.hang > 0) {
			this.hang--;
			this.emit(frame, at, false);
		} else {
			this.ring.push({ frame, abs: at });
			if (this.ring.length > Math.round(this.opts.preRollMs / 20)) this.ring.shift();
			if (this.chunkLen >= this.opts.chunkSeconds * SAMPLE_RATE) this.closeChunk();
		}
		if (this.chunkLen >= this.opts.maxChunkSeconds * SAMPLE_RATE) this.closeChunk();
	}

	private emit(frame: Int16Array, at: number, speech: boolean) {
		if (!this.open) {
			this.open = true;
			this.chunkLen = 0;
			this.speechFrames = 0;
			this.map = [];
			this.lastEmittedEnd = -1;
			this.sink.open(this.index);
		}
		if (at !== this.lastEmittedEnd) this.map.push({ out: this.chunkLen, src: at });
		this.lastEmittedEnd = at + frame.length;
		this.chunkLen += frame.length;
		this.sentSeconds += frame.length / SAMPLE_RATE;
		if (speech) this.speechFrames++;
		this.sink.write(frame);
	}

	private closeChunk() {
		if (!this.open) return;
		this.open = false;
		const speech = (this.speechFrames * FRAME) / SAMPLE_RATE;
		const meta: ChunkMeta = {
			track: this.id,
			index: this.index,
			duration: this.chunkLen / SAMPLE_RATE,
			speech,
			map: this.map,
		};
		const keep = speech >= this.opts.minSpeechSeconds;
		if (keep) this.index++;
		else this.sentSeconds -= this.chunkLen / SAMPLE_RATE;
		this.sink.close(meta, keep);
	}
}
