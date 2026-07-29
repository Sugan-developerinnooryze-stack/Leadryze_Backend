import mongoose, { Schema, Document } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

/** A tenant-uploaded image, browsable/draggable in the PDF Designer's Uploads panel. */
export interface ITemplateAssetDoc extends Document {
  tenantId:    mongoose.Types.ObjectId;
  clientId?:   string;
  url:         string;
  key:         string;
  filename:    string;
  mimetype:    string;
  size:        number;
  uploadedBy?: string;
  createdAt:   Date;
  updatedAt:   Date;
}

const schema = new Schema<ITemplateAssetDoc>(
  {
    tenantId:   { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    clientId:   { type: String, index: true },
    url:        { type: String, required: true },
    key:        { type: String, required: true },
    filename:   { type: String, required: true, trim: true },
    mimetype:   { type: String, required: true },
    size:       { type: Number, required: true },
    uploadedBy: { type: String },
  },
  { timestamps: true }
);

schema.pre('save', async function (next) {
  if (!this.isNew || this.clientId) return next();
  this.clientId = await resolveClientPrefix(this.tenantId as mongoose.Types.ObjectId);
  next();
});

schema.index({ tenantId: 1, createdAt: -1 });

export const TemplateAsset = mongoose.model<ITemplateAssetDoc>(
  'TemplateAsset',
  schema,
  'native_template_assets'
);
