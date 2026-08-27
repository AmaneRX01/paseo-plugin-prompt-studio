import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Module from "node:module";
import test from "node:test";
import type {
  GenerationAgentHandle,
  GenerationAgentSnapshot,
  GenerationPaseo,
  GenerationPreparationContext,
  GenerationRunResult,
  GenerationRuntimeStore,
  GenerationStartInput,
  GenerationWorkspaceHandle,
} from "../src/server/generation-coordinator.server";
import { buildGenerationAgentPolicy } from "../src/server/generation-provider-policy.server";
import type {
  GenerationJob,
  GenerationPreview,
  GenerationProviderConfig,
  GenerationTask,
} from "../src/shared/generation.shared";

const moduleInternals = Module as unknown as {
  _resolveFilename(request: string, parent: unknown, isMain: boolean, options: unknown): string;
};
const originalResolveFilename = moduleInternals._resolveFilename;
moduleInternals._resolveFilename = function resolveTestVirtualModule(request, parent, isMain, options) {
  if (request === "@getpaseo/plugin/server") return path.join(import.meta.dirname, "plugin-server.stub.cjs");
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

let createGenerationCoordinator: typeof import("../src/server/generation-coordinator.server").createGenerationCoordinator;
test.before(async () => {
  ({ createGenerationCoordinator } = await import("../src/server/generation-coordinator.server"));
});

const DRAFT_ID = `dr_${"a".repeat(16)}`;
const GENERATION_ID = `gn_${"b".repeat(24)}`;
const PROJECT_ID = "prj_external";
const WORKSPACE_ID = "wks_source";
const REPLACEMENT_WORKSPACE_ID = "wks_source_replacement";
const ROOT_WORKSPACE_ID = "wks_root";

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function startInput(overrides: Partial<GenerationStartInput> = {}): GenerationStartInput {
  return {
    draftId: DRAFT_ID,
    generationId: null,
    expectedVersion: 1,
    expectedHash: digest("target"),
    task: "related",
    locale: "en",
    allowProjectRead: false,
    filters: {
      includeHistory: true,
      timeRange: "90d",
      tagPaths: [],
      crossProject: false,
      projectIds: [],
      includeInbox: false,
    },
    ...overrides,
  };
}

function counts() {
  return {
    eligibleOtherPromptCount: 2,
    includedOtherPromptCount: 1,
    eligibleReferenceVersionCount: 3,
    includedReferenceVersionCount: 2,
    eligibleTargetHistoryVersionCount: 1,
    includedTargetHistoryVersionCount: 1,
    truncated: true,
    estimatedInputTokens: 500,
    inputTokenBudget: 16_000,
  };
}

function makeJob(input: GenerationStartInput, context: GenerationPreparationContext): GenerationJob {
  const now = "2026-08-26T00:00:00.000Z";
  const request = "frozen generation request";
  return {
    schemaVersion: 1,
    id: GENERATION_ID,
    draftId: input.draftId,
    task: input.task,
    status: "prepared",
    baseVersion: input.expectedVersion,
    baseHash: input.expectedHash,
    locale: input.locale,
    allowProjectRead: input.allowProjectRead,
    filters: input.filters,
    configuration: context.configuration,
    project: context.project,
    counts: counts(),
    includedSources: [],
    protection: context.protection,
    requestId: `prompt-studio:generation:${GENERATION_ID}:create`,
    clientMessageId: `prompt-studio:generation:${GENERATION_ID}:message`,
    requestHash: digest(request),
    responseHash: null,
    responseCapturedAt: null,
    responseMarkdown: null,
    agentId: null,
    checkpointId: null,
    appliedVersion: null,
    appliedHash: null,
    error: null,
    archiveWarning: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}

class FakeStore implements GenerationRuntimeStore {
  job: GenerationJob | null = null;
  refreshedSource: { projectId: string; workspaceId: string; rootPath: string; name: string } | null = null;
  hideUnresolvedOnce = false;
  configuration: GenerationProviderConfig = {
    provider: "codex",
    model: "gpt-5.5",
    thinkingOptionId: "high",
  };

  constructor(readonly rootPath: string, readonly calls: string[] = []) {}

  async isManagedPath(candidatePath: string): Promise<boolean> {
    const relative = path.relative(this.rootPath, candidatePath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  async getGenerationProviderConfig(_task: GenerationTask): Promise<GenerationProviderConfig> {
    return this.configuration;
  }

  async getGenerationProject(_draftId: string) {
    return { projectId: PROJECT_ID, projectName: "Example", workspaceId: WORKSPACE_ID };
  }

  async refreshGenerationProjectLocator(source: {
    projectId: string;
    workspaceId: string;
    rootPath: string;
    name: string;
  }): Promise<void> {
    this.refreshedSource = source;
  }

  async findUnresolvedGeneration(_draftId: string): Promise<GenerationJob | null> {
    if (this.hideUnresolvedOnce) {
      this.hideUnresolvedOnce = false;
      return null;
    }
    if (!this.job || ["applied", "failed", "discarded", "abandoned"].includes(this.job.status)) return null;
    return this.job;
  }

  async previewGeneration(
    input: Parameters<GenerationRuntimeStore["previewGeneration"]>[0],
    context: GenerationPreparationContext,
  ): Promise<GenerationPreview> {
    return {
      draftId: input.draftId,
      task: input.task,
      project: context.project,
      configuration: context.configuration,
      counts: counts(),
      protection: context.protection,
    };
  }

  async prepareGeneration(
    input: GenerationStartInput,
    context: GenerationPreparationContext,
  ): Promise<GenerationJob> {
    this.calls.push("prepare");
    this.job ??= makeJob(input, context);
    return this.job;
  }

  async getGeneration(_draftId: string, generationId: string): Promise<GenerationJob> {
    assert.equal(generationId, GENERATION_ID);
    if (!this.job) throw new Error("missing generation");
    return this.job;
  }

  async getGenerationPrompt() {
    return {
      requestMarkdown: "frozen generation request",
      systemPrompt: "return only the rewritten prompt",
      agentTitle: "Prompt Studio · Optimize · Example",
    };
  }

  async claimGenerationLaunch(): Promise<{ job: GenerationJob; claimed: boolean }> {
    this.calls.push("claim");
    if (!this.job) throw new Error("missing generation");
    if (this.job.status !== "prepared") return { job: this.job, claimed: false };
    this.job = { ...this.job, status: "launching" };
    return { job: this.job, claimed: true };
  }

  async markGenerationRunning(
    _draftId: string,
    _generationId: string,
    agentId: string,
  ): Promise<GenerationJob> {
    this.calls.push("running");
    if (!this.job) throw new Error("missing generation");
    this.job = { ...this.job, status: "running", agentId, error: null };
    return this.job;
  }

  async markGenerationNeedsAttention(
    _draftId: string,
    _generationId: string,
    error: string,
    agentId?: string | null,
  ): Promise<GenerationJob> {
    this.calls.push("needs-attention");
    if (!this.job) throw new Error("missing generation");
    this.job = { ...this.job, status: "needs-attention", error, agentId: agentId ?? this.job.agentId };
    return this.job;
  }

  async markGenerationFailed(
    _draftId: string,
    _generationId: string,
    error: string,
    agentId?: string | null,
  ): Promise<GenerationJob> {
    this.calls.push("failed");
    if (!this.job) throw new Error("missing generation");
    this.job = { ...this.job, status: "failed", error, agentId: agentId ?? this.job.agentId };
    return this.job;
  }

  async commitGenerationResponse(input: {
    responseMarkdown: string;
    agentId: string;
  } & Record<string, unknown>) {
    this.calls.push(`commit:${input.responseMarkdown}`);
    if (!this.job) throw new Error("missing generation");
    this.job = {
      ...this.job,
      status: "applied",
      responseMarkdown: input.responseMarkdown,
      responseHash: digest(input.responseMarkdown),
      responseCapturedAt: "2026-08-26T00:01:00.000Z",
      agentId: input.agentId,
      checkpointId: `cp_${"c".repeat(24)}`,
      appliedVersion: 2,
      appliedHash: digest(input.responseMarkdown),
    };
    return { job: this.job, draft: null };
  }

  async applyGenerationCandidate(): Promise<{ job: GenerationJob; draft: null }> {
    this.calls.push("apply-candidate");
    if (!this.job) throw new Error("missing generation");
    this.job = { ...this.job, status: "applied" };
    return { job: this.job, draft: null };
  }

  async discardGeneration(): Promise<GenerationJob> {
    this.calls.push("discard");
    if (!this.job) throw new Error("missing generation");
    this.job = { ...this.job, status: "discarded" };
    return this.job;
  }

  async abandonGeneration(): Promise<GenerationJob> {
    this.calls.push("abandon");
    if (!this.job) throw new Error("missing generation");
    this.job = { ...this.job, status: "abandoned" };
    return this.job;
  }

  async recordGenerationArchiveWarning(
    _draftId: string,
    _generationId: string,
    warning: string,
  ): Promise<GenerationJob> {
    if (!this.job) throw new Error("missing generation");
    this.job = { ...this.job, archiveWarning: warning };
    return this.job;
  }
}

class FakeAgent implements GenerationAgentHandle {
  archived = false;
  result: GenerationRunResult = {
    status: "timeout",
    error: null,
    lastMessage: null,
  };

  constructor(
    readonly id: string,
    readonly cwd: string,
    readonly labels: Record<string, string>,
    private readonly calls: string[],
  ) {}

  snapshot(): GenerationAgentSnapshot {
    return {
      id: this.id,
      cwd: this.cwd,
      workspaceId: ROOT_WORKSPACE_ID,
      status: this.result.status === "timeout" ? "running" : "idle",
      labels: this.labels,
      archivedAt: this.archived ? "2026-08-26T00:02:00.000Z" : null,
    };
  }

  async refresh() {
    return { agent: this.snapshot() };
  }

  async waitForFinish(timeoutMs?: number) {
    assert.ok((timeoutMs ?? 0) <= 250, "sync RPC must not perform a long wait");
    return this.result;
  }

  async archive() {
    this.calls.push("archive");
    this.archived = true;
    return { archivedAt: "2026-08-26T00:02:00.000Z" };
  }
}

class FakePaseo implements GenerationPaseo {
  readonly agentMap = new Map<string, FakeAgent>();
  createCount = 0;
  agentListCount = 0;
  sourceWorkspaceAvailable = true;
  replacementWorkspaceAvailable = false;
  createBehavior: "success" | "throw" | "accept-then-throw" = "success";
  createdOptions: Parameters<GenerationWorkspaceHandle["agents"]["create"]>[0] | null = null;

  constructor(readonly projectRoot: string, readonly calls: string[] = []) {}

  private workspace(id: string): GenerationWorkspaceHandle {
    return {
      id,
      projectId: PROJECT_ID,
      refresh: async () => (
        id === WORKSPACE_ID && !this.sourceWorkspaceAvailable
          ? null
          : {
              id,
              projectId: PROJECT_ID,
              projectDisplayName: "Example",
              projectRootPath: this.projectRoot,
              workspaceDirectory: id === ROOT_WORKSPACE_ID ? this.projectRoot : undefined,
            }
      ),
      agents: {
        create: async (options) => {
          this.calls.push("create");
          this.createCount += 1;
          this.createdOptions = options;
          if (this.createBehavior === "throw") throw new Error("connection reset");
          const agent = new FakeAgent(`agt_${this.createCount}`, this.projectRoot, options.labels, this.calls);
          this.agentMap.set(agent.id, agent);
          if (this.createBehavior === "accept-then-throw") throw new Error("acknowledgement lost");
          return agent;
        },
      },
    };
  }

  readonly workspaces = {
    ref: (workspaceId: string) => this.workspace(workspaceId),
    open: async (_root: string) => this.workspace(ROOT_WORKSPACE_ID),
    list: async () => ({
      entries: this.replacementWorkspaceAvailable
        ? [{ id: REPLACEMENT_WORKSPACE_ID, projectId: PROJECT_ID }]
        : [],
      pageInfo: { nextCursor: null, hasMore: false },
    }),
  };

  readonly agents = {
    ref: (agentId: string) => {
      const agent = this.agentMap.get(agentId);
      if (!agent) {
        return {
          id: agentId,
          refresh: async () => null,
          waitForFinish: async () => ({ status: "error" as const, error: "missing", lastMessage: null }),
          archive: async () => ({ archivedAt: "2026-08-26T00:02:00.000Z" }),
        };
      }
      return agent;
    },
    list: async () => {
      this.agentListCount += 1;
      return {
        entries: [...this.agentMap.values()].map((agent) => ({ agent: agent.snapshot() })),
        pageInfo: { nextCursor: null, hasMore: false },
      };
    },
  };

  readonly providers = {
    listAvailable: async () => ({
      providers: [{ provider: "codex", available: true }],
      error: null,
    }),
    listModels: async (provider: string) => ({
      provider,
      models: [{
        id: "gpt-5.5",
        isSelectable: true,
        contextWindowMaxTokens: 128_000,
        thinkingOptions: [{ id: "high" }],
      }],
      error: null,
    }),
  };
}

async function fixture(t: test.TestContext) {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "prompt-studio-generation-vault-"));
  const projectRoot = await mkdtemp(path.join(tmpdir(), "prompt-studio-generation-project-"));
  t.after(() => Promise.all([
    rm(vaultRoot, { recursive: true, force: true }),
    rm(projectRoot, { recursive: true, force: true }),
  ]));
  const calls: string[] = [];
  const store = new FakeStore(vaultRoot, calls);
  const paseo = new FakePaseo(projectRoot, calls);
  return { store, paseo, coordinator: createGenerationCoordinator(store, paseo) };
}

function seedPreparedJob(
  store: FakeStore,
  paseo: FakePaseo,
  input: GenerationStartInput = startInput(),
): GenerationJob {
  const protection = buildGenerationAgentPolicy({
    selection: store.configuration,
    allowProjectRead: input.allowProjectRead,
    projectRoot: paseo.projectRoot,
    vaultRoot: store.rootPath,
    systemPrompt: "return only the rewritten prompt",
  }).protection;
  const job = makeJob(input, {
    configuration: store.configuration,
    project: { projectId: PROJECT_ID, projectName: "Example", workspaceId: WORKSPACE_ID },
    projectRoot: paseo.projectRoot,
    contextWindowMaxTokens: 128_000,
    protection,
  });
  store.job = job;
  return job;
}

test("provider policies force unattended read-only controls without verbose warnings", () => {
  const codex = buildGenerationAgentPolicy({
    selection: { provider: "codex", model: "gpt-5.5", thinkingOptionId: null },
    allowProjectRead: true,
    projectRoot: "D:\\project",
    vaultRoot: "D:\\vault",
    systemPrompt: "system",
  });
  assert.deepEqual(codex.config.options, {
    approval_policy: "never",
    sandbox_mode: "read-only",
    web_search: "disabled",
    features: {
      multi_agent_v2: false,
      network_proxy: false,
    },
  });
  assert.equal(codex.protection.level, "behavioral-only");
  assert.equal(codex.protection.warning, null);

  const kimiNoRead = buildGenerationAgentPolicy({
    selection: { provider: "kimi", model: "kimi-for-coding", thinkingOptionId: null },
    allowProjectRead: false,
    projectRoot: "D:\\project",
    vaultRoot: "D:\\vault",
    systemPrompt: "system",
  });
  assert.equal(kimiNoRead.config.modeId, "plan");
  assert.equal(kimiNoRead.protection.level, "native-policy");
  const kimiRead = buildGenerationAgentPolicy({
    selection: { provider: "kimi", model: "kimi-for-coding", thinkingOptionId: null },
    allowProjectRead: true,
    projectRoot: "D:\\project",
    vaultRoot: "D:\\vault",
    systemPrompt: "system",
  });
  assert.equal(kimiRead.config.modeId, "default");
  assert.equal(kimiRead.protection.level, "behavioral-only");
  assert.equal(kimiRead.protection.warning, null);

  const claude = buildGenerationAgentPolicy({
    selection: { provider: "claude", model: "claude-sonnet-5", thinkingOptionId: null },
    allowProjectRead: true,
    projectRoot: "/project",
    vaultRoot: "/vault",
    systemPrompt: "system",
  });
  assert.deepEqual(claude.config.options?.allowedTools, ["Read", "Glob", "Grep"]);
  assert.equal(
    (claude.config.options?.sandbox as { failIfUnavailable?: unknown }).failIfUnavailable,
    true,
  );
  assert.ok((claude.config.options?.disallowedTools as string[]).includes("Task"));
  assert.equal(claude.protection.level, "behavioral-only");
  assert.equal(claude.protection.warning, null);

  const opencode = buildGenerationAgentPolicy({
    selection: { provider: "opencode", model: "openai/gpt-5.5", thinkingOptionId: null },
    allowProjectRead: false,
    projectRoot: "/project",
    vaultRoot: "/vault",
    systemPrompt: "system",
  });
  assert.deepEqual(opencode.config.options, { permission: "deny" });
  assert.equal(opencode.protection.level, "native-policy");

  const unknown = buildGenerationAgentPolicy({
    selection: { provider: "custom-acp", model: "model", thinkingOptionId: null },
    allowProjectRead: false,
    projectRoot: "/project",
    vaultRoot: "/vault",
    systemPrompt: "system",
  });
  assert.equal(unknown.protection.level, "behavioral-only");
  assert.equal(unknown.protection.warning, null);
});

test("start persists and claims a job before one Agent create with stable safety metadata", async (t) => {
  const { coordinator, store, paseo } = await fixture(t);
  const result = await coordinator.start(startInput({ allowProjectRead: true }));

  assert.equal(result.job.status, "running");
  assert.equal(result.job.project.workspaceId, WORKSPACE_ID);
  assert.equal(paseo.createCount, 1);
  assert.deepEqual(store.calls.slice(0, 4), ["prepare", "claim", "create", "running"]);
  assert.equal(paseo.createdOptions?.requestId, result.job.requestId);
  assert.equal(paseo.createdOptions?.clientMessageId, result.job.clientMessageId);
  assert.equal(paseo.createdOptions?.autoArchive, false);
  assert.equal(paseo.createdOptions?.labels["prompt-studio.generation"], GENERATION_ID);
  assert.equal(paseo.createdOptions?.prompt, "frozen generation request");
  assert.equal(paseo.createdOptions?.config.options?.sandbox_mode, "read-only");

  const retried = await coordinator.start(startInput({ allowProjectRead: true }));
  assert.equal(retried.job.id, result.job.id);
  assert.equal(paseo.createCount, 1, "a running generation must never create a second Agent");
});

test("generation replaces an archived Project locator with a current Workspace before launch", async (t) => {
  const { coordinator, store, paseo } = await fixture(t);
  paseo.sourceWorkspaceAvailable = false;
  paseo.replacementWorkspaceAvailable = true;

  const result = await coordinator.start(startInput());

  assert.equal(result.job.status, "running");
  assert.equal(result.job.project.workspaceId, REPLACEMENT_WORKSPACE_ID);
  assert.equal(store.refreshedSource?.workspaceId, REPLACEMENT_WORKSPACE_ID);
  assert.equal(store.refreshedSource?.projectId, PROJECT_ID);
  assert.equal(store.refreshedSource?.rootPath, paseo.projectRoot);
});

test("a lost create acknowledgement reconciles by stable labels instead of duplicating", async (t) => {
  const { coordinator, paseo } = await fixture(t);
  paseo.createBehavior = "accept-then-throw";

  const result = await coordinator.start(startInput());
  assert.equal(result.job.status, "running");
  assert.equal(result.job.agentId, "agt_1");
  assert.equal(paseo.createCount, 1);

  await coordinator.start(startInput());
  assert.equal(paseo.createCount, 1);
});

test("a prepare race returning another caller's running job is classified without a new launch", async (t) => {
  const { coordinator, store, paseo } = await fixture(t);
  const first = await coordinator.start(startInput());
  assert.equal(first.job.status, "running");
  store.hideUnresolvedOnce = true;

  const raced = await coordinator.start(startInput({ task: "format", filters: null }));
  assert.equal(raced.job.id, first.job.id);
  assert.equal(raced.job.task, "related");
  assert.equal(paseo.createCount, 1);
});

test("an explicit generation ID resumes terminal and conflict jobs without creating another Agent", async (t) => {
  for (const status of ["applied", "failed", "conflict"] as const) {
    const { coordinator, store, paseo } = await fixture(t);
    const input = startInput();
    const existing = {
      ...seedPreparedJob(store, paseo, input),
      status,
      completedAt: status === "conflict" ? null : "2026-08-26T00:03:00.000Z",
    } satisfies GenerationJob;
    store.job = existing;

    const resumed = await coordinator.start({ ...input, generationId: GENERATION_ID });

    assert.strictEqual(resumed.job, existing, `${status} recovery must return the existing job`);
    assert.equal(resumed.job.id, GENERATION_ID);
    assert.equal(resumed.job.status, status);
    assert.equal(paseo.createCount, 0);
    assert.equal(store.calls.includes("prepare"), false);
    assert.equal(store.calls.includes("claim"), false);
  }
});

test("an explicit generation ID rejects any drift from its frozen start input", async (t) => {
  const { coordinator, store, paseo } = await fixture(t);
  const frozen = startInput();
  seedPreparedJob(store, paseo, frozen);
  const changedFilters: NonNullable<GenerationStartInput["filters"]> = {
    ...frozen.filters!,
    timeRange: "7d" as const,
  };
  const mismatches: Array<[string, Partial<GenerationStartInput>]> = [
    ["base version", { expectedVersion: frozen.expectedVersion + 1 }],
    ["base hash", { expectedHash: digest("changed target") }],
    ["task", { task: "format", filters: null }],
    ["locale", { locale: "zh" }],
    ["project-read permission", { allowProjectRead: true }],
    ["context filters", { filters: changedFilters }],
  ];

  for (const [field, override] of mismatches) {
    await assert.rejects(
      coordinator.start(startInput({ ...override, generationId: GENERATION_ID })),
      /resume input does not match frozen job/,
      `${field} drift must not resume a frozen generation`,
    );
  }

  assert.equal(store.job?.status, "prepared");
  assert.equal(paseo.createCount, 0);
  assert.equal(store.calls.includes("claim"), false);
});

test("an ambiguous create failure becomes needs-attention and is never relaunched", async (t) => {
  const { coordinator, paseo } = await fixture(t);
  paseo.createBehavior = "throw";

  const first = await coordinator.start(startInput());
  assert.equal(first.job.status, "needs-attention");
  assert.match(first.job.error ?? "", /will not create a duplicate/);
  assert.equal(paseo.createCount, 1);

  const second = await coordinator.start(startInput());
  assert.equal(second.job.status, "needs-attention");
  assert.equal(paseo.createCount, 1);
});

test("a broken frozen Project mapping never falls back to a global Agent search", async (t) => {
  const { coordinator, paseo } = await fixture(t);
  const started = await coordinator.start(startInput());
  assert.equal(started.job.status, "running");
  assert.equal(paseo.agentListCount, 0);

  paseo.sourceWorkspaceAvailable = false;
  const synced = await coordinator.sync(DRAFT_ID, GENERATION_ID);

  assert.equal(synced.job.status, "needs-attention");
  assert.match(synced.job.error ?? "", /Project root is unavailable/);
  assert.equal(paseo.agentListCount, 0);
});

test("sync captures the exact Agent reply before explicitly archiving", async (t) => {
  const { coordinator, store, paseo } = await fixture(t);
  const started = await coordinator.start(startInput());
  const agent = paseo.agentMap.get(started.job.agentId ?? "");
  assert.ok(agent);
  agent.result = { status: "idle", error: null, lastMessage: "# Exact reply\n\nKeep  two spaces.  \n" };

  const result = await coordinator.sync(DRAFT_ID, GENERATION_ID);
  assert.equal(result.job.status, "applied");
  assert.equal(result.job.responseMarkdown, "# Exact reply\n\nKeep  two spaces.  \n");
  const committedAt = store.calls.indexOf("commit:# Exact reply\n\nKeep  two spaces.  \n");
  const archivedAt = store.calls.indexOf("archive");
  assert.ok(committedAt >= 0 && archivedAt > committedAt, "the response must be durable before Agent archive");
  assert.equal(agent.archived, true);
});

test("timeout and permission keep the Agent unarchived; provider errors persist before archive", async (t) => {
  const { coordinator, store, paseo } = await fixture(t);
  const started = await coordinator.start(startInput());
  const agent = paseo.agentMap.get(started.job.agentId ?? "");
  assert.ok(agent);

  const timedOut = await coordinator.sync(DRAFT_ID, GENERATION_ID);
  assert.equal(timedOut.job.status, "running");
  assert.equal(agent.archived, false);

  agent.result = { status: "permission", error: "approval required", lastMessage: null };
  const permission = await coordinator.sync(DRAFT_ID, GENERATION_ID);
  assert.equal(permission.job.status, "needs-attention");
  assert.equal(agent.archived, false);

  agent.result = { status: "error", error: "provider crashed", lastMessage: null };
  const failed = await coordinator.sync(DRAFT_ID, GENERATION_ID);
  assert.equal(failed.job.status, "failed");
  assert.equal(agent.archived, true);
  assert.ok(store.calls.indexOf("failed") < store.calls.indexOf("archive"));
});

test("discard and conflict apply close an Agent left unarchived after a prior crash", async (t) => {
  const discardedFixture = await fixture(t);
  const discardedStart = await discardedFixture.coordinator.start(startInput());
  const discardedAgent = discardedFixture.paseo.agentMap.get(discardedStart.job.agentId ?? "");
  assert.ok(discardedAgent);
  discardedFixture.store.job = {
    ...discardedStart.job,
    status: "result-ready",
    responseMarkdown: "candidate",
    responseHash: digest("candidate"),
    responseCapturedAt: "2026-08-26T00:01:00.000Z",
  };
  const discarded = await discardedFixture.coordinator.discard(DRAFT_ID, GENERATION_ID);
  assert.equal(discarded.status, "discarded");
  assert.equal(discardedAgent.archived, true);
  assert.ok(discardedFixture.store.calls.indexOf("discard") < discardedFixture.store.calls.indexOf("archive"));

  const appliedFixture = await fixture(t);
  const appliedStart = await appliedFixture.coordinator.start(startInput());
  const appliedAgent = appliedFixture.paseo.agentMap.get(appliedStart.job.agentId ?? "");
  assert.ok(appliedAgent);
  appliedFixture.store.job = {
    ...appliedStart.job,
    status: "conflict",
    responseMarkdown: "candidate",
    responseHash: digest("candidate"),
    responseCapturedAt: "2026-08-26T00:01:00.000Z",
  };
  const applied = await appliedFixture.coordinator.applyCandidate({
    draftId: DRAFT_ID,
    generationId: GENERATION_ID,
    expectedVersion: 2,
    expectedHash: digest("latest"),
  });
  assert.equal(applied.job.status, "applied");
  assert.equal(appliedAgent.archived, true);
  assert.ok(appliedFixture.store.calls.indexOf("apply-candidate") < appliedFixture.store.calls.indexOf("archive"));
});

test("archive refuses an Agent whose lineage labels do not match and persists a warning", async (t) => {
  const { coordinator, store, paseo } = await fixture(t);
  const input = startInput();
  const agent = new FakeAgent(
    "agt_mismatched",
    paseo.projectRoot,
    {
      "prompt-studio.generation": `gn_${"c".repeat(24)}`,
      "prompt-studio.draft": DRAFT_ID,
      "prompt-studio.task": input.task,
      "prompt-studio.request": `prompt-studio:generation:${GENERATION_ID}:create`,
    },
    paseo.calls,
  );
  paseo.agentMap.set(agent.id, agent);
  store.job = {
    ...seedPreparedJob(store, paseo, input),
    status: "applied",
    agentId: agent.id,
    completedAt: "2026-08-26T00:03:00.000Z",
  };

  const resumed = await coordinator.start({ ...input, generationId: GENERATION_ID });

  assert.equal(resumed.job.status, "applied");
  assert.equal(agent.archived, false);
  assert.equal(paseo.calls.includes("archive"), false);
  assert.match(resumed.job.archiveWarning ?? "", /no longer matches generation/);
  assert.equal(paseo.createCount, 0);
});

test("managed or overlapping Prompt Studio vault roots are rejected before job creation", async (t) => {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), "prompt-studio-generation-overlap-"));
  t.after(() => rm(vaultRoot, { recursive: true, force: true }));
  const store = new FakeStore(vaultRoot);
  const paseo = new FakePaseo(vaultRoot);
  const coordinator = createGenerationCoordinator(store, paseo);

  await assert.rejects(coordinator.start(startInput()), /managed|overlap/i);
  assert.equal(store.job, null);
  assert.equal(paseo.createCount, 0);
});
