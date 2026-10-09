<div align="center">

# Meeting Notes for Obsidian

**Record any meeting, take notes as you go, and get a clean "who said what" transcript and an AI summary — right in your vault.**

No bot joins your call. No new app. Your notes stay plain Markdown.

*The interface and default prompts are in French for now.*

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Obsidian](https://img.shields.io/badge/Obsidian-%E2%89%A5%201.11.4-7c3aed)
![Desktop](https://img.shields.io/badge/desktop-macOS%2014.4%2B-lightgrey)

</div>

---

## What it does

1. **Start recording at any time** — ribbon icon, command palette or a hotkey. Pick a title, call or in-person, the language, and a summary template.
2. **Write your notes** in `Notes.md`, which opens for you. Every line is timestamped silently, and *Mark this moment* drops a `⏱ 12:34` marker.
3. **Stop** — from the status bar, the note header or a command. Audio is transcribed in the background *during* the meeting, so the result is ready seconds after you stop.
4. **Name the speakers** — the plugin suggests names it heard in the conversation ("thanks Paul…"); you confirm or fix them.
5. **Get a tidy folder**:

```
Réunions/2026-10-09 1430 Product sync/
  Résumé.md       ← AI summary: TL;DR, decisions, tasks, topics, open questions
  Transcript.md   ← cleaned-up transcript, speaker by speaker, with timestamps
  Notes.md        ← your raw notes, untouched
  audio.mp3       ← optional recording
```

Tasks come out as `- [ ] Paul — send the recap (Friday)`, so they work with Tasks, Dataview and Bases.

## How it works

| Piece | What it does |
|---|---|
| **Microphone** | Captured with Web Audio. In a call, it is *you*, so you are always attributed correctly. |
| **System audio** | A tiny native helper (`meeting-tap`, ~190 KB, Swift) taps the Mac's audio output through Core Audio process taps. This is how the other participants are heard without a bot or a virtual audio driver. |
| **Silence removal** | An on-device voice detector strips silences before anything is uploaded (transcription is billed per second). Chunks are cut *inside* silences, so no word is split, and timestamps are mapped back to the real meeting clock. Chunks with no speech are never sent. |
| **Transcription** | [`microsoft/mai-transcribe-2`](https://openrouter.ai/microsoft/mai-transcribe-2) through OpenRouter, with speaker diarization. Chunks stay under the diarization length limit. |
| **Clean-up and summary** | A small LLM (`anthropic/claude-haiku-5.5` by default) matches speakers across chunks, fixes recognition errors, removes filler words, and writes the summary. Your notes are treated as the most important input. |

Everything is written to your vault first (`<meeting>/.raw/`), so a crash or a failed API call never loses a meeting. **Retraiter la réunion** (re-process: command or folder context menu) picks up where it stopped.

### Cost

You pay OpenRouter directly (bring your own key). As a rough guide, transcription is about **$0.10 per hour of speech** after silence removal, plus a few cents of LLM per meeting.

## Install

> Not yet in the community plugin directory. Build from source:

Requirements: macOS 14.4+, Obsidian 1.11.4+, [Bun](https://bun.sh), Xcode command line tools (`swiftc`).

```bash
git clone https://github.com/Azilone/obsidian-meeting-notes.git
cd obsidian-meeting-notes
bun install
./native/build.sh
VAULT="/path/to/your/vault" bun run build
```

Then in Obsidian: **Settings → Community plugins → enable Meeting Notes**.

### Setup

1. **Settings → Meeting Notes → OpenRouter API key**: paste your key. It is checked against OpenRouter, the remaining credit is shown, and it is saved in Obsidian's secret storage (never in your vault or in `data.json`).
2. Set **your name** (used for your microphone).
3. On the first recording, macOS asks to allow **system audio recording** for *Meeting Notes*. Accept it, or the other participants won't be captured.

## Summary templates

Templates are plain notes in `Réunions/Modèles` (configurable). The note's content describes the summary you want; two are created for you: **Général** and **1:1**. Duplicate one, rewrite the sections, and it shows up in the start dialog.

## Settings

| Setting | Default |
|---|---|
| Meeting type | Call (mic + system audio) / In person (mic only, every voice diarized) |
| Language | Auto-detect; can be changed for each meeting |
| Summary language | French |
| Keep audio | On |
| Chunk length | 8 min |
| Models | `microsoft/mai-transcribe-2`, `anthropic/claude-haiku-5.5` (any OpenRouter model works) |
| Folders | `Réunions`, `Réunions/Modèles` |

## Privacy

- Audio and text go **only to OpenRouter** (and the model providers it routes to), with your own key. Nothing else leaves your machine.
- Raw audio chunks and API responses stay in a hidden `.raw/` folder inside each meeting folder. Delete it once you're happy with the result.
- Using git sync on your vault? You may want to add `**/.raw/` and `*.mp3` to `.gitignore`.
- Always tell participants you are recording, and follow the consent laws where you live.

## Development

```bash
bun install
bun test                         # VAD/chunking and merge logic
VAULT="/path/to/vault" bun run dev   # watch mode, builds straight into the vault
./native/build.sh                # universal (arm64 + x86_64) helper, ad-hoc signed
```

Test the helper on its own:

```bash
./native/bin/meeting-tap --seconds 5 > out.pcm
ffplay -f s16le -ar 16000 -ac 1 out.pcm
```

The helper writes raw PCM (s16le, mono, 16 kHz) on stdout and JSON status lines on stderr, and exits when its stdin closes. Any helper that follows this contract can be added for Windows (WASAPI loopback) or Linux (PipeWire monitor).

### Layout

```
src/
  main.ts              plugin, commands, status bar, recovery
  session.ts           recording session, transcription queue, on-disk state
  openrouter.ts        API client (STT, chat, key check)
  recorder/track.ts    VAD, silence removal, chunking, time maps
  recorder/sources.ts  microphone (AudioWorklet) and system audio (helper)
  pipeline/            merge, speaker matching, clean-up, summary, writer
  ui/modals.ts         start dialog, speaker names
native/macos/          Swift Core Audio tap helper
```

## Roadmap

- Windows and Linux system audio helpers
- Live transcript while recording
- "Ask this meeting" chat
- Auto-title from the calendar

## License

[MIT](LICENSE)
