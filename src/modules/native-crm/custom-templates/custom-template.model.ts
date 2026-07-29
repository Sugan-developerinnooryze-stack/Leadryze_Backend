import mongoose, { Schema, Document } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

// NOTE (lockstep rule): every property here MUST also exist in the zod schemas
// in custom-template.validation.ts — Mongoose strict mode silently drops keys
// missing from this schema, and zod strips keys missing from that one. The
// element-schema lockstep test guards this.

export type TemplateDocType = 'invoice' | 'quotation' | 'contract' | 'workorder';

export interface ITableColumn {
  key:    string;  // services: index|name|description|count|amount|lineTotal; parts adds partNumber
  label:  string;
  width?: number;  // percent of table width; undefined = auto
  align?: 'left' | 'center' | 'right';
}

export type TotalsRowKey =
  | 'servicesSubtotal' | 'partsSubtotal' | 'subtotal'
  | 'discount' | 'gst' | 'total' | 'paid' | 'balance';

export interface ITotalsRow {
  key:    TotalsRowKey;
  label?: string;  // display-label override
}

export interface IDesignElement {
  id:              string;
  type:            'text' | 'richtext' | 'image' | 'table' | 'totals' | 'divider' | 'box' | 'gridtable';
  x:               number;
  y:               number;
  w:               number;
  h:               number;
  z?:              number;
  // typography (text / richtext / table / totals)
  content?:        string;
  fontSize?:       number;
  fontFamily?:     string;
  fontWeight?:     'normal' | 'bold';
  fontStyle?:      'normal' | 'italic';
  lineHeight?:     number;
  color?:          string;
  textAlign?:      'left' | 'center' | 'right';
  padding?:        number;
  // image
  src?:            string;
  objectFit?:      'contain' | 'cover' | 'fill';
  // box / divider / table borders
  backgroundColor?: string;
  borderColor?:    string;
  borderWidth?:    number;
  borderRadius?:   number;
  // table
  dataset?:        'services' | 'parts';
  columns?:        ITableColumn[];
  headerBg?:       string;
  headerColor?:    string;
  altRowBg?:       string;
  showBorders?:    boolean;
  // totals
  totalsRows?:          ITotalsRow[];
  totalsEmphasizeLast?: boolean;
  // gridtable — a manually-authored grid (Word/Excel-style), unrelated to the
  // dynamic services/parts `table` above: laid out by hand, cell by cell,
  // rather than one row per line item. Each cell holds sanitized rich HTML —
  // text, bold/italic, bullet/numbered lists, and inline images can all
  // coexist in one cell — with {{token}} bindings substituted the same way a
  // plain `text` element's content is.
  gridRows?:        number;
  gridCols?:        number;
  gridCells?:       string[][];
  gridHeaderRow?:   boolean;
  gridColWidths?:   number[];
  gridRowHeights?:  number[];
}

export interface ITemplatePage {
  marginTopPx:    number;
  marginBottomPx: number;
}

/** A header/footer band that repeats on every printed page (own mini element set). */
export interface ITemplateRegion {
  enabled:  boolean;
  heightPx: number;
  elements: IDesignElement[];
}

export interface ICustomTemplate extends Document {
  tenantId:   mongoose.Types.ObjectId;
  clientId?:  string;
  docType:    TemplateDocType;
  name:       string;
  isDefault:  boolean;
  elements:   IDesignElement[];
  page?:      ITemplatePage;
  header?:    ITemplateRegion;
  footer?:    ITemplateRegion;
}

const tableColumnSchema = new Schema<ITableColumn>(
  {
    key:   { type: String, required: true },
    label: { type: String, required: true },
    width: Number,
    align: { type: String, enum: ['left', 'center', 'right'] },
  },
  { _id: false }
);

const totalsRowSchema = new Schema<ITotalsRow>(
  {
    key: {
      type: String,
      enum: ['servicesSubtotal','partsSubtotal','subtotal','discount','gst','total','paid','balance'],
      required: true,
    },
    label: String,
  },
  { _id: false }
);

const elementSchema = new Schema<IDesignElement>(
  {
    id:              { type: String, required: true },
    type:            { type: String, enum: ['text','richtext','image','table','totals','divider','box','gridtable'], required: true },
    x:               { type: Number, required: true },
    y:               { type: Number, required: true },
    w:               { type: Number, required: true },
    h:               { type: Number, required: true },
    z:               Number,
    content:         String,
    fontSize:        Number,
    fontFamily:      String,
    fontWeight:      String,
    fontStyle:       String,
    lineHeight:      Number,
    color:           String,
    textAlign:       String,
    padding:         Number,
    src:             String,
    objectFit:       { type: String, enum: ['contain','cover','fill'] },
    backgroundColor: String,
    borderColor:     String,
    borderWidth:     Number,
    borderRadius:    Number,
    dataset:         { type: String, enum: ['services','parts'] },
    columns:         { type: [tableColumnSchema], default: undefined },
    headerBg:        String,
    headerColor:     String,
    altRowBg:        String,
    showBorders:     Boolean,
    totalsRows:          { type: [totalsRowSchema], default: undefined },
    totalsEmphasizeLast: Boolean,
    gridRows:        Number,
    gridCols:        Number,
    gridCells:       { type: [[String]], default: undefined },
    gridHeaderRow:   Boolean,
    gridColWidths:   { type: [Number], default: undefined },
    gridRowHeights:  { type: [Number], default: undefined },
  },
  { _id: false }
);

const pageSchema = new Schema<ITemplatePage>(
  {
    marginTopPx:    { type: Number, default: 0 },
    marginBottomPx: { type: Number, default: 0 },
  },
  { _id: false }
);

const templateRegionSchema = new Schema<ITemplateRegion>(
  {
    enabled:  { type: Boolean, default: false },
    heightPx: { type: Number, default: 60 },
    elements: { type: [elementSchema], default: [] },
  },
  { _id: false }
);

const schema = new Schema<ICustomTemplate>(
  {
    tenantId:  { type: Schema.Types.ObjectId, required: true },
    clientId:  { type: String, index: true },
    docType:   { type: String, enum: ['invoice','quotation','contract','workorder'], required: true },
    name:      { type: String, required: true },
    isDefault: { type: Boolean, default: false },
    elements:  { type: [elementSchema], default: [] },
    page:      { type: pageSchema, default: undefined },
    header:    { type: templateRegionSchema, default: undefined },
    footer:    { type: templateRegionSchema, default: undefined },
  },
  { timestamps: true }
);

schema.pre('save', async function (next) {
  if (!this.isNew || this.clientId) return next();
  this.clientId = await resolveClientPrefix(this.tenantId as mongoose.Types.ObjectId);
  next();
});

schema.index({ tenantId: 1, docType: 1 });

export const CustomTemplate = mongoose.model<ICustomTemplate>(
  'CustomTemplate',
  schema,
  'custom_templates'
);
