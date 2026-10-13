import { describe, expect, test } from 'bun:test';
import { dateFromName, memoKind, type VoiceMemo } from '../src/recorder/voice-memos';

const memo = (title: string, duration: number): VoiceMemo => ({ name: 'x.m4a', path: '/x.m4a', title, duration, recordedAt: new Date() });

describe('voice memos', () => {
	test('date from Voice Memos file name', () => {
		const d = dateFromName('20261013 192233-1A2B3C4D.m4a')!;
		expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([2026, 9, 13, 19, 22, 33]);
		expect(dateFromName('Nouvel enregistrement.m4a')).toBeNull();
	});
	test('kind from the title, else decided from the transcript', () => {
		expect(memoKind(memo('Réunion Paul', 60))).toBe('meeting');
		expect(memoKind(memo('Rue de Rivoli', 20 * 60))).toBe('auto');
	});
});
