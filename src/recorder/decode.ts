/**
 * Decode an audio file (m4a, mp3, wav, …) into 16 kHz mono s16 PCM, streamed to `onPcm`.
 * Primary path (desktop): the native helper (`meeting-tap --decode <file>`), which streams and never
 * holds the whole file in memory. Fallback and mobile: Web Audio's decoder, which does (fine up to ~1–2 h).
 */

import { HelperSource, type PcmHandler } from './sources';
import { SAMPLE_RATE } from './track';

export const AUDIO_EXTENSIONS = ['m4a', 'mp3', 'wav', 'aac', 'ogg', 'oga', 'opus', 'webm', 'mp4', 'flac', 'aiff', 'aif', 'caf', 'qta', 'mov'];

export function isAudioPath(path: string): boolean {
	const ext = path.split('.').pop()?.toLowerCase() ?? '';
	return AUDIO_EXTENSIONS.includes(ext);
}

export interface DecodeHooks {
	onPcm: PcmHandler;
	/** 0..1 while decoding. */
	progress?: (ratio: number) => void;
}

/** Decode `absPath` with the helper; throws if the helper is missing or fails. */
export async function decodeWithHelper(helper: string, absPath: string, hooks: DecodeHooks): Promise<void> {
	let failure: string | null = null;
	const src = new HelperSource(helper, ['--decode', absPath], hooks.onPcm, (m) => (failure = m));
	src.onEvent = (e) => {
		if (e.event === 'progress' && typeof e.ratio === 'number') hooks.progress?.(e.ratio);
	};
	await src.start();
	const code = await src.done;
	if (failure) throw new Error(failure);
	if (code !== 0) throw new Error(`Le décodage a échoué (code ${code})`);
}

/** Decode with the browser's audio stack (resampled to 16 kHz mono by the OfflineAudioContext). */
export async function decodeWithWebAudio(bytes: ArrayBuffer, hooks: DecodeHooks): Promise<void> {
	const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
	const buf = await ctx.decodeAudioData(bytes);
	const data = buf.getChannelData(0);
	const step = SAMPLE_RATE * 10; // 10 s blocks keep the UI responsive
	for (let i = 0; i < data.length; i += step) {
		const slice = data.subarray(i, i + step);
		const pcm = new Int16Array(slice.length);
		for (let j = 0; j < slice.length; j++) {
			const v = Math.max(-1, Math.min(1, slice[j]));
			pcm[j] = v < 0 ? v * 32768 : v * 32767;
		}
		hooks.onPcm(pcm);
		hooks.progress?.(Math.min(1, (i + step) / data.length));
		await new Promise((r) => window.setTimeout(r, 0));
	}
}

export async function decodeFile(
	helper: string,
	absPath: string,
	readBytes: () => Promise<ArrayBuffer>,
	hooks: DecodeHooks,
): Promise<void> {
	if (!helper || !absPath) return decodeWithWebAudio(await readBytes(), hooks);
	let received = 0;
	const counted: DecodeHooks = { ...hooks, onPcm: (pcm) => (received += pcm.length, hooks.onPcm(pcm)) };
	try {
		await decodeWithHelper(helper, absPath, counted);
	} catch (e) {
		// Once audio has been pushed downstream, replaying from the start would duplicate it.
		if (received) throw e;
		console.warn('[dictee] helper decode failed, falling back to Web Audio', e);
		await decodeWithWebAudio(await readBytes(), hooks);
	}
}
