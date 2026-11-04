# People

File: `gateway/modules/people/index.js`. The assistant messages other people for you, from its own
WhatsApp number. Every message waits for your yes.

## What it does

- `find`: looks up a person by name or number in the contacts the WhatsApp channel knows, plus
  `<dataDir>/contacts.json` if it is there (`{ "contacts": [{ "phone": "...", "name": "..." }] }`,
  for example imported from an older assistant). A local number (`050…`) also finds `+97250…`.
- `send`: sends a WhatsApp message (and a file from the assistant's own folder, if given) to one number.

## Turn it on

The `whatsapp` channel, and in `config.json`: `"modules": { "people": {} }`.

## What runs freely, what asks

- Free: `find`. It only reads your contacts.
- Always asks: `send`. You see who (name and number), the whole text and the file. Your yes holds
  for exactly that number, text and file, once, for 5 minutes. A file changed after your yes is not sent.

## Limits and known issues

- The message comes from the assistant's number, not yours. Say so in the text when it matters.
- Replies from those people do not reach the assistant: the channel answers only you.
- Files: only from the assistant's own folder, up to 16 MB.
