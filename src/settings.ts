import { App, Platform, PluginSettingTab, Setting } from 'obsidian';
import type DicteePlugin from './main';
import { checkKey } from './openrouter';
import { listMicrophones } from './recorder/sources';
import { VOICE_MEMOS_DIR } from './recorder/voice-memos';

export const LANGUAGES: Record<string, string> = {
	'': 'Détection automatique',
	fr: 'Français',
	en: 'Anglais',
	es: 'Espagnol',
	de: 'Allemand',
	it: 'Italien',
	pt: 'Portugais',
	nl: 'Néerlandais',
};

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
	/** A memo at least this long (min) is a meeting, shorter ones go to the journal (0 = never by length). */
	meetingMinMinutes: number;
}

export const DEFAULT_SETTINGS: MeetingSettings = {
	sttModel: 'microsoft/mai-transcribe-2',
	llmModel: 'anthropic/claude-haiku-5.5',
	rootFolder: 'Réunions',
	templatesFolder: 'Réunions/Modèles',
	language: '',
	summaryLanguage: 'français',
	myName: 'Moi',
	micDevice: '',
	defaultMode: 'call',
	keepAudio: true,
	askSpeakerNames: true,
	chunkMinutes: 8,
	lastTemplate: '',
	defaultTemplate: 'Général',
	overlay: true,
	overlayHidden: true,
	overlayPos: null,
	idleMinutes: 10,
	idleGraceMinutes: 5,
	maxMinutes: 180,
	sttPricePerMinute: 0.0017,
	importFolder: 'Réunions/À importer',
	voiceFolder: 'JOURNAL/Notes vocales',
	dailyNoteFormat: '[JOURNAL]/YYYY/[Journalier]/YYYY.MM.DD',
	lastKind: 'voice',
	voiceMemos: false,
	voiceMemosDir: VOICE_MEMOS_DIR,
	voiceMemosSince: '',
	voiceMemosSeen: [],
	meetingMinMinutes: 15,
};

export class MeetingSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: DicteePlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const save = () => this.plugin.saveSettings();
		containerEl.empty();

		const key = new Setting(containerEl)
			.setName('Clé API OpenRouter')
			.setDesc('Stockée dans le trousseau d’Obsidian, jamais dans le coffre.');
		const status = key.descEl.createDiv({ cls: 'mn-key-status' });
		const showStatus = (state: 'ok' | 'error' | 'pending' | 'none', text: string) => {
			status.setText(text);
			status.dataset.state = state;
		};
		let run = 0;
		const verify = async (value: string, saveIfValid: boolean) => {
			const id = ++run;
			showStatus('pending', 'Vérification de la clé…');
			const res = await checkKey(value);
			if (id !== run) return; // a newer check superseded this one
			if (res.ok && saveIfValid) this.plugin.setApiKey(value);
			showStatus(res.ok ? 'ok' : 'error', (res.ok ? '✓ ' : '✗ ') + res.message + (!res.ok && saveIfValid ? ' Clé non enregistrée.' : ''));
		};
		let timer = 0;
		key.addText((t) => {
			t.inputEl.type = 'password';
			t.setPlaceholder(this.plugin.apiKey() ? '•••••••••••• (enregistrée)' : 'sk-or-v1-…').onChange((v) => {
				window.clearTimeout(timer);
				const value = v.trim();
				if (!value) return;
				timer = window.setTimeout(() => void verify(value, true), 500);
			});
		});
		key.addExtraButton((b) =>
			b
				.setIcon('refresh-cw')
				.setTooltip('Vérifier la clé enregistrée')
				.onClick(() => {
					const stored = this.plugin.apiKey();
					if (stored) void verify(stored, false);
					else showStatus('none', 'Aucune clé enregistrée.');
				}),
		);
		const stored = this.plugin.apiKey();
		if (stored) void verify(stored, false);
		else showStatus('none', 'Aucune clé enregistrée — colle ta clé sk-or-….');

		new Setting(containerEl).setName('Ton nom').setDesc('Utilisé pour ta voix (micro) dans le transcript.').addText((t) =>
			t.setValue(s.myName).onChange(async (v) => {
				s.myName = v.trim() || 'Moi';
				await save();
			}),
		);

		new Setting(containerEl).setName('Enregistrement').setHeading();

		new Setting(containerEl).setName('Micro').addDropdown((d) => {
			d.addOption('', 'Micro par défaut du système');
			if (s.micDevice) d.addOption(s.micDevice, 'Micro choisi');
			d.setValue(s.micDevice).onChange(async (v) => {
				s.micDevice = v;
				await save();
			});
			void listMicrophones().then((devices) => {
				d.selectEl.empty();
				d.addOption('', 'Micro par défaut du système');
				for (const dev of devices) {
					if (dev.deviceId && dev.deviceId !== 'default') d.addOption(dev.deviceId, dev.label || 'Micro sans nom');
				}
				d.setValue(devices.some((x) => x.deviceId === s.micDevice) ? s.micDevice : '');
			});
		});

		new Setting(containerEl)
			.setName('Type de réunion par défaut')
			.setDesc('Visio : ton micro + le son de l’ordinateur (les autres). Présentiel : seulement le micro, toutes les voix sont séparées.')
			.addDropdown((d) =>
				d
					.addOptions({ call: 'Visio / appel', room: 'Présentiel' })
					.setValue(s.defaultMode)
					.onChange(async (v) => {
						s.defaultMode = v as 'call' | 'room';
						await save();
					}),
			);

		new Setting(containerEl)
			.setName('Modèle de résumé par défaut')
			.setDesc('Utilisé à chaque nouvelle réunion. Les modèles sont les notes du dossier des modèles.')
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
			.setName('Garder l’audio')
			.setDesc('Enregistre audio.mp3 dans le dossier de la réunion.')
			.addToggle((t) =>
				t.setValue(s.keepAudio).onChange(async (v) => {
					s.keepAudio = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName('Durée des segments (min)')
			.setDesc('Les segments sont transcrits pendant la réunion, coupés dans un silence. Max 12 (limite de la diarisation).')
			.addSlider((sl) =>
				sl
					.setLimits(2, 12, 1)
					.setDynamicTooltip()
					.setValue(s.chunkMinutes)
					.onChange(async (v) => {
						s.chunkMinutes = v;
						await save();
					}),
			);

		if (Platform.isDesktopApp && Platform.isMacOS) {
			new Setting(containerEl).setName('Mémos Dictaphone (iPhone)').setHeading();
			new Setting(containerEl)
				.setName('Traiter les nouveaux mémos automatiquement')
				.setDesc(
					'Enregistre avec Dictaphone sur l’iPhone (écran verrouillé, pause…) : chaque nouveau mémo synchronisé par iCloud est transcrit, reconnu comme réunion ou journal d’après ce qui est dit, et rangé, toutes les 2 minutes tant qu’Obsidian est ouvert. Seuls les mémos à partir du jour de l’activation sont pris, pas l’historique. Obsidian a besoin de l’accès complet au disque.',
				)
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

		new Setting(containerEl).setName('Overlay').setHeading();

		new Setting(containerEl)
			.setName('Overlay flottant')
			.setDesc('Une petite pilule toujours visible, au-dessus de toutes les applications, pendant l’enregistrement.')
			.addToggle((t) =>
				t.setValue(s.overlay).onChange(async (v) => {
					s.overlay = v;
					await save();
				}),
			);
		new Setting(containerEl)
			.setName('Invisible dans les partages d’écran')
			.setDesc('L’overlay n’apparaît ni dans Zoom/Meet/Teams ni dans les captures d’écran.')
			.addToggle((t) =>
				t.setValue(s.overlayHidden).onChange(async (v) => {
					s.overlayHidden = v;
					await save();
				}),
			);

		new Setting(containerEl).setName('Garde-fous').setHeading();

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
		minutes(
			'Demander après N minutes sans parole',
			'Personne ne parle depuis ce temps : l’overlay demande si la réunion continue. 0 = jamais.',
			'idleMinutes',
			DEFAULT_SETTINGS.idleMinutes,
		);
		minutes(
			'Arrêt automatique après N minutes sans réponse',
			'Sans réponse à la question, l’enregistrement se termine tout seul et le compte rendu est généré.',
			'idleGraceMinutes',
			DEFAULT_SETTINGS.idleGraceMinutes,
		);
		minutes('Durée maximale (min)', 'L’enregistrement s’arrête de lui-même au-delà. 0 = sans limite.', 'maxMinutes', DEFAULT_SETTINGS.maxMinutes);
		new Setting(containerEl)
			.setName('Prix de la transcription ($ / min envoyée)')
			.setDesc('Sert à l’estimation affichée pendant la réunion. Le coût réel est affiché à la fin.')
			.addText((t) => {
				t.inputEl.type = 'number';
				t.inputEl.step = '0.0001';
				t.setValue(String(s.sttPricePerMinute)).onChange(async (v) => {
					const n = Number(v);
					s.sttPricePerMinute = Number.isFinite(n) && n >= 0 ? n : DEFAULT_SETTINGS.sttPricePerMinute;
					await save();
				});
			});

		new Setting(containerEl).setName('Transcription et résumé').setHeading();

		new Setting(containerEl)
			.setName('Langue par défaut')
			.setDesc('Détection automatique par défaut.')
			.addDropdown((d) =>
				d
					.addOptions(LANGUAGES)
					.setValue(s.language)
					.onChange(async (v) => {
						s.language = v;
						await save();
					}),
			);

		new Setting(containerEl).setName('Langue du résumé').addText((t) =>
			t.setValue(s.summaryLanguage).onChange(async (v) => {
				s.summaryLanguage = v.trim() || 'français';
				await save();
			}),
		);

		new Setting(containerEl).setName('Demander les noms des intervenants').addToggle((t) =>
			t.setValue(s.askSpeakerNames).onChange(async (v) => {
				s.askSpeakerNames = v;
				await save();
			}),
		);

		new Setting(containerEl).setName('Modèle de transcription').addText((t) =>
			t.setValue(s.sttModel).onChange(async (v) => {
				s.sttModel = v.trim() || DEFAULT_SETTINGS.sttModel;
				await save();
			}),
		);
		new Setting(containerEl).setName('Modèle de langage').addText((t) =>
			t.setValue(s.llmModel).onChange(async (v) => {
				s.llmModel = v.trim() || DEFAULT_SETTINGS.llmModel;
				await save();
			}),
		);

		new Setting(containerEl).setName('Dossiers').setHeading();

		new Setting(containerEl).setName('Dossier des réunions').addText((t) =>
			t.setValue(s.rootFolder).onChange(async (v) => {
				s.rootFolder = v.trim().replace(/\/+$/, '') || 'Réunions';
				await save();
			}),
		);
		new Setting(containerEl)
			.setName('Dossier d’import')
			.setDesc('Un fichier audio déposé ici (AirDrop, iCloud…) est proposé à l’import automatiquement.')
			.addText((t) =>
				t.setValue(s.importFolder).onChange(async (v) => {
					s.importFolder = v.trim().replace(/\/+$/, '');
					await save();
				}),
			);
		new Setting(containerEl)
			.setName('Dossier des notes vocales')
			.setDesc('Audio et transcript de chaque note vocale. Le résumé va dans la note du jour.')
			.addText((t) =>
				t.setValue(s.voiceFolder).onChange(async (v) => {
					s.voiceFolder = v.trim().replace(/\/+$/, '') || DEFAULT_SETTINGS.voiceFolder;
					await save();
				}),
			);
		new Setting(containerEl)
			.setName('Note du jour')
			.setDesc('Vide : réglages du plugin « Notes quotidiennes ». Sinon un chemin au format Moment, ex. [JOURNAL]/YYYY/[Journalier]/YYYY.MM.DD')
			.addText((t) =>
				t.setValue(s.dailyNoteFormat).onChange(async (v) => {
					s.dailyNoteFormat = v.trim().replace(/\.md$/, '');
					await save();
				}),
			);
		new Setting(containerEl)
			.setName('Dossier des modèles de résumé')
			.setDesc('Chaque note Markdown est un modèle : son contenu décrit le résumé voulu.')
			.addText((t) =>
				t.setValue(s.templatesFolder).onChange(async (v) => {
					s.templatesFolder = v.trim().replace(/\/+$/, '');
					await save();
				}),
			);
	}
}
