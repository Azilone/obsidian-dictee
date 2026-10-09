import { App, Modal, Setting } from 'obsidian';
import { LANGUAGES, type MeetingMode } from '../settings';
import type { Utterance } from '../pipeline/merge';
import { samples, type Person } from '../pipeline/speakers';

export interface StartOptions {
	title: string;
	language: string;
	mode: MeetingMode;
	template: string;
}

export class StartMeetingModal extends Modal {
	private opts: StartOptions;
	private done = false;

	constructor(
		app: App,
		defaults: StartOptions,
		private templates: string[],
		private onSubmit: (o: StartOptions) => void,
	) {
		super(app);
		this.opts = { ...defaults };
	}

	onOpen() {
		const { contentEl } = this;
		this.setTitle('Nouvelle réunion');
		this.modalEl.addClass('mn-start-modal');

		new Setting(contentEl).setName('Titre').addText((t) => {
			t.setPlaceholder('Réunion').setValue(this.opts.title).onChange((v) => (this.opts.title = v));
			t.inputEl.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' && !e.isComposing) {
					e.preventDefault();
					this.submit();
				}
			});
			window.setTimeout(() => t.inputEl.select(), 0);
		});

		new Setting(contentEl).setName('Type').addDropdown((d) =>
			d
				.addOptions({ call: 'Visio / appel', room: 'Présentiel' })
				.setValue(this.opts.mode)
				.onChange((v) => (this.opts.mode = v as MeetingMode)),
		);

		new Setting(contentEl).setName('Langue').addDropdown((d) =>
			d
				.addOptions(LANGUAGES)
				.setValue(this.opts.language)
				.onChange((v) => (this.opts.language = v)),
		);

		new Setting(contentEl).setName('Modèle de résumé').addDropdown((d) => {
			for (const t of this.templates) d.addOption(t, t);
			d.setValue(this.templates.includes(this.opts.template) ? this.opts.template : this.templates[0]);
			this.opts.template = d.getValue();
			d.onChange((v) => (this.opts.template = v));
		});

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText('Démarrer l’enregistrement')
				.setCta()
				.onClick(() => this.submit()),
		);
	}

	private submit() {
		if (this.done) return;
		this.done = true;
		this.opts.title = this.opts.title.trim() || 'Réunion';
		this.close();
		this.onSubmit(this.opts);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Shows each detected voice with a couple of quotes so the user can name it. */
export class SpeakerNamesModal extends Modal {
	private resolved = false;
	private people: Person[];

	constructor(
		app: App,
		people: Person[],
		private utts: Utterance[],
		private resolve: (p: Person[]) => void,
	) {
		super(app);
		this.people = people.map((p) => ({ ...p }));
	}

	onOpen() {
		const { contentEl } = this;
		this.setTitle('Qui parle ?');
		this.modalEl.addClass('mn-speaker-modal');
		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'Vérifie ou complète les noms des intervenants. Laisser vide garde « Intervenant N ».',
		});
		let n = 0;
		for (const person of this.people) {
			const fallback = `Intervenant ${person.name ? n : ++n}`;
			const setting = new Setting(contentEl).setName(person.name || fallback).addText((t) =>
				t
					.setPlaceholder(fallback)
					.setValue(person.name)
					.onChange((v) => (person.name = v.trim())),
			);
			const quotes = setting.descEl.createDiv({ cls: 'mn-quotes' });
			for (const q of samples(person, this.utts)) quotes.createDiv({ cls: 'mn-quote', text: `« ${q} »` });
			if (person.evidence && person.name) quotes.createDiv({ cls: 'mn-evidence', text: person.evidence });
		}
		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText('Continuer')
				.setCta()
				.onClick(() => this.close()),
		);
		this.scope.register([], 'Enter', () => {
			this.close();
			return false;
		});
	}

	onClose() {
		this.contentEl.empty();
		if (!this.resolved) {
			this.resolved = true;
			this.resolve(this.people);
		}
	}
}
