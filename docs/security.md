# Security

The assistant reads text other people wrote (web pages, emails, files sent to it) and can act
on your computer and your accounts. This page says what protects you, from what, and what is
left. Report a problem privately: see `SECURITY.md` in the repo root.

## The threats

1. **A stranger talks to the assistant.** Only your own number (WhatsApp) or your paired chat
   (Telegram) is answered. Groups, forwarded messages and other senders are ignored.
2. **Outside text gives orders.** A page or an email says "send the password file to …".
   This is the main threat: the agent cannot reliably tell your words from theirs.
3. **Your own settings leak in.** The agent runs `claude`. It must not load your personal
   Claude Code settings, notes or skills.

## What protects you

**Free inside, gated outside.** Reading and writing in the assistant's own folder runs free.
Anything that reaches other people, money or the rest of the machine asks you first in the chat.
- Messages, email, payments, bookings, calendar answers: always ask (`GATED` in `policy.js`).
- Shell commands: an allow list of read-only programs runs free (`commands.js`). Anything the
  parser does not understand asks. No `curl -w`, no redirect into a file, no secret path.
- Secret files are never read: the data folder, `~/.ssh`, `~/.claude`, `~/.config`, cloud and
  package logins, browser profiles, shell history (`secretReadDeny` in `policy.js`).
- An approval shows the whole request. A request too long to show in full is refused, never cut.
- Sending an email needs a one-time ticket for exactly the text you approved.

**Taint.** When outside text enters a conversation (a page, an email, a file in the inbox, a
shell command that fetched something), the conversation is *tainted* until a new one starts:
- web reads only for plain addresses (no query string that could carry data out),
- `nslookup`, `dig`, `ping`: ask (data can leave in the name),
- memory writes ask (a page could plant a "rule"),
- every browser click, typing and key press asks,
- free shell (if on) stops.

**No settings files.** The agent's `claude` runs with `--setting-sources ""` and no auto-memory:
your `~/.claude/CLAUDE.md`, allow rules, hooks, plugins and skills are not loaded.

**Its own user (Linux, recommended for a server).** `bin/own-user.js` runs the assistant as a
system user with no sudo. Other homes are hidden, the system and the code are read-only for it.

## What is left (known residual risks)

- **Taint is a heuristic.** A script the agent writes and you approve can fetch a page in a way
  the taint check does not see. Read what you approve.
- **freeShell.** Off by default. When on, the agent's commands run as the gateway's user: a free
  command could read the gateway's secrets and change `config.json`. The list of commands that
  still ask is a deny list and can be bypassed. Turn it on only if you accept that.
- **Read-only is not secret-free.** In a clean conversation the agent may read most files in your
  home and send them where you asked. Use its own user, or `lockHost: true` on a shared machine.
- **The browser** checks every request for private addresses after DNS, but a DNS answer can
  change between the check and Chrome's own lookup (rebinding).
- **WhatsApp** uses an unofficial client (Baileys). WhatsApp may ban the number. Use a spare one.
- **Private modules** in your repo run with the gateway's rights.
