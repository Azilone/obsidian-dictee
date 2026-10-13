/**
 * Voice Memos inbox (macOS): recordings made with the iPhone's Voice Memos app sync over iCloud
 * into a protected folder on the Mac. This lists the new ones so the plugin can process them
 * without asking: record on the phone (screen locked, paused, Action button…), find it in the vault.
 *
 * Reading the folder needs Full Disk Access for Obsidian. Titles and durations come from the
 * Voice Memos database through `/usr/bin/sqlite3` when possible, else from the file itself.
 */

export const VOICE_MEMOS_DIR = '~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings';

export interface VoiceMemo {
	/** File name, the stable id of a memo. */
	name: string;
	path: string;
	/** Title given in Voice Memos (often a place name), '' if unknown. */
	title: string;
	/** Seconds (estimated from the size when the database is unreadable). */
	duration: number;
	recordedAt: Date;
}

export class NoAccessError extends Error {}

function expand(dir: string): string {
	const os = require('os') as typeof import('os');
	return dir.replace(/^~(?=\/|$)/, os.homedir());
}

/** `20261013 192233-1A2B3C4D.m4a` → local date-time, else null. */
export function dateFromName(name: string): Date | null {
	const m = /^(\d{4})(\d{2})(\d{2}) (\d{2})(\d{2})(\d{2})/.exec(name);
	return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

/** Title and duration per file name, from the Voice Memos database. Empty when unreadable. */
function readDatabase(dir: string): Map<string, { title: string; duration: number }> {
	const out = new Map<string, { title: string; duration: number }>();
	const fs = require('fs') as typeof import('fs');
	const { execFileSync } = require('child_process') as typeof import('child_process');
	const db = `${dir}/CloudRecordings.db`;
	if (!fs.existsSync(db)) return out;
	try {
		const run = (sql: string) =>
			execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', db, sql], { encoding: 'utf8', timeout: 5000 }).trim();
		const cols = (JSON.parse(run('PRAGMA table_info(ZCLOUDRECORDING)') || '[]') as { name: string }[]).map((c) => c.name);
		const title = ['ZENCRYPTEDTITLE', 'ZCUSTOMLABEL'].filter((c) => cols.includes(c));
		if (!cols.includes('ZPATH')) return out;
		const sql = `SELECT ZPATH AS path, ${title.length ? `COALESCE(${title.join(', ')}, '')` : "''"} AS title, ${
			cols.includes('ZDURATION') ? 'ZDURATION' : '0'
		} AS duration FROM ZCLOUDRECORDING`;
		for (const row of JSON.parse(run(sql) || '[]') as { path: string; title: string; duration: number }[]) {
			if (row.path) out.set(row.path.split('/').pop()!, { title: String(row.title ?? ''), duration: Number(row.duration) || 0 });
		}
	} catch (e) {
		console.warn('[dictee] Voice Memos database unreadable, using file names only', e);
	}
	return out;
}

/**
 * Memos recorded after `since` and not in `seen`, oldest first. A file still growing (iCloud
 * download in progress) is left for the next check.
 */
export function listNewMemos(dir: string, since: Date, seen: Set<string>): VoiceMemo[] {
	const fs = require('fs') as typeof import('fs');
	const root = expand(dir);
	let names: string[];
	try {
		names = fs.readdirSync(root);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === 'EPERM' || code === 'EACCES') throw new NoAccessError('Accès complet au disque requis');
		if (code === 'ENOENT') return [];
		throw e;
	}
	const fresh = names.filter((n) => /\.m4a$/i.test(n) && !seen.has(n));
	if (!fresh.length) return [];
	const db = readDatabase(root);
	const out: VoiceMemo[] = [];
	for (const name of fresh) {
		const path = `${root}/${name}`;
		let stat: import('fs').Stats;
		try {
			stat = fs.statSync(path);
		} catch {
			continue;
		}
		const recordedAt = dateFromName(name) ?? stat.birthtime;
		if (recordedAt < since) continue;
		if (!stat.size || Date.now() - stat.mtimeMs < 60_000) continue; // still syncing
		const info = db.get(name);
		// Without the database, estimate from the size (Voice Memos AAC is ~64 kbit/s or more).
		const duration = info?.duration || stat.size / 8000;
		out.push({ name, path, title: info?.title.trim() ?? '', duration, recordedAt });
	}
	return out.sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
}

/** A memo titled like a meeting is one; otherwise the transcript decides (`auto`). */
export function memoKind(memo: VoiceMemo): 'meeting' | 'auto' {
	return /r[ée]union|meeting|call|rdv|entretien|1:1/i.test(memo.title) ? 'meeting' : 'auto';
}
