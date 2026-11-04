# Browse

Folder: `gateway/modules/browse/`. The assistant uses a Chromium browser (Playwright) with a
profile that stays between runs. Logins stay too. One profile for each identity.

## What it does

- `open URL`: opens a page and returns title, address and main text.
- `text` (`max`, default 6000, up to 40,000; `all`), `links` (`word` filters), `shot` (a PNG in
  `<agentCwd>/outbox`).
- `click`, `type`, `press`: act on the page by visible text, label or CSS selector.
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

- Free: `open`, `text`, `links`, `shot`.
- `click`, `type`, `press`: free, unless the step really acts. It asks if the target text has a word
  like send, submit, pay, buy, order, book, delete, publish (several languages), if the page address
  looks like a checkout, or if the key is Enter.
- Reading any page taints the conversation. Then other strong actions ask.

## The rules, in code (`guard.js`)

- Only public `http` and `https` pages. Your machine, home network, VPN ranges and cloud metadata
  addresses are refused. The check also runs after DNS, so a public name that points to
  `127.0.0.1` is refused.
- No credentials in the address.
- The agent never types into password, card, security code or one-time code fields.

## Limits and known issues

- The word list that finds "acting" steps is not perfect. A button with an unusual name may pass.
  Mind the 🌐 prompt when a step asks.
- Pages that need a login by a person must be done by you in a visible window.
- Two logins in one profile can log the first one out. Use one identity for each account.
- The browser tool of the CLI (`bin/browse.js`) is a separate Chrome with a local debugging port
  on 127.0.0.1. It keeps its profile in `~/.assistant/browser/<identity>`.
- Not yet tried with a real login. See [live checks](../live-checks.md).
