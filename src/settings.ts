import { App, Platform, PluginSettingTab, Setting } from 'obsidian';
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

export class MeetingSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: MuesliPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		containerEl.empty();

		new Setting(containerEl)
			.setName(L.ob.settingName)
			.setDesc(L.ob.settingDesc)
			.addButton((b) => b.setButtonText(L.ob.open).onClick(() => this.plugin.openOnboarding()));

		const key = new Setting(containerEl)
			.setName(L.s.apiKey)
			.setDesc(L.s.apiKeyDesc);
		const status = key.descEl.createDiv({ cls: 'mn-key-status' });
		const showStatus = (state: 'ok' | 'error' | 'pending' | 'none', text: string) => {
			status.setText(text);
			status.dataset.state = state;
		};
		let run = 0;
		const verify = async (value: string, saveIfValid: boolean) => {
			const id = ++run;
			showStatus('pending', L.s.checking);
			const res = await checkKey(value);
			if (id !== run) return; // a newer check superseded this one
			if (res.ok && saveIfValid) this.plugin.setApiKey(value);
			showStatus(res.ok ? 'ok' : 'error', (res.ok ? '✓ ' : '✗ ') + res.message + (!res.ok && saveIfValid ? L.s.notSaved : ''));
		};
		let timer = 0;
		key.addText((t) => {
			t.inputEl.type = 'password';
			t.setPlaceholder(this.plugin.apiKey() ? L.s.saved : 'sk-or-v1-…').onChange((v) => {
				window.clearTimeout(timer);
				const value = v.trim();
				if (!value) return;
				timer = window.setTimeout(() => void verify(value, true), 500);
			});
		});
		key.addExtraButton((b) =>
			b
				.setIcon('refresh-cw')
				.setTooltip(L.s.verify)
				.onClick(() => {
					const stored = this.plugin.apiKey();
					if (stored) void verify(stored, false);
					else showStatus('none', L.s.noKey);
				}),
		);
		const stored = this.plugin.apiKey();
		if (stored) void verify(stored, false);
		else showStatus('none', L.s.noKeyPaste);

		new Setting(containerEl).setName(L.s.yourName).setDesc(L.s.yourNameDesc).addText((t) =>
			t.setValue(s.myName).onChange(async (v) => {
				s.myName = v.trim() || L.me;
				await save();
			}),
		);

		new Setting(containerEl).setName(L.s.recording).setHeading();

		new Setting(containerEl).setName(L.s.mic).addDropdown((d) => {
			d.addOption('', L.s.micDefault);
			if (s.micDevice) d.addOption(s.micDevice, L.s.micChosen);
			d.setValue(s.micDevice).onChange(async (v) => {
				s.micDevice = v;
				await save();
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

		new Setting(containerEl)
			.setName(L.s.mode)
			.setDesc(L.s.modeDesc)
			.addDropdown((d) =>
				d
					.addOptions({ call: L.s.modeCall, room: L.s.modeRoom })
					.setValue(s.defaultMode)
					.onChange(async (v) => {
						s.defaultMode = v as 'call' | 'room';
						await save();
					}),
			);

		new Setting(containerEl)
			.setName(L.s.template)
			.setDesc(L.s.templateDesc)
			.addDropdown((d) => {
				void this.plugin.templateNames().then((names) => {
					for (const n of names) d.addOption(n, n);
					d.setValue(names.includes(s.defaultTemplate) ? s.defaultTemplate : names[0]);
				});
				d.onChange(async (v) => {
					s.defaultTemplate = v;
					await save();
				});
			});

		new Setting(containerEl)
			.setName(L.s.keepAudio)
			.setDesc(L.s.keepAudioDesc)
			.addToggle((t) =>
				t.setValue(s.keepAudio).onChange(async (v) => {
					s.keepAudio = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName(L.s.chunk)
			.setDesc(L.s.chunkDesc)
			.addSlider((sl) =>
				sl
					.setLimits(2, 12, 1)
					.setValue(s.chunkMinutes)
					.onChange(async (v) => {
						s.chunkMinutes = v;
						await save();
					}),
			);

		if (Platform.isDesktopApp && Platform.isMacOS) {
			new Setting(containerEl).setName(L.s.memos).setHeading();
			new Setting(containerEl)
				.setName(L.s.memosToggle)
				.setDesc(L.s.memosDesc)
				.addToggle((t) =>
					t.setValue(s.voiceMemos).onChange(async (v) => {
						s.voiceMemos = v;
						// Today's memos count too: you often record first, then turn this on.
						if (v && !s.voiceMemosSince) s.voiceMemosSince = window.moment().startOf('day').toISOString();
						await save();
						if (v) void this.plugin.checkVoiceMemos(true);
					}),
				);
		}

		new Setting(containerEl).setName(L.s.overlay).setHeading();

		new Setting(containerEl)
			.setName(L.s.overlayToggle)
			.setDesc(L.s.overlayDesc)
			.addToggle((t) =>
				t.setValue(s.overlay).onChange(async (v) => {
					s.overlay = v;
					await save();
				}),
			);
		new Setting(containerEl)
			.setName(L.s.overlayHidden)
			.setDesc(L.s.overlayHiddenDesc)
			.addToggle((t) =>
				t.setValue(s.overlayHidden).onChange(async (v) => {
					s.overlayHidden = v;
					await save();
				}),
			);

		new Setting(containerEl).setName(L.s.guards).setHeading();

		const minutes = (name: string, desc: string, key: 'idleMinutes' | 'idleGraceMinutes' | 'maxMinutes', fallback: number) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((t) => {
					t.inputEl.type = 'number';
					t.inputEl.min = '0';
					t.setValue(String(s[key])).onChange(async (v) => {
						const n = Number(v);
						s[key] = Number.isFinite(n) && n >= 0 ? n : fallback;
						await save();
					});
				});
		minutes(L.s.idle, L.s.idleDesc, 'idleMinutes', DEFAULT_SETTINGS.idleMinutes);
		minutes(L.s.grace, L.s.graceDesc, 'idleGraceMinutes', DEFAULT_SETTINGS.idleGraceMinutes);
		minutes(L.s.max, L.s.maxDesc, 'maxMinutes', DEFAULT_SETTINGS.maxMinutes);
		new Setting(containerEl)
			.setName(L.s.price)
			.setDesc(L.s.priceDesc)
			.addText((t) => {
				t.inputEl.type = 'number';
				t.inputEl.step = '0.0001';
				t.setValue(String(s.sttPricePerMinute)).onChange(async (v) => {
					const n = Number(v);
					s.sttPricePerMinute = Number.isFinite(n) && n >= 0 ? n : DEFAULT_SETTINGS.sttPricePerMinute;
					await save();
				});
			});

		new Setting(containerEl).setName(L.s.ai).setHeading();

		new Setting(containerEl)
			.setName(L.s.lang)
			.setDesc(L.s.langDesc)
			.addDropdown((d) =>
				d
					.addOptions(LANGUAGES)
					.setValue(s.language)
					.onChange(async (v) => {
						s.language = v;
						await save();
					}),
			);

		new Setting(containerEl).setName(L.s.summaryLang).addText((t) =>
			t.setValue(s.summaryLanguage).onChange(async (v) => {
				s.summaryLanguage = v.trim() || DEFAULT_SETTINGS.summaryLanguage;
				await save();
			}),
		);

		new Setting(containerEl).setName(L.s.askNames).addToggle((t) =>
			t.setValue(s.askSpeakerNames).onChange(async (v) => {
				s.askSpeakerNames = v;
				await save();
			}),
		);

		new Setting(containerEl).setName(L.s.sttModel).addText((t) =>
			t.setValue(s.sttModel).onChange(async (v) => {
				s.sttModel = v.trim() || DEFAULT_SETTINGS.sttModel;
				await save();
			}),
		);
		new Setting(containerEl).setName(L.s.llmModel).addText((t) =>
			t.setValue(s.llmModel).onChange(async (v) => {
				s.llmModel = v.trim() || DEFAULT_SETTINGS.llmModel;
				await save();
			}),
		);

		new Setting(containerEl).setName(L.s.folders).setHeading();

		new Setting(containerEl).setName(L.s.rootFolder).addText((t) =>
			t.setValue(s.rootFolder).onChange(async (v) => {
				s.rootFolder = v.trim().replace(/\/+$/, '') || DEFAULT_SETTINGS.rootFolder;
				await save();
			}),
		);
		new Setting(containerEl)
			.setName(L.s.importFolder)
			.setDesc(L.s.importFolderDesc)
			.addText((t) =>
				t.setValue(s.importFolder).onChange(async (v) => {
					s.importFolder = v.trim().replace(/\/+$/, '');
					await save();
				}),
			);
		new Setting(containerEl)
			.setName(L.s.voiceFolder)
			.setDesc(L.s.voiceFolderDesc)
			.addText((t) =>
				t.setValue(s.voiceFolder).onChange(async (v) => {
					s.voiceFolder = v.trim().replace(/\/+$/, '') || DEFAULT_SETTINGS.voiceFolder;
					await save();
				}),
			);
		new Setting(containerEl)
			.setName(L.s.daily)
			.setDesc(L.s.dailyDesc)
			.addText((t) =>
				t.setValue(s.dailyNoteFormat).onChange(async (v) => {
					s.dailyNoteFormat = v.trim().replace(/\.md$/, '');
					await save();
				}),
			);
		new Setting(containerEl)
			.setName(L.s.templatesFolder)
			.setDesc(L.s.templatesFolderDesc)
			.addText((t) =>
				t.setValue(s.templatesFolder).onChange(async (v) => {
					s.templatesFolder = v.trim().replace(/\/+$/, '');
					await save();
				}),
			);
	}
}
