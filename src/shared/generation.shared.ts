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
const generationFiniteTimeRangeSchema = z.string()
  .regex(/^[1-9]\d{0,3}d$/)
  .refine((value) => Number.parseInt(value, 10) <= 3_650, "Time range must not exceed 3650 days");
export const generationTimeRangeSchema = z.union([
  generationFiniteTimeRangeSchema,
  z.literal("all"),
]);
export const generationTimeRangeDaysSchema = z.tuple([
  z.number().int().min(1).max(3_650),
  z.number().int().min(1).max(3_650),
  z.number().int().min(1).max(3_650),
]).superRefine((values, context) => {
  if (values[0] >= values[1] || values[1] >= values[2]) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Time ranges must be strictly increasing",
    });
  }
});
export const DEFAULT_GENERATION_TIME_RANGE_DAYS = [3, 7, 14] as const;

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
  contextTimeRangeDays: generationTimeRangeDaysSchema.default([...DEFAULT_GENERATION_TIME_RANGE_DAYS]),
  updatedAt: isoDateSchema,
}).strict();

const legacyGenerationContextFiltersSchema = z.object({
  includeHistory: z.boolean(),
  timeRange: generationTimeRangeSchema,
  tagPaths: z.array(z.string().trim().min(1)).max(100),
  crossProject: z.boolean(),
  projectIds: z.array(z.string().min(1)).max(100),
  includeInbox: z.boolean(),
}).strict();

const generationTimedSourceSchema = z.object({
  enabled: z.boolean(),
  timeRange: generationTimeRangeSchema,
}).strict();

export const generationContextFiltersV2Schema = z.object({
  schemaVersion: z.literal(2),
  targetCheckpoints: generationTimedSourceSchema,
  projectPrompts: generationTimedSourceSchema.extend({
    projectIds: z.array(z.string().min(1)).max(100),
    includeInbox: z.boolean(),
  }).strict(),
  tagPrompts: generationTimedSourceSchema.extend({
    tagPaths: z.array(z.string().trim().min(1)).max(100),
  }).strict(),
}).strict();

/**
 * Durable generation jobs created before source-specific ranges remain valid.
 * New calls always use v2; the legacy branch exists only so an already-frozen
 * job can still be reconciled or resumed without rewriting its provenance.
 */
export const generationContextFiltersSchema = z.union([
  generationContextFiltersV2Schema,
  legacyGenerationContextFiltersSchema,
]);

export const defaultGenerationContextFilters: GenerationContextFiltersV2 = Object.freeze({
  schemaVersion: 2,
  targetCheckpoints: {
    enabled: true,
    timeRange: "14d",
  },
  projectPrompts: {
    enabled: true,
    timeRange: "14d",
    projectIds: [] as string[],
    includeInbox: false,
  },
  tagPrompts: {
    enabled: true,
    timeRange: "14d",
    tagPaths: [] as string[],
  },
} satisfies GenerationContextFiltersV2);

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

const generationProjectV1Schema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  workspaceId: z.string().min(1),
}).strict();

export const generationProjectSchema = z.object({
  projectId: z.string().min(1),
  projectName: z.string().min(1),
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

const generationJobRecordFields = {
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
};

const generationJobRecordV1Schema = z.object({
  schemaVersion: z.literal(1),
  ...generationJobRecordFields,
  project: generationProjectV1Schema,
}).strict();

const generationJobRecordV2Schema = z.object({
  schemaVersion: z.literal(2),
  ...generationJobRecordFields,
  project: generationProjectSchema,
}).strict();

export const generationJobRecordSchema = z.union([
  generationJobRecordV2Schema,
  generationJobRecordV1Schema,
]).transform((record) => (
  record.schemaVersion === 2
    ? record
    : generationJobRecordV2Schema.parse({
        ...record,
        schemaVersion: 2,
        project: {
          projectId: record.project.projectId,
          projectName: record.project.projectName,
        },
      })
));

export const generationJobSchema = generationJobRecordV2Schema.extend({
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
    contextTimeRangeDays: generationTimeRangeDaysSchema,
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
export type GenerationTimeRangeDays = z.infer<typeof generationTimeRangeDaysSchema>;
export type GenerationProviderConfig = z.infer<typeof generationProviderConfigSchema>;
export type GenerationSettings = z.infer<typeof generationSettingsSchema>;
export type GenerationContextFilters = z.infer<typeof generationContextFiltersSchema>;
export type GenerationContextFiltersV2 = z.infer<typeof generationContextFiltersV2Schema>;
export type GenerationContextCounts = z.infer<typeof generationContextCountsSchema>;
export type GenerationContextSource = z.infer<typeof generationContextSourceSchema>;
export type GenerationProject = z.infer<typeof generationProjectSchema>;
export type GenerationProtection = z.infer<typeof generationProtectionSchema>;
export type GenerationPreview = z.infer<typeof generationPreviewSchema>;
export type GenerationJobStatus = z.infer<typeof generationJobStatusSchema>;
export type GenerationJobRecord = z.infer<typeof generationJobRecordSchema>;
export type GenerationJob = z.infer<typeof generationJobSchema>;
