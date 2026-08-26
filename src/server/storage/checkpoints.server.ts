import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  checkpointContentSchema,
  checkpointSchema,
  type Checkpoint,
  type CheckpointContent,
  type DraftId,
} from "../../shared/contracts.shared";
import {
  assertSafePath,
  collectFiles,
  formatError,
  hash,
} from "./filesystem.server";

export function checkpointDocument(checkpoint: Checkpoint, markdown: string): string {
  return `<!-- prompt-studio-checkpoint ${JSON.stringify(checkpoint)} -->\n\n${markdown}`;
}

export function parseCheckpointDocument(value: string): CheckpointContent {
  const match = /^<!-- prompt-studio-checkpoint (.+) -->\r?\n\r?\n([\s\S]*)$/.exec(value);
  if (!match) throw new Error("Missing checkpoint metadata header or body delimiter");
  const checkpoint = checkpointSchema.parse(JSON.parse(match[1]));
  const parsed = checkpointContentSchema.parse({ ...checkpoint, markdown: match[2] });
  if (hash(parsed.markdown) !== parsed.contentHash) {
    throw new Error(`Checkpoint hash mismatch: ${parsed.id}`);
  }
  return parsed;
}

async function readCheckpointFile(
  filePath: string,
  containerRoot: string,
  draftId: DraftId,
): Promise<CheckpointContent> {
  await assertSafePath(containerRoot, filePath);
  const checkpoint = parseCheckpointDocument(await readFile(filePath, "utf8"));
  if (checkpoint.draftId !== draftId) {
    throw new Error(`Checkpoint lineage mismatch: ${checkpoint.id}`);
  }
  return checkpoint;
}

export async function listCheckpoints(
  draftRoot: string,
  containerRoot: string,
  draftId: DraftId,
): Promise<{ values: Checkpoint[]; warnings: string[] }> {
  const loaded = await listCheckpointContents(draftRoot, containerRoot, draftId);
  return {
    values: loaded.values.map(({ markdown: _markdown, ...checkpoint }) => checkpoint),
    warnings: loaded.warnings,
  };
}

/**
 * Loads every unique checkpoint and its verified Markdown body in one bounded
 * traversal. Generation context construction uses this instead of repeatedly
 * reopening the same checkpoint directory through one-RPC-at-a-time reads.
 */
export async function listCheckpointContents(
  draftRoot: string,
  containerRoot: string,
  draftId: DraftId,
): Promise<{ values: CheckpointContent[]; warnings: string[] }> {
  const loaded: Array<{ checkpoint: CheckpointContent; filePath: string }> = [];
  const warnings: string[] = [];
  const checkpointRoot = path.join(draftRoot, "checkpoints");
  for (const filePath of await collectFiles(checkpointRoot, (name) => name.endsWith(".md"), 1)) {
    try {
      loaded.push({ checkpoint: await readCheckpointFile(filePath, containerRoot, draftId), filePath });
    } catch (error) {
      warnings.push(`${path.relative(containerRoot, filePath)}: ${formatError(error)}`);
    }
  }

  const counts = new Map<string, number>();
  for (const { checkpoint } of loaded) counts.set(checkpoint.id, (counts.get(checkpoint.id) ?? 0) + 1);
  for (const [checkpointId, count] of counts) {
    if (count > 1) warnings.push(`Duplicate canonical checkpoint id ${checkpointId}; all ${count} copies were ignored`);
  }

  const values = loaded
    .filter(({ checkpoint }) => counts.get(checkpoint.id) === 1)
    .map(({ checkpoint }) => checkpoint)
    .sort((left, right) => right.at.localeCompare(left.at));
  return { values, warnings };
}

export async function readCheckpoint(
  draftRoot: string,
  containerRoot: string,
  draftId: DraftId,
  checkpointId: string,
): Promise<CheckpointContent> {
  const checkpointRoot = path.join(draftRoot, "checkpoints");
  const matches: CheckpointContent[] = [];
  for (const filePath of await collectFiles(checkpointRoot, (name) => name.endsWith(".md"), 1)) {
    try {
      const checkpoint = await readCheckpointFile(filePath, containerRoot, draftId);
      if (checkpoint.id === checkpointId) matches.push(checkpoint);
    } catch (error) {
      if (path.basename(filePath).endsWith(`-${checkpointId}.md`)) throw error;
    }
  }
  if (!matches.length) throw new Error(`Unknown Prompt Studio checkpoint: ${checkpointId}`);
  if (matches.length > 1) throw new Error(`Duplicate canonical checkpoint id: ${checkpointId}`);
  return matches[0];
}
