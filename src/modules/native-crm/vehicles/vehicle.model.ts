import mongoose, { Schema, Document } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

export interface IVehicleDoc extends Document {
  tenantId:           mongoose.Types.ObjectId;
  branchId?:          mongoose.Types.ObjectId | null;
  clientId?:   string;
  numId:              number;
  vehicleId:          string;
  name:               string;
  registrationNumber?:string;
  make?:              string;
  vehicleModel?:      string;
  year?:              number;
  assignedTeam?:      string;
  assignedDriver?:    string;
  fuelType?:          'petrol' | 'diesel' | 'electric' | 'hybrid';
  lastServiceDate?:   Date;
  notes?:             string;
  status:             'active' | 'in_use' | 'under_maintenance' | 'retired';
  customFields?: Record<string, any>;
  createdBy?:         string;
  createdAt:          Date;
  updatedAt:          Date;
}

const schema = new Schema<IVehicleDoc>(
  {
    tenantId:           { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    branchId:           { type: Schema.Types.ObjectId, ref: 'Branch', default: null, index: true },
    clientId:  { type: String, index: true },
    numId:              { type: Number },
    vehicleId:          { type: String },
    name:               { type: String, required: true, trim: true },
    registrationNumber: { type: String, trim: true },
    make:               { type: String, trim: true },
    vehicleModel:       { type: String, trim: true },
    year:               { type: Number },
    assignedTeam:       { type: String, trim: true },
    assignedDriver:     { type: String, trim: true },
    fuelType:           { type: String, enum: ['petrol', 'diesel', 'electric', 'hybrid'] },
    lastServiceDate:    { type: Date },
    notes:              { type: String },
    status:             { type: String, enum: ['active', 'in_use', 'under_maintenance', 'retired'], default: 'active' },
    customFields: { type: Schema.Types.Mixed, default: {} },
    createdBy:          { type: String },
  },
  { timestamps: true }
);

schema.pre('save', async function (next) {
  if (!this.isNew) return next();
  const last = await (this.constructor as any).findOne({ tenantId: this.tenantId }).sort({ numId: -1 }).select('numId').lean();
  this.numId     = (last?.numId ?? 0) + 1;
  const pfx         = await resolveClientPrefix(this.tenantId);
  this.clientId = pfx;
  this.vehicleId = `${pfx}-VEH-${String(this.numId).padStart(4, '0')}`;
  next();
});

schema.index({ tenantId: 1 });
schema.index({ tenantId: 1, status: 1 });

export const NativeVehicle = mongoose.model<IVehicleDoc>('NativeVehicle', schema, 'native_vehicles');

