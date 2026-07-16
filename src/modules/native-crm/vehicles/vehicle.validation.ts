import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

export const createVehicleSchema = z.object({
  name:               z.string().trim().min(1).max(200),
  registrationNumber: z.string().trim().optional(),
  make:               z.string().trim().optional(),
  vehicleModel:       z.string().trim().optional(),
  year:               z.number().int().min(1900).max(2100).optional(),
  assignedTeam:       z.string().trim().optional(),
  assignedDriver:     z.string().trim().optional(),
  fuelType:           z.enum(['petrol','diesel','electric','hybrid']).optional(),
  lastServiceDate:    z.string().optional(),
  notes:              z.string().optional(),
  status:             z.enum(['active','in_use','under_maintenance','retired']).optional(),
  customFields,
});

export const updateVehicleSchema = createVehicleSchema.partial();
