/** Turns per-chunk transcription results into one timeline of utterances. */

import { remapTime, type ChunkMeta } from '../recorder/track';

export interface SttSegment {
	start: number;
	end: number;
	text: string;
	speaker?: number;
}

export interface SttResult {
	text: string;
	language?: string;
	duration?: number;
	segments?: SttSegment[];
	usage?: { seconds?: number; cost?: number };
}

export interface Utterance {
	start: number;
	end: number;
	/** Raw speaker label: `me`, or `<track><chunk>:<speaker>` (e.g. `system2:1`). */
	label: string;
	text: string;
}

export interface ChunkTranscript {
	meta: ChunkMeta;
	result: SttResult;
}

/**
 * @param micIsMe In a call, the mic only carries the user; in a room it is diarized like the rest.
 */
export function mergeChunks(chunks: ChunkTranscript[], micIsMe: boolean): Utterance[] {
	const out: Utterance[] = [];
	for (const { meta, result } of chunks) {
		const segs = result.segments?.length
			? result.segments
			: result.text.trim()
				? [{ start: 0, end: meta.duration, text: result.text }]
				: [];
		for (const s of segs) {
			const text = s.text.trim();
			if (!text) continue;
			out.push({
				start: remapTime(meta.map, s.start),
				end: remapTime(meta.map, s.end),
				label: meta.track === 'mic' && micIsMe ? 'me' : `${meta.track}${meta.index}:${s.speaker ?? 0}`,
				text,
			});
		}
	}
	out.sort((a, b) => a.start - b.start);
	return micIsMe ? dropEchoes(out) : out;
}

function words(s: string): string[] {
	return s
		.toLowerCase()
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length > 2);
}

/**
 * Without headphones the mic also hears the other participants. A mic utterance that overlaps a
 * system utterance in time and mostly repeats its words is an echo, not the user speaking.
 */
export function dropEchoes(utts: Utterance[]): Utterance[] {
	const system = utts.filter((u) => u.label !== 'me');
	return utts.filter((u) => {
		if (u.label !== 'me') return true;
		const mine = words(u.text);
		if (!mine.length) return true;
		const theirs = new Set(
			system.filter((s) => s.start < u.end + 1.5 && s.end > u.start - 1.5).flatMap((s) => words(s.text)),
		);
		if (!theirs.size) return true;
		const shared = mine.filter((w) => theirs.has(w)).length;
		return shared / mine.length < 0.6;
	});
}

export function formatClock(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	const mm = String(m).padStart(2, '0');
	const ss = String(sec).padStart(2, '0');
	return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Compact text form fed to the LLM: `[mm:ss] label: text`, merging consecutive same-speaker lines. */
export function toRawLines(utts: Utterance[], names?: Record<string, string>): string[] {
	const lines: string[] = [];
	let last: { label: string; idx: number } | null = null;
	for (const u of utts) {
		const who = names?.[u.label] ?? u.label;
		if (last && last.label === who && lines[last.idx].length < 1200) {
			lines[last.idx] += ' ' + u.text;
		} else {
			lines.push(`[${formatClock(u.start)}] ${who}: ${u.text}`);
			last = { label: who, idx: lines.length - 1 };
		}
	}
	return lines;
}
