import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import {
  generationIdSchema,
  type DraftId,
} from "../../shared/contracts.shared";
import {
  generationJobRecordSchema,
  generationSettingsSchema,
  type GenerationJob,
  type GenerationJobRecord,
  type GenerationJobStatus,
  type GenerationProviderConfig,
  type GenerationSettings,
} from "../../shared/generation.shared";
import {
  assertSafePath,
  atomicWrite,
  exists,
  formatError,
  hash,
  processIsAlive,
  readJson,
  writeJson,
} from "./filesystem.server";

const META_NAME = "meta.json";
const REQUEST_NAME = "request.md";
const RESPONSE_NAME = "response.md";
const LOCK_STALE_MS = 30 * 60 * 1_000;
const LOCK_ATTEMPTS = 50;

interface LockParticipantState {
  schemaVersion: 1;
  token: string;
  pid: number;
  choosing: boolean;
  ticket: number | null;
  createdAt: string;
}

interface LockParticipantTicket {
  schemaVersion: 1;
  token: string;
  ticket: number;
}

interface LockParticipantSnapshot {
  token: string;
  choosing: boolean;
  ticket: number | null;
}

function lockParticipantPid(token: string): number | null {
  const match = /^lp_(\d+)_[a-f0-9]{32}$/.exec(token);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function parseLockParticipantState(value: unknown, expectedToken: string): LockParticipantState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<LockParticipantState>;
  if (
    candidate.schemaVersion !== 1
    || candidate.token !== expectedToken
    || !Number.isSafeInteger(candidate.pid)
    || (candidate.pid ?? 0) <= 0
    || typeof candidate.choosing !== "boolean"
    || (candidate.ticket !== null
      && (!Number.isSafeInteger(candidate.ticket) || (candidate.ticket ?? 0) <= 0))
    || typeof candidate.createdAt !== "string"
  ) return null;
  return candidate as LockParticipantState;
}

async function removeLockParticipant(
  rootPath: string,
  queuePath: string,
  participantPath: string,
): Promise<void> {
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      await assertSafePath(queuePath, participantPath);
      const info = await lstat(participantPath);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Unsafe Prompt Studio lock participant: ${participantPath}`);
      }
      await rm(participantPath, { recursive: true, force: true });
      await assertSafePath(rootPath, queuePath);
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code === "ENOENT") return;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 5 + attempt * 2));
    }
  }
  throw new Error(`Prompt Studio lock participant could not be released: ${participantPath}`);
}

async function assertLockPathOrMissing(boundaryPath: string, targetPath: string): Promise<boolean> {
  try {
    await assertSafePath(boundaryPath, targetPath);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "ENOENT") return false;
    throw error;
  }
}

async function readLockParticipant(
  rootPath: string,
  queuePath: string,
  token: string,
): Promise<LockParticipantSnapshot | null> {
  const participantPath = path.join(queuePath, token);
  if (!(await assertLockPathOrMissing(queuePath, participantPath))) return null;
  let info;
  try {
    info = await lstat(participantPath);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "ENOENT") return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Unsafe Prompt Studio lock participant: ${participantPath}`);
  }

  const encodedPid = lockParticipantPid(token);
  let state: LockParticipantState | null = null;
  const statePath = path.join(participantPath, "state.json");
  if (!(await assertLockPathOrMissing(rootPath, statePath))) return null;
  try {
    state = parseLockParticipantState(
      await readJson(statePath),
      token,
    );
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code !== "ENOENT") state = null;
  }
  const ownerPid = state?.pid ?? encodedPid;
  if (ownerPid !== null && !processIsAlive(ownerPid)) {
    await removeLockParticipant(rootPath, queuePath, participantPath);
    return null;
  }
  if (!state) {
    if (ownerPid === null && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
      await removeLockParticipant(rootPath, queuePath, participantPath);
      return null;
    }
    // A live participant may be between mkdir and its first atomic state write.
    // Treat it as choosing so no contender can pass it.
    return { token, choosing: true, ticket: null };
  }
  if (encodedPid !== null && encodedPid !== state.pid) {
    throw new Error(`Prompt Studio lock participant PID mismatch: ${participantPath}`);
  }
  const ticketPath = path.join(participantPath, "ticket.json");
  if (!(await assertLockPathOrMissing(rootPath, ticketPath))) return null;
  try {
    const ticketValue = await readJson(ticketPath) as Partial<LockParticipantTicket>;
    if (
      ticketValue.schemaVersion !== 1
      || ticketValue.token !== token
      || !Number.isSafeInteger(ticketValue.ticket)
      || (ticketValue.ticket ?? 0) <= 0
    ) {
      throw new Error(`Malformed Prompt Studio lock ticket: ${ticketPath}`);
    }
    return { token, choosing: false, ticket: ticketValue.ticket as number };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code !== "ENOENT") throw error;
    return { token, choosing: true, ticket: null };
  }
}

async function listLockParticipants(
  rootPath: string,
  queuePath: string,
): Promise<LockParticipantSnapshot[]> {
  await assertSafePath(rootPath, queuePath);
  const snapshots: LockParticipantSnapshot[] = [];
  for (const entry of await readdir(queuePath, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Unsafe Prompt Studio lock queue entry: ${path.join(queuePath, entry.name)}`);
    }
    const snapshot = await readLockParticipant(rootPath, queuePath, entry.name);
    if (snapshot) snapshots.push(snapshot);
  }
  return snapshots;
}

/**
 * A filesystem bakery lock. Every contender owns a never-reused participant
 * directory, so release and stale cleanup can only remove that contender's
 * path. No check-then-unlink operation targets the shared lock pathname.
 */
export async function acquireCrossProcessFileLock(
  rootPathInput: string,
  key: string,
  busyMessage: string,
): Promise<() => Promise<void>> {
  const rootPath = path.resolve(rootPathInput);
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "_");
  const locksRoot = path.join(rootPath, ".locks");
  const queuePath = path.join(locksRoot, `${safeKey}.queue-v2`);
  await mkdir(queuePath, { recursive: true });
  await assertSafePath(rootPath, queuePath);

  const token = `lp_${process.pid}_${randomUUID().replace(/-/g, "")}`;
  const participantPath = path.join(queuePath, token);
  await mkdir(participantPath);
  await assertSafePath(queuePath, participantPath);
  const createdAt = new Date().toISOString();
  const statePath = path.join(participantPath, "state.json");
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    await removeLockParticipant(rootPath, queuePath, participantPath);
    released = true;
  };

  try {
    await writeJson(statePath, {
      schemaVersion: 1,
      token,
      pid: process.pid,
      choosing: true,
      ticket: null,
      createdAt,
    } satisfies LockParticipantState, rootPath);
    const published = await listLockParticipants(rootPath, queuePath);
    const maxTicket = published.reduce(
      (maximum, participant) => Math.max(maximum, participant.ticket ?? 0),
      0,
    );
    if (maxTicket >= Number.MAX_SAFE_INTEGER) {
      throw new Error(`Prompt Studio lock ticket space is exhausted: ${key}`);
    }
    const ticket = maxTicket + 1;
    await writeJson(path.join(participantPath, "ticket.json"), {
      schemaVersion: 1,
      token,
      ticket,
    } satisfies LockParticipantTicket, rootPath);

    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      const participants = await listLockParticipants(rootPath, queuePath);
      const blocked = participants.some((participant) => {
        if (participant.token === token) return false;
        if (participant.choosing || participant.ticket === null) return true;
        return participant.ticket < ticket
          || (participant.ticket === ticket && participant.token.localeCompare(token) < 0);
      });
      if (!blocked) return release;
      await new Promise((resolve) => setTimeout(resolve, 20 + attempt * 4));
    }
    throw new Error(busyMessage);
  } catch (error) {
    await release();
    throw error;
  }
}

const terminalStatuses = new Set<GenerationJobStatus>([
  "applied",
  "failed",
  "discarded",
  "abandoned",
]);

const transitions: Record<GenerationJobStatus, ReadonlySet<GenerationJobStatus>> = {
  prepared: new Set(["launching", "running", "failed", "abandoned"]),
  launching: new Set(["running", "result-ready", "needs-attention", "failed", "abandoned"]),
  running: new Set(["result-ready", "needs-attention", "failed", "abandoned"]),
  "result-ready": new Set(["applied", "conflict", "discarded", "failed"]),
  applied: new Set(),
  conflict: new Set(["applied", "discarded"]),
  "needs-attention": new Set(["running", "result-ready", "failed", "abandoned"]),
  failed: new Set(),
  discarded: new Set(),
  abandoned: new Set(),
};

export interface GenerationRepositoryOptions {
  now?: () => Date;
}

export interface ListGenerationJobsResult {
  values: GenerationJob[];
  warnings: string[];
}

export interface AppliedGenerationFields {
  checkpointId: GenerationJobRecord["checkpointId"];
  appliedVersion: number;
  appliedHash: string;
}

export interface ClaimGenerationLaunchResult {
  job: GenerationJob;
  claimed: boolean;
}

function frozenJobFields(job: GenerationJobRecord): string {
  return JSON.stringify({
    schemaVersion: job.schemaVersion,
    id: job.id,
    draftId: job.draftId,
    task: job.task,
    baseVersion: job.baseVersion,
    baseHash: job.baseHash,
    locale: job.locale,
    allowProjectRead: job.allowProjectRead,
    filters: job.filters,
    configuration: job.configuration,
    project: job.project,
    counts: job.counts,
    includedSources: job.includedSources,
    protection: job.protection,
    requestId: job.requestId,
    clientMessageId: job.clientMessageId,
    requestHash: job.requestHash,
    createdAt: job.createdAt,
  });
}

function isTerminal(status: GenerationJobStatus): boolean {
  return terminalStatuses.has(status);
}

export class GenerationRepository {
  readonly rootPath: string;
  private readonly now: () => Date;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(rootPath: string, options: GenerationRepositoryOptions = {}) {
    this.rootPath = path.resolve(rootPath);
    this.now = options.now ?? (() => new Date());
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private draftRoot(draftId: DraftId): string {
    return path.join(this.rootPath, "drafts", draftId);
  }

  private generationsRoot(draftId: DraftId): string {
    return path.join(this.draftRoot(draftId), "generations");
  }

  private generationRoot(draftId: DraftId, generationId: string): string {
    return path.join(this.generationsRoot(draftId), generationIdSchema.parse(generationId));
  }

  private async acquireFileLock(key: string): Promise<() => Promise<void>> {
    return acquireCrossProcessFileLock(
      this.rootPath,
      key,
      `Prompt Studio generation resource is busy: ${key}`,
    );
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
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

  private async ensureDraftBoundary(draftId: DraftId): Promise<string> {
    const draftRoot = this.draftRoot(draftId);
    await assertSafePath(this.rootPath, draftRoot);
    const info = await lstat(draftRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Unsafe or missing Prompt Studio draft boundary: ${draftId}`);
    }
    return draftRoot;
  }

  private async readRecordUnlocked(draftId: DraftId, generationId: string): Promise<GenerationJobRecord> {
    const generationRoot = this.generationRoot(draftId, generationId);
    await assertSafePath(this.rootPath, generationRoot);
    const info = await lstat(generationRoot);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Unsafe Prompt Studio generation boundary: ${generationId}`);
    }
    const metaPath = path.join(generationRoot, META_NAME);
    await assertSafePath(this.rootPath, metaPath);
    const record = generationJobRecordSchema.parse(await readJson(metaPath));
    if (record.id !== generationId || record.draftId !== draftId) {
      throw new Error(`Generation lineage mismatch: ${generationId}`);
    }
    return record;
  }

  private async hydrateUnlocked(record: GenerationJobRecord): Promise<GenerationJob> {
    let responseMarkdown: string | null = null;
    if (record.responseHash !== null) {
      const responsePath = path.join(this.generationRoot(record.draftId, record.id), RESPONSE_NAME);
      await assertSafePath(this.rootPath, responsePath);
      responseMarkdown = await readFile(responsePath, "utf8");
      if (hash(responseMarkdown) !== record.responseHash) {
        throw new Error(`Generation response hash mismatch: ${record.id}`);
      }
    }
    return { ...record, responseMarkdown };
  }

  private async listUnlocked(draftId: DraftId): Promise<ListGenerationJobsResult> {
    const generationsRoot = this.generationsRoot(draftId);
    if (!(await exists(generationsRoot))) return { values: [], warnings: [] };
    await assertSafePath(this.rootPath, generationsRoot);
    const values: GenerationJob[] = [];
    const warnings: string[] = [];
    for (const entry of await readdir(generationsRoot, { withFileTypes: true })) {
      if (!entry.name.startsWith("gn_")) continue;
      const entryPath = path.join(generationsRoot, entry.name);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        warnings.push(`${path.relative(this.rootPath, entryPath)}: unsafe generation entry was ignored`);
        continue;
      }
      try {
        values.push(await this.hydrateUnlocked(await this.readRecordUnlocked(draftId, entry.name)));
      } catch (error) {
        warnings.push(`${path.relative(this.rootPath, entryPath)}: ${formatError(error)}`);
      }
    }
    values.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
    return { values, warnings };
  }

  async create(recordInput: GenerationJobRecord, requestMarkdown: string): Promise<GenerationJob> {
    const record = generationJobRecordSchema.parse(recordInput);
    if (record.status !== "prepared") throw new Error("A generation must be created in prepared status");
    if (record.requestHash !== hash(requestMarkdown)) throw new Error("Generation request hash mismatch");
    return this.withLock(`generation-${record.draftId}`, async () => {
      await this.ensureDraftBoundary(record.draftId);
      const existing = await this.listUnlocked(record.draftId);
      if (existing.warnings.length) {
        throw new Error(`Generation lineage must be repaired before starting: ${existing.warnings.join("; ")}`);
      }
      const unresolved = existing.values.find((value) => !isTerminal(value.status));
      if (unresolved) return unresolved;

      const generationsRoot = this.generationsRoot(record.draftId);
      await mkdir(generationsRoot, { recursive: true });
      await assertSafePath(this.rootPath, generationsRoot);
      const targetRoot = this.generationRoot(record.draftId, record.id);
      if (await exists(targetRoot)) throw new Error(`Generation already exists: ${record.id}`);
      const temporaryRoot = path.join(generationsRoot, `.preparing-${record.id}-${randomUUID()}`);
      await mkdir(temporaryRoot);
      try {
        await atomicWrite(path.join(temporaryRoot, REQUEST_NAME), requestMarkdown, this.rootPath);
        await writeJson(path.join(temporaryRoot, META_NAME), record, this.rootPath);
        await assertSafePath(this.rootPath, targetRoot);
        await rename(temporaryRoot, targetRoot);
      } catch (error) {
        await assertSafePath(this.rootPath, temporaryRoot);
        await rm(temporaryRoot, { recursive: true, force: true });
        throw error;
      }
      return { ...record, responseMarkdown: null };
    });
  }

  async list(draftId: DraftId): Promise<ListGenerationJobsResult> {
    await this.ensureDraftBoundary(draftId);
    return this.listUnlocked(draftId);
  }

  async get(draftId: DraftId, generationId: string): Promise<GenerationJob> {
    await this.ensureDraftBoundary(draftId);
    return this.hydrateUnlocked(await this.readRecordUnlocked(draftId, generationId));
  }

  async findUnresolved(draftId: DraftId): Promise<GenerationJob | null> {
    const listed = await this.list(draftId);
    if (listed.warnings.length) {
      throw new Error(`Generation lineage must be repaired: ${listed.warnings.join("; ")}`);
    }
    return listed.values.find((value) => !isTerminal(value.status)) ?? null;
  }

  async withSettingsLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.withLock("generation-settings", operation);
  }

  async getRequest(draftId: DraftId, generationId: string): Promise<string> {
    const record = await this.readRecordUnlocked(draftId, generationId);
    const requestPath = path.join(this.generationRoot(draftId, generationId), REQUEST_NAME);
    await assertSafePath(this.rootPath, requestPath);
    const request = await readFile(requestPath, "utf8");
    if (hash(request) !== record.requestHash) throw new Error(`Generation request hash mismatch: ${generationId}`);
    return request;
  }

  async update(
    draftId: DraftId,
    generationId: string,
    mutate: (current: GenerationJobRecord) => GenerationJobRecord,
  ): Promise<GenerationJob> {
    return this.withLock(`generation-${draftId}`, async () => {
      const current = await this.readRecordUnlocked(draftId, generationId);
      const next = generationJobRecordSchema.parse(mutate(current));
      if (frozenJobFields(next) !== frozenJobFields(current)) {
        throw new Error(`Immutable generation request fields changed: ${generationId}`);
      }
      if (next.status !== current.status && !transitions[current.status].has(next.status)) {
        throw new Error(`Invalid generation transition: ${current.status} -> ${next.status}`);
      }
      if (JSON.stringify(next) === JSON.stringify(current)) return this.hydrateUnlocked(current);
      await writeJson(path.join(this.generationRoot(draftId, generationId), META_NAME), next, this.rootPath);
      return this.hydrateUnlocked(next);
    });
  }

  async transition(
    draftId: DraftId,
    generationId: string,
    status: GenerationJobStatus,
    fields: Partial<Pick<GenerationJobRecord, "agentId" | "error">> = {},
  ): Promise<GenerationJob> {
    return this.update(draftId, generationId, (current) => {
      if (current.status === status && isTerminal(status)) return current;
      const at = this.timestamp();
      return {
        ...current,
        ...fields,
        status,
        updatedAt: at,
        completedAt: isTerminal(status) ? at : null,
      };
    });
  }

  /**
   * Atomically claims the only transition that authorizes Agent creation.
   * Retries observing launching/running never receive a second claim.
   */
  async claimLaunch(draftId: DraftId, generationId: string): Promise<ClaimGenerationLaunchResult> {
    return this.withLock(`generation-${draftId}`, async () => {
      const current = await this.readRecordUnlocked(draftId, generationId);
      if (current.status === "launching" || current.status === "running") {
        return { job: await this.hydrateUnlocked(current), claimed: false };
      }
      if (current.status !== "prepared") {
        throw new Error(`Cannot claim Agent launch while generation is ${current.status}`);
      }
      const next = generationJobRecordSchema.parse({
        ...current,
        status: "launching",
        updatedAt: this.timestamp(),
      });
      await writeJson(path.join(this.generationRoot(draftId, generationId), META_NAME), next, this.rootPath);
      return { job: await this.hydrateUnlocked(next), claimed: true };
    });
  }

  async markRunning(draftId: DraftId, generationId: string, agentId: string): Promise<GenerationJob> {
    return this.transition(draftId, generationId, "running", { agentId, error: null });
  }

  async markNeedsAttention(
    draftId: DraftId,
    generationId: string,
    error: string,
    agentId?: string | null,
  ): Promise<GenerationJob> {
    return this.transition(draftId, generationId, "needs-attention", {
      error,
      ...(agentId === undefined ? {} : { agentId }),
    });
  }

  async markFailed(
    draftId: DraftId,
    generationId: string,
    error: string,
    agentId?: string | null,
  ): Promise<GenerationJob> {
    return this.transition(draftId, generationId, "failed", {
      error,
      ...(agentId === undefined ? {} : { agentId }),
    });
  }

  async setArchiveWarning(draftId: DraftId, generationId: string, warning: string): Promise<GenerationJob> {
    return this.update(draftId, generationId, (current) => ({
      ...current,
      archiveWarning: warning,
      updatedAt: this.timestamp(),
    }));
  }

  async captureResponse(
    draftId: DraftId,
    generationId: string,
    responseMarkdown: string,
    agentId: string | null,
  ): Promise<GenerationJob> {
    if (!responseMarkdown.trim()) throw new Error("Generation Agent returned an empty response");
    return this.withLock(`generation-${draftId}`, async () => {
      const current = await this.readRecordUnlocked(draftId, generationId);
      if (current.responseHash !== null) {
        const hydrated = await this.hydrateUnlocked(current);
        if (hydrated.responseMarkdown !== responseMarkdown) {
          throw new Error(`Generation response was already captured with different content: ${generationId}`);
        }
        return hydrated;
      }
      if (current.status !== "launching" && current.status !== "running" && current.status !== "needs-attention") {
        throw new Error(`Cannot capture a response while generation is ${current.status}`);
      }
      const responsePath = path.join(this.generationRoot(draftId, generationId), RESPONSE_NAME);
      if (await exists(responsePath)) {
        await assertSafePath(this.rootPath, responsePath);
        const existing = await readFile(responsePath, "utf8");
        if (existing !== responseMarkdown) {
          throw new Error(`Uncommitted generation response conflicts with the Agent response: ${generationId}`);
        }
      } else {
        await atomicWrite(responsePath, responseMarkdown, this.rootPath);
      }
      const at = this.timestamp();
      const next = generationJobRecordSchema.parse({
        ...current,
        status: "result-ready",
        responseHash: hash(responseMarkdown),
        responseCapturedAt: at,
        agentId: agentId ?? current.agentId,
        error: null,
        updatedAt: at,
      });
      await writeJson(path.join(this.generationRoot(draftId, generationId), META_NAME), next, this.rootPath);
      return { ...next, responseMarkdown };
    });
  }

  async markApplied(
    draftId: DraftId,
    generationId: string,
    fields: AppliedGenerationFields,
  ): Promise<GenerationJob> {
    return this.update(draftId, generationId, (current) => {
      if (current.responseHash === null) throw new Error("Cannot apply a generation without a captured response");
      if (current.status === "applied") {
        if (
          current.checkpointId === fields.checkpointId
          && current.appliedVersion === fields.appliedVersion
          && current.appliedHash === fields.appliedHash
        ) return current;
        throw new Error(`Generation was already applied with different revision metadata: ${generationId}`);
      }
      const at = this.timestamp();
      return {
        ...current,
        status: "applied",
        checkpointId: fields.checkpointId,
        appliedVersion: fields.appliedVersion,
        appliedHash: fields.appliedHash,
        error: null,
        updatedAt: at,
        completedAt: at,
      };
    });
  }

  async markConflict(draftId: DraftId, generationId: string, error: string): Promise<GenerationJob> {
    return this.transition(draftId, generationId, "conflict", { error });
  }

  async discard(draftId: DraftId, generationId: string): Promise<GenerationJob> {
    return this.transition(draftId, generationId, "discarded", { error: null });
  }

  async abandon(draftId: DraftId, generationId: string): Promise<GenerationJob> {
    return this.transition(draftId, generationId, "abandoned", { error: null });
  }
}

export class GenerationSettingsRepository {
  readonly rootPath: string;
  private readonly jobs: GenerationRepository;
  private readonly now: () => Date;

  constructor(rootPath: string, options: GenerationRepositoryOptions = {}) {
    this.rootPath = path.resolve(rootPath);
    this.now = options.now ?? (() => new Date());
    this.jobs = new GenerationRepository(this.rootPath, options);
  }

  private settingsPath(): string {
    return path.join(this.rootPath, "local", "generation-settings.json");
  }

  private defaultSettings(): GenerationSettings {
    return {
      schemaVersion: 1,
      version: 1,
      related: null,
      format: null,
      updatedAt: this.now().toISOString(),
    };
  }

  async get(): Promise<GenerationSettings> {
    const settingsPath = this.settingsPath();
    if (!(await exists(settingsPath))) return this.defaultSettings();
    await assertSafePath(this.rootPath, settingsPath);
    return generationSettingsSchema.parse(await readJson(settingsPath));
  }

  async update(input: {
    expectedVersion: number;
    related: GenerationProviderConfig | null;
    format: GenerationProviderConfig | null;
  }): Promise<GenerationSettings> {
    return this.jobs.withSettingsLock(async () => {
      const current = await this.get();
      if (current.version !== input.expectedVersion) {
        throw new Error(
          `Generation settings changed since they were opened (current version ${current.version}). Reload before saving.`,
        );
      }
      const next = generationSettingsSchema.parse({
        schemaVersion: 1,
        version: current.version + 1,
        related: input.related,
        format: input.format,
        updatedAt: this.now().toISOString(),
      });
      await writeJson(this.settingsPath(), next, this.rootPath);
      return next;
    });
  }
}
