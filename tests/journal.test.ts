import { describe, expect, test } from 'bun:test';
import { parseEntry, renderEntry } from '../src/pipeline/journal';

describe('journal entry', () => {
	test('renders title, gist and one clean list', () => {
		const e = parseEntry(
			'{"title":"Prépa entretien","tldr":"Gros focus sur l’entretien.","tasks":[{"text":"- Relire le CV","done":false},{"text":"Payer Muay Thai","done":true}],"events":["14:00 — appel Paul"],"notes":["– Fatigué mais motivé"]}',
		);
		expect(renderEntry('19:36', 'Journal', e, '[[T|Transcript]]')).toBe(
			[
				'### 🎙️ 19:36 · Prépa entretien',
				'*Gros focus sur l’entretien.*',
				'',
				'- [ ] Relire le CV',
				'- [x] Payer Muay Thai',
				'- 14:00 — appel Paul',
				'- Fatigué mais motivé',
				'',
				'[[T|Transcript]]',
			].join('\n'),
		);
	});
	test('falls back to notes when the model does not answer JSON', () => {
		const e = parseEntry('- une idée\n• une autre');
		expect(e.notes).toEqual(['une idée', 'une autre']);
		expect(renderEntry('08:00', 'Journal', e, '')).toBe('### 🎙️ 08:00 · Journal\n\n- une idée\n- une autre');
	});
});

test('keeps highlights from the model', () => {
	const e = parseEntry('{"title":"T","tldr":"==entretien jeudi==","tasks":[],"events":[],"notes":["- ==visa== demain"]}');
	expect(renderEntry('09:00', 'Journal', e, '')).toBe('### 🎙️ 09:00 · T\n*==entretien jeudi==*\n\n- ==visa== demain');
});
