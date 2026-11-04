# Email

Folder: `gateway/modules/email/`. It reads and searches your mailbox over IMAP. It writes drafts.
It sends mail over SMTP, but only after you approve.

## What it does

- `search`: finds mail, newest first. On Gmail it uses Gmail search words (`from:x newer_than:7d is:unread`).
  On other servers it looks in subject, sender and body.
- `read`: shows headers, the text (first 20,000 characters) and the list of attachments.
- `save_attachment`: saves an attachment to `<agentCwd>/inbox` so the agent can read it.
- `draft`: saves a draft in your Drafts folder. Nothing is sent.
- `send`: sends one mail. For a reply, give `reply_to_uid` to keep the thread.
- Triage: every `watchMin` minutes the gateway looks for new unread mail. Only sender and subject
  go to a small model with no tools. You hear only about mail that needs you (a person waiting,
  a bill, a deadline, a security alert). The line starts with 📧.

## Config keys (`modules.email`)

```json
"modules": { "email": { "user": "dana@example.com", "watchMin": 60 } }
```

- `user`: the address. Required.
- `watchMin`: minutes between checks. Default 60. `0` turns triage off.
- `imapHost`, `imapPort` (993), `smtpHost`, `smtpPort` (465): needed only for providers other than
  Gmail, Googlemail, Outlook and Hotmail. Those four are known.

## Secrets

`EMAIL_APP_PASSWORD`: an app password, not your normal password. For Gmail, turn on 2-Step
Verification first, then make one at your Google account, App passwords. You can revoke it any time.
Save it with `setup.js secret EMAIL_APP_PASSWORD`. The agent never sees it.

## What runs freely, what asks

- Free: `search`, `read`, `save_attachment`, `draft`.
- Asks: `send`. You see the recipient, Cc, subject and the start of the text.
  Your "yes" opens a ticket for exactly that mail. The ticket works once and ends after 5 minutes.
  If the agent changes one word, the ticket does not fit and the send fails.
- `search`, `read` and `save_attachment` taint the conversation, because the mail was written by others.

## Limits and known issues

- First triage run only remembers the newest mail. It does not report old mail.
- One triage looks at 20 mails at most. `search` returns 50 at most.
- Mail is sent as plain text. No HTML, and no attachments on send.
- Triage needs the password. Without it the check does not start.
- Not yet tried with a real mailbox. See [live checks](../live-checks.md).
