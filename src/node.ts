/**
 * Node.js modules, desktop only: each loader throws on mobile, where they don't exist. Only the
 * parts the plugin uses are typed here, so the code stays typed even without Node's type package.
 */

import { Platform } from 'obsidian';

export interface StatsLike {
	size: number;
	mtime: Date;
	mtimeMs: number;
	birthtime: Date;
}

export interface FsLike {
	existsSync(path: string): boolean;
	chmodSync(path: string, mode: number): void;
	readFileSync(path: string): Uint8Array;
	writeFileSync(path: string, data: Uint8Array, options?: { mode?: number }): void;
	renameSync(from: string, to: string): void;
	readdirSync(path: string): string[];
	statSync(path: string): StatsLike;
	promises: {
		stat(path: string): Promise<StatsLike>;
		readFile(path: string): Promise<Uint8Array>;
	};
}

export interface PathLike {
	basename(path: string, ext?: string): string;
	extname(path: string): string;
}

export interface OsLike {
	homedir(): string;
}

interface StreamLike {
	on(event: 'data', listener: (chunk: Uint8Array) => void): void;
}

export interface ChildProcess {
	stdin: { end(): void } | null;
	stdout: StreamLike;
	stderr: StreamLike;
	on(event: 'error', listener: (error: Error) => void): void;
	on(event: 'exit', listener: (code: number | null) => void): void;
	kill(signal?: string): boolean;
}

export interface ChildProcessLike {
	spawn: (command: string, args: string[], options: { stdio: ['pipe', 'pipe', 'pipe'] }) => ChildProcess;
	execFileSync: (file: string, args: string[], options: { encoding: 'utf8'; timeout?: number }) => string;
}

export async function nodeFs(): Promise<FsLike> {
	if (!Platform.isDesktop) throw new Error('Desktop only');
	const mod: unknown = await import('fs');
	return mod as FsLike;
}

export async function nodePath(): Promise<PathLike> {
	if (!Platform.isDesktop) throw new Error('Desktop only');
	const mod: unknown = await import('path');
	return mod as PathLike;
}

export async function nodeOs(): Promise<OsLike> {
	if (!Platform.isDesktop) throw new Error('Desktop only');
	const mod: unknown = await import('os');
	return mod as OsLike;
}

export async function nodeChildProcess(): Promise<ChildProcessLike> {
	if (!Platform.isDesktop) throw new Error('Desktop only');
	const mod: unknown = await import('child_process');
	return mod as ChildProcessLike;
}
