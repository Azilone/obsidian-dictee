/** After the meeting: transcripts → speakers → clean transcript → summary → files. */

import { App, TFile, TFolder, normalizePath, stringifyYaml } from 'obsidian';
import { parseJson, type OpenRouter } from '../openrouter';
import { micIsMe, readChunkResult, saveState, type MeetingState, type TranscriptionQueue } from '../session';
import type { MeetingSettings } from '../settings';
import { LANGUAGES } from '../settings';
import { formatClock, mergeChunks, toRawLines, type Utterance } from './merge';
import { SPEAKERS_PROMPT, cleanPrompt, summaryPrompt, titlePrompt, voicePrompt } from './prompts';
import { nameMap, normalizePeople, type Person } from './speakers';

export interface ProcessHooks {
	progress(step: string): void;
	/** Let the user confirm or fix speaker names; resolves with the final people list. */
	askNames?(people: Person[], utts: Utterance[]): Promise<Person[]>;
}

export interface ProcessResult {
	summary: TFile;
	cost: number;
}

/** Split lines into blocks of roughly `size` characters. */
export function blocks(lines: string[], size: number): string[] {
	const out: string[] = [];
	let cur: string[] = [];
	let len = 0;
	for (const l of lines) {
		if (len + l.length > size && cur.length) {
			out.push(cur.join('\n'));
			cur = [];
			len = 0;
		}
		cur.push(l);
		len += l.length + 1;
	}
	if (cur.length) out.push(cur.join('\n'));
	return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i], i);
			}
		}),
	);
	return out;
}

/** Notes with the time each line was written, for the summary prompt. */
export function annotateNotes(notes: string, times: Record<string, number>): string {
	return notes
		.split('\n')
		.map((line) => {
			const t = times[line.trim()];
			return t != null && line.trim() ? `[${formatClock(t)}] ${line}` : line;
		})
		.join('\n');
}

function stripFrontmatter(md: string): string {
	return md.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

export async function processMeeting(
	app: App,
	api: OpenRouter,
	settings: MeetingSettings,
	state: MeetingState,
	queue: TranscriptionQueue,
	hooks: ProcessHooks,
): Promise<ProcessResult> {
	const { folder } = state;
	const llm = settings.llmModel;

	// 1. Finish transcription (retry failed chunks once more).
	hooks.progress('Transcription…');
	await queue.kick(true);
	const failed = state.chunks.filter((c) => c.status !== 'done');
	if (failed.length) {
		throw new Error(
			`${failed.length} segment(s) n’ont pas pu être transcrits (${failed[0].error ?? 'erreur inconnue'}). Relance « Retraiter la réunion » plus tard.`,
		);
	}
	const results = await Promise.all(
		state.chunks.map(async (meta) => ({ meta, result: await readChunkResult(app, folder, meta) })),
	);
	let cost = state.chunks.reduce((n, c) => n + (c.cost ?? 0), 0);
	const utts = mergeChunks(results, micIsMe(state));
	if (!utts.length) throw new Error('Aucune parole détectée dans l’enregistrement.');

	// 2. Who is who.
	let people: Person[] = [];
	if (utts.some((u) => u.label !== 'me')) {
		hooks.progress('Identification des intervenants…');
		let raw: unknown = null;
		try {
			raw = parseJson(
				await api.chat(llm, [
					{ role: 'system', content: SPEAKERS_PROMPT },
					{ role: 'user', content: toRawLines(utts).join('\n') },
				], { json: true }),
			);
		} catch (e) {
			console.warn('[meeting-notes] speaker grouping failed, keeping raw labels', e);
		}
		people = normalizePeople(raw, utts);
		if (hooks.askNames) people = await hooks.askNames(people, utts);
	}
	const names = nameMap(people, settings.myName);
	state.speakerNames = names;
	await saveState(app, state);

	// 3. Clean transcript, in parallel blocks.
	hooks.progress('Mise au propre du transcript…');
	const lang = LANGUAGES[state.language] ?? '';
	const rawLines = toRawLines(utts, names);
	const cleaned = await mapLimit(blocks(rawLines, 14000), 3, (block) =>
		api.chat(llm, [
			{ role: 'system', content: cleanPrompt(state.language ? lang.toLowerCase() : '') },
			{ role: 'user', content: block },
		]),
	);
	const transcript = cleaned.map((c) => c.trim()).join('\n\n');

	if (state.kind === 'voice') {
		hooks.progress('Résumé pour le journal…');
		const entry = await api.chat(llm, [
			{ role: 'system', content: voicePrompt(settings.summaryLanguage) },
			{ role: 'user', content: transcript },
		]);
		hooks.progress('Écriture dans la note du jour…');
		const daily = await writeVoiceNote(app, settings, state, transcript, entry.trim());
		state.status = 'done';
		state.error = undefined;
		await saveState(app, state);
		return { summary: daily, cost };
	}

	// 4. Summary.
	hooks.progress('Rédaction du résumé…');
	const notesFile = app.vault.getAbstractFileByPath(normalizePath(`${folder}/Notes.md`));
	const notes = notesFile instanceof TFile ? stripFrontmatter(await app.vault.read(notesFile)).trim() : '';
	const template = await loadTemplate(app, settings, state.template);
	const participants = [...new Set(Object.entries(names).filter(([l]) => utts.some((u) => u.label === l)).map(([, n]) => n))];
	const summary = await api.chat(llm, [
		{ role: 'system', content: summaryPrompt(template, settings.summaryLanguage) },
		{
			role: 'user',
			content: [
				`Réunion : ${state.title}`,
				`Date : ${window.moment(state.startedAt).format('LLLL')}`,
				`Durée : ${Math.round(state.duration / 60)} min`,
				`Participants : ${participants.join(', ')}`,
				'',
				'=== NOTES BRUTES ===',
				notes ? annotateNotes(notes, state.noteTimes) : '(aucune note)',
				'',
				'=== TRANSCRIPT ===',
				transcript,
			].join('\n'),
		},
	]);

	// 5. Files.
	if (state.autoTitle) {
		hooks.progress('Choix du titre…');
		try {
			const title = (
				await api.chat(llm, [
					{ role: 'system', content: titlePrompt(settings.summaryLanguage) },
					{ role: 'user', content: summary.slice(0, 4000) },
				], { maxTokens: 40 })
			)
				.split('\n')[0]
				.replace(/^["«\s#]+|["»\s.]+$/g, '');
			if (title) await applyTitle(app, state, title);
		} catch (e) {
			console.warn('[meeting-notes] title generation failed, keeping the placeholder', e);
		}
	}
	hooks.progress('Écriture des fichiers…');
	const files = await writeMeetingFiles(app, state, { transcript, summary: summary.trim(), participants });
	state.status = 'done';
	state.error = undefined;
	await saveState(app, state);
	return { summary: files.summary, cost };
}

/** Rename the meeting (folder, `Notes.md` heading, state) after the LLM-chosen title. */
async function applyTitle(app: App, state: MeetingState, title: string) {
	const safe = title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();
	const dir = state.folder.split('/').slice(0, -1).join('/');
	const stamp = state.folder.split('/').pop()?.match(/^\d{4}-\d{2}-\d{2} \d{4}/)?.[0] ?? '';
	const folder = app.vault.getAbstractFileByPath(state.folder);
	if (!safe || !folder) return;
	const name = [stamp, safe].filter(Boolean).join(' ');
	let next = normalizePath([dir, name].filter(Boolean).join('/'));
	for (let i = 2; app.vault.getAbstractFileByPath(next); i++) next = normalizePath([dir, `${name} (${i})`].filter(Boolean).join('/'));
	await app.fileManager.renameFile(folder, next);
	const notes = app.vault.getAbstractFileByPath(`${next}/Notes.md`);
	if (notes instanceof TFile) {
		await app.vault.process(notes, (data) => (data.startsWith(`# ${state.title}\n`) ? `# ${safe}${data.slice(state.title.length + 2)}` : data));
	}
	state.folder = next;
	state.title = safe;
	state.autoTitle = false;
	await saveState(app, state);
}

export async function loadTemplate(app: App, settings: MeetingSettings, name: string): Promise<string> {
	const { DEFAULT_TEMPLATES } = await import('./prompts');
	const file = app.vault.getAbstractFileByPath(normalizePath(`${settings.templatesFolder}/${name}.md`));
	if (file instanceof TFile) return stripFrontmatter(await app.vault.read(file));
	return DEFAULT_TEMPLATES[name] ?? DEFAULT_TEMPLATES['Général'];
}

async function upsert(app: App, path: string, content: string): Promise<TFile> {
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFile) {
		await app.vault.modify(existing, content);
		return existing;
	}
	return app.vault.create(path, content);
}

function frontmatter(data: Record<string, unknown>) {
	return `---\n${stringifyYaml(data)}---\n\n`;
}

export async function writeMeetingFiles(
	app: App,
	state: MeetingState,
	out: { transcript: string; summary: string; participants: string[] },
) {
	const p = (name: string) => normalizePath(`${state.folder}/${name}`);
	const link = (target: string, from: string, alias: string) => {
		const f = app.vault.getAbstractFileByPath(target);
		return f instanceof TFile ? app.fileManager.generateMarkdownLink(f, from, undefined, alias) : alias;
	};
	const meta = {
		date: window.moment(state.startedAt).format('YYYY-MM-DDTHH:mm'),
		durée: `${Math.max(1, Math.round(state.duration / 60))} min`,
		participants: out.participants,
		langue: state.language || 'auto',
		tags: ['réunion'],
	};

	const transcript = await upsert(
		app,
		p('Transcript.md'),
		frontmatter({ ...meta, type: 'transcript' }) + `# ${state.title} — transcript\n\n${out.transcript}\n`,
	);
	const folderFile = app.vault.getAbstractFileByPath(state.folder);
	const audioFile =
		folderFile instanceof TFolder
			? folderFile.children.find((f): f is TFile => f instanceof TFile && f.basename === 'audio' && f.extension !== 'md')
			: undefined;
	const audioPath = audioFile?.path ?? p('audio.mp3');
	const hasAudio = !!audioFile;
	const summaryPath = p('Résumé.md');
	const nav = [
		link(transcript.path, summaryPath, 'Transcript'),
		link(p('Notes.md'), summaryPath, 'Notes brutes'),
		hasAudio ? link(audioPath, summaryPath, 'Audio') : null,
	]
		.filter(Boolean)
		.join(' · ');
	const audioEmbed = audioFile ? `\n\n!${app.fileManager.generateMarkdownLink(audioFile, summaryPath)}` : '';
	const summary = await upsert(
		app,
		summaryPath,
		frontmatter({ ...meta, type: 'réunion' }) + `# ${state.title}\n\n${nav}${audioEmbed}\n\n${out.summary}\n`,
	);
	return { transcript, summary };
}

/** Path of the daily note for `date`: the plugin setting, else the core Daily notes options. */
export function dailyNotePath(app: App, settings: MeetingSettings, date: string): string {
	const m = window.moment(date);
	if (settings.dailyNoteFormat.trim()) return normalizePath(`${m.format(settings.dailyNoteFormat.trim())}.md`);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const core = (app as any).internalPlugins?.getPluginById?.('daily-notes')?.instance?.options ?? {};
	const folder = String(core.folder ?? '').replace(/^\/+|\/+$/g, '');
	const name = m.format(core.format || 'YYYY-MM-DD');
	return normalizePath(folder ? `${folder}/${name}.md` : `${name}.md`);
}

/** Transcript next to the audio, and a bullet-journal block appended to the day's note. */
export async function writeVoiceNote(
	app: App,
	settings: MeetingSettings,
	state: MeetingState,
	transcript: string,
	entry: string,
): Promise<TFile> {
	const meta = {
		date: window.moment(state.startedAt).format('YYYY-MM-DDTHH:mm'),
		durée: `${Math.max(1, Math.round(state.duration / 60))} min`,
		type: 'note vocale',
	};
	const transcriptFile = await upsert(
		app,
		normalizePath(`${state.folder}/Transcript.md`),
		frontmatter(meta) + `# ${state.title} — transcript\n\n${transcript}\n`,
	);

	const dailyPath = dailyNotePath(app, settings, state.startedAt);
	const dir = dailyPath.split('/').slice(0, -1).join('/');
	if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir);
	let daily = app.vault.getAbstractFileByPath(dailyPath);
	if (!(daily instanceof TFile)) daily = await app.vault.create(dailyPath, '');
	const file = daily as TFile;

	const folder = app.vault.getAbstractFileByPath(state.folder);
	const audio =
		folder instanceof TFolder
			? folder.children.find((f): f is TFile => f instanceof TFile && f.basename === 'audio' && f.extension !== 'md')
			: undefined;
	const links = [
		app.fileManager.generateMarkdownLink(transcriptFile, file.path, undefined, 'Transcript'),
		audio ? app.fileManager.generateMarkdownLink(audio, file.path, undefined, 'Audio') : null,
	]
		.filter(Boolean)
		.join(' · ');
	const block = `### 🎙️ ${window.moment(state.startedAt).format('HH:mm')} · ${state.title}\n${links}\n\n${entry}\n`;
	// Re-processing replaces the block for this note instead of adding a second one.
	const marker = `<!-- mn:${state.folder} -->`;
	await app.vault.process(file, (data) => {
		const tagged = `${marker}\n${block}${marker.replace('mn:', '/mn:')}`;
		const re = new RegExp(`${escapeRe(marker)}[\\s\\S]*?${escapeRe(marker.replace('mn:', '/mn:'))}`);
		if (re.test(data)) return data.replace(re, tagged);
		return `${data.replace(/\s+$/, '')}${data.trim() ? '\n\n' : ''}${tagged}\n`;
	});
	return file;
}

function escapeRe(s: string) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
