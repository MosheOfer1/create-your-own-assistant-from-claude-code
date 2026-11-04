// The gateway's own lines to the owner. The assistant itself answers in any language
// (the system prompt tells it which); these few fixed lines need a translation here.
// A missing language falls back to English. Add a language: copy `en` and translate.
const STRINGS = {
  en: {
    ask: (id, what) => `🔐 Request #${id}\n${what}\n\nReply: yes / no`,
    allowed: (id) => `✅ Approved (#${id})`,
    denied: (id) => `❌ Denied (#${id})`,
    parked: (id, h) => `⏳ Request #${id} waits for you ${h} more hours. Reply "yes ${id}" and I will do it.`,
    lateYes: (id) => `✅ You approved request #${id}. Doing it now.`,
    lateNo: (id) => `❌ You denied request #${id}. I will not do it.`,
    stopped: '⏹️ Stopped.',
    idle: 'Nothing is running right now.',
    newSession: '🆕 Started a new conversation.',
    status: (s) => `Waiting for approval: ${s.pending}\nWorking now: ${s.busy ? 'yes' : 'no'}\nSince the last turn: ${s.idle}`,
    resumed: '🔄 I restarted in the middle of a task. Going on from where I stopped.',
    error: (m) => `Error: ${m}`,
    empty: '(empty)',
    unsupported: 'I cannot read this kind of message yet. Please write text.',
    taint: '🟠 This conversation holds text someone else wrote (an email, a page or a file), so I ask.\n',
    runCommand: 'Run a command:',
    changeFile: 'Change a file:',
    waLoggedOut: '⚠️ WhatsApp logged the assistant out. Open the assistant\'s setup and link WhatsApp again (a new pairing code). Tip: open WhatsApp on the assistant\'s phone at least every 14 days.',
    waDown: '⚠️ The assistant has had no WhatsApp connection for 10 minutes. I keep trying. Is the machine online?',
    waBack: '✅ WhatsApp is connected again.',
  },
  he: {
    ask: (id, what) => `🔐 בקשה #${id}\n${what}\n\nלענות: כן / לא`,
    allowed: (id) => `✅ אושר (#${id})`,
    denied: (id) => `❌ נדחה (#${id})`,
    parked: (id, h) => `⏳ בקשה #${id} מחכה לך עוד ${h} שעות. כשתענה "כן ${id}" אבצע אותה.`,
    lateYes: (id) => `✅ אישרת את בקשה #${id}. מבצע עכשיו.`,
    lateNo: (id) => `❌ דחית את בקשה #${id}. לא אבצע אותה.`,
    stopped: '⏹️ עצרתי.',
    idle: 'אין כרגע משהו שרץ.',
    newSession: '🆕 התחלתי שיחה חדשה.',
    status: (s) => `ממתינים לאישור: ${s.pending}\nעובד עכשיו: ${s.busy ? 'כן' : 'לא'}\nמאז התור האחרון: ${s.idle}`,
    resumed: '🔄 הופעלתי מחדש באמצע משימה. ממשיך מאיפה שעצרתי.',
    error: (m) => `שגיאה: ${m}`,
    empty: '(ריק)',
    unsupported: 'עדיין לא יודע לקרוא סוג הודעה כזה. תכתוב לי טקסט.',
    taint: '🟠 בשיחה יש טקסט שמישהו אחר כתב (מייל, אתר או קובץ), לכן אני שואל.\n',
    runCommand: 'להריץ פקודה:',
    changeFile: 'לשנות קובץ:',
    waLoggedOut: '⚠️ וואטסאפ ניתק את העוזר. צריך לחבר אותו מחדש בהקמה (קוד צימוד חדש). טיפ: לפתוח את וואטסאפ בטלפון של העוזר לפחות פעם ב-14 יום.',
    waDown: '⚠️ אין לעוזר חיבור לוואטסאפ כבר 10 דקות. אני ממשיך לנסות. המחשב מחובר לרשת?',
    waBack: '✅ וואטסאפ מחובר שוב.',
  },
};

export function strings(language = 'en') {
  return { ...STRINGS.en, ...(STRINGS[String(language).slice(0, 2)] || {}) };
}

// Yes / no words in every language we know, so an answer in any of them counts.
export const YES = ['yes', 'y', 'ok', 'approve', 'כן', 'אשר', 'מאשר', 'אישור', 'sí', 'si', 'oui', 'ja', 'да', 'نعم', '✅', '👍'];
export const NO = ['no', 'n', 'deny', 'לא', 'דחה', 'non', 'nein', 'нет', 'لا', '❌', '👎'];
export const STOP = ['stop', '/stop', 'עצור', 'תעצור', 'stopp', 'стоп'];
export const NEW = ['/new', 'new chat', 'שיחה חדשה'];
