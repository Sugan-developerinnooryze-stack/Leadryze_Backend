import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

const currentYear = new Date().getFullYear();

const baseVehicleSchema = z.object({
  name:               z.string().trim().min(1, 'Vehicle name is required').max(200),
  registrationNumber: z.string().trim().optional(),
  make:               z.string().trim().optional(),
  vehicleModel:       z.string().trim().optional(),
  year:               z.preprocess(
                        (val) => (val === '' || val === null || val === undefined ? undefined : Number(val)),
                        z.number().int('Year must be an integer').min(1900, 'Year must be at least 1900').max(currentYear + 1, `Year cannot be in the future (max ${currentYear + 1})`).optional()
                      ),
  assignedTeam:       z.string().trim().optional(),
  assignedDriver:     z.string().trim().optional(),
  fuelType:           z.enum(['petrol','diesel','electric','hybrid']).optional(),
  lastServiceDate:    z
                        .string()
                        .trim()
                        .optional()
                        .nullable()
                        .refine(
                          (val) => {
                            if (!val) return true;
                            const d = new Date(val);
                            if (isNaN(d.getTime())) return false;
                            const todayEnd = new Date();
                            todayEnd.setHours(23, 59, 59, 999);
                            return d <= todayEnd;
                          },
                          { message: 'Last service date cannot be in the future' }
                        ),
  notes:              z.string().optional(),
  status:             z.enum(['active','in_use','under_maintenance','retired']).optional(),
  customFields,
});

export const createVehicleSchema = baseVehicleSchema.refine(
  (data) => {
    if (data.year && data.lastServiceDate) {
      const d = new Date(data.lastServiceDate);
      if (!isNaN(d.getTime()) && d.getFullYear() < data.year) {
        return false;
      }
    }
    return true;
  },
  {
    message: 'Last service date cannot be earlier than manufacture year',
    path: ['lastServiceDate'],
  }
);

export const updateVehicleSchema = baseVehicleSchema.partial().refine(
  (data) => {
    if (data.year && data.lastServiceDate) {
      const d = new Date(data.lastServiceDate);
      if (!isNaN(d.getTime()) && d.getFullYear() < data.year) {
        return false;
      }
    }
    return true;
  },
  {
    message: 'Last service date cannot be earlier than manufacture year',
    path: ['lastServiceDate'],
  }
);
