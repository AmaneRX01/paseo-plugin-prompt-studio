import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";
import {
  checkpointIdSchema,
  draftDetailSchema,
  draftIdSchema,
  generationIdSchema,
} from "./contracts.shared";

const isoDateSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const generationTaskSchema = z.enum(["related", "format"]);
export const generationLocaleSchema = z.enum(["en", "zh"]);
export const generationTimeRangeSchema = z.enum(["7d", "30d", "90d", "all"]);

export const generationProviderConfigSchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  thinkingOptionId: z.string().trim().min(1).nullable(),
}).strict();

export const generationSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.number().int().positive(),
  related: generationProviderConfigSchema.nullable(),
  format: generationProviderConfigSchema.nullable(),
  updatedAt: isoDateSchema,
}).strict();

export const generationContextFiltersSchema = z.object({
  includeHistory: z.boolean(),
  timeRange: generationTimeRangeSchema,
  tagPaths: z.array(z.string().trim().min(1)).max(100),
  crossProject: z.boolean(),
  projectIds: z.array(z.string().min(1)).max(100),
  includeInbox: z.boolean(),
}).strict();

export const defaultGenerationContextFilters = Object.freeze({
  includeHistory: true,
  timeRange: "90d",
  tagPaths: [] as string[],
  crossProject: false,
  projectIds: [] as string[],
  includeInbox: false,
}) satisfies GenerationContextFilters;

export const generationContextCountsSchema = z.object({
  eligibleOtherPromptCount: z.number().int().nonnegative(),
  includedOtherPromptCount: z.number().int().nonnegative(),
  eligibleReferenceVersionCount: z.number().int().nonnegative(),
  includedReferenceVersionCount: z.number().int().nonnegative(),
  eligibleTargetHistoryVersionCount: z.number().int().nonnegative(),
  includedTargetHistoryVersionCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  estimatedInputTokens: z.number().int().nonnegative(),
  inputTokenBudget: z.number().int().positive(),
}).strict();

export const generationContextSourceSchema = z.object({
  draftId: draftIdSchema,
  checkpointId: checkpointIdSchema.nullable(),
  kind: z.enum(["current", "checkpoint"]),
  at: isoDateSchema,
  contentHash: sha256Schema,
}).strict();

export const generationProjectSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  workspaceId: z.string().min(1),
}).strict();

export const generationProtectionSchema = z.object({
  level: z.enum(["native-policy", "behavioral-only"]),
  projectRead: z.boolean(),
  warning: z.string().nullable(),
}).strict();

export const generationPreviewSchema = z.object({
  draftId: draftIdSchema,
  task: generationTaskSchema,
  project: generationProjectSchema,
  configuration: generationProviderConfigSchema,
  counts: generationContextCountsSchema,
  protection: generationProtectionSchema,
}).strict();

export const generationJobStatusSchema = z.enum([
  "prepared",
  "launching",
  "running",
  "result-ready",
  "applied",
  "conflict",
  "needs-attention",
  "failed",
  "discarded",
  "abandoned",
]);

export const generationJobRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: generationIdSchema,
  draftId: draftIdSchema,
  task: generationTaskSchema,
  status: generationJobStatusSchema,
  baseVersion: z.number().int().positive(),
  baseHash: sha256Schema,
  locale: generationLocaleSchema,
  allowProjectRead: z.boolean(),
  filters: generationContextFiltersSchema.nullable(),
  configuration: generationProviderConfigSchema,
  project: generationProjectSchema,
  counts: generationContextCountsSchema,
  includedSources: z.array(generationContextSourceSchema),
  protection: generationProtectionSchema,
  requestId: z.string().regex(/^prompt-studio:generation:[a-z0-9_:-]+$/),
  clientMessageId: z.string().regex(/^prompt-studio:generation:[a-z0-9_:-]+$/),
  requestHash: sha256Schema,
  responseHash: sha256Schema.nullable(),
  responseCapturedAt: isoDateSchema.nullable(),
  agentId: z.string().min(1).nullable(),
  checkpointId: checkpointIdSchema.nullable(),
  appliedVersion: z.number().int().positive().nullable(),
  appliedHash: sha256Schema.nullable(),
  error: z.string().nullable(),
  archiveWarning: z.string().nullable(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  completedAt: isoDateSchema.nullable(),
}).strict();

export const generationJobSchema = generationJobRecordSchema.extend({
  responseMarkdown: z.string().nullable(),
}).strict();

const generationDraftVersionInputSchema = z.object({
  draftId: draftIdSchema,
  expectedVersion: z.number().int().positive(),
  expectedHash: sha256Schema,
}).strict();

const generationJobInputSchema = z.object({
  draftId: draftIdSchema,
  generationId: generationIdSchema,
}).strict();

const generationJobMutationOutputSchema = z.object({
  job: generationJobSchema,
  draft: draftDetailSchema.nullable(),
}).strict();

export const generationSettingsGetRpc = defineRpc({
  name: "prompt-studio.generation-settings-get",
  input: z.object({}).strict(),
  output: z.object({ settings: generationSettingsSchema }).strict(),
});

export const generationSettingsUpdateRpc = defineRpc({
  name: "prompt-studio.generation-settings-update",
  input: z.object({
    expectedVersion: z.number().int().positive(),
    related: generationProviderConfigSchema.nullable(),
    format: generationProviderConfigSchema.nullable(),
  }).strict(),
  output: z.object({ settings: generationSettingsSchema }).strict(),
});

export const generationPreviewRpc = defineRpc({
  name: "prompt-studio.generation-preview",
  input: generationDraftVersionInputSchema.extend({
    task: generationTaskSchema.default("related"),
    locale: generationLocaleSchema,
    filters: generationContextFiltersSchema,
    allowProjectRead: z.boolean().default(false),
  }).strict(),
  output: z.object({ preview: generationPreviewSchema }).strict(),
});

export const generationStartRpc = defineRpc({
  name: "prompt-studio.generation-start",
  input: generationDraftVersionInputSchema.extend({
    generationId: generationIdSchema.nullable().default(null),
    task: generationTaskSchema,
    locale: generationLocaleSchema,
    allowProjectRead: z.boolean(),
    filters: generationContextFiltersSchema.nullable(),
  }).strict(),
  output: z.object({
    job: generationJobSchema,
    preview: generationPreviewSchema,
  }).strict(),
});

export const generationGetRpc = defineRpc({
  name: "prompt-studio.generation-get",
  input: z.object({
    draftId: draftIdSchema,
    generationId: generationIdSchema.nullable().default(null),
  }).strict(),
  output: z.object({ job: generationJobSchema.nullable() }).strict(),
});

export const generationSyncRpc = defineRpc({
  name: "prompt-studio.generation-sync",
  input: generationJobInputSchema,
  output: generationJobMutationOutputSchema,
});

export const generationApplyCandidateRpc = defineRpc({
  name: "prompt-studio.generation-apply-candidate",
  input: generationJobInputSchema.extend({
    expectedVersion: z.number().int().positive(),
    expectedHash: sha256Schema,
  }).strict(),
  output: generationJobMutationOutputSchema,
});

export const generationDiscardRpc = defineRpc({
  name: "prompt-studio.generation-discard",
  input: generationJobInputSchema,
  output: z.object({ job: generationJobSchema }).strict(),
});

export const generationAbandonRpc = defineRpc({
  name: "prompt-studio.generation-abandon",
  input: generationJobInputSchema,
  output: z.object({ job: generationJobSchema }).strict(),
});

export type GenerationTask = z.infer<typeof generationTaskSchema>;
export type GenerationLocale = z.infer<typeof generationLocaleSchema>;
export type GenerationTimeRange = z.infer<typeof generationTimeRangeSchema>;
export type GenerationProviderConfig = z.infer<typeof generationProviderConfigSchema>;
export type GenerationSettings = z.infer<typeof generationSettingsSchema>;
export type GenerationContextFilters = z.infer<typeof generationContextFiltersSchema>;
export type GenerationContextCounts = z.infer<typeof generationContextCountsSchema>;
export type GenerationContextSource = z.infer<typeof generationContextSourceSchema>;
export type GenerationProject = z.infer<typeof generationProjectSchema>;
export type GenerationProtection = z.infer<typeof generationProtectionSchema>;
export type GenerationPreview = z.infer<typeof generationPreviewSchema>;
export type GenerationJobStatus = z.infer<typeof generationJobStatusSchema>;
export type GenerationJobRecord = z.infer<typeof generationJobRecordSchema>;
export type GenerationJob = z.infer<typeof generationJobSchema>;
