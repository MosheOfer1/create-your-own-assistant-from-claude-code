# Telegram channel

File: `gateway/src/channels/telegram.js`. It is an optional backup channel. It uses the Telegram
Bot API with long polling. It has no dependencies.

## What it does

- Talks to you through a bot that you make with @BotFather.
- Reads text, captions, voice notes, audio, photos, documents and video.
- Sends text (split in parts of 4000 characters), reactions and a typing sign.
- When WhatsApp is `logged-out` or `down`, the gateway reports it here.

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

The channel has no tools. Only private chats with the paired owner pass.

## Limits and known issues

- Without a token the channel is left out, with a log line. The other channels still run.
- Files (screenshots) go as photos or documents.
- Not yet tried against the real service. See [live checks](../live-checks.md).
