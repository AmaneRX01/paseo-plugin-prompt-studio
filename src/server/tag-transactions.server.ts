import { z } from "zod";
import { draftIdSchema } from "../shared/contracts.shared";
import { tagKey, tagMatchesPath } from "../shared/tags.shared";

const tagMutationEntrySchema = z.object({
  draftId: draftIdSchema,
  beforeTags: z.array(z.string()),
  afterTags: z.array(z.string()),
});

export const tagMutationJournalSchema = z.object({
  schemaVersion: z.literal(1),
  operation: z.literal("tag-mutation"),
  kind: z.enum(["rename", "batch"]),
  id: z.string().regex(/^tm_[a-f0-9]{24}$/),
  fromPath: z.string().nullable(),
  toPath: z.string().nullable(),
  addTags: z.array(z.string()),
  removeTags: z.array(z.string()),
  removeDescendants: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
  nextIndex: z.number().int().nonnegative(),
  entries: z.array(tagMutationEntrySchema),
}).refine((journal) => journal.nextIndex <= journal.entries.length, {
  message: "Tag mutation journal cursor is outside its entry list",
  path: ["nextIndex"],
}).superRefine((journal, context) => {
  if (journal.kind === "rename" && (!journal.fromPath || !journal.toPath)) {
    context.addIssue({
      code: "custom",
      message: "Rename journals require both logical tag paths",
      path: ["fromPath"],
    });
  } else if (journal.kind === "rename" && journal.fromPath && journal.toPath
    && tagKey(journal.fromPath) !== tagKey(journal.toPath)
    && tagMatchesPath(journal.toPath, journal.fromPath)) {
    context.addIssue({
      code: "custom",
      message: "A rename journal cannot move a tag into its own descendant",
      path: ["toPath"],
    });
  }
});

export type TagMutationJournal = z.infer<typeof tagMutationJournalSchema>;
