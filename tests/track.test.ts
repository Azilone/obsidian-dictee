import { describe, expect, test } from 'bun:test';
import { SAMPLE_RATE, Track, remapTime, type ChunkMeta } from '../src/recorder/track';
import { mergeChunks, dropEchoes, toRawLines } from '../src/pipeline/merge';

const tone = (secs: number, amp = 8000) =>
	Int16Array.from({ length: Math.round(secs * SAMPLE_RATE) }, (_, i) => Math.round(amp * Math.sin(i / 5)));
const silence = (secs: number) => new Int16Array(Math.round(secs * SAMPLE_RATE));

function collect(opts = {}) {
	const chunks: { meta: ChunkMeta; keep: boolean; samples: number }[] = [];
	let samples = 0;
	const track = new Track(
		'system',
		{
			open: () => (samples = 0),
			write: (p) => (samples += p.length),
			close: (meta, keep) => chunks.push({ meta, keep, samples }),
		},
		opts,
	);
	return { track, chunks };
}

describe('Track', () => {
	test('strips long silences and maps time back', () => {
		const { track, chunks } = collect();
		track.push(tone(2));
		track.push(silence(30));
		track.push(tone(3));
		track.flush();
		expect(chunks.length).toBe(1);
		const c = chunks[0];
		expect(c.keep).toBe(true);
		// 5 s of speech + ~0.8 s pads instead of 35 s
		expect(c.meta.duration).toBeLessThan(6.5);
		expect(c.meta.duration).toBeGreaterThan(5);
		// The second burst starts at 32 s on the meeting clock.
		const secondOut = c.meta.map[1].out / SAMPLE_RATE;
		expect(remapTime(c.meta.map, secondOut + 0.3)).toBeCloseTo(32, 0);
		expect(remapTime(c.meta.map, 1)).toBeCloseTo(1, 1);
	});

	test('drops a chunk that is only silence or blips', () => {
		const { track, chunks } = collect();
		track.push(silence(10));
		track.push(tone(0.2));
		track.push(silence(10));
		track.flush();
		expect(chunks.every((c) => !c.keep)).toBe(true);
	});

	test('cuts chunks inside silences once the target length is reached', () => {
		const { track, chunks } = collect({ chunkSeconds: 4, maxChunkSeconds: 100 });
		for (let i = 0; i < 4; i++) {
			track.push(tone(3));
			track.push(silence(2));
		}
		track.flush();
		const kept = chunks.filter((c) => c.keep);
		expect(kept.length).toBe(2);
		expect(kept.map((c) => c.meta.index)).toEqual([0, 1]);
		expect(remapTime(kept[1].meta.map, 0.31)).toBeCloseTo(10, 0);
	});

	test('silent system audio (digital zero) is never sent', () => {
		const { track, chunks } = collect();
		track.push(silence(120));
		track.flush();
		expect(chunks.length).toBe(0);
	});
});

describe('merge', () => {
	const meta = (track: 'mic' | 'system', index: number, src: number): ChunkMeta => ({
		track,
		index,
		duration: 60,
		speech: 60,
		map: [{ out: 0, src: src * SAMPLE_RATE }],
	});

	test('interleaves tracks on the meeting clock and labels speakers per chunk', () => {
		const utts = mergeChunks(
			[
				{ meta: meta('system', 0, 0), result: { text: '', segments: [{ start: 1, end: 3, text: 'Salut', speaker: 1 }] } },
				{ meta: meta('mic', 0, 0), result: { text: '', segments: [{ start: 4, end: 5, text: 'Bonjour à tous' }] } },
				{ meta: meta('system', 1, 100), result: { text: '', segments: [{ start: 0, end: 2, text: 'Ok', speaker: 0 }] } },
			],
			true,
		);
		expect(utts.map((u) => [u.label, Math.round(u.start)])).toEqual([
			['system0:1', 1],
			['me', 4],
			['system1:0', 100],
		]);
	});

	test('drops mic echoes of the other side', () => {
		const out = dropEchoes([
			{ start: 10, end: 14, label: 'system0:0', text: 'On valide le lancement pour lundi prochain' },
			{ start: 10.3, end: 14.2, label: 'me', text: 'on valide le lancement pour lundi' },
			{ start: 15, end: 16, label: 'me', text: 'Parfait, je note ça' },
		]);
		expect(out.map((u) => u.label)).toEqual(['system0:0', 'me']);
	});

	test('raw lines merge consecutive turns', () => {
		const lines = toRawLines(
			[
				{ start: 0, end: 1, label: 'me', text: 'A' },
				{ start: 1, end: 2, label: 'me', text: 'B' },
				{ start: 65, end: 66, label: 'x', text: 'C' },
			],
			{ me: 'Kévin' },
		);
		expect(lines).toEqual(['[00:00] Kévin: A B', '[01:05] x: C']);
	});
});

describe('Track telemetry', () => {
	test('lastSpeechAt follows the meeting clock and sentSeconds counts kept audio only', () => {
		const { track } = collect();
		track.push(tone(2));
		track.push(silence(60));
		expect(track.lastSpeechAt).toBeGreaterThan(1.5);
		expect(track.lastSpeechAt).toBeLessThan(2.2);
		// 62 s elapsed, ~2 s spoken: an idle check sees ~60 s of silence.
		expect(track.position - track.lastSpeechAt).toBeGreaterThan(59);
		expect(track.sentSeconds).toBeLessThan(3.5);
		expect(track.sentSeconds).toBeGreaterThan(2);
	});

	test('a dropped (silent) chunk is not counted as sent', () => {
		const { track } = collect();
		track.push(silence(5));
		track.push(tone(0.2));
		track.push(silence(5));
		track.flush();
		expect(track.sentSeconds).toBeCloseTo(0, 3);
	});
});

describe('VAD', () => {
	test('keyboard clicks are not speech', () => {
		const { track, chunks } = collect();
		for (let i = 0; i < 40; i++) {
			track.push(tone(0.015, 20000)); // a 15 ms click
			track.push(silence(0.25));
		}
		track.flush();
		expect(chunks.filter((c) => c.keep).length).toBe(0);
	});
});
