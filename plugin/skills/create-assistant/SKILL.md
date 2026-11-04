---
name: create-assistant
description: Build the user's own personal assistant step by step - its own WhatsApp number, email, reminders, browsing, voice notes and a second brain, running on their computer or a machine they already have. Use when the user asks to create, set up, install, continue or fix their personal assistant ("create my personal assistant", "תייצר לי עוזר אישי"), or to add a part to it later (email, Telegram, a login).
---

# create-assistant

You guide the user through building their assistant. Most users are not technical.

## How to talk

- Speak the user's language (the one they wrote in) the whole way. Short, plain sentences.
- **Before every action say what you will do and why, in one or two lines.** Then do it. Then say what happened.
- One question at a time. Offer a sensible default. Every step can be skipped and done later.
- Never ask for a password, token or code in the chat. Secrets go through a local window (`setup.js secret`),
  logins through a visible browser window (`chrome-step.js`). Say so when it matters: "You type it there, I never see it."
- Never spend money without explaining it first. Nothing here costs money except what the user already pays for Claude.
- If a step fails: say it plainly, show the short error, offer to retry, skip, or stop. Never loop.

## Tools

`S="node ~/.assistant/app/gateway/bin/setup.js"` (state, log, config, secrets, checks, WhatsApp pairing),
`~/.assistant/app/gateway/bin/service.js` (the service), `remote.js` (another machine), `chrome-step.js` (windows).
Every command prints `--help`. Run `$S status` at the start: it shows what is done, and resumes where they stopped.
After each step: `$S mark STEP done` (or `skipped`) and `$S log "<what happened>"`. Never log secrets.

## Steps (in order; skip what is done)

1. **language** - Confirm the language. `$S set language '"he"'` (any ISO code), `$S set ownerName '"<first name>"'`,
   `$S set timezone '"<IANA zone>"'`.
2. **plan** - In 5-6 lines: what they get (an assistant they talk to on WhatsApp like a contact; it reads their
   email, reminds them, browses, understands voice notes, remembers in a second brain they can read), what it needs
   (a **second phone number** for the assistant - a real SIM or eSIM, not a one-time virtual number; about 30 minutes;
   a computer that stays on, or a machine they already have), and that every message to other people, payment or
   booking asks them first.
3. **prereqs** - First run only: if `~/.assistant/app` is missing, explain, then clone
   https://github.com/MosheOfer1/create-your-own-assistant-from-claude-code there and
   `npm ci --omit=dev` in `gateway/`. Then `$S check`. Node 22+ is required (offer to install it: nvm, brew, or the
   nodejs.org installer); git and Claude Code are required; ffmpeg only for voice; `npx playwright-core install chromium` for the browser.
4. **host** - Ask: "this computer" or "a machine you already have (SSH)". This computer must stay on and awake:
   explain how to turn off sleep for their system (macOS: Battery/Energy settings; Linux: power settings; Windows:
   use WSL2 with systemd on, and turn off sleep). For SSH: `remote.js check USER@HOST` and explain any PROBLEM line.
   `$S set host '"local"'` or `'"ssh:USER@HOST"'`.
5. **code** - Pin the version: `$S set version '"<latest tag of the public repo>"'` (`git -C ~/.assistant/app describe --tags --abbrev=0`).
6. **repo** - Their private GitHub repo for settings and the second brain. Needs `gh` logged in: if not, run
   `gh auth login --web` in the background and tell them to finish it in the browser. Then `$S repo create my-assistant`.
   If they already keep notes in Obsidian, offer to point the brain at that vault instead:
   `$S set modules.brain.dir '"<vault path>"'` (a vault that is a git repo gets commits).
7. **claude** - This computer: already logged in (you run here). SSH host: print `remote.js login USER@HOST` and ask them
   to type it in the prompt with a leading `!` (it is interactive, once). Or, if they prefer an API key:
   `$S secret ANTHROPIC_API_KEY --url https://console.anthropic.com/settings/keys --say "<create a key and paste it>"`.
8. **whatsapp** - Ask for the assistant's number and their own number (international format).
   `$S set channels.whatsapp '{"assistantNumber":"+…","ownerNumber":"+…"}'`. Explain: on the assistant's phone,
   WhatsApp (or WhatsApp Business) → Linked devices → Link with phone number instead. Run `$S whatsapp` in the background;
   when it prints `pairing code: XXXX-XXXX`, show the code; it prints `linked` when done. Tell them: open WhatsApp on
   the assistant's phone at least every 14 days, or WhatsApp unlinks it (the assistant warns them).
9. **telegram** (optional backup) - They make a bot with @BotFather: `chrome-step.js step --url https://web.telegram.org --say "<open @BotFather, /newbot, copy the token>"`,
   then `$S secret TELEGRAM_BOT_TOKEN --url https://web.telegram.org --say "<paste the token>"` and
   `$S set channels.telegram '{}'`. After the service starts, its log shows `/start <code>` to send to the bot.
10. **email** (optional) - Explain app passwords (a separate password just for the assistant, revocable). Gmail needs
    2-Step Verification on. `$S set modules.email '{"user":"<address>"}'`, then
    `$S secret EMAIL_APP_PASSWORD --url https://myaccount.google.com/apppasswords --say "<create one named Assistant, paste it>"`.
11. **voice** (optional) - whisper.cpp on the host (macOS: `brew install whisper-cpp`; Linux: build from source or the
    package manager) and a model in `~/.assistant/data/models/` (ggml-base.bin is small; ggml-small.bin is better for
    non-English). `$S set modules.media '{}'`. A GPU makes it faster; no GPU is fine.
12. **logins** (optional) - Sites the assistant should be logged in to: `chrome-step.js login --url <site>` (they log in in
    the window and press Done). SSH host: then `chrome-step.js push --to USER@HOST:.assistant/data`.
    Always on: `$S set modules.reminders '{}'`, `$S set modules.brain '{}'` (if not set by step 6), `$S set modules.browse '{}'`.
13. **service** - This computer: `service.js install`. SSH host: `$S repo push`, then `remote.js install USER@HOST --repo <owner>/my-assistant --version <tag>`.
    If linger is not on, explain the one admin command it needs.
    **Own user (Linux / WSL2, recommended):** explain: the assistant moves to a user of its own; it can no longer
    see their files, and its code becomes read-only to it, so it may run plain commands without asking. It needs their
    admin password once. Ask them to type, with a leading `!` (sudo asks for the password there, not in the chat):
    `! sudo "$(command -v node)" ~/.assistant/app/gateway/bin/own-user.js install` (SSH host: `remote.js own-user USER@HOST`
    prints the command). Show its `ok:` / `BAD:` lines. Later secrets or logins: `! sudo … own-user.js sync-from-owner`.
    macOS: skip (it runs as their user, with the guards in the code).
14. **deploy** - Explain: settings and brain live in their private repo. A change made there from outside (GitHub,
    Obsidian on a phone) is picked up when the assistant answers the next message. What they ask in the chat works
    at once. To update the assistant: change `version` in config.json.
15. **test** - Ask them to write "hi" to the assistant's number. Watch `service.js logs` (or `remote.js logs`).
    A reply means it works. Then suggest two first tasks ("remind me tomorrow at 9 to…", "what's new in my email?").

## When something is wrong later

`$S status`, `service.js status` / `logs`. WhatsApp unlinked → step 8 again (`rm` nothing; `$S whatsapp` makes a new code
after `~/.assistant/data/whatsapp-auth` is moved aside - ask first). Repeat any step any time; each is safe to run again.
