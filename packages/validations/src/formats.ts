import { z } from "zod/v3";

export const createFormatSchema = z.object({
  app_pattern: z.string().min(1, "App pattern is required"),
  label: z.string().min(1, "Label is required"),
  instructions: z.string().min(1, "Instructions are required"),
  llm_provider: z.string().optional(),
  llm_model_id: z.string().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  system_prompt_override: z.string().optional(),
  shortcut: z.string().optional(),
});

export const updateFormatSchema = z.object({
  app_pattern: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  instructions: z.string().min(1).optional(),
  llm_provider: z.string().nullable().optional(),
  llm_model_id: z.string().nullable().optional(),
  max_output_tokens: z.number().int().positive().nullable().optional(),
  system_prompt_override: z.string().nullable().optional(),
  shortcut: z.string().nullable().optional(),
});

export type CreateFormatInput = z.infer<typeof createFormatSchema>;
export type UpdateFormatInput = z.infer<typeof updateFormatSchema>;
