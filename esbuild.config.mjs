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

// Production builds embed the macOS helper (see src/recorder/helper.ts), written next to the plugin
// on first use. Dev builds embed nothing and use the helper copied into the vault below.
const HELPER = 'native/bin/meeting-tap';
if (prod && process.env.CI && !existsSync(HELPER)) throw new Error(`${HELPER} is missing: run ./native/build.sh first`);
const helper = prod && existsSync(HELPER) ? readFileSync(HELPER) : null;
const helperSha = helper ? createHash('sha256').update(helper).digest('hex') : '';
const helperB64 = helper ? helper.toString('base64') : '';

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
	define: { HELPER_SHA256: JSON.stringify(helperSha), HELPER_BASE64: JSON.stringify(helperB64) },
	plugins: [copyAssets],
});

if (prod) {
	await ctx.rebuild();
	process.exit(0);
} else {
	await ctx.watch();
}
