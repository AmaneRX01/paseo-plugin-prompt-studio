import type { output as ZodOutput } from "zod";
import {
  draftAttachmentsSearchRpc,
  type DraftAttachmentItem,
} from "../shared/draft-attachments";
import type { PromptStudioStore } from "./store";

function matchesDraft(query: string, title: string, tags: readonly string[]): boolean {
  if (!query) return true;
  const haystack = `${title}\n${tags.join(" ")}`.toLocaleLowerCase();
  return haystack.includes(query.toLocaleLowerCase());
}

export async function searchDraftAttachments(
  store: PromptStudioStore,
  input: ZodOutput<typeof draftAttachmentsSearchRpc.input>,
): Promise<{ items: DraftAttachmentItem[] }> {
  const catalog = await store.scan("", "ready", null, false, null);
  const items: DraftAttachmentItem[] = [];
  for (const summary of catalog.drafts) {
    if (summary.status !== "ready" || summary.archivedAt !== null) continue;
    if (!matchesDraft(input.query, summary.title, summary.tags)) continue;

    // Re-read through the logical store API so the attachment is a canonical
    // Markdown snapshot at search/attach time, never a client-supplied path.
    const detail = await store.getDraft(summary.id);
    if (detail.summary.status !== "ready" || detail.summary.archivedAt !== null) continue;
    if (!matchesDraft(input.query, detail.summary.title, detail.summary.tags)) continue;
    const tags = detail.summary.tags.length ? `Tags: ${detail.summary.tags.join(", ")} · ` : "";
    items.push({
      id: detail.summary.id,
      identifier: detail.summary.id,
      title: detail.summary.title,
      subtitle: `${tags}Updated ${detail.summary.updatedAt}`,
      url: `prompt-studio://draft/${detail.summary.id}`,
      text: `[Prompt Studio draft: ${detail.summary.title} · revision ${detail.summary.version}]\n\n${detail.markdown}`,
      resourceType: "prompt-studio/draft",
    });
  }
  return { items };
}

export function createDraftAttachmentHandler(store: PromptStudioStore) {
  return (input: ZodOutput<typeof draftAttachmentsSearchRpc.input>) => searchDraftAttachments(store, input);
}
