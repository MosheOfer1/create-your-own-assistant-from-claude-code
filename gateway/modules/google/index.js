// Gmail, Google Calendar and Google Drive through the claude.ai connectors of the Claude account
// the assistant is logged in with (connect them once at claude.ai → Settings → Connectors).
// No Google password or token on this machine: the connectors live in the Claude account.
//
// claude -p loads connectors only with the user's own settings (--setting-sources user) and
// without --strict-mcp-config. Run as the owner's own user, that would load the owner's
// ~/.claude again (CLAUDE.md, allow rules, hooks). So this module works only when the gateway
// runs as its own user (bin/own-user.js), whose ~/.claude is its own and empty.

const G = 'mcp__claude_ai_Gmail__';
const C = 'mcp__claude_ai_Google_Calendar__';
const D = 'mcp__claude_ai_Google_Drive__';

// Reading: free. What it reads was written by others, so it taints the conversation.
const READ = [
  ...['search_threads', 'get_thread', 'get_message', 'list_labels', 'list_drafts', 'get_draft'].map((t) => G + t),
  ...['list_calendars', 'list_events', 'get_event', 'search_events', 'suggest_time'].map((t) => C + t),
  ...['search_files', 'get_file_metadata', 'get_file_permissions', 'read_file_content', 'list_recent_files', 'download_file_content'].map((t) => D + t),
];

// Changes inside the owner's own account that reach nobody: free in a clean conversation.
const OWN = new RegExp(`^(${G}(create_draft|update_draft|delete_draft|label_message|label_thread|unlabel_message|unlabel_thread|update_message_labels|create_label|update_label|mark_message_spam|mark_thread_spam|unmark_message_spam|unmark_thread_spam|untrash_message|untrash_thread)|${D}(create_file|copy_file|update_file))$`);
const EVENT_WRITE = new RegExp(`^${C}(create_event|update_event)$`);

// An event only for the owner: no guests, no updates sent. With guests it invites people: it asks.
export function privateEvent(input = {}) {
  const guests = JSON.stringify([input.attendees, input.guests, input.event?.attendees].filter(Boolean));
  const notify = JSON.stringify([input.sendUpdates, input.send_updates, input.sendNotifications].filter(Boolean));
  return !guests.includes('@') && !/all|externalOnly|true/i.test(notify);
}

export default function google(config, { log = console.log } = {}) {
  if (!config.ownUser) {
    log('google: off. The connectors need the gateway to run as its own user (bin/own-user.js).');
    return {};
  }
  return {
    claudeAi: true, // the agent loads the account's connectors (agent.js)
    allowed: READ,
    untrusted: [/^mcp__claude_ai_(Gmail|Google_Calendar|Google_Drive)__/],
    // Always the owner's yes, whatever else says: mail out, sharing, deleting events, answering invites.
    gated: [new RegExp(`^${G}(send_message|send_draft|reply|forward)$`), new RegExp(`^${D}share_file$`), new RegExp(`^${C}(delete_event|respond_to_event)$`)],
    autoAllow: (tool, input, { tainted } = {}) => !tainted && (OWN.test(tool) || (EVENT_WRITE.test(tool) && privateEvent(input))),
    prompt: '## Google\nThe owner\'s Gmail, Calendar and Drive are connected (mcp__claude_ai_Gmail__*, mcp__claude_ai_Google_Calendar__*, mcp__claude_ai_Google_Drive__*). '
      + 'Read freely. Drafts, labels, own files and events without guests need no approval; sending, sharing, inviting and answering invites ask the owner.',
  };
}
