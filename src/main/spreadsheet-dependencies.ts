import type { Document as XmlDocument, Element as XmlElement } from '@xmldom/xmldom';
import type { ExcelDocument } from '../shared/types';

type SheetXml = { name: string; id: string; doc: XmlDocument };
type Range = { sheet: string; c1: number; r1: number; c2: number; r2: number };
const nodes = (p: XmlDocument | XmlElement, name: string) => Array.from(p.getElementsByTagNameNS('*', name));
const key = (sheet: string, ref: string) => `${sheet.toLocaleLowerCase()}!${ref.toUpperCase()}`;
function position(ref: string) {
  const match = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})$/i.exec(ref); if (!match) return;
  let col = 0; for (const ch of match[1].toUpperCase()) col = col * 26 + ch.charCodeAt(0) - 64;
  const row = Number(match[2]); return col <= 16384 && row <= 1048576 ? { col, row } : undefined;
}

// This is deliberately a dependency recognizer, not a formula evaluator. Unsupported
// expressions (names, external/3-D/structured/dynamic/volatile references) are opaque:
// their caches and transitive dependents are invalidated on every workbook mutation.
function dependencies(formula: string, currentSheet: string, sheets: Set<string>) {
  let rest = formula.replace(/"(?:[^"]|"")*"/g, '');
  let opaque = /\b(?:INDIRECT|OFFSET|RAND|RANDBETWEEN|NOW|TODAY|CELL|INFO)\s*\(/i.test(rest) || /[\[\]#]/.test(rest);
  const pureFunctions = new Set('SUM AVERAGE MIN MAX COUNT COUNTA COUNTBLANK COUNTIF COUNTIFS SUMIF SUMIFS AVERAGEIF AVERAGEIFS IF IFS IFERROR IFNA AND OR NOT XOR ABS ROUND ROUNDUP ROUNDDOWN INT TRUNC MOD POWER SQRT SIGN PRODUCT SUMPRODUCT SUBTOTAL AGGREGATE CONCAT CONCATENATE TEXTJOIN LEFT RIGHT MID LEN LOWER UPPER TRIM CLEAN SUBSTITUTE REPLACE FIND SEARCH EXACT TEXT VALUE DATE YEAR MONTH DAY HOUR MINUTE SECOND DAYS EDATE EOMONTH WEEKDAY VLOOKUP HLOOKUP XLOOKUP LOOKUP INDEX MATCH XMATCH CHOOSE ROW ROWS COLUMN COLUMNS TRANSPOSE FILTER SORT UNIQUE ISNUMBER ISTEXT ISBLANK ISERROR ISNA TRUE FALSE LOG LOG10 LN EXP SIN COS TAN PI MEDIAN STDEV STDEV.S STDEV.P VAR VAR.S VAR.P'.split(' '));
  for (const match of rest.matchAll(/([\p{L}_][\p{L}\p{N}_.]*)\s*\(/gu)) if (!pureFunctions.has(match[1].toUpperCase())) opaque = true;
  const ranges: Range[] = [];
  rest = rest.replace(/(?<![\p{L}\p{N}_.])(?:(?:'((?:[^']|'')+)'|([\p{L}\p{N}_.]+))!)?(\$?[A-Z]{1,3}\$?[1-9]\d{0,6})(?::(\$?[A-Z]{1,3}\$?[1-9]\d{0,6}))?(?![\p{L}\p{N}_.])/giu, (token, quoted: string | undefined, plain: string | undefined, a: string, b: string | undefined, offset: number) => {
    // LOG10(...) and other function names which happen to be valid cell addresses.
    if (!quoted && !plain && !b && /^\s*\(/.test(rest.slice(offset + token.length))) return token;
    const sheet = (quoted?.replaceAll("''", "'") ?? plain ?? currentSheet).toLocaleLowerCase(), start = position(a), finish = position(b ?? a);
    if (!start || !finish || !sheets.has(sheet)) { opaque = true; return ' '; }
    ranges.push({ sheet, c1: Math.min(start.col, finish.col), c2: Math.max(start.col, finish.col), r1: Math.min(start.row, finish.row), r2: Math.max(start.row, finish.row) }); return ' ';
  });
  rest = rest.replace(/[\p{L}_][\p{L}\p{N}_.]*\s*(?=\()/gu, '').replace(/\b(?:TRUE|FALSE)\b/gi, '');
  if (/[^\d\s.+\-*/^&%=<>,;(){}]/.test(rest)) opaque = true;
  return { ranges, opaque };
}

export function invalidateFormulaCaches(sheets: SheetXml[], modified: { sheet: string; ref: string }[]) {
  const names = new Set(sheets.map(s => s.name.toLocaleLowerCase()));
  const formulas = sheets.flatMap(sheet => nodes(sheet.doc, 'c').flatMap(cell => {
    const f = nodes(cell, 'f')[0]; if (!f) return [];
    const ref = cell.getAttribute('r')!;
    const dependency = dependencies(f.textContent ?? '', sheet.name, names);
    return [{ sheet, cell, ref, f, ...dependency, opaque: !!f.getAttribute('t') && f.getAttribute('t') !== 'normal' || dependency.opaque }];
  }));
  const invalid = new Set<string>(), queue = modified.map(c => ({ sheet: c.sheet.toLocaleLowerCase(), ref: c.ref.toUpperCase() }));
  const changed = new Set(queue.map(c => key(c.sheet, c.ref)));
  const invalidate = (formula: typeof formulas[number]) => {
    const id = key(formula.sheet.name, formula.ref); if (invalid.has(id)) return;
    invalid.add(id); queue.push({ sheet: formula.sheet.name.toLocaleLowerCase(), ref: formula.ref });
    // Shared/array formula followers can have cached values without their own <f>.
    const range = formula.f.getAttribute('ref');
    if (range) {
      const [a, b = a] = range.split(':').map(position);
      if (a && b) for (const cell of nodes(formula.sheet.doc, 'c')) {
        const ref = cell.getAttribute('r')!, point = position(ref); if (!point || point.col < a.col || point.col > b.col || point.row < a.row || point.row > b.row) continue;
        const member = key(formula.sheet.name, ref); if (member !== id && !changed.has(member)) { changed.add(member); queue.push({ sheet: formula.sheet.name.toLocaleLowerCase(), ref }); }
        for (const value of nodes(cell, 'v')) value.parentNode?.removeChild(value);
      }
    }
    for (const value of nodes(formula.cell, 'v')) value.parentNode?.removeChild(value);
  };
  for (const formula of formulas) if (formula.opaque || changed.has(key(formula.sheet.name, formula.ref))) invalidate(formula);
  let comparisons = 0, conservative = false;
  for (let at = 0; at < queue.length; at++) {
    const change = queue[at], point = position(change.ref); if (!point) continue;
    for (const formula of formulas) {
      if (invalid.has(key(formula.sheet.name, formula.ref))) continue;
      if (++comparisons > 2_000_000) { conservative = true; for (const remaining of formulas) invalidate(remaining); break; }
      if (formula.ranges.some(r => r.sheet === change.sheet && point.col >= r.c1 && point.col <= r.c2 && point.row >= r.r1 && point.row <= r.r2)) invalidate(formula);
    }
    if (conservative) break;
  }
  return { invalidated: formulas.filter(f => invalid.has(key(f.sheet.name, f.ref))).map(f => `${f.sheet.name}!${f.ref}`), preserved: formulas.length - invalid.size,
    reason: conservative ? '依赖分析达到复杂度上限，其余公式缓存保守失效；需在 Excel 重算' : '已清除修改单元格的直接、跨表和链式依赖缓存；动态、外部、命名或复杂公式保守失效；其余缓存按依赖保留。应用不计算公式，需在 Excel 重算。' };
}

export function paginateExcel(doc: ExcelDocument, options: { sheet?: string; offset?: number; limit?: number } = {}) {
  const offset = options.offset ?? 0, limit = options.limit ?? 200;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Excel 分页参数无效；limit 需为 1–1000');
  const selected = options.sheet === undefined ? doc.sheets : doc.sheets.filter(s => s.id === options.sheet || s.name === options.sheet);
  if (!selected.length) throw new Error('工作表不存在，请使用目录中的工作表名称或 ID');
  let skip = offset, remaining = limit;
  const sheets = selected.map(sheet => {
    const start = Math.min(skip, sheet.cells.length); skip -= start;
    const cells = sheet.cells.slice(start, start + remaining); remaining -= cells.length;
    const nextOffset = start + cells.length;
    return { ...sheet, cells, pagination: { offset: start, returned: cells.length, total: sheet.cells.length, nextOffset: nextOffset < sheet.cells.length ? nextOffset : null } };
  });
  const total = selected.reduce((sum, s) => sum + s.cells.length, 0), returned = limit - remaining;
  return { kind: doc.kind, path: doc.path, version: doc.version, needsRecalculation: doc.needsRecalculation, sheets,
    pagination: { scope: options.sheet === undefined ? 'workbook-cell-order' : 'sheet-cell-order', offset, returned, total, nextOffset: offset + returned < total ? offset + returned : null } };
}
