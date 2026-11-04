# Create your own assistant from Claude Code

Your own assistant on WhatsApp. Claude Code builds it and runs it
on your computer, or on a machine you already have.

> Work in progress. Some parts are not yet tried for real. See [Status](#status).

## What it does

- **Chat on WhatsApp.** The assistant has its own phone number. You write to it like to a friend.
- **Email.** It reads your mail, tells you about the mail that needs you, and writes drafts.
- **Reminders.** "Remind me tomorrow at 9." It can also do a task at a set time.
- **Browsing.** It opens public web pages, reads them and fills in forms for you.
- **Voice notes.** Send a voice note. The assistant turns the speech into text.
- **Second brain.** It keeps what it learns about you in plain Markdown files.
  You can open them in Obsidian.
- **Telegram backup.** If WhatsApp goes down, the assistant tells you on Telegram.

## What you need

- A Claude subscription, or an Anthropic API key.
- A second phone number for the assistant. Use a real SIM or an eSIM.
- A computer that stays on, or a Linux machine with 2 GB RAM that you reach over SSH.
- A GitHub account. The assistant keeps your settings and notes in a private repo there.

## Install

In Claude Code, type these two lines:

```
/plugin marketplace add MosheOfer1/create-your-own-assistant-from-claude-code
/plugin install assistant@create-your-own-assistant
```

Then say "create my personal assistant". Use any language.
Claude asks one question at a time. You can skip any step and do it later.

## How it stays safe

- **Free inside, gated outside.** The assistant works freely in its own folder.
  It always asks you before it sends something to other people, pays or books.
- **Outside text is not trusted.** A web page, an email or a forwarded message can hold tricks.
  After the assistant reads one, the conversation is "tainted". Strong actions ask
  until you start a new conversation.
- **Secrets stay out of reach.** The agent never gets the secrets of the gateway.
  Its file tools cannot open the folder where the secrets are kept.
- **You type secrets in a local window.** Passwords and tokens never go through the chat.
- **Public web pages only.** The browser refuses your own machine and your home network.
  It never types into password or card fields.
- **Use a spare WhatsApp number.** The assistant's number runs on an unofficial client (Baileys).
  WhatsApp may ban that number.

You answer a request with "yes" or "no" in the same chat.

## How it works

```
 your phone
    |  WhatsApp (the assistant's number)
    v
 gateway  (Node 22, on your machine)
    |  one message at a time
    v
 claude -p  (the agent)
    |  needs a tool?
    v
 approvals --- free? --- yes --> run it
    |
    no --> ask you: "yes / no"
    v
 modules: reminders, media, brain, email, browse

 your private repo (settings + notes) --- pulled before each answer ---> gateway
```

## Layout

| Path | What |
|---|---|
| `plugin/` | The Claude Code plugin. Skills `create-assistant` and `web-browse`. |
| `gateway/src/` | The core: router, agent, policy, approvals, channels. |
| `gateway/modules/` | The parts you can switch on: reminders, media, brain, email, browse. |
| `gateway/bin/` | Tools: `setup`, `service`, `remote`, `chrome-step`, `browse`, `cli`. |
| `docs/` | One page for each module, and the list of live checks. |
| `scripts/` | Repo tools. The scanner for personal data. |

Details for each part:
[core](docs/modules/core.md), [whatsapp](docs/modules/whatsapp.md),
[telegram](docs/modules/telegram.md), [reminders](docs/modules/reminders.md),
[media](docs/modules/media.md), [brain](docs/modules/brain.md),
[email](docs/modules/email.md), [browse](docs/modules/browse.md),
[setup](docs/modules/setup.md).

## Develop

```
cd gateway
npm ci
npm test                  # unit tests, no network
npm run cli -- --echo     # chat in your terminal, no claude: replies echo
npm run cli               # chat in your terminal with the real agent
```

Turn on the git hooks once:

```
git config core.hooksPath .githooks
```

The hooks run `scripts/scrub-scan.mjs` on each commit. It looks for your private strings:
names, phone numbers, hosts. Keep the pattern list outside the repo, in
`~/.config/scrub-patterns.txt` (one pattern per line). CI runs the tests and
gitleaks on every push.

## Status

This is a work in progress. [docs/live-checks.md](docs/live-checks.md) lists
what is tested with fakes only and not yet tried for real.

## License

MIT
