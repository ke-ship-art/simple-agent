import { extname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { Inflate, zipSync, strFromU8, strToU8 } from 'fflate';
import { DOMParser, XMLSerializer, type Document as XmlDocument, type Element as XmlElement } from '@xmldom/xmldom';
import { PDFDocument, PDFName, PDFHexString, PDFString, StandardFonts, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { reviewPatch } from './diff';
import { Files, hash } from './workspace';
import type { ChangeSet, ExcelDocument, FileOperation, OpenDocument, SheetCell, WordBlock, WordDocument } from '../shared/types';
import { invalidateFormulaCaches } from './spreadsheet-dependencies';
export { paginateExcel } from './spreadsheet-dependencies';

const serializer = new XMLSerializer();
const elements = (parent: XmlDocument | XmlElement, name: string): XmlElement[] => Array.from(parent.getElementsByTagNameNS('*', name));
const first = (parent: XmlDocument | XmlElement, name: string) => elements(parent, name)[0];
function xml(text: string): XmlDocument {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('不支持含外部实体的文档');
  return new DOMParser({ onError: (level, message) => { if (level !== 'warning') throw new Error(`文档 XML 错误：${message}`); } }).parseFromString(text, 'application/xml');
}
export function unpack(bytes: Uint8Array) {
  // Parse the actual central directory, never signatures embedded in compressed data.
  // Inflate in bounded chunks and verify actual sizes as metadata can be forged.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65558) && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0 || end < bytes.length - 65558) throw new Error('办公文档 ZIP 目录无效');
  const count = view.getUint16(end + 10, true), directorySize = view.getUint32(end + 12, true), directory = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count === 65535 || directorySize === 0xffffffff || directory === 0xffffffff) throw new Error('不支持多卷或 ZIP64 办公文件');
  if (!count || count > 10000 || directory + directorySize !== end || end + 22 + view.getUint16(end + 20, true) !== bytes.length) throw new Error('文档解压目录或条目数量超出限制');
  let total = 0, i = directory;
  const manifest: { name: string; size: number; compressed: number; method: number; offset: number }[] = [], names = new Set<string>();
  for (let n = 0; n < count; n++) {
    if (i + 46 > end || view.getUint32(i, true) !== 0x02014b50) throw new Error('文档 ZIP 条目无效');
    const size = view.getUint32(i + 24, true), compressed = view.getUint32(i + 20, true), method = view.getUint16(i + 10, true), offset = view.getUint32(i + 42, true);
    total += size;
    if (view.getUint16(i + 8, true) & 1) throw new Error('不支持加密的办公文件');
    const nameLen = view.getUint16(i + 28, true), extraLen = view.getUint16(i + 30, true), commentLen = view.getUint16(i + 32, true);
    if (i + 46 + nameLen + extraLen + commentLen > end) throw new Error('文档 ZIP 目录越界');
    const name = strFromU8(bytes.slice(i + 46, i + 46 + nameLen));
    if (name.split('/').includes('..') || name.startsWith('/') || name.includes('\\') || name.includes('\0') || names.has(name)) throw new Error('文档包包含非法或重复路径');
    if (total > 64 * 1024 * 1024 || size > 32 * 1024 * 1024 || (method !== 0 && method !== 8)) throw new Error('文档解压大小或压缩类型超出限制（总计 64 MB、单个部件 32 MB）');
    if (offset + 30 > directory || view.getUint32(offset, true) !== 0x04034b50) throw new Error('文档 ZIP 本地条目无效');
    const start = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    if (start + compressed > directory || view.getUint16(offset + 8, true) !== method || strFromU8(bytes.slice(offset + 30, offset + 30 + view.getUint16(offset + 26, true))) !== name) throw new Error('文档 ZIP 本地目录与中央目录不一致');
    names.add(name); manifest.push({ name, size, compressed, method, offset: start });
    i += 46 + nameLen + extraLen + commentLen;
  }
  if (i !== end) throw new Error('文档 ZIP 目录长度不一致');
  if ([...names].some(name => /_xmlsignatures|vbaProject/i.test(name))) throw new Error('签名或宏文档仅支持在原办公软件中编辑');
  const parts: Record<string, Uint8Array> = Object.create(null);
  for (const entry of manifest) {
    const input = bytes.subarray(entry.offset, entry.offset + entry.compressed);
    if (entry.method === 0) { if (input.length !== entry.size) throw new Error('文档解压大小与元数据不一致'); parts[entry.name] = input.slice(); continue; }
    const chunks: Uint8Array[] = []; let length = 0;
    const stream = new Inflate((chunk) => { length += chunk.length; if (length > entry.size || length > 32 * 1024 * 1024) throw new Error('文档解压大小与元数据不一致'); chunks.push(chunk); });
    for (let at = 0; at < input.length; at += 4096) stream.push(input.subarray(at, at + 4096), at + 4096 >= input.length);
    if (length !== entry.size) throw new Error('文档解压大小与元数据不一致');
    const output = new Uint8Array(length); let at = 0; for (const chunk of chunks) { output.set(chunk, at); at += chunk.length; } parts[entry.name] = output;
  }
  return parts;
}
function getXml(parts: Record<string, Uint8Array>, name: string) {
  if (!parts[name]) throw new Error(`文档缺少 ${name}`);
  return xml(strFromU8(parts[name]));
}
function validText(text: string) {
  for (const ch of text) { const point = ch.codePointAt(0)!; if (point >= 0xd800 && point <= 0xdfff || point < 32 && ![9, 10, 13].includes(point) || point === 0xfffe || point === 0xffff) throw new Error(`文本包含无效 Unicode/XML 字符 U+${point.toString(16).toUpperCase()}`); }
}
function wordTokens(p: XmlElement) {
  const tokens: { node: XmlElement; text: string; style: string }[] = [];
  const walk = (node: XmlElement) => {
    const name = node.localName;
    if (node.namespaceURI === W && ['t', 'tab', 'br', 'cr', 'noBreakHyphen', 'softHyphen'].includes(name ?? '')) {
      let run = node.parentNode as XmlElement | null; while (run && run.localName !== 'r') run = run.parentNode as XmlElement | null;
      const rPr = run && first(run, 'rPr');
      let container = run?.parentNode as XmlElement | null;
      const link = container?.localName === 'hyperlink' ? serializer.serializeToString(container.cloneNode(false)) : '';
      tokens.push({ node, text: name === 't' ? node.textContent ?? '' : name === 'tab' ? '\t' : name === 'noBreakHyphen' ? '\u2011' : name === 'softHyphen' ? '\u00ad' : '\n', style: (rPr ? serializer.serializeToString(rPr) : '') + link }); return;
    }
    for (const child of Array.from(node.childNodes)) if (child.nodeType === 1) walk(child as XmlElement);
  }; walk(p); return tokens;
}
function paragraphText(p: XmlElement) { return wordTokens(p).map(t => t.text).join(''); }
function wordBlocks(doc: XmlDocument): { p: XmlElement; block: WordBlock }[] {
  return Array.from(doc.getElementsByTagNameNS(W, 'p')).map((p, index) => {
    let parent = p.parentNode, cell = false, protectedAncestor = false;
    while (parent) {
      if (parent.nodeType === 1) {
        const name = (parent as XmlElement).localName ?? '';
        if (name === 'tc') cell = true;
        if (['ins', 'del', 'sdt', 'moveFrom', 'moveTo', 'drawing', 'object', 'txbxContent', 'AlternateContent'].includes(name)) protectedAncestor = true;
      }
      parent = parent.parentNode;
    }
    const unknownRunContent = elements(p, 'r').some(r => Array.from(r.childNodes).some(child => child.nodeType === 1 && !['rPr', 't', 'tab', 'br', 'cr', 'noBreakHyphen', 'softHyphen', 'lastRenderedPageBreak'].includes((child as XmlElement).localName ?? '')));
    const unsafe = protectedAncestor || unknownRunContent || ['fldChar', 'fldSimple', 'instrText', 'ins', 'del', 'moveFrom', 'moveTo', 'sdt', 'oMath', 'object', 'drawing', 'sym', 'ruby', 'altChunk', 'smartTag', 'customXml', 'footnoteReference', 'endnoteReference', 'AlternateContent'].some(tag => elements(p, tag).length) || elements(p, 'br').some(br => br.getAttributeNS(W, 'type') && br.getAttributeNS(W, 'type') !== 'textWrapping');
    const runs = elements(p, 'r').map(r => { const properties = first(r, 'rPr'); const enabled = (name: string) => { const node = properties && first(properties, name); return node && !['0', 'false', 'off', 'none'].includes(node.getAttributeNS(W, 'val') ?? '') ? true : undefined; }; return { text: paragraphText(r), bold: enabled('b'), italic: enabled('i'), underline: enabled('u') }; });
    return { p, block: { id: `p:${index}`, type: cell ? 'table-cell' : 'paragraph', text: paragraphText(p), editable: !unsafe, reason: unsafe ? '此段落包含域、修订、特殊字符对象或复杂结构，已保留原结构' : undefined, runs, style: first(p, 'pStyle')?.getAttributeNS(W, 'val') ?? undefined } };
  });
}
function writeWordToken(node: XmlElement, value: string) {
  const parent = node.parentNode!, doc = node.ownerDocument!;
  const parts = value.split(/([\t\n])/);
  for (const part of parts) {
    if (!part) continue;
    const next = doc.createElementNS(W, part === '\t' ? 'w:tab' : part === '\n' ? 'w:br' : 'w:t');
    if (part !== '\t' && part !== '\n') { next.textContent = part; next.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve'); }
    parent.insertBefore(next, node);
  }
  parent.removeChild(node);
}
function replaceWord(p: XmlElement, oldText: string, newText: string, stylePolicy: 'preserve' | 'first-run' = 'preserve') {
  validText(oldText); validText(newText); newText = newText.replace(/\r\n?/g, '\n');
  const tokens = wordTokens(p);
  const full = paragraphText(p);
  if (!oldText) {
    if (full) throw new Error('空文本只能用于空段落');
    let t = tokens[0]?.node;
    if (!t) { const r = p.ownerDocument!.createElementNS(p.namespaceURI, 'w:r'); t = p.ownerDocument!.createElementNS(p.namespaceURI, 'w:t'); r.appendChild(t); p.appendChild(r); }
    writeWordToken(t, newText); return '保留原格式';
  }
  const at = full.indexOf(oldText);
  if (at < 0 || full.indexOf(oldText, at + 1) >= 0) throw new Error('原文不存在或出现多次，请重新读取并提供唯一原文');
  const end = at + oldText.length;
  let offset = 0;
  const affected = tokens.flatMap(token => { const start = offset; offset += token.text.length; if (offset <= at || start >= end) return []; return [{ ...token, start, overlap: token.text.slice(Math.max(0, at - start), Math.min(token.text.length, end - start)) }]; });
  const equal = [...oldText].length === [...newText].length;
  if (stylePolicy === 'preserve' && !equal && new Set(affected.map(t => t.style)).size > 1) throw new Error('替换跨越不同文字格式且长度变化，无法自动无损分配样式。请分段替换，或明确设置 stylePolicy="first-run"；文件未修改');
  const replacement = [...newText]; let cursor = 0, inserted = false;
  for (const token of affected) {
    const { text, start, node } = token;
    const left = text.slice(0, Math.max(0, at - start));
    const right = text.slice(Math.max(0, end - start));
    const count = [...token.overlap].length;
    const chunk = equal && stylePolicy === 'preserve' ? replacement.slice(cursor, cursor + count).join('') : inserted ? '' : newText;
    cursor += count; writeWordToken(node, left + chunk + right); inserted = true;
  }
  return stylePolicy === 'first-run' && new Set(affected.map(t => t.style)).size > 1 ? '显式 first-run：替换文字采用首个受影响 run 的格式；其余内容及格式保留' : '保留各原 run 格式';
}
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function sheetParts(parts: Record<string, Uint8Array>) {
  const workbook = getXml(parts, 'xl/workbook.xml');
  const relationships = getXml(parts, 'xl/_rels/workbook.xml.rels');
  return elements(workbook, 'sheet').map(sheet => {
    const id = sheet.getAttributeNS(R, 'id')!;
    const rel = elements(relationships, 'Relationship').find(r => r.getAttribute('Id') === id);
    const target = rel?.getAttribute('Target') ?? '';
    if (!target || target.includes('..') || rel?.getAttribute('TargetMode') === 'External') throw new Error('不支持外部工作表');
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    return { name: sheet.getAttribute('name')!, id, path, doc: getXml(parts, path) };
  });
}
function unsafeCell(cell: XmlElement) {
  const f = first(cell, 'f');
  return !!f && !!f.getAttribute('t') && f.getAttribute('t') !== 'normal';
}
function inspectExcel(parts: Record<string, Uint8Array>, path: string, version: string): ExcelDocument {
  const strings = parts['xl/sharedStrings.xml'] ? elements(getXml(parts, 'xl/sharedStrings.xml'), 'si').map(si => elements(si, 't').map(t => t.textContent ?? '').join('')) : [];
  const workbook = getXml(parts, 'xl/workbook.xml');
  const calc = first(workbook, 'calcPr');
  const sheets = sheetParts(parts);
  const formulas = sheets.flatMap(sheet => elements(sheet.doc, 'c').filter(c => first(c, 'f')).map(cell => ({ name: `${sheet.name}!${cell.getAttribute('r')}`, cached: !!first(cell, 'v') && first(cell, 'v')!.textContent !== '' })));
  return {
    kind: 'xlsx', path, version, needsRecalculation: calc?.getAttribute('fullCalcOnLoad') === '1',
    recalculation: { invalidated: formulas.filter(f => !f.cached).map(f => f.name), preserved: formulas.filter(f => f.cached).length, reason: '无缓存公式需由 Excel 计算；现有缓存为文件保存的结果，应用不执行公式计算' },
    sheets: sheets.map(sheet => ({
      name: sheet.name, id: sheet.id, merges: elements(sheet.doc, 'mergeCell').map(c => c.getAttribute('ref')!),
      cells: elements(sheet.doc, 'c').map(c => {
        const type = c.getAttribute('t'), raw = first(c, 'v')?.textContent ?? '';
        const formula = first(c, 'f')?.textContent ?? undefined;
        const value = type === 's' ? strings[Number(raw)] ?? '' : type === 'inlineStr' ? elements(c, 't').map(t => t.textContent ?? '').join('') : raw;
        return { ref: c.getAttribute('r')!, value, formula, style: c.getAttribute('s') ?? undefined, editable: !first(sheet.doc, 'sheetProtection') && !unsafeCell(c) } satisfies SheetCell;
      })
    }))
  };
}
function coordinates(ref: string) {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(ref);
  if (!match) throw new Error('单元格地址无效');
  let col = 0; for (const c of match[1]) col = col * 26 + c.charCodeAt(0) - 64;
  if (col > 16384 || Number(match[2]) > 1048576) throw new Error('单元格地址超出 Excel 范围');
  return { col, row: Number(match[2]) };
}
function inRange(ref: string, range: string) {
  const [a, b = a] = range.split(':').map(coordinates), c = coordinates(ref);
  return c.col >= a.col && c.col <= b.col && c.row >= a.row && c.row <= b.row;
}
function setCell(doc: XmlDocument, ref: string, value: string, formula?: string) {
  validText(value); if (formula !== undefined) { validText(formula); if (formula.length > 32767) throw new Error('Excel 公式超过安全长度限制'); }
  const position = coordinates(ref);
  if (first(doc, 'sheetProtection')) throw new Error('工作表已受保护');
  const allCells = elements(doc, 'c');
  const original = allCells.find(c => c.getAttribute('r') === ref);
  if (original && unsafeCell(original)) throw new Error('共享、数组或数据表公式仅支持在 Excel 中编辑');
  for (const f of elements(doc, 'f')) if (f.getAttribute('ref') && inRange(ref, f.getAttribute('ref')!)) throw new Error('单元格属于数组或共享公式范围');
  for (const merged of elements(doc, 'mergeCell')) {
    const range = merged.getAttribute('ref')!;
    if (inRange(ref, range) && range.split(':')[0] !== ref) throw new Error('请编辑合并单元格的左上角');
  }
  let row = elements(doc, 'row').find(r => Number(r.getAttribute('r')) === position.row);
  const sheetData = first(doc, 'sheetData'); if (!sheetData) throw new Error('工作表缺少数据区域');
  if (!row) { row = doc.createElementNS(S, 'row'); row.setAttribute('r', String(position.row)); const next = elements(doc, 'row').find(r => Number(r.getAttribute('r')) > position.row); sheetData.insertBefore(row, next ?? null); }
  let cell = original;
  if (!cell) { cell = doc.createElementNS(S, 'c'); cell.setAttribute('r', ref); const next = elements(row, 'c').find(c => coordinates(c.getAttribute('r')!).col > position.col); row.insertBefore(cell, next ?? null); }
  // Preserve cell style and extension data; change only formula/value nodes.
  for (const name of ['f', 'v', 'is']) for (const node of elements(cell, name)) if (node.parentNode === cell) cell.removeChild(node);
  if (formula !== undefined && formula !== '') {
    cell.removeAttribute('t'); const f = doc.createElementNS(S, 'f'); f.textContent = formula.replace(/^=/, ''); cell.insertBefore(f,first(cell,'extLst')??null);
  } else if (value !== '' && /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
    cell.removeAttribute('t'); const v = doc.createElementNS(S, 'v'); v.textContent = value; cell.insertBefore(v,first(cell,'extLst')??null);
  } else {
    cell.setAttribute('t', 'inlineStr'); const inline = doc.createElementNS(S, 'is'), t = doc.createElementNS(S, 't'); t.setAttributeNS('http://www.w3.org/XML/1998/namespace','xml:space', 'preserve'); t.textContent = value; inline.appendChild(t); cell.insertBefore(inline,first(cell,'extLst')??null);
  }
  first(doc, 'dimension')?.parentNode?.removeChild(first(doc, 'dimension')!);
}
const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function wordReview(blocks: WordBlock[], selected: Set<string>) {
  return blocks.filter(b => selected.has(b.id)).map(b => `${b.id} [${b.type}; style=${b.style ?? '默认'}]\n${b.text}\n格式：${JSON.stringify(b.runs ?? [])}`).join('\n\n') + '\n';
}
function excelReview(doc: ExcelDocument, selected: Set<string>) {
  return doc.sheets.flatMap(sheet => sheet.cells.filter(c => selected.has(`${sheet.id}!${c.ref}`)).map(c => `${sheet.name}!${c.ref}: ${c.formula !== undefined ? '=' + c.formula + ` [缓存=${JSON.stringify(c.value)}]` : JSON.stringify(c.value)} [style=${c.style ?? '默认'}]`)).join('\n') + '\n';
}
function newPackage(kind: 'docx' | 'xlsx', text: string) {
  const relns = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const parts: Record<string, Uint8Array> = {};
  const put = (name: string, xml: string) => { parts[name] = strToU8(xml); };
  if (kind === 'docx') {
    put('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
    put('_rels/.rels', `<Relationships xmlns="${relns}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`);
    put('word/document.xml', `<w:document xmlns:w="${W}"><w:body>${text.split('\n').map(p => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`);
  } else {
    put('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
    put('_rels/.rels', `<Relationships xmlns="${relns}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
    put('xl/workbook.xml', `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`);
    put('xl/_rels/workbook.xml.rels', `<Relationships xmlns="${relns}"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
    put('xl/worksheets/sheet1.xml', `<worksheet xmlns="${S}"><sheetData/></worksheet>`);
    if (text) { const doc = getXml(parts, 'xl/worksheets/sheet1.xml'); setCell(doc, 'A1', text); put('xl/worksheets/sheet1.xml', serializer.serializeToString(doc)); }
  }
  return zipSync(parts);
}
export class Documents {
  private pdfFonts = new WeakMap<PDFDocument, Map<string, PDFFont>>();
  constructor(readonly files: Files, private resources: string) {}
  private async pdfFont(pdf: PDFDocument, text: string) {
    validText(text);
    if (text.includes('\t')) throw new Error('PDF 添字暂不支持制表符，请明确改为空格后重试，或使用批注保留原文');
    let fonts = this.pdfFonts.get(pdf); if (!fonts) { fonts = new Map(); this.pdfFonts.set(pdf, fonts); }
    let primary = fonts.get('noto');
    if (!primary) { pdf.registerFontkit(fontkit); primary = await pdf.embedFont(await readFile(join(this.resources, 'NotoSansSC-Regular.otf')), { subset: true }); fonts.set('noto', primary); }
    const points = [...text].filter(ch => ch !== '\n' && ch !== '\r'), coverage = new Set(primary.getCharacterSet());
    const missing = [...new Set(points.filter(ch => !coverage.has(ch.codePointAt(0)!)))];
    if (!missing.length) return primary;
    // A verified fallback is used only when it covers the entire string. We never
    // silently substitute .notdef glyphs or split shaping clusters between fonts.
    let fallback = fonts.get('helvetica'); if (!fallback) { fallback = await pdf.embedFont(StandardFonts.Helvetica); fonts.set('helvetica', fallback); }
    const fallbackCoverage = new Set(fallback.getCharacterSet());
    if (points.every(ch => fallbackCoverage.has(ch.codePointAt(0)!))) return fallback;
    throw new Error(`PDF 字体不支持以下字符：${missing.slice(0, 12).map(ch => `${ch} (U+${ch.codePointAt(0)!.toString(16).toUpperCase()})`).join('、')}。文件未修改；可改用 Unicode 批注，或在支持该字体的外部 PDF 编辑器中添字`);
  }
  async inspect(workspaceId: string, path: string): Promise<OpenDocument> {
    const bytes = await this.files.bytes(workspaceId, path), version = hash(bytes), extension = extname(path).toLowerCase();
    if (extension === '.docx') {
      const doc = getXml(unpack(bytes), 'word/document.xml');
      return { kind: 'docx', path, version, blocks: wordBlocks(doc).map(p => p.block) } satisfies WordDocument;
    }
    if (extension === '.xlsx') return inspectExcel(unpack(bytes), path, version);
    if (extension === '.pdf') {
      const doc = await PDFDocument.load(bytes);
      if (doc.getForm().getFields().some(f => f.constructor.name === 'PDFSignature')) throw new Error('签名 PDF 仅支持在原软件中查看');
      return { kind: 'pdf', path, version, pages: doc.getPages().map((p, i) => ({ number: i + 1, width: p.getWidth(), height: p.getHeight(), rotation: p.getRotation().angle })) };
    }
    if (/\.(doc|xls|xlsm|pptx|zip|png|jpe?g|gif|webp|exe|dll|woff2?|ttf|otf)$/i.test(path) || bytes.includes(0)) throw new Error('此格式暂不支持编辑');
    if (bytes.length > 2 * 1024 * 1024) throw new Error('文本文件超过 2 MB，请拆分后处理');
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { kind: 'text', path, version, text, bom, newline: text.includes('\r\n') ? '\r\n' : '\n' };
  }
  async create(workspaceId: string, path: string, text: string, set: ChangeSet, signal?: AbortSignal) {
    signal?.throwIfAborted(); validText(text);
    const extension = extname(path).toLowerCase();
    let bytes: Uint8Array;
    if (extension === '.docx' || extension === '.xlsx') bytes = newPackage(extension.slice(1) as 'docx' | 'xlsx', text);
    else if (extension === '.pdf') {
      const doc = await PDFDocument.create(), page = doc.addPage();
      if (text) { const font = await this.pdfFont(doc, text); page.drawText(text, { x: 40, y: page.getHeight() - 50, size: 12, lineHeight: 20, maxWidth: page.getWidth() - 80, font }); }
      bytes = await doc.save();
    } else {
      if (/\.(doc|xls|xlsm|pptx|zip|png|jpe?g|exe|dll)$/i.test(path)) throw new Error('新建仅支持文本、docx、xlsx、pdf');
      bytes = Buffer.from(text, 'utf8');
    }
    signal?.throwIfAborted(); await this.files.write(workspaceId, path, null, bytes, set, `新建 ${path}`);
    return this.inspect(workspaceId, path);
  }
  async apply(workspaceId: string, path: string, version: string, operations: FileOperation[], set: ChangeSet, manual = false, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const bytes = await this.files.bytes(workspaceId, path);
    if (hash(bytes) !== version) throw new Error('文件版本已变化，请重新读取');
    const doc = await this.inspect(workspaceId, path);
    let output: Uint8Array, summary: string, semanticDiff: string | undefined;
    if (doc.kind === 'text') {
      let text = doc.text;
      for (const op of operations) {
        signal?.throwIfAborted();
        if (op.type === 'set_text') text = op.text;
        else if (op.type === 'replace') {
          if (!op.oldText || !text.includes(op.oldText) || text.indexOf(op.oldText) !== text.lastIndexOf(op.oldText)) throw new Error('替换原文必须非空且唯一');
          text = text.replace(op.oldText, op.newText);
        } else throw new Error('文本操作类型错误');
      }
      text = text.replace(/\r?\n/g, doc.newline);
      output = Buffer.from((doc.bom ? '\ufeff' : '') + text, 'utf8'); summary = `编辑文本 ${path}`;
    } else if (doc.kind === 'docx') {
      const parts = unpack(bytes), xmlDoc = getXml(parts, 'word/document.xml');
      const blocks = wordBlocks(xmlDoc), changes: string[] = [];
      for (const op of operations) {
        signal?.throwIfAborted();
        if (op.type !== 'word_replace') throw new Error('Word 操作类型错误');
        const found = blocks.find(b => b.block.id === op.blockId);
        if (!found || !found.block.editable) throw new Error('段落不存在或包含不支持编辑的复杂结构');
        const strategy = replaceWord(found.p, op.oldText, op.newText, op.stylePolicy); changes.push(`${op.blockId}: ${op.oldText} → ${op.newText}\n样式策略：${strategy}`);
      }
      const selected = new Set(operations.flatMap(op => op.type === 'word_replace' ? [op.blockId] : []));
      semanticDiff = await reviewPatch(path, wordReview(doc.blocks, selected), wordReview(wordBlocks(xmlDoc).map(b => b.block), selected), '修改前（段落与原格式）', '修改后（段落与保留格式）');
      parts['word/document.xml'] = strToU8(serializer.serializeToString(xmlDoc)); output = zipSync(parts); summary = changes.join('\n');
    } else if (doc.kind === 'xlsx') {
      const parts = unpack(bytes), sheets = sheetParts(parts), changes: string[] = [];
      for (const op of operations) {
        signal?.throwIfAborted();
        if (op.type !== 'cell') throw new Error('Excel 操作类型错误');
        const sheet = sheets.find(s => s.id === op.sheetId || s.name === op.sheetId);
        if (!sheet) throw new Error('工作表不存在');
        const before = doc.sheets.find(s => s.id === sheet.id)?.cells.find(c => c.ref === op.ref);
        setCell(sheet.doc, op.ref, op.value, op.formula); changes.push(`${sheet.name}!${op.ref}: ${before?.formula ? '=' + before.formula : before?.value ?? '空'} → ${op.formula ? '=' + op.formula : op.value}`);
      }
      const recalculation = invalidateFormulaCaches(sheets, operations.flatMap(op => op.type === 'cell' ? [{ sheet: sheets.find(s => s.id === op.sheetId || s.name === op.sheetId)!.name, ref: op.ref }] : []));
      for (const sheet of sheets) {
        signal?.throwIfAborted();
        parts[sheet.path] = strToU8(serializer.serializeToString(sheet.doc));
      }
      const workbook = getXml(parts, 'xl/workbook.xml');
      let calc = first(workbook, 'calcPr'); if (!calc) { calc = workbook.createElementNS(S, 'calcPr'); const tail=Array.from(workbook.documentElement!.childNodes).find(n=>n.nodeType===1&&['oleSize','customWorkbookViews','pivotCaches','smartTagPr','smartTagTypes','webPublishing','fileRecoveryPr','webPublishObjects','extLst'].includes((n as XmlElement).localName??''));workbook.documentElement!.insertBefore(calc,tail??null); }
      calc.setAttribute('fullCalcOnLoad', '1'); calc.setAttribute('forceFullCalc', '1'); calc.setAttribute('calcMode', 'auto');
      parts['xl/workbook.xml'] = strToU8(serializer.serializeToString(workbook));
      // Remove calculation-chain metadata because its dependencies are now stale.
      delete parts['xl/calcChain.xml'];
      const rels = getXml(parts, 'xl/_rels/workbook.xml.rels');
      for (const rel of elements(rels, 'Relationship')) if (rel.getAttribute('Type')?.endsWith('/calcChain')) rel.parentNode?.removeChild(rel);
      parts['xl/_rels/workbook.xml.rels'] = strToU8(serializer.serializeToString(rels));
      const contentTypes = getXml(parts, '[Content_Types].xml');
      for (const entry of elements(contentTypes, 'Override')) if (entry.getAttribute('PartName') === '/xl/calcChain.xml') entry.parentNode?.removeChild(entry);
      parts['[Content_Types].xml'] = strToU8(serializer.serializeToString(contentTypes));
      const selected = new Set(operations.flatMap(op => op.type === 'cell' ? [`${sheets.find(s => s.id === op.sheetId || s.name === op.sheetId)!.id}!${op.ref}`] : []));
      for (const sheet of sheets) for (const cell of elements(sheet.doc, 'c')) if (first(cell, 'f') && !first(cell, 'v')) selected.add(`${sheet.id}!${cell.getAttribute('r')}`);
      semanticDiff = await reviewPatch(path, excelReview(doc, selected), excelReview(inspectExcel(parts, path, ''), selected), '修改前（单元格、公式与缓存）', '修改后（需重算的缓存留空）');
      output = zipSync(parts); summary = changes.join('\n') + `\n公式缓存：清除 ${recalculation.invalidated.length} 个，保留 ${recalculation.preserved} 个。${recalculation.reason}`;
    } else {
      let pdf = await PDFDocument.load(bytes); const changes: string[] = [];
      for (const op of operations) {
        signal?.throwIfAborted();
        if (op.type === 'pdf_pages') {
          if (!op.pages.length || op.pages.some(n => !Number.isInteger(n) || n < 1 || n > pdf.getPageCount())) throw new Error('页面序列无效');
          const next = await PDFDocument.create(); const pages = await next.copyPages(pdf, op.pages.map(n => n - 1)); pages.forEach(p => next.addPage(p)); pdf = next; changes.push(`页面序列：${op.pages.join(', ')}`);
        } else if (op.type === 'pdf_merge') {
          for (const input of op.paths) { signal?.throwIfAborted(); const other = await PDFDocument.load(await this.files.bytes(workspaceId, input)); const pages = await pdf.copyPages(other, other.getPageIndices()); pages.forEach(p => pdf.addPage(p)); }
          changes.push(`合并：${op.paths.join(', ')}`);
        } else if (op.type === 'pdf_note' || op.type === 'pdf_text') {
          const page = pdf.getPages()[op.page - 1];
          if (!page || !Number.isFinite(op.x) || !Number.isFinite(op.y) || op.x < 0 || op.y < 0 || op.x > page.getWidth() || op.y > page.getHeight()) throw new Error('PDF 页码或坐标无效；坐标使用 PDF 点，原点在左下角');
          validText(op.text); if (op.type === 'pdf_note') {
            const note = pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [op.x, op.y, op.x + 20, op.y + 20], Contents: PDFHexString.fromText(op.text), T: PDFHexString.fromText('Simple Agent'), Name: 'Comment', C: [0.98, 0.75, 0.2], F: 4, M: PDFString.fromDate(new Date()) });
            const annotation = pdf.context.register(note); let annotations = page.node.Annots();
            if (!annotations) { annotations = pdf.context.obj([]); page.node.set(PDFName.of('Annots'), annotations); } annotations.push(annotation);
          } else {
            const size = op.size ?? 12; if (size < 5 || size > 100) throw new Error('字号需为 5–100 点');
            const font = await this.pdfFont(pdf, op.text);
            page.drawText(op.text, { x: op.x, y: op.y, size, font, lineHeight: size * 1.4, maxWidth: page.getWidth() - op.x });
          }
          changes.push(`第 ${op.page} 页${op.type === 'pdf_note' ? '批注' : '添字'}：${op.text}`);
        } else throw new Error('PDF 操作类型错误');
      }
      const before = doc.pages.map(p => `第${p.number}页：${p.width}×${p.height}，旋转${p.rotation}°`).join('\n') + '\n';
      const after = pdf.getPages().map((p, index) => `第${index + 1}页：${p.getWidth()}×${p.getHeight()}，旋转${p.getRotation().angle}°`).join('\n') + '\n' + changes.map(change => `[本次操作] ${change}`).join('\n') + '\n';
      semanticDiff = await reviewPatch(path, before, after, '修改前（页面结构）', '修改后（页面结构及新增内容）');
      output = await pdf.save(); summary = changes.join('\n');
    }
    if (semanticDiff && semanticDiff.length > 2 * 1024 * 1024) throw new Error('本次 Office 内容差异超过 2 MB，无法安全审核；请拆分为较小修改');
    signal?.throwIfAborted(); await this.files.write(workspaceId, path, version, output, set, summary, manual, semanticDiff);
    return this.inspect(workspaceId, path);
  }
  async exportPdf(workspaceId: string, path: string, version: string, target: string, pages: number[], set: ChangeSet, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (extname(target).toLowerCase() !== '.pdf') throw new Error('导出目标必须为 .pdf 文件');
    const doc = await this.inspect(workspaceId, path);
    if (doc.kind !== 'pdf' || doc.version !== version) throw new Error('PDF 文件版本已变化，请重新读取');
    if (!pages.length || pages.length > 1000 || pages.some(n => !Number.isInteger(n) || n < 1 || n > doc.pages.length)) throw new Error('导出页面序列无效');
    if (this.files.dirty.has(this.files.dirtyKey(workspaceId, path))) throw new Error('请先保存或放弃源 PDF 的编辑');
    const bytes = await this.files.bytes(workspaceId, path);
    if (hash(bytes) !== version) throw new Error('PDF 文件版本已变化，请重新读取');
    const source = await PDFDocument.load(bytes), output = await PDFDocument.create();
    for (const page of await output.copyPages(source, pages.map(n => n - 1))) output.addPage(page);
    const result = await output.save(); signal?.throwIfAborted(); await this.files.write(workspaceId, target, null, result, set, `从 ${path} 导出页面 ${pages.join(', ')} 到 ${target}`);
    return this.inspect(workspaceId, target);
  }
}
