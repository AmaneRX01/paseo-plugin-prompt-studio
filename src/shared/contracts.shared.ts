import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";
import { activeDraftStatuses, draftStatuses } from "./draft-lifecycle.shared";
import type { TagTreeNode as SharedTagTreeNode } from "./tags.shared";

export const MAX_DRAFT_MARKDOWN_LENGTH = 500_000;

const isoDateSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

export const containerIdSchema = z.union([
  z.literal("ct_inbox"),
  z.string().regex(/^ct_[a-f0-9]{16}$/),
]);
export const draftIdSchema = z.string().regex(/^dr_[a-f0-9]{16}$/);
export const checkpointIdSchema = z.string().regex(/^cp_[a-f0-9]{24}$/);
export const snapshotIdSchema = z.string().regex(/^sn_[a-f0-9]{24}$/);
export const dispatchIdSchema = z.string().regex(/^ds_[a-f0-9]{24}$/);
export const generationIdSchema = z.string().regex(/^gn_[a-f0-9]{24}$/);

export const activeDraftStatusSchema = z.enum(activeDraftStatuses);
export const draftStatusSchema = z.enum(draftStatuses);
export const registrationSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pending"),
    error: z.string().nullable(),
  }),
  z.object({
    status: z.literal("registered"),
    projectId: z.string().min(1),
    workspaceId: z.string().min(1),
    error: z.null(),
  }),
]);

export const draftScopeSchema = z.object({
  projectId: z.string().min(1).nullable(),
  projectName: z.string().min(1).nullable(),
});

// Workspace IDs are transient locators used to resolve a Paseo Project. They are
// deliberately absent from the canonical DraftScope persisted in meta/snapshots.
export const draftScopeTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inbox") }),
  z.object({
    kind: z.literal("project"),
    projectId: z.string().min(1),
    workspaceId: z.string().min(1),
  }),
]);

export const containerSummarySchema = z.object({
  schemaVersion: z.literal(2),
  kind: z.literal("prompt-studio-container"),
  id: containerIdSchema,
  containerType: z.enum(["inbox", "project"]),
  title: z.string(),
  sourceProjectName: z.string().nullable(),
  sourcePathFingerprint: sha256Schema.nullable(),
  registration: registrationSchema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  draftCount: z.number().int().nonnegative(),
});

export const contentOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }),
  z.object({
    kind: z.literal("generated"),
    task: z.enum(["related", "format"]),
    generationId: generationIdSchema,
    at: isoDateSchema,
    agentId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    includedPromptCount: z.number().int().nonnegative(),
    includedVersionCount: z.number().int().nonnegative(),
  }),
]);

export const draftSummarySchema = z.object({
  schemaVersion: z.literal(5),
  id: draftIdSchema,
  containerId: containerIdSchema,
  title: z.string(),
  status: draftStatusSchema,
  tags: z.array(z.string()),
  scope: draftScopeSchema,
  version: z.number().int().positive(),
  contentHash: sha256Schema,
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  archivedAt: isoDateSchema.nullable(),
  archivedFromStatus: activeDraftStatusSchema.nullable(),
  lastCheckpointAt: isoDateSchema.nullable(),
  snapshotCount: z.number().int().nonnegative(),
  dispatchCount: z.number().int().nonnegative(),
  contentOrigin: contentOriginSchema,
  preview: z.string(),
});

export const checkpointSchema = z.object({
  id: checkpointIdSchema,
  draftId: draftIdSchema,
  reason: z.enum([
    "ready",
    "periodic",
    "scope",
    "send",
    "external-edit",
    "restore",
    "before-generation",
    "before-format",
  ]),
  at: isoDateSchema,
  version: z.number().int().positive(),
  contentHash: sha256Schema,
});

export const checkpointContentSchema = checkpointSchema.extend({
  markdown: z.string(),
});

export const snapshotSchema = z.object({
  schemaVersion: z.literal(2),
  id: snapshotIdSchema,
  draftId: draftIdSchema,
  createdAt: isoDateSchema,
  title: z.string(),
  version: z.number().int().positive(),
  contentHash: sha256Schema,
  scope: draftScopeSchema,
  markdown: z.string(),
});

export const existingAgentTargetSchema = z.object({
  kind: z.literal("existing_agent"),
  agentId: z.string().min(1),
});
export const newAgentTargetSchema = z.object({
  kind: z.literal("new_agent"),
  workspaceId: z.string().min(1),
  config: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    modeId: z.string().min(1).nullable(),
    thinkingOptionId: z.string().min(1).nullable(),
    title: z.string().min(1).max(160).nullable(),
  }),
});
export const dispatchTargetSchema = z.discriminatedUnion("kind", [
  existingAgentTargetSchema,
  newAgentTargetSchema,
]);

export const linkedSessionSchema = z.object({
  agentId: z.string().min(1),
  workspaceId: z.string().min(1).nullable(),
  agentTitle: z.string().nullable(),
  provider: z.string().nullable(),
  userMessage: z.string(),
  acceptedAt: isoDateSchema,
});

export const dispatchSchema = z.object({
  schemaVersion: z.literal(2),
  id: dispatchIdSchema,
  draftId: draftIdSchema,
  snapshotId: snapshotIdSchema,
  clientMessageId: z.string().regex(/^prompt-studio:[a-z0-9_:-]+$/),
  target: dispatchTargetSchema,
  status: z.enum(["pending", "accepted", "failed"]),
  attemptCount: z.number().int().positive(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
  agentId: z.string().min(1).nullable(),
  workspaceId: z.string().min(1).nullable(),
  error: z.string().nullable(),
  linkedSession: linkedSessionSchema.nullable(),
});

export const eventSchema = z.object({
  schemaVersion: z.literal(2),
  id: z.string().regex(/^ev_[a-f0-9]{24}$/),
  at: isoDateSchema,
  type: z.enum([
    "container.created",
    "container.registered",
    "draft.created",
    "draft.autosaved",
    "draft.external-edit",
    "draft.scope-moved",
    "draft.archived",
    "draft.status-changed",
    "checkpoint.created",
    "checkpoint.restored",
    "generation.started",
    "generation.applied",
    "generation.conflict",
    "generation.failed",
    "generation.discarded",
    "dispatch.pending",
    "dispatch.accepted",
    "dispatch.failed",
    "dispatch.reconciled",
    // Parsed only for compatibility with worklog notes created by older builds.
    "worklog.appended",
  ]),
  containerId: containerIdSchema,
  draftId: draftIdSchema.nullable(),
  summary: z.string(),
  actor: z.enum(["user", "external", "plugin"]),
  details: z.record(z.string(), z.unknown()).default({}),
});

export const timelineEntrySchema = z.object({
  id: z.string(),
  at: isoDateSchema,
  type: z.enum([
    "draft",
    "update",
    "scope",
    "status",
    "checkpoint",
    "pending",
    "sent",
    "failed",
    "session",
    "generation",
    // Read-only compatibility for historical worklog Markdown.
    "worklog",
  ]),
  containerId: containerIdSchema,
  draftId: draftIdSchema.nullable(),
  title: z.string(),
  summary: z.string(),
  agentId: z.string().nullable(),
  dispatchId: dispatchIdSchema.nullable(),
  snapshotId: snapshotIdSchema.nullable(),
});

export const draftDetailSchema = z.object({
  summary: draftSummarySchema,
  markdown: z.string(),
  checkpoints: z.array(checkpointSchema),
  snapshots: z.array(snapshotSchema.omit({ markdown: true })),
  dispatches: z.array(dispatchSchema),
  events: z.array(eventSchema),
  warnings: z.array(z.string()),
});

export type TagTreeNode = SharedTagTreeNode;

export const tagTreeNodeSchema: z.ZodType<TagTreeNode> = z.lazy(() => z.object({
  name: z.string(),
  path: z.string(),
  count: z.number().int().nonnegative(),
  directCount: z.number().int().nonnegative(),
  children: z.array(tagTreeNodeSchema),
}));

export const catalogScanRpc = defineRpc({
  name: "prompt-studio.catalog-scan",
  input: z.object({
    query: z.string().max(500).default(""),
    statuses: z.array(draftStatusSchema).nullable().default(null),
    projectIds: z.array(z.string().min(1)).nullable().default(null),
    tagPaths: z.array(z.string()).nullable().default(null),
    rebuild: z.boolean().default(false),
  }),
  output: z.object({
    rootPath: z.string(),
    containers: z.array(containerSummarySchema),
    drafts: z.array(draftSummarySchema),
    tagTree: z.array(tagTreeNodeSchema),
    timeline: z.array(timelineEntrySchema),
    warnings: z.array(z.string()),
  }),
});

export const containerEnsureRpc = defineRpc({
  name: "prompt-studio.container-ensure",
  input: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("inbox") }),
    z.object({
      kind: z.literal("project"),
      projectId: z.string().min(1),
      workspaceId: z.string().min(1),
    }),
    z.object({
      kind: z.literal("container"),
      containerId: containerIdSchema,
    }),
  ]),
  output: z.object({
    created: z.boolean(),
    container: containerSummarySchema,
    registrationWarning: z.string().nullable(),
  }),
});

export const draftCreateRpc = defineRpc({
  name: "prompt-studio.draft-create",
  input: z.object({
    target: draftScopeTargetSchema,
    title: z.string().max(160).default("Untitled"),
    markdown: z.string().max(MAX_DRAFT_MARKDOWN_LENGTH).default(""),
  }),
  output: z.object({ draft: draftDetailSchema, registrationWarning: z.string().nullable() }),
});

export const draftGetRpc = defineRpc({
  name: "prompt-studio.draft-get",
  input: z.object({ draftId: draftIdSchema }),
  output: z.object({ draft: draftDetailSchema }),
});

export const draftAutosaveRpc = defineRpc({
  name: "prompt-studio.draft-autosave",
  input: z.object({
    draftId: draftIdSchema,
    title: z.string().max(160),
    markdown: z.string().max(MAX_DRAFT_MARKDOWN_LENGTH),
    expectedVersion: z.number().int().positive(),
    expectedHash: sha256Schema,
  }).strict(),
  output: z.object({
    summary: draftSummarySchema,
    checkpoint: checkpointSchema.nullable(),
    event: eventSchema.nullable(),
    checkpointCreated: z.boolean(),
  }),
});

export const draftTagsSetRpc = defineRpc({
  name: "prompt-studio.draft-tags-set",
  input: z.object({
    draftId: draftIdSchema,
    tags: z.array(z.string()),
    expectedTags: z.array(z.string()),
  }).strict(),
  output: z.object({
    summary: draftSummarySchema,
    changed: z.boolean(),
    tagTree: z.array(tagTreeNodeSchema),
  }),
});

export const tagRenameRpc = defineRpc({
  name: "prompt-studio.tag-rename",
  input: z.object({
    fromPath: z.string(),
    toPath: z.string(),
  }).strict(),
  output: z.object({
    changedDrafts: z.array(draftSummarySchema),
    tagTree: z.array(tagTreeNodeSchema),
  }),
});

export const tagBatchRpc = defineRpc({
  name: "prompt-studio.tag-batch",
  input: z.object({
    draftIds: z.array(draftIdSchema).min(1),
    addTags: z.array(z.string()),
    removeTags: z.array(z.string()),
    removeDescendants: z.boolean().default(false),
  }).strict(),
  output: z.object({
    changedDrafts: z.array(draftSummarySchema),
    tagTree: z.array(tagTreeNodeSchema),
  }),
});

export const draftScopeRpc = defineRpc({
  name: "prompt-studio.draft-scope",
  input: z.object({ draftId: draftIdSchema, target: draftScopeTargetSchema }),
  output: z.object({ draft: draftDetailSchema, registrationWarning: z.string().nullable() }),
});

const draftTransitionInputSchema = z.object({
  draftId: draftIdSchema,
  targetStatus: draftStatusSchema,
  expectedVersion: z.number().int().positive(),
  expectedHash: sha256Schema,
}).strict();

export const draftTransitionRpc = defineRpc({
  name: "prompt-studio.draft-transition",
  input: draftTransitionInputSchema,
  output: z.object({ draft: draftDetailSchema, changed: z.boolean() }),
});

export const draftBatchTransitionRpc = defineRpc({
  name: "prompt-studio.draft-batch-transition",
  input: z.object({
    transitions: z.array(draftTransitionInputSchema).min(1).max(500).superRefine((items, context) => {
      const seen = new Set<string>();
      items.forEach((item, index) => {
        if (seen.has(item.draftId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Duplicate Draft ID",
            path: [index, "draftId"],
          });
        }
        seen.add(item.draftId);
      });
    }),
  }).strict(),
  output: z.object({
    changedDrafts: z.array(draftSummarySchema),
    unchangedDraftIds: z.array(draftIdSchema),
    failures: z.array(z.object({
      draftId: draftIdSchema,
      message: z.string(),
    })),
  }),
});

export const draftDeleteRpc = defineRpc({
  name: "prompt-studio.draft-delete",
  input: z.object({
    draftId: draftIdSchema,
    confirmationDraftId: draftIdSchema,
    expectedVersion: z.number().int().positive(),
    expectedHash: sha256Schema,
  }),
  output: z.object({ deletedDraftId: draftIdSchema }),
});

export const snapshotGetRpc = defineRpc({
  name: "prompt-studio.snapshot-get",
  input: z.object({ draftId: draftIdSchema, snapshotId: snapshotIdSchema }),
  output: z.object({ snapshot: snapshotSchema }),
});

export const checkpointGetRpc = defineRpc({
  name: "prompt-studio.checkpoint-get",
  input: z.object({ draftId: draftIdSchema, checkpointId: checkpointIdSchema }),
  output: z.object({ checkpoint: checkpointContentSchema }),
});

export const checkpointRestoreRpc = defineRpc({
  name: "prompt-studio.checkpoint-restore",
  input: z.object({
    draftId: draftIdSchema,
    checkpointId: checkpointIdSchema,
    expectedVersion: z.number().int().positive(),
    expectedHash: sha256Schema,
  }),
  output: z.object({ draft: draftDetailSchema, restored: z.boolean() }),
});

export const dispatchSendRpc = defineRpc({
  name: "prompt-studio.dispatch-send",
  input: z.object({ draftId: draftIdSchema, target: dispatchTargetSchema }),
  output: z.object({ draft: draftDetailSchema, dispatch: dispatchSchema }),
});

export const dispatchRetryRpc = defineRpc({
  name: "prompt-studio.dispatch-retry",
  input: z.object({ draftId: draftIdSchema, dispatchId: dispatchIdSchema }),
  output: z.object({ draft: draftDetailSchema, dispatch: dispatchSchema }),
});

export const dispatchReconcileRpc = defineRpc({
  name: "prompt-studio.dispatch-reconcile",
  input: z.object({ draftId: draftIdSchema, dispatchId: dispatchIdSchema }),
  output: z.object({ draft: draftDetailSchema, dispatch: dispatchSchema }),
});

export type ContainerId = z.infer<typeof containerIdSchema>;
export type DraftId = z.infer<typeof draftIdSchema>;
export type DraftStatus = z.infer<typeof draftStatusSchema>;
export type DraftScope = z.infer<typeof draftScopeSchema>;
export type DraftScopeTarget = z.infer<typeof draftScopeTargetSchema>;
export type ContainerSummary = z.infer<typeof containerSummarySchema>;
export type DraftSummary = z.infer<typeof draftSummarySchema>;
export type DraftDetail = z.infer<typeof draftDetailSchema>;
export type CatalogScanResult = z.infer<typeof catalogScanRpc.output>;
export type Checkpoint = z.infer<typeof checkpointSchema>;
export type CheckpointContent = z.infer<typeof checkpointContentSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Dispatch = z.infer<typeof dispatchSchema>;
export type DispatchTarget = z.infer<typeof dispatchTargetSchema>;
export type StudioEvent = z.infer<typeof eventSchema>;
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;
