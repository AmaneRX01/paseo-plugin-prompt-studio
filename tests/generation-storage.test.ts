import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Module from "node:module";
import test from "node:test";
import type { DraftId } from "../src/shared/contracts.shared";
import type { GenerationJobRecord } from "../src/shared/generation.shared";

const moduleInternals = Module as unknown as {
  _resolveFilename(request: string, parent: unknown, isMain: boolean, options: unknown): string;
};
const originalResolveFilename = moduleInternals._resolveFilename;
moduleInternals._resolveFilename = function resolveTestVirtualModule(request, parent, isMain, options) {
  if (request === "@getpaseo/plugin/server") return path.join(import.meta.dirname, "plugin-server.stub.cjs");
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

let checkpointDocument: typeof import("../src/server/storage/checkpoints.server").checkpointDocument;
let listCheckpointContents: typeof import("../src/server/storage/checkpoints.server").listCheckpointContents;
let hash: typeof import("../src/server/storage/filesystem.server").hash;
let acquireCrossProcessFileLock: typeof import("../src/server/storage/generations.server").acquireCrossProcessFileLock;
let GenerationRepository: typeof import("../src/server/storage/generations.server").GenerationRepository;
let GenerationSettingsRepository: typeof import("../src/server/storage/generations.server").GenerationSettingsRepository;
let generationStartRpc: typeof import("../src/shared/generation.shared").generationStartRpc;
let generationSyncRpc: typeof import("../src/shared/generation.shared").generationSyncRpc;
test.before(async () => {
  ({ checkpointDocument, listCheckpointContents } = await import("../src/server/storage/checkpoints.server"));
  ({ hash } = await import("../src/server/storage/filesystem.server"));
  ({
    acquireCrossProcessFileLock,
    GenerationRepository,
    GenerationSettingsRepository,
  } = await import("../src/server/storage/generations.server"));
  ({ generationStartRpc, generationSyncRpc } = await import("../src/shared/generation.shared"));
});

const draftId = "dr_1111111111111111" as DraftId;
const firstGenerationId = "gn_111111111111111111111111" as const;

async function createVault(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "prompt-studio-generation-"));
  await mkdir(path.join(root, "drafts", draftId), { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function record(
  requestMarkdown: string,
  overrides: Partial<GenerationJobRecord> = {},
): GenerationJobRecord {
  return {
    schemaVersion: 1,
    id: firstGenerationId,
    draftId,
    task: "related",
    status: "prepared",
    baseVersion: 1,
    baseHash: hash("base"),
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
    project: { projectId: "project-1", projectName: "Project One", workspaceId: "workspace-1" },
    counts: {
      eligibleOtherPromptCount: 0,
      includedOtherPromptCount: 0,
      eligibleReferenceVersionCount: 0,
      includedReferenceVersionCount: 0,
      eligibleTargetHistoryVersionCount: 0,
      includedTargetHistoryVersionCount: 0,
      truncated: false,
      estimatedInputTokens: 100,
      inputTokenBudget: 16_000,
    },
    includedSources: [],
    protection: { level: "native-policy", projectRead: false, warning: null },
    requestId: `prompt-studio:generation:${firstGenerationId}`,
    clientMessageId: `prompt-studio:generation:${firstGenerationId}`,
    requestHash: hash(requestMarkdown),
    responseHash: null,
    responseCapturedAt: null,
    agentId: null,
    checkpointId: null,
    appliedVersion: null,
    appliedHash: null,
    error: null,
    archiveWarning: null,
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

test("generation repository atomically stores immutable requests and hydrates captured responses", async (t) => {
  const root = await createVault(t);
  let tick = 0;
  const repository = new GenerationRepository(root, {
    now: () => new Date(Date.UTC(2026, 7, 26, 0, 0, tick++)),
  });
  const request = "frozen generation request";
  const created = await repository.create(record(request), request);
  assert.equal(created.status, "prepared");
  assert.equal(await repository.getRequest(draftId, firstGenerationId), request);
  assert.equal(
    await readFile(path.join(root, "drafts", draftId, "generations", firstGenerationId, "request.md"), "utf8"),
    request,
  );

  const claims = await Promise.all([
    repository.claimLaunch(draftId, firstGenerationId),
    repository.claimLaunch(draftId, firstGenerationId),
  ]);
  assert.equal(claims.filter((claim) => claim.claimed).length, 1);
  await repository.markRunning(draftId, firstGenerationId, "agent-1");
  const captured = await repository.captureResponse(draftId, firstGenerationId, "exact response\r\n", "agent-1");
  assert.equal(captured.status, "result-ready");
  assert.equal(captured.responseMarkdown, "exact response\r\n");
  assert.equal((await repository.get(draftId, firstGenerationId)).responseMarkdown, "exact response\r\n");
  await repository.markConflict(draftId, firstGenerationId, "draft changed");
  const discarded = await repository.discard(draftId, firstGenerationId);
  assert.equal(discarded.status, "discarded");
  assert.ok(discarded.completedAt);
});

test("three repositories clear one dead participant without double-claiming Agent launch", async (t) => {
  const root = await createVault(t);
  const repositories = [
    new GenerationRepository(root),
    new GenerationRepository(root),
    new GenerationRepository(root),
  ];
  const request = "three-way launch claim";
  await repositories[0].create(record(request), request);

  const queuePath = path.join(root, ".locks", `generation-${draftId}.queue-v2`);
  const staleToken = `lp_2147483647_${"a".repeat(32)}`;
  const stalePath = path.join(queuePath, staleToken);
  await mkdir(stalePath, { recursive: true });
  await writeFile(path.join(stalePath, "state.json"), `${JSON.stringify({
    schemaVersion: 1,
    token: staleToken,
    pid: 2_147_483_647,
    choosing: true,
    ticket: null,
    createdAt: "2026-08-26T00:00:00.000Z",
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(stalePath, "ticket.json"), `${JSON.stringify({
    schemaVersion: 1,
    token: staleToken,
    ticket: 1,
  }, null, 2)}\n`, "utf8");

  const claims = await Promise.all(repositories.map((repository) => (
    repository.claimLaunch(draftId, firstGenerationId)
  )));

  assert.equal(claims.filter((claim) => claim.claimed).length, 1);
  assert.equal(claims.filter((claim) => !claim.claimed).length, 2);
  assert.deepEqual(await readdir(queuePath), []);
  assert.equal((await repositories[0].get(draftId, firstGenerationId)).status, "launching");
});

test("an old owner release cannot unlink a later lock participant", async (t) => {
  const root = await createVault(t);
  const key = "aba-release";
  const queuePath = path.join(root, ".locks", `${key}.queue-v2`);
  const releaseFirst = await acquireCrossProcessFileLock(root, key, "busy");
  const [firstToken] = await readdir(queuePath);
  assert.ok(firstToken);

  // Model an external stale-owner cleanup that removed the first owner's
  // unique participant before that owner's delayed finally block runs.
  await rm(path.join(queuePath, firstToken), { recursive: true, force: true });
  const releaseSecond = await acquireCrossProcessFileLock(root, key, "busy");
  const [secondToken] = await readdir(queuePath);
  assert.ok(secondToken);
  assert.notEqual(secondToken, firstToken);

  await releaseFirst();
  assert.deepEqual(await readdir(queuePath), [secondToken]);
  await releaseSecond();
  assert.deepEqual(await readdir(queuePath), []);
});

test("an unresolved generation is single-flight and a terminal generation permits the next job", async (t) => {
  const root = await createVault(t);
  const repository = new GenerationRepository(root);
  const firstRequest = "first request";
  await repository.create(record(firstRequest), firstRequest);
  const secondId = "gn_222222222222222222222222" as const;
  const blocked = await repository.create(record("second request", {
    id: secondId,
    requestId: `prompt-studio:generation:${secondId}`,
    clientMessageId: `prompt-studio:generation:${secondId}`,
    requestHash: hash("second request"),
  }), "second request");
  assert.equal(blocked.id, firstGenerationId);
  assert.equal((await repository.list(draftId)).values.length, 1);

  await repository.abandon(draftId, firstGenerationId);
  const second = await repository.create(record("second request", {
    id: secondId,
    requestId: `prompt-studio:generation:${secondId}`,
    clientMessageId: `prompt-studio:generation:${secondId}`,
    requestHash: hash("second request"),
  }), "second request");
  assert.equal(second.id, secondId);
  assert.equal((await repository.list(draftId)).values.length, 2);
});

test("response capture recovers an identical orphan file and rejects a different one", async (t) => {
  const root = await createVault(t);
  const repository = new GenerationRepository(root);
  const request = "request";
  await repository.create(record(request), request);
  await repository.claimLaunch(draftId, firstGenerationId);
  const responsePath = path.join(root, "drafts", draftId, "generations", firstGenerationId, "response.md");
  await writeFile(responsePath, "orphan response", "utf8");
  const recovered = await repository.captureResponse(draftId, firstGenerationId, "orphan response", "agent-1");
  assert.equal(recovered.responseMarkdown, "orphan response");

  const secondRoot = await createVault(t);
  const secondRepository = new GenerationRepository(secondRoot);
  await secondRepository.create(record(request), request);
  await secondRepository.claimLaunch(draftId, firstGenerationId);
  await writeFile(
    path.join(secondRoot, "drafts", draftId, "generations", firstGenerationId, "response.md"),
    "different response",
    "utf8",
  );
  await assert.rejects(
    secondRepository.captureResponse(draftId, firstGenerationId, "agent response", "agent-1"),
    /conflicts with the Agent response/i,
  );
});

test("generation settings use optimistic versions and persist independent task configurations", async (t) => {
  const root = await createVault(t);
  const repository = new GenerationSettingsRepository(root, {
    now: () => new Date("2026-08-26T00:00:00.000Z"),
  });
  const initial = await repository.get();
  assert.equal(initial.version, 1);
  assert.equal(initial.related, null);
  const updated = await repository.update({
    expectedVersion: initial.version,
    related: { provider: "codex", model: "gpt-5", thinkingOptionId: "high" },
    format: { provider: "kimi", model: "kimi-k2", thinkingOptionId: null },
  });
  assert.equal(updated.version, 2);
  assert.equal((await repository.get()).format?.provider, "kimi");
  await assert.rejects(repository.update({
    expectedVersion: 1,
    related: null,
    format: null,
  }), /settings changed/i);
});

test("independent repository instances tolerate lock-file release races", async (t) => {
  const root = await createVault(t);
  const first = new GenerationRepository(root);
  const second = new GenerationRepository(root);
  const request = "request";
  await first.create(record(request), request);
  await Promise.all(Array.from({ length: 16 }, (_, index) => (
    (index % 2 === 0 ? first : second).setArchiveWarning(
      draftId,
      firstGenerationId,
      `warning-${index}`,
    )
  )));
  assert.match((await first.get(draftId, firstGenerationId)).archiveWarning ?? "", /^warning-\d+$/);
});

test("bulk checkpoint loading returns verified unique bodies and ignores duplicate canonical ids", async (t) => {
  const root = await createVault(t);
  const checkpointRoot = path.join(root, "drafts", draftId, "checkpoints");
  await mkdir(checkpointRoot, { recursive: true });
  const first = {
    id: "cp_111111111111111111111111" as const,
    draftId,
    reason: "periodic" as const,
    at: "2026-08-26T00:00:00.000Z",
    version: 1,
    contentHash: hash("first"),
  };
  const duplicate = {
    ...first,
    contentHash: hash("duplicate"),
  };
  const second = {
    ...first,
    id: "cp_222222222222222222222222" as const,
    at: "2026-08-25T00:00:00.000Z",
    contentHash: hash("second"),
  };
  await writeFile(path.join(checkpointRoot, `a-${first.id}.md`), checkpointDocument(first, "first"), "utf8");
  await writeFile(path.join(checkpointRoot, `b-${first.id}.md`), checkpointDocument(duplicate, "duplicate"), "utf8");
  await writeFile(path.join(checkpointRoot, `c-${second.id}.md`), checkpointDocument(second, "second"), "utf8");
  const loaded = await listCheckpointContents(path.join(root, "drafts", draftId), root, draftId);
  assert.deepEqual(loaded.values.map((value) => value.id), [second.id]);
  assert.match(loaded.warnings.join("\n"), /Duplicate canonical checkpoint id/);
});

test("generation RPC inputs reject client-supplied paths, prompt bodies, and Agent responses", () => {
  const validStart = {
    draftId,
    expectedVersion: 1,
    expectedHash: hash("base"),
    task: "format" as const,
    locale: "en" as const,
    allowProjectRead: false,
    filters: null,
  };
  assert.equal(generationStartRpc.input.safeParse(validStart).success, true);
  assert.equal(generationStartRpc.input.safeParse({ ...validStart, rootPath: "C:\\outside" }).success, false);
  assert.equal(generationStartRpc.input.safeParse({ ...validStart, markdown: "client body" }).success, false);
  const validSync = { draftId, generationId: firstGenerationId };
  assert.equal(generationSyncRpc.input.safeParse(validSync).success, true);
  assert.equal(generationSyncRpc.input.safeParse({ ...validSync, responseMarkdown: "forged response" }).success, false);
});
