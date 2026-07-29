import sanitizeHtml from 'sanitize-html';
import { IDesignElement, ITemplatePage, ITemplateRegion } from '../custom-templates/custom-template.model';
import {
  RenderCtx, buildVarMap, esc,
  DEFAULT_SERVICE_COLUMNS, DEFAULT_PART_COLUMNS, cellValue,
  DEFAULT_TOTALS_ROWS, TOTALS_LABELS, totalsValue,
} from './variable-catalog';

/**
 * Renders a designer template (absolute-positioned JSON elements) to HTML.
 *
 * Pagination ("band model"): flow-height elements split the canvas into
 * alternating bands. Non-flow elements group into relative-positioned bands
 * (absolute inside); flow elements render as normal-flow blocks so Puppeteer
 * paginates them natively (thead repeats per page). A flow element's
 * design-time height is only a coordinate placeholder — real data height
 * replaces it and everything below shifts naturally.
 *
 * 'table' and 'richtext' get flow treatment — both have genuinely
 * data-dependent, unbounded content (row count / notes-terms text length).
 * 'gridtable' still renders as a normal fixed-height absolute element (its
 * content still comes from gridTableHtml() below, unchanged) — it's
 * manually-authored static content, not variable-driven, so it has no
 * "empty" state to collapse and no benefit from flow treatment.
 *
 * Zero flow elements → legacy absolute single-page path (old templates render
 * exactly as before).
 */

const PAGE_W = 794;
const PAGE_H = 1123;

// 'richtext' included so an empty Notes/Terms box collapses to its real
// (near-zero) height instead of reserving its full design-time box and
// leaving a dead gap; real content auto-sizes without clipping, same as
// tables. 'gridtable' stays out — manually-authored static content has no
// "empty" state to collapse.
const FLOW_TYPES = new Set(['table', 'richtext']);

// ─── Rich text sanitizer (tenant-authored HTML → Puppeteer/iframe) ───────────

function sanitizeRich(html: string): string {
  return sanitizeHtml(html ?? '', {
    allowedTags: ['p','br','b','strong','i','em','u','s','ul','ol','li','h1','h2','h3','h4',
                  'blockquote','span','div','table','thead','tbody','tr','th','td','a','hr','img'],
    allowedAttributes: {
      a: ['href'],
      img: ['src'], // no inline style on img — sizing comes from the fixed .tpl-rich img CSS rule instead
      '*': ['style'],
    },
    allowedStyles: {
      '*': {
        'color': [/^#[0-9a-fA-F]{3,8}$/, /^rgb/],
        'text-align': [/^left$/, /^right$/, /^center$/],
        'font-weight': [/^bold$/, /^normal$/, /^\d{3}$/],
        'font-style': [/^italic$/, /^normal$/],
        'text-decoration': [/^underline$/, /^line-through$/],
      },
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['http', 'https'] },
  });
}

// ─── Shared style helpers ────────────────────────────────────────────────────

function typographyCss(el: IDesignElement): string {
  return [
    `font-size:${el.fontSize ?? 13}px`,
    el.fontFamily ? `font-family:'${el.fontFamily}', Arial, sans-serif` : '',
    `font-weight:${el.fontWeight ?? 'normal'}`,
    `font-style:${el.fontStyle ?? 'normal'}`,
    el.lineHeight ? `line-height:${el.lineHeight}` : '',
    `color:${el.color ?? '#111827'}`,
    `text-align:${el.textAlign ?? 'left'}`,
    el.padding ? `padding:${el.padding}px` : '',
  ].filter(Boolean).join(';');
}

function replaceVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (_, key) => vars[key.trim()] ?? '');
}

// ─── Table element ───────────────────────────────────────────────────────────
// DEFAULT_SERVICE_COLUMNS / DEFAULT_PART_COLUMNS / cellValue now live in
// variable-catalog.ts (shared with the live-data endpoint).

function tableHtml(el: IDesignElement, ctx: RenderCtx): string {
  const dataset = el.dataset ?? 'services';
  const rows: any[] = (dataset === 'parts' ? ctx.doc?.parts : ctx.doc?.services) ?? [];
  const columns = el.columns?.length
    ? el.columns
    : (dataset === 'parts' ? DEFAULT_PART_COLUMNS : DEFAULT_SERVICE_COLUMNS);

  const headerBg    = el.headerBg    ?? '#f3f4f6';
  const headerColor = el.headerColor ?? '#374151';
  const altRowBg    = el.altRowBg === '' ? '' : (el.altRowBg ?? '#f9fafb');
  const borders     = el.showBorders !== false;
  const borderCss   = borders ? `border:1px solid ${el.borderColor ?? '#e5e7eb'};` : 'border:none;';
  const fontSize    = el.fontSize ?? 11;
  const fontFamily  = el.fontFamily ? `font-family:'${el.fontFamily}', Arial, sans-serif;` : '';

  const colgroup = columns.map((c) =>
    c.width ? `<col style="width:${c.width}%">` : '<col>'
  ).join('');

  const thead = columns.map((c) =>
    `<th style="padding:5px 8px;${borderCss}text-align:${c.align ?? 'left'};background:${headerBg};color:${headerColor}">${esc(c.label)}</th>`
  ).join('');

  const body = rows.length
    ? rows.map((row, i) => {
        const bg = altRowBg && i % 2 === 1 ? `background:${altRowBg};` : '';
        const tds = columns.map((c) =>
          `<td style="padding:4px 8px;${borderCss}text-align:${c.align ?? 'left'};${bg}">${cellValue(row, c.key, i, ctx.cur)}</td>`
        ).join('');
        return `<tr>${tds}</tr>`;
      }).join('')
    : `<tr><td colspan="${columns.length}" style="padding:8px;text-align:center;color:#9ca3af;${borderCss}">No ${dataset} listed</td></tr>`;

  return `
    <table class="tpl-table" style="width:100%;border-collapse:collapse;font-size:${fontSize}px;${fontFamily}">
      <colgroup>${colgroup}</colgroup>
      <thead><tr>${thead}</tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

// ─── Totals element ──────────────────────────────────────────────────────────
// DEFAULT_TOTALS_ROWS / TOTALS_LABELS / totalsValue now live in
// variable-catalog.ts (shared with the live-data endpoint).

function totalsHtml(el: IDesignElement, ctx: RenderCtx): string {
  const rows = el.totalsRows?.length ? el.totalsRows : DEFAULT_TOTALS_ROWS;
  const emphasize = el.totalsEmphasizeLast !== false;
  const fontSize = el.fontSize ?? 11;
  const color = el.color ?? '#111827';
  const fontFamily = el.fontFamily ? `font-family:'${el.fontFamily}', Arial, sans-serif;` : '';

  const rowHtml = rows.map((r, i) => {
    const last = emphasize && i === rows.length - 1;
    const style = last
      ? `font-weight:bold;font-size:${fontSize + 2}px;border-top:2px solid #d1d5db;padding-top:5px;margin-top:3px;`
      : '';
    return `
      <div style="display:flex;justify-content:space-between;padding:2px 0;${style}">
        <span style="${last ? '' : 'color:#6b7280'}">${esc(r.label || TOTALS_LABELS[r.key])}</span>
        <span>${esc(totalsValue(r.key, ctx))}</span>
      </div>`;
  }).join('');

  return `<div style="font-size:${fontSize}px;color:${color};${fontFamily}">${rowHtml}</div>`;
}

// ─── Richtext element ────────────────────────────────────────────────────────

function richtextHtml(el: IDesignElement, ctx: RenderCtx): string {
  const binding = (el.content ?? '').trim();
  const isTerms = binding.includes('doc.terms');
  const isNotes = binding.includes('doc.notes');
  let raw = '';
  if (isTerms) raw = ctx.doc?.termsAndConditions ?? '';
  else if (isNotes) raw = ctx.doc?.notes ?? '';
  else raw = binding; // literal rich content typed in the designer
  // Notes/Terms are conditional sections — no heading and no box at all when
  // this invoice has nothing to show (an empty <div> collapses to ~0 height
  // in flow, so this also closes the gap that would otherwise sit where the
  // box used to be reserved).
  if ((isTerms || isNotes) && !String(raw ?? '').replace(/<[^>]+>/g, '').trim()) return '';
  const inner = sanitizeRich(raw);
  const heading = isTerms ? 'Terms &amp; Conditions' : isNotes ? 'Notes' : '';
  const headingHtml = heading ? `<p style="font-weight:bold;margin:0 0 4px;">${heading}</p>` : '';
  return `<div class="tpl-rich" style="${typographyCss(el)}">${headingHtml}${inner}</div>`;
}

// ─── Grid table element (manually-authored, Word/Excel-style) ────────────────
// Each cell holds sanitized rich HTML — text, bold/italic, bullet/numbered
// lists, and inline images can all coexist in one cell, same as a real
// spreadsheet/document cell. {{token}} bindings are substituted first (same
// mechanism as a plain `text` element), then the result is sanitized through
// the same allowlist as the richtext element (now extended to allow <img>).

function gridTableHtml(el: IDesignElement, vars: Record<string, string>): string {
  const rows    = el.gridCells ?? [];
  const heights = el.gridRowHeights;
  const cols    = el.gridCols ?? (rows[0]?.length ?? 0);
  const widths  = el.gridColWidths;
  const borderCss = 'border:1px solid #e5e7eb;';
  const fontSize = el.fontSize ?? 11;
  const fontFamily = el.fontFamily ? `font-family:'${el.fontFamily}', Arial, sans-serif;` : '';

  // The designer canvas always shows an even split when columns haven't been
  // manually resized (GridTablePreview defaults each <col> to 100/cols and
  // fixes table-layout so content never skews it). Without an explicit
  // colgroup + table-layout:fixed here too, a plain <table> falls back to
  // content-based auto-sizing — same data, visibly different columns from
  // what the canvas showed.
  const effectiveWidths = widths?.length === cols ? widths : Array.from({ length: cols }, () => 100 / cols);
  const colgroup = effectiveWidths.map((w) => `<col style="width:${w}%">`).join('');

  const cellStyle = (isHeader: boolean) =>
    `padding:5px 8px;${borderCss}text-align:left;vertical-align:middle;${isHeader ? 'background:#f3f4f6;color:#374151;font-weight:bold;' : ''}`;

  const cellInner = (cellHtml: string): string => {
    const substituted = replaceVars(cellHtml, vars);
    // An <img> whose {{token}} never resolved becomes src="" — drop it
    // instead of leaving a confusing broken-image icon in the PDF.
    const cleaned = substituted.replace(/<img\b[^>]*\bsrc=""[^>]*>/gi, '');
    return `<div class="tpl-rich">${sanitizeRich(cleaned)}</div>`;
  };

  const rowHtml = (row: string[], rowIdx: number, isHeader: boolean) => {
    const heightPx = heights?.[rowIdx];
    const tds = row.map((cellHtml) => {
      const tag = isHeader ? 'th' : 'td';
      return `<${tag} style="${cellStyle(isHeader)}">${cellInner(cellHtml)}</${tag}>`;
    }).join('');
    return `<tr${heightPx ? ` style="height:${heightPx}px"` : ''}>${tds}</tr>`;
  };

  const hasHeader = !!el.gridHeaderRow && rows.length > 0;
  const bodyRows  = hasHeader ? rows.slice(1) : rows;
  // <thead> repeats on every page a tall grid spans, same as the dynamic table.
  const thead = hasHeader ? `<thead>${rowHtml(rows[0], 0, true)}</thead>` : '';
  const tbody = `<tbody>${bodyRows.map((r, i) => rowHtml(r, hasHeader ? i + 1 : i, false)).join('')}</tbody>`;

  return `
    <table class="tpl-table" style="width:100%;table-layout:fixed;border-collapse:collapse;font-size:${fontSize}px;${fontFamily}">
      <colgroup>${colgroup}</colgroup>
      ${thead}
      ${tbody}
    </table>`;
}

// ─── Per-element renderers ───────────────────────────────────────────────────

function renderElementContent(el: IDesignElement, vars: Record<string, string>, ctx: RenderCtx): string {
  if (el.type === 'divider') {
    return `<div style="width:100%;border-top:${el.borderWidth ?? 1}px solid ${el.borderColor ?? '#e5e7eb'};"></div>`;
  }
  if (el.type === 'box') {
    return `<div style="width:100%;height:100%;background:${el.backgroundColor ?? 'transparent'};border:${el.borderWidth ?? 0}px solid ${el.borderColor ?? 'transparent'};border-radius:${el.borderRadius ?? 4}px;"></div>`;
  }
  if (el.type === 'image') {
    const src = el.src ? replaceVars(el.src, vars) : '';
    if (!src) return '';
    return `<img src="${esc(src)}" style="width:100%;height:100%;object-fit:${el.objectFit ?? 'contain'};" />`;
  }
  if (el.type === 'table')     return tableHtml(el, ctx);
  if (el.type === 'totals')    return totalsHtml(el, ctx);
  if (el.type === 'richtext')  return richtextHtml(el, ctx);
  if (el.type === 'gridtable') return gridTableHtml(el, vars);
  // text
  const text = el.content ? replaceVars(el.content, vars) : '';
  return `<div style="${typographyCss(el)};white-space:pre-wrap;word-break:break-word;">${text}</div>`;
}

function absoluteWrap(el: IDesignElement, inner: string, offsetY: number): string {
  const clip = el.type === 'text' ? '' : 'overflow:hidden;';
  return `<div data-el-id="${esc(el.id)}" style="position:absolute;left:${el.x}px;top:${el.y - offsetY}px;width:${el.w}px;height:${el.h}px;z-index:${el.z ?? 1};${clip}">${inner}</div>`;
}

// ─── Header / footer (repeat on every printed page) ───────────────────────────
// `position:fixed` content repeats on every physical page under Chromium's
// print engine — the same engine both Puppeteer's page.pdf() and the on-screen
// iframe preview ultimately use — so header/footer render with the exact same
// element renderer as body content (full font/style/image parity), not via
// Puppeteer's separate, isolated displayHeaderFooter/headerTemplate API.
function regionHtml(region: ITemplateRegion | undefined, side: 'top' | 'bottom', vars: Record<string, string>, ctx: RenderCtx): string {
  if (!region?.enabled || !region.elements.length) return '';
  const inner = region.elements
    .map((el) => absoluteWrap(el, renderElementContent(el, vars, ctx), 0))
    .join('\n');
  // Mirror body's own centering (`width + margin:0 auto`) rather than
  // left:0/right:0, so the band stays aligned with page content regardless of
  // the Puppeteer/browser viewport width.
  return `<div style="position:fixed;${side}:0;left:0;right:0;margin:0 auto;width:${PAGE_W}px;height:${region.heightPx}px;overflow:hidden;z-index:1000;">${inner}</div>`;
}

// ─── Band assembly ───────────────────────────────────────────────────────────

export interface RenderedTemplate {
  html:        string;
  pageOptions: { marginTopPx: number; marginBottomPx: number };
}

function htmlShell(body: string, flowMode: boolean): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8"/>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 13px; color: #111827; background: #fff; width: ${PAGE_W}px; margin: 0 auto; }
  table.tpl-table { border-collapse: collapse; width: 100%; }
  table.tpl-table thead { display: table-header-group; }
  table.tpl-table tr { page-break-inside: avoid; }
  .band { position: relative; overflow: visible; }
  .band-footer { page-break-inside: avoid; }
  .tpl-rich p { margin: 0 0 4px; }
  .tpl-rich ul, .tpl-rich ol { margin: 4px 0; padding-left: 18px; }
  .tpl-rich h1, .tpl-rich h2, .tpl-rich h3, .tpl-rich h4 { margin: 4px 0; }
  .tpl-rich img { max-width: 100%; height: auto; display: block; }
  ${flowMode ? '' : `.page { position: relative; width: ${PAGE_W}px; min-height: ${PAGE_H}px; background: #fff; margin: 0 auto; }`}
</style>
</head>
<body>${body}</body>
</html>`;
}

export function renderCustomTemplateFull(
  elements: IDesignElement[],
  ctx: RenderCtx,
  page?: ITemplatePage,
  header?: ITemplateRegion,
  footer?: ITemplateRegion,
): RenderedTemplate {
  const vars = buildVarMap(ctx);
  // The header/footer band is reserved page margin — Puppeteer's page.pdf()
  // margin already blanks that space on every physical page, so the fixed
  // band lands exactly inside it with zero interaction with the band/cursor
  // pagination logic below.
  const pageOptions = {
    marginTopPx:    (page?.marginTopPx    ?? 0) + (header?.enabled ? header.heightPx : 0),
    marginBottomPx: (page?.marginBottomPx ?? 0) + (footer?.enabled ? footer.heightPx : 0),
  };

  const headerHtml = regionHtml(header, 'top', vars, ctx);
  const footerHtml = regionHtml(footer, 'bottom', vars, ctx);

  const flow = elements
    .filter((e) => FLOW_TYPES.has(e.type))
    .sort((a, b) => a.y - b.y);

  // Legacy path: no flow elements → absolute single page, byte-compatible.
  if (flow.length === 0) {
    const body = elements
      .map((el) => absoluteWrap(el, renderElementContent(el, vars, ctx), 0))
      .join('\n');
    return { html: htmlShell(`${headerHtml}${footerHtml}<div class="page">${body}</div>`, false), pageOptions };
  }

  // Band mode: alternate absolute bands and flow blocks.
  const nonFlow = elements.filter((e) => !FLOW_TYPES.has(e.type));
  const parts: string[] = [];
  let cursor = 0;
  // When flow elements are packed tighter (or overlap) in design-space than
  // their real heights allow, `cursor` can outrun a later flow element's own
  // y — the gap handed to bandFor() for that step becomes zero/negative
  // width. A strict `from <= y < to` membership test would then silently
  // drop any non-flow element whose y falls in that gap. Tracking what's
  // already been placed instead guarantees every element renders exactly
  // once — worst case it lands clamped to the top of the band it was caught
  // in rather than at its exact original y, but it's never just gone.
  const placed = new Set<string>();

  const bandFor = (from: number, to: number | null): string => {
    const members = nonFlow.filter((e) => !placed.has(e.id) && (to === null || e.y < to));
    members.forEach((e) => placed.add(e.id));
    if (to !== null) {
      const height = Math.max(0, to - from);
      if (!members.length && height === 0) return '';
      const inner = members
        .map((el) => absoluteWrap(el, renderElementContent(el, vars, ctx), from))
        .join('\n');
      return `<div class="band" style="height:${height}px">${inner}</div>`;
    }
    // Footer band: height derived from content extent.
    if (!members.length) return '';
    const bottom = Math.max(...members.map((e) => Math.max(e.y + e.h, from)));
    const height = Math.max(0, bottom - from);
    const inner = members
      .map((el) => absoluteWrap(el, renderElementContent(el, vars, ctx), from))
      .join('\n');
    const avoidBreak = height < 900 ? ' band-footer' : '';
    return `<div class="band${avoidBreak}" style="height:${height}px">${inner}</div>`;
  };

  for (const f of flow) {
    const bandTop = Math.max(cursor, 0);
    const flowTop = Math.max(f.y, bandTop);
    parts.push(bandFor(bandTop, flowTop));
    parts.push(
      `<div data-el-id="${esc(f.id)}" style="margin-left:${f.x}px;width:${f.w}px;">${renderElementContent(f, vars, ctx)}</div>`
    );
    cursor = f.y + f.h;
  }
  parts.push(bandFor(cursor, null));

  return { html: htmlShell(`${headerHtml}${footerHtml}${parts.filter(Boolean).join('\n')}`, true), pageOptions };
}

/** Legacy signature kept for existing call sites (single-page absolute only usage). */
export function renderCustomTemplate(
  elements: IDesignElement[],
  doc: any,
  settings: any,
  customer: any,
): string {
  const docType =
    doc?.invoiceId ? 'invoice' : doc?.quotationId && !doc?.contractId ? 'quotation'
    : doc?.contractId ? 'contract' : 'workorder';
  const ctx: RenderCtx = {
    doc, settings, customer,
    docType: docType as RenderCtx['docType'],
    cur: (settings?.currency && ({ AUD:'$',USD:'$',GBP:'£',EUR:'€',INR:'₹',CAD:'$',NZD:'$',SGD:'$' } as Record<string,string>)[settings.currency]) || '$',
    customFieldDefs: [],
  };
  return renderCustomTemplateFull(elements, ctx).html;
}
