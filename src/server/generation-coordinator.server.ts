import { lstat, realpath } from "node:fs/promises";
import type { output as ZodOutput } from "zod";
import type { DraftDetail } from "../shared/contracts.shared";
import type {
  generationPreviewRpc,
  generationStartRpc,
  GenerationJob,
  GenerationPreview,
  GenerationProject,
  GenerationProtection,
  GenerationProviderConfig,
  GenerationTask,
} from "../shared/generation.shared";
import {
  resolveAvailableSourceProject,
  type PaseoWorkspaceRegistrar,
} from "./project-registration.server";
import type { ResolvedSourceProject } from "./store.server";
import {
  buildGenerationAgentPolicy,
  type GenerationAgentPolicy,
} from "./generation-provider-policy.server";
import {
  formatError,
  isWithinPath,
  normalizePath,
} from "./storage/filesystem.server";

export type GenerationPreviewInput = ZodOutput<typeof generationPreviewRpc.input>;
export type GenerationStartInput = ZodOutput<typeof generationStartRpc.input>;

export interface GenerationPreparationContext {
  configuration: GenerationProviderConfig;
  project: GenerationProject;
  projectRoot: string;
  contextWindowMaxTokens: number;
  protection: GenerationProtection;
}

export interface GenerationPromptSnapshot {
  requestMarkdown: string;
  systemPrompt: string;
  agentTitle: string;
}

export interface GenerationMutationResult {
  job: GenerationJob;
  draft: DraftDetail | null;
}

/**
 * Adapter boundary between the Paseo runtime coordinator and Prompt Studio's
 * canonical plaintext store. Implementations must perform every mutation under
 * the Draft/generation cross-process lock. In particular, claimGenerationLaunch
 * is a compare-and-set: exactly one caller may receive claimed=true.
 */
export interface GenerationRuntimeStore {
  readonly rootPath: string;
  isManagedPath(candidatePath: string): Promise<boolean>;
  getGenerationProviderConfig(task: GenerationTask): Promise<GenerationProviderConfig>;
  getGenerationProject(draftId: string): Promise<GenerationProject>;
  refreshGenerationProjectLink(source: ResolvedSourceProject): Promise<void>;
  findUnresolvedGeneration(draftId: string): Promise<GenerationJob | null>;
  previewGeneration(
    input: GenerationPreviewInput,
    context: GenerationPreparationContext,
  ): Promise<GenerationPreview>;
  prepareGeneration(
    input: GenerationStartInput,
    context: GenerationPreparationContext,
  ): Promise<GenerationJob>;
  getGeneration(draftId: string, generationId: string): Promise<GenerationJob>;
  getGenerationPrompt(draftId: string, generationId: string): Promise<GenerationPromptSnapshot>;
  claimGenerationLaunch(
    draftId: string,
    generationId: string,
  ): Promise<{ job: GenerationJob; claimed: boolean }>;
  markGenerationRunning(
    draftId: string,
    generationId: string,
    agentId: string,
  ): Promise<GenerationJob>;
  markGenerationNeedsAttention(
    draftId: string,
    generationId: string,
    error: string,
    agentId?: string | null,
  ): Promise<GenerationJob>;
  markGenerationFailed(
    draftId: string,
    generationId: string,
    error: string,
    agentId?: string | null,
  ): Promise<GenerationJob>;
  commitGenerationResponse(input: {
    draftId: string;
    generationId: string;
    responseMarkdown: string;
    agentId: string;
  }): Promise<GenerationMutationResult>;
  applyGenerationCandidate(input: {
    draftId: string;
    generationId: string;
    expectedVersion: number;
    expectedHash: string;
  }): Promise<GenerationMutationResult>;
  discardGeneration(draftId: string, generationId: string): Promise<GenerationJob>;
  abandonGeneration(draftId: string, generationId: string): Promise<GenerationJob>;
  recordGenerationArchiveWarning(
    draftId: string,
    generationId: string,
    warning: string,
  ): Promise<GenerationJob>;
}

export interface GenerationAgentSnapshot {
  id: string;
  cwd: string;
  workspaceId?: string;
  status: "initializing" | "running" | "idle" | "error" | "closed";
  labels: Record<string, string>;
  archivedAt?: string | null;
}

export interface GenerationRunResult {
  status: "idle" | "error" | "permission" | "timeout";
  error: string | null;
  lastMessage: string | null;
}

export interface GenerationAgentHandle {
  readonly id: string;
  refresh(requestId?: string): Promise<{ agent: GenerationAgentSnapshot } | null>;
  waitForFinish(timeoutMs?: number): Promise<GenerationRunResult>;
  archive(): Promise<{ archivedAt: string }>;
}

export interface GenerationWorkspaceSnapshot {
  id: string;
  projectId: string;
  projectDisplayName: string;
  projectRootPath: string;
  workspaceDirectory?: string;
}

export interface GenerationWorkspaceHandle {
  readonly id: string;
  readonly projectId: string | null;
  refresh(options?: { requestId?: string }): Promise<GenerationWorkspaceSnapshot | null>;
  agents: {
    create(options: {
      config: GenerationAgentPolicy["config"];
      prompt: string;
      requestId: string;
      clientMessageId: string;
      title: string;
      labels: Record<string, string>;
      autoArchive: false;
    }): Promise<GenerationAgentHandle>;
  };
}

export interface GenerationPaseo extends PaseoWorkspaceRegistrar {
  workspaces: {
    ref(workspaceId: string): GenerationWorkspaceHandle;
    open(path: string): Promise<GenerationWorkspaceHandle>;
  };
  agents: {
    ref(agentId: string): GenerationAgentHandle;
    list(options?: {
      filter?: { includeArchived?: boolean };
      page?: { limit: number; cursor?: string };
    }): Promise<{
      entries: Array<{ agent: GenerationAgentSnapshot }>;
      pageInfo: { nextCursor: string | null; hasMore: boolean };
    }>;
  };
  providers: {
    listAvailable(options?: { requestId?: string }): Promise<{
      providers: Array<{ provider: string; available: boolean; error?: string | null }>;
      error?: string | null;
    }>;
    listModels(provider: string, options?: { cwd?: string; requestId?: string }): Promise<{
      provider: string;
      models?: Array<{
        id: string;
        aliases?: string[];
        isSelectable?: boolean;
        contextWindowMaxTokens?: number;
        thinkingOptions?: Array<{ id: string }>;
      }>;
      error?: string | null;
    }>;
  };
}

type ResolvedGenerationContext = GenerationPreparationContext;

const TERMINAL_STATUSES = new Set<GenerationJob["status"]>([
  "applied",
  "failed",
  "discarded",
  "abandoned",
]);

function previewFromJob(job: GenerationJob): GenerationPreview {
  return {
    draftId: job.draftId,
    task: job.task,
    project: job.project,
    configuration: job.configuration,
    counts: job.counts,
    protection: job.protection,
  };
}

function assertResumeInput(job: GenerationJob, input: GenerationStartInput): void {
  if (
    job.draftId !== input.draftId
    || job.baseVersion !== input.expectedVersion
    || job.baseHash !== input.expectedHash
    || job.task !== input.task
    || job.locale !== input.locale
    || job.allowProjectRead !== input.allowProjectRead
    || JSON.stringify(job.filters) !== JSON.stringify(input.filters)
  ) {
    throw new Error(`Generation resume input does not match frozen job ${job.id}`);
  }
}

function generationLabels(job: GenerationJob): Record<string, string> {
  return {
    "prompt-studio.generation": job.id,
    "prompt-studio.draft": job.draftId,
    "prompt-studio.task": job.task,
    "prompt-studio.request": job.requestId,
  };
}

function matchesGeneration(agent: GenerationAgentSnapshot, job: GenerationJob): boolean {
  const labels = generationLabels(job);
  return Object.entries(labels).every(([key, value]) => agent.labels[key] === value);
}

function agentTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return (normalized || "Prompt Studio generation").slice(0, 120);
}

async function canonicalDirectory(rootPath: string): Promise<string> {
  const info = await lstat(rootPath);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Generation Project root is unsafe or unavailable: ${rootPath}`);
  }
  return normalizePath(await realpath(rootPath));
}

async function assertExternalProjectRoot(
  store: GenerationRuntimeStore,
  projectRoot: string,
): Promise<string> {
  if (await store.isManagedPath(projectRoot)) {
    throw new Error("Generation Agents cannot run in a Prompt Studio managed or legacy vault");
  }
  const [canonicalProject, canonicalVault] = await Promise.all([
    canonicalDirectory(projectRoot),
    canonicalDirectory(store.rootPath),
  ]);
  if (
    isWithinPath(canonicalVault, canonicalProject)
    || isWithinPath(canonicalProject, canonicalVault)
  ) {
    throw new Error("Generation Project roots must not overlap the Prompt Studio vault");
  }
  return canonicalProject;
}

async function validateProviderSelection(
  paseo: GenerationPaseo,
  configuration: GenerationProviderConfig,
  cwd: string,
): Promise<number> {
  const available = await paseo.providers.listAvailable();
  if (available.error) throw new Error(`Provider discovery failed: ${available.error}`);
  const provider = available.providers.find((entry) => entry.provider === configuration.provider);
  if (!provider?.available) {
    throw new Error(provider?.error || `Generation provider is unavailable: ${configuration.provider}`);
  }
  const catalog = await paseo.providers.listModels(configuration.provider, { cwd });
  if (catalog.error) throw new Error(`Model discovery failed: ${catalog.error}`);
  if (catalog.provider !== configuration.provider) {
    throw new Error(`Paseo returned models for ${catalog.provider}, not ${configuration.provider}`);
  }
  const model = catalog.models?.find((entry) => entry.id === configuration.model);
  if (!model || model.isSelectable === false) {
    throw new Error(`Generation model is unavailable: ${configuration.provider}/${configuration.model}`);
  }
  if (
    configuration.thinkingOptionId
    && !model.thinkingOptions?.some((entry) => entry.id === configuration.thinkingOptionId)
  ) {
    throw new Error(
      `Thinking option is unavailable for ${configuration.provider}/${configuration.model}: ${configuration.thinkingOptionId}`,
    );
  }
  return Math.max(1, Math.floor(model.contextWindowMaxTokens ?? 32_000));
}

export function createGenerationCoordinator(
  store: GenerationRuntimeStore,
  paseo: GenerationPaseo,
) {
  async function resolveProject(project: GenerationProject): Promise<{
    project: GenerationProject;
    root: string;
  }> {
    const source = await resolveAvailableSourceProject(paseo, project.projectId);
    const root = await assertExternalProjectRoot(store, source.rootPath);
    await store.refreshGenerationProjectLink(source);
    return {
      project,
      root,
    };
  }

  async function resolveProjectRoot(project: GenerationProject): Promise<string> {
    return (await resolveProject(project)).root;
  }

  async function resolveContext(
    draftId: string,
    task: GenerationTask,
    allowProjectRead: boolean,
  ): Promise<ResolvedGenerationContext> {
    const [configuration, project] = await Promise.all([
      store.getGenerationProviderConfig(task),
      store.getGenerationProject(draftId),
    ]);
    const resolvedProject = await resolveProject(project);
    const projectRoot = resolvedProject.root;
    const contextWindowMaxTokens = await validateProviderSelection(paseo, configuration, projectRoot);
    const protection = buildGenerationAgentPolicy({
      selection: configuration,
      allowProjectRead,
      projectRoot,
      vaultRoot: store.rootPath,
      systemPrompt: "",
    }).protection;
    return {
      configuration,
      project: resolvedProject.project,
      projectRoot,
      contextWindowMaxTokens,
      protection,
    };
  }

  async function resolveContextForJob(job: GenerationJob): Promise<ResolvedGenerationContext> {
    const projectRoot = await resolveProjectRoot(job.project);
    const contextWindowMaxTokens = await validateProviderSelection(paseo, job.configuration, projectRoot);
    const protection = buildGenerationAgentPolicy({
      selection: job.configuration,
      allowProjectRead: job.allowProjectRead,
      projectRoot,
      vaultRoot: store.rootPath,
      systemPrompt: "",
    }).protection;
    if (JSON.stringify(protection) !== JSON.stringify(job.protection)) {
      throw new Error("The provider safety policy changed after this generation was prepared");
    }
    return {
      configuration: job.configuration,
      project: job.project,
      projectRoot,
      contextWindowMaxTokens,
      protection,
    };
  }

  async function rootWorkspace(
    job: GenerationJob,
    context: ResolvedGenerationContext,
  ): Promise<GenerationWorkspaceHandle> {
    const opened = await paseo.workspaces.open(context.projectRoot);
    const current = await opened.refresh({ requestId: `${job.requestId}:workspace` });
    if (!current) throw new Error(`Paseo could not open the Project root Workspace: ${context.projectRoot}`);
    if (current.id !== opened.id || current.projectId !== job.project.projectId) {
      throw new Error("Paseo opened a Workspace belonging to a different Project");
    }
    if (normalizePath(current.projectRootPath) !== normalizePath(context.projectRoot)) {
      throw new Error("Paseo Project root changed while preparing the generation Agent");
    }
    if (
      current.workspaceDirectory
      && normalizePath(current.workspaceDirectory) !== normalizePath(context.projectRoot)
    ) {
      throw new Error("Generation Agents must run in the Project root Workspace, not another worktree");
    }
    return opened;
  }

  async function isSafeGenerationAgent(
    agent: GenerationAgentSnapshot,
    job: GenerationJob,
    expectedRoot?: string | null,
  ): Promise<boolean> {
    if (!matchesGeneration(agent, job)) return false;
    if (await store.isManagedPath(agent.cwd)) {
      throw new Error(`Generation Agent ${agent.id} is inside a Prompt Studio managed vault`);
    }
    const canonicalCwd = await canonicalDirectory(agent.cwd);
    if (expectedRoot && canonicalCwd !== normalizePath(expectedRoot)) {
      throw new Error(`Generation Agent ${agent.id} is not in the frozen Project root`);
    }
    return true;
  }

  async function findAgent(
    job: GenerationJob,
    expectedRoot?: string | null,
  ): Promise<GenerationAgentHandle | null> {
    if (job.agentId) {
      const handle = paseo.agents.ref(job.agentId);
      const refreshed = await handle.refresh(`${job.requestId}:agent`);
      if (refreshed && await isSafeGenerationAgent(refreshed.agent, job, expectedRoot)) return handle;
    }
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const page = await paseo.agents.list({
        filter: { includeArchived: true },
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      for (const entry of page.entries) {
        if (await isSafeGenerationAgent(entry.agent, job, expectedRoot)) {
          return paseo.agents.ref(entry.agent.id);
        }
      }
      if (!page.pageInfo.hasMore || !page.pageInfo.nextCursor) return null;
      cursor = page.pageInfo.nextCursor;
    }
    throw new Error("Generation Agent reconciliation exceeded the pagination limit");
  }

  async function reconcileAgent(
    job: GenerationJob,
    expectedRoot?: string | null,
  ): Promise<GenerationJob | null> {
    const handle = await findAgent(job, expectedRoot);
    if (!handle) return null;
    if (job.status === "prepared" || job.status === "launching" || job.status === "needs-attention") {
      return store.markGenerationRunning(job.draftId, job.id, handle.id);
    }
    return { ...job, agentId: job.agentId ?? handle.id };
  }

  async function archiveAfterCapture(job: GenerationJob): Promise<GenerationJob> {
    if (!job.agentId) return job;
    try {
      const handle = paseo.agents.ref(job.agentId);
      const current = await handle.refresh(`${job.requestId}:archive-check`);
      if (!current || !matchesGeneration(current.agent, job)) {
        throw new Error(`Agent ${job.agentId} no longer matches generation ${job.id}`);
      }
      if (!current?.agent.archivedAt) await handle.archive();
      return job;
    } catch (error) {
      const warning = `The generation result is safe, but Agent ${job.agentId} could not be archived: ${formatError(error)}`;
      try {
        return await store.recordGenerationArchiveWarning(job.draftId, job.id, warning);
      } catch {
        console.error(`[prompt-studio] ${warning}`);
        return job;
      }
    }
  }

  async function failAndArchive(
    job: GenerationJob,
    error: string,
    agentId: string | null,
  ): Promise<GenerationJob> {
    const failed = await store.markGenerationFailed(job.draftId, job.id, error, agentId);
    return archiveAfterCapture(failed);
  }

  return {
    async preview(input: GenerationPreviewInput): Promise<GenerationPreview> {
      const context = await resolveContext(input.draftId, input.task, input.allowProjectRead);
      return store.previewGeneration(input, context);
    },

    async start(input: GenerationStartInput): Promise<{ job: GenerationJob; preview: GenerationPreview }> {
      let preparedContext: ResolvedGenerationContext | null = null;
      let job = input.generationId
        ? await store.getGeneration(input.draftId, input.generationId)
        : await store.findUnresolvedGeneration(input.draftId);
      if (input.generationId) {
        if (!job) throw new Error(`Unknown generation: ${input.generationId}`);
        assertResumeInput(job, input);
      }
      if (!job) {
        preparedContext = await resolveContext(input.draftId, input.task, input.allowProjectRead);
        job = await store.prepareGeneration(input, preparedContext);
      }
      if (job.status === "running") {
        return { job, preview: previewFromJob(job) };
      }
      if (TERMINAL_STATUSES.has(job.status) || job.status === "conflict") {
        const archived = await archiveAfterCapture(job);
        return { job: archived, preview: previewFromJob(archived) };
      }
      if (job.status === "result-ready") {
        if (!job.responseMarkdown || !job.agentId) {
          throw new Error(`Generation ${job.id} has an incomplete captured response`);
        }
        // Keep start/resume free of an otherwise invisible Draft mutation. The
        // client observes result-ready and follows with generation.sync, whose
        // contract returns the canonical Draft for local/cache adoption.
        return { job, preview: previewFromJob(job) };
      }

      // A failed create acknowledgement is ambiguous. needs-attention jobs may
      // only reconcile or be abandoned; they must never launch a second Agent.
      if (job.status === "needs-attention" || job.status === "launching") {
        let expectedRoot: string;
        try {
          expectedRoot = await resolveProjectRoot(job.project);
        } catch (error) {
          const needsAttention = await store.markGenerationNeedsAttention(
            job.draftId,
            job.id,
            `The frozen Project root is unavailable; Agent reconciliation was not attempted: ${formatError(error)}`,
            job.agentId,
          );
          return { job: needsAttention, preview: previewFromJob(needsAttention) };
        }
        const recovered = await reconcileAgent(job, expectedRoot);
        return { job: recovered ?? job, preview: previewFromJob(recovered ?? job) };
      }

      let context: ResolvedGenerationContext;
      let workspace: GenerationWorkspaceHandle;
      let prompt: GenerationPromptSnapshot;
      let policy: GenerationAgentPolicy;
      try {
        context = preparedContext
          && preparedContext.project.projectId === job.project.projectId
          && JSON.stringify(preparedContext.configuration) === JSON.stringify(job.configuration)
          && JSON.stringify(preparedContext.protection) === JSON.stringify(job.protection)
          ? preparedContext
          : await resolveContextForJob(job);
        workspace = await rootWorkspace(job, context);
        prompt = await store.getGenerationPrompt(job.draftId, job.id);
        policy = buildGenerationAgentPolicy({
          selection: job.configuration,
          allowProjectRead: job.allowProjectRead,
          projectRoot: context.projectRoot,
          vaultRoot: store.rootPath,
          systemPrompt: prompt.systemPrompt,
        });
      } catch (error) {
        job = await store.markGenerationFailed(
          job.draftId,
          job.id,
          `The generation Agent was not launched: ${formatError(error)}`,
          null,
        );
        return { job, preview: previewFromJob(job) };
      }
      const claimed = await store.claimGenerationLaunch(job.draftId, job.id);
      job = claimed.job;
      if (!claimed.claimed) {
        const afterClaim = await reconcileAgent(job, context.projectRoot);
        return { job: afterClaim ?? job, preview: previewFromJob(afterClaim ?? job) };
      }

      try {
        const handle = await workspace.agents.create({
          config: policy.config,
          prompt: prompt.requestMarkdown,
          requestId: job.requestId,
          clientMessageId: job.clientMessageId,
          title: agentTitle(prompt.agentTitle),
          labels: generationLabels(job),
          autoArchive: false,
        });
        job = await store.markGenerationRunning(job.draftId, job.id, handle.id);
        return { job, preview: previewFromJob(job) };
      } catch (error) {
        const recoveredAfterError = await reconcileAgent(job, context.projectRoot).catch(() => null);
        if (recoveredAfterError) {
          return { job: recoveredAfterError, preview: previewFromJob(recoveredAfterError) };
        }
        job = await store.markGenerationNeedsAttention(
          job.draftId,
          job.id,
          `Agent creation acknowledgement is uncertain; Prompt Studio will not create a duplicate: ${formatError(error)}`,
          null,
        );
        return { job, preview: previewFromJob(job) };
      }
    },

    async get(draftId: string, generationId: string | null): Promise<GenerationJob | null> {
      if (generationId) return store.getGeneration(draftId, generationId);
      return store.findUnresolvedGeneration(draftId);
    },

    async sync(draftId: string, generationId: string): Promise<GenerationMutationResult> {
      let job = await store.getGeneration(draftId, generationId);
      if (job.status === "result-ready") {
        if (!job.responseMarkdown || !job.agentId) {
          throw new Error(`Generation ${job.id} has an incomplete captured response`);
        }
        const committed = await store.commitGenerationResponse({
          draftId,
          generationId,
          responseMarkdown: job.responseMarkdown,
          agentId: job.agentId,
        });
        return { ...committed, job: await archiveAfterCapture(committed.job) };
      }
      if (TERMINAL_STATUSES.has(job.status) || job.status === "conflict") {
        return { job: await archiveAfterCapture(job), draft: null };
      }

      let expectedRoot: string;
      try {
        expectedRoot = await resolveProjectRoot(job.project);
      } catch (error) {
        if (job.status === "prepared") return { job, draft: null };
        job = await store.markGenerationNeedsAttention(
          draftId,
          generationId,
          `The frozen Project root is unavailable; Agent reconciliation was not attempted: ${formatError(error)}`,
          job.agentId,
        );
        return { job, draft: null };
      }
      const reconciled = await reconcileAgent(job, expectedRoot);
      if (reconciled) job = reconciled;
      const handle = await findAgent(job, expectedRoot);
      if (!handle) {
        if (job.status === "prepared") return { job, draft: null };
        job = await store.markGenerationNeedsAttention(
          draftId,
          generationId,
          "The generation Agent could not be found; no replacement Agent was created.",
          job.agentId,
        );
        return { job, draft: null };
      }

      const result = await handle.waitForFinish(250);
      if (result.status === "timeout") return { job, draft: null };
      if (result.status === "permission") {
        job = await store.markGenerationNeedsAttention(
          draftId,
          generationId,
          result.error || "The generation Agent requires permission.",
          handle.id,
        );
        return { job, draft: null };
      }
      if (result.status === "error") {
        job = await failAndArchive(
          job,
          result.error || "The generation Agent failed.",
          handle.id,
        );
        return { job, draft: null };
      }
      if (result.lastMessage === null || !result.lastMessage.trim()) {
        job = await failAndArchive(job, "The generation Agent returned an empty response.", handle.id);
        return { job, draft: null };
      }
      const committed = await store.commitGenerationResponse({
        draftId,
        generationId,
        responseMarkdown: result.lastMessage,
        agentId: handle.id,
      });
      return { ...committed, job: await archiveAfterCapture(committed.job) };
    },

    async applyCandidate(input: {
      draftId: string;
      generationId: string;
      expectedVersion: number;
      expectedHash: string;
    }): Promise<GenerationMutationResult> {
      const applied = await store.applyGenerationCandidate(input);
      return { ...applied, job: await archiveAfterCapture(applied.job) };
    },

    async discard(draftId: string, generationId: string): Promise<GenerationJob> {
      const discarded = await store.discardGeneration(draftId, generationId);
      return archiveAfterCapture(discarded);
    },

    async abandon(draftId: string, generationId: string): Promise<GenerationJob> {
      const current = await store.getGeneration(draftId, generationId);
      let handle: GenerationAgentHandle | null = null;
      try {
        const expectedRoot = await resolveProjectRoot(current.project);
        handle = await findAgent(current, expectedRoot);
      } catch {
        // A broken Project mapping must never downgrade to a global label
        // search. The recorded agentId, if any, is handled by the lineage-safe
        // archiveAfterCapture fallback below.
      }
      let job = await store.abandonGeneration(draftId, generationId);
      if (!handle) return archiveAfterCapture(job);
      try {
        const snapshot = await handle.refresh(`${job.requestId}:abandon-archive-check`);
        if (!snapshot?.agent.archivedAt) await handle.archive();
      } catch (error) {
        job = await store.recordGenerationArchiveWarning(
          draftId,
          generationId,
          `Generation was abandoned, but Agent ${handle.id} could not be archived: ${formatError(error)}`,
        );
      }
      return job;
    },
  };
}
