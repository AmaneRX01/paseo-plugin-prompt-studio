import { z } from "zod";
import {
  activeDraftStatusSchema,
  checkpointSchema,
  contentOriginSchema,
  containerIdSchema,
  draftIdSchema,
  draftScopeSchema,
  draftStatusSchema,
  generationIdSchema,
  MAX_DRAFT_MARKDOWN_LENGTH,
} from "../../shared/contracts";

export const MANIFEST_NAME = "companion.json";
export const DRAFT_META_NAME = "meta.json";
export const DRAFT_MARKDOWN_NAME = "draft.md";

const internalIsoDateSchema = z.string().datetime({ offset: true });

export const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("prompt-studio-container"),
  id: containerIdSchema,
  containerType: z.enum(["inbox", "project"]),
  title: z.string(),
  sourceProjectName: z.string().nullable(),
  sourcePathFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
  createdAt: internalIsoDateSchema,
  updatedAt: internalIsoDateSchema,
});

const pendingRegistrationSchema = z.object({
  status: z.literal("pending"),
  projectId: z.null(),
  workspaceId: z.null(),
  error: z.string().nullable(),
});

const registeredRegistrationSchema = z.object({
  status: z.literal("registered"),
  projectId: z.string().min(1),
  workspaceId: z.string().min(1),
  error: z.null(),
});

export const localProjectSourceSchema = z.object({
  projectId: z.string().min(1),
  rootPath: z.string().min(1),
  name: z.string().min(1),
});

export const localRegistrationSchema = z.discriminatedUnion("status", [
  pendingRegistrationSchema,
  registeredRegistrationSchema,
]);

export const placementSchema = z.object({
  schemaVersion: z.literal(1),
  containerId: containerIdSchema,
  source: localProjectSourceSchema.nullable(),
  companion: z.object({
    rootPath: z.string().min(1),
    registration: localRegistrationSchema,
  }),
  updatedAt: internalIsoDateSchema,
});

export const projectLinkSchema = z.object({
  manifest: manifestSchema,
  source: localProjectSourceSchema.nullable(),
  linkError: z.string().nullable(),
});

// A Project link's identity is its Paseo projectId; the linked folder path is
// payload that follows the Project wherever it lives.
export const projectMapSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("prompt-studio-project-map"),
  pluginProject: z.object({
    rootPath: z.string().min(1),
    registration: localRegistrationSchema,
  }),
  projects: z.array(projectLinkSchema),
  updatedAt: internalIsoDateSchema,
});

const pendingTagMutationSchema = z.object({
  id: z.string().regex(/^tm_[a-f0-9]{24}$/),
  index: z.number().int().nonnegative(),
});

export const draftMetaSchema = z.object({
  schemaVersion: z.literal(1),
  id: draftIdSchema,
  containerId: containerIdSchema,
  title: z.string(),
  status: draftStatusSchema,
  tags: z.array(z.string()),
  scope: draftScopeSchema,
  version: z.number().int().positive(),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  createdAt: internalIsoDateSchema,
  updatedAt: internalIsoDateSchema,
  archivedAt: internalIsoDateSchema.nullable(),
  archivedFromStatus: activeDraftStatusSchema.nullable(),
  lastCheckpointAt: internalIsoDateSchema.nullable(),
  contentOrigin: contentOriginSchema,
  pendingTagMutation: pendingTagMutationSchema.optional(),
});

export const deleteJournalSchema = z.object({
  schemaVersion: z.literal(1),
  operation: z.literal("draft-delete"),
  draftId: draftIdSchema,
  containerId: containerIdSchema,
  createdAt: internalIsoDateSchema,
});

export const generationApplyJournalSchema = z.object({
  schemaVersion: z.literal(1),
  operation: z.literal("generation-apply"),
  draftId: draftIdSchema,
  generationId: generationIdSchema,
  checkpoint: checkpointSchema,
  beforeMeta: draftMetaSchema,
  beforeMarkdown: z.string().max(MAX_DRAFT_MARKDOWN_LENGTH),
  nextMeta: draftMetaSchema,
  responseHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  createdAt: internalIsoDateSchema,
});

export type Manifest = z.infer<typeof manifestSchema>;
export type Placement = z.infer<typeof placementSchema>;
export type LocalProjectSource = z.infer<typeof localProjectSourceSchema>;
export type LocalRegistration = z.infer<typeof localRegistrationSchema>;
export type ProjectLink = z.infer<typeof projectLinkSchema>;
export type ProjectMap = z.infer<typeof projectMapSchema>;
export type DraftMeta = z.infer<typeof draftMetaSchema>;
export type DeleteJournal = z.infer<typeof deleteJournalSchema>;
export type GenerationApplyJournal = z.infer<typeof generationApplyJournalSchema>;
