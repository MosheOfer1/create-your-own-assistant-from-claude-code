# WhatsApp channel

File: `gateway/src/channels/whatsapp.js`. It uses the Baileys library. The assistant is a linked
device on its own number. You write to it like to any contact.

## What it does

- Passes only the owner's direct messages. Everything else is dropped in this file.
- Reads text, captions, quoted text, forwarded flags, voice notes and files.
- Sends text, images, audio and documents. Shows 👀 reactions and a typing sign.
- Keeps the chat the owner last wrote from. It also knows the owner's LID chat id.
- Ignores messages older than the start time (minus 60 seconds).

## Config keys

```json
"channels": { "whatsapp": { "assistantNumber": "+15550100", "ownerNumber": "+15550101" } }
```

- `assistantNumber`: the number the gateway links to. Needed for the pairing code.
- `ownerNumber`: the only person the assistant listens to. Required.

Use the international format. The login files are in `<dataDir>/whatsapp-auth`.

## Pairing

1. On the assistant's phone: WhatsApp, Linked devices, Link with phone number instead.
2. Run `node gateway/bin/setup.js whatsapp`. It prints `pairing code: XXXX-XXXX`.
3. Type the code on the phone. The tool prints `linked`.

Keep the default Baileys browser name. A custom name makes WhatsApp reject pairing codes.

## Secrets

None in the environment. The login files in `whatsapp-auth` are secrets. Keep them out of git.

## What runs freely, what asks

The channel has no tools. The owner's messages always pass. Messages from other people do not.

## Limits and known issues

- Open WhatsApp on the assistant's phone at least every 14 days. Else WhatsApp unlinks the device
  (status `logged-out`). Then you need a new pairing code.
- After 10 minutes without a connection the status is `down`. The gateway then writes to you on
  another channel, if there is one.
- Group chats are ignored.
- Messages of a kind the code does not read get a short "cannot read this" reply.
- Not yet tried against the real service. See [live checks](../live-checks.md).
