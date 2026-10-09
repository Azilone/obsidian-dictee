import { requestUrl } from 'obsidian';
import type { SttResult } from './pipeline/merge';

const BASE = 'https://openrouter.ai/api/v1';

export class OpenRouterError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
	get retryable() {
		return this.status === 0 || this.status === 408 || this.status === 429 || this.status >= 500;
	}
}

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

function toBase64(bytes: Uint8Array): string {
	let bin = '';
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(bin);
}

export interface KeyInfo {
	ok: boolean;
	message: string;
}

const money = (n: number) => `${n.toFixed(2).replace('.', ',')} $`;

/** Ask OpenRouter whether a key works, and how much it can still spend. */
export async function checkKey(key: string): Promise<KeyInfo> {
	const get = (path: string) =>
		requestUrl({ url: BASE + path, headers: { Authorization: `Bearer ${key}` }, throw: false });
	let res;
	try {
		res = await get('/key');
	} catch (e) {
		return { ok: false, message: `Impossible de joindre OpenRouter (${(e as Error).message}).` };
	}
	if (res.status === 401 || res.status === 403) return { ok: false, message: 'Clé refusée par OpenRouter.' };
	if (res.status >= 400) return { ok: false, message: `OpenRouter a répondu ${res.status}.` };
	const d = res.json?.data ?? {};
	if (typeof d.limit_remaining === 'number') {
		const period = d.limit_reset === 'monthly' ? '/mois' : d.limit_reset === 'weekly' ? '/semaine' : d.limit_reset === 'daily' ? '/jour' : '';
		return { ok: true, message: `Clé valide — ${money(d.limit_remaining)} restants sur ${money(d.limit)}${period}.` };
	}
	try {
		const c = (await get('/credits')).json?.data;
		if (c && typeof c.total_credits === 'number') {
			return { ok: true, message: `Clé valide — ${money(c.total_credits - c.total_usage)} de crédit restant.` };
		}
	} catch {
		/* credits are optional */
	}
	return { ok: true, message: 'Clé valide.' };
}

export class OpenRouter {
	constructor(private getKey: () => string | null) {}

	private async post(path: string, body: unknown): Promise<any> {
		const key = this.getKey();
		if (!key) throw new OpenRouterError('Clé OpenRouter manquante (Réglages → Meeting Notes).', 401);
		let res;
		try {
			res = await requestUrl({
				url: BASE + path,
				method: 'POST',
				contentType: 'application/json',
				headers: {
					Authorization: `Bearer ${key}`,
					'HTTP-Referer': 'https://obsidian.md',
					'X-Title': 'Obsidian Meeting Notes',
				},
				body: JSON.stringify(body),
				throw: false,
			});
		} catch (e) {
			throw new OpenRouterError(`Réseau : ${(e as Error).message}`, 0);
		}
		if (res.status >= 400) {
			let msg = res.text;
			try {
				msg = res.json?.error?.message ?? msg;
			} catch {
				/* not JSON */
			}
			throw new OpenRouterError(`OpenRouter ${res.status} : ${msg}`.slice(0, 400), res.status);
		}
		return res.json;
	}

	async transcribe(mp3: Uint8Array, opts: { model: string; language?: string; diarize: boolean }): Promise<SttResult> {
		const body: Record<string, unknown> = {
			model: opts.model,
			input_audio: { data: toBase64(mp3), format: 'mp3' },
			response_format: 'verbose_json',
			timestamp_granularities: ['segment'],
		};
		if (opts.language) body.language = opts.language;
		if (opts.diarize) body.provider = { options: { azure: { diarization: { enabled: true } } } };
		return withRetry(() => this.post('/audio/transcriptions', body));
	}

	async chat(model: string, messages: ChatMessage[], opts: { json?: boolean; maxTokens?: number } = {}): Promise<string> {
		const body: Record<string, unknown> = { model, messages, temperature: 0.2 };
		if (opts.maxTokens) body.max_tokens = opts.maxTokens;
		if (opts.json) body.response_format = { type: 'json_object' };
		const res = await withRetry(() => this.post('/chat/completions', body));
		const text = res?.choices?.[0]?.message?.content;
		if (typeof text !== 'string') throw new OpenRouterError('Réponse vide du modèle', 502);
		return text;
	}
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
	let delay = 2000;
	for (let i = 1; ; i++) {
		try {
			return await fn();
		} catch (e) {
			const retryable = e instanceof OpenRouterError ? e.retryable : true;
			if (!retryable || i >= attempts) throw e;
			await new Promise((r) => window.setTimeout(r, delay));
			delay *= 2;
		}
	}
}

/** Extract a JSON object from a model reply, tolerating code fences. */
export function parseJson<T>(text: string): T {
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	return JSON.parse(start >= 0 ? text.slice(start, end + 1) : text) as T;
}
