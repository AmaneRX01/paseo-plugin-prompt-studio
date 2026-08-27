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
} from "../../shared/contracts.shared";

export const MANIFEST_NAME = "companion.json";
export const DRAFT_META_NAME = "meta.json";
export const DRAFT_MARKDOWN_NAME = "draft.md";

const internalIsoDateSchema = z.string().datetime({ offset: true });

export const manifestSchema = z.object({
  schemaVersion: z.literal(2),
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

const legacyLocalProjectSourceSchema = z.object({
  projectId: z.string().min(1),
  workspaceId: z.string().min(1),
  rootPath: z.string().min(1),
  name: z.string().min(1),
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
  schemaVersion: z.literal(2),
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

const projectMapV1Schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("prompt-studio-project-map"),
  pluginProject: z.object({
    rootPath: z.string().min(1),
    registration: localRegistrationSchema,
  }),
  projects: z.array(z.object({
    manifest: manifestSchema,
    source: legacyLocalProjectSourceSchema.nullable(),
    linkError: z.string().nullable(),
  })),
  updatedAt: internalIsoDateSchema,
});

const projectMapV2Schema = z.object({
  schemaVersion: z.literal(2),
  kind: z.literal("prompt-studio-project-map"),
  pluginProject: z.object({
    rootPath: z.string().min(1),
    registration: localRegistrationSchema,
  }),
  projects: z.array(projectLinkSchema),
  updatedAt: internalIsoDateSchema,
});

export const projectMapSchema = z.union([projectMapV2Schema, projectMapV1Schema]).transform((map) => (
  map.schemaVersion === 2
    ? map
    : projectMapV2Schema.parse({
        ...map,
        schemaVersion: 2,
        projects: map.projects.map((project) => ({
          ...project,
          source: project.source
            ? {
                projectId: project.source.projectId,
                rootPath: project.source.rootPath,
                name: project.source.name,
              }
            : null,
        })),
      })
));

const safeRelativePathSchema = z.string().min(1).refine(
  (value) => !value.includes("..") && !value.startsWith("/") && !/^[a-zA-Z]:/.test(value),
  "Expected a safe relative path",
);

export const vaultMigrationJournalSchema = z.object({
  schemaVersion: z.literal(1),
  operation: z.literal("unify-prompt-studio-vault"),
  createdAt: internalIsoDateSchema,
  containers: z.array(z.object({
    manifest: manifestSchema,
    source: localProjectSourceSchema.nullable(),
    linkError: z.string().nullable(),
    legacyRelativePath: safeRelativePathSchema,
  })),
  drafts: z.array(z.object({
    draftId: draftIdSchema,
    sourceContainerId: containerIdSchema,
    legacyRelativePath: safeRelativePathSchema,
  })),
});

const draftMetaV2Schema = z.object({
  schemaVersion: z.literal(2),
  id: draftIdSchema,
  containerId: containerIdSchema,
  title: z.string(),
  status: z.enum(["draft", "ready", "archived"]),
  tags: z.array(z.string()),
  scope: draftScopeSchema,
  version: z.number().int().positive(),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  createdAt: internalIsoDateSchema,
  updatedAt: internalIsoDateSchema,
  archivedAt: internalIsoDateSchema.nullable(),
  lastCheckpointAt: internalIsoDateSchema.nullable(),
});

const legacyDraftStatusSchema = z.enum(["draft", "ready", "starred", "archived"]);
const legacyActiveDraftStatusSchema = z.enum(["draft", "ready", "starred"]);
const pendingTagMutationSchema = z.object({
  id: z.string().regex(/^tm_[a-f0-9]{24}$/),
  index: z.number().int().nonnegative(),
});

const draftMetaV3Schema = z.object({
  schemaVersion: z.literal(3),
  id: draftIdSchema,
  containerId: containerIdSchema,
  title: z.string(),
  status: legacyDraftStatusSchema,
  tags: z.array(z.string()),
  scope: draftScopeSchema,
  version: z.number().int().positive(),
  contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  createdAt: internalIsoDateSchema,
  updatedAt: internalIsoDateSchema,
  archivedAt: internalIsoDateSchema.nullable(),
  archivedFromStatus: legacyActiveDraftStatusSchema.nullable(),
  lastCheckpointAt: internalIsoDateSchema.nullable(),
});

const draftMetaV4Schema = z.object({
  schemaVersion: z.literal(4),
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
  pendingTagMutation: pendingTagMutationSchema.optional(),
});

export const draftMetaV5Schema = z.object({
  schemaVersion: z.literal(5),
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

export const draftMetaSchema = z.union([
  draftMetaV5Schema,
  draftMetaV4Schema,
  draftMetaV3Schema,
  draftMetaV2Schema,
]).transform((meta) => {
  if (meta.schemaVersion === 5) return meta;
  const status = meta.status === "starred" ? "ready" as const : meta.status;
  const archivedFromStatus = meta.schemaVersion === 4
    ? meta.archivedFromStatus
    : meta.schemaVersion === 3
      ? meta.archivedFromStatus === "starred" ? "ready" as const : meta.archivedFromStatus
      : meta.status === "archived" ? "draft" as const : null;
  return draftMetaV5Schema.parse({
    ...meta,
    schemaVersion: 5,
    status,
    archivedFromStatus,
    contentOrigin: { kind: "manual" },
  });
});

export const moveJournalSchema = z.object({
  schemaVersion: z.literal(2),
  operation: z.literal("draft-scope-move"),
  draftId: draftIdSchema,
  sourceContainerId: containerIdSchema,
  targetContainerId: containerIdSchema,
  targetScope: draftScopeSchema,
  createdAt: internalIsoDateSchema,
});

export const deleteJournalSchema = z.object({
  schemaVersion: z.literal(3),
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
  beforeMeta: draftMetaV5Schema,
  beforeMarkdown: z.string().max(MAX_DRAFT_MARKDOWN_LENGTH),
  nextMeta: draftMetaV5Schema,
  responseHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  createdAt: internalIsoDateSchema,
});

export type Manifest = z.infer<typeof manifestSchema>;
export type Placement = z.infer<typeof placementSchema>;
export type LocalProjectSource = z.infer<typeof localProjectSourceSchema>;
export type LocalRegistration = z.infer<typeof localRegistrationSchema>;
export type ProjectLink = z.infer<typeof projectLinkSchema>;
export type ProjectMap = z.infer<typeof projectMapSchema>;
export type VaultMigrationJournal = z.infer<typeof vaultMigrationJournalSchema>;
export type DraftMeta = z.infer<typeof draftMetaSchema>;
export type DeleteJournal = z.infer<typeof deleteJournalSchema>;
export type GenerationApplyJournal = z.infer<typeof generationApplyJournalSchema>;
