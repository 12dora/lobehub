import { z } from 'zod';

import { checksumSchema, idSchema } from './common';
import { platformEffectiveAgentSchema } from './domain';

export const platformAgentEffectiveListOutputSchema = z
  .object({ agents: z.array(platformEffectiveAgentSchema).max(1000), revision: checksumSchema })
  .strict();

export const platformAgentEffectiveGetInputSchema = z
  .object({ platformAgentId: idSchema })
  .strict();

export const platformAgentEffectiveGetOutputSchema = platformEffectiveAgentSchema.nullable();

export const platformAgentSetHiddenInputSchema = z
  .object({ hidden: z.boolean(), platformAgentId: idSchema })
  .strict();

export const platformAgentSetHiddenOutputSchema = z.object({ success: z.literal(true) }).strict();
