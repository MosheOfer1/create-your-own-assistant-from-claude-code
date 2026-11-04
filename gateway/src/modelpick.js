// Which model answers a turn: the everyday one by default (fast, cheap), the strong one when
// the turn needs it. Rules in code, free and instant:
// 1. The owner says so: "opus:" / "think hard" → strong, "sonnet:" → everyday (the prefix is dropped).
// 2. Planning, analysis, comparison, careful writing, code, a long or many-part message, a file.
// After a strong turn the next STICKY_MS stay strong, so "yes, go on" does not drop mid-task
// (and the warm process is not restarted for every switch).

export const STICKY_MS = 10 * 60_000;

const FORCE_STRONG = /^\s*(?:אופוס|opus)\s*[:：,-]\s*/i;
const FORCE_EVERYDAY = /^\s*(?:סונט|sonnet)\s*[:：,-]\s*/i;
const THINK = /תחשוב\s+(?:טוב|לעומק|היטב|ברצינות)|לעומק|תעמיק|בצורה\s+יסודית|\bthink\s+(?:hard|carefully|deeply)\b|\bin\s+depth\b|\bthoroughly\b/i;
// Whole words only. Hebrew words may carry one or two prefix letters (ה ו ב ל מ ש כ): "בקוד" yes, "קודם" no.
const HE = ['תתכנן', 'תכנן', 'תכנית', 'תוכנית', 'אסטרטגי', 'תנתח', 'ניתוח', 'תשווה', 'השוואה', 'מה\\s+עדיף',
  'תחליט', 'תמליץ', 'המלצה', 'יתרונות\\s+וחסרונות', 'תבדוק\\s+לעומק', 'תחקור', 'מחקר',
  'תנסח', 'ניסוח', 'מכתב', 'מייל\\s+רשמי', 'טיוטה', 'קורות\\s+חיים', 'הצעת\\s+מחיר', 'חוזה',
  'קוד', 'סקריפט', 'באג', 'תתקן', 'אקסל\\s+עם', 'נוסחה', 'חישוב'];
const EN = ['plan', 'strategy', 'analy[sz]e', 'analysis', 'compare', 'comparison', 'which\\s+is\\s+better', 'decide',
  'recommend', 'pros\\s+and\\s+cons', 'research', 'draft', 'letter', 'formal\\s+email', 'cv', 'resume', 'quote',
  'contract', 'code', 'script', 'bug', 'debug', 'formula', 'calculate'];
const HARD = new RegExp(`(?:^|[^\\p{L}])(?:[והבלמשכ]{0,2}(?:${HE.join('|')})|(?:${EN.join('|')}))(?=$|[^\\p{L}])`, 'iu');
const LONG = 400;

// → { strong: bool, text (prefix removed), reason }
export function pickModel(text = '', { now = Date.now(), strongUntil = 0, files = 0 } = {}) {
  if (FORCE_STRONG.test(text)) return { strong: true, text: text.replace(FORCE_STRONG, ''), reason: 'asked' };
  if (FORCE_EVERYDAY.test(text)) return { strong: false, text: text.replace(FORCE_EVERYDAY, ''), reason: 'asked' };
  if (THINK.test(text)) return { strong: true, text, reason: 'think' };
  if (now < strongUntil) return { strong: true, text, reason: 'sticky' };
  if (files > 0) return { strong: true, text, reason: 'file' };
  if (text.length > LONG) return { strong: true, text, reason: 'long' };
  if ((text.match(/\n\s*(?:\d+[.)]|[-•*])\s/g) || []).length >= 2) return { strong: true, text, reason: 'list' };
  if (HARD.test(text)) return { strong: true, text, reason: 'hard' };
  return { strong: false, text, reason: 'default' };
}
