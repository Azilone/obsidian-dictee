import { App, Modal, Setting } from 'obsidian';
import type { Moment } from 'moment';
import { LANGUAGES, type MeetingMode } from '../settings';
import type { Utterance } from '../pipeline/merge';
import { samples, type Person } from '../pipeline/speakers';
import type { MeetingKind } from '../session';
import { t } from '../i18n';

export interface StartOptions {
	title: string;
	language: string;
	mode: MeetingMode;
	template: string;
	autoTitle?: boolean;
}

/** The only question before recording: a meeting, or a journal entry for the daily note. */
export class StartChoiceModal extends Modal {
	constructor(
		app: App,
		private onPick: (kind: MeetingKind) => void,
	) {
		super(app);
	}

	onOpen() {
		this.setTitle(t.record);
		this.modalEl.addClass('mn-start-modal');
		const row = this.contentEl.createDiv({ cls: 'mn-start-choices' });
		const pick = (kind: MeetingKind) => {
			this.close();
			this.onPick(kind);
		};
		const meeting = row.createEl('button', { cls: 'mod-cta mn-start-btn' });
		meeting.createSpan({ cls: 'mn-start-icon', text: '🎙️' });
		meeting.createSpan({ text: t.meeting });
		meeting.addEventListener('click', () => pick('meeting'));
		const journal = row.createEl('button', { cls: 'mn-start-btn' });
		journal.createSpan({ cls: 'mn-start-icon', text: '📓' });
		journal.createSpan({ text: t.journal });
		journal.addEventListener('click', () => pick('voice'));
		window.setTimeout(() => meeting.focus(), 0);
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
		this.setTitle(t.whoSpeaks);
		this.modalEl.addClass('mn-speaker-modal');
		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: t.whoSpeaksDesc,
		});
		let n = 0;
		for (const person of this.people) {
			const fallback = t.speaker(person.name ? n : ++n);
			const setting = new Setting(contentEl).setName(person.name || fallback).addText((t) =>
				t
					.setPlaceholder(fallback)
					.setValue(person.name)
					.onChange((v) => (person.name = v.trim())),
			);
			const quotes = setting.descEl.createDiv({ cls: 'mn-quotes' });
			for (const q of samples(person, this.utts)) quotes.createDiv({ cls: 'mn-quote', text: `“${q}”` });
			if (person.evidence && person.name) quotes.createDiv({ cls: 'mn-evidence', text: person.evidence });
		}
		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText(t.continue)
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

export interface ImportOptions {
	/** `auto`: decided from the transcript (Voice Memos inbox only). */
	kind: MeetingKind | 'auto';
	title: string;
	/** ISO date-time of the meeting start. */
	startedAt: string;
	language: string;
	template: string;
}

/** Options for a meeting built from an existing audio file. */
export class ImportMeetingModal extends Modal {
	private opts: ImportOptions;
	private done = false;

	constructor(
		app: App,
		private fileName: string,
		defaults: ImportOptions,
		private templates: string[],
		private onSubmit: (o: ImportOptions | null) => void,
	) {
		super(app);
		this.opts = { ...defaults };
	}

	onOpen() {
		const { contentEl } = this;
		this.setTitle(t.importTitle);
		this.modalEl.addClass('mn-start-modal');
		contentEl.createEl('p', { cls: 'setting-item-description', text: this.fileName });

		let templateRow: Setting | null = null;
		new Setting(contentEl).setName(t.type).addDropdown((d) =>
			d
				.addOptions({ voice: t.voiceNoteToDaily, meeting: t.meeting })
				.setValue(this.opts.kind)
				.onChange((v) => {
					this.opts.kind = v as MeetingKind;
					templateRow?.settingEl.toggle(this.opts.kind === 'meeting');
				}),
		);

		new Setting(contentEl).setName(t.title).addText((text) => {
			text.setValue(this.opts.title).onChange((v) => (this.opts.title = v));
			text.inputEl.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' && !e.isComposing) {
					e.preventDefault();
					this.submit();
				}
			});
			window.setTimeout(() => text.inputEl.select(), 0);
		});

		new Setting(contentEl)
			.setName(t.dateTime)
			.setDesc(t.dateTimeDesc)
			.addText((text) => {
				text.inputEl.type = 'datetime-local';
				text.setValue(window.moment(this.opts.startedAt).format('YYYY-MM-DDTHH:mm')).onChange((v) => {
					const m: Moment = window.moment(v);
					if (m.isValid()) this.opts.startedAt = m.toISOString();
				});
			});

		new Setting(contentEl).setName(t.language).addDropdown((d) =>
			d
				.addOptions(LANGUAGES)
				.setValue(this.opts.language)
				.onChange((v) => (this.opts.language = v)),
		);

		templateRow = new Setting(contentEl).setName(t.summaryTemplate).addDropdown((d) => {
			for (const name of this.templates) d.addOption(name, name);
			d.setValue(this.templates.includes(this.opts.template) ? this.opts.template : this.templates[0]);
			this.opts.template = d.getValue();
			d.onChange((v) => (this.opts.template = v));
		});
		templateRow.settingEl.toggle(this.opts.kind === 'meeting');

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText(t.processRecording)
				.setCta()
				.onClick(() => this.submit()),
		);
	}

	private submit() {
		if (this.done) return;
		this.done = true;
		this.opts.title = this.opts.title.trim() || (this.opts.kind === 'voice' ? t.voiceNote : t.meeting);
		this.close();
		this.onSubmit(this.opts);
	}

	onClose() {
		this.contentEl.empty();
		if (!this.done) {
			this.done = true;
			this.onSubmit(null);
		}
	}
}
