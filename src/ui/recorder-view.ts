/**
 * The recorder screen: one big button, made for the phone. Pick "voice note" (journal, into the
 * daily note) or "meeting" (in person, full meeting folder), record, pause, stop.
 */

import { ItemView, Platform, setIcon, type WorkspaceLeaf } from 'obsidian';
import { formatClock } from '../pipeline/merge';
import type { MeetingKind } from '../session';
import type MuesliPlugin from '../main';
import { t } from '../i18n';

export const RECORDER_VIEW = 'muesli-recorder';

export class RecorderView extends ItemView {
	private template = '';
	private templates: string[] = [];
	private built: 'idle' | 'live' | null = null;
	private els: {
		time?: HTMLElement;
		meter?: HTMLElement;
		toggle?: HTMLButtonElement;
		lost?: HTMLElement;
		status?: HTMLElement;
	} = {};

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: MuesliPlugin,
	) {
		super(leaf);
	}

	getViewType() {
		return RECORDER_VIEW;
	}

	getDisplayText() {
		return t.recorder;
	}

	getIcon() {
		return 'mic';
	}

	async onOpen() {
		this.contentEl.addClass('mn-recorder');
		this.templates = await this.plugin.templateNames();
		this.template = this.plugin.settings.lastTemplate || this.templates[0];
		this.refresh();
	}

	async onClose() {
		this.contentEl.empty();
	}

	private get kind(): MeetingKind {
		return this.plugin.settings.lastKind;
	}

	/** Called on every plugin tick; rebuilds only when switching between idle and live. */
	refresh() {
		const s = this.plugin.session;
		const want = s ? 'live' : 'idle';
		if (want !== this.built) {
			this.built = want;
			this.contentEl.empty();
			this.els = {};
			if (s) this.buildLive();
			else this.buildIdle();
		}
		if (s) {
			this.els.time?.setText(formatClock(s.elapsed));
			this.contentEl.toggleClass('is-paused', s.paused);
			const db = s.level('mic');
			this.els.meter?.setCssProps({ '--level': String(db == null || s.paused ? 0 : Math.max(0, Math.min(1, (db + 60) / 50))) });
			if (this.els.toggle) {
				setIcon(this.els.toggle, s.paused ? 'play' : 'pause');
				this.els.toggle.setAttribute('aria-label', s.paused ? t.resume : t.pause);
			}
			const lost = Math.round(s.lostSeconds);
			this.els.lost?.setText(lost >= 5 ? t.notRecorded(formatClock(lost)) : '');
		}
		const busy = this.plugin.processingLabel();
		this.els.status?.setText(busy ?? '');
	}

	private buildIdle() {
		const root = this.contentEl.createDiv({ cls: 'mn-rec-body' });

		const seg = root.createDiv({ cls: 'mn-rec-seg' });
		const choices: [MeetingKind, string, string][] = [
			['voice', 'mic', t.journal],
			['meeting', 'users', t.meeting],
		];
		for (const [kind, icon, label] of choices) {
			const b = seg.createEl('button', { cls: 'mn-rec-seg-btn' });
			setIcon(b.createSpan(), icon);
			b.createSpan({ text: label });
			b.toggleClass('is-active', this.kind === kind);
			b.addEventListener('click', () => {
				this.plugin.settings.lastKind = kind;
				void this.plugin.saveSettings();
				this.built = null;
				this.refresh();
			});
		}

		root.createDiv({
			cls: 'mn-rec-hint',
			text:
				this.kind === 'voice'
					? t.hintVoice
					: t.hintMeeting,
		});

		const big = root.createEl('button', { cls: 'mn-rec-big', attr: { 'aria-label': t.record } });
		big.createSpan({ cls: 'mn-rec-big-dot' });
		big.addEventListener('click', () => {
			big.disabled = true;
			void this.plugin
				.startFromRecorder(this.kind, { title: '', template: this.template })
				.finally(() => (big.disabled = false));
		});
		root.createDiv({ cls: 'mn-rec-label', text: t.record });

		this.els.status = root.createDiv({ cls: 'mn-rec-status' });
		if (Platform.isMobile) {
			root.createDiv({
				cls: 'mn-rec-note',
				text: t.keepOpen,
			});
		}
	}

	private buildLive() {
		const s = this.plugin.session!;
		const root = this.contentEl.createDiv({ cls: 'mn-rec-body is-live' });
		root.createDiv({ cls: 'mn-rec-kind', text: s.state.kind === 'voice' ? t.journal : t.meeting });
		this.els.time = root.createDiv({ cls: 'mn-rec-time' });
		const meter = root.createDiv({ cls: 'mn-rec-meter' });
		this.els.meter = meter.createDiv({ cls: 'mn-rec-meter-fill' });

		const row = root.createDiv({ cls: 'mn-rec-controls' });
		this.els.toggle = row.createEl('button', { cls: 'mn-rec-ctl' });
		this.els.toggle.addEventListener('click', () => {
			const cur = this.plugin.session;
			cur?.setPaused(!cur.paused);
			this.refresh();
		});
		const stop = row.createEl('button', { cls: 'mn-rec-ctl mod-stop', attr: { 'aria-label': t.end } });
		setIcon(stop, 'square');
		stop.addEventListener('click', () => void this.plugin.stopMeeting());

		this.els.lost = root.createDiv({ cls: 'mn-rec-lost' });
		this.els.status = root.createDiv({ cls: 'mn-rec-status' });
	}
}
