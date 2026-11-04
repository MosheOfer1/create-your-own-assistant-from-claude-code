# Media

File: `gateway/modules/media/index.js`. It turns voice notes into text. It saves files you send
to the agent's inbox.

## What it does

- Voice note: sends the audio to a transcriber. It shows you the text (`🎤 ...`) and gives it to the
  agent as a turn. The text is marked as an automatic transcript that may hold mistakes.
- File (image, PDF, document): saves it to `<agentCwd>/inbox/<time>-<name>`. The agent reads it with `Read`.
- Once every 6 hours, files older than `keepDays` leave the inbox.
- Names are cleaned: letters, digits, dot, dash and underscore only.

## Config keys (`modules.media`)

- `transcriber`: `whisper` (default, whisper.cpp on this machine), `http`, or `off`.
- `whisperBin` (`whisper-cli`), `whisperModel` (`<dataDir>/models/ggml-base.bin`), `ffmpegBin` (`ffmpeg`).
- `httpUrl`: an OpenAI-compatible `/v1/audio/transcriptions` URL. `httpModel` (`whisper-1`).
- `voiceLanguage`: the language of the speech. Default: your chat `language`. `auto` lets whisper detect it.
- `maxMinutes` (10), `maxFileMB` (50), `keepDays` (7).

## Secrets

`TRANSCRIBE_API_KEY` (only for `transcriber: http`). The agent does not get it.

## What runs freely, what asks

The module has no tools. Saving a file and transcribing are done by the gateway, not by the agent.
Reading a file in the inbox taints the conversation, because someone else wrote it.
A forwarded voice note or file is marked as written by someone else and taints it at once.

## Limits and known issues

- `whisper` needs `ffmpeg` and `whisper-cli` on the machine, and a model file.
  A GPU makes it faster. No GPU is fine.
- With `http`, your audio goes to the service at `httpUrl`. Choose a service you trust.
- Longer than `maxMinutes` or bigger than `maxFileMB`: you get a short refusal.
- `transcriber: off` replies that voice notes are not set up.
- Not yet tried with real voice notes. See [live checks](../live-checks.md).
