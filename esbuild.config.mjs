import esbuild from 'esbuild';
import builtins from 'builtin-modules';
import { createHash } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';

const prod = process.argv[2] === 'production';
// Set VAULT=/path/to/vault to build straight into that vault's plugin folder.
const vault = process.env.VAULT;
const outdir = vault ? join(vault, '.obsidian', 'plugins', 'muesli') : '.';
if (vault) mkdirSync(outdir, { recursive: true });

// Production builds pin the macOS helper they ship with (see src/recorder/helper.ts): the plugin
// downloads it from the matching GitHub release when it is missing. Dev builds pin nothing.
const HELPER = 'native/bin/meeting-tap';
if (prod && process.env.CI && !existsSync(HELPER)) throw new Error(`${HELPER} is missing: run ./native/build.sh first`);
const helperSha = prod && existsSync(HELPER) ? createHash('sha256').update(readFileSync(HELPER)).digest('hex') : '';

const copyAssets = {
	name: 'copy-assets',
	setup(build) {
		build.onEnd(() => {
			if (!vault) return;
			for (const f of ['manifest.json', 'styles.css']) copyFileSync(f, join(outdir, f));
			if (existsSync(HELPER)) copyFileSync(HELPER, join(outdir, 'meeting-tap'));
		});
	},
};

const ctx = await esbuild.context({
	entryPoints: ['src/main.ts'],
	bundle: true,
	external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*', ...builtins],
	format: 'cjs',
	target: 'es2020',
	logLevel: 'info',
	sourcemap: prod ? false : 'inline',
	treeShaking: true,
	minify: prod,
	outfile: join(outdir, 'main.js'),
	define: { HELPER_SHA256: JSON.stringify(helperSha) },
	plugins: [copyAssets],
});

if (prod) {
	await ctx.rebuild();
	process.exit(0);
} else {
	await ctx.watch();
}
