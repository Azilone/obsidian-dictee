# Contributing

Thanks for helping make Muesli better! Every issue and pull request is read and answered.

## Issues

- **Bugs**: include your Muesli and Obsidian versions, your platform (macOS version, Windows, iOS…), the meeting type (call, in person, import, Voice Memos) and the console lines starting with `[muesli]` (View → Toggle Developer Tools → Console). Never paste your OpenRouter key or a transcript you can't share.
- **Features**: describe the workflow you want rather than only the solution. It helps find the best design.

## Development

Requirements: [Bun](https://bun.sh), and on macOS the Xcode command line tools (`xcode-select --install`) for the audio helper.

```bash
git clone https://github.com/Azilone/obsidian-muesli.git
cd obsidian-muesli
bun install
./native/build.sh                         # macOS only, when changing native/macos: rebuilds native/meeting-tap
VAULT="/path/to/test-vault" bun run dev   # watch build into the vault's plugin folder
```

Use a test vault, not your real one. Reload the plugin (or Obsidian) after a change.

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Keep the output plain Markdown: a meeting folder must stay readable without the plugin.
3. Any text shown to the user goes through `src/i18n.ts`, in **both English and French**. LLM prompts live in `src/pipeline/prompts.ts`, also in both languages.
4. Run `bun run check` (type-check, the Obsidian community ESLint rules, tests) before opening the PR.
5. Describe what changed and how you tested it (call, in person, import, mobile). Screenshots are great for UI changes.

Small, focused PRs are reviewed fastest.

## Releasing (maintainers)

1. Bump `version` in `manifest.json` and `package.json`, and add it to `versions.json`.
2. Commit, then push a tag with exactly that version (no `v` prefix): `git tag 0.2.0 && git push origin 0.2.0`.
3. The release workflow builds the plugin, embedding the committed `native/meeting-tap`, and publishes `main.js`, `manifest.json`, `styles.css`. The tag must match the manifest version.

The helper itself is rebuilt by the **Helper** workflow (on changes to `native/macos`, or run it by hand), which attests and commits `native/meeting-tap`. Don't commit a locally built helper: let the workflow do it.
