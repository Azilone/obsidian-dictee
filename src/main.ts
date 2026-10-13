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
import type { Moment } from 'moment';
import { OpenRouter } from './openrouter';
import { formatClock, type Utterance } from './pipeline/merge';
import { processMeeting } from './pipeline/process';
import { DEFAULT_TEMPLATES } from './pipeline/prompts';
import type { Person } from './pipeline/speakers';
import { decodeFile, isAudioPath } from './recorder/decode';
import { RecordingSession, TranscriptionQueue, importRecording, loadState, saveState, type MeetingKind, type MeetingState } from './session';
import { DEFAULT_SETTINGS, MeetingSettingTab, type MeetingSettings } from './settings';
import { ImportMeetingModal, SpeakerNamesModal, StartChoiceModal, type ImportOptions, type StartOptions } from './ui/modals';
import { RecorderOverlay, type OverlayAction } from './ui/overlay';
import { RECORDER_VIEW, RecorderView } from './ui/recorder-view';
import { NoAccessError, listNewMemos, memoKind } from './recorder/voice-memos';

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
	private players = new WeakMap<MarkdownView, Player>();
	private lastLine = { file: '', line: -1, at: 0 };
	private overlay: RecorderOverlay | null = null;
	private overlayWarned = false;
	/** Pending "still in a meeting?" question. */
	private idle: { minutes: number; deadline: number; notice: Notice } | null = null;
	/** Meeting-clock time (s) before which the idle question is not asked again. */
	private idleSnoozeUntil = 0;

	async onload() {
		await this.loadSettings();
		this.api = new OpenRouter(() => this.apiKey());

		this.addSettingTab(new MeetingSettingTab(this.app, this));
		this.registerView(RECORDER_VIEW, (leaf) => new RecorderView(leaf, this));
		this.ribbonEl = this.addRibbonIcon('mic', Platform.isMobile ? 'Enregistreur' : 'Démarrer une réunion', () => {
			// On the phone the recorder screen (big button) is the way in.
			if (Platform.isMobile) void this.openRecorder();
			else if (this.session) this.showRecorderMenu(this.ribbonEl);
			else void this.startMeeting();
		});
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
			id: 'open-recorder',
			name: 'Ouvrir l’enregistreur',
			icon: 'mic',
			callback: () => void this.openRecorder(),
		});
		this.addCommand({
			id: 'voice-note',
			name: 'Enregistrer une note vocale',
			icon: 'audio-lines',
			checkCallback: (checking) => {
				if (this.session) return false;
				if (!checking) void this.startFromRecorder('voice', { title: '', template: '' }).then(() => this.openRecorder());
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
			id: 'import',
			name: 'Importer un enregistrement audio',
			icon: 'file-audio',
			callback: () => void this.importFromDialog(),
		});
		this.addCommand({
			id: 'show-overlay',
			name: 'Afficher l’overlay d’enregistrement',
			icon: 'picture-in-picture-2',
			checkCallback: (checking) => {
				if (!this.session) return false;
				if (!checking) this.showOverlay(true);
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
		this.registerEvent(this.app.workspace.on('layout-change', () => this.syncPlayers()));
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (file instanceof TFile && isAudioPath(file.path) && file.basename !== 'audio') {
					menu.addItem((i) =>
						i
							.setTitle('Créer une réunion depuis cet audio')
							.setIcon('file-audio')
							.onClick(() => void this.importAudio(file)),
					);
				}
				const folder = file instanceof TFolder ? file.path : file.parent?.path;
				if (!folder || this.processing.has(folder) || this.session?.state.folder === folder) return;
				if (!this.isMeetingFolder(folder)) return;
				menu.addItem((i) =>
					i
						.setTitle('Retraiter la réunion')
						.setIcon('refresh-cw')
						.onClick(() => void this.reprocess(folder)),
				);
			}),
		);
		this.register(() => window.clearInterval(this.tick));
		this.app.workspace.onLayoutReady(() => {
			void this.recoverInterrupted();
			if (this.settings.importFolder) void this.ensureFolder(this.settings.importFolder).catch(() => {});
			// A recording dropped in the import folder (AirDrop, iCloud, Dictaphone…) is offered right
			// away, and the ones that arrived while Obsidian was closed are offered at startup.
			const inbox = (f: unknown): f is TFile =>
				f instanceof TFile && isAudioPath(f.path) && !!this.settings.importFolder && f.parent?.path === normalizePath(this.settings.importFolder);
			this.registerEvent(
				this.app.vault.on('create', (f) => {
					if (inbox(f)) this.offerImport([f]);
				}),
			);
			if (Platform.isDesktopApp && Platform.isMacOS) {
				void this.checkVoiceMemos();
				this.registerInterval(window.setInterval(() => void this.checkVoiceMemos(), 2 * 60_000));
			}
			const dir = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.importFolder || '/'));
			if (dir instanceof TFolder) {
				const waiting = dir.children.filter(inbox);
				if (waiting.length) this.offerImport(waiting);
			}
		});
		this.render();
	}

	private offerImport(files: TFile[]) {
		const n = new Notice('', 0);
		n.messageEl.empty();
		n.messageEl.createDiv({
			text: files.length === 1 ? `Nouvel enregistrement : ${files[0].name}` : `${files.length} enregistrements à traiter`,
		});
		n.messageEl
			.createEl('button', { text: 'Traiter', cls: 'mod-cta mn-notice-btn' })
			.addEventListener('click', async () => {
				n.hide();
				for (const f of files) await this.importAudio(f);
			});
	}

	private memoCheck: Promise<void> | null = null;
	private memoAccessWarned = false;

	/** New Voice Memos from the iPhone → journal entries or meetings, without asking. */
	checkVoiceMemos(explicit = false): Promise<void> {
		if (!this.settings.voiceMemos || !this.apiKey()) return Promise.resolve();
		this.memoCheck ??= this.importVoiceMemos(explicit).finally(() => (this.memoCheck = null));
		return this.memoCheck;
	}

	private async importVoiceMemos(explicit: boolean) {
		const st = this.settings;
		let memos;
		try {
			memos = listNewMemos(st.voiceMemosDir, new Date(st.voiceMemosSince || Date.now()), new Set(st.voiceMemosSeen));
		} catch (e) {
			if (!(e instanceof NoAccessError) || (this.memoAccessWarned && !explicit)) return;
			this.memoAccessWarned = true;
			const n = new Notice('', 0);
			n.messageEl.empty();
			n.messageEl.createDiv({
				text: 'Pour lire les mémos Dictaphone, donne l’accès complet au disque à Obsidian (puis redémarre Obsidian).',
			});
			n.messageEl.createEl('button', { text: 'Ouvrir les réglages', cls: 'mod-cta mn-notice-btn' }).addEventListener('click', () => {
				n.hide();
				// eslint-disable-next-line @typescript-eslint/no-var-requires
				require('electron').shell?.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
			});
			return;
		}
		for (const memo of memos) {
			if (!this.settings.voiceMemos) return;
			// Marked first: a memo that fails is kept in its folder for « Retraiter », never re-imported in a loop.
			st.voiceMemosSeen.push(memo.name);
			await this.saveSettings();
			const kind = memoKind(memo);
			const templates = await this.templateNames();
			await this.importAudio(memo.path, {
				kind,
				title: kind === 'meeting' ? memo.title : 'Mémo',
				startedAt: memo.recordedAt.toISOString(),
				language: st.language,
				template: st.lastTemplate || templates[0],
			});
		}
	}

	async openRecorder() {
		const existing = this.app.workspace.getLeavesOfType(RECORDER_VIEW)[0];
		const leaf = existing ?? this.app.workspace.getLeaf(Platform.isMobile ? false : 'tab');
		if (!existing) await leaf.setViewState({ type: RECORDER_VIEW, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	processingLabel(): string | null {
		return this.processing.size ? [...this.processing.values()][0] : null;
	}

	onunload() {
		this.overlay?.destroy();
		this.overlay = null;
		// Never drop a recording silently: write out what we have.
		if (this.session) void this.session.stop();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Native helper (desktop only); empty on mobile, where there is no file system path. */
	get helperPath(): string {
		const base = this.vaultBasePath();
		return base ? `${base}/${this.manifest.dir}/meeting-tap` : '';
	}

	// ─── Templates ───

	async templateNames(): Promise<string[]> {
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

	/** `Réunions/YYYY-MM-DD HHmm Title`, suffixed when it already exists; created on disk. */
	private async newMeetingFolder(title: string, when: Moment, kind: MeetingKind | 'auto' = 'meeting'): Promise<string> {
		const safeTitle = title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();
		const root = kind === 'meeting' ? this.settings.rootFolder : this.settings.voiceFolder;
		let folder = normalizePath(`${root}/${when.format('YYYY-MM-DD HHmm')} ${safeTitle}`);
		for (let i = 2; this.app.vault.getAbstractFileByPath(folder); i++) folder = folder.replace(/( \(\d+\))?$/, ` (${i})`);
		await this.ensureFolder(folder);
		return folder;
	}

	// ─── Recording ───

	/** No key yet: say so with a shortcut to the settings. Returns false when missing. */
	private requireKey(): boolean {
		if (this.apiKey()) return true;
		const n = new Notice('', 10000);
		n.messageEl.empty();
		n.messageEl.createDiv({ text: 'Ajoute ta clé OpenRouter dans les réglages (à faire sur chaque appareil).' });
		n.messageEl
			.createEl('button', { text: 'Ouvrir les réglages', cls: 'mod-cta mn-notice-btn' })
			.addEventListener('click', () => {
				n.hide();
				this.openSettings();
			});
		return false;
	}

	/** System audio needs the macOS helper; anywhere else a meeting is mic-only (in person). */
	private get canRecordCalls(): boolean {
		return Platform.isDesktopApp && Platform.isMacOS;
	}

	async startMeeting() {
		// On the phone, everything goes through the recorder screen (big button).
		if (Platform.isMobile) return this.openRecorder();
		if (this.session || !this.requireKey()) return;
		const templates = await this.templateNames();
		new StartChoiceModal(this.app, (kind) => {
			if (kind === 'voice') return void this.startFromRecorder('voice', { title: '', template: '' });
			void this.beginRecording({
				title: 'Réunion',
				language: this.settings.language,
				mode: this.canRecordCalls ? this.settings.defaultMode : 'room',
				template: templates.includes(this.settings.defaultTemplate) ? this.settings.defaultTemplate : templates[0],
				autoTitle: true,
			});
		}).open();
	}

	/** From the recorder screen: a voice note starts at once; a meeting is in person (mic only). */
	async startFromRecorder(kind: MeetingKind, o: { title: string; template: string }) {
		if (this.session || !this.requireKey()) return;
		const templates = await this.templateNames();
		await this.beginRecording(
			{
				title: o.title || (kind === 'voice' ? 'Note vocale' : 'Réunion'),
				language: this.settings.language,
				mode: 'room',
				template: kind === 'voice' ? '' : templates.includes(o.template) ? o.template : templates[0],
				autoTitle: kind === 'meeting' && !o.title,
			},
			kind,
			false,
		);
	}

	private async beginRecording(o: StartOptions, kind: MeetingKind = 'meeting', openNotes = true) {
		const now = window.moment();
		const folder = await this.newMeetingFolder(o.title, now, kind);
		const notes = kind === 'meeting' ? await this.app.vault.create(normalizePath(`${folder}/Notes.md`), `# ${o.title}\n\n`) : null;

		if (kind === 'meeting') {
			this.settings.lastTemplate = o.template;
			await this.saveSettings();
		}

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
			kind,
			autoTitle: o.autoTitle,
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
		if (notes && openNotes && !Platform.isMobile) {
			const leaf = this.app.workspace.getLeaf(false);
			await leaf.openFile(notes, { active: true });
			const view = leaf.view;
			if (view instanceof MarkdownView) {
				view.editor.focus();
				view.editor.setCursor(view.editor.lastLine(), 0);
			}
		}
		this.tick = window.setInterval(() => this.onTick(), 500);
		if (this.settings.overlay && Platform.isDesktopApp) this.showOverlay(false);
		this.render();
	}

	private onTick() {
		this.render();
		this.guard();
		if (this.overlay) {
			const s = this.session;
			if (s) this.overlay.update(this.overlayState(s));
			void this.overlay.poll();
		}
	}

	async stopMeeting(reason?: string) {
		const session = this.session;
		if (!session) return;
		this.session = null;
		window.clearInterval(this.tick);
		this.overlay?.destroy();
		this.overlay = null;
		this.clearIdle();
		if (reason) new Notice(reason, 10000);
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

	// ─── Overlay & guards ───

	private showOverlay(explicit: boolean) {
		const s = this.session;
		if (!s) return;
		if (!this.overlay) {
			this.overlay = new RecorderOverlay({
				hiddenFromCapture: this.settings.overlayHidden,
				position: this.settings.overlayPos,
				onAction: (a, payload) => this.onOverlayAction(a, payload),
			});
		}
		const ok = this.overlay.show();
		if (!ok) {
			this.overlay = null;
			if (explicit || !this.overlayWarned) new Notice('Overlay indisponible dans cette version d’Obsidian.');
			this.overlayWarned = true;
			return;
		}
		this.overlay.update(this.overlayState(s));
	}

	private overlayState(s: RecordingSession) {
		const sent = s.sentSeconds;
		const cost = s.estimatedCost;
		return {
			time: formatClock(s.elapsed),
			paused: s.paused,
			levels: [s.level('mic'), ...(s.state.mode === 'call' ? [s.systemError ? null : s.level('system')] : [])],
			sent: `${Math.round(sent / 60)} min envoyées`,
			cost: cost >= 0.005 ? `${cost.toFixed(2).replace('.', ',')} $` : '',
			idle: this.idle ? { minutes: this.idle.minutes, left: Math.max(0, Math.round((this.idle.deadline - performance.now()) / 1000)) } : null,
		};
	}

	private onOverlayAction(action: OverlayAction, payload?: unknown) {
		const s = this.session;
		switch (action) {
			case 'toggle':
				s?.setPaused(!s.paused);
				break;
			case 'mark':
				void this.markMoment();
				break;
			case 'stop':
				void this.stopMeeting();
				break;
			case 'continue':
				this.continueMeeting();
				break;
			case 'moved':
				this.settings.overlayPos = payload as { x: number; y: number };
				void this.saveSettings();
				break;
		}
	}

	/** Auto-stop on a long silence (after asking) or past the maximum duration. */
	private guard() {
		const s = this.session;
		const st = this.settings;
		if (!s || s.paused) return;
		if (st.maxMinutes > 0 && s.elapsed >= st.maxMinutes * 60) {
			void this.stopMeeting(`Durée maximale atteinte (${st.maxMinutes} min) : réunion terminée automatiquement.`);
			return;
		}
		if (st.idleMinutes <= 0) return;
		if (this.idle) {
			if (s.idleSeconds < 20) {
				// Someone spoke again: question withdrawn.
				this.clearIdle();
			} else if (performance.now() >= this.idle.deadline) {
				void this.stopMeeting(`Aucune parole depuis ${Math.round(s.idleSeconds / 60)} min : réunion terminée automatiquement.`);
			}
			return;
		}
		if (s.idleSeconds >= st.idleMinutes * 60 && s.elapsed >= this.idleSnoozeUntil) this.askIdle(Math.round(s.idleSeconds / 60));
	}

	private askIdle(minutes: number) {
		const grace = Math.max(0.5, this.settings.idleGraceMinutes);
		const notice = new Notice('', 0);
		const el = notice.messageEl;
		el.empty();
		el.createDiv({ text: `Plus de parole depuis ${minutes} min — toujours en réunion ? Sans réponse, l’enregistrement s’arrête dans ${grace} min.` });
		const row = el.createDiv({ cls: 'mn-notice-row' });
		row.createEl('button', { text: 'Continuer', cls: 'mod-cta mn-notice-btn' }).addEventListener('click', () => this.continueMeeting());
		row.createEl('button', { text: 'Terminer', cls: 'mod-warning mn-notice-btn' }).addEventListener('click', () => void this.stopMeeting());
		this.idle = { minutes, deadline: performance.now() + grace * 60_000, notice };
		this.overlay?.show();
	}

	private continueMeeting() {
		const s = this.session;
		if (s) this.idleSnoozeUntil = s.elapsed + Math.max(1, this.settings.idleMinutes) * 60;
		this.clearIdle();
	}

	private clearIdle() {
		this.idle?.notice.hide();
		this.idle = null;
	}

	/** Drop a time marker in the notes, wherever the user is. */
	private async markMoment() {
		const s = this.session;
		if (!s) return;
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view as MarkdownView;
			if (view.file?.path === s.notesPath) {
				this.insertMarker(view.editor);
				return;
			}
		}
		const file = this.app.vault.getAbstractFileByPath(s.notesPath);
		if (!(file instanceof TFile)) return;
		const stamp = `==⏱ ${formatClock(s.elapsed)}== `;
		await this.app.vault.process(file, (data) => `${data.replace(/\s+$/, '')}\n${stamp}\n`);
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

	/**
	 * `background`: nobody is waiting (auto-import) — no questions, nothing opened.
	 * One notice per recording: « transcription en cours » then « terminée · prix ».
	 */
	private async runPipeline(state: MeetingState, queue: TranscriptionQueue, background = false, notice?: ProgressNotice) {
		const { folder } = state;
		const progress = notice ?? new ProgressNotice(this.recordingLabel(state));
		queue.onProgress = () => this.render();
		try {
			const res = await processMeeting(this.app, this.api, this.settings, state, queue, {
				progress: (step) => {
					this.processing.set(state.folder, step);
					this.render();
				},
				relocate: (kind) => this.settleKind(state, kind),
				askNames: this.settings.askSpeakerNames && !background
					? (people: Person[], utts: Utterance[]) =>
							new Promise((resolve) => new SpeakerNamesModal(this.app, people, utts, resolve).open())
					: undefined,
			});
			const open = () => void this.app.workspace.getLeaf(false).openFile(res.summary);
			progress.done(res.cost, open, this.recordingLabel(state));
			if (!background) open();
		} catch (e) {
			state.status = 'error';
			state.error = (e as Error).message;
			await saveState(this.app, state).catch(() => {});
			console.error('[meeting-notes] processing failed', e);
			progress.fail((e as Error).message);
		} finally {
			this.processing.delete(folder);
			this.processing.delete(state.folder);
			this.render();
		}
	}

	private recordingLabel(state: MeetingState): string {
		return state.kind === 'voice' ? 'Journal' : state.kind === 'auto' ? 'Mémo' : state.title;
	}

	/**
	 * An `auto` recording once the transcript says what it is: a journal stays with the voice
	 * notes (renamed « Journal »), a meeting moves to the meetings folder and gets a title later.
	 */
	private async settleKind(state: MeetingState, kind: MeetingKind) {
		const from = this.app.vault.getAbstractFileByPath(state.folder);
		if (!(from instanceof TFolder)) return;
		const stamp = from.name.match(/^\d{4}-\d{2}-\d{2} \d{4}/)?.[0] ?? window.moment(state.startedAt).format('YYYY-MM-DD HHmm');
		const title = kind === 'voice' ? 'Journal' : 'Réunion';
		const root = normalizePath(kind === 'voice' ? this.settings.voiceFolder : this.settings.rootFolder);
		await this.ensureFolder(root);
		let to = normalizePath(`${root}/${stamp} ${title}`);
		for (let i = 2; this.app.vault.getAbstractFileByPath(to); i++) to = normalizePath(`${root}/${stamp} ${title} (${i})`);
		await this.app.fileManager.renameFile(from, to);
		this.processing.delete(state.folder);
		Object.assign(state, { folder: to, title, kind });
		if (kind === 'meeting') {
			state.autoTitle = true;
			state.template ||= this.settings.lastTemplate || (await this.templateNames())[0];
			await this.app.vault.create(normalizePath(`${to}/Notes.md`), `# ${title}\n\n`);
		}
		await saveState(this.app, state);
	}

	// ─── Import ───

	private vaultBasePath(): string {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return ((this.app.vault.adapter as any).getBasePath?.() as string | undefined) ?? '';
	}

	/** Native file dialog; falls back to a hint when Electron's remote module is unavailable. */
	private async importFromDialog() {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let remote: any = null;
		try {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			remote = require('electron')?.remote;
		} catch {
			/* no remote */
		}
		if (!Platform.isDesktopApp || !remote?.dialog) {
			return new Notice(`Dépose le fichier audio dans « ${this.settings.importFolder} » ou fais un clic droit dessus dans le coffre.`, 10000);
		}
		const res = await remote.dialog.showOpenDialog({
			title: 'Importer un enregistrement',
			properties: ['openFile'],
			filters: [{ name: 'Audio', extensions: ['m4a', 'mp3', 'wav', 'aac', 'ogg', 'opus', 'webm', 'mp4', 'flac', 'aiff', 'caf'] }],
		});
		const abs: string | undefined = res?.filePaths?.[0];
		if (!abs) return;
		const base = this.vaultBasePath();
		if (abs.startsWith(base + '/')) {
			const inVault = this.app.vault.getAbstractFileByPath(normalizePath(abs.slice(base.length + 1)));
			if (inVault instanceof TFile) return this.importAudio(inVault);
		}
		return this.importAudio(abs);
	}

	/**
	 * Build a meeting or a voice note from an audio file, in the vault or (desktop) anywhere on
	 * disk. A file from the import folder is moved into the new folder, so it is handled once.
	 */
	async importAudio(source: TFile | string, preset?: ImportOptions) {
		if (!this.requireKey()) return;
		const background = !!preset;
		let name: string, base: string, ext: string, mtime: Date;
		if (source instanceof TFile) {
			({ name, basename: base, extension: ext } = source);
			mtime = new Date(source.stat.mtime);
		} else {
			const fs = require('fs') as typeof import('fs');
			const path = require('path') as typeof import('path');
			name = path.basename(source);
			ext = path.extname(source).slice(1);
			base = path.basename(source, path.extname(source));
			try {
				mtime = fs.statSync(source).mtime;
			} catch {
				return new Notice(`Fichier introuvable : ${source}`);
			}
		}
		ext = ext.toLowerCase() || 'm4a';
		const templates = await this.templateNames();
		const opts = preset ?? await new Promise<ImportOptions | null>((resolve) =>
			new ImportMeetingModal(
				this.app,
				name,
				{
					kind: this.settings.lastKind,
					title: base.replace(/[_-]+/g, ' ').trim(),
					startedAt: mtime.toISOString(),
					language: this.settings.language,
					template: this.settings.lastTemplate || templates[0],
				},
				templates,
				resolve,
			).open(),
		);
		if (!opts) return;
		const { kind } = opts;

		const folder = await this.newMeetingFolder(opts.title, window.moment(opts.startedAt), kind);
		if (kind === 'meeting') {
			await this.app.vault.create(normalizePath(`${folder}/Notes.md`), `# ${opts.title}\n\n`);
			if (!background) this.settings.lastTemplate = opts.template;
		}
		if (!background && kind !== 'auto') {
			this.settings.lastKind = kind;
			await this.saveSettings();
		}

		const state: MeetingState = {
			version: 1,
			title: opts.title,
			folder,
			startedAt: opts.startedAt,
			language: opts.language,
			mode: 'room',
			template: kind === 'voice' ? '' : opts.template,
			duration: 0,
			status: 'processing',
			chunks: [],
			noteTimes: {},
			source: 'import',
			sourceFile: source instanceof TFile ? source.path : source,
			kind,
		};
		const notice = new ProgressNotice(this.recordingLabel(state));
		const step = (text: string) => {
			this.processing.set(folder, text);
			this.render();
		};
		step('Décodage de l’audio…');
		try {
			let file = source instanceof TFile ? source : null;
			const dest = normalizePath(`${folder}/audio.${ext}`);
			const inbox = this.settings.importFolder && file?.parent?.path === normalizePath(this.settings.importFolder);
			if (file && inbox) {
				await this.app.fileManager.renameFile(file, dest);
				file = this.app.vault.getAbstractFileByPath(dest) as TFile;
			} else if (this.settings.keepAudio) {
				const bytes = file ? await this.app.vault.readBinary(file) : this.readDiskFile(source as string);
				await this.app.vault.adapter.writeBinary(dest, bytes);
			}
			const readBytes = async () => (file ? this.app.vault.readBinary(file) : this.readDiskFile(source as string));
			const basePath = this.vaultBasePath();
			const abs = file ? (basePath ? `${basePath}/${file.path}` : '') : (source as string);
			const queue = await importRecording(this.app, this.api, this.settings, state, (onPcm) =>
				decodeFile(Platform.isDesktopApp ? this.helperPath : '', abs, readBytes, {
					onPcm,
					progress: (r) => step(`Découpage de l’audio… ${Math.round(r * 100)} %`),
				}),
			);
			this.processing.delete(folder);
			await this.runPipeline(state, queue, background, notice);
		} catch (e) {
			this.processing.delete(folder);
			this.render();
			state.status = 'error';
			state.error = (e as Error).message;
			await saveState(this.app, state).catch(() => {});
			console.error('[meeting-notes] import failed', e);
			notice.fail((e as Error).message);
		}
	}

	private readDiskFile(abs: string): ArrayBuffer {
		const buf = (require('fs') as typeof import('fs')).readFileSync(abs);
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
	}

	async reprocess(folder: string) {
		const state = await loadState(this.app, folder);
		if (!state) return new Notice('Pas de données d’enregistrement pour ce dossier.');
		if (state.status === 'recording') state.status = 'processing';
		const queue = new TranscriptionQueue(this.app, this.api, this.settings, state);
		await this.runPipeline(state, queue);
	}

	private activeMeetingFolder(): string | null {
		const folder = this.app.workspace.getActiveFile()?.parent?.path;
		return folder && this.isMeetingFolder(folder) ? folder : null;
	}

	/** A meeting folder has its `Notes.md`; a voice note lives directly under the voice folder. */
	private isMeetingFolder(folder: string): boolean {
		if (this.app.vault.getAbstractFileByPath(normalizePath(`${folder}/Notes.md`))) return true;
		const parent = folder.split('/').slice(0, -1).join('/');
		return !!this.settings.voiceFolder && parent === normalizePath(this.settings.voiceFolder);
	}

	/** Meetings cut short by a crash or quit: offer to finish them. */
	private async recoverInterrupted() {
		const roots = [this.settings.rootFolder, this.settings.voiceFolder]
			.map((p) => this.app.vault.getAbstractFileByPath(normalizePath(p || '/')))
			.filter((f): f is TFolder => f instanceof TFolder && !f.isRoot());
		for (const child of roots.flatMap((r) => r.children)) {
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
		this.ribbonEl.setAttribute('aria-label', s ? 'Enregistrement en cours' : Platform.isMobile ? 'Enregistreur' : 'Démarrer une réunion');
		this.ribbonEl.toggleClass('mn-ribbon-recording', !!s);
		this.syncPlayers();
		for (const leaf of this.app.workspace.getLeavesOfType(RECORDER_VIEW)) {
			if (leaf.view instanceof RecorderView) leaf.view.refresh();
		}
	}

	/** A floating mini player (pause / finish) over the meeting's notes while recording. */
	private syncPlayers() {
		const s = this.session;
		for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
			const view = leaf.view as MarkdownView;
			const want = !!s && !Platform.isMobile && view.file?.path === s.notesPath;
			let player = this.players.get(view);
			if (want && !player) {
				player = new Player(view.contentEl, {
					onToggle: () => this.session?.setPaused(!this.session.paused),
					onStop: () => void this.stopMeeting(),
				});
				this.players.set(view, player);
			} else if (!want && player) {
				player.destroy();
				this.players.delete(view);
				continue;
			}
			if (want && s) player!.update(s);
		}
	}
}

/** Mini player DOM: updated in place so clicks are never lost to a re-render. */
class Player {
	private el: HTMLElement;
	private toggle: HTMLElement;
	private time: HTMLElement;
	private meters: HTMLElement;
	private paused: boolean | null = null;

	constructor(parent: HTMLElement, actions: { onToggle: () => void; onStop: () => void }) {
		this.el = parent.createDiv({ cls: 'mn-player' });
		this.el.createSpan({ cls: 'mn-dot' });
		this.time = this.el.createSpan({ cls: 'mn-time' });
		this.meters = this.el.createSpan({ cls: 'mn-meters' });
		this.toggle = this.button('pause', 'Pause', actions.onToggle);
		this.button('square', 'Terminer la réunion', actions.onStop).addClass('mod-stop');
	}

	private button(icon: string, label: string, onClick: () => void) {
		const b = this.el.createEl('button', { cls: 'clickable-icon mn-player-btn', attr: { 'aria-label': label } });
		setIcon(b, icon);
		b.addEventListener('click', onClick);
		return b;
	}

	update(s: RecordingSession) {
		this.time.setText(formatClock(s.elapsed));
		this.el.toggleClass('is-paused', s.paused);
		if (s.paused !== this.paused) {
			this.paused = s.paused;
			setIcon(this.toggle, s.paused ? 'play' : 'pause');
			this.toggle.setAttribute('aria-label', s.paused ? 'Reprendre' : 'Pause');
		}
		const levels = [s.level('mic'), ...(s.state.mode === 'call' ? [s.systemError ? null : s.level('system')] : [])];
		while (this.meters.childElementCount < levels.length) {
			this.meters.createSpan({ cls: 'mn-meter' }).createSpan({ cls: 'mn-meter-fill' });
		}
		levels.forEach((db, i) => {
			const m = this.meters.children[i] as HTMLElement;
			m.toggleClass('is-off', db == null);
			(m.firstElementChild as HTMLElement).style.setProperty('--level', String(db == null ? 0 : Math.max(0, Math.min(1, (db + 60) / 50))));
		});
	}

	destroy() {
		this.el.remove();
	}
}

/** The single notice of a recording: in progress, then done with its price (click to open), or failed. */
class ProgressNotice {
	private notice = new Notice('', 0);

	constructor(private label: string) {
		this.notice.messageEl.addClass('mn-notice');
		this.notice.setMessage(`🎙️ ${label} — transcription en cours…`);
	}

	done(cost: number, open: () => void, label = this.label) {
		this.notice.hide();
		const n = new Notice(`✓ ${label} — transcription terminée${cost > 0 ? ` · ${formatCost(cost)}` : ''}`, 8000);
		n.messageEl.addClass('mn-notice', 'mod-clickable');
		n.messageEl.addEventListener('click', open);
	}

	fail(message: string) {
		this.notice.hide();
		new Notice(`✗ ${this.label} — échec : ${message}`, 15000);
	}
}

function formatCost(usd: number): string {
	return `${usd.toFixed(usd < 0.1 ? 3 : 2).replace('.', ',')} $`;
}
