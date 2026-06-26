import { DEFAULT_CLUSTER_PROMPT, DEFAULT_NOTES_PROMPT } from "@aipm/core";
import { z } from "zod";

const signalKinds = [
  "mentioned_no_response",
  "review_requested",
  "unaddressed_review_comments",
  "pr_no_reviewer",
  "draft_pr_aged",
  "in_progress_stale",
  "blocker_cleared",
] as const;

export const calendarSchema = z.object({
  timezone: z.string().default("UTC"),
  workingDays: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5]),
  workingHours: z.tuple([z.number(), z.number()]).optional(),
  holidays: z.array(z.string()).optional(),
});

export const signalConfigSchema = z.object({
  quietPeriodHours: z.number().nonnegative(),
  maxEscalations: z.number().int().nonnegative().default(3),
  enabled: z.boolean().default(true),
});

export const shadowSchema = z.object({
  global: z.boolean().default(true),
  capabilities: z
    .object({
      nudges: z.boolean().optional(),
      workingNotes: z.boolean().optional(),
      proposals: z.boolean().optional(),
      digest: z.boolean().optional(),
    })
    .default({}),
});

export const engineConfigSchema = z.object({
  // prefault (not default): zod v4's .default() returns the value as-is without
  // re-parsing, so an empty object would skip the nested field defaults. prefault
  // feeds {} back through the schema so timezone/workingDays/global/… fill in.
  calendar: calendarSchema.prefault({}),
  signals: z.record(z.enum(signalKinds), signalConfigSchema),
  shadow: shadowSchema.prefault({}),
  botAccounts: z.array(z.string().trim().toLowerCase()).default([]),
  llmJudge: z.boolean().default(false),
  notesPrompt: z.string().trim().min(1).default(DEFAULT_NOTES_PROMPT),
  clusterPrompt: z.string().trim().min(1).default(DEFAULT_CLUSTER_PROMPT),
  platforms: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});

export type EngineConfigInput = z.input<typeof engineConfigSchema>;
export { signalKinds };
