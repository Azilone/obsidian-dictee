/** Voice note → bullet-journal block for the daily note (pure, no Obsidian API). */

export interface JournalEntry {
	title: string;
	tldr: string;
	tasks: { text: string; done: boolean }[];
	events: string[];
	notes: string[];
}

/** Strip list markers / Markdown the model may still add, so the block renders as a clean list. */
function clean(text: unknown): string {
	return String(text ?? '')
		.replace(/^\s*(?:[-*•–—]|\[[ x]\])\s*/i, '')
		.replace(/\s+/g, ' ')
		.trim();
}

export function parseEntry(raw: string): JournalEntry {
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const j = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
		const list = (v: unknown) => (Array.isArray(v) ? v.map(clean).filter(Boolean) : []);
		return {
			title: clean(j.title),
			tldr: clean(j.tldr),
			tasks: Array.isArray(j.tasks)
				? j.tasks
						.map((t: unknown) => (typeof t === 'string' ? { text: clean(t), done: false } : { text: clean((t as { text?: string }).text), done: !!(t as { done?: boolean }).done }))
						.filter((t: { text: string }) => t.text)
				: [],
			events: list(j.events),
			notes: list(j.notes),
		};
	} catch {
		// Not JSON: keep the text as notes rather than losing it.
		return { title: '', tldr: '', tasks: [], events: [], notes: raw.split('\n').map(clean).filter(Boolean) };
	}
}

/** The block added to the daily note: a natural title, a one-line gist, one bullet-journal list. */
export function renderEntry(time: string, fallbackTitle: string, e: JournalEntry, links: string): string {
	const lines = [`### 🎙️ ${time} · ${e.title || fallbackTitle}`];
	if (e.tldr) lines.push(`*${e.tldr.replace(/\*/g, '')}*`);
	const items = [
		...e.tasks.map((t) => `- [${t.done ? 'x' : ' '}] ${t.text}`),
		...e.events.map((t) => `- ${t}`),
		...e.notes.map((t) => `- ${t}`),
	];
	if (items.length) lines.push('', ...items);
	if (links) lines.push('', links);
	return lines.join('\n');
}
