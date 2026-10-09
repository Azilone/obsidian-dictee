import type { Utterance } from './merge';

export interface Person {
	name: string;
	labels: string[];
	evidence?: string;
}

/**
 * Validate the model's grouping: every label belongs to exactly one person, unknown labels are
 * dropped, missing ones become their own person. `me` is handled separately.
 */
export function normalizePeople(raw: unknown, utts: Utterance[]): Person[] {
	const labels = [...new Set(utts.map((u) => u.label).filter((l) => l !== 'me'))];
	const known = new Set(labels);
	const seen = new Set<string>();
	const people: Person[] = [];
	const list = (raw as { people?: unknown })?.people;
	if (Array.isArray(list)) {
		for (const p of list) {
			const ls = Array.isArray(p?.labels) ? (p.labels as unknown[]).map(String) : [];
			const mine = ls.filter((l) => known.has(l) && !seen.has(l));
			if (!mine.length) continue;
			mine.forEach((l) => seen.add(l));
			people.push({
				name: typeof p.name === 'string' ? p.name.trim() : '',
				labels: mine,
				evidence: typeof p.evidence === 'string' ? p.evidence : undefined,
			});
		}
	}
	for (const l of labels) if (!seen.has(l)) people.push({ name: '', labels: [l] });
	// Order by first appearance.
	const first = (p: Person) => Math.min(...utts.filter((u) => p.labels.includes(u.label)).map((u) => u.start));
	people.sort((a, b) => first(a) - first(b));
	return people;
}

/** Label → display name; unnamed people become "Intervenant N". */
export function nameMap(people: Person[], myName: string): Record<string, string> {
	const map: Record<string, string> = { me: myName };
	let n = 0;
	for (const p of people) {
		const name = p.name || `Intervenant ${++n}`;
		for (const l of p.labels) map[l] = name;
	}
	return map;
}

/** Longest few utterances of a person, to help the user recognize who it is. */
export function samples(person: Person, utts: Utterance[], count = 2): string[] {
	return utts
		.filter((u) => person.labels.includes(u.label))
		.sort((a, b) => b.text.length - a.text.length)
		.slice(0, count)
		.map((u) => (u.text.length > 160 ? u.text.slice(0, 157) + '…' : u.text));
}
