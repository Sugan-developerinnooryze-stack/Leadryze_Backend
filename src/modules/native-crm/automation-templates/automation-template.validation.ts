import { z } from 'zod';

// "Save as template" — sourceFlowId only, never nodes/edges directly (see
// automation-template.service.ts's createTemplate for why).
export const createAutomationTemplateSchema = z.object({
  sourceFlowId: z.string().trim().min(1),
  name:         z.string().trim().min(1).max(120),
  description:  z.string().trim().max(500).optional(),
  category:     z.string().trim().max(60).optional(),
});
