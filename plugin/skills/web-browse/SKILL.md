---
name: web-browse
description: Browse the web in a real Chrome that stays open and stays logged in, one profile per identity. Use when the user asks to do something on a website - open a page, search a site, fill a form, check a price, anything behind a login they made. Public pages only; never types passwords or card numbers.
---

# web-browse

A Chrome of your own per identity (profile in `~/.assistant/browser/<identity>`). It stays open between
commands, so logins, tabs and half-filled forms persist. It listens on 127.0.0.1 only.

```
B="node ~/.assistant/app/gateway/bin/browse.js"
$B open URL             go there; prints title, URL and main text   <- the main way to see a page
$B text [--max N] [--all]
$B links [WORD]         visible links and buttons (text -> href); WORD filters
$B click "TEXT"         a visible link/button by its text, else a CSS selector
$B type "LABEL" "TEXT"  fill a field by its label, placeholder or CSS
$B press KEY | shot [PATH] | start [--show] | stop
```
Another identity (a work account, a brand): prefix `BROWSE_IDENTITY=work`. Never mix identities in one profile:
a second login in the same profile can log the first one out.

**First run:** if `~/.assistant/app` is missing, tell the user what you will do and why, then:
`git clone --depth 1 https://github.com/OWNER/create-your-own-assistant-from-claude-code ~/.assistant/app && cd ~/.assistant/app/gateway && npm ci --omit=dev && npx playwright-core install chromium`.

## Work fast

- Chain commands in one Bash call when you know the next steps (`$B open … && $B click … && $B text`).
- Read text first. `shot` + Read only when the layout matters.
- Look for a URL shortcut before a form: search URLs (`?q=`), direct pages.
- Data in a tab or section that is not open yet: `links`, then `click` it.

## Rules

- Ask the user before anything outward and hard to undo: send, publish, pay, book, delete, share.
- `LOGIN NEEDED`: the user logs in themselves. Run `$B start --show` (a visible window on their screen),
  let them log in, then `$B start` again (back to hidden; the login stays). Never ask for a password in chat
  and never type one: password, card and code fields are refused in code.
- `BLOCKED` (a bot check): do not retry in a loop. Offer the visible window once, else another source.
- Only public addresses: this machine, the home network and VPN ranges are refused, also after DNS.
- Stuck: `$B stop && $B start` (logins stay).
