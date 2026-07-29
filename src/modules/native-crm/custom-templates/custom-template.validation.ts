import { z } from 'zod';

// Lockstep rule: every key accepted here MUST also be declared in the Mongoose
// element schema (custom-template.model.ts) and vice versa — either side
// silently drops unknown keys. Guarded by the element-schema lockstep test.

export const FONT_FAMILIES = [
  'Arial', 'Helvetica', 'Georgia', 'Times New Roman',
  'Courier New', 'Verdana', 'Tahoma', 'Trebuchet MS',
] as const;

// #rgb / #rrggbb / #rrggbbaa, or the keyword 'transparent'. Exported so other
// modules (e.g. the template-analysis repair pipeline) validate/coerce
// against the exact same pattern instead of hand-duplicating it.
export const COLOR_REGEX = /^(#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?|transparent)$/;
const color = z.string().regex(COLOR_REGEX, 'Invalid color');

export const SERVICE_COLUMN_KEYS = ['index', 'name', 'description', 'count', 'amount', 'lineTotal'] as const;
export const PART_COLUMN_KEYS    = [...SERVICE_COLUMN_KEYS, 'partNumber'] as const;
export const TOTALS_ROW_KEYS = ['servicesSubtotal','partsSubtotal','subtotal','discount','gst','total','paid','balance'] as const;

const tableColumnSchema = z.object({
  key:   z.enum(PART_COLUMN_KEYS), // superset; dataset-specific check in superRefine below
  label: z.string().max(80),
  width: z.number().min(1).max(100).optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
});

const totalsRowSchema = z.object({
  key:   z.enum(TOTALS_ROW_KEYS),
  label: z.string().max(80).optional(),
});

export const designElementSchema = z.object({
  id:              z.string().min(1).max(40),
  type:            z.enum(['text','richtext','image','table','totals','divider','box','gridtable']),
  x:               z.number().min(-2000).max(4000),
  y:               z.number().min(-2000).max(20000),
  w:               z.number().min(1).max(4000),
  h:               z.number().min(1).max(20000),
  z:               z.number().int().min(0).max(999).optional(),
  content:         z.string().max(10000).optional(),
  fontSize:        z.number().min(6).max(120).optional(),
  fontFamily:      z.enum(FONT_FAMILIES).optional(),
  fontWeight:      z.enum(['normal','bold']).optional(),
  fontStyle:       z.enum(['normal','italic']).optional(),
  lineHeight:      z.number().min(0.5).max(4).optional(),
  color:           color.optional(),
  textAlign:       z.enum(['left','center','right']).optional(),
  padding:         z.number().min(0).max(100).optional(),
  src:             z.string().max(2000).optional(),
  objectFit:       z.enum(['contain','cover','fill']).optional(),
  backgroundColor: color.optional(),
  borderColor:     color.optional(),
  borderWidth:     z.number().min(0).max(30).optional(),
  borderRadius:    z.number().min(0).max(100).optional(),
  dataset:         z.enum(['services','parts']).optional(),
  columns:         z.array(tableColumnSchema).max(12).optional(),
  headerBg:        color.optional(),
  headerColor:     color.optional(),
  altRowBg:        z.union([color, z.literal('')]).optional(),
  showBorders:     z.boolean().optional(),
  totalsRows:          z.array(totalsRowSchema).max(8).optional(),
  totalsEmphasizeLast: z.boolean().optional(),
  // gridtable — a manually-authored grid, unrelated to `table`'s dynamic
  // services/parts binding. Each cell holds sanitized rich HTML (text,
  // lists, inline images) with {{token}} bindings substituted the same way
  // a plain `text` element's content is — see gridTableHtml/sanitizeRich.
  gridRows:        z.number().int().min(1).max(30).optional(),
  gridCols:        z.number().int().min(1).max(12).optional(),
  gridCells:       z.array(z.array(z.string().max(5000)).max(12)).max(30).optional(),
  gridHeaderRow:   z.boolean().optional(),
  gridColWidths:   z.array(z.number().min(1).max(100)).max(12).optional(),
  gridRowHeights:  z.array(z.number().min(10).max(1000)).max(30).optional(),
}).superRefine((el, ctx) => {
  // partNumber only makes sense for the parts dataset
  if (el.type === 'table' && el.dataset !== 'parts' && el.columns?.some((c) => c.key === 'partNumber')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'partNumber column is only valid for the parts dataset' });
  }
  // gridtable's cell grid must actually match its declared dimensions —
  // catches a malformed payload before it ever reaches the renderer.
  if (el.type === 'gridtable') {
    const rows = el.gridRows ?? 0;
    const cols = el.gridCols ?? 0;
    const cells = el.gridCells;
    if (!cells || cells.length !== rows || cells.some((row) => row.length !== cols)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'gridCells must be exactly gridRows × gridCols' });
    }
    if (el.gridRowHeights && el.gridRowHeights.length !== rows) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'gridRowHeights, if present, must have exactly gridRows entries' });
    }
  }
});

const pageSchema = z.object({
  marginTopPx:    z.number().min(0).max(200),
  marginBottomPx: z.number().min(0).max(200),
});

// Header/footer are fixed-height repeating bands — flow-height elements
// (table/richtext/gridtable) can't live inside one, since their real
// rendered height isn't known until the content actually paginates.
const headerFooterElementSchema = designElementSchema.refine(
  (el) => el.type !== 'table' && el.type !== 'richtext' && el.type !== 'gridtable',
  { message: 'table/richtext/gridtable elements are not allowed in a header/footer band' }
);

export const templateRegionSchema = z.object({
  enabled:  z.boolean(),
  heightPx: z.number().min(0).max(300),
  elements: z.array(headerFooterElementSchema).max(50),
});

const elementsArray = z.array(designElementSchema).max(200);

export const createTemplateSchema = z.object({
  name:      z.string().trim().min(1).max(120),
  docType:   z.enum(['invoice','quotation','contract','workorder']),
  elements:  elementsArray.optional(),
  isDefault: z.boolean().optional(),
  page:      pageSchema.optional(),
  header:    templateRegionSchema.optional(),
  footer:    templateRegionSchema.optional(),
});

export const updateTemplateSchema = z.object({
  name:      z.string().trim().min(1).max(120).optional(),
  elements:  elementsArray.optional(),
  isDefault: z.boolean().optional(),
  page:      pageSchema.optional(),
  header:    templateRegionSchema.optional(),
  footer:    templateRegionSchema.optional(),
});
