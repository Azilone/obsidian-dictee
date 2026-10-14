/**
 * The macOS audio helper (`meeting-tap`) ships inside main.js: Obsidian only installs main.js,
 * manifest.json and styles.css, so production builds embed the binary (base64) with its SHA-256,
 * and it is written next to the plugin on first use, or when an update brings a new one.
 * Dev builds embed nothing and leave whatever binary is in the plugin folder alone.
 */

import { Platform } from 'obsidian';
import { nodeFs } from '../node';

declare const HELPER_SHA256: string;
declare const HELPER_BASE64: string;

let pending: Promise<void> | null = null;

async function sha256(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(data));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Make sure `path` holds the helper this build ships with. */
export function ensureHelper(path: string): Promise<void> {
	if (!path || !Platform.isDesktopApp || !Platform.isMacOS || !HELPER_BASE64) return Promise.resolve();
	pending ??= install(path).finally(() => (pending = null));
	return pending;
}

async function install(path: string) {
	const fs = await nodeFs();
	if (fs.existsSync(path) && (await sha256(fs.readFileSync(path))) === HELPER_SHA256) return;
	const bin = atob(HELPER_BASE64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	const tmp = `${path}.tmp`;
	fs.writeFileSync(tmp, bytes, { mode: 0o755 });
	fs.renameSync(tmp, path);
}
