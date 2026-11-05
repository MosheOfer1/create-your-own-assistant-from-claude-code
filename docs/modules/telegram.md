# Telegram channel

File: `gateway/src/channels/telegram.js`. It is an optional backup channel. It uses the Telegram
Bot API with long polling. It has no dependencies.

## What it does

- Talks to you through a bot that you make with @BotFather.
- Reads what the WhatsApp channel reads, in the same form:
  - text and captions;
  - voice notes and audio (`audio`), photos, documents, video, video notes and GIFs (`file`);
  - quoted replies (the part you quoted, else the text, caption, location or card you replied to);
  - forwarded messages (`forwarded`);
  - locations and venues, live locations, and contacts. See [WhatsApp](whatsapp.md#locations) for
    the text the agent gets.
- A live location's later positions come as edits of its message. They change
  `channel.lastLocation` only. They are never a turn.
- Sends text (split in parts of 4000 characters), reactions and a typing sign.
- Adds ✅ / ❌ buttons to approval requests (see below).
- When WhatsApp is `logged-out` or `down`, the gateway reports it here.

## Approval buttons

1. The router sends an approval request (`t.ask(id, what)` in `i18n.js`). The channel sees it by its
   form: `🔐 <word> #N` on the first line. It adds two buttons to the last part: `✅ yes` and `❌ no`,
   with the words of the request's own language (`כן` / `לא` in Hebrew).
2. You press a button. The channel answers the press at once (Telegram shows ✅ or ❌). Then it passes
   the text you would type, for example `yes 5` or `כן 5`, to the router. The router handles it like
   a typed answer (`approvals.answer`).
3. The router sends its result (`✅ Approved (#5)`, `❌ Denied (#5)`, or a late answer). The channel
   sees it, also when it went out on WhatsApp (`join.js` shows every sent text to the other
   channels: `observe`). The buttons change to one label with the result.

Rules:

- Only the paired owner, in the paired chat, on the request's own message, counts.
- A request that is already decided does not go to the router again. The press shows the result.
- A parked request (`⏳ …`) keeps its buttons, because a late answer still counts.
- The last 50 requests are kept in `<dataDir>/channels.json` (`telegramAsks`), so buttons work after
  a restart.
- The router may pass `send(text, { approvalId })` in the future. Then the channel does not need to
  read the form of the text. `join.js` passes such options through.

## Config keys

```json
"channels": { "telegram": {} }
```

There are no options. List `whatsapp` first and `telegram` second, so WhatsApp is the main channel.
A reply goes to the channel you wrote in last (for 30 minutes). Else it goes to the first channel
that works.

## Pairing

1. Make a bot with @BotFather. Save its token with `setup.js secret TELEGRAM_BOT_TOKEN`.
2. Start the gateway. The log shows `telegram: send "/start <code>" to your bot to connect it`.
3. Send that line to the bot. It answers with ✅. From now on only that chat is heard.

The code works once. The chat id is saved in `<dataDir>/channels.json`.

## Secrets

`TELEGRAM_BOT_TOKEN` in `<dataDir>/.env`. The code never logs URLs, because the token is in them.

## What runs freely, what asks

The channel has no tools. Only private chats with the paired owner pass. A button press is the
owner's answer, the same as typing it.

## Limits and known issues

- Without a token the channel is left out, with a log line. The other channels still run.
- Files (screenshots) go as photos or documents.
- A request that went out on WhatsApp has no buttons here. Buttons appear only on requests sent here.
- The request and result are found by their text form. A reply of the agent that starts like a
  request (`🔐 … #N`) also gets buttons, and one that starts like a result (`✅ … #N`) closes the
  buttons of request N. A press still only types `yes N`. `{ approvalId }` from the router ends this.
- A press on a request that ended without a result text (expired, or stopped with "stop") reaches the
  router as `yes N`. The router finds no open request N and treats it as a normal message.
- A bot cannot write first to other people, so `sendTo` is WhatsApp only.
