import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { containerIdSchema, draftIdSchema, draftScopeTargetSchema } from "./contracts";

export const projectLinkStatusSchema = z.enum([
  "available",
  "project_missing",
  "folder_missing",
  "unknown",
]);

export type ProjectLinkStatus = z.infer<typeof projectLinkStatusSchema>;
export type ProjectLinkSummary = z.infer<typeof projectLinkSummarySchema>;
export type ProjectLinkFailure = z.infer<typeof projectLinkFailureSchema>;

export const projectLinkSummarySchema = z.object({
  containerId: containerIdSchema,
  projectId: z.string().min(1),
  name: z.string().min(1),
  title: z.string().min(1),
  rootPath: z.string().min(1).nullable(),
  status: projectLinkStatusSchema,
  draftCount: z.number().int().nonnegative(),
}).strict();

export const projectLinkFailureSchema = z.object({
  draftId: draftIdSchema,
  message: z.string().min(1),
}).strict();

export const projectLinksListRpc = defineRpc({
  name: "prompt-studio.project-links-list",
  input: z.object({}).strict(),
  output: z.object({
    links: z.array(projectLinkSummarySchema),
    verificationError: z.string().nullable(),
  }).strict(),
});

export const projectLinkMigrateRpc = defineRpc({
  name: "prompt-studio.project-migrate",
  input: z.object({
    sourceProjectId: z.string().min(1),
    target: draftScopeTargetSchema,
  }).strict(),
  output: z.object({
    movedDraftIds: z.array(draftIdSchema),
    failures: z.array(projectLinkFailureSchema),
    linkRemoved: z.boolean(),
  }).strict(),
});

export const projectLinkDeleteRpc = defineRpc({
  name: "prompt-studio.project-delete",
  input: z.object({
    projectId: z.string().min(1),
    confirmationProjectId: z.string().min(1),
  }).strict(),
  output: z.object({
    deletedDraftIds: z.array(draftIdSchema),
    failures: z.array(projectLinkFailureSchema),
    linkRemoved: z.boolean(),
  }).strict(),
});
