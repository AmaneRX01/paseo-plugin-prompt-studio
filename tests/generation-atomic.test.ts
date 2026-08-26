import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Module from "node:module";
import test from "node:test";
import type { DraftDetail, DraftScope } from "../src/shared/contracts.shared";
import type { GenerationJob, GenerationJobRecord } from "../src/shared/generation.shared";
import type { PromptStudioStore as PromptStudioStoreType } from "../src/server/store.server";
import type { GenerationRepository as GenerationRepositoryType } from "../src/server/storage/generations.server";
import type { GenerationApplyJournal } from "../src/server/storage/model.server";

const moduleInternals = Module as unknown as {
  _resolveFilename(request: string, parent: unknown, isMain: boolean, options: unknown): string;
};
const originalResolveFilename = moduleInternals._resolveFilename;
moduleInternals._resolveFilename = function resolveTestVirtualModule(request, parent, isMain, options) {
  if (request === "@getpaseo/plugin/server") return path.join(import.meta.dirname, "plugin-server.stub.cjs");
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

let PromptStudioStore: typeof PromptStudioStoreType;
let GenerationRepository: typeof GenerationRepositoryType;
let checkpointDocument: typeof import("../src/server/storage/checkpoints.server").checkpointDocument;
let compactTimestamp: typeof import("../src/server/storage/filesystem.server").compactTimestamp;
let generationApplyJournalSchema: typeof import("../src/server/storage/model.server").generationApplyJournalSchema;
let hash: typeof import("../src/server/storage/filesystem.server").hash;
let MAX_DRAFT_MARKDOWN_LENGTH: number;

test.before(async () => {
  ({ PromptStudioStore } = await import("../src/server/store.server"));
  ({ GenerationRepository } = await import("../src/server/storage/generations.server"));
  ({ checkpointDocument } = await import("../src/server/storage/checkpoints.server"));
  ({ compactTimestamp, hash } = await import("../src/server/storage/filesystem.server"));
  ({ generationApplyJournalSchema } = await import("../src/server/storage/model.server"));
  ({ MAX_DRAFT_MARKDOWN_LENGTH } = await import("../src/shared/contracts.shared"));
});

const projectScope: DraftScope = {
  projectId: "prj_generation_atomic",
  projectName: "Generation Atomic",
};

const zeroCounts = {
  eligibleOtherPromptCount: 0,
  includedOtherPromptCount: 0,
  eligibleReferenceVersionCount: 0,
  includedReferenceVersionCount: 0,
  eligibleTargetHistoryVersionCount: 0,
  includedTargetHistoryVersionCount: 0,
  truncated: false,
  estimatedInputTokens: 100,
  inputTokenBudget: 16_000,
} as const;

async function doesNotExist(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return false;
  } catch {
    return true;
  }
}

async function makeFixture(
  t: test.TestContext,
  markdown = "base body",
): Promise<{ root: string; store: PromptStudioStoreType; draft: DraftDetail }> {
  const root = await mkdtemp(path.join(tmpdir(), "prompt-studio-generation-atomic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new PromptStudioStore(root);
  await store.ensureContainer(null);
  const draft = await store.createDraft("ct_inbox", projectScope, "Generated atomically", markdown);
  return { root, store, draft };
}

function generationRecord(
  draft: DraftDetail,
  requestMarkdown: string,
  generationId = "gn_111111111111111111111111",
): GenerationJobRecord {
  const at = "2026-08-26T01:00:00.000Z";
  return {
    schemaVersion: 1,
    id: generationId as GenerationJobRecord["id"],
    draftId: draft.summary.id,
    task: "related",
    status: "prepared",
    baseVersion: draft.summary.version,
    baseHash: draft.summary.contentHash,
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
    configuration: { provider: "codex", model: "gpt-test", thinkingOptionId: null },
    project: {
      projectId: projectScope.projectId!,
      projectName: projectScope.projectName!,
      workspaceId: "wks_generation_atomic",
    },
    counts: { ...zeroCounts },
    includedSources: [],
    protection: {
      level: "behavioral-only",
      projectRead: false,
      warning: "fixture",
    },
    requestId: `prompt-studio:generation:${generationId}:create`,
    clientMessageId: `prompt-studio:generation:${generationId}:message`,
    requestHash: hash(requestMarkdown),
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
  };
}

async function prepareGeneration(
  root: string,
  store: PromptStudioStoreType,
  draft: DraftDetail,
  generationId = "gn_111111111111111111111111",
): Promise<{ repository: GenerationRepositoryType; job: GenerationJob }> {
  const requestMarkdown = `request for ${generationId}`;
  const prepared = await store.prepareGenerationJob({
    record: generationRecord(draft, requestMarkdown, generationId),
    requestMarkdown,
    expectedProjectId: projectScope.projectId!,
  });
  const repository = new GenerationRepository(root);
  const claim = await repository.claimLaunch(draft.summary.id, prepared.id);
  assert.equal(claim.claimed, true);
  const job = await repository.markRunning(draft.summary.id, prepared.id, "agt_generation_atomic");
  return { repository, job };
}

async function createConflict(
  fixture: { root: string; store: PromptStudioStoreType; draft: DraftDetail },
  response = "generated candidate",
): Promise<{ repository: GenerationRepositoryType; job: GenerationJob; draft: DraftDetail }> {
  const prepared = await prepareGeneration(fixture.root, fixture.store, fixture.draft);
  const markdownPath = path.join(fixture.root, "drafts", fixture.draft.summary.id, "draft.md");
  await writeFile(markdownPath, "newer third-party body", "utf8");
  const newer = await fixture.store.getDraft(fixture.draft.summary.id);
  const committed = await fixture.store.commitGenerationResponse({
    draftId: fixture.draft.summary.id,
    generationId: prepared.job.id,
    responseMarkdown: response,
    agentId: "agt_generation_atomic",
  });
  assert.equal(committed.job.status, "conflict");
  assert.equal(committed.draft.markdown, newer.markdown);
  return { repository: prepared.repository, job: committed.job, draft: committed.draft };
}

test("captured responses normalize CRLF, apply atomically, and retain the pre-generation checkpoint", async (t) => {
  const fixture = await makeFixture(t, "original body");
  const ready = (await fixture.store.transitionDraft({
    draftId: fixture.draft.summary.id,
    targetStatus: "ready",
    expectedVersion: fixture.draft.summary.version,
    expectedHash: fixture.draft.summary.contentHash,
  })).draft;
  const prepared = await prepareGeneration(fixture.root, fixture.store, ready);
  const result = await fixture.store.commitGenerationResponse({
    draftId: ready.summary.id,
    generationId: prepared.job.id,
    responseMarkdown: "first\r\nsecond\rthird\n",
    agentId: "agt_generation_atomic",
  });

  assert.equal(result.job.status, "applied");
  assert.equal(result.job.responseMarkdown, "first\nsecond\nthird\n");
  assert.equal(result.draft.markdown, "first\nsecond\nthird\n");
  assert.equal(result.draft.summary.status, "draft");
  assert.equal(result.draft.summary.contentOrigin.kind, "generated");
  assert.ok(result.job.checkpointId);
  const checkpoint = await fixture.store.getCheckpoint(ready.summary.id, result.job.checkpointId!);
  assert.equal(checkpoint.reason, "before-generation");
  assert.equal(checkpoint.markdown, "original body");
  assert.equal(await doesNotExist(path.join(
    fixture.root,
    ".transactions",
    `generation-apply-${ready.summary.id}-${prepared.job.id}.json`,
  )), true);
});

test("the 500,000-character Draft limit is inclusive and an oversized response fails without changing the Draft", async (t) => {
  await t.test("exact limit applies", async (child) => {
    const fixture = await makeFixture(child);
    const prepared = await prepareGeneration(fixture.root, fixture.store, fixture.draft);
    const response = "x".repeat(MAX_DRAFT_MARKDOWN_LENGTH);
    const result = await fixture.store.commitGenerationResponse({
      draftId: fixture.draft.summary.id,
      generationId: prepared.job.id,
      responseMarkdown: response,
      agentId: "agt_generation_atomic",
    });
    assert.equal(result.job.status, "applied");
    assert.equal(result.draft.markdown.length, MAX_DRAFT_MARKDOWN_LENGTH);
  });

  await t.test("over limit is durable failure", async (child) => {
    const fixture = await makeFixture(child);
    const prepared = await prepareGeneration(fixture.root, fixture.store, fixture.draft);
    const result = await fixture.store.commitGenerationResponse({
      draftId: fixture.draft.summary.id,
      generationId: prepared.job.id,
      responseMarkdown: "x".repeat(MAX_DRAFT_MARKDOWN_LENGTH + 1),
      agentId: "agt_generation_atomic",
    });
    assert.equal(result.job.status, "failed");
    assert.match(result.job.error ?? "", /500000-character Draft limit/i);
    assert.equal(result.draft.markdown, fixture.draft.markdown);
    assert.equal(result.draft.summary.version, fixture.draft.summary.version);
    assert.equal(await doesNotExist(path.join(
      fixture.root,
      ".transactions",
      `generation-apply-${fixture.draft.summary.id}-${prepared.job.id}.json`,
    )), true);
  });
});

test("a concurrent body edit becomes a candidate and explicit apply checkpoints the latest body", async (t) => {
  const fixture = await makeFixture(t);
  const conflict = await createConflict(fixture);
  assert.equal(conflict.draft.markdown, "newer third-party body");
  assert.deepEqual(conflict.draft.summary.contentOrigin, { kind: "manual" });

  const applied = await fixture.store.applyGenerationCandidate({
    draftId: conflict.draft.summary.id,
    generationId: conflict.job.id,
    expectedVersion: conflict.draft.summary.version,
    expectedHash: conflict.draft.summary.contentHash,
  });
  assert.equal(applied.job.status, "applied");
  assert.equal(applied.draft.markdown, "generated candidate");
  assert.ok(applied.job.checkpointId);
  const checkpoint = await fixture.store.getCheckpoint(applied.draft.summary.id, applied.job.checkpointId!);
  assert.equal(checkpoint.markdown, "newer third-party body");
});

test("discard racing applyCandidate has one terminal winner and discarded content never overwrites the Draft", async (t) => {
  const fixture = await makeFixture(t);
  const conflict = await createConflict(fixture, "racing generated candidate");
  const secondStore = new PromptStudioStore(fixture.root);
  await secondStore.getDraft(fixture.draft.summary.id);

  const outcomes = await Promise.allSettled([
    fixture.store.applyGenerationCandidate({
      draftId: fixture.draft.summary.id,
      generationId: conflict.job.id,
      expectedVersion: conflict.draft.summary.version,
      expectedHash: conflict.draft.summary.contentHash,
    }),
    secondStore.discardGeneration(fixture.draft.summary.id, conflict.job.id),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 1);

  const finalJob = await conflict.repository.get(fixture.draft.summary.id, conflict.job.id);
  const finalDraft = await new PromptStudioStore(fixture.root).getDraft(fixture.draft.summary.id);
  assert.ok(finalJob.status === "applied" || finalJob.status === "discarded");
  if (finalJob.status === "discarded") {
    assert.equal(finalDraft.markdown, "newer third-party body");
    assert.deepEqual(finalDraft.summary.contentOrigin, { kind: "manual" });
  } else {
    assert.equal(finalDraft.markdown, "racing generated candidate");
    assert.equal(finalDraft.summary.contentOrigin.kind, "generated");
  }
  assert.equal(await doesNotExist(path.join(
    fixture.root,
    ".transactions",
    `generation-apply-${fixture.draft.summary.id}-${conflict.job.id}.json`,
  )), true);
});

interface ManualJournalFixture {
  root: string;
  store: PromptStudioStoreType;
  draft: DraftDetail;
  repository: GenerationRepositoryType;
  job: GenerationJob;
  journal: GenerationApplyJournal;
  journalPath: string;
  metaPath: string;
  markdownPath: string;
  checkpointPath: string;
}

async function makeManualJournalFixture(t: test.TestContext): Promise<ManualJournalFixture> {
  const fixture = await makeFixture(t, "journal base body");
  const prepared = await prepareGeneration(fixture.root, fixture.store, fixture.draft);
  const job = await prepared.repository.captureResponse(
    fixture.draft.summary.id,
    prepared.job.id,
    "journal generated body",
    "agt_generation_atomic",
  );
  const draftRoot = path.join(fixture.root, "drafts", fixture.draft.summary.id);
  const metaPath = path.join(draftRoot, "meta.json");
  const markdownPath = path.join(draftRoot, "draft.md");
  const beforeMeta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
  const at = "2026-08-26T02:00:00.000Z";
  const checkpoint = {
    id: "cp_999999999999999999999999",
    draftId: fixture.draft.summary.id,
    reason: "before-generation",
    at,
    version: fixture.draft.summary.version,
    contentHash: hash("journal base body"),
  };
  const nextMeta = {
    ...beforeMeta,
    schemaVersion: 5,
    version: fixture.draft.summary.version + 1,
    contentHash: hash("journal generated body"),
    updatedAt: at,
    lastCheckpointAt: at,
    contentOrigin: {
      kind: "generated",
      task: "related",
      generationId: job.id,
      at,
      agentId: "agt_generation_atomic",
      provider: "codex",
      model: "gpt-test",
      includedPromptCount: 0,
      includedVersionCount: 0,
    },
  };
  const journal = generationApplyJournalSchema.parse({
    schemaVersion: 1,
    operation: "generation-apply",
    draftId: fixture.draft.summary.id,
    generationId: job.id,
    checkpoint,
    beforeMeta,
    beforeMarkdown: "journal base body",
    nextMeta,
    responseHash: job.responseHash,
    createdAt: at,
  });
  const journalPath = path.join(
    fixture.root,
    ".transactions",
    `generation-apply-${fixture.draft.summary.id}-${job.id}.json`,
  );
  const checkpointPath = path.join(
    draftRoot,
    "checkpoints",
    `${compactTimestamp(at)}-${checkpoint.id}.md`,
  );
  await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  return {
    ...fixture,
    repository: prepared.repository,
    job,
    journal,
    journalPath,
    metaPath,
    markdownPath,
    checkpointPath,
  };
}

test("generation-apply journal recovery completes every partial commit stage exactly once", async (t) => {
  for (const phase of ["journal-only", "body-only", "meta-only", "checkpoint-and-body"] as const) {
    await t.test(phase, async (child) => {
      const fixture = await makeManualJournalFixture(child);
      if (phase === "body-only" || phase === "checkpoint-and-body") {
        await writeFile(fixture.markdownPath, "journal generated body", "utf8");
      }
      if (phase === "meta-only") {
        await writeFile(fixture.metaPath, `${JSON.stringify(fixture.journal.nextMeta, null, 2)}\n`, "utf8");
      }
      if (phase === "checkpoint-and-body") {
        await writeFile(
          fixture.checkpointPath,
          checkpointDocument(fixture.journal.checkpoint, fixture.journal.beforeMarkdown),
          "utf8",
        );
      }

      const recovered = new PromptStudioStore(fixture.root);
      const draft = await recovered.getDraft(fixture.draft.summary.id);
      const job = await new GenerationRepository(fixture.root).get(fixture.draft.summary.id, fixture.job.id);
      assert.equal(draft.markdown, "journal generated body");
      assert.equal(draft.summary.contentHash, hash("journal generated body"));
      assert.equal(draft.summary.contentOrigin.kind, "generated");
      assert.equal(job.status, "applied");
      assert.equal(job.checkpointId, fixture.journal.checkpoint.id);
      assert.equal(await doesNotExist(fixture.journalPath), true);
      assert.equal((await recovered.getCheckpoint(draft.summary.id, fixture.journal.checkpoint.id)).markdown, "journal base body");
      assert.equal(draft.events.filter((event) => event.type === "checkpoint.created"
        && event.details.checkpointId === fixture.journal.checkpoint.id).length, 1);
      assert.equal(draft.events.filter((event) => event.type === "generation.applied"
        && event.details.generationId === fixture.job.id).length, 1);

      const reopened = new PromptStudioStore(fixture.root);
      const secondRead = await reopened.getDraft(fixture.draft.summary.id);
      assert.equal(secondRead.events.filter((event) => event.type === "checkpoint.created"
        && event.details.checkpointId === fixture.journal.checkpoint.id).length, 1);
      assert.equal(secondRead.events.filter((event) => event.type === "generation.applied"
        && event.details.generationId === fixture.job.id).length, 1);
    });
  }
});

test("journal recovery merges tag-only metadata written after the generated body", async (t) => {
  const fixture = await makeManualJournalFixture(t);
  await writeFile(fixture.markdownPath, "journal generated body", "utf8");
  const taggedMeta = {
    ...fixture.journal.beforeMeta,
    tags: ["Recovery/Keep"],
  };
  await writeFile(fixture.metaPath, `${JSON.stringify(taggedMeta, null, 2)}\n`, "utf8");

  const recovered = new PromptStudioStore(fixture.root);
  const draft = await recovered.getDraft(fixture.draft.summary.id);
  const job = await new GenerationRepository(fixture.root).get(fixture.draft.summary.id, fixture.job.id);
  assert.equal(job.status, "applied");
  assert.equal(draft.markdown, "journal generated body");
  assert.deepEqual(draft.summary.tags, ["Recovery/Keep"]);
  assert.equal(draft.summary.contentOrigin.kind, "generated");
  assert.equal(await doesNotExist(fixture.journalPath), true);
});

test("journal recovery rolls back a written generated body when non-tag metadata changed", async (t) => {
  const fixture = await makeManualJournalFixture(t);
  await writeFile(fixture.markdownPath, "journal generated body", "utf8");
  const renamedMeta = {
    ...fixture.journal.beforeMeta,
    title: "Externally renamed during crash",
  };
  await writeFile(fixture.metaPath, `${JSON.stringify(renamedMeta, null, 2)}\n`, "utf8");

  const recovered = new PromptStudioStore(fixture.root);
  const draft = await recovered.getDraft(fixture.draft.summary.id);
  const job = await new GenerationRepository(fixture.root).get(fixture.draft.summary.id, fixture.job.id);
  assert.equal(job.status, "conflict");
  assert.equal(job.responseMarkdown, "journal generated body");
  assert.equal(draft.markdown, "journal base body");
  assert.equal(draft.summary.title, "Externally renamed during crash");
  assert.deepEqual(draft.summary.contentOrigin, { kind: "manual" });
  assert.equal(await doesNotExist(fixture.journalPath), true);
});

test("journal recovery preserves a third-party body as a conflict candidate and clears the journal", async (t) => {
  const fixture = await makeManualJournalFixture(t);
  await writeFile(fixture.markdownPath, "third-party body during crash", "utf8");

  const recovered = new PromptStudioStore(fixture.root);
  const draft = await recovered.getDraft(fixture.draft.summary.id);
  const job = await new GenerationRepository(fixture.root).get(fixture.draft.summary.id, fixture.job.id);
  assert.equal(job.status, "conflict");
  assert.equal(job.responseMarkdown, "journal generated body");
  assert.equal(draft.markdown, "third-party body during crash");
  assert.deepEqual(draft.summary.contentOrigin, { kind: "manual" });
  assert.equal(await doesNotExist(fixture.journalPath), true);
  assert.equal(await doesNotExist(fixture.checkpointPath), true);
  assert.ok(draft.events.some((event) => event.type === "generation.conflict"
    && event.details.generationId === fixture.job.id
    && event.details.reason === "interrupted-apply-external-change"));
});

test("an unresolved generation blocks every Draft mutation and both new and retry dispatch", async (t) => {
  const fixture = await makeFixture(t, "locked body");
  const ready = (await fixture.store.transitionDraft({
    draftId: fixture.draft.summary.id,
    targetStatus: "ready",
    expectedVersion: fixture.draft.summary.version,
    expectedHash: fixture.draft.summary.contentHash,
  })).draft;
  const readyCheckpoint = ready.checkpoints.find((checkpoint) => checkpoint.reason === "ready");
  assert.ok(readyCheckpoint);
  const dispatch = await fixture.store.prepareDispatch(ready.summary.id, {
    kind: "existing_agent",
    agentId: "agt_dispatch_before_generation",
  });
  await fixture.store.finalizeDispatch(ready.summary.id, dispatch.dispatch.id, {
    status: "failed",
    error: "fixture failure",
    agentId: "agt_dispatch_before_generation",
  });
  const current = await fixture.store.getDraft(ready.summary.id);
  await fixture.store.prepareGenerationJob({
    record: generationRecord(current, "locking request"),
    requestMarkdown: "locking request",
    expectedProjectId: projectScope.projectId!,
  });
  const anotherSource = {
    projectId: "prj_generation_other",
    workspaceId: "wks_generation_other",
    rootPath: path.resolve("D:\\generation-other"),
    name: "Generation Other",
  };
  const anotherContainer = await fixture.store.ensureContainer(anotherSource);
  const blocked = /while generation .* is prepared/i;

  await assert.rejects(fixture.store.autosaveDraft({
    draftId: current.summary.id,
    title: current.summary.title,
    markdown: "blocked edit",
    expectedVersion: current.summary.version,
    expectedHash: current.summary.contentHash,
  }), blocked);
  await assert.rejects(fixture.store.moveDraftScope(
    current.summary.id,
    anotherContainer.summary.id,
    { projectId: anotherSource.projectId, projectName: anotherSource.name },
  ), blocked);
  await assert.rejects(fixture.store.transitionDraft({
    draftId: current.summary.id,
    targetStatus: "draft",
    expectedVersion: current.summary.version,
    expectedHash: current.summary.contentHash,
  }), blocked);
  await assert.rejects(fixture.store.transitionDraft({
    draftId: current.summary.id,
    targetStatus: "archived",
    expectedVersion: current.summary.version,
    expectedHash: current.summary.contentHash,
  }), blocked);
  await assert.rejects(fixture.store.prepareDispatch(current.summary.id, {
    kind: "existing_agent",
    agentId: "agt_new_dispatch_blocked",
  }), blocked);
  await assert.rejects(fixture.store.markDispatchAttempt(current.summary.id, dispatch.dispatch.id), blocked);
  await assert.rejects(fixture.store.deleteDraft({
    draftId: current.summary.id,
    confirmationDraftId: current.summary.id,
    expectedVersion: current.summary.version,
    expectedHash: current.summary.contentHash,
  }), blocked);
  await assert.rejects(fixture.store.restoreCheckpoint({
    draftId: current.summary.id,
    checkpointId: readyCheckpoint.id,
    expectedVersion: current.summary.version,
    expectedHash: current.summary.contentHash,
  }), blocked);

  const unchanged = await fixture.store.getDraft(current.summary.id);
  assert.equal(unchanged.markdown, current.markdown);
  assert.equal(unchanged.summary.version, current.summary.version);
  assert.equal(unchanged.summary.scope.projectId, current.summary.scope.projectId);
  assert.equal(unchanged.summary.status, current.summary.status);
  assert.equal((await readdir(path.join(fixture.root, "drafts", current.summary.id, "snapshots")))
    .filter((name) => name.endsWith(".json")).length, 1);
});
