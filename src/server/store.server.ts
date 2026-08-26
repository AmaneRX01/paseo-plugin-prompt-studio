import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  MAX_DRAFT_MARKDOWN_LENGTH,
  checkpointSchema,
  dispatchSchema,
  draftDetailSchema,
  eventSchema,
  snapshotSchema,
  type Checkpoint,
  type CheckpointContent,
  type ContainerId,
  type ContainerSummary,
  type Dispatch,
  type DispatchTarget,
  type DraftStatus,
  type DraftDetail,
  type DraftId,
  type DraftScope,
  type DraftSummary,
  type Snapshot,
  type StudioEvent,
  type TagTreeNode,
  type TimelineEntry,
} from "../shared/contracts.shared";
import {
  canTransitionDraftStatus,
  draftStatuses,
  isActiveDraftStatus,
  isSendableDraftStatus,
} from "../shared/draft-lifecycle.shared";
import {
  addTags,
  buildTagTree,
  foldCaseInsensitive,
  normalizeTags,
  removeTags,
  renameTagPath,
  sameTagSet,
  tagKey,
  tagMatchesPath,
} from "../shared/tags.shared";
import type {
  GenerationContextCounts,
  GenerationJob,
  GenerationJobRecord,
  GenerationTask,
} from "../shared/generation.shared";
import {
  tagMutationJournalSchema,
  type TagMutationJournal,
} from "./tag-transactions.server";
import { buildDraftTimeline } from "./timeline.server";
import {
  checkpointDocument,
  listCheckpoints as listStoredCheckpoints,
  readCheckpoint as readStoredCheckpoint,
} from "./storage/checkpoints.server";
import {
  assertSafePath,
  assertTreeSafe,
  atomicWrite,
  collectFiles,
  compactTimestamp,
  exists,
  formatError,
  hash,
  isWithinPath,
  normalizePath,
  preview,
  readJson,
  shortId,
  writeJson,
} from "./storage/filesystem.server";
import {
  DRAFT_MARKDOWN_NAME,
  DRAFT_META_NAME,
  deleteJournalSchema,
  draftMetaSchema,
  generationApplyJournalSchema,
  type DeleteJournal,
  type DraftMeta,
  type GenerationApplyJournal,
  type Manifest,
  type Placement,
} from "./storage/model.server";
import {
  acquireCrossProcessFileLock,
  GenerationRepository,
} from "./storage/generations.server";
import {
  VaultRepository,
  type ResolvedSourceProject as VaultResolvedSourceProject,
  type VaultContainerRecord,
} from "./storage/vault.server";

const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1_000;
export type ResolvedSourceProject = VaultResolvedSourceProject;

export interface EnsureContainerResult {
  created: boolean;
  manifest: Manifest;
  placement: Placement;
  summary: ContainerSummary;
}

export interface AutosaveDraftInput {
  draftId: DraftId;
  title: string;
  markdown: string;
  expectedVersion: number;
  expectedHash: string;
}

export interface SetDraftTagsInput {
  draftId: DraftId;
  tags: string[];
  expectedTags: string[];
}

export interface BatchDraftTagsInput {
  draftIds: DraftId[];
  addTags: string[];
  removeTags: string[];
  removeDescendants: boolean;
}

export interface TransitionDraftInput {
  draftId: DraftId;
  targetStatus: DraftStatus;
  expectedVersion: number;
  expectedHash: string;
}

export interface DeleteDraftInput {
  draftId: DraftId;
  confirmationDraftId: DraftId;
  expectedVersion: number;
  expectedHash: string;
}

export interface ApplyGenerationRevisionInput {
  draftId: DraftId;
  generationId: string;
  task: GenerationTask;
  markdown: string;
  expectedVersion: number;
  expectedHash: string;
  agentId: string;
  provider: string;
  model: string;
  counts: GenerationContextCounts;
}

export interface PrepareGenerationJobInput {
  record: GenerationJobRecord;
  requestMarkdown: string;
  expectedProjectId: string;
}

export type ApplyGenerationRevisionResult =
  | { status: "applied"; draft: DraftDetail; checkpointId: string }
  | { status: "conflict"; draft: DraftDetail };

export interface RestoreCheckpointInput {
  draftId: DraftId;
  checkpointId: string;
  expectedVersion: number;
  expectedHash: string;
}

export interface CatalogResult {
  rootPath: string;
  containers: ContainerSummary[];
  drafts: DraftSummary[];
  tagTree: TagTreeNode[];
  timeline: TimelineEntry[];
  warnings: string[];
}

export interface PromptStudioStoreOptions {
  now?: () => Date;
  entropy?: () => string;
}

export function defaultPromptStudioRoot(): string {
  const override = process.env.PASEO_PROMPT_STUDIO_HOME;
  return path.resolve(override?.trim() || path.join(homedir(), ".paseo", "prompt-studio"));
}

function searchTokens(query: string): string[] {
  return [...new Set(foldCaseInsensitive(query.trim()).split(/\s+/).filter(Boolean))];
}

function searchPreview(markdown: string, tokens: string[]): string {
  if (!tokens.length) return preview(markdown);
  const lines = markdown.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const matched = lines.find((line) => {
    const normalized = foldCaseInsensitive(line);
    return tokens.some((token) => normalized.includes(token));
  });
  return preview(matched ?? markdown);
}

function sameTagDisplay(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(normalizeTags(left)) === JSON.stringify(normalizeTags(right));
}

function tagsForSet(current: readonly string[], requested: readonly string[]): string[] {
  const currentDisplay = new Map(normalizeTags(current).map((tag) => [tagKey(tag), tag] as const));
  return normalizeTags(requested).map((tag) => currentDisplay.get(tagKey(tag)) ?? tag);
}

function replayJournaledTagRename(
  current: readonly string[],
  entry: TagMutationJournal["entries"][number],
  fromPath: string,
  toPath: string,
): string[] {
  const currentTags = normalizeTags(current);
  if (sameTagDisplay(currentTags, entry.beforeTags)) return renameTagPath(currentTags, fromPath, toPath);
  if (sameTagDisplay(currentTags, entry.afterTags)) return currentTags;
  if (tagKey(fromPath) === tagKey(toPath)) return renameTagPath(currentTags, fromPath, toPath);
  const affectedBefore = normalizeTags(entry.beforeTags).filter((tag) => tagMatchesPath(tag, fromPath));
  const affectedBeforeKeys = new Set(affectedBefore.map(tagKey));
  const mapped = renameTagPath(affectedBefore, fromPath, toPath);
  const mappedKeys = new Set(mapped.map(tagKey));
  const currentKeys = new Set(currentTags.map(tagKey));
  const uniqueBefore = [...affectedBeforeKeys].filter((key) => !mappedKeys.has(key));
  const uniqueMapped = [...mappedKeys].filter((key) => !affectedBeforeKeys.has(key));
  if (uniqueBefore.some((key) => currentKeys.has(key))) {
    return renameTagPath(currentTags, fromPath, toPath);
  }
  if (uniqueMapped.some((key) => currentKeys.has(key))) {
    return normalizeTags(currentTags.flatMap((tag) => {
      if (mappedKeys.has(tagKey(tag)) || !tagMatchesPath(tag, fromPath)) return [tag];
      return renameTagPath([tag], fromPath, toPath);
    }));
  }
  // Every phase marker was externally removed. Preserve the current set rather
  // than guessing and resurrecting a deleted Tag from journal history.
  return currentTags;
}

function replayJournaledTagBatch(
  current: readonly string[],
  entry: TagMutationJournal["entries"][number],
  add: readonly string[],
  remove: readonly string[],
  removeDescendants: boolean,
): string[] {
  const currentTags = normalizeTags(current);
  if (sameTagDisplay(currentTags, entry.beforeTags)) {
    return addTags(removeTags(currentTags, remove, { includeDescendants: removeDescendants }), add);
  }
  if (sameTagDisplay(currentTags, entry.afterTags)) return currentTags;
  const beforeKeys = new Set(normalizeTags(entry.beforeTags).map(tagKey));
  const afterKeys = new Set(normalizeTags(entry.afterTags).map(tagKey));
  const currentKeys = new Set(currentTags.map(tagKey));
  const hasBeforeMarker = [...beforeKeys].some((key) => !afterKeys.has(key) && currentKeys.has(key));
  const hasAfterMarker = [...afterKeys].some((key) => !beforeKeys.has(key) && currentKeys.has(key));
  if (hasBeforeMarker && !hasAfterMarker) {
    return addTags(removeTags(currentTags, remove, { includeDescendants: removeDescendants }), add);
  }
  // The write phase is complete or ambiguous. Preserve current Tags rather
  // than reapplying a journal over a later external edit.
  return currentTags;
}

function withoutPendingTagMutation(meta: DraftMeta): DraftMeta {
  const clean = { ...meta };
  delete clean.pendingTagMutation;
  return clean;
}

function generationRevisionMetadata(meta: DraftMeta): Omit<DraftMeta, "tags" | "pendingTagMutation"> {
  const { tags: _tags, pendingTagMutation: _pendingTagMutation, ...revision } = meta;
  return revision;
}

function generationNextMetaWithCurrentTags(next: DraftMeta, current: DraftMeta): DraftMeta {
  const merged: DraftMeta = { ...next, tags: current.tags };
  if (current.pendingTagMutation) merged.pendingTagMutation = current.pendingTagMutation;
  else delete merged.pendingTagMutation;
  return merged;
}

function sameScope(left: DraftScope, right: DraftScope): boolean {
  return left.projectId === right.projectId;
}

function scopeLocation(scope: DraftScope): string {
  if (!scope.projectId) return "Inbox";
  return scope.projectName ?? scope.projectId;
}

function sortDraftSummaries(drafts: DraftSummary[]): void {
  drafts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export class PromptStudioStore {
  readonly rootPath: string;
  readonly draftsPath: string;
  readonly eventsPath: string;
  readonly transactionsPath: string;
  private readonly vault: VaultRepository;
  private readonly generations: GenerationRepository;
  private readonly locks = new Map<string, Promise<void>>();
  private initialization: Promise<void> | null = null;
  private catalogCache: CatalogResult | null = null;
  private readonly now: () => Date;
  private readonly entropy: () => string;

  constructor(rootPath = defaultPromptStudioRoot(), options: PromptStudioStoreOptions = {}) {
    this.rootPath = path.resolve(rootPath);
    this.draftsPath = path.join(this.rootPath, "drafts");
    this.eventsPath = path.join(this.rootPath, "events");
    this.transactionsPath = path.join(this.rootPath, ".transactions");
    this.now = options.now ?? (() => new Date());
    this.entropy = options.entropy ?? randomUUID;
    this.vault = new VaultRepository(this.rootPath, this.now);
    this.generations = new GenerationRepository(this.rootPath, { now: this.now });
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private id(prefix: string, bytes = 12): string {
    return shortId(prefix, bytes, this.entropy());
  }

  private async initialize(): Promise<void> {
    this.initialization ??= this.initializeOnce().catch((error) => {
      this.initialization = null;
      throw error;
    });
    return this.initialization;
  }

  private async initializeOnce(): Promise<void> {
    if (await exists(this.rootPath)) {
      const info = await lstat(this.rootPath);
      if (info.isSymbolicLink()) throw new Error(`Symbolic-link or junction vault roots are not supported: ${this.rootPath}`);
    }
    await mkdir(this.rootPath, { recursive: true });
    await assertSafePath(this.rootPath, this.transactionsPath);
    await mkdir(this.transactionsPath, { recursive: true });
    await assertSafePath(this.rootPath, this.transactionsPath);
    const releaseRecovery = await this.acquireFileLock("vault-recovery");
    try {
      await this.vault.initialize();
      await this.recoverGenerationApplyJournals();
      const releaseTags = await this.acquireFileLock("tags-global");
      try {
        await this.recoverDeleteJournals();
        await this.recoverTagMutationJournals();
      } finally {
        await releaseTags();
      }
    } finally {
      await releaseRecovery();
    }
  }

  private async ensureNoUnresolvedGeneration(draftId: DraftId, action: string): Promise<void> {
    const unresolved = await this.generations.findUnresolved(draftId);
    if (unresolved) {
      throw new Error(`Cannot ${action} while generation ${unresolved.id} is ${unresolved.status}; apply, discard, or abandon it first`);
    }
  }

  private tagMutationJournalPath(id: string): string {
    return path.join(this.transactionsPath, `tag-mutation-${id}.json`);
  }

  private async applyTagMutationJournal(
    initial: TagMutationJournal,
    journalPath: string,
  ): Promise<void> {
    let journal = initial;
    for (let index = journal.nextIndex; index < journal.entries.length; index += 1) {
      const entry = journal.entries[index];
      const releaseDraft = await this.acquireFileLock(entry.draftId);
      try {
        const draftRoot = this.draftRoot(this.rootPath, entry.draftId);
        const metaPath = path.join(draftRoot, DRAFT_META_NAME);
        if (await exists(metaPath)) {
          await assertSafePath(this.rootPath, draftRoot);
          const meta = await this.readDraftMeta(draftRoot, this.rootPath);
          const currentTags = normalizeTags(meta.tags);
          const marker = meta.pendingTagMutation;
          const alreadyApplied = marker?.id === journal.id && marker.index === index;
          if (marker && !alreadyApplied) {
            throw new Error(`Draft ${entry.draftId} belongs to another pending Tag mutation: ${marker.id}`);
          }
          const nextTags = alreadyApplied
            ? currentTags
            : journal.kind === "rename"
              ? replayJournaledTagRename(
                  currentTags,
                  entry,
                  journal.fromPath ?? "",
                  journal.toPath ?? "",
                )
              : replayJournaledTagBatch(
                  currentTags,
                  entry,
                  journal.addTags,
                  journal.removeTags,
                  journal.removeDescendants,
                );
          if (!alreadyApplied || JSON.stringify(meta.tags) !== JSON.stringify(nextTags)) {
            await writeJson(metaPath, {
              ...meta,
              tags: nextTags,
              pendingTagMutation: { id: journal.id, index },
            }, this.rootPath);
          }
        }
        journal = { ...journal, nextIndex: index + 1 };
        await writeJson(journalPath, journal, this.rootPath);
      } finally {
        await releaseDraft();
      }
    }
    for (const entry of journal.entries) {
      const releaseDraft = await this.acquireFileLock(entry.draftId);
      try {
        const draftRoot = this.draftRoot(this.rootPath, entry.draftId);
        const metaPath = path.join(draftRoot, DRAFT_META_NAME);
        if (!(await exists(metaPath))) continue;
        await assertSafePath(this.rootPath, draftRoot);
        const meta = await this.readDraftMeta(draftRoot, this.rootPath);
        if (meta.pendingTagMutation?.id === journal.id) {
          await writeJson(metaPath, withoutPendingTagMutation(meta), this.rootPath);
        }
      } finally {
        await releaseDraft();
      }
    }
    await assertSafePath(this.rootPath, journalPath);
    await rm(journalPath, { force: true });
  }

  private async recoverTagMutationJournals(): Promise<boolean> {
    let recovered = false;
    for (const entry of await readdir(this.transactionsPath, { withFileTypes: true })) {
      const match = /^tag-mutation-(tm_[a-f0-9]{24})\.json$/.exec(entry.name);
      if (!match || !entry.isFile() || entry.isSymbolicLink()) continue;
      const journalPath = path.join(this.transactionsPath, entry.name);
      await assertSafePath(this.rootPath, journalPath);
      const journal = tagMutationJournalSchema.parse(await readJson(journalPath));
      if (journal.id !== match[1]) throw new Error(`Tag mutation journal id/path mismatch: ${entry.name}`);
      this.catalogCache = null;
      await this.applyTagMutationJournal(journal, journalPath);
      recovered = true;
    }
    if (recovered) this.catalogCache = null;
    return recovered;
  }

  private async commitTagMutation(
    kind: TagMutationJournal["kind"],
    entries: TagMutationJournal["entries"],
    options: {
      fromPath?: string;
      toPath?: string;
      addTags?: readonly string[];
      removeTags?: readonly string[];
      removeDescendants?: boolean;
    } = {},
  ): Promise<void> {
    if (!entries.length) return;
    const id = this.id("tm", 12);
    const journalPath = this.tagMutationJournalPath(id);
    const journal = tagMutationJournalSchema.parse({
      schemaVersion: 1,
      operation: "tag-mutation",
      kind,
      id,
      fromPath: options.fromPath ?? null,
      toPath: options.toPath ?? null,
      addTags: normalizeTags(options.addTags ?? []),
      removeTags: normalizeTags(options.removeTags ?? []),
      removeDescendants: options.removeDescendants ?? false,
      createdAt: this.timestamp(),
      nextIndex: 0,
      entries,
    });
    await writeJson(journalPath, journal, this.rootPath);
    // A failed multi-Draft write must never leave an in-memory view claiming
    // the pre-transaction tag set is still canonical.
    this.catalogCache = null;
    try {
      await this.applyTagMutationJournal(journal, journalPath);
    } catch (error) {
      try {
        await this.recoverTagMutationJournals();
      } catch (recoveryError) {
        throw new Error(
          `Tag mutation failed and immediate recovery did not complete: ${formatError(error)}; recovery: ${formatError(recoveryError)}`,
        );
      }
    }
  }

  private async acquireFileLock(key: string): Promise<() => Promise<void>> {
    return acquireCrossProcessFileLock(
      this.rootPath,
      key,
      `Prompt Studio resource is busy in another plugin process: ${key}`,
    );
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    const prior = this.locks.get(key) ?? Promise.resolve();
    let releaseQueue!: () => void;
    const queued = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const chain = prior.then(() => queued);
    this.locks.set(key, chain);
    await prior;
    let releaseFile: (() => Promise<void>) | null = null;
    try {
      releaseFile = await this.acquireFileLock(key);
      return await operation();
    } finally {
      if (releaseFile) await releaseFile();
      releaseQueue();
      if (this.locks.get(key) === chain) this.locks.delete(key);
    }
  }

  private async readPlacement(containerId: ContainerId): Promise<Placement> {
    return this.vault.placementFor(containerId);
  }

  private async findContainer(containerId: ContainerId): Promise<{ root: string; manifest: Manifest }> {
    const container = await this.vault.findContainer(containerId);
    return { root: this.rootPath, manifest: container.manifest };
  }

  private async containerDraftCount(containerId: ContainerId): Promise<number> {
    let count = 0;
    for (const entry of await readdir(this.draftsPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^dr_[a-f0-9]{16}$/.test(entry.name)) continue;
      try {
        const metaPath = path.join(this.draftsPath, entry.name, DRAFT_META_NAME);
        await assertSafePath(this.rootPath, metaPath);
        const meta = draftMetaSchema.parse(await readJson(metaPath));
        if (meta.containerId === containerId) count += 1;
      } catch {
        // Canonical scans report malformed Draft metadata without hiding healthy records.
      }
    }
    return count;
  }

  private async containerSummary(record: VaultContainerRecord): Promise<ContainerSummary> {
    let registration: ContainerSummary["registration"];
    try {
      const placement = await this.readPlacement(record.manifest.id);
      registration = placement.companion.registration.status === "registered"
        ? {
            status: "registered" as const,
            projectId: placement.companion.registration.projectId,
            workspaceId: placement.companion.registration.workspaceId,
            error: null,
          }
        : { status: "pending" as const, error: placement.companion.registration.error };
    } catch (error) {
      registration = { status: "pending", error: `Project map is unavailable: ${formatError(error)}` };
    }
    return {
      schemaVersion: 2,
      kind: "prompt-studio-container",
      id: record.manifest.id,
      containerType: record.manifest.containerType,
      title: record.manifest.title,
      sourceProjectName: record.manifest.sourceProjectName,
      sourcePathFingerprint: record.manifest.sourcePathFingerprint,
      registration,
      createdAt: record.manifest.createdAt,
      updatedAt: record.manifest.updatedAt,
      draftCount: await this.containerDraftCount(record.manifest.id),
    };
  }

  async ensureContainer(source: ResolvedSourceProject | null): Promise<EnsureContainerResult> {
    return this.withLock("project-map", async () => {
      const ensured = await this.vault.ensureContainer(source);
      const record = await this.vault.findContainer(ensured.manifest.id);
      if (ensured.created) {
        await this.writeContainerEvent(this.rootPath, {
          type: "container.created",
          containerId: ensured.manifest.id,
          draftId: null,
          summary: `Linked ${ensured.manifest.title} to the Prompt Studio vault`,
          actor: "plugin",
        });
      }
      return {
        ...ensured,
        summary: await this.containerSummary(record),
      };
    });
  }

  async findContainerForProject(projectId: string): Promise<ContainerSummary | null> {
    await this.initialize();
    const record = await this.vault.findContainerForProject(projectId);
    return record ? this.containerSummary(record) : null;
  }

  async findContainerByRoot(rootPath: string): Promise<ContainerSummary | null> {
    await this.initialize();
    const record = await this.vault.findContainerByRoot(rootPath);
    return record ? this.containerSummary(record) : null;
  }

  async isManagedPath(candidatePath: string): Promise<boolean> {
    const boundary = normalizePath(this.rootPath);
    const candidate = normalizePath(candidatePath);
    if (isWithinPath(boundary, candidate) || isWithinPath(candidate, boundary)) return true;
    try {
      const canonicalBoundary = normalizePath(await realpath(this.rootPath));
      const canonicalCandidate = normalizePath(await realpath(candidatePath));
      return isWithinPath(canonicalBoundary, canonicalCandidate)
        || isWithinPath(canonicalCandidate, canonicalBoundary);
    } catch {
      return false;
    }
  }

  async recordRegistration(
    containerId: ContainerId,
    registration:
      | { status: "registered"; projectId: string; workspaceId: string }
      | { status: "pending"; error: string },
  ): Promise<ContainerSummary> {
    return this.withLock("project-map", async () => {
      const record = await this.vault.findContainer(containerId);
      await this.vault.recordRegistration(registration);
      if (registration.status === "registered") {
        await this.writeContainerEvent(this.rootPath, {
          type: "container.registered",
          containerId,
          draftId: null,
          summary: "Registered the single Prompt Studio vault as a Paseo Project/Workspace",
          actor: "plugin",
        });
      }
      const summary = await this.containerSummary(record);
      if (this.catalogCache) await this.refreshCatalog();
      return summary;
    });
  }

  async getContainerRoot(containerId: ContainerId): Promise<string> {
    await this.initialize();
    await this.vault.findContainer(containerId);
    return this.rootPath;
  }

  async getContainerSource(containerId: ContainerId): Promise<ResolvedSourceProject | null> {
    await this.initialize();
    return this.vault.getContainerSource(containerId);
  }

  async getLinkedProjects(): Promise<ResolvedSourceProject[]> {
    await this.initialize();
    return (await this.vault.listContainers()).flatMap((container) => (
      container.source ? [{ ...container.source }] : []
    ));
  }

  private async writeContainerEvent(
    containerRoot: string,
    input: Omit<StudioEvent, "schemaVersion" | "id" | "at" | "details"> & { details?: Record<string, unknown> },
  ): Promise<StudioEvent> {
    const at = this.timestamp();
    const event: StudioEvent = eventSchema.parse({
      schemaVersion: 2,
      id: this.id("ev"),
      at,
      ...input,
      details: input.details ?? {},
    });
    const date = at.slice(0, 10);
    const eventPath = path.join(
      containerRoot,
      "events",
      date.slice(0, 4),
      date.slice(5, 7),
      `${compactTimestamp(at)}-${event.id}.json`,
    );
    await writeJson(eventPath, event, containerRoot);
    return event;
  }

  private async writeDraftEvent(
    containerRoot: string,
    draftId: DraftId,
    input: Omit<StudioEvent, "schemaVersion" | "id" | "at" | "containerId" | "draftId" | "details"> & {
      containerId: ContainerId;
      details?: Record<string, unknown>;
    },
  ): Promise<StudioEvent> {
    const event = await this.writeContainerEvent(containerRoot, { ...input, draftId });
    const draftRoot = path.join(containerRoot, "drafts", draftId);
    const date = event.at.slice(0, 10);
    await writeJson(
      path.join(draftRoot, "events", date.slice(0, 4), date.slice(5, 7), `${compactTimestamp(event.at)}-${event.id}.json`),
      event,
      containerRoot,
    );
    return event;
  }

  private async readEvents(root: string): Promise<{ events: StudioEvent[]; warnings: string[] }> {
    const events: StudioEvent[] = [];
    const warnings: string[] = [];
    for (const filePath of await collectFiles(path.join(root, "events"), (name) => name.endsWith(".json"), 4)) {
      try {
        await assertSafePath(root, filePath);
        events.push(eventSchema.parse(await readJson(filePath)));
      } catch (error) {
        warnings.push(`${path.relative(root, filePath)}: ${formatError(error)}`);
      }
    }
    events.sort((left, right) => right.at.localeCompare(left.at));
    return { events, warnings };
  }

  private async writeGenerationEventOnceUnlocked(
    containerRoot: string,
    draftRoot: string,
    draftId: DraftId,
    input: {
      type: "generation.started" | "generation.applied" | "generation.conflict" | "generation.failed" | "generation.discarded";
      containerId: ContainerId;
      summary: string;
      generationId: string;
      details?: Record<string, unknown>;
    },
  ): Promise<StudioEvent> {
    const existing = (await this.readEvents(draftRoot)).events.find(
      (event) => event.type === input.type && event.details.generationId === input.generationId,
    );
    if (existing) return existing;
    return this.writeDraftEvent(containerRoot, draftId, {
      type: input.type,
      containerId: input.containerId,
      summary: input.summary,
      actor: "plugin",
      details: { generationId: input.generationId, ...(input.details ?? {}) },
    });
  }

  async recordGenerationEvent(input: {
    draftId: DraftId;
    generationId: string;
    type: "generation.started" | "generation.conflict" | "generation.failed" | "generation.discarded";
    summary: string;
    details?: Record<string, unknown>;
  }): Promise<StudioEvent> {
    return this.withLock(input.draftId, async () => {
      const { containerRoot, draftRoot } = await this.locateDraft(input.draftId);
      const meta = await this.readDraftMeta(draftRoot, containerRoot);
      const event = await this.writeGenerationEventOnceUnlocked(containerRoot, draftRoot, input.draftId, {
        ...input,
        containerId: meta.containerId,
      });
      await this.updateCachedDraft(await this.loadDraftUnlocked(input.draftId, false), false);
      return event;
    });
  }

  async prepareGenerationJob(input: PrepareGenerationJobInput): Promise<GenerationJob> {
    return this.withLock(input.record.draftId, async () => {
      const { containerRoot, draftRoot } = await this.locateDraft(input.record.draftId);
      let meta = await this.readDraftMeta(draftRoot, containerRoot);
      const reconciled = await this.reconcileExternalEditUnlocked(containerRoot, draftRoot, meta);
      meta = reconciled.meta;
      if (meta.version !== input.record.baseVersion || meta.contentHash !== input.record.baseHash) {
        throw new Error(
          `Draft changed while generation context was being prepared (current version ${meta.version})`,
        );
      }
      if (meta.status === "archived") {
        throw new Error("Restore the archived draft before running generation");
      }
      if (meta.scope.projectId !== input.expectedProjectId) {
        throw new Error("Draft Project changed while generation context was being prepared");
      }
      const job = await this.generations.create(input.record, input.requestMarkdown);
      await this.writeGenerationEventOnceUnlocked(containerRoot, draftRoot, input.record.draftId, {
        type: "generation.started",
        containerId: meta.containerId,
        summary: `${job.task === "format" ? "Started formatting" : "Started optimizing"} ${meta.title} with an Agent`,
        generationId: job.id,
        details: {
          task: job.task,
          provider: job.configuration.provider,
          model: job.configuration.model,
          counts: job.counts,
          allowProjectRead: job.allowProjectRead,
        },
      });
      await this.updateCachedDraft(await this.loadDraftUnlocked(input.record.draftId, false), false);
      return job;
    });
  }

  private draftRoot(containerRoot: string, draftId: DraftId): string {
    return path.join(containerRoot, "drafts", draftId);
  }

  private async locateDraft(draftId: DraftId): Promise<{ containerRoot: string; draftRoot: string }> {
    const draftRoot = this.draftRoot(this.rootPath, draftId);
    if (!(await exists(path.join(draftRoot, DRAFT_META_NAME)))) {
      throw new Error(`Unknown Prompt Studio draft: ${draftId}`);
    }
    await assertSafePath(this.rootPath, draftRoot);
    return { containerRoot: this.rootPath, draftRoot };
  }

  private async readDraftMeta(draftRoot: string, containerRoot: string): Promise<DraftMeta> {
    await assertSafePath(containerRoot, draftRoot);
    const metaPath = path.join(draftRoot, DRAFT_META_NAME);
    await assertSafePath(containerRoot, metaPath);
    const meta = draftMetaSchema.parse(await readJson(metaPath));
    if (path.basename(draftRoot) !== meta.id) throw new Error(`Draft directory/id mismatch: ${draftRoot}`);
    return meta;
  }

  private async listSnapshots(draftRoot: string, containerRoot: string): Promise<{ values: Snapshot[]; warnings: string[] }> {
    const values: Snapshot[] = [];
    const warnings: string[] = [];
    const snapshotsRoot = path.join(draftRoot, "snapshots");
    if (!(await exists(snapshotsRoot))) return { values, warnings };
    for (const entry of await readdir(snapshotsRoot, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^sn_[a-f0-9]{24}\.json$/.test(entry.name)) continue;
      const filePath = path.join(snapshotsRoot, entry.name);
      try {
        await assertSafePath(containerRoot, filePath);
        const metadata = snapshotSchema.omit({ markdown: true }).parse(await readJson(filePath));
        const markdownPath = path.join(snapshotsRoot, `${metadata.id}.md`);
        await assertSafePath(containerRoot, markdownPath);
        const markdown = await readFile(markdownPath, "utf8");
        const snapshot = snapshotSchema.parse({ ...metadata, markdown });
        if (hash(markdown) !== snapshot.contentHash) throw new Error(`Immutable snapshot hash mismatch: ${snapshot.id}`);
        values.push(snapshot);
      } catch (error) {
        warnings.push(`${path.relative(containerRoot, filePath)}: ${formatError(error)}`);
      }
    }
    values.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return { values, warnings };
  }

  private async listDispatches(draftRoot: string, containerRoot: string): Promise<{ values: Dispatch[]; warnings: string[] }> {
    const values: Dispatch[] = [];
    const warnings: string[] = [];
    const dispatchesRoot = path.join(draftRoot, "dispatches");
    if (!(await exists(dispatchesRoot))) return { values, warnings };
    for (const entry of await readdir(dispatchesRoot, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^ds_[a-f0-9]{24}\.json$/.test(entry.name)) continue;
      const filePath = path.join(dispatchesRoot, entry.name);
      try {
        await assertSafePath(containerRoot, filePath);
        values.push(dispatchSchema.parse(await readJson(filePath)));
      } catch (error) {
        warnings.push(`${path.relative(containerRoot, filePath)}: ${formatError(error)}`);
      }
    }
    values.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return { values, warnings };
  }

  private async createCheckpointUnlocked(
    containerRoot: string,
    draftRoot: string,
    meta: DraftMeta,
    markdown: string,
    reason: Checkpoint["reason"],
  ): Promise<{ meta: DraftMeta; checkpoint: Checkpoint }> {
    const at = this.timestamp();
    const checkpoint: Checkpoint = checkpointSchema.parse({
      id: this.id("cp"),
      draftId: meta.id,
      reason,
      at,
      version: meta.version,
      contentHash: hash(markdown),
    });
    await atomicWrite(
      path.join(draftRoot, "checkpoints", `${compactTimestamp(at)}-${checkpoint.id}.md`),
      checkpointDocument(checkpoint, markdown),
      containerRoot,
    );
    const nextMeta: DraftMeta = { ...meta, lastCheckpointAt: at };
    await writeJson(path.join(draftRoot, DRAFT_META_NAME), nextMeta, containerRoot);
    await this.writeDraftEvent(containerRoot, meta.id, {
      type: "checkpoint.created",
      containerId: meta.containerId,
      summary: `Created ${reason} checkpoint`,
      actor: "plugin",
      details: { checkpointId: checkpoint.id, version: checkpoint.version, contentHash: checkpoint.contentHash },
    });
    return { meta: nextMeta, checkpoint };
  }

  private async reconcileExternalEditUnlocked(
    containerRoot: string,
    draftRoot: string,
    meta: DraftMeta,
  ): Promise<{ meta: DraftMeta; markdown: string; changed: boolean }> {
    const markdownPath = path.join(draftRoot, DRAFT_MARKDOWN_NAME);
    await assertSafePath(containerRoot, markdownPath);
    const markdown = await readFile(markdownPath, "utf8");
    const observedHash = hash(markdown);
    if (observedHash === meta.contentHash) return { meta, markdown, changed: false };
    const nextVersion = meta.version + 1;
    const now = this.timestamp();
    const revertsReady = meta.status === "ready";
    let nextMeta: DraftMeta = {
      ...meta,
      status: revertsReady ? "draft" : meta.status,
      version: nextVersion,
      contentHash: observedHash,
      updatedAt: now,
      contentOrigin: { kind: "manual" },
    };
    const checkpoint = await this.createCheckpointUnlocked(containerRoot, draftRoot, nextMeta, markdown, "external-edit");
    nextMeta = checkpoint.meta;
    await this.writeDraftEvent(containerRoot, meta.id, {
      type: "draft.external-edit",
      containerId: meta.containerId,
      summary: "Reconciled plaintext changes made outside Prompt Studio",
      actor: "external",
      details: {
        fromHash: meta.contentHash,
        toHash: observedHash,
        version: nextVersion,
        ...(revertsReady ? { fromStatus: "ready", toStatus: "draft" } : {}),
      },
    });
    if (revertsReady) {
      await this.writeDraftEvent(containerRoot, meta.id, {
        type: "draft.status-changed",
        containerId: meta.containerId,
        summary: `Changed ${meta.title} from ready to draft after external edit`,
        actor: "external",
        details: { fromStatus: "ready", toStatus: "draft", reason: "content-edited" },
      });
    }
    return { meta: nextMeta, markdown, changed: true };
  }

  private async loadDraftUnlocked(draftId: DraftId, reconcile = true): Promise<DraftDetail> {
    const { containerRoot, draftRoot } = await this.locateDraft(draftId);
    let meta = await this.readDraftMeta(draftRoot, containerRoot);
    const markdownPath = path.join(draftRoot, DRAFT_MARKDOWN_NAME);
    await assertSafePath(containerRoot, markdownPath);
    const markdownOnDisk = await readFile(markdownPath, "utf8");
    let markdown = markdownOnDisk;
    if (reconcile) {
      const reconciled = await this.reconcileExternalEditUnlocked(containerRoot, draftRoot, meta);
      meta = reconciled.meta;
      markdown = reconciled.markdown;
    }
    const checkpoints = await listStoredCheckpoints(draftRoot, containerRoot, meta.id);
    const snapshots = await this.listSnapshots(draftRoot, containerRoot);
    const dispatches = await this.listDispatches(draftRoot, containerRoot);
    const events = await this.readEvents(draftRoot);
    return draftDetailSchema.parse({
      summary: {
        schemaVersion: 5,
        id: meta.id,
        containerId: meta.containerId,
        title: meta.title,
        status: meta.status,
        tags: normalizeTags(meta.tags),
        scope: meta.scope,
        version: meta.version,
        contentHash: meta.contentHash,
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        archivedAt: meta.archivedAt,
        archivedFromStatus: meta.archivedFromStatus,
        lastCheckpointAt: meta.lastCheckpointAt,
        snapshotCount: snapshots.values.length,
        dispatchCount: dispatches.values.length,
        contentOrigin: meta.contentOrigin,
        preview: preview(markdown),
      },
      markdown,
      checkpoints: checkpoints.values,
      snapshots: snapshots.values.map(({ markdown: _markdown, ...snapshot }) => snapshot),
      dispatches: dispatches.values,
      events: events.events,
      warnings: [...checkpoints.warnings, ...snapshots.warnings, ...dispatches.warnings, ...events.warnings],
    });
  }

  private async summarizeDraft(meta: DraftMeta, draftRoot: string, markdown: string): Promise<DraftSummary> {
    const countFiles = async (directory: string, pattern: RegExp): Promise<number> => {
      if (!(await exists(directory))) return 0;
      return (await readdir(directory, { withFileTypes: true })).filter(
        (entry) => entry.isFile() && !entry.isSymbolicLink() && pattern.test(entry.name),
      ).length;
    };
    const [snapshotCount, dispatchCount] = await Promise.all([
      countFiles(path.join(draftRoot, "snapshots"), /^sn_[a-f0-9]{24}\.json$/),
      countFiles(path.join(draftRoot, "dispatches"), /^ds_[a-f0-9]{24}\.json$/),
    ]);
    return {
      schemaVersion: 5,
      id: meta.id,
      containerId: meta.containerId,
      title: meta.title,
      status: meta.status,
      tags: normalizeTags(meta.tags),
      scope: meta.scope,
      version: meta.version,
      contentHash: meta.contentHash,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      archivedAt: meta.archivedAt,
      archivedFromStatus: meta.archivedFromStatus,
      lastCheckpointAt: meta.lastCheckpointAt,
      snapshotCount,
      dispatchCount,
      contentOrigin: meta.contentOrigin,
      preview: preview(markdown),
    };
  }

  async getDraft(draftId: DraftId): Promise<DraftDetail> {
    return this.withLock("tags-global", async () => {
      await this.recoverTagMutationJournals();
      return this.withLock(draftId, async () => {
        const draft = await this.loadDraftUnlocked(draftId);
        await this.updateCachedDraft(draft, false);
        return draft;
      });
    });
  }

  async createDraft(
    containerId: ContainerId,
    scope: DraftScope,
    title = "Untitled",
    markdown = "",
  ): Promise<DraftDetail> {
    const draftId = this.id("dr", 8) as DraftId;
    return this.withLock(draftId, async () => {
      const { root: containerRoot } = await this.findContainer(containerId);
      const draftRoot = this.draftRoot(containerRoot, draftId);
      await assertSafePath(containerRoot, path.join(containerRoot, "drafts"));
      await assertSafePath(containerRoot, draftRoot);
      await mkdir(path.join(draftRoot, "checkpoints"), { recursive: true });
      await mkdir(path.join(draftRoot, "snapshots"), { recursive: true });
      await mkdir(path.join(draftRoot, "dispatches"), { recursive: true });
      await mkdir(path.join(draftRoot, "events"), { recursive: true });
      await assertSafePath(containerRoot, draftRoot);
      const now = this.timestamp();
      const meta: DraftMeta = {
        schemaVersion: 5,
        id: draftId,
        containerId,
        title: title.trim() || "Untitled",
        status: "draft",
        tags: [],
        scope,
        version: 1,
        contentHash: hash(markdown),
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        archivedFromStatus: null,
        lastCheckpointAt: null,
        contentOrigin: { kind: "manual" },
      };
      await atomicWrite(path.join(draftRoot, DRAFT_MARKDOWN_NAME), markdown, containerRoot);
      await writeJson(path.join(draftRoot, DRAFT_META_NAME), meta, containerRoot);
      await this.writeDraftEvent(containerRoot, draftId, {
        type: "draft.created",
        containerId,
        summary: `Created ${meta.title}`,
        actor: "user",
      });
      await this.refreshCatalog();
      return this.loadDraftUnlocked(draftId);
    });
  }

  async autosaveDraft(input: AutosaveDraftInput): Promise<{
    summary: DraftSummary;
    checkpoint: Checkpoint | null;
    event: StudioEvent | null;
    checkpointCreated: boolean;
  }> {
    return this.withLock(input.draftId, async () => {
      await this.ensureNoUnresolvedGeneration(input.draftId, "save this draft");
      const { containerRoot, draftRoot } = await this.locateDraft(input.draftId);
      let meta = await this.readDraftMeta(draftRoot, containerRoot);
      const reconciled = await this.reconcileExternalEditUnlocked(containerRoot, draftRoot, meta);
      meta = reconciled.meta;
      if (meta.version !== input.expectedVersion || meta.contentHash !== input.expectedHash) {
        throw new Error(
          `Draft changed since it was opened (current version ${meta.version}, hash ${meta.contentHash}). Reload before saving.`,
        );
      }
      if (meta.status === "archived") throw new Error("Restore the archived draft before editing it");
      const nextTitle = input.title.trim() || "Untitled";
      const changedFields = [
        ...(meta.title === nextTitle ? [] : ["title"]),
        ...(reconciled.markdown === input.markdown ? [] : ["markdown"]),
      ];
      if (!changedFields.length) {
        return {
          summary: await this.summarizeDraft(meta, draftRoot, reconciled.markdown),
          checkpoint: null,
          event: null,
          checkpointCreated: false,
        };
      }
      let checkpoint: Checkpoint | null = null;
      if (!meta.lastCheckpointAt || this.now().getTime() - Date.parse(meta.lastCheckpointAt) >= CHECKPOINT_INTERVAL_MS) {
        const created = await this.createCheckpointUnlocked(containerRoot, draftRoot, meta, reconciled.markdown, "periodic");
        meta = created.meta;
        checkpoint = created.checkpoint;
      }
      const nextHash = hash(input.markdown);
      const now = this.timestamp();
      const next: DraftMeta = {
        ...meta,
        title: nextTitle,
        status: meta.status === "ready" ? "draft" : meta.status,
        version: meta.version + 1,
        contentHash: nextHash,
        updatedAt: now,
        contentOrigin: changedFields.includes("markdown") ? { kind: "manual" } : meta.contentOrigin,
      };
      await atomicWrite(path.join(draftRoot, DRAFT_MARKDOWN_NAME), input.markdown, containerRoot);
      await writeJson(path.join(draftRoot, DRAFT_META_NAME), next, containerRoot);
      const event = await this.writeDraftEvent(containerRoot, input.draftId, {
        type: "draft.autosaved",
        containerId: meta.containerId,
        summary: `Autosaved ${next.title}`,
        actor: "user",
        details: {
          changedFields,
          fromVersion: meta.version,
          toVersion: next.version,
          fromHash: meta.contentHash,
          toHash: nextHash,
          ...(meta.status === "ready" ? { fromStatus: "ready", toStatus: "draft" } : {}),
        },
      });
      if (meta.status === "ready") {
        await this.writeDraftEvent(containerRoot, input.draftId, {
          type: "draft.status-changed",
          containerId: meta.containerId,
          summary: `Changed ${next.title} from ready to draft after content edit`,
          actor: "user",
          details: { fromStatus: "ready", toStatus: "draft", reason: "content-edited" },
        });
      }
      const summary = await this.summarizeDraft(next, draftRoot, input.markdown);
      if (meta.status === "ready") {
        await this.updateCachedDraft(await this.loadDraftUnlocked(input.draftId, false), false);
      } else {
        await this.updateCachedAutosave(summary, event);
      }
      return { summary, checkpoint, event, checkpointCreated: checkpoint !== null };
    });
  }

  private async listDraftIds(): Promise<DraftId[]> {
    const ids: DraftId[] = [];
    for (const entry of await readdir(this.draftsPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^dr_[a-f0-9]{16}$/.test(entry.name)) continue;
      const draftRoot = path.join(this.draftsPath, entry.name);
      await assertSafePath(this.rootPath, draftRoot);
      ids.push(entry.name as DraftId);
    }
    return ids.sort();
  }

  private async summarizeCurrentDraft(draftId: DraftId): Promise<DraftSummary> {
    const { containerRoot, draftRoot } = await this.locateDraft(draftId);
    const meta = await this.readDraftMeta(draftRoot, containerRoot);
    const markdownPath = path.join(draftRoot, DRAFT_MARKDOWN_NAME);
    await assertSafePath(containerRoot, markdownPath);
    const markdown = await readFile(markdownPath, "utf8");
    return this.summarizeDraft(meta, draftRoot, markdown);
  }

  private async planTagMutation(
    draftIds: readonly DraftId[],
    transform: (tags: readonly string[]) => string[],
  ): Promise<TagMutationJournal["entries"]> {
    const entries: TagMutationJournal["entries"] = [];
    for (const draftId of [...new Set(draftIds)].sort()) {
      const planned = await this.withLock(draftId, async () => {
        const { containerRoot, draftRoot } = await this.locateDraft(draftId);
        const meta = await this.readDraftMeta(draftRoot, containerRoot);
        const beforeTags = normalizeTags(meta.tags);
        const afterTags = normalizeTags(transform(beforeTags));
        return sameTagDisplay(beforeTags, afterTags) ? null : { draftId, beforeTags, afterTags };
      });
      if (planned) entries.push(planned);
    }
    return entries;
  }

  private async summariesAfterTagMutation(entries: TagMutationJournal["entries"]): Promise<DraftSummary[]> {
    const summaries: DraftSummary[] = [];
    for (const entry of entries) {
      try {
        summaries.push(await this.withLock(entry.draftId, () => this.summarizeCurrentDraft(entry.draftId)));
      } catch (error) {
        if (!/Unknown Prompt Studio draft/.test(formatError(error))) throw error;
      }
    }
    return summaries;
  }

  async setDraftTags(input: SetDraftTagsInput): Promise<{
    summary: DraftSummary;
    changed: boolean;
    tagTree: TagTreeNode[];
  }> {
    return this.withLock("tags-global", async () => {
      await this.recoverTagMutationJournals();
      return this.withLock(input.draftId, async () => {
        const { containerRoot, draftRoot } = await this.locateDraft(input.draftId);
        const meta = await this.readDraftMeta(draftRoot, containerRoot);
        const currentTags = normalizeTags(meta.tags);
        if (!sameTagSet(currentTags, input.expectedTags)) {
          throw new Error("Draft tags changed since they were opened. Reload the current tags before saving.");
        }
        const nextTags = tagsForSet(currentTags, input.tags);
        const changed = JSON.stringify(meta.tags) !== JSON.stringify(nextTags);
        if (changed) {
          await writeJson(path.join(draftRoot, DRAFT_META_NAME), { ...meta, tags: nextTags }, containerRoot);
        }
        const summary = await this.summarizeCurrentDraft(input.draftId);
        const tagTree = await this.updateCachedTagSummaries(changed ? [summary] : []);
        return { summary, changed, tagTree };
      });
    });
  }

  async renameTag(fromPathInput: string, toPathInput: string): Promise<{
    changedDrafts: DraftSummary[];
    tagTree: TagTreeNode[];
  }> {
    return this.withLock("tags-global", async () => {
      await this.recoverTagMutationJournals();
      const fromPath = normalizeTags([fromPathInput])[0];
      const toPath = normalizeTags([toPathInput])[0];
      if (!fromPath || !toPath) throw new Error("Tag rename paths must contain at least one non-empty segment");
      if (tagKey(fromPath) !== tagKey(toPath) && tagMatchesPath(toPath, fromPath)) {
        throw new Error("A tag cannot be renamed into its own descendant");
      }
      const entries = await this.planTagMutation(
        await this.listDraftIds(),
        (tags) => renameTagPath(tags, fromPath, toPath),
      );
      await this.commitTagMutation("rename", entries, { fromPath, toPath });
      const changedDrafts = await this.summariesAfterTagMutation(entries);
      const tagTree = await this.updateCachedTagSummaries(changedDrafts);
      return { changedDrafts, tagTree };
    });
  }

  async batchDraftTags(input: BatchDraftTagsInput): Promise<{
    changedDrafts: DraftSummary[];
    tagTree: TagTreeNode[];
  }> {
    return this.withLock("tags-global", async () => {
      await this.recoverTagMutationJournals();
      const draftIds = [...new Set(input.draftIds)].sort();
      const entries = await this.planTagMutation(draftIds, (tags) => (
        addTags(
          removeTags(tags, input.removeTags, { includeDescendants: input.removeDescendants }),
          input.addTags,
        )
      ));
      await this.commitTagMutation("batch", entries, input);
      const changedDrafts = await this.summariesAfterTagMutation(entries);
      const tagTree = await this.updateCachedTagSummaries(changedDrafts);
      return { changedDrafts, tagTree };
    });
  }

  private async transitionDraftUnlocked(
    draftId: DraftId,
    targetStatus: DraftStatus,
    expected?: { version: number; hash: string },
  ): Promise<{ draft: DraftDetail; changed: boolean }> {
    await this.ensureNoUnresolvedGeneration(draftId, "change draft status");
    const { containerRoot, draftRoot } = await this.locateDraft(draftId);
    const reconciled = await this.reconcileExternalEditUnlocked(
      containerRoot,
      draftRoot,
      await this.readDraftMeta(draftRoot, containerRoot),
    );
    const meta = reconciled.meta;
    if (expected && (meta.version !== expected.version || meta.contentHash !== expected.hash)) {
      throw new Error(
        `Draft changed since it was opened (current version ${meta.version}, hash ${meta.contentHash}). Reload before changing status.`,
      );
    }
    if (meta.status === targetStatus) {
      const unchanged = await this.loadDraftUnlocked(draftId, false);
      if (reconciled.changed) await this.updateCachedDraft(unchanged, false);
      return { draft: unchanged, changed: false };
    }
    if (!canTransitionDraftStatus(meta.status, targetStatus, meta.archivedFromStatus)) {
      throw new Error(`Invalid draft status transition: ${meta.status} -> ${targetStatus}`);
    }

    const now = this.timestamp();
    const fromStatus = meta.status;
    let next: DraftMeta = {
      ...meta,
      status: targetStatus,
      archivedAt: targetStatus === "archived" ? now : null,
      archivedFromStatus: targetStatus === "archived"
        ? (isActiveDraftStatus(fromStatus) ? fromStatus : meta.archivedFromStatus)
        : null,
      version: meta.version + 1,
      updatedAt: now,
    };
    if (fromStatus === "draft" && targetStatus === "ready") {
      next = (await this.createCheckpointUnlocked(
        containerRoot,
        draftRoot,
        next,
        reconciled.markdown,
        "ready",
      )).meta;
    } else {
      await writeJson(path.join(draftRoot, DRAFT_META_NAME), next, containerRoot);
    }
    const action = targetStatus === "archived"
      ? `Archived ${next.title}`
      : fromStatus === "archived"
        ? `Restored ${next.title} as ${targetStatus}`
        : `Changed ${next.title} from ${fromStatus} to ${targetStatus}`;
    await this.writeDraftEvent(containerRoot, draftId, {
      type: "draft.status-changed",
      containerId: next.containerId,
      summary: action,
      actor: "user",
      details: { fromStatus, toStatus: targetStatus },
    });
    await this.refreshCatalog();
    return { draft: await this.loadDraftUnlocked(draftId, false), changed: true };
  }

  async transitionDraft(input: TransitionDraftInput): Promise<{ draft: DraftDetail; changed: boolean }> {
    return this.withLock(input.draftId, () => this.transitionDraftUnlocked(input.draftId, input.targetStatus, {
      version: input.expectedVersion,
      hash: input.expectedHash,
    }));
  }

  private deleteJournalPath(draftId: DraftId): string {
    return path.join(this.transactionsPath, `delete-${draftId}.json`);
  }

  private generationApplyJournalPath(draftId: DraftId, generationId: string): string {
    return path.join(this.transactionsPath, `generation-apply-${draftId}-${generationId}.json`);
  }

  private async writeCheckpointEventOnceUnlocked(
    containerRoot: string,
    draftRoot: string,
    meta: DraftMeta,
    checkpoint: Checkpoint,
  ): Promise<void> {
    const existsAlready = (await this.readEvents(draftRoot)).events.some(
      (event) => event.type === "checkpoint.created"
        && event.details.checkpointId === checkpoint.id,
    );
    if (existsAlready) return;
    await this.writeDraftEvent(containerRoot, meta.id, {
      type: "checkpoint.created",
      containerId: meta.containerId,
      summary: `Created ${checkpoint.reason} checkpoint`,
      actor: "plugin",
      details: {
        checkpointId: checkpoint.id,
        version: checkpoint.version,
        contentHash: checkpoint.contentHash,
      },
    });
  }

  private async completeGenerationApplyJournalUnlocked(
    journal: GenerationApplyJournal,
    journalPath: string,
  ): Promise<{ job: GenerationJob; draft: DraftDetail }> {
    const { containerRoot, draftRoot } = await this.locateDraft(journal.draftId);
    let job = await this.generations.get(journal.draftId, journal.generationId);
    if (!job.responseMarkdown || job.responseHash !== journal.responseHash) {
      throw new Error(`Generation apply journal response lineage is incomplete: ${journal.generationId}`);
    }
    if (hash(job.responseMarkdown) !== journal.responseHash) {
      throw new Error(`Generation apply journal response hash mismatch: ${journal.generationId}`);
    }

    const currentMeta = await this.readDraftMeta(draftRoot, containerRoot);
    const markdownPath = path.join(draftRoot, DRAFT_MARKDOWN_NAME);
    await assertSafePath(containerRoot, markdownPath);
    const currentMarkdown = await readFile(markdownPath, "utf8");
    const currentRevision = JSON.stringify(generationRevisionMetadata(currentMeta));
    const metaIsBefore = currentRevision === JSON.stringify(generationRevisionMetadata(journal.beforeMeta));
    const metaIsNext = currentRevision === JSON.stringify(generationRevisionMetadata(journal.nextMeta));
    const nextMeta = generationNextMetaWithCurrentTags(journal.nextMeta, currentMeta);
    const bodyIsBefore = currentMarkdown === journal.beforeMarkdown;
    const bodyIsNext = currentMarkdown === job.responseMarkdown;

    if (["failed", "discarded", "abandoned"].includes(job.status)) {
      await assertSafePath(this.rootPath, journalPath);
      await rm(journalPath, { force: true });
      return { job, draft: await this.loadDraftUnlocked(journal.draftId, false) };
    }
    if ((!metaIsBefore && !metaIsNext) || (!bodyIsBefore && !bodyIsNext)) {
      if (job.status === "applied") {
        throw new Error(`Applied generation ${journal.generationId} no longer matches its canonical Draft`);
      }
      if (job.status !== "result-ready" && job.status !== "conflict") {
        throw new Error(`Cannot recover generation apply while job is ${job.status}`);
      }
      // If the generated body was written before the interrupted transaction,
      // roll it back before exposing the response as a conflict candidate. It
      // must never become canonical without generated provenance merely because
      // unrelated metadata changed during recovery.
      if (bodyIsNext && !bodyIsBefore) {
        await atomicWrite(markdownPath, journal.beforeMarkdown, containerRoot);
      }
      const reconciledConflict = await this.reconcileExternalEditUnlocked(
        containerRoot,
        draftRoot,
        currentMeta,
      );
      job = await this.generations.markConflict(
        journal.draftId,
        journal.generationId,
        "The Draft changed while a generated response was being committed.",
      );
      await this.writeGenerationEventOnceUnlocked(containerRoot, draftRoot, journal.draftId, {
        type: "generation.conflict",
        containerId: reconciledConflict.meta.containerId,
        summary: `Saved generated response as a conflict candidate for ${reconciledConflict.meta.title}`,
        generationId: journal.generationId,
        details: {
          expectedVersion: journal.beforeMeta.version,
          expectedHash: journal.beforeMeta.contentHash,
          currentVersion: reconciledConflict.meta.version,
          currentHash: reconciledConflict.meta.contentHash,
          reason: "interrupted-apply-external-change",
        },
      });
      await assertSafePath(this.rootPath, journalPath);
      await rm(journalPath, { force: true });
      const draft = await this.loadDraftUnlocked(journal.draftId, false);
      await this.updateCachedDraft(draft, false);
      return { job, draft };
    }

    if (job.status !== "result-ready" && job.status !== "conflict" && job.status !== "applied") {
      throw new Error(`Cannot complete generation apply while job is ${job.status}`);
    }
    const checkpointPath = path.join(
      draftRoot,
      "checkpoints",
      `${compactTimestamp(journal.checkpoint.at)}-${journal.checkpoint.id}.md`,
    );
    const expectedCheckpoint = checkpointDocument(journal.checkpoint, journal.beforeMarkdown);
    if (await exists(checkpointPath)) {
      await assertSafePath(containerRoot, checkpointPath);
      if (await readFile(checkpointPath, "utf8") !== expectedCheckpoint) {
        throw new Error(`Generation undo checkpoint conflicts with existing content: ${journal.checkpoint.id}`);
      }
    } else {
      await atomicWrite(checkpointPath, expectedCheckpoint, containerRoot);
    }
    await this.writeCheckpointEventOnceUnlocked(
      containerRoot,
      draftRoot,
      journal.beforeMeta,
      journal.checkpoint,
    );
    if (!bodyIsNext) await atomicWrite(markdownPath, job.responseMarkdown, containerRoot);
    if (JSON.stringify(currentMeta) !== JSON.stringify(nextMeta)) {
      await writeJson(path.join(draftRoot, DRAFT_META_NAME), nextMeta, containerRoot);
    }

    const jobAlreadyApplied = job.status === "applied";
    if (jobAlreadyApplied) {
      if (
        job.checkpointId !== journal.checkpoint.id
        || job.appliedVersion !== nextMeta.version
        || job.appliedHash !== nextMeta.contentHash
      ) {
        throw new Error(`Applied generation provenance mismatch: ${journal.generationId}`);
      }
    }
    await this.writeGenerationEventOnceUnlocked(containerRoot, draftRoot, journal.draftId, {
      type: "generation.applied",
      containerId: nextMeta.containerId,
      summary: `${job.task === "format" ? "Formatted" : "Optimized"} ${nextMeta.title} with an Agent`,
      generationId: journal.generationId,
      details: {
        agentId: job.agentId,
        provider: job.configuration.provider,
        model: job.configuration.model,
        task: job.task,
        checkpointId: journal.checkpoint.id,
        fromVersion: journal.beforeMeta.version,
        toVersion: nextMeta.version,
        fromHash: journal.beforeMeta.contentHash,
        toHash: nextMeta.contentHash,
        counts: job.counts,
        ...(journal.beforeMeta.status === "ready" ? { fromStatus: "ready", toStatus: "draft" } : {}),
      },
    });
    if (journal.beforeMeta.status === "ready") {
      const statusAlreadyRecorded = (await this.readEvents(draftRoot)).events.some(
        (event) => event.type === "draft.status-changed"
          && event.details.reason === "content-generated"
          && event.details.generationId === journal.generationId,
      );
      if (!statusAlreadyRecorded) {
        await this.writeDraftEvent(containerRoot, journal.draftId, {
          type: "draft.status-changed",
          containerId: nextMeta.containerId,
          summary: `Changed ${nextMeta.title} from ready to draft after generated content was applied`,
          actor: "plugin",
          details: {
            fromStatus: "ready",
            toStatus: "draft",
            reason: "content-generated",
            generationId: journal.generationId,
          },
        });
      }
    }
    await assertSafePath(this.rootPath, journalPath);
    await rm(journalPath, { force: true });
    if (!jobAlreadyApplied) {
      job = await this.generations.markApplied(journal.draftId, journal.generationId, {
        checkpointId: journal.checkpoint.id,
        appliedVersion: nextMeta.version,
        appliedHash: nextMeta.contentHash,
      });
    }
    const draft = await this.loadDraftUnlocked(journal.draftId, false);
    await this.updateCachedDraft(draft, false);
    return { job, draft };
  }

  private async recoverGenerationApplyJournals(): Promise<void> {
    if (!(await exists(this.transactionsPath))) return;
    await assertSafePath(this.rootPath, this.transactionsPath);
    for (const entry of await readdir(this.transactionsPath, { withFileTypes: true })) {
      if (
        !entry.isFile()
        || entry.isSymbolicLink()
        || !/^generation-apply-dr_[a-f0-9]{16}-gn_[a-f0-9]{24}\.json$/.test(entry.name)
      ) continue;
      const journalPath = path.join(this.transactionsPath, entry.name);
      const journal = generationApplyJournalSchema.parse(await readJson(journalPath));
      const releaseDraft = await this.acquireFileLock(journal.draftId);
      try {
        await this.completeGenerationApplyJournalUnlocked(journal, journalPath);
      } catch (error) {
        throw new Error(`Unable to recover ${entry.name}: ${formatError(error)}`);
      } finally {
        await releaseDraft();
      }
    }
  }

  private deleteQuarantinePath(draftId: DraftId): string {
    return path.join(this.transactionsPath, `deleting-${draftId}`);
  }

  private async purgeDraftContainerEvents(draftId: DraftId): Promise<void> {
    for (const eventsRoot of await this.vault.eventRoots()) {
      for (const filePath of await collectFiles(eventsRoot, (name) => name.endsWith(".json"), 4)) {
        await assertSafePath(this.rootPath, filePath);
        const raw = await readFile(filePath, "utf8");
        let matches = raw.includes(draftId);
        try {
          const parsed = eventSchema.safeParse(JSON.parse(raw));
          if (parsed.success) matches = parsed.data.draftId === draftId;
        } catch {
          // A malformed duplicate event can still be identified by its logical Draft ID.
        }
        if (matches) await rm(filePath, { force: true });
      }
    }
  }

  private async completeDeleteJournal(journal: DeleteJournal, journalPath: string): Promise<void> {
    const draftRoot = this.draftRoot(this.rootPath, journal.draftId);
    const quarantinePath = this.deleteQuarantinePath(journal.draftId);
    const resolvedTransactions = path.resolve(this.transactionsPath);
    const resolvedQuarantine = path.resolve(quarantinePath);
    if (!isWithinPath(resolvedTransactions, resolvedQuarantine) || resolvedQuarantine === resolvedTransactions) {
      throw new Error(`Unsafe draft deletion quarantine path: ${quarantinePath}`);
    }

    const draftExists = await exists(draftRoot);
    const quarantineExists = await exists(quarantinePath);
    if (draftExists && quarantineExists) {
      throw new Error(`Both canonical and quarantined copies exist for deleted draft ${journal.draftId}`);
    }
    if (draftExists) {
      await assertTreeSafe(this.rootPath, draftRoot);
      await assertSafePath(this.rootPath, this.transactionsPath);
      await rename(draftRoot, quarantinePath);
    }
    if (await exists(quarantinePath)) {
      await assertTreeSafe(this.rootPath, quarantinePath);
      await rm(quarantinePath, { recursive: true, force: true });
    }
    await this.purgeDraftContainerEvents(journal.draftId);
    await assertSafePath(this.rootPath, journalPath);
    await rm(journalPath, { force: true });
  }

  private async recoverDeleteJournals(): Promise<void> {
    if (!(await exists(this.transactionsPath))) return;
    for (const entry of await readdir(this.transactionsPath, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^delete-dr_[a-f0-9]{16}\.json$/.test(entry.name)) continue;
      const journalPath = path.join(this.transactionsPath, entry.name);
      try {
        await assertSafePath(this.rootPath, journalPath);
        const journal = deleteJournalSchema.parse(await readJson(journalPath));
        await this.completeDeleteJournal(journal, journalPath);
      } catch (error) {
        throw new Error(`Unable to recover ${entry.name}: ${formatError(error)}`);
      }
    }
  }

  async deleteDraft(input: DeleteDraftInput): Promise<{ deletedDraftId: DraftId }> {
    if (input.confirmationDraftId !== input.draftId) throw new Error("Permanent deletion confirmation did not match the Draft ID");
    return this.withLock("vault-recovery", async () => {
      await this.recoverDeleteJournals();
      return this.withLock("tags-global", async () => {
        await this.recoverTagMutationJournals();
        return this.withLock(input.draftId, async () => {
      await this.ensureNoUnresolvedGeneration(input.draftId, "permanently delete this draft");
      const { containerRoot, draftRoot } = await this.locateDraft(input.draftId);
      const reconciled = await this.reconcileExternalEditUnlocked(
        containerRoot,
        draftRoot,
        await this.readDraftMeta(draftRoot, containerRoot),
      );
      const meta = reconciled.meta;
      if (meta.version !== input.expectedVersion || meta.contentHash !== input.expectedHash) {
        throw new Error(
          `Draft changed since it was opened (current version ${meta.version}, hash ${meta.contentHash}). Reload before deleting.`,
        );
      }
      if (meta.status !== "archived") throw new Error("Only archived drafts can be permanently deleted");
      const dispatches = await this.listDispatches(draftRoot, containerRoot);
      if (dispatches.warnings.length) {
        throw new Error("Repair malformed dispatch records before permanently deleting this draft");
      }
      if (dispatches.values.some((dispatch) => dispatch.status === "pending")) {
        throw new Error("Reconcile every pending dispatch before permanently deleting this draft");
      }
      await assertTreeSafe(containerRoot, draftRoot);

          const journal: DeleteJournal = {
            schemaVersion: 3,
            operation: "draft-delete",
            draftId: input.draftId,
            containerId: meta.containerId,
            createdAt: this.timestamp(),
          };
          const journalPath = this.deleteJournalPath(input.draftId);
          await writeJson(journalPath, journal, this.rootPath);
          await this.completeDeleteJournal(journal, journalPath);
          await this.refreshCatalog();
          return { deletedDraftId: input.draftId };
        });
      });
    });
  }

  async moveDraftScope(draftId: DraftId, targetContainerId: ContainerId, scope: DraftScope): Promise<DraftDetail> {
    return this.withLock(draftId, async () => {
      await this.ensureNoUnresolvedGeneration(draftId, "change draft Scope");
      const source = await this.locateDraft(draftId);
      let meta = await this.readDraftMeta(source.draftRoot, source.containerRoot);
      const reconciled = await this.reconcileExternalEditUnlocked(source.containerRoot, source.draftRoot, meta);
      meta = reconciled.meta;
      if (meta.containerId === targetContainerId && sameScope(meta.scope, scope)) {
        const unchanged = await this.loadDraftUnlocked(draftId, false);
        if (reconciled.changed) await this.updateCachedDraft(unchanged, false);
        return unchanged;
      }
      if (meta.status === "archived") throw new Error("Restore the archived draft before changing its Scope");
      await this.vault.findContainer(targetContainerId);
      const sourceScope = meta.scope;
      meta = (await this.createCheckpointUnlocked(source.containerRoot, source.draftRoot, meta, reconciled.markdown, "scope")).meta;
      const originalContainerId = meta.containerId;
      const next: DraftMeta = {
        ...meta,
        containerId: targetContainerId,
        scope,
        version: meta.version + 1,
        updatedAt: this.timestamp(),
      };
      await writeJson(path.join(source.draftRoot, DRAFT_META_NAME), next, source.containerRoot);
      await this.writeDraftEvent(source.containerRoot, draftId, {
        type: "draft.scope-moved",
        containerId: targetContainerId,
        summary: `Moved ${next.title} from ${scopeLocation(sourceScope)} to ${scopeLocation(scope)}`,
        actor: "user",
        details: { sourceContainerId: originalContainerId, targetContainerId, sourceScope, targetScope: scope, scope },
      });
      await this.refreshCatalog();
      return this.loadDraftUnlocked(draftId, false);
    });
  }

  async getCheckpoint(draftId: DraftId, checkpointId: string): Promise<CheckpointContent> {
    return this.withLock(draftId, async () => {
      const { containerRoot, draftRoot } = await this.locateDraft(draftId);
      return readStoredCheckpoint(draftRoot, containerRoot, draftId, checkpointId);
    });
  }

  async restoreCheckpoint(input: RestoreCheckpointInput): Promise<{ draft: DraftDetail; restored: boolean }> {
    return this.withLock(input.draftId, async () => {
      await this.ensureNoUnresolvedGeneration(input.draftId, "restore a checkpoint");
      const { containerRoot, draftRoot } = await this.locateDraft(input.draftId);
      let meta = await this.readDraftMeta(draftRoot, containerRoot);
      const reconciled = await this.reconcileExternalEditUnlocked(containerRoot, draftRoot, meta);
      meta = reconciled.meta;
      if (meta.version !== input.expectedVersion || meta.contentHash !== input.expectedHash) {
        throw new Error(
          `Draft changed since the checkpoint preview was opened (current version ${meta.version}, hash ${meta.contentHash}). Reload before restoring.`,
        );
      }
      if (meta.status === "archived") {
        throw new Error("Restore the archived draft before applying a checkpoint");
      }

      const target = await readStoredCheckpoint(
        draftRoot,
        containerRoot,
        input.draftId,
        input.checkpointId,
      );
      if (target.contentHash === meta.contentHash && target.markdown === reconciled.markdown) {
        return { draft: await this.loadDraftUnlocked(input.draftId, false), restored: false };
      }

      const beforeRestore = await this.createCheckpointUnlocked(
        containerRoot,
        draftRoot,
        meta,
        reconciled.markdown,
        "restore",
      );
      meta = beforeRestore.meta;
      const now = this.timestamp();
      const next: DraftMeta = {
        ...meta,
        status: meta.status === "ready" ? "draft" : meta.status,
        version: meta.version + 1,
        contentHash: target.contentHash,
        updatedAt: now,
        contentOrigin: { kind: "manual" },
      };
      await atomicWrite(path.join(draftRoot, DRAFT_MARKDOWN_NAME), target.markdown, containerRoot);
      await writeJson(path.join(draftRoot, DRAFT_META_NAME), next, containerRoot);
      await this.writeDraftEvent(containerRoot, input.draftId, {
        type: "checkpoint.restored",
        containerId: next.containerId,
        summary: `Restored checkpoint ${target.id} from v${target.version}`,
        actor: "user",
        details: {
          checkpointId: target.id,
          safetyCheckpointId: beforeRestore.checkpoint.id,
          fromVersion: meta.version,
          toVersion: next.version,
          fromHash: meta.contentHash,
          toHash: next.contentHash,
          ...(meta.status === "ready" ? { fromStatus: "ready", toStatus: "draft" } : {}),
        },
      });
      if (meta.status === "ready") {
        await this.writeDraftEvent(containerRoot, input.draftId, {
          type: "draft.status-changed",
          containerId: next.containerId,
          summary: `Changed ${next.title} from ready to draft after checkpoint restore`,
          actor: "user",
          details: { fromStatus: "ready", toStatus: "draft", reason: "content-edited" },
        });
      }
      const draft = await this.loadDraftUnlocked(input.draftId, false);
      await this.updateCachedDraft(draft, false);
      return { draft, restored: true };
    });
  }

  private async applyGenerationRevisionUnlocked(
    input: ApplyGenerationRevisionInput,
  ): Promise<ApplyGenerationRevisionResult> {
      const { containerRoot, draftRoot } = await this.locateDraft(input.draftId);
      let meta = await this.readDraftMeta(draftRoot, containerRoot);
      const reconciled = await this.reconcileExternalEditUnlocked(containerRoot, draftRoot, meta);
      meta = reconciled.meta;

      if (meta.contentOrigin.kind === "generated" && meta.contentOrigin.generationId === input.generationId) {
        const event = (await this.readEvents(draftRoot)).events.find(
          (candidate) => candidate.type === "generation.applied"
            && candidate.details.generationId === input.generationId,
        );
        const checkpointId = typeof event?.details.checkpointId === "string" ? event.details.checkpointId : null;
        if (!checkpointId) throw new Error(`Applied generation ${input.generationId} is missing checkpoint provenance`);
        return {
          status: "applied",
          draft: await this.loadDraftUnlocked(input.draftId, false),
          checkpointId,
        };
      }

      if (meta.version !== input.expectedVersion || meta.contentHash !== input.expectedHash) {
        await this.writeGenerationEventOnceUnlocked(containerRoot, draftRoot, input.draftId, {
          type: "generation.conflict",
          containerId: meta.containerId,
          summary: `Saved generated response as a conflict candidate for ${meta.title}`,
          generationId: input.generationId,
          details: {
            agentId: input.agentId,
            expectedVersion: input.expectedVersion,
            expectedHash: input.expectedHash,
            currentVersion: meta.version,
            currentHash: meta.contentHash,
          },
        });
        const draft = await this.loadDraftUnlocked(input.draftId, false);
        await this.updateCachedDraft(draft, false);
        return { status: "conflict", draft };
      }
      if (meta.status === "archived") throw new Error("Restore the archived draft before applying generated content");

      const before = await this.createCheckpointUnlocked(
        containerRoot,
        draftRoot,
        meta,
        reconciled.markdown,
        input.task === "format" ? "before-format" : "before-generation",
      );
      meta = before.meta;
      const now = this.timestamp();
      const nextHash = hash(input.markdown);
      const revertsReady = meta.status === "ready";
      const next: DraftMeta = {
        ...meta,
        schemaVersion: 5,
        status: revertsReady ? "draft" : meta.status,
        version: meta.version + 1,
        contentHash: nextHash,
        updatedAt: now,
        contentOrigin: {
          kind: "generated",
          task: input.task,
          generationId: input.generationId,
          at: now,
          agentId: input.agentId,
          provider: input.provider,
          model: input.model,
          includedPromptCount: input.counts.includedOtherPromptCount,
          includedVersionCount:
            input.counts.includedReferenceVersionCount + input.counts.includedTargetHistoryVersionCount,
        },
      };
      await atomicWrite(path.join(draftRoot, DRAFT_MARKDOWN_NAME), input.markdown, containerRoot);
      await writeJson(path.join(draftRoot, DRAFT_META_NAME), next, containerRoot);
      await this.writeGenerationEventOnceUnlocked(containerRoot, draftRoot, input.draftId, {
        type: "generation.applied",
        containerId: next.containerId,
        summary: `${input.task === "format" ? "Formatted" : "Optimized"} ${next.title} with an Agent`,
        generationId: input.generationId,
        details: {
          agentId: input.agentId,
          provider: input.provider,
          model: input.model,
          task: input.task,
          checkpointId: before.checkpoint.id,
          fromVersion: meta.version,
          toVersion: next.version,
          fromHash: meta.contentHash,
          toHash: nextHash,
          counts: input.counts,
          ...(revertsReady ? { fromStatus: "ready", toStatus: "draft" } : {}),
        },
      });
      if (revertsReady) {
        await this.writeDraftEvent(containerRoot, input.draftId, {
          type: "draft.status-changed",
          containerId: next.containerId,
          summary: `Changed ${next.title} from ready to draft after generated content was applied`,
          actor: "plugin",
          details: { fromStatus: "ready", toStatus: "draft", reason: "content-generated" },
        });
      }
      const draft = await this.loadDraftUnlocked(input.draftId, false);
      await this.updateCachedDraft(draft, false);
      return { status: "applied", draft, checkpointId: before.checkpoint.id };
  }

  async applyGenerationRevision(input: ApplyGenerationRevisionInput): Promise<ApplyGenerationRevisionResult> {
    if (!/^gn_[a-f0-9]{24}$/.test(input.generationId)) throw new Error("Invalid generation ID");
    return this.withLock(input.draftId, async () => {
      return this.applyGenerationRevisionUnlocked(input);
    });
  }

  private async applyCapturedGenerationUnlocked(input: {
    job: GenerationJob;
    expectedVersion: number;
    expectedHash: string;
  }): Promise<{ job: GenerationJob; draft: DraftDetail }> {
    const { job } = input;
    if (!job.responseMarkdown || !job.responseHash || !job.agentId) {
      throw new Error(`Generation ${job.id} has no captured response to apply`);
    }
    const journalPath = this.generationApplyJournalPath(job.draftId, job.id);
    if (await exists(journalPath)) {
      const existing = generationApplyJournalSchema.parse(await readJson(journalPath));
      if (existing.draftId !== job.draftId || existing.generationId !== job.id) {
        throw new Error(`Generation apply journal lineage mismatch: ${job.id}`);
      }
      return this.completeGenerationApplyJournalUnlocked(existing, journalPath);
    }
    const revision: ApplyGenerationRevisionInput = {
      draftId: job.draftId,
      generationId: job.id,
      task: job.task,
      markdown: job.responseMarkdown,
      expectedVersion: input.expectedVersion,
      expectedHash: input.expectedHash,
      agentId: job.agentId,
      provider: job.configuration.provider,
      model: job.configuration.model,
      counts: job.counts,
    };
    const { containerRoot, draftRoot } = await this.locateDraft(job.draftId);
    let meta = await this.readDraftMeta(draftRoot, containerRoot);
    const reconciled = await this.reconcileExternalEditUnlocked(containerRoot, draftRoot, meta);
    meta = reconciled.meta;

    if (meta.contentOrigin.kind === "generated" && meta.contentOrigin.generationId === job.id) {
      const applied = await this.applyGenerationRevisionUnlocked(revision);
      if (applied.status !== "applied") throw new Error(`Generation ${job.id} lost applied provenance`);
      const appliedJob = job.status === "applied" ? job : await this.generations.markApplied(job.draftId, job.id, {
        checkpointId: applied.checkpointId,
        appliedVersion: applied.draft.summary.version,
        appliedHash: applied.draft.summary.contentHash,
      });
      return { job: appliedJob, draft: applied.draft };
    }
    if (meta.version !== input.expectedVersion || meta.contentHash !== input.expectedHash) {
      const conflict = await this.applyGenerationRevisionUnlocked(revision);
      if (conflict.status !== "conflict") throw new Error(`Generation ${job.id} conflict was not retained`);
      const conflictJob = await this.generations.markConflict(
        job.draftId,
        job.id,
        "The Draft changed before the generated response could be applied.",
      );
      return { job: conflictJob, draft: conflict.draft };
    }
    if (meta.status === "archived") throw new Error("Restore the archived draft before applying generated content");

    const at = this.timestamp();
    const checkpoint: Checkpoint = checkpointSchema.parse({
      id: this.id("cp"),
      draftId: job.draftId,
      reason: job.task === "format" ? "before-format" : "before-generation",
      at,
      version: meta.version,
      contentHash: hash(reconciled.markdown),
    });
    const nextHash = hash(job.responseMarkdown);
    const nextMeta: DraftMeta = {
      ...meta,
      schemaVersion: 5,
      status: meta.status === "ready" ? "draft" : meta.status,
      version: meta.version + 1,
      contentHash: nextHash,
      updatedAt: at,
      lastCheckpointAt: at,
      contentOrigin: {
        kind: "generated",
        task: job.task,
        generationId: job.id,
        at,
        agentId: job.agentId,
        provider: job.configuration.provider,
        model: job.configuration.model,
        includedPromptCount: job.counts.includedOtherPromptCount,
        includedVersionCount:
          job.counts.includedReferenceVersionCount + job.counts.includedTargetHistoryVersionCount,
      },
    };
    const journal = generationApplyJournalSchema.parse({
      schemaVersion: 1,
      operation: "generation-apply",
      draftId: job.draftId,
      generationId: job.id,
      checkpoint,
      beforeMeta: meta,
      beforeMarkdown: reconciled.markdown,
      nextMeta,
      responseHash: job.responseHash,
      createdAt: at,
    });
    await writeJson(journalPath, journal, this.rootPath);
    return this.completeGenerationApplyJournalUnlocked(journal, journalPath);
  }

  async commitGenerationResponse(input: {
    draftId: DraftId;
    generationId: string;
    responseMarkdown: string;
    agentId: string;
  }): Promise<{ job: GenerationJob; draft: DraftDetail }> {
    return this.withLock(input.draftId, async () => {
      let job = await this.generations.get(input.draftId, input.generationId);
      if (!["launching", "running", "needs-attention", "result-ready"].includes(job.status)) {
        throw new Error(`Cannot commit a generation response while generation is ${job.status}`);
      }
      if (job.agentId && job.agentId !== input.agentId) {
        throw new Error(`Generation Agent lineage mismatch: ${input.agentId}`);
      }
      const responseMarkdown = input.responseMarkdown.replace(/\r\n?/g, "\n");
      job = await this.generations.captureResponse(
        input.draftId,
        input.generationId,
        responseMarkdown,
        input.agentId,
      );
      if (responseMarkdown.length > MAX_DRAFT_MARKDOWN_LENGTH) {
        const error = `Generation Agent response exceeds the ${MAX_DRAFT_MARKDOWN_LENGTH}-character Draft limit`;
        job = await this.generations.markFailed(input.draftId, input.generationId, error);
        const { containerRoot, draftRoot } = await this.locateDraft(input.draftId);
        const meta = await this.readDraftMeta(draftRoot, containerRoot);
        await this.writeGenerationEventOnceUnlocked(containerRoot, draftRoot, input.draftId, {
          type: "generation.failed",
          containerId: meta.containerId,
          summary: `Generation ${input.generationId} failed`,
          generationId: input.generationId,
          details: { error, agentId: input.agentId },
        });
        const draft = await this.loadDraftUnlocked(input.draftId, false);
        await this.updateCachedDraft(draft, false);
        return { job, draft };
      }
      return this.applyCapturedGenerationUnlocked({
        job,
        expectedVersion: job.baseVersion,
        expectedHash: job.baseHash,
      });
    });
  }

  async applyGenerationCandidate(input: {
    draftId: DraftId;
    generationId: string;
    expectedVersion: number;
    expectedHash: string;
  }): Promise<{ job: GenerationJob; draft: DraftDetail }> {
    return this.withLock(input.draftId, async () => {
      let job = await this.generations.get(input.draftId, input.generationId);
      if (job.status !== "conflict" || !job.responseMarkdown || !job.agentId) {
        throw new Error(`Generation ${job.id} has no conflict candidate to apply`);
      }
      return this.applyCapturedGenerationUnlocked({
        job,
        expectedVersion: input.expectedVersion,
        expectedHash: input.expectedHash,
      });
    });
  }

  async discardGeneration(draftId: DraftId, generationId: string): Promise<GenerationJob> {
    return this.withLock(draftId, async () => {
      const job = await this.generations.discard(draftId, generationId);
      const { containerRoot, draftRoot } = await this.locateDraft(draftId);
      const meta = await this.readDraftMeta(draftRoot, containerRoot);
      await this.writeGenerationEventOnceUnlocked(containerRoot, draftRoot, draftId, {
        type: "generation.discarded",
        containerId: meta.containerId,
        summary: `Discarded generation candidate ${generationId}`,
        generationId,
      });
      await this.updateCachedDraft(await this.loadDraftUnlocked(draftId, false), false);
      return job;
    });
  }

  async abandonGeneration(draftId: DraftId, generationId: string): Promise<GenerationJob> {
    return this.withLock(draftId, async () => this.generations.abandon(draftId, generationId));
  }

  async failGeneration(
    draftId: DraftId,
    generationId: string,
    error: string,
    agentId: string | null,
  ): Promise<GenerationJob> {
    return this.withLock(draftId, async () => {
      const job = await this.generations.transition(draftId, generationId, "failed", {
        error,
        ...(agentId ? { agentId } : {}),
      });
      const { containerRoot, draftRoot } = await this.locateDraft(draftId);
      const meta = await this.readDraftMeta(draftRoot, containerRoot);
      await this.writeGenerationEventOnceUnlocked(containerRoot, draftRoot, draftId, {
        type: "generation.failed",
        containerId: meta.containerId,
        summary: `Generation ${generationId} failed`,
        generationId,
        details: { error, ...(agentId ? { agentId } : {}) },
      });
      await this.updateCachedDraft(await this.loadDraftUnlocked(draftId, false), false);
      return job;
    });
  }

  private async createSnapshotUnlocked(draftId: DraftId): Promise<Snapshot> {
    await this.ensureNoUnresolvedGeneration(draftId, "send this draft");
    const { containerRoot, draftRoot } = await this.locateDraft(draftId);
    let meta = await this.readDraftMeta(draftRoot, containerRoot);
    const reconciled = await this.reconcileExternalEditUnlocked(containerRoot, draftRoot, meta);
    if (!isSendableDraftStatus(reconciled.meta.status)) {
      throw new Error("Only ready drafts can be sent");
    }
    meta = (await this.createCheckpointUnlocked(containerRoot, draftRoot, reconciled.meta, reconciled.markdown, "send")).meta;
    const now = this.timestamp();
    const snapshot: Snapshot = snapshotSchema.parse({
      schemaVersion: 2,
      id: this.id("sn"),
      draftId,
      createdAt: now,
      title: meta.title,
      version: meta.version,
      contentHash: hash(reconciled.markdown),
      scope: meta.scope,
      markdown: reconciled.markdown,
    });
    const snapshotsRoot = path.join(draftRoot, "snapshots");
    const markdownPath = path.join(snapshotsRoot, `${snapshot.id}.md`);
    const jsonPath = path.join(snapshotsRoot, `${snapshot.id}.json`);
    if ((await exists(markdownPath)) || (await exists(jsonPath))) throw new Error(`Snapshot already exists: ${snapshot.id}`);
    await atomicWrite(markdownPath, snapshot.markdown, containerRoot);
    const { markdown: _markdown, ...metadata } = snapshot;
    await writeJson(jsonPath, metadata, containerRoot);
    return snapshot;
  }

  async createSnapshot(draftId: DraftId): Promise<Snapshot> {
    return this.withLock(draftId, () => this.createSnapshotUnlocked(draftId));
  }

  async getSnapshot(draftId: DraftId, snapshotId: string): Promise<Snapshot> {
    return this.withLock(draftId, async () => {
      const { containerRoot, draftRoot } = await this.locateDraft(draftId);
      const metadataPath = path.join(draftRoot, "snapshots", `${snapshotId}.json`);
      const markdownPath = path.join(draftRoot, "snapshots", `${snapshotId}.md`);
      await assertSafePath(containerRoot, metadataPath);
      await assertSafePath(containerRoot, markdownPath);
      const metadata = snapshotSchema
        .omit({ markdown: true })
        .parse(await readJson(metadataPath));
      if (metadata.draftId !== draftId || metadata.id !== snapshotId) throw new Error("Snapshot lineage mismatch");
      const markdown = await readFile(markdownPath, "utf8");
      const snapshot = snapshotSchema.parse({ ...metadata, markdown });
      if (hash(markdown) !== snapshot.contentHash) throw new Error(`Immutable snapshot hash mismatch: ${snapshotId}`);
      return snapshot;
    });
  }

  async prepareDispatch(draftId: DraftId, target: DispatchTarget): Promise<{ snapshot: Snapshot; dispatch: Dispatch }> {
    return this.withLock(draftId, async () => {
      const snapshot = await this.createSnapshotUnlocked(draftId);
      const { containerRoot, draftRoot } = await this.locateDraft(draftId);
      const meta = await this.readDraftMeta(draftRoot, containerRoot);
      const now = this.timestamp();
      const dispatch: Dispatch = dispatchSchema.parse({
        schemaVersion: 2,
        id: this.id("ds"),
        draftId,
        snapshotId: snapshot.id,
        clientMessageId: `prompt-studio:${draftId}:${snapshot.id}`,
        target,
        status: "pending",
        attemptCount: 1,
        createdAt: now,
        updatedAt: now,
        agentId: target.kind === "existing_agent" ? target.agentId : null,
        workspaceId: target.kind === "new_agent" ? target.workspaceId : null,
        error: null,
        linkedSession: null,
      });
      await writeJson(path.join(draftRoot, "dispatches", `${dispatch.id}.json`), dispatch, containerRoot);
      await this.writeDraftEvent(containerRoot, draftId, {
        type: "dispatch.pending",
        containerId: meta.containerId,
        summary: `Prepared immutable snapshot ${snapshot.id} for dispatch`,
        actor: "user",
        details: { dispatchId: dispatch.id, snapshotId: snapshot.id, clientMessageId: dispatch.clientMessageId },
      });
      await this.refreshCatalog();
      return { snapshot, dispatch };
    });
  }

  async getDispatch(draftId: DraftId, dispatchId: string): Promise<Dispatch> {
    return this.withLock(draftId, async () => {
      const { containerRoot, draftRoot } = await this.locateDraft(draftId);
      const dispatchPath = path.join(draftRoot, "dispatches", `${dispatchId}.json`);
      await assertSafePath(containerRoot, dispatchPath);
      const dispatch = dispatchSchema.parse(await readJson(dispatchPath));
      if (dispatch.draftId !== draftId || dispatch.id !== dispatchId) throw new Error("Dispatch lineage mismatch");
      return dispatch;
    });
  }

  async markDispatchAttempt(draftId: DraftId, dispatchId: string): Promise<Dispatch> {
    return this.withLock(draftId, async () => {
      await this.ensureNoUnresolvedGeneration(draftId, "retry sending this draft");
      const { containerRoot, draftRoot } = await this.locateDraft(draftId);
      const dispatchPath = path.join(draftRoot, "dispatches", `${dispatchId}.json`);
      await assertSafePath(containerRoot, dispatchPath);
      const current = dispatchSchema.parse(await readJson(dispatchPath));
      if (current.draftId !== draftId || current.id !== dispatchId) throw new Error("Dispatch lineage mismatch");
      if (current.status === "accepted") return current;
      const meta = await this.readDraftMeta(draftRoot, containerRoot);
      if (meta.status === "archived") {
        throw new Error("Restore the archived draft before retrying a failed dispatch");
      }
      const next: Dispatch = {
        ...current,
        status: "pending",
        attemptCount: current.attemptCount + 1,
        updatedAt: this.timestamp(),
        error: null,
      };
      await writeJson(path.join(draftRoot, "dispatches", `${dispatchId}.json`), next, containerRoot);
      return dispatchSchema.parse(next);
    });
  }

  async finalizeDispatch(
    draftId: DraftId,
    dispatchId: string,
    result:
      | {
          status: "accepted";
          agentId: string;
          workspaceId: string | null;
          agentTitle: string | null;
          provider: string | null;
          userMessage: string;
          reconciled?: boolean;
        }
      | { status: "failed"; error: string; agentId?: string | null; workspaceId?: string | null },
  ): Promise<Dispatch> {
    return this.withLock(draftId, async () => {
      const { containerRoot, draftRoot } = await this.locateDraft(draftId);
      const meta = await this.readDraftMeta(draftRoot, containerRoot);
      const dispatchPath = path.join(draftRoot, "dispatches", `${dispatchId}.json`);
      await assertSafePath(containerRoot, dispatchPath);
      const current = dispatchSchema.parse(await readJson(dispatchPath));
      if (current.status === "accepted" && result.status === "failed") return current;
      const now = this.timestamp();
      const next: Dispatch = dispatchSchema.parse(
        result.status === "accepted"
          ? {
              ...current,
              status: "accepted",
              updatedAt: now,
              agentId: result.agentId,
              workspaceId: result.workspaceId,
              error: null,
              linkedSession: {
                agentId: result.agentId,
                workspaceId: result.workspaceId,
                agentTitle: result.agentTitle,
                provider: result.provider,
                userMessage: result.userMessage,
                acceptedAt: now,
              },
            }
          : {
              ...current,
              status: "failed",
              updatedAt: now,
              agentId: result.agentId ?? current.agentId,
              workspaceId: result.workspaceId ?? current.workspaceId,
              error: result.error,
              linkedSession: null,
            },
      );
      await writeJson(path.join(draftRoot, "dispatches", `${dispatchId}.json`), next, containerRoot);
      await this.writeDraftEvent(containerRoot, draftId, {
        type:
          result.status === "failed"
            ? "dispatch.failed"
            : result.reconciled
              ? "dispatch.reconciled"
              : "dispatch.accepted",
        containerId: meta.containerId,
        summary:
          result.status === "failed"
            ? `Dispatch failed: ${result.error}`
            : `${result.reconciled ? "Reconciled" : "Sent"} snapshot ${current.snapshotId} to agent ${result.agentId}`,
        actor: "plugin",
        details: { dispatchId, snapshotId: current.snapshotId, clientMessageId: current.clientMessageId },
      });
      await this.refreshCatalog();
      return next;
    });
  }

  private async readLegacyWorklogs(containerId: ContainerId): Promise<{ entries: TimelineEntry[]; warnings: string[] }> {
    const entries: TimelineEntry[] = [];
    const warnings: string[] = [];
    for (const worklogRoot of await this.vault.legacyWorklogRoots(containerId)) {
      let files: string[];
      try {
        files = await collectFiles(worklogRoot, (name) => name.endsWith(".md"), 3);
      } catch (error) {
        warnings.push(`${path.relative(this.rootPath, worklogRoot)}: ${formatError(error)}`);
        continue;
      }
      for (const filePath of files) {
        try {
          await assertSafePath(this.rootPath, filePath);
          const markdown = await readFile(filePath, "utf8");
          const blocks = markdown.split(/^## /m).slice(1);
          for (const block of blocks) {
            const [heading = "", ...body] = block.split(/\r?\n/);
            const match = /^(\S+)(?: · (dr_[a-f0-9]{16}))?$/.exec(heading.trim());
            if (!match) continue;
            entries.push({
              id: `worklog:${containerId}:${match[1]}`,
              at: new Date(match[1]).toISOString(),
              type: "worklog",
              containerId,
              draftId: (match[2] as DraftId | undefined) ?? null,
              title: "Historical worklog note",
              summary: body.join("\n").trim().slice(0, 240),
              agentId: null,
              dispatchId: null,
              snapshotId: null,
            });
          }
        } catch (error) {
          warnings.push(`${path.relative(this.rootPath, filePath)}: ${formatError(error)}`);
        }
      }
    }
    return { entries, warnings };
  }

  private async scanCanonical(reconcileDrafts: boolean): Promise<CatalogResult> {
    await this.initialize();
    const containers: ContainerSummary[] = [];
    const drafts: DraftSummary[] = [];
    const timeline: TimelineEntry[] = [];
    const warnings: string[] = [];
    let records: VaultContainerRecord[] = [];
    try {
      records = await this.vault.listContainers();
      for (const record of records) containers.push(await this.containerSummary(record));
    } catch (error) {
      warnings.push(`local/project-map.json: ${formatError(error)}`);
      try {
        const root = await this.vault.rootContainer();
        records = [root];
        containers.push(await this.containerSummary(root));
      } catch (rootError) {
        warnings.push(`companion.json: ${formatError(rootError)}`);
      }
    }
    for (const entry of await readdir(this.draftsPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^dr_[a-f0-9]{16}$/.test(entry.name)) continue;
      try {
        const detail = reconcileDrafts
          ? await this.withLock(entry.name, () => this.loadDraftUnlocked(entry.name as DraftId, true))
          : await this.loadDraftUnlocked(entry.name as DraftId, false);
        drafts.push(detail.summary);
        timeline.push(...buildDraftTimeline(detail));
        warnings.push(...detail.warnings);
      } catch (error) {
        warnings.push(`${path.relative(this.rootPath, path.join(this.draftsPath, entry.name))}: ${formatError(error)}`);
      }
    }
    for (const record of records) {
      const legacyWorklogs = await this.readLegacyWorklogs(record.manifest.id);
      timeline.push(...legacyWorklogs.entries);
      warnings.push(...legacyWorklogs.warnings);
    }
    warnings.push(...await this.vault.linkWarnings());
    containers.sort((left, right) => left.title.localeCompare(right.title));
    sortDraftSummaries(drafts);
    timeline.sort((left, right) => right.at.localeCompare(left.at));
    return { rootPath: this.rootPath, containers, drafts, tagTree: buildTagTree(drafts), timeline, warnings };
  }

  private async writeCatalogIndex(canonical: CatalogResult): Promise<void> {
    const catalog = {
      schemaVersion: 2,
      generatedAt: this.timestamp(),
      containers: canonical.containers.map((container) => ({
        id: container.id,
        title: container.title,
        containerType: container.containerType,
        sourcePathFingerprint: container.sourcePathFingerprint,
        updatedAt: container.updatedAt,
      })),
      drafts: canonical.drafts.map((draft) => ({
        id: draft.id,
        containerId: draft.containerId,
        title: draft.title,
        status: draft.status,
        tags: draft.tags,
        scope: draft.scope,
        contentHash: draft.contentHash,
        contentOrigin: draft.contentOrigin,
        updatedAt: draft.updatedAt,
      })),
      tagTree: canonical.tagTree,
    };
    await writeJson(path.join(this.rootPath, "catalog.json"), catalog, this.rootPath);
  }

  private async refreshCatalog(scan?: CatalogResult): Promise<CatalogResult> {
    const canonical = scan ?? (await this.scanCanonical(false));
    this.catalogCache = canonical;
    await this.writeCatalogIndex(canonical);
    return canonical;
  }

  private async updateCachedTagSummaries(summaries: readonly DraftSummary[]): Promise<TagTreeNode[]> {
    if (!this.catalogCache) {
      return (await this.refreshCatalog()).tagTree;
    }
    const changed = new Map(summaries.map((summary) => [summary.id, summary.tags] as const));
    const drafts = this.catalogCache.drafts.map((draft) => {
      const tags = changed.get(draft.id);
      return tags ? { ...draft, tags } : draft;
    });
    for (const summary of summaries) {
      if (!drafts.some((draft) => draft.id === summary.id)) drafts.push(summary);
    }
    sortDraftSummaries(drafts);
    const tagTree = buildTagTree(drafts);
    this.catalogCache = { ...this.catalogCache, drafts, tagTree };
    await this.writeCatalogIndex(this.catalogCache);
    return tagTree;
  }

  private async updateCachedAutosave(summary: DraftSummary, event: StudioEvent): Promise<void> {
    if (!this.catalogCache) return;
    const drafts = this.catalogCache.drafts.some((draft) => draft.id === summary.id)
      ? this.catalogCache.drafts.map((draft) => draft.id === summary.id ? summary : draft)
      : [...this.catalogCache.drafts, summary];
    sortDraftSummaries(drafts);
    const timeline = this.catalogCache.timeline
      .filter((entry) => entry.id !== `draft-update:${summary.id}`)
      .map((entry) => entry.draftId === summary.id
        ? {
            ...entry,
            containerId: summary.containerId,
            title: summary.title,
            summary: entry.id === `draft-created:${summary.id}` ? summary.preview : entry.summary,
          }
        : entry);
    timeline.push({
      id: `draft-update:${summary.id}`,
      at: event.at,
      type: "update",
      containerId: summary.containerId,
      draftId: summary.id,
      title: summary.title,
      summary: event.summary,
      agentId: null,
      dispatchId: null,
      snapshotId: null,
    });
    timeline.sort((left, right) => right.at.localeCompare(left.at));
    this.catalogCache = { ...this.catalogCache, drafts, timeline };
    await this.writeCatalogIndex(this.catalogCache);
  }

  private async updateCachedDraft(draft: DraftDetail, initialize: boolean): Promise<void> {
    if (!this.catalogCache) {
      if (initialize) await this.refreshCatalog();
      return;
    }
    const existing = this.catalogCache.drafts.find((item) => item.id === draft.summary.id);
    if (existing && JSON.stringify(existing) === JSON.stringify(draft.summary)) return;
    const drafts = this.catalogCache.drafts.some((item) => item.id === draft.summary.id)
      ? this.catalogCache.drafts.map((item) => item.id === draft.summary.id ? draft.summary : item)
      : [...this.catalogCache.drafts, draft.summary];
    sortDraftSummaries(drafts);
    const timeline = [
      ...this.catalogCache.timeline.filter((entry) => entry.draftId !== draft.summary.id),
      ...buildDraftTimeline(draft),
    ].sort((left, right) => right.at.localeCompare(left.at));
    this.catalogCache = {
      ...this.catalogCache,
      drafts,
      tagTree: buildTagTree(drafts),
      timeline,
      warnings: [...new Set([...this.catalogCache.warnings, ...draft.warnings])],
    };
    await this.writeCatalogIndex(this.catalogCache);
  }

  async scan(
    query = "",
    status: DraftSummary["status"] | readonly DraftSummary["status"][] | null = null,
    projectId: string | readonly string[] | null = null,
    rebuild = false,
    tagPaths: readonly string[] | null = null,
  ): Promise<CatalogResult> {
    return this.withLock("tags-global", async () => {
      await this.recoverTagMutationJournals();
      return this.withLock("catalog", async () => {
      const warnings: string[] = [];
      let canonical = this.catalogCache;
      if (rebuild || !canonical) {
        const catalogPath = path.join(this.rootPath, "catalog.json");
        if (await exists(catalogPath)) {
          try {
            await assertSafePath(this.rootPath, catalogPath);
            const raw = await readJson(catalogPath);
            if (!raw || typeof raw !== "object" || (raw as { schemaVersion?: unknown }).schemaVersion !== 2) {
              throw new Error("Expected disposable schema-v2 catalog");
            }
          } catch (error) {
            warnings.push(`catalog.json was ignored and rebuilt: ${formatError(error)}`);
          }
        }
        canonical = await this.scanCanonical(true);
        await this.refreshCatalog(canonical);
      }
      const statusFilter = status === null
        ? null
        : new Set(Array.isArray(status) ? status : [status]);
      const allStatusesSelected = statusFilter !== null
        && statusFilter.size === draftStatuses.length
        && draftStatuses.every((value) => statusFilter.has(value));
      const effectiveStatusFilter = statusFilter === null || allStatusesSelected ? null : statusFilter;
      const projectFilter = projectId === null
        ? null
        : new Set(Array.isArray(projectId) ? projectId : [projectId]);
      const normalizedTagPaths = tagPaths === null ? [] : normalizeTags(tagPaths);
      const tokens = searchTokens(query);
      const matchingDraftIds = new Set<string>();
      const matchingPreviews = new Map<string, string>();
      if (tokens.length) {
        for (const draft of canonical.drafts) {
          try {
            const located = await this.locateDraft(draft.id);
            const markdownPath = path.join(located.draftRoot, DRAFT_MARKDOWN_NAME);
            await assertSafePath(located.containerRoot, markdownPath);
            const markdown = await readFile(markdownPath, "utf8");
            const haystack = foldCaseInsensitive(
              `${draft.title}\n${draft.tags.join(" ")}\n${draft.scope.projectName ?? ""}\n${markdown}`,
            );
            if (tokens.every((token) => haystack.includes(token))) {
              matchingDraftIds.add(draft.id);
              matchingPreviews.set(draft.id, searchPreview(markdown, tokens));
            }
          } catch (error) {
            warnings.push(`${draft.id}: ${formatError(error)}`);
          }
        }
      }
      const tagCandidates = canonical.drafts.filter(
        (draft) =>
          (!tokens.length || matchingDraftIds.has(draft.id)) &&
          (effectiveStatusFilter === null || effectiveStatusFilter.has(draft.status)) &&
          (projectFilter === null || (draft.scope.projectId !== null && projectFilter.has(draft.scope.projectId))),
      ).map((draft) => ({ ...draft, preview: matchingPreviews.get(draft.id) ?? draft.preview }));
      const tagTree = buildTagTree(tagCandidates);
      const drafts = tagCandidates.filter((draft) => (
        !normalizedTagPaths.length || draft.tags.some((tag) => (
          normalizedTagPaths.some((selectedPath) => tagMatchesPath(tag, selectedPath))
        ))
      ));
      const ids = new Set(drafts.map((draft) => draft.id));
      let projectContainerIds = new Set<ContainerId>();
      if (projectFilter !== null && projectFilter.size) {
        try {
          projectContainerIds = await this.vault.containerIdsForProjects(projectFilter);
        } catch {
          // Canonical scan already reports malformed mapping warnings.
        }
      }
      const timeline = canonical.timeline.filter((entry) => {
        if (entry.draftId) return ids.has(entry.draftId);
        if (effectiveStatusFilter !== null) return false;
        if (projectFilter !== null && !projectContainerIds.has(entry.containerId)) return false;
        if (tokens.length) {
          const haystack = foldCaseInsensitive(`${entry.title}\n${entry.summary}`);
          return tokens.every((token) => haystack.includes(token));
        }
        return true;
      });
        return { ...canonical, drafts, tagTree, timeline, warnings: [...warnings, ...canonical.warnings] };
      });
    });
  }
}
