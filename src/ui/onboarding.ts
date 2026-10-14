/**
 * First-run setup: the OpenRouter key (with where to get one and what it costs), the user's name,
 * and on a Mac a short sound test. The test installs the audio helper and triggers the macOS
 * permission prompt now, rather than at the start of the first real call.
 */

import { Modal, Platform, Setting, type App } from 'obsidian';
import { t } from '../i18n';
import { checkKey } from '../openrouter';
import { MicSource, SystemSource, type AudioSource } from '../recorder/sources';
import type MuesliPlugin from '../main';

const TEST_SECONDS = 6;

export class OnboardingModal extends Modal {
	private sources: AudioSource[] = [];
	private timer = 0;

	constructor(
		app: App,
		private plugin: MuesliPlugin,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		this.setTitle(t.ob.title);
		this.modalEl.addClass('mn-onboarding');
		contentEl.createEl('p', { cls: 'setting-item-description', text: t.ob.intro });

		// 1. OpenRouter key
		this.step(1, t.ob.keyTitle, t.ob.keyDesc);
		const key = new Setting(contentEl).setName(t.s.apiKey);
		const status = key.descEl.createDiv({ cls: 'mn-key-status' });
		const show = (state: 'ok' | 'error' | 'pending' | 'none', text: string) => {
			status.setText(text);
			status.dataset.state = state;
		};
		key.addButton((b) => b.setButtonText(t.ob.getKey).onClick(() => window.open('https://openrouter.ai/keys')));
		let timer = 0;
		let run = 0;
		key.addText((text) => {
			text.inputEl.type = 'password';
			text.setPlaceholder(this.plugin.apiKey() ? t.s.saved : 'sk-or-v1-…').onChange((v) => {
				window.clearTimeout(timer);
				const value = v.trim();
				if (!value) return;
				timer = window.setTimeout(() => {
					const id = ++run;
					show('pending', t.s.checking);
					void checkKey(value).then((res) => {
						if (id !== run) return;
						if (res.ok) this.plugin.setApiKey(value);
						show(res.ok ? 'ok' : 'error', (res.ok ? '✓ ' : '✗ ') + res.message + (res.ok ? '' : t.s.notSaved));
					});
				}, 500);
			});
		});
		const stored = this.plugin.apiKey();
		if (stored) void checkKey(stored).then((res) => show(res.ok ? 'ok' : 'error', (res.ok ? '✓ ' : '✗ ') + res.message));

		// 2. Name
		this.step(2, t.ob.nameTitle, t.s.yourNameDesc);
		new Setting(contentEl).setName(t.s.yourName).addText((text) =>
			text.setValue(this.plugin.settings.myName).onChange(async (v) => {
				this.plugin.settings.myName = v.trim() || t.me;
				await this.plugin.saveSettings();
			}),
		);

		// 3. Sound test (Mac: microphone + computer audio)
		if (Platform.isDesktopApp && Platform.isMacOS) {
			this.step(3, t.ob.testTitle, t.ob.testDesc);
			const box = contentEl.createDiv({ cls: 'mn-ob-test' });
			const mic = this.meter(box, t.microphone);
			const sys = this.meter(box, t.computerAudio);
			const result = box.createDiv({ cls: 'mn-ob-result' });
			new Setting(contentEl).addButton((b) =>
				b.setButtonText(t.ob.test).onClick(() => {
					b.setDisabled(true);
					void this.soundTest(mic, sys, result).finally(() => b.setDisabled(false).setButtonText(t.ob.testAgain));
				}),
			);
		}

		contentEl.createEl('p', { cls: 'setting-item-description', text: t.ob.outro });
		new Setting(contentEl).addButton((b) => b.setButtonText(t.ob.done).setCta().onClick(() => this.close()));
	}

	private step(n: number, title: string, desc: string) {
		const h = this.contentEl.createDiv({ cls: 'mn-ob-step' });
		h.createSpan({ cls: 'mn-ob-num', text: String(n) });
		h.createSpan({ cls: 'mn-ob-title', text: title });
		this.contentEl.createEl('p', { cls: 'setting-item-description', text: desc });
	}

	private meter(parent: HTMLElement, label: string) {
		const row = parent.createDiv({ cls: 'mn-ob-meter' });
		row.createSpan({ cls: 'mn-ob-label', text: label });
		const bar = row.createDiv({ cls: 'mn-ob-bar' });
		const fill = bar.createDiv({ cls: 'mn-ob-fill' });
		const mark = row.createSpan({ cls: 'mn-ob-mark' });
		return { fill, mark, peak: -120 };
	}

	/** Record a few seconds from both sources, showing live levels, then say what was heard. */
	private async soundTest(
		mic: ReturnType<OnboardingModal['meter']>,
		sys: ReturnType<OnboardingModal['meter']>,
		result: HTMLElement,
	) {
		this.stopSources();
		for (const m of [mic, sys]) {
			m.peak = -120;
			m.mark.setText('');
		}
		const feed = (m: typeof mic) => (pcm: Int16Array) => {
			let sum = 0;
			for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
			const db = 20 * Math.log10(Math.sqrt(sum / Math.max(1, pcm.length)) / 32768 + 1e-9);
			m.peak = Math.max(m.peak, db);
			m.fill.setCssProps({ '--level': String(Math.max(0, Math.min(1, (db + 60) / 50))) });
		};
		result.setText(t.ob.installing);
		let sysError: string | null = null;
		await this.plugin.installHelper();
		result.setText(t.ob.listening(TEST_SECONDS));
		try {
			const m = new MicSource(this.plugin.settings.micDevice, feed(mic));
			await m.start();
			this.sources.push(m);
		} catch (e) {
			mic.mark.setText('✗');
			result.setText(t.micUnavailable((e as Error).message));
		}
		// Not awaited: the first start can wait on the macOS permission prompt.
		let sysStarted = false;
		const s = new SystemSource(this.plugin.helperPath, feed(sys), (msg) => (sysError = msg));
		this.sources.push(s);
		s.start().then(
			() => (sysStarted = true),
			(e: Error) => (sysError = e.message),
		);
		await new Promise<void>((resolve) => (this.timer = window.setTimeout(resolve, TEST_SECONDS * 1000)));
		this.stopSources();
		if (!sysStarted && !sysError) sysError = t.ob.permission;
		const heard = (m: typeof mic) => m.peak > -55;
		mic.mark.setText(heard(mic) ? '✓' : '✗');
		sys.mark.setText(!sysError && heard(sys) ? '✓' : '✗');
		for (const m of [mic, sys]) m.fill.setCssProps({ '--level': '0' });
		result.setText(
			sysError
				? t.ob.sysError(sysError)
				: !heard(sys)
					? t.ob.sysSilent
					: !heard(mic)
						? t.ob.micSilent
						: t.ob.allGood,
		);
	}

	private stopSources() {
		window.clearTimeout(this.timer);
		for (const s of this.sources) s.stop();
		this.sources = [];
	}

	onClose() {
		this.stopSources();
		this.contentEl.empty();
		this.plugin.settings.onboarded = true;
		void this.plugin.saveSettings();
	}
}
