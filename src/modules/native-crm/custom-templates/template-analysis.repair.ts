import {
  designElementSchema, createTemplateSchema,
  FONT_FAMILIES, COLOR_REGEX, PART_COLUMN_KEYS, TOTALS_ROW_KEYS,
} from './custom-template.validation';
import { IDesignElement, TemplateDocType } from './custom-template.model';

/**
 * AI output can't be trusted to satisfy designElementSchema's exact bounds —
 * this module normalizes it element-by-element (clamping numbers, coercing
 * enums/colors, reshaping gridtable dimensions to match gridRows×gridCols)
 * so a slightly-malformed response never just 400s and dead-ends the user.
 * Unrecoverable elements are dropped individually (with a warning) rather
 * than failing the whole request. The real designElementSchema/
 * createTemplateSchema (same ones every hand-built template already goes
 * through) still has final say — nothing here re-implements those bounds as
 * a second source of truth, it only repairs toward them.
 */

const MAX_ELEMENTS = 200;

const NUMERIC_BOUNDS: Record<string, [number, number]> = {
  x: [-2000, 4000], y: [-2000, 20000], w: [1, 4000], h: [1, 20000],
  z: [0, 999], fontSize: [6, 120], lineHeight: [0.5, 4], padding: [0, 100],
  borderWidth: [0, 30], borderRadius: [0, 100],
};

// Matches frontend defaultSize() in TemplateDesignerPage.tsx — used when an
// element is missing x/y/w/h entirely (a default anchor, not a guess at the
// AI's real intent, which by definition wasn't given).
const DEFAULT_SIZE: Record<string, { w: number; h: number }> = {
  text: { w: 200, h: 30 }, richtext: { w: 500, h: 80 }, image: { w: 120, h: 60 },
  table: { w: 754, h: 120 }, totals: { w: 240, h: 110 }, divider: { w: 720, h: 4 },
  box: { w: 200, h: 80 }, gridtable: { w: 300, h: 100 },
};

const VALID_TYPES = new Set(['text', 'richtext', 'image', 'table', 'totals', 'divider', 'box', 'gridtable']);

const FONT_FAMILY_MAP: Record<string, string> = {
  roboto: 'Arial', calibri: 'Arial', 'open sans': 'Arial', lato: 'Arial', montserrat: 'Arial',
  'segoe ui': 'Arial', inter: 'Arial', 'sans-serif': 'Arial', 'sans serif': 'Arial',
  serif: 'Georgia', times: 'Times New Roman', courier: 'Courier New', trebuchet: 'Trebuchet MS',
};

function clampNum(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

function coerceFontFamily(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  if ((FONT_FAMILIES as readonly string[]).includes(trimmed)) return trimmed;
  const mapped = FONT_FAMILY_MAP[trimmed.toLowerCase()];
  return mapped ?? 'Arial';
}

/** Keeps a valid color/`'transparent'` as-is; drops (returns undefined) anything invalid instead of guessing a replacement. */
function coerceColor(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return COLOR_REGEX.test(trimmed) ? trimmed : undefined;
}

function coerceEnum<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;
}

function truncate(v: unknown, maxLen: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  return v.length > maxLen ? v.slice(0, maxLen) : v;
}

function genId(used: Set<string>): string {
  let id: string;
  do { id = `el-${Math.random().toString(36).slice(2, 10)}`; } while (used.has(id));
  used.add(id);
  return id;
}

// Only 'table' has a genuinely unbounded, data-dependent row count (1 vs.
// 60 line items), so it's the only type that truly needs flow/pagination
// treatment. 'richtext'/'gridtable' were flow types too until this was
// narrowed — they're fixed-size at design time (a gridtable's dimensions
// are picked up front; richtext's box is resized on canvas like any other
// element), so keeping them out of FLOW_TYPES removes the "beside a flow
// element" overlap risk for two of the three types that used to trigger it,
// at the cost of long richtext content clipping instead of paginating
// (rare, and visible on canvas immediately as a too-short box).
const FLOW_TYPES = new Set(['table']);
const OVERLAP_GAP = 20;

/**
 * Deterministically eliminates every vertical overlap between a flow-type
 * element (table) and anything else — the renderer's band-model pagination
 * only understands a single-column, stacked layout around flow elements; it
 * has no concept of something sitting BESIDE one (same y-range, different
 * x). AI-generated drafts repeatedly produced exactly this pattern (a
 * totals block beside a table, a quote-metadata box beside an address,
 * positioned faithfully to a real source document that DOES support
 * side-by-side layout) — verified live across three separate documents that
 * prompt instructions alone don't reliably prevent this, so it's enforced
 * here instead, guaranteeing every analysis result renders without the
 * collapsed/colliding layout this caused.
 *
 * Two passes: first spread out any flow elements that overlap EACH OTHER
 * (sorted by y, each pushed clear of the previous one), then push every
 * non-flow element clear of the now-final flow ranges — above if it started
 * before the flow block's top, below otherwise. Repeats until stable (a
 * pushed element can newly collide with a different flow block) with a
 * safety cap so a pathological input can't loop forever.
 */
export function resolveFlowOverlaps(elements: IDesignElement[]): void {
  const flow = elements.filter((e) => FLOW_TYPES.has(e.type)).sort((a, b) => a.y - b.y);
  const nonFlow = elements.filter((e) => !FLOW_TYPES.has(e.type));

  let cursor: number | null = null;
  for (const f of flow) {
    if (cursor !== null && f.y < cursor + OVERLAP_GAP) f.y = cursor + OVERLAP_GAP;
    cursor = f.y + f.h;
  }

  for (let iteration = 0; iteration < 5; iteration++) {
    let changed = false;
    for (const el of nonFlow) {
      for (const f of flow) {
        const elTop = el.y, elBottom = el.y + el.h;
        const fTop = f.y, fBottom = f.y + f.h;
        const overlaps = elTop < fBottom && elBottom > fTop;
        if (!overlaps) continue;
        el.y = elTop < fTop ? Math.max(0, fTop - OVERLAP_GAP - el.h) : fBottom + OVERLAP_GAP;
        changed = true;
      }
    }
    if (!changed) break;
  }
}

function repairTableColumns(raw: any, dataset: string | undefined): IDesignElement['columns'] {
  if (!Array.isArray(raw)) return undefined;
  const isParts = dataset === 'parts';
  const out = raw
    .slice(0, 12)
    .map((c: any) => {
      if (!c || typeof c !== 'object') return null;
      const key = coerceEnum(c.key, PART_COLUMN_KEYS);
      if (!key) return null;
      if (key === 'partNumber' && !isParts) return null; // mirrors the superRefine business rule directly
      const label = truncate(c.label, 80) ?? key;
      const width = clampNum(c.width, 1, 100);
      const align = coerceEnum(c.align, ['left', 'center', 'right'] as const);
      const col: any = { key, label };
      if (width !== undefined) col.width = width;
      if (align) col.align = align;
      return col;
    })
    .filter(Boolean);
  return out.length ? (out as IDesignElement['columns']) : undefined;
}

function repairTotalsRows(raw: any): IDesignElement['totalsRows'] {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .slice(0, 8)
    .map((r: any) => {
      if (!r || typeof r !== 'object') return null;
      const key = coerceEnum(r.key, TOTALS_ROW_KEYS);
      if (!key) return null;
      const row: any = { key };
      const label = truncate(r.label, 80);
      if (label) row.label = label;
      return row;
    })
    .filter(Boolean);
  return out.length ? (out as IDesignElement['totalsRows']) : undefined;
}

/** Reshapes gridCells to exactly gridRows×gridCols, padding/truncating as needed. */
function repairGridCells(raw: any, gridRows: number, gridCols: number): string[][] {
  const source: any[] = Array.isArray(raw) ? raw : [];
  const rows: string[][] = [];
  for (let r = 0; r < gridRows; r++) {
    const srcRow: any[] = Array.isArray(source[r]) ? source[r] : [];
    const row: string[] = [];
    for (let c = 0; c < gridCols; c++) {
      const cell = srcRow[c];
      row.push(truncate(typeof cell === 'string' ? cell : cell != null ? String(cell) : '', 5000) ?? '');
    }
    rows.push(row);
  }
  return rows;
}

function repairElement(raw: any, usedIds: Set<string>, warnings: string[], index: number): IDesignElement | null {
  if (!raw || typeof raw !== 'object') {
    warnings.push(`Skipped a non-object entry at position ${index}`);
    return null;
  }

  const type = coerceEnum(raw.type, [
    'text', 'richtext', 'image', 'table', 'totals', 'divider', 'box', 'gridtable',
  ] as const);
  if (!type || !VALID_TYPES.has(type)) {
    warnings.push(`Dropped an element with an unrecognized type at position ${index}`);
    return null;
  }

  const id = (typeof raw.id === 'string' && raw.id.trim().length >= 1 && raw.id.trim().length <= 40 && !usedIds.has(raw.id.trim()))
    ? raw.id.trim()
    : genId(usedIds);
  usedIds.add(id);

  const dims = DEFAULT_SIZE[type];
  const el: any = {
    id, type,
    x: clampNum(raw.x, ...NUMERIC_BOUNDS.x) ?? 40,
    y: clampNum(raw.y, ...NUMERIC_BOUNDS.y) ?? 40,
    w: clampNum(raw.w, ...NUMERIC_BOUNDS.w) ?? dims.w,
    h: clampNum(raw.h, ...NUMERIC_BOUNDS.h) ?? dims.h,
  };

  const z = clampNum(raw.z, ...NUMERIC_BOUNDS.z);
  if (z !== undefined) el.z = Math.round(z);

  const content = truncate(raw.content, 10000);
  if (content !== undefined) el.content = content;

  const fontSize = clampNum(raw.fontSize, ...NUMERIC_BOUNDS.fontSize);
  if (fontSize !== undefined) el.fontSize = fontSize;

  const fontFamily = coerceFontFamily(raw.fontFamily);
  if (fontFamily) el.fontFamily = fontFamily;

  const fontWeight = coerceEnum(raw.fontWeight, ['normal', 'bold'] as const);
  if (fontWeight) el.fontWeight = fontWeight;

  const fontStyle = coerceEnum(raw.fontStyle, ['normal', 'italic'] as const);
  if (fontStyle) el.fontStyle = fontStyle;

  const lineHeight = clampNum(raw.lineHeight, ...NUMERIC_BOUNDS.lineHeight);
  if (lineHeight !== undefined) el.lineHeight = lineHeight;

  const color = coerceColor(raw.color);
  if (color) el.color = color;

  const textAlign = coerceEnum(raw.textAlign, ['left', 'center', 'right'] as const);
  if (textAlign) el.textAlign = textAlign;

  const padding = clampNum(raw.padding, ...NUMERIC_BOUNDS.padding);
  if (padding !== undefined) el.padding = padding;

  const src = truncate(raw.src, 2000);
  if (src !== undefined) el.src = src;

  const objectFit = coerceEnum(raw.objectFit, ['contain', 'cover', 'fill'] as const);
  if (objectFit) el.objectFit = objectFit;

  const backgroundColor = coerceColor(raw.backgroundColor);
  if (backgroundColor) el.backgroundColor = backgroundColor;

  const borderColor = coerceColor(raw.borderColor);
  if (borderColor) el.borderColor = borderColor;

  const borderWidth = clampNum(raw.borderWidth, ...NUMERIC_BOUNDS.borderWidth);
  if (borderWidth !== undefined) el.borderWidth = borderWidth;

  const borderRadius = clampNum(raw.borderRadius, ...NUMERIC_BOUNDS.borderRadius);
  if (borderRadius !== undefined) el.borderRadius = borderRadius;

  if (type === 'table') {
    const dataset = coerceEnum(raw.dataset, ['services', 'parts'] as const);
    if (dataset) el.dataset = dataset;
    const columns = repairTableColumns(raw.columns, dataset);
    if (columns) el.columns = columns;
    const headerBg = coerceColor(raw.headerBg);
    if (headerBg) el.headerBg = headerBg;
    const headerColor = coerceColor(raw.headerColor);
    if (headerColor) el.headerColor = headerColor;
    if (raw.altRowBg === '') el.altRowBg = '';
    else { const altRowBg = coerceColor(raw.altRowBg); if (altRowBg) el.altRowBg = altRowBg; }
    if (typeof raw.showBorders === 'boolean') el.showBorders = raw.showBorders;
  }

  if (type === 'totals') {
    const totalsRows = repairTotalsRows(raw.totalsRows);
    if (totalsRows) el.totalsRows = totalsRows;
    if (typeof raw.totalsEmphasizeLast === 'boolean') el.totalsEmphasizeLast = raw.totalsEmphasizeLast;
  }

  if (type === 'gridtable') {
    const cellsSourceLen = Array.isArray(raw.gridCells) ? raw.gridCells.length : undefined;
    const colsSourceLen = Array.isArray(raw.gridCells?.[0]) ? raw.gridCells[0].length : undefined;
    const gridRows = Math.round(clampNum(raw.gridRows, 1, 30) ?? clampNum(cellsSourceLen, 1, 30) ?? 1);
    const gridCols = Math.round(clampNum(raw.gridCols, 1, 12) ?? clampNum(colsSourceLen, 1, 12) ?? 1);
    el.gridRows = gridRows;
    el.gridCols = gridCols;
    el.gridCells = repairGridCells(raw.gridCells, gridRows, gridCols);
    if (typeof raw.gridHeaderRow === 'boolean') el.gridHeaderRow = raw.gridHeaderRow;

    if (Array.isArray(raw.gridColWidths)) {
      const widths: number[] = [];
      for (let c = 0; c < gridCols; c++) widths.push(clampNum(raw.gridColWidths[c], 1, 100) ?? Math.round((100 / gridCols) * 10) / 10);
      el.gridColWidths = widths;
    }
    if (Array.isArray(raw.gridRowHeights)) {
      const heights: number[] = [];
      for (let r = 0; r < gridRows; r++) heights.push(clampNum(raw.gridRowHeights[r], 10, 1000) ?? 32);
      el.gridRowHeights = heights;
    }
  }

  return el as IDesignElement;
}

export function repairAndValidateElements(
  rawElements: unknown,
  docType: TemplateDocType,
): { elements: IDesignElement[]; warnings: string[] } {
  const warnings: string[] = [];

  if (!Array.isArray(rawElements)) {
    return { elements: [], warnings: ['The analyzer returned no usable layout — try again or build this template manually.'] };
  }

  const usedIds = new Set<string>();
  const repaired: IDesignElement[] = [];

  for (const [i, raw] of rawElements.slice(0, MAX_ELEMENTS).entries()) {
    const el = repairElement(raw, usedIds, warnings, i);
    if (!el) continue;

    const check = designElementSchema.safeParse(el);
    if (!check.success) {
      warnings.push(`Dropped an unrecoverable ${el.type} element (position ${i}): ${check.error.issues[0]?.message ?? 'failed validation'}`);
      continue;
    }
    repaired.push(check.data as IDesignElement);
  }

  resolveFlowOverlaps(repaired);
  // y may have shifted; re-clamp to the schema's bound so a document dense
  // enough to push things far down still passes the final gate below rather
  // than throwing.
  for (const el of repaired) el.y = Math.min(20000, Math.max(-2000, el.y));

  // Final request-level gate — must pass before this is ever handed back to
  // the frontend as save-ready JSON. Should always succeed given every
  // element already passed designElementSchema individually; kept as a real
  // gate, not a formality, in case an unexpected interaction slips through.
  const finalCheck = createTemplateSchema.safeParse({
    name: 'AI Draft', docType, elements: repaired,
  });
  if (!finalCheck.success) {
    throw new Error(`Repaired template still failed validation: ${finalCheck.error.issues[0]?.message ?? 'unknown error'}`);
  }

  return { elements: finalCheck.data.elements ?? [], warnings };
}
