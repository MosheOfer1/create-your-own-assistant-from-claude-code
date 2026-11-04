import zlib from 'node:zlib';

// Word, Excel and PowerPoint files (docx/xlsx/pptx) and their OpenDocument twins (odt/ods/odp)
// → plain text the agent can Read. They are zip files of XML, so this needs no dependency: a small
// zip reader, node:zlib, and a few regular expressions over the XML.

const ENTRY_MAX = 64 << 20; // one inflated XML part; more is a zip bomb, not a document

// A zip in memory → { names, text(name) }. Entries inflate only when asked. No zip64, no encryption.
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const entries = new Map();
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const nameLen = buf.readUInt16LE(p + 28);
    entries.set(buf.toString('utf8', p + 46, p + 46 + nameLen), {
      flags: buf.readUInt16LE(p + 8), method: buf.readUInt16LE(p + 10),
      packed: buf.readUInt32LE(p + 20), size: buf.readUInt32LE(p + 24), local: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  function text(name) {
    const e = entries.get(name);
    if (!e) return '';
    if (e.flags & 1) throw new Error('the file is password protected');
    if (e.size > ENTRY_MAX) throw new Error(`${name} is too big`);
    // The local header's name and extra lengths may differ from the directory's: read them there.
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    const data = buf.subarray(start, start + e.packed);
    if (e.method === 0) return data.toString('utf8');
    if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: ENTRY_MAX }).toString('utf8');
    throw new Error(`zip method ${e.method} is not supported`);
  }
  return { names: [...entries.keys()], text };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] !== '#') return ENTITIES[e] ?? m;
  return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
});
const tidy = (s) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
// Only the text of <tag>…</tag> runs (w:t, a:t) and the line ends and tabs the caller marked with
// NL and TAB: the rest of the XML is layout, field codes and the file's own whitespace.
const NL = '\u0003';
const TAB = '\u0004';
const runs = (xml, tag) => [...xml.replace(new RegExp(`<${tag}(?: [^>]*)?>([^<]*)</${tag}>`, 'g'), '\u0001$1\u0002')
  .matchAll(/\u0001([^\u0002]*)\u0002|[\u0003\u0004]/g)].map((m) => m[1] ?? (m[0] === NL ? '\n' : '\t')).join('');
const attr = (tag, name) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];

// Word: paragraphs as lines, table cells separated by tabs.
function docxText(zip) {
  const body = zip.text('word/document.xml')
    .replace(/<w:tab\/>/g, TAB).replace(/<w:br[^>]*\/>/g, NL)
    .replace(/<\/w:p>(\s*<\/w:tc>)/g, '$1').replace(/<\/w:tc>/g, TAB).replace(/<\/w:tr>/g, NL)
    .replace(/<\/w:p>/g, NL);
  return tidy(decode(runs(body, 'w:t')));
}

// "AB12" → column 27 (0-based).
const colIndex = (ref) => [...ref.replace(/\d+$/, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

// Excel: every sheet as "## name" and its rows, cells separated by tabs. Dates stay serial numbers.
function xlsxText(zip) {
  const tText = (x) => [...x.matchAll(/<t(?: [^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join('');
  const shared = [...zip.text('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decode(tText(m[1])));
  const rels = new Map([...zip.text('xl/_rels/workbook.xml.rels').matchAll(/<Relationship [^>]*>/g)].map((m) => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const out = [];
  for (const m of zip.text('xl/workbook.xml').matchAll(/<sheet [^>]*>/g)) {
    const target = rels.get(attr(m[0], 'r:id')) || '';
    out.push(`## ${decode(attr(m[0], 'name') || '')}`);
    for (const row of zip.text(target.startsWith('/') ? target.slice(1) : `xl/${target}`).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of row[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const type = attr(c[1], 't');
        const v = c[2]?.match(/<v>([^<]*)<\/v>/)?.[1] ?? '';
        let val = type === 's' ? shared[Number(v)] ?? '' : decode(type === 'inlineStr' ? tText(c[2] || '') : v);
        if (type === 'b') val = val === '1' ? 'TRUE' : 'FALSE';
        const ref = attr(c[1], 'r');
        cells[ref ? colIndex(ref) : cells.length] = val.replace(/[\t\n]+/g, ' ');
      }
      if (cells.some(Boolean)) out.push(Array.from(cells, (x) => x ?? '').join('\t'));
    }
    out.push('');
  }
  return tidy(out.join('\n'));
}

// PowerPoint: every slide as "## Slide N" and its lines, in the order of the deck
// (presentation.xml), not the order of the file names, which is the order they were made.
function pptxText(zip) {
  const rels = new Map([...zip.text('ppt/_rels/presentation.xml.rels').matchAll(/<Relationship [^>]*>/g)].map((m) => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  let slides = [...zip.text('ppt/presentation.xml').matchAll(/<p:sldId [^>]*>/g)]
    .map((m) => rels.get(attr(m[0], 'r:id'))).filter(Boolean).map((t) => (t.startsWith('/') ? t.slice(1) : `ppt/${t}`));
  if (!slides.length) {
    slides = zip.names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  }
  return tidy(slides.map((n, i) => `## Slide ${i + 1}\n${decode(runs(zip.text(n).replace(/<a:br\/>/g, NL).replace(/<\/a:p>/g, NL), 'a:t'))}`).join('\n\n'));
}

// OpenDocument text: text sits in the elements, so line ends come from </text:p>, </text:h>.
function odfLines(xml) {
  return decode(xml
    .replace(/<text:tab\/>/g, '\t').replace(/<text:line-break\/>/g, '\n')
    .replace(/<text:s(?: text:c="(\d+)")?\/>/g, (m, n) => ' '.repeat(Math.min(Number(n || 1), 100)))
    .replace(/<\/text:(p|h)>(\s*<\/table:table-cell>)/g, '$2').replace(/<\/table:table-cell>/g, '\t').replace(/<\/table:table-row>/g, '\n')
    .replace(/<\/text:(p|h)>/g, '\n')
    .replace(/<[^>]+>/g, ''));
}
const odfBody = (zip) => zip.text('content.xml').replace(/^[\s\S]*?<office:body>/, '').replace(/<office:annotation[ >][\s\S]*?<\/office:annotation>/g, '');

const odtText = (zip) => tidy(odfLines(odfBody(zip)));

// OpenDocument sheet: like xlsx. A repeated cell counts many columns; an empty one stays empty,
// so a sheet that says "the next 16000 cells are blank" stays small.
function odsText(zip) {
  const out = [];
  for (const t of odfBody(zip).matchAll(/<table:table ([^>]*)>([\s\S]*?)<\/table:table>/g)) {
    out.push(`## ${decode(attr(t[1], 'table:name') || '')}`);
    for (const row of t[2].matchAll(/<table:table-row[^>]*>([\s\S]*?)<\/table:table-row>/g)) {
      const cells = [];
      let col = 0;
      for (const c of row[1].matchAll(/<table:(?:covered-)?table-cell([^>]*?)(?:\/>|>([\s\S]*?)<\/table:(?:covered-)?table-cell>)/g)) {
        const repeat = Number(attr(c[1], 'table:number-columns-repeated') || 1);
        const val = tidy(odfLines(c[2] || '')).replace(/\s*\n\s*/g, ' ').replace(/\t/g, ' ');
        if (val) for (let i = 0; i < Math.min(repeat, 100); i++) cells[col + i] = val;
        col += repeat;
      }
      if (cells.some(Boolean)) out.push(Array.from(cells, (x) => x ?? '').join('\t'));
    }
    out.push('');
  }
  return tidy(out.join('\n'));
}

// OpenDocument slides: every draw:page as "## Slide N"; speaker notes left out, as in pptx.
function odpText(zip) {
  const pages = [...odfBody(zip).matchAll(/<draw:page[ >][\s\S]*?<\/draw:page>/g)];
  return tidy(pages.map((p, i) => `## Slide ${i + 1}\n${tidy(odfLines(p[0].replace(/<presentation:notes[\s\S]*?<\/presentation:notes>/g, '')))}`).join('\n\n'));
}

const KINDS = { docx: docxText, xlsx: xlsxText, pptx: pptxText, odt: odtText, ods: odsText, odp: odpText };
const MIME = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
};

// 'docx' | … | 'odp' | null, by type or (a document often comes as octet-stream) by file name.
export function officeKind(mimetype, name = '') {
  return MIME[mimetype] || (/\.(docx|xlsx|pptx|odt|ods|odp)$/i.exec(name)?.[1].toLowerCase() ?? null);
}

// The text of an office file, cut at maxChars with a note at the end. Throws on a broken file.
export function officeText(buf, kind, maxChars = 1_000_000) {
  const text = KINDS[kind](readZip(buf));
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[… cut here: the text is longer than ${maxChars} characters]` : text;
}
