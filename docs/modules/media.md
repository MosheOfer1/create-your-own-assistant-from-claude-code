# Media

Files: `gateway/modules/media/` (`index.js`, `transcribe.js`, `sherpa-worker.js`, `video.js`, `office.js`).
It turns voice notes into text. It saves files you send to the agent's inbox. It takes frames and
the sound out of videos. It takes the text out of office files.

## What it does

- Voice note: sends the audio to a transcriber. It shows you the text (`🎤 ...`) and gives it to the
  agent as a turn. The text is marked as an automatic transcript that may hold mistakes.
- File (image, PDF, other): saves it to `<agentCwd>/inbox/<time>-<name>`. The agent reads it with `Read`.
- Video: saves it. Then ffmpeg takes up to `videoFrames` small JPEGs (640 px wide at most), spread over
  the video, next to it in the inbox (`<time>-<name>-frame1.jpg`, ...). Its sound goes to the same
  transcribers as a voice note. The turn tells the agent where the frames are and gives the transcript.
  The transcript is marked: the speaker may not be you.
- Office file (`docx`, `xlsx`, `pptx`, `odt`, `ods`, `odp`): saves it, and writes its text to
  `<file>.txt` beside it. The turn points the agent to the `.txt`. Word: paragraphs and tables.
  Excel: every sheet, cells split by tabs. PowerPoint: every slide, in the deck's order.
  No new package: these files are zip files of XML.
- Once every 6 hours, files older than `keepDays` leave the inbox (frames and `.txt` files too).
- Names are cleaned: letters, digits, dot, dash and underscore only.

## Transcribers

| Engine | Languages | Where it runs | Note |
|---|---|---|---|
| `sherpa` | one per model (`sherpaLanguages`, default `he`) | this machine, CPU (also arm64) | fast on CPU, offline. One model knows one language. |
| `whisper` | about 99, among them Hebrew, English, Arabic, Russian | this machine, CPU or GPU | whisper.cpp. Quality depends on the model size: small models are weak in Hebrew. |
| `http` | many (an OpenAI-compatible whisper) | a service, or your own server | your audio goes to that service. |

`transcriber` can be one name or a list, tried in order: `["http", "sherpa"]`. When one fails, the next
one runs, and the log says why. The language rules:

- `voiceLanguage` (default: your chat `language`) is a set language, like `he`: an engine that does not
  do it is skipped, with a log line. A Hebrew-only model on English speech gives nonsense, not an error.
- `voiceLanguage: auto`: single-language engines run only after the multilingual ones fail, unless
  there is only one engine.

At start, one log line says which transcribers can run and why the others cannot (a missing program,
model or package). When none can run, a voice note gets a short reply in your language: speech-to-text
is not set up. When one could run but failed this time, the reply asks you to try again. The technical
reason (`spawn whisper-cli ENOENT`, a missing model file, an HTTP error) is only in the log.

### sherpa

- Needs the npm package `sherpa-onnx-node`. It is an optional dependency: the install adds it on Linux
  x64/arm64, macOS and Windows; without it the gateway still runs, and the start log says it is missing.
  It ships prebuilt binaries in per-platform packages and has no install script, so it works with
  `npm ci --omit=dev --ignore-scripts`. Linux x64 needs glibc 2.32 or newer; arm64 glibc 2.17 or newer.
- Needs a streaming transducer model in `sherpaModelDir`: `encoder.onnx`, `decoder.onnx`, `joiner.onnx`
  (or `*.int8.onnx`) and `tokens.txt`. A Hebrew one: `zipformer2-66m-streaming-he` on Hugging Face
  (`thewh1teagle/zipformer2-66m-streaming-he`, folder `sherpa-onnx`, about 72 MB, CC-BY-4.0).
  For another language, use a model for it and set `sherpaLanguages`.
- Needs `ffmpeg`. The model loads once at start, in a worker thread.

### http on your own machine

`httpUrl` can point to a self-hosted OpenAI-compatible whisper server, for example on a PC with a
GPU, reached over a VPN: `"httpUrl": "http://<pc-address>:<port>/v1/audio/transcriptions"`. Any server
that answers `POST /v1/audio/transcriptions` (form fields `file`, `model`, `language`) with
`{ "text": ... }` works. Put it first and a local engine after it: `["http", "sherpa"]`.
When the PC is off, the request fails fast (at once when the port is closed, about 10 seconds when the
address does not answer), and the next engine runs.

## Config keys (`modules.media`)

- `transcriber`: `whisper` (default), `http`, `sherpa`, `off`, or a list of them.
- `whisperBin` (`whisper-cli`), `whisperModel` (`<dataDir>/models/ggml-base.bin`), `ffmpegBin` (`ffmpeg`).
- `httpUrl`: an OpenAI-compatible `/v1/audio/transcriptions` URL. `httpModel` (`whisper-1`).
- `sherpaModelDir` (`<dataDir>/models/sherpa`), `sherpaLanguages` (`["he"]`), `sherpaThreads` (2),
  `sherpaModelType` (`zipformer2`; `""` lets sherpa read it from the model).
- `voiceLanguage`: the language of the speech. Default: your chat `language`. `auto` lets the engine detect it.
- `maxMinutes` (10): longest voice note; for a video, only its first `maxMinutes` are looked at.
- `maxFileMB` (50), `keepDays` (7), `videoFrames` (6), `maxTextKB` (1000, the most text from an office file).

## Secrets

`TRANSCRIBE_API_KEY` (only for `transcriber: http`). The agent does not get it.

## What runs freely, what asks

The module has no tools. Saving a file, frames, office text and transcribing are done by the gateway,
not by the agent. Reading a file in the inbox (frames and `.txt` files too) taints the conversation,
because someone else wrote it. A forwarded voice note, video or file is marked as written by someone
else and taints it at once.

## Limits and known issues

- `whisper` needs `ffmpeg` and `whisper-cli` on the machine, and a model file. A GPU makes it faster.
- Videos and `sherpa` need `ffmpeg`. Without it a video is only saved, and the turn says so.
- With `http`, your audio goes to the service at `httpUrl`. Choose a service you trust.
- Longer than `maxMinutes` (voice) or bigger than `maxFileMB`: you get a short refusal.
- `transcriber: off` replies that voice notes are not set up.
- Office: old `doc`/`xls`/`ppt`, password-protected files and zip64 files give no text (the file is
  still saved). Excel dates stay numbers. Images inside documents are not read.
- An audio file sent as a document (an mp3) is saved, not transcribed.
- Not yet tried with real voice notes or a real sherpa model. See [live checks](../live-checks.md).
