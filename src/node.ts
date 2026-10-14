/** Node.js modules, desktop only: each loader throws on mobile, where they don't exist. */

import { Platform } from 'obsidian';

export type ChildProcess = ReturnType<typeof import('child_process').spawn>;

export async function nodeFs() {
	if (!Platform.isDesktop) throw new Error('Desktop only');
	return import('fs');
}

export async function nodePath() {
	if (!Platform.isDesktop) throw new Error('Desktop only');
	return import('path');
}

export async function nodeOs() {
	if (!Platform.isDesktop) throw new Error('Desktop only');
	return import('os');
}

export async function nodeChildProcess() {
	if (!Platform.isDesktop) throw new Error('Desktop only');
	return import('child_process');
}
