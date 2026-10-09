import {
	MarkdownView,
	Menu,
	Notice,
	Platform,
	Plugin,
	TFile,
	TFolder,
	normalizePath,
	setIcon,
	type Editor,
	type MarkdownFileInfo,
} from 'obsidian';
import { OpenRouter } from './openrouter';
import { formatClock, type Utterance } from './pipeline/merge';
import { processMeeting } from './pipeline/process';
import { DEFAULT_TEMPLATES } from './pipeline/prompts';
import type { Person } from './pipeline/speakers';
import { RecordingSession, TranscriptionQueue, loadState, type MeetingState } from './session';
import { DEFAULT_SETTINGS, MeetingSettingTab, type MeetingSettings } from './settings';
import { SpeakerNamesModal, StartMeetingModal, type StartOptions } from './ui/modals';

const SECRET_ID = 'meeting-notes-openrouter';

export default class MeetingNotesPlugin extends Plugin {
	settings!: MeetingSettings;
	api!: OpenRouter;
	session: RecordingSession | null = null;
	/** Folders currently being processed (transcript/summary). */
	private processing = new Map<string, string>();

	private statusEl!: HTMLElement;
	private ribbonEl!: HTMLElement;
	private tick = 0;
	private headerActions = new WeakMap<MarkdownView, HTMLElement>();
	private lastLine = { file: '', line: -1, at: 0 };

	async onload() {
		await this.loadSettings();
		this.api = new OpenRouter(() => this.apiKey());

		this.addSettingTab(new MeetingSettingTab(this.app, this));
		this.ribbonEl = this.addRibbonIcon('mic', 'Démarrer une réunion', () =>
			this.session ? this.showRecorderMenu(this.ribbonEl) : this.startMeeting(),
		);
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass('mn-status', 'mod-clickable');
		this.statusEl.addEventListener('click', () => {
			if (this.session) this.showRecorderMenu(this.statusEl);
		});

		this.addCommand({
			id: 'start',
			name: 'Démarrer une réunion',
			icon: 'mic',
			checkCallback: (checking) => {
				if (this.session) return false;
				if (!checking) this.startMeeting();
				return true;
			},
		});
		this.addCommand({
			id: 'stop',
			name: 'Terminer la réunion',
			icon: 'square',
			checkCallback: (checking) => {
				if (!this.session) return false;
				if (!checking) void this.stopMeeting();
				return true;
			},
		});
		this.addCommand({
			id: 'pause',
			name: 'Mettre en pause / reprendre l’enregistrement',
			icon: 'pause',
			checkCallback: (checking) => {
				if (!this.session) return false;
				if (!checking) this.session.setPaused(!this.session.paused);
				return true;
			},
		});
		this.addCommand({
			id: 'mark',
			name: 'Marquer ce moment',
			icon: 'bookmark',
			editorCheckCallback: (checking, editor) => {
				if (!this.session) return false;
				if (!checking) this.insertMarker(editor);
				return true;
			},
		});
		this.addCommand({
			id: 'reprocess',
			name: 'Retraiter la réunion (transcript + résumé)',
			icon: 'refresh-cw',
			checkCallback: (checking) => {
				const folder = this.activeMeetingFolder();
				if (!folder || this.processing.has(folder) || this.session?.state.folder === folder) return false;
				if (!checking) void this.reprocess(folder);
				return true;
			},
		});

		this.registerEvent(
			this.app.workspace.on('editor-change', (editor: Editor, info: MarkdownFileInfo) => this.onEditorChange(editor, info)),
		);
		this.registerEvent(this.app.workspace.on('layout-change', () => this.syncHeaderActions()));
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				const folder = file instanceof TFolder ? file.path : file.parent?.path;
				if (!folder || this.processing.has(folder) || this.session?.state.folder === folder) return;
				if (!this.app.vault.getAbstractFileByPath(normalizePath(`${folder}/Notes.md`))) return;
				menu.addItem((i) =>
					i
						.setTitle('Retraiter la réunion')
						.setIcon('refresh-cw')
						.onClick(() => void this.reprocess(folder)),
				);
			}),
		);
		this.register(() => window.clearInterval(this.tick));
		this.app.workspace.onLayoutReady(() => void this.recoverInterrupted());
		this.render();
	}

	onunload() {
		// Never drop a recording silently: write out what we have.
		if (this.session) void this.session.stop();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	get helperPath(): string {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const base = (this.app.vault.adapter as any).getBasePath?.() as string;
		return `${base}/${this.manifest.dir}/meeting-tap`;
	}

	// ─── Templates ───

	private async templateNames(): Promise<string[]> {
		const folder = normalizePath(this.settings.templatesFolder);
		let dir = this.app.vault.getAbstractFileByPath(folder);
		if (!dir) {
			await this.ensureFolder(folder);
			for (const [name, body] of Object.entries(DEFAULT_TEMPLATES)) {
				await this.app.vault.create(normalizePath(`${folder}/${name}.md`), body);
			}
			dir = this.app.vault.getAbstractFileByPath(folder);
		}
		const names =
			dir instanceof TFolder
				? dir.children.filter((f): f is TFile => f instanceof TFile && f.extension === 'md').map((f) => f.basename)
				: [];
		return names.length ? names.sort() : Object.keys(DEFAULT_TEMPLATES);
	}

	apiKey(): string | null {
		try {
			return this.app.secretStorage.getSecret(SECRET_ID) || null;
		} catch {
			return null;
		}
	}

	setApiKey(value: string) {
		this.app.secretStorage.setSecret(SECRET_ID, value);
	}

	openSettings() {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const setting = (this.app as any).setting;
		setting?.open();
		setting?.openTabById(this.manifest.id);
	}

	private async ensureFolder(path: string) {
		const parts = normalizePath(path).split('/');
		for (let i = 1; i <= parts.length; i++) {
			const p = parts.slice(0, i).join('/');
			if (!this.app.vault.getAbstractFileByPath(p)) await this.app.vault.createFolder(p);
		}
	}

	// ─── Recording ───

	async startMeeting() {
		if (this.session) return;
		if (!Platform.isDesktopApp) return new Notice('Meeting Notes fonctionne sur Obsidian desktop.');
		if (!this.apiKey()) {
			const n = new Notice('', 10000);
			n.messageEl.empty();
			n.messageEl.createDiv({ text: 'Ajoute ta clé OpenRouter avant de démarrer une réunion.' });
			n.messageEl
				.createEl('button', { text: 'Ouvrir les réglages', cls: 'mod-cta mn-notice-btn' })
				.addEventListener('click', () => {
					n.hide();
					this.openSettings();
				});
			return;
		}
		const templates = await this.templateNames();
		new StartMeetingModal(
			this.app,
			{
				title: '',
				language: this.settings.language,
				mode: Platform.isMacOS ? this.settings.defaultMode : 'room',
				template: this.settings.lastTemplate || templates[0],
			},
			templates,
			(o) => void this.beginRecording(o),
		).open();
	}

	private async beginRecording(o: StartOptions) {
		const now = window.moment();
		const safeTitle = o.title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();
		let folder = normalizePath(`${this.settings.rootFolder}/${now.format('YYYY-MM-DD HHmm')} ${safeTitle}`);
		for (let i = 2; this.app.vault.getAbstractFileByPath(folder); i++) folder = folder.replace(/( \(\d+\))?$/, ` (${i})`);
		await this.ensureFolder(folder);
		const notes = await this.app.vault.create(normalizePath(`${folder}/Notes.md`), `# ${o.title}\n\n`);

		this.settings.lastTemplate = o.template;
		await this.saveSettings();

		const state: MeetingState = {
			version: 1,
			title: o.title,
			folder,
			startedAt: now.toISOString(),
			language: o.language,
			mode: o.mode,
			template: o.template,
			duration: 0,
			status: 'recording',
			chunks: [],
			noteTimes: {},
		};
		const session = new RecordingSession(this.app, this.api, this.settings, state, this.helperPath);
		session.onChange = () => this.render();
		try {
			await session.start();
		} catch (e) {
			await session.stop().catch(() => {});
			new Notice(`Impossible de démarrer l’enregistrement : ${(e as Error).message}`, 10000);
			return;
		}
		this.session = session;
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(notes, { active: true });
		const view = leaf.view;
		if (view instanceof MarkdownView) {
			view.editor.focus();
			view.editor.setCursor(view.editor.lastLine(), 0);
		}
		this.tick = window.setInterval(() => this.render(), 500);
		this.render();
	}

	async stopMeeting() {
		const session = this.session;
		if (!session) return;
		this.session = null;
		window.clearInterval(this.tick);
		const { folder } = session.state;
		this.processing.set(folder, 'Finalisation de l’audio…');
		this.render();
		try {
			await session.stop();
		} catch (e) {
			console.error('[meeting-notes] stop failed', e);
		}
		await this.runPipeline(session.state, session.queue);
	}

	private insertMarker(editor: Editor) {
		if (!this.session) return;
		const stamp = `==⏱ ${formatClock(this.session.elapsed)}== `;
		const cur = editor.getCursor();
		const line = editor.getLine(cur.line);
		if (line.trim()) {
			editor.replaceRange(`\n${stamp}`, { line: cur.line, ch: line.length });
			editor.setCursor({ line: cur.line + 1, ch: stamp.length });
		} else {
			editor.replaceRange(stamp, { line: cur.line, ch: 0 });
			editor.setCursor({ line: cur.line, ch: stamp.length });
		}
	}

	/** Remember when each line of the notes was started, so the summary can align notes and talk. */
	private onEditorChange(editor: Editor, info: MarkdownFileInfo) {
		const s = this.session;
		if (!s || info.file?.path !== s.notesPath) return;
		const line = editor.getCursor().line;
		if (this.lastLine.file !== s.notesPath || this.lastLine.line !== line) {
			this.lastLine = { file: s.notesPath, line, at: s.elapsed };
		}
		const text = editor.getLine(line);
		if (text.trim()) {
			// Keep the latest text of the line under its start time.
			s.noteTyped(text, this.lastLine.at);
		}
	}

	// ─── Processing ───

	private async runPipeline(state: MeetingState, queue: TranscriptionQueue) {
		const { folder } = state;
		const notice = new Notice('', 0);
		notice.messageEl.addClass('mn-notice');
		const update = (step: string) => {
			this.processing.set(folder, step);
			const { done, total } = queue.counts;
			notice.setMessage(`${state.title} — ${step}${step.startsWith('Transcription') && total ? ` ${done}/${total}` : ''}`);
			this.render();
		};
		queue.onProgress = () => update(this.processing.get(folder) ?? 'Transcription…');
		try {
			const res = await processMeeting(this.app, this.api, this.settings, state, queue, {
				progress: update,
				askNames: this.settings.askSpeakerNames
					? (people: Person[], utts: Utterance[]) =>
							new Promise((resolve) => new SpeakerNamesModal(this.app, people, utts, resolve).open())
					: undefined,
			});
			notice.hide();
			new Notice(`Compte rendu prêt : ${state.title}${res.cost ? ` (≈ ${res.cost.toFixed(3)} $ de transcription)` : ''}`);
			await this.app.workspace.getLeaf(false).openFile(res.summary);
		} catch (e) {
			notice.hide();
			state.status = 'error';
			state.error = (e as Error).message;
			await import('./session').then((m) => m.saveState(this.app, state)).catch(() => {});
			console.error('[meeting-notes] processing failed', e);
			new Notice(`Meeting Notes : ${(e as Error).message}`, 15000);
		} finally {
			this.processing.delete(folder);
			this.render();
		}
	}

	async reprocess(folder: string) {
		const state = await loadState(this.app, folder);
		if (!state) return new Notice('Pas de données d’enregistrement pour ce dossier.');
		if (state.status === 'recording') state.status = 'processing';
		const queue = new TranscriptionQueue(this.app, this.api, this.settings, state);
		await this.runPipeline(state, queue);
	}

	private activeMeetingFolder(): string | null {
		const file = this.app.workspace.getActiveFile();
		const folder = file?.parent?.path;
		if (!folder) return null;
		return this.app.vault.getAbstractFileByPath(normalizePath(`${folder}/Notes.md`)) ? folder : null;
	}

	/** Meetings cut short by a crash or quit: offer to finish them. */
	private async recoverInterrupted() {
		const root = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.rootFolder));
		if (!(root instanceof TFolder)) return;
		for (const child of root.children) {
			if (!(child instanceof TFolder)) continue;
			const state = await loadState(this.app, child.path).catch(() => null);
			if (!state || (state.status !== 'recording' && state.status !== 'processing')) continue;
			const n = new Notice('', 0);
			const el = n.messageEl;
			el.empty();
			el.createDiv({ text: `La réunion « ${state.title} » a été interrompue.` });
			const btn = el.createEl('button', { text: 'Terminer le traitement', cls: 'mod-cta mn-notice-btn' });
			btn.addEventListener('click', () => {
				n.hide();
				void this.reprocess(child.path);
			});
		}
	}

	// ─── UI ───

	private showRecorderMenu(anchor: HTMLElement) {
		const s = this.session;
		if (!s) return;
		const menu = new Menu();
		menu.addItem((i) =>
			i
				.setTitle(s.paused ? 'Reprendre' : 'Pause')
				.setIcon(s.paused ? 'play' : 'pause')
				.onClick(() => s.setPaused(!s.paused)),
		);
		menu.addItem((i) =>
			i
				.setTitle('Ouvrir les notes')
				.setIcon('file-text')
				.onClick(() => void s.openNotes()),
		);
		menu.addItem((i) =>
			i
				.setTitle('Marquer ce moment')
				.setIcon('bookmark')
				.onClick(() => {
					const view = this.app.workspace.getActiveViewOfType(MarkdownView);
					if (view?.file?.path === s.notesPath) this.insertMarker(view.editor);
					else new Notice('Ouvre les notes de la réunion pour marquer un moment.');
				}),
		);
		menu.addSeparator();
		menu.addItem((i) =>
			i
				.setTitle('Terminer la réunion')
				.setIcon('square')
				.setWarning(true)
				.onClick(() => void this.stopMeeting()),
		);
		const r = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: r.left, y: r.top });
	}

	private meter(parent: HTMLElement, db: number | null, label: string) {
		const m = parent.createSpan({ cls: 'mn-meter', attr: { 'aria-label': label } });
		const v = db == null ? 0 : Math.max(0, Math.min(1, (db + 60) / 50));
		m.createSpan({ cls: 'mn-meter-fill' }).style.setProperty('--level', String(v));
		if (db == null) m.addClass('is-off');
	}

	render() {
		const s = this.session;
		const el = this.statusEl;
		el.empty();
		el.toggleClass('is-recording', !!s && !s.paused);
		el.toggleClass('is-paused', !!s?.paused);
		if (s) {
			el.createSpan({ cls: 'mn-dot' });
			el.createSpan({ cls: 'mn-time', text: formatClock(s.elapsed) });
			this.meter(el, s.level('mic'), 'Micro');
			if (s.state.mode === 'call') this.meter(el, s.systemError ? null : s.level('system'), 'Son de l’ordinateur');
			el.setAttribute('aria-label', s.paused ? 'En pause — cliquer pour les options' : 'Enregistrement — cliquer pour les options');
		} else if (this.processing.size) {
			const icon = el.createSpan({ cls: 'mn-spin' });
			setIcon(icon, 'loader');
			el.createSpan({ text: [...this.processing.values()][0] });
			el.removeAttribute('aria-label');
		}
		el.toggle(!!s || this.processing.size > 0);
		setIcon(this.ribbonEl, s ? 'square' : 'mic');
		this.ribbonEl.setAttribute('aria-label', s ? 'Réunion en cours' : 'Démarrer une réunion');
		this.ribbonEl.toggleClass('mn-ribbon-recording', !!s);
		this.syncHeaderActions();
	}

	/** A stop button in the header of the meeting's notes while recording. */
	private syncHeaderActions() {
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view as MarkdownView;
			const want = !!this.session && view.file?.path === this.session.notesPath;
			const existing = this.headerActions.get(view);
			if (want && !existing) {
				const btn = view.addAction('square', 'Terminer la réunion', () => void this.stopMeeting());
				btn.addClass('mn-header-stop');
				this.headerActions.set(view, btn);
			} else if (!want && existing) {
				existing.remove();
				this.headerActions.delete(view);
			}
		}
	}
}
