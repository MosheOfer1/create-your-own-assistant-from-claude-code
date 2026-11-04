import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, describe, test } from 'node:test';
import media from '../modules/media/index.js';
import { officeKind, officeText, readZip } from '../modules/media/office.js';

const tmps = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'media-office-')); tmps.push(d); return d; };
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); });

// A tiny zip writer: { name: text } → Buffer. Deflated entries, or stored with { store: true }.
function zip(files, { store = false, encrypt = false } = {}) {
  const locals = [];
  const dir = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const data = store ? raw : zlib.deflateRawSync(raw);
    const n = Buffer.from(name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(encrypt ? 1 : 0, 6);
    head.writeUInt16LE(store ? 0 : 8, 8);
    head.writeUInt32LE(zlib.crc32(raw), 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(encrypt ? 1 : 0, 8);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(zlib.crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(head, n, data);
    dir.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(dir);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(dir.length / 2, 8);
  end.writeUInt16LE(dir.length / 2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const DOCX = zip({
  'word/document.xml': '<?xml version="1.0"?><w:document><w:body>'
    + '<w:p><w:r><w:t>שלום</w:t></w:r><w:r><w:t xml:space="preserve"> world &amp; you</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r><w:r><w:instrText>PAGE</w:instrText></w:r></w:p>'
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>x1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>y1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    + '</w:body></w:document>',
});

const XLSX = zip({
  'xl/workbook.xml': '<workbook><sheets><sheet name="Costs &amp; more" sheetId="1" r:id="rId1"/><sheet name="Two" sheetId="2" r:id="rId2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="/xl/worksheets/b.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>Item</t></si><si><r><t>Pri</t></r><r><t xml:space="preserve">ce</t></r></si><si><t>חלב</t></si></sst>',
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>7.5</v></c></row>'
    + '<row r="3"><c r="A3" t="b"><v>1</v></c><c r="B3" t="inlineStr"><is><t>in line</t></is></c></row>'
    + '<row r="4"><c r="A4"/></row>'
    + '</sheetData></worksheet>',
  'xl/worksheets/b.xml': '<worksheet><sheetData><row r="1"><c r="AA1" t="str"><v>far</v></c></row></sheetData></worksheet>',
});

// Slide files made in one order, the deck shows them in another.
const PPTX = zip({
  'ppt/presentation.xml': '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>',
  'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>',
  'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Made first</a:t></a:r></a:p></p:sld>',
  'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Shown first</a:t></a:r><a:br/><a:r><a:t>second line</a:t></a:r></a:p><a:p><a:r><a:t>&lt;b&gt;</a:t></a:r></a:p></p:sld>',
});

const ODF = (body) => `<?xml version="1.0"?><office:document-content><office:automatic-styles><style:style style:name="P1">STYLE</style:style></office:automatic-styles><office:body>${body}</office:body></office:document-content>`;
const ODT = zip({ mimetype: 'application/vnd.oasis.opendocument.text', 'content.xml': ODF(
  '<office:text><text:h text:outline-level="1">Title</text:h><text:p>one<text:s text:c="3"/>two<text:tab/>three<text:line-break/>four</text:p>'
  + '<text:p>note<office:annotation><text:p>hidden comment</text:p></office:annotation> here</text:p>'
  + '<table:table table:name="T"><table:table-row><table:table-cell><text:p>c1</text:p></table:table-cell><table:table-cell><text:p>c2</text:p></table:table-cell></table:table-row></table:table>'
  + '</office:text>') }, { store: true });
const ODS = zip({ 'content.xml': ODF(
  '<office:spreadsheet><table:table table:name="Sheet A"><table:table-column table:number-columns-repeated="3"/>'
  + '<table:table-row><table:table-cell office:value-type="string"><text:p>name</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"><text:p>x</text:p></table:table-cell><table:table-cell table:number-columns-repeated="16380"/></table:table-row>'
  + '<table:table-row table:number-rows-repeated="1000"><table:table-cell table:number-columns-repeated="16384"/></table:table-row>'
  + '<table:table-row><table:table-cell table:number-columns-repeated="2"/><table:table-cell office:value-type="float" office:value="3"><text:p>3</text:p></table:table-cell></table:table-row>'
  + '</table:table></office:spreadsheet>') });
const ODP = zip({ 'content.xml': ODF(
  '<office:presentation><draw:page draw:name="p1"><draw:frame><draw:text-box><text:p>Hello</text:p></draw:text-box></draw:frame><presentation:notes><text:p>speaker notes</text:p></presentation:notes></draw:page>'
  + '<draw:page draw:name="p2"><draw:frame><draw:text-box><text:p>Bye</text:p></draw:text-box></draw:frame></draw:page></office:presentation>') });

describe('readZip', () => {
  test('stored and deflated entries; a missing one is empty', () => {
    for (const store of [true, false]) {
      const z = readZip(zip({ 'a.xml': 'hello', 'b/c.xml': 'שלום' }, { store }));
      assert.deepEqual(z.names, ['a.xml', 'b/c.xml']);
      assert.equal(z.text('b/c.xml'), 'שלום');
      assert.equal(z.text('none.xml'), '');
    }
  });
  test('not a zip, or password protected: a clear error', () => {
    assert.throws(() => readZip(Buffer.from('just text, no zip at all here')), /not a zip file/);
    assert.throws(() => readZip(zip({ 'a.xml': 'x' }, { encrypt: true })).text('a.xml'), /password protected/);
  });
});

describe('officeText', () => {
  test('docx: paragraphs as lines, tabs, breaks, table cells, entities; field codes left out', () => {
    assert.equal(officeText(DOCX, 'docx'), 'שלום world & you\na\tb\nc\nx1\ty1');
  });
  test('xlsx: sheets by name, shared, rich, inline and bool cells, columns by reference', () => {
    assert.equal(officeText(XLSX, 'xlsx'), '## Costs & more\nItem\tPrice\nחלב\t\t7.5\nTRUE\tin line\n\n## Two\n' + '\t'.repeat(26) + 'far');
  });
  test('pptx: slides in the order of the deck', () => {
    assert.equal(officeText(PPTX, 'pptx'), '## Slide 1\nShown first\nsecond line\n<b>\n\n## Slide 2\nMade first');
  });
  test('pptx without presentation.xml: slides by number', () => {
    const z = zip({ 'ppt/slides/slide10.xml': '<a:p><a:t>ten</a:t></a:p>', 'ppt/slides/slide2.xml': '<a:p><a:t>two</a:t></a:p>' });
    assert.equal(officeText(z, 'pptx'), '## Slide 1\ntwo\n\n## Slide 2\nten');
  });
  test('odt: headings and paragraphs, spaces, tabs, line breaks, tables; styles and comments left out', () => {
    assert.equal(officeText(ODT, 'odt'), 'Title\none   two\tthree\nfour\nnote here\nc1\tc2');
  });
  test('ods: repeated cells count columns; empty repeats stay small', () => {
    const text = officeText(ODS, 'ods');
    assert.equal(text, '## Sheet A\nname\tx\tx\n\t\t3');
  });
  test('odp: pages as slides, speaker notes left out', () => {
    assert.equal(officeText(ODP, 'odp'), '## Slide 1\nHello\n\n## Slide 2\nBye');
  });
  test('long text is cut with a note', () => {
    const big = zip({ 'word/document.xml': `<w:p><w:t>${'a'.repeat(5000)}</w:t></w:p>` });
    const text = officeText(big, 'docx', 1000);
    assert.ok(text.startsWith('a'.repeat(1000) + '\n\n[… cut here'));
    assert.ok(text.length < 1100);
  });
});

describe('officeKind', () => {
  test('by type, else by name', () => {
    assert.equal(officeKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'docx');
    assert.equal(officeKind('application/vnd.oasis.opendocument.spreadsheet'), 'ods');
    assert.equal(officeKind('application/octet-stream', 'Report.PPTX'), 'pptx');
    assert.equal(officeKind('application/octet-stream', 'old.doc'), null);
    assert.equal(officeKind('application/pdf', 'a.pdf'), null);
  });
});

describe('media module: office files', () => {
  function setup(opts = {}) {
    const agentCwd = tmp();
    const lines = [];
    const mod = media({ agentCwd, dataDir: tmp(), language: 'en', transcriber: 'off', ...opts }, { log: (l) => lines.push(l) });
    mod.start({ async send() {} });
    mod.stop();
    return { mod, lines, inbox: path.join(agentCwd, 'inbox') };
  }
  const doc = (buf, o = {}, text = '') => ({ text, file: { name: 'report.docx', mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: buf.length, download: async () => buf, ...o } });

  test('the text goes to <file>.txt beside it; the turn points to the .txt', async () => {
    const s = setup();
    const p = await s.mod.media(doc(DOCX, {}, 'summarise'));
    const m = /^\[The owner sent a file: (\S+-report\.docx) \(application\/vnd[^,]+, 1 KB\)\. Its text is in (\S+): Read that if the task needs it\.\]\nsummarise$/.exec(p);
    assert.ok(m, p);
    assert.equal(m[2], `${m[1]}.txt`);
    assert.equal(path.dirname(m[2]), s.inbox);
    assert.equal(fs.readFileSync(m[2], 'utf8'), 'שלום world & you\na\tb\nc\nx1\ty1');
    assert.ok(fs.existsSync(m[1]));
  });

  test('an xlsx sent as octet-stream is found by its name; maxTextKB caps the .txt', async () => {
    const s = setup({ maxTextKB: 0.01 });
    const p = await s.mod.media(doc(XLSX, { name: 'costs.xlsx', mimetype: 'application/octet-stream' }));
    const txt = /Its text is in (\S+):/.exec(p)[1];
    assert.match(fs.readFileSync(txt, 'utf8'), /^## Costs &\n\n\[… cut here/);
  });

  test('a broken file is still saved; the turn and the log say why there is no text', async () => {
    const s = setup();
    const p = await s.mod.media(doc(Buffer.from('not really a docx')));
    assert.match(p, /^\[The owner sent a file: \S+-report\.docx \([^)]+\)\. Its text could not be taken out \(not a zip file\)\.\]$/);
    assert.equal(fs.readdirSync(s.inbox).length, 1);
    assert.ok(s.lines.some((l) => /no text from .*report\.docx: not a zip file/.test(l)));
  });

  test('a nameless pptx gets file.pptx', async () => {
    const s = setup();
    await s.mod.media(doc(PPTX, { name: '', mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }));
    assert.deepEqual(fs.readdirSync(s.inbox).map((n) => n.replace(/^\d{8}T\d{6}-/, '')).sort(), ['file.pptx', 'file.pptx.txt']);
  });
});
