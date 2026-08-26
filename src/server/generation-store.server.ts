import { randomUUID } from "node:crypto";
import type { output as ZodOutput } from "zod";
import {
  generationJobRecordSchema,
  generationSettingsUpdateRpc,
  type GenerationJob,
  type GenerationJobRecord,
  type GenerationPreview,
  type GenerationProject,
  type GenerationProviderConfig,
  type GenerationSettings,
  type GenerationTask,
} from "../shared/generation.shared";
import {
  buildGenerationContextFromStore,
  generationSystemPrompt,
} from "./generation-context.server";
import type {
  GenerationMutationResult,
  GenerationPreparationContext,
  GenerationPreviewInput,
  GenerationPromptSnapshot,
  GenerationStartInput,
} from "./generation-coordinator.server";
import type { GenerationHandlerStore } from "./generation-handlers.server";
import {
  GenerationRepository,
  GenerationSettingsRepository,
} from "./storage/generations.server";
import { hash } from "./storage/filesystem.server";
import { PromptStudioStore } from "./store.server";

export interface PromptStudioGenerationStoreOptions {
  now?: () => Date;
  entropy?: () => string;
}

function generationId(entropy: () => string): string {
  const value = entropy().replace(/[^a-fA-F0-9]/g, "").toLocaleLowerCase();
  if (value.length < 24) throw new Error("Generation entropy must contain at least 24 hexadecimal characters");
  return `gn_${value.slice(0, 24)}`;
}

function assertExpectedDraft(
  draft: { version: number; contentHash: string; scope: { projectId: string | null } },
  input: { expectedVersion: number; expectedHash: string },
  expectedProjectId?: string,
): void {
  if (draft.version !== input.expectedVersion || draft.contentHash !== input.expectedHash) {
    throw new Error(`Draft changed before generation started (current version ${draft.version})`);
  }
  if (expectedProjectId !== undefined && draft.scope.projectId !== expectedProjectId) {
    throw new Error("Draft Project changed before generation started");
  }
}

export class PromptStudioGenerationStore implements GenerationHandlerStore {
  readonly rootPath: string;
  private readonly jobs: GenerationRepository;
  private readonly settings: GenerationSettingsRepository;
  private readonly now: () => Date;
  private readonly entropy: () => string;

  constructor(
    private readonly store: PromptStudioStore,
    options: PromptStudioGenerationStoreOptions = {},
  ) {
    this.rootPath = store.rootPath;
    this.now = options.now ?? (() => new Date());
    this.entropy = options.entropy ?? randomUUID;
    this.jobs = new GenerationRepository(this.rootPath, { now: this.now });
    this.settings = new GenerationSettingsRepository(this.rootPath, { now: this.now });
  }

  isManagedPath(candidatePath: string): Promise<boolean> {
    return this.store.isManagedPath(candidatePath);
  }

  getGenerationSettings(): Promise<GenerationSettings> {
    return this.settings.get();
  }

  updateGenerationSettings(
    input: ZodOutput<typeof generationSettingsUpdateRpc.input>,
  ): Promise<GenerationSettings> {
    return this.settings.update(input);
  }

  async getGenerationProviderConfig(task: GenerationTask): Promise<GenerationProviderConfig> {
    const configuration = (await this.settings.get())[task];
    if (!configuration) {
      throw new Error(`Configure a provider and model for the ${task} generation task first`);
    }
    return configuration;
  }

  async getGenerationProject(draftId: string): Promise<GenerationProject> {
    const draft = await this.store.getDraft(draftId);
    const projectId = draft.summary.scope.projectId;
    if (!projectId) throw new Error("Assign the Prompt Studio draft to a Project before running generation");
    const linked = (await this.store.getLinkedProjects()).find((project) => project.projectId === projectId);
    if (!linked) throw new Error(`The Draft's Project link is unavailable: ${projectId}`);
    return {
      projectId,
      projectName: draft.summary.scope.projectName ?? linked.name,
      workspaceId: linked.workspaceId,
    };
  }

  private async ensureGenerationEvents(job: GenerationJob): Promise<GenerationJob> {
    await this.store.recordGenerationEvent({
      draftId: job.draftId,
      generationId: job.id,
      type: "generation.started",
      summary: `${job.task === "format" ? "Started formatting" : "Started optimizing"} with an Agent`,
      details: {
        task: job.task,
        provider: job.configuration.provider,
        model: job.configuration.model,
        counts: job.counts,
        allowProjectRead: job.allowProjectRead,
      },
    });
    if (job.status === "failed") {
      await this.store.recordGenerationEvent({
        draftId: job.draftId,
        generationId: job.id,
        type: "generation.failed",
        summary: `Generation ${job.id} failed`,
        details: { error: job.error, agentId: job.agentId },
      });
    } else if (job.status === "conflict") {
      await this.store.recordGenerationEvent({
        draftId: job.draftId,
        generationId: job.id,
        type: "generation.conflict",
        summary: "Saved generated response as a conflict candidate",
        details: { error: job.error, agentId: job.agentId },
      });
    } else if (job.status === "discarded") {
      await this.store.recordGenerationEvent({
        draftId: job.draftId,
        generationId: job.id,
        type: "generation.discarded",
        summary: `Discarded generation candidate ${job.id}`,
      });
    }
    return job;
  }

  async findUnresolvedGeneration(draftId: string): Promise<GenerationJob | null> {
    const job = await this.jobs.findUnresolved(draftId);
    return job ? this.ensureGenerationEvents(job) : null;
  }

  async previewGeneration(
    input: GenerationPreviewInput,
    context: GenerationPreparationContext,
  ): Promise<GenerationPreview> {
    const built = await buildGenerationContextFromStore({
      store: this.store,
      draftId: input.draftId,
      task: input.task,
      locale: input.locale,
      filters: input.task === "related" ? input.filters : null,
      allowProjectRead: input.allowProjectRead,
      modelContextWindowTokens: context.contextWindowMaxTokens,
    });
    assertExpectedDraft(built.target.summary, input, context.project.projectId);
    return {
      draftId: input.draftId,
      task: input.task,
      project: context.project,
      configuration: context.configuration,
      counts: built.counts,
      protection: context.protection,
    };
  }

  async prepareGeneration(
    input: GenerationStartInput,
    context: GenerationPreparationContext,
  ): Promise<GenerationJob> {
    if (input.task === "related" && input.filters === null) {
      throw new Error("Related Prompt generation requires context filters");
    }
    if (input.task === "format" && input.filters !== null) {
      throw new Error("Format-only generation cannot include Prompt context filters");
    }
    const built = await buildGenerationContextFromStore({
      store: this.store,
      draftId: input.draftId,
      task: input.task,
      locale: input.locale,
      filters: input.filters,
      allowProjectRead: input.allowProjectRead,
      modelContextWindowTokens: context.contextWindowMaxTokens,
    });
    assertExpectedDraft(built.target.summary, input, context.project.projectId);
    const id = generationId(this.entropy);
    const at = this.now().toISOString();
    const stablePrefix = `prompt-studio:generation:${id}`;
    const record: GenerationJobRecord = generationJobRecordSchema.parse({
      schemaVersion: 1,
      id,
      draftId: input.draftId,
      task: input.task,
      status: "prepared",
      baseVersion: input.expectedVersion,
      baseHash: input.expectedHash,
      locale: input.locale,
      allowProjectRead: input.allowProjectRead,
      filters: input.task === "related" ? input.filters : null,
      configuration: context.configuration,
      project: context.project,
      counts: built.counts,
      includedSources: built.includedSources,
      protection: context.protection,
      requestId: `${stablePrefix}:create`,
      clientMessageId: `${stablePrefix}:message`,
      requestHash: hash(built.requestMarkdown),
      responseHash: null,
      responseCapturedAt: null,
      agentId: null,
      checkpointId: null,
      appliedVersion: null,
      appliedHash: null,
      error: null,
      archiveWarning: null,
      createdAt: at,
      updatedAt: at,
      completedAt: null,
    });
    return this.store.prepareGenerationJob({
      record,
      requestMarkdown: built.requestMarkdown,
      expectedProjectId: context.project.projectId,
    });
  }

  async getGeneration(draftId: string, generationIdValue: string): Promise<GenerationJob> {
    return this.ensureGenerationEvents(await this.jobs.get(draftId, generationIdValue));
  }

  async getGenerationPrompt(
    draftId: string,
    generationIdValue: string,
  ): Promise<GenerationPromptSnapshot> {
    const job = await this.jobs.get(draftId, generationIdValue);
    return {
      requestMarkdown: await this.jobs.getRequest(draftId, generationIdValue),
      systemPrompt: generationSystemPrompt({
        task: job.task,
        locale: job.locale,
        allowProjectRead: job.allowProjectRead,
        forbiddenVaultPath: this.rootPath,
      }),
      agentTitle: `Prompt Studio ${job.task} · ${job.draftId}`,
    };
  }

  claimGenerationLaunch(draftId: string, generationIdValue: string) {
    return this.jobs.claimLaunch(draftId, generationIdValue);
  }

  markGenerationRunning(
    draftId: string,
    generationIdValue: string,
    agentId: string,
  ): Promise<GenerationJob> {
    return this.jobs.markRunning(draftId, generationIdValue, agentId);
  }

  markGenerationNeedsAttention(
    draftId: string,
    generationIdValue: string,
    error: string,
    agentId: string | null = null,
  ): Promise<GenerationJob> {
    return this.jobs.transition(draftId, generationIdValue, "needs-attention", {
      error,
      ...(agentId ? { agentId } : {}),
    });
  }

  async markGenerationFailed(
    draftId: string,
    generationIdValue: string,
    error: string,
    agentId: string | null = null,
  ): Promise<GenerationJob> {
    return this.store.failGeneration(draftId, generationIdValue, error, agentId);
  }

  async commitGenerationResponse(input: {
    draftId: string;
    generationId: string;
    responseMarkdown: string;
    agentId: string;
  }): Promise<GenerationMutationResult> {
    return this.store.commitGenerationResponse(input);
  }

  async applyGenerationCandidate(input: {
    draftId: string;
    generationId: string;
    expectedVersion: number;
    expectedHash: string;
  }): Promise<GenerationMutationResult> {
    return this.store.applyGenerationCandidate(input);
  }

  async discardGeneration(draftId: string, generationIdValue: string): Promise<GenerationJob> {
    return this.store.discardGeneration(draftId, generationIdValue);
  }

  abandonGeneration(draftId: string, generationIdValue: string): Promise<GenerationJob> {
    return this.store.abandonGeneration(draftId, generationIdValue);
  }

  recordGenerationArchiveWarning(
    draftId: string,
    generationIdValue: string,
    warning: string,
  ): Promise<GenerationJob> {
    return this.jobs.setArchiveWarning(draftId, generationIdValue, warning);
  }
}
