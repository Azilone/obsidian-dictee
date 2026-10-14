import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

// The rules of the Obsidian community directory's automated review.
export default defineConfig([
	{ ignores: ['main.js', 'node_modules/**', 'native/**', 'tests/**', '*.mjs'] },
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: { projectService: { allowDefaultProject: ['eslint.config.mjs'] } },
		},
	},
]);
