import { App, Platform, PluginSettingTab, type Setting, type SettingDefinitionItem, type SettingGroupItem } from 'obsidian';
import type MuesliPlugin from './main';
import { checkKey } from './openrouter';
import { listMicrophones } from './recorder/sources';
import { VOICE_MEMOS_DIR } from './recorder/voice-memos';
import { t as L } from './i18n';

/** Transcription languages (ISO code → name), '' = auto-detect. */
export const LANGUAGES: Record<string, string> = L.languages;

export type MeetingMode = 'call' | 'room';

export interface MeetingSettings {
	sttModel: string;
	llmModel: string;
	rootFolder: string;
	templatesFolder: string;
	language: string;
	summaryLanguage: string;
	myName: string;
	micDevice: string;
	defaultMode: MeetingMode;
	keepAudio: boolean;
	askSpeakerNames: boolean;
	chunkMinutes: number;
	lastTemplate: string;
	/** Summary template used when a meeting starts. */
	defaultTemplate: string;
	/** Floating always-on-top recorder pill. */
	overlay: boolean;
	/** Exclude the overlay from screen sharing / screenshots (macOS content protection). */
	overlayHidden: boolean;
	overlayPos: { x: number; y: number } | null;
	/** Minutes without speech before asking whether the meeting is still on (0 = never). */
	idleMinutes: number;
	/** Minutes to wait for an answer before stopping on its own. */
	idleGraceMinutes: number;
	/** Hard limit on a recording (0 = none). */
	maxMinutes: number;
	/** USD per minute of audio sent, for the live estimate. */
	sttPricePerMinute: number;
	/** Audio files dropped here are offered for import. */
	importFolder: string;
	/** Voice notes (audio + transcript), one sub-folder each. */
	voiceFolder: string;
	/** Moment pattern for the daily note path, e.g. `[Journal]/YYYY/YYYY-MM-DD`; empty = core Daily notes. */
	dailyNoteFormat: string;
	/** Last choice on the recorder screen. */
	lastKind: 'meeting' | 'voice';
	/** macOS: process new Voice Memos (synced from the iPhone) automatically. */
	voiceMemos: boolean;
	voiceMemosDir: string;
	/** Only memos recorded after this (ISO), so turning it on does not import the whole history. */
	voiceMemosSince: string;
	/** File names already handled. */
	voiceMemosSeen: string[];
	/** The first-run setup was shown (it opens by itself only once, and only without a key). */
	onboarded: boolean;
}

export const DEFAULT_SETTINGS: MeetingSettings = {
	sttModel: 'microsoft/mai-transcribe-2',
	llmModel: 'anthropic/claude-haiku-5.5',
	rootFolder: L.defaults.rootFolder,
	templatesFolder: L.defaults.templatesFolder,
	language: '',
	summaryLanguage: L.defaults.summaryLanguage,
	myName: L.me,
	micDevice: '',
	defaultMode: 'call',
	keepAudio: true,
	askSpeakerNames: true,
	chunkMinutes: 8,
	lastTemplate: '',
	defaultTemplate: L.defaults.defaultTemplate,
	overlay: true,
	overlayHidden: true,
	overlayPos: null,
	idleMinutes: 10,
	idleGraceMinutes: 5,
	maxMinutes: 180,
	sttPricePerMinute: 0.0017,
	importFolder: L.defaults.importFolder,
	voiceFolder: L.defaults.voiceFolder,
	dailyNoteFormat: '',
	lastKind: 'voice',
	voiceMemos: false,
	voiceMemosDir: VOICE_MEMOS_DIR,
	voiceMemosSince: '',
	voiceMemosSeen: [],
	onboarded: false,
};

type Key = keyof MeetingSettings;

const nonEmpty = (v: string) => (v.trim() ? undefined : L.s.required);

export class MeetingSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: MuesliPlugin,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem<Key>[] {
		const minutes = (name: string, desc: string, key: 'idleMinutes' | 'idleGraceMinutes' | 'maxMinutes'): SettingGroupItem<Key> => ({
			name,
			desc,
			control: { type: 'number', key, min: 0, defaultValue: DEFAULT_SETTINGS[key] },
		});
		return [
			{
				name: L.ob.settingName,
				desc: L.ob.settingDesc,
				render: (setting) => {
					setting.addButton((b) => b.setButtonText(L.ob.open).onClick(() => this.plugin.openOnboarding()));
				},
			},
			{ name: L.s.apiKey, desc: L.s.apiKeyDesc, aliases: ['OpenRouter', 'API'], render: (setting) => this.renderKey(setting) },
			{ name: L.s.yourName, desc: L.s.yourNameDesc, control: { type: 'text', key: 'myName', validate: nonEmpty } },
			{
				type: 'group',
				heading: L.s.recording,
				items: [
					{ name: L.s.mic, render: (setting) => this.renderMic(setting) },
					{
						name: L.s.mode,
						desc: L.s.modeDesc,
						control: { type: 'dropdown', key: 'defaultMode', options: { call: L.s.modeCall, room: L.s.modeRoom } },
					},
					{ name: L.s.template, desc: L.s.templateDesc, render: (setting) => this.renderTemplate(setting) },
					{ name: L.s.keepAudio, desc: L.s.keepAudioDesc, control: { type: 'toggle', key: 'keepAudio' } },
					{ name: L.s.chunk, desc: L.s.chunkDesc, control: { type: 'slider', key: 'chunkMinutes', min: 2, max: 12, step: 1 } },
				],
			},
			{
				type: 'group',
				heading: L.s.memos,
				visible: Platform.isDesktopApp && Platform.isMacOS,
				items: [{ name: L.s.memosToggle, desc: L.s.memosDesc, render: (setting) => this.renderVoiceMemos(setting) }],
			},
			{
				type: 'group',
				heading: L.s.overlay,
				items: [
					{ name: L.s.overlayToggle, desc: L.s.overlayDesc, control: { type: 'toggle', key: 'overlay' } },
					{ name: L.s.overlayHidden, desc: L.s.overlayHiddenDesc, control: { type: 'toggle', key: 'overlayHidden' } },
				],
			},
			{
				type: 'group',
				heading: L.s.guards,
				items: [
					minutes(L.s.idle, L.s.idleDesc, 'idleMinutes'),
					minutes(L.s.grace, L.s.graceDesc, 'idleGraceMinutes'),
					minutes(L.s.max, L.s.maxDesc, 'maxMinutes'),
					{
						name: L.s.price,
						desc: L.s.priceDesc,
						control: { type: 'number', key: 'sttPricePerMinute', min: 0, step: 'any', defaultValue: DEFAULT_SETTINGS.sttPricePerMinute },
					},
				],
			},
			{
				type: 'group',
				heading: L.s.ai,
				items: [
					{ name: L.s.lang, desc: L.s.langDesc, control: { type: 'dropdown', key: 'language', options: LANGUAGES } },
					{ name: L.s.summaryLang, control: { type: 'text', key: 'summaryLanguage', validate: nonEmpty } },
					{ name: L.s.askNames, control: { type: 'toggle', key: 'askSpeakerNames' } },
					{ name: L.s.sttModel, control: { type: 'text', key: 'sttModel', placeholder: DEFAULT_SETTINGS.sttModel, validate: nonEmpty } },
					{ name: L.s.llmModel, control: { type: 'text', key: 'llmModel', placeholder: DEFAULT_SETTINGS.llmModel, validate: nonEmpty } },
				],
			},
			{
				type: 'group',
				heading: L.s.folders,
				items: [
					{ name: L.s.rootFolder, control: { type: 'text', key: 'rootFolder', placeholder: DEFAULT_SETTINGS.rootFolder, validate: nonEmpty } },
					{ name: L.s.importFolder, desc: L.s.importFolderDesc, control: { type: 'text', key: 'importFolder', placeholder: DEFAULT_SETTINGS.importFolder } },
					{
						name: L.s.voiceFolder,
						desc: L.s.voiceFolderDesc,
						control: { type: 'text', key: 'voiceFolder', placeholder: DEFAULT_SETTINGS.voiceFolder, validate: nonEmpty },
					},
					{
						name: L.s.daily,
						desc: L.s.dailyDesc,
						control: { type: 'text', key: 'dailyNoteFormat', validate: (v) => (/\.md$/i.test(v.trim()) ? L.s.noMd : undefined) },
					},
					{
						name: L.s.templatesFolder,
						desc: L.s.templatesFolderDesc,
						control: { type: 'text', key: 'templatesFolder', placeholder: DEFAULT_SETTINGS.templatesFolder, validate: nonEmpty },
					},
				],
			},
		];
	}

	/** Password field checked live against OpenRouter, saved in Obsidian's secret storage when valid. */
	private renderKey(setting: Setting) {
		const status = setting.descEl.createDiv({ cls: 'mn-key-status' });
		const show = (state: 'ok' | 'error' | 'pending' | 'none', text: string) => {
			status.setText(text);
			status.dataset.state = state;
		};
		let run = 0;
		const verify = async (value: string, saveIfValid: boolean) => {
			const id = ++run;
			show('pending', L.s.checking);
			const res = await checkKey(value);
			if (id !== run) return; // a newer check superseded this one
			if (res.ok && saveIfValid) this.plugin.setApiKey(value);
			show(res.ok ? 'ok' : 'error', (res.ok ? '✓ ' : '✗ ') + res.message + (!res.ok && saveIfValid ? L.s.notSaved : ''));
		};
		let timer = 0;
		setting.addText((text) => {
			text.inputEl.type = 'password';
			text.setPlaceholder(this.plugin.apiKey() ? L.s.saved : 'sk-or-v1-…').onChange((v) => {
				window.clearTimeout(timer);
				const value = v.trim();
				if (!value) return;
				timer = window.setTimeout(() => void verify(value, true), 500);
			});
		});
		setting.addExtraButton((b) =>
			b
				.setIcon('refresh-cw')
				.setTooltip(L.s.verify)
				.onClick(() => {
					const stored = this.plugin.apiKey();
					if (stored) void verify(stored, false);
					else show('none', L.s.noKey);
				}),
		);
		const stored = this.plugin.apiKey();
		if (stored) void verify(stored, false);
		else show('none', L.s.noKeyPaste);
	}

	/** Device list is only known once the browser has listed the microphones. */
	private renderMic(setting: Setting) {
		const s = this.plugin.settings;
		setting.addDropdown((d) => {
			d.addOption('', L.s.micDefault);
			if (s.micDevice) d.addOption(s.micDevice, L.s.micChosen);
			d.setValue(s.micDevice).onChange(async (v) => {
				s.micDevice = v;
				await this.plugin.saveSettings();
			});
			void listMicrophones().then((devices) => {
				d.selectEl.empty();
				d.addOption('', L.s.micDefault);
				for (const dev of devices) {
					if (dev.deviceId && dev.deviceId !== 'default') d.addOption(dev.deviceId, dev.label || L.s.micUnnamed);
				}
				d.setValue(devices.some((x) => x.deviceId === s.micDevice) ? s.micDevice : '');
			});
		});
	}

	/** Templates are the notes of the templates folder, read when the row is shown. */
	private renderTemplate(setting: Setting) {
		const s = this.plugin.settings;
		setting.addDropdown((d) => {
			void this.plugin.templateNames().then((names) => {
				for (const n of names) d.addOption(n, n);
				d.setValue(names.includes(s.defaultTemplate) ? s.defaultTemplate : names[0]);
			});
			d.onChange(async (v) => {
				s.defaultTemplate = v;
				await this.plugin.saveSettings();
			});
		});
	}

	/** Turning the inbox on starts from today's memos and checks right away. */
	private renderVoiceMemos(setting: Setting) {
		const s = this.plugin.settings;
		setting.addToggle((t) =>
			t.setValue(s.voiceMemos).onChange(async (v) => {
				s.voiceMemos = v;
				// Today's memos count too: you often record first, then turn this on.
				if (v && !s.voiceMemosSince) s.voiceMemosSince = window.moment().startOf('day').toISOString();
				await this.plugin.saveSettings();
				if (v) void this.plugin.checkVoiceMemos(true);
			}),
		);
	}
}
