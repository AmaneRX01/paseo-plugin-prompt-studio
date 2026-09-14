import { defineAttachmentSource, defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const draftAttachmentItemSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  title: z.string(),
  subtitle: z.string().optional(),
  url: z.string().url(),
  text: z.string(),
  resourceType: z.string().min(1),
}).strict();

export const draftAttachmentsSearchRpc = defineRpc({
  name: "prompt-studio.drafts.search",
  input: z.object({ query: z.string().trim().max(500).default("") }).strict(),
  output: z.object({ items: z.array(draftAttachmentItemSchema) }).strict(),
});

export const draftsSearchRpc = draftAttachmentsSearchRpc;

export const draftAttachmentsSource = defineAttachmentSource({
  id: "prompt-studio-drafts",
  title: "Prompt Studio drafts",
  icon: "BookOpen",
  pickerTitle: "Attach a Prompt Studio draft",
  searchPlaceholder: "Search ready drafts by title or tag",
  search: draftAttachmentsSearchRpc,
});

export type DraftAttachmentItem = z.infer<typeof draftAttachmentItemSchema>;
export type DraftAttachmentSearchResult = z.infer<typeof draftAttachmentsSearchRpc.output>;
