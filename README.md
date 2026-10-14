<div align="center">

<img src="assets/logo.png" width="112" alt="Muesli logo">

# Muesli for Obsidian

**Granola, in Obsidian. The AI notepad for back-to-back meetings.**

Notes, actions and memory, directly in your vault. **Without a meeting bot.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Obsidian](https://img.shields.io/badge/Obsidian-%E2%89%A5%201.11.4-7c3aed)
![Calls](https://img.shields.io/badge/calls-macOS%2014.4%2B-lightgrey)
![Mobile](https://img.shields.io/badge/mobile-in%20person%20%26%20journal-success)

**English** · [Français](README.fr.md)

[Install](#install) · [Setup](#setup) · [How it works](#how-it-works) · [Privacy](#privacy-and-disclosures)

</div>

---

## Why Muesli?

You jump from call to call. You want to listen, jot three words, and walk out with clean notes and a task list. Not a bot in the participant list, not another app, not your notes locked in someone else's cloud.

- **No bot joins your call.** Muesli records your microphone and your Mac's audio output, so it works with Zoom, Meet, Teams, Slack, a phone call in the browser — anything that plays sound.
- **Your notes come first.** Type a few words while people talk. The summary is built *around* them, filled in with what was actually said.
- **Actions you can track.** Tasks come out as `- [ ] Paul — send the recap (Friday)`, ready for Tasks, Dataview and Bases.
- **Memory that stays yours.** Every meeting is a folder of plain Markdown in your vault: searchable, linkable to people and projects, synced however you already sync.
- **Bring your own key.** One [OpenRouter](https://openrouter.ai) key, pay per use (about **$0.10 per hour** of speech). No subscription, no account with us.

## What you get

Click the 🎙️ ribbon icon, pick **Meeting**, and write in the `Notes.md` that opens. Click stop. A few seconds later:

```
Meetings/2026-10-09 1430 Pricing review with Acme/
  Summary.md      ← TL;DR, decisions, actions, topics, open questions
  Transcript.md   ← cleaned-up "who said what", with timestamps
  Notes.md        ← your raw notes, untouched
  audio.mp3       ← optional recording
```

The title is chosen by the AI from the content. Speakers are named from the conversation ("thanks Paul…"), and you confirm or fix them in one dialog.

## Two uses

| | **Meeting** | **Journal** |
|---|---|---|
| For | Calls on your Mac (mic + system audio), in-person meetings, any recording | Thinking out loud: tasks, plans, ideas, mood |
| Result | A meeting folder with summary, transcript, notes and audio | A bullet-journal entry appended to today's daily note; audio and transcript in `Voice notes/` |

### During a meeting

- **Notes with timestamps.** Every line you type is silently timestamped, and *Mark this moment* drops a `⏱ 12:34` marker. The summary uses both to align your notes with the conversation.
- **Never forget to stop.** A small always-on-top pill shows the recording, the elapsed time and the estimated cost over every app, and stays **out of screen shares and screenshots**. After a long silence Muesli asks whether the meeting is still on, and ends it by itself if nobody answers.
- **Ready when you stop.** Audio is transcribed in the background *during* the meeting, so the result arrives seconds after you click stop.

### Recorded elsewhere? Import it

A voice memo from your phone, an `.m4a` from a dictaphone, an `.mp3` someone sent you: drop it in `Meetings/Inbox` (AirDrop, iCloud Drive, Finder), right-click any audio file in the vault → **Create a meeting from this audio**, or run *Import an audio recording* to pick a file anywhere on disk. You get the same folder, with the original audio kept.

### iPhone Voice Memos, processed on your Mac

Turn on *Process new memos automatically* (macOS): every new Voice Memo synced by iCloud is transcribed, recognized as a meeting or a journal entry from what is said, and filed — while Obsidian is open. Record with the screen locked, find it in your vault. Needs Full Disk Access for Obsidian.

### On your phone

Tap the mic icon to open the **recorder**: pick **Journal** or **Meeting** (in person, microphone only), then one big button. iOS cuts the microphone of any app in the background, so keep Obsidian in front while recording (the screen stays on). The OpenRouter key is stored per device: enter it on the phone too.

## Install

> Muesli is not in the community plugin directory yet.

**With BRAT (recommended)**: install [BRAT](https://github.com/TfTHacker/obsidian42-brat), then *BRAT: Add a beta plugin* → `Azilone/obsidian-muesli`. Enable **Muesli** in *Settings → Community plugins*.

**Manually**: download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/Azilone/obsidian-muesli/releases/latest) into `<your vault>/.obsidian/plugins/muesli/`, then enable **Muesli**.

**From source**: see [CONTRIBUTING.md](CONTRIBUTING.md#development).

### Requirements

| | Calls (mic + system audio) | In person, journal, import |
|---|---|---|
| macOS 14.4+ | ✅ | ✅ |
| Windows, Linux | — (mic only for now) | ✅ |
| iOS, Android | — | ✅ (recorder screen) |

Obsidian 1.11.4 or later, and an [OpenRouter API key](https://openrouter.ai/keys) with a few dollars of credit.

## Setup

On first launch, a **setup screen** walks you through it (also available from *Settings → Muesli → Setup* or the *Set up Muesli* command):

1. **OpenRouter API key**: get one at [openrouter.ai/keys](https://openrouter.ai/keys) and paste your key. It is checked right away, the remaining credit is shown, and it is saved in Obsidian's secret storage (never in your vault or in `data.json`).
2. **Your name**: used for your microphone in transcripts.
3. **Sound test (Mac)**: Muesli sets up its small audio helper (see [disclosures](#privacy-and-disclosures)), then macOS asks to allow **Muesli** to record the computer's audio. Accept, or the other participants won't be captured. Play some audio during the test: both meters should move. You can change the permission later in *System Settings → Privacy & Security → Screen & System Audio Recording*. macOS may ask again after an update.
4. Optional: **Default meeting type** (call or in person), **default summary template**, **summary language**, and the folders.

That's it: ribbon icon → **Meeting** → write → stop.

## Summary templates

Templates are plain notes in `Meetings/Templates`. A template's content describes the summary you want, in your own words. Two are created for you, **General** and **1:1**. Duplicate one, rewrite its sections (a sales call, a standup, an interview…) and pick it as the default in the settings.

## Language

The interface, the default folders, the templates and the AI prompts follow Obsidian's language: **French** if Obsidian is in French, **English** otherwise. Transcription auto-detects the spoken language (or set it), and the summary is written in the *Summary language* setting, whatever the meeting language.

## How it works

| Piece | What it does |
|---|---|
| **Microphone** | Captured with Web Audio. In a call, it is *you*, so you are always attributed correctly. |
| **System audio** | A tiny native helper (`meeting-tap`, Swift, ~270 KB) taps the Mac's audio output through Core Audio process taps. This is how the other participants are heard without a bot or a virtual audio driver. |
| **Silence removal** | An on-device voice detector strips silences before anything is uploaded (transcription is billed per second). Chunks are cut *inside* silences, so no word is split, and timestamps are mapped back to the real meeting clock. Chunks with no speech are never sent. |
| **Transcription** | [`microsoft/mai-transcribe-2`](https://openrouter.ai/microsoft/mai-transcribe-2) through OpenRouter, with speaker diarization. |
| **Clean-up and summary** | A small LLM (`anthropic/claude-haiku-5.5` by default, any OpenRouter model works) matches speakers across chunks, fixes recognition errors, removes filler words, writes the summary and picks a title. Your notes are treated as the most important input. |

Everything is written to your vault first (`<meeting>/.raw/`), so a crash or a failed API call never loses a meeting. **Re-process the meeting** (command, or right-click the folder) picks up where it stopped.

### Cost

You pay OpenRouter directly. As a rough guide: transcription is about **$0.10 per hour of speech** after silence removal, plus a few cents of LLM per meeting. The live estimate is shown in the overlay, the real cost when processing ends.

## Settings

| Setting | Default |
|---|---|
| Default meeting type | Call (mic + system audio) / In person (mic only, every voice diarized) |
| Default summary template | `General` |
| Language | Auto-detect |
| Summary language | English (French if Obsidian is in French) |
| Keep the audio | On |
| Segment length | 8 min |
| Floating overlay | On, hidden from screen sharing |
| Ask after N min without speech / stop after | 10 min / 5 min |
| Maximum duration | 180 min |
| Models | `microsoft/mai-transcribe-2`, `anthropic/claude-haiku-5.5` |
| Folders | `Meetings`, `Meetings/Templates`, `Meetings/Inbox`, `Voice notes` |
| Daily note | Core *Daily notes* settings, or your own Moment path |

## Privacy and disclosures

- **Network**: audio and text are sent **only to [OpenRouter](https://openrouter.ai)** (and the model providers it routes to), with your own key. No telemetry, no analytics, no server of ours.
- **Paid service**: OpenRouter is pay-per-use; you need an account and credit.
- **Native helper (macOS)**: system audio capture and fast audio decoding use `meeting-tap`, a small open-source Swift program ([`native/macos/main.swift`](native/macos/main.swift)). Obsidian only installs `main.js`, `manifest.json` and `styles.css`, so the release build embeds the compiled helper in `main.js` (with its SHA-256) and Muesli writes it to its plugin folder on first use. Nothing is downloaded. Release files are built by GitHub Actions from this repository, with [build provenance attestations](https://github.com/Azilone/obsidian-muesli/attestations); the same binary is attached to each release as `meeting-tap`. You can also build it yourself with `./native/build.sh`.
- **Files outside the vault**: only when you import a file from disk, or with the optional Voice Memos inbox (reads `~/Library/Group Containers/group.com.apple.VoiceMemos.shared`, requires Full Disk Access).
- Raw audio chunks and API responses stay in a hidden `.raw/` folder inside each meeting folder. Delete it once you're happy with the result. Syncing your vault with git? Consider adding `**/.raw/` and `*.mp3` to `.gitignore`.
- **Always tell participants you are recording**, and follow the consent laws where you live.

## Development

```bash
bun install
bun run check                        # type-check + tests (VAD, chunking, merge, journal)
./native/build.sh                    # universal (arm64 + x86_64) helper, ad-hoc signed
VAULT="/path/to/vault" bun run dev   # watch mode, builds straight into the vault
```

Test the helper on its own:

```bash
./native/bin/meeting-tap --seconds 5 > out.pcm
ffplay -f s16le -ar 16000 -ac 1 out.pcm
```

The helper writes raw PCM (s16le, mono, 16 kHz) on stdout and JSON status lines on stderr, and exits when its stdin closes. `meeting-tap --decode file.m4a` streams any audio file in the same format (used for imports). Any helper that follows this contract can be added for Windows (WASAPI loopback) or Linux (PipeWire monitor) — contributions welcome.

### Layout

```
src/
  main.ts              plugin, commands, status bar, recovery
  i18n.ts              every UI string, English and French
  session.ts           recording session, transcription queue, on-disk state
  openrouter.ts        API client (STT, chat, key check)
  recorder/track.ts    VAD, silence removal, chunking, time maps
  recorder/sources.ts  microphone (AudioWorklet) and system audio (helper)
  recorder/helper.ts   writes the macOS helper embedded in main.js
  recorder/decode.ts   audio file → 16 kHz PCM (helper `--decode`, Web Audio fallback)
  recorder/voice-memos.ts  iPhone Voice Memos inbox (macOS)
  pipeline/            merge, speaker matching, clean-up, summary, journal, prompts (EN + FR)
  ui/                  start and import dialogs, speaker names, overlay pill, mobile recorder
native/macos/          Swift Core Audio tap helper
```

## Roadmap

- Windows and Linux system audio helpers
- Live transcript while recording
- "Ask your meetings" chat across the vault
- Auto-title and participants from the calendar

## License

[MIT](LICENSE)
