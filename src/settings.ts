import { App, PluginSettingTab, Setting } from 'obsidian';
import type MeetingNotesPlugin from './main';
import { checkKey } from './openrouter';
import { listMicrophones } from './recorder/sources';

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
};

export class MeetingSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: MeetingNotesPlugin,
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

		new Setting(containerEl).setName('Transcription et résumé').setHeading();

		new Setting(containerEl)
			.setName('Langue par défaut')
			.setDesc('Modifiable au démarrage de chaque réunion.')
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
