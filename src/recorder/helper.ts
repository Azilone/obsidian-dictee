/**
 * The macOS audio helper (`meeting-tap`) is not part of what Obsidian installs (main.js, manifest,
 * styles), so it is fetched once from the GitHub release matching the plugin version and checked
 * against the SHA-256 baked into main.js at build time. Builds without a helper (dev watch mode)
 * have no hash and leave whatever binary is in the plugin folder alone.
 */

import { Notice, Platform, requestUrl } from 'obsidian';
import { t } from '../i18n';

declare const HELPER_SHA256: string;

const REPO = 'Azilone/obsidian-muesli';

let pending: Promise<void> | null = null;

function sha256(data: Uint8Array): string {
	const crypto = require('crypto') as typeof import('crypto');
	return crypto.createHash('sha256').update(data).digest('hex');
}

/** Make sure `path` holds the helper this build expects; downloads it when missing or outdated. */
export function ensureHelper(path: string, version: string): Promise<void> {
	if (!path || !Platform.isDesktopApp || !Platform.isMacOS || !HELPER_SHA256) return Promise.resolve();
	pending ??= install(path, version).finally(() => (pending = null));
	return pending;
}

async function install(path: string, version: string) {
	const fs = require('fs') as typeof import('fs');
	if (fs.existsSync(path) && sha256(fs.readFileSync(path)) === HELPER_SHA256) return;
	const notice = new Notice(t.helperDownloading, 0);
	try {
		const res = await requestUrl({ url: `https://github.com/${REPO}/releases/download/${version}/meeting-tap`, throw: false });
		if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
		const bytes = new Uint8Array(res.arrayBuffer);
		if (sha256(bytes) !== HELPER_SHA256) throw new Error('checksum mismatch');
		const tmp = `${path}.download`;
		fs.writeFileSync(tmp, bytes, { mode: 0o755 });
		fs.renameSync(tmp, path);
	} catch (e) {
		new Notice(t.helperFailed((e as Error).message), 10000);
		throw e;
	} finally {
		notice.hide();
	}
}
