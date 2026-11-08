// The agent writes Markdown; WhatsApp shows it as raw signs. This turns the common parts into
// WhatsApp's own marks and drops what only clutters a phone chat:
// - **bold** / __bold__ → *bold*, # Heading → *Heading*, ~~x~~ → ~x~
// - [label](url) → "label url" (the bare url when the label is the url), <url> → url
// - a "Sources:" block at the end (the web search tool asks for it) is dropped
// Code blocks and inline code stay as they are (WhatsApp shows ``` too).
export function waText(text) {
  if (!text) return text;
  const parts = String(text).split(/(```[\s\S]*?```)/);
  const out = parts.map((p, i) => (i % 2 ? p : plain(p))).join('');
  return dropSources(out).replace(/\n{3,}/g, '\n\n').trim();
}

function plain(s) {
  return s
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => (sameUrl(label, url) ? url : `${label} ${url}`))
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, '*$1*')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/(^|[^\w])__(.+?)__(?=[^\w]|$)/g, '$1*$2*')
    .replace(/~~(.+?)~~/g, '~$1~')
    .replace(/^(\s*)[-*]\s+/gm, '$1• ')
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, '');
}

const bare = (u) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
const sameUrl = (label, url) => bare(label.trim()) === bare(url);

// "Sources: ..." (or "מקורות:") as the last paragraph: one line, or a list under it.
function dropSources(s) {
  return s.replace(/\n+\s*\*?(Sources|מקורות)\*?:[^\n]*(\n\s*(•|\d+\.)[^\n]*)*\s*$/i, '');
}
