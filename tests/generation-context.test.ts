import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import test from "node:test";
import type { CheckpointContent, DraftSummary } from "../src/shared/contracts.shared";
import type {
  GenerationContextFilters,
  GenerationContextFiltersV2,
} from "../src/shared/generation.shared";
import type { GenerationContextDraft } from "../src/server/generation-context.server";

const moduleInternals = Module as unknown as {
  _resolveFilename(request: string, parent: unknown, isMain: boolean, options: unknown): string;
};
const originalResolveFilename = moduleInternals._resolveFilename;
moduleInternals._resolveFilename = function resolveTestVirtualModule(request, parent, isMain, options) {
  if (request === "@getpaseo/plugin/server") return path.join(import.meta.dirname, "plugin-server.stub.cjs");
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

let buildGenerationContext: typeof import("../src/server/generation-context.server").buildGenerationContext;
let estimateGenerationTokens: typeof import("../src/server/generation-context.server").estimateGenerationTokens;
let hash: typeof import("../src/server/storage/filesystem.server").hash;
test.before(async () => {
  ({ buildGenerationContext, estimateGenerationTokens } = await import("../src/server/generation-context.server"));
  ({ hash } = await import("../src/server/storage/filesystem.server"));
});

const now = new Date("2026-08-26T12:00:00.000Z");
const projectScope = { projectId: "project-1", projectName: "Project One" };

function summary(input: {
  id: string;
  markdown: string;
  title?: string;
  tags?: string[];
  projectId?: string | null;
  projectName?: string | null;
  updatedAt?: string;
  status?: "draft" | "ready" | "archived";
}): DraftSummary {
  return {
    schemaVersion: 5,
    id: input.id as DraftSummary["id"],
    containerId: "ct_inbox",
    title: input.title ?? input.id,
    status: input.status ?? "draft",
    tags: input.tags ?? [],
    scope: {
      projectId: input.projectId === undefined ? projectScope.projectId : input.projectId,
      projectName: input.projectName === undefined ? projectScope.projectName : input.projectName,
    },
    version: 1,
    contentHash: hash(input.markdown),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-08-25T00:00:00.000Z",
    archivedAt: input.status === "archived" ? "2026-08-25T01:00:00.000Z" : null,
    archivedFromStatus: input.status === "archived" ? "draft" : null,
    lastCheckpointAt: null,
    snapshotCount: 0,
    dispatchCount: 0,
    contentOrigin: { kind: "manual" },
    preview: input.markdown,
  };
}

function checkpoint(
  draftId: string,
  id: string,
  markdown: string,
  at = "2026-08-24T00:00:00.000Z",
): CheckpointContent {
  return {
    id: id as CheckpointContent["id"],
    draftId: draftId as CheckpointContent["draftId"],
    reason: "periodic",
    at,
    version: 1,
    contentHash: hash(markdown),
    markdown,
  };
}

function draft(
  id: string,
  markdown: string,
  options: Omit<Parameters<typeof summary>[0], "id" | "markdown"> = {},
  checkpoints: CheckpointContent[] = [],
): GenerationContextDraft {
  return { summary: summary({ id, markdown, ...options }), markdown, checkpoints };
}

function filters(overrides: Partial<GenerationContextFilters> = {}): GenerationContextFilters {
  return {
    includeHistory: true,
    timeRange: "90d",
    tagPaths: ["Code"],
    crossProject: false,
    projectIds: [],
    includeInbox: false,
    ...overrides,
  };
}

function sourceFilters(overrides: {
  targetCheckpoints?: Partial<GenerationContextFiltersV2["targetCheckpoints"]>;
  projectPrompts?: Partial<GenerationContextFiltersV2["projectPrompts"]>;
  tagPrompts?: Partial<GenerationContextFiltersV2["tagPrompts"]>;
} = {}): GenerationContextFiltersV2 {
  return {
    schemaVersion: 2,
    targetCheckpoints: {
      enabled: true,
      timeRange: "90d",
      ...overrides.targetCheckpoints,
    },
    projectPrompts: {
      enabled: true,
      timeRange: "90d",
      projectIds: ["project-1"],
      includeInbox: false,
      ...overrides.projectPrompts,
    },
    tagPrompts: {
      enabled: true,
      timeRange: "90d",
      tagPaths: ["Code"],
      ...overrides.tagPrompts,
    },
  };
}

test("related context filters by current tags and project, deduplicates checkpoint bodies, and reports exact counts", () => {
  const targetId = "dr_1111111111111111";
  const target = draft(targetId, "TARGET CURRENT", { tags: ["Code/API"] }, [
    checkpoint(targetId, "cp_111111111111111111111111", "TARGET CURRENT"),
    checkpoint(targetId, "cp_222222222222222222222222", "TARGET HISTORY"),
  ]);
  const includedId = "dr_2222222222222222";
  const included = draft(includedId, "RELATED CURRENT", { tags: ["Code/Backend"] }, [
    checkpoint(includedId, "cp_333333333333333333333333", "RELATED CURRENT"),
    checkpoint(includedId, "cp_444444444444444444444444", "RELATED HISTORY"),
  ]);
  const wrongProject = draft("dr_3333333333333333", "WRONG PROJECT", {
    tags: ["Code"],
    projectId: "project-2",
    projectName: "Project Two",
  });
  const wrongTag = draft("dr_4444444444444444", "WRONG TAG", { tags: ["Writing"] });
  const archived = draft("dr_5555555555555555", "ARCHIVED", { tags: ["Code"], status: "archived" });

  const result = buildGenerationContext({
    task: "related",
    locale: "en",
    target,
    candidates: [wrongProject, wrongTag, archived, included],
    filters: filters(),
    allowProjectRead: false,
    forbiddenVaultPath: "C:\\vault",
    modelContextWindowTokens: 64_000,
    now,
    entropy: () => "fixed-boundary",
  });

  assert.match(result.requestMarkdown, /TARGET CURRENT/);
  assert.match(result.requestMarkdown, /TARGET HISTORY/);
  assert.match(result.requestMarkdown, /RELATED CURRENT/);
  assert.match(result.requestMarkdown, /RELATED HISTORY/);
  assert.doesNotMatch(result.requestMarkdown, /WRONG PROJECT|WRONG TAG|ARCHIVED/);
  assert.doesNotMatch(
    result.requestMarkdown,
    /dr_1111111111111111|dr_2222222222222222|cp_222222222222222222222222|sha256:/,
  );
  assert.deepEqual(result.counts, {
    eligibleOtherPromptCount: 1,
    includedOtherPromptCount: 1,
    eligibleReferenceVersionCount: 2,
    includedReferenceVersionCount: 2,
    eligibleTargetHistoryVersionCount: 1,
    includedTargetHistoryVersionCount: 1,
    truncated: false,
    estimatedInputTokens: result.counts.estimatedInputTokens,
    inputTokenBudget: 32_000,
  });
  assert.equal(result.includedSources.length, 3);
});

test("cross-project selection can include selected Projects and Inbox while excluding unselected Projects", () => {
  const target = draft("dr_1111111111111111", "TARGET", { tags: [] });
  const selected = draft("dr_2222222222222222", "SELECTED", {
    projectId: "project-2",
    projectName: "Project Two",
  });
  const inbox = draft("dr_3333333333333333", "INBOX", { projectId: null, projectName: null });
  const unselected = draft("dr_4444444444444444", "UNSELECTED", {
    projectId: "project-3",
    projectName: "Project Three",
  });
  const result = buildGenerationContext({
    task: "related",
    locale: "en",
    target,
    candidates: [selected, inbox, unselected],
    filters: filters({
      includeHistory: false,
      tagPaths: [],
      crossProject: true,
      projectIds: ["project-2"],
      includeInbox: true,
    }),
    allowProjectRead: false,
    forbiddenVaultPath: "C:\\vault",
    now,
    entropy: () => "fixed",
  });
  assert.match(result.requestMarkdown, /SELECTED/);
  assert.match(result.requestMarkdown, /INBOX/);
  assert.doesNotMatch(result.requestMarkdown, /UNSELECTED/);
  assert.equal(result.counts.includedOtherPromptCount, 2);
});

test("source-specific filters union selected Projects and tags without including related checkpoints", () => {
  const target = draft("dr_1111111111111111", "TARGET", { tags: ["Code"] });
  const projectOnlyId = "dr_2222222222222222";
  const projectOnly = draft(projectOnlyId, "PROJECT ONLY", {
    projectId: "project-2",
    projectName: "Project Two",
    tags: ["Writing"],
  }, [checkpoint(projectOnlyId, "cp_111111111111111111111111", "PROJECT HISTORY")]);
  const tagOnly = draft("dr_3333333333333333", "TAG ONLY", {
    projectId: "project-3",
    projectName: "Project Three",
    tags: ["Code/API"],
  });
  const both = draft("dr_4444444444444444", "BOTH SOURCES", {
    projectId: "project-2",
    projectName: "Project Two",
    tags: ["Code"],
  });
  const unrelated = draft("dr_5555555555555555", "UNRELATED", {
    projectId: "project-4",
    projectName: "Project Four",
    tags: ["Writing"],
  });

  const result = buildGenerationContext({
    task: "related",
    locale: "en",
    target,
    candidates: [projectOnly, tagOnly, both, unrelated],
    filters: sourceFilters({
      targetCheckpoints: { enabled: false },
      projectPrompts: { projectIds: ["project-2"], timeRange: "all" },
      tagPrompts: { tagPaths: ["Code"], timeRange: "all" },
    }),
    allowProjectRead: false,
    forbiddenVaultPath: "C:\\vault",
    now,
    entropy: () => "fixed",
  });

  assert.match(result.requestMarkdown, /PROJECT ONLY|TAG ONLY|BOTH SOURCES/);
  assert.doesNotMatch(result.requestMarkdown, /PROJECT HISTORY|UNRELATED/);
  assert.equal(result.counts.eligibleOtherPromptCount, 3);
  assert.equal(result.counts.eligibleReferenceVersionCount, 3);
  assert.equal(result.includedSources.length, 3, "a prompt matching both sources must be deduplicated");
});

test("each source applies its own time range", () => {
  const targetId = "dr_1111111111111111";
  const target = draft(targetId, "TARGET", { tags: [] }, [
    checkpoint(targetId, "cp_111111111111111111111111", "TARGET 10 DAYS", "2026-08-16T12:00:00.000Z"),
    checkpoint(targetId, "cp_222222222222222222222222", "TARGET TOO OLD", "2026-07-01T00:00:00.000Z"),
  ]);
  const projectExpiredButTagFresh = draft("dr_2222222222222222", "TAG RANGE WINS", {
    projectId: "project-2",
    projectName: "Project Two",
    tags: ["Code"],
    updatedAt: "2026-08-16T12:00:00.000Z",
  });
  const tagExpired = draft("dr_3333333333333333", "TAG TOO OLD", {
    projectId: "project-3",
    projectName: "Project Three",
    tags: ["Code"],
    updatedAt: "2026-08-01T00:00:00.000Z",
  });

  const result = buildGenerationContext({
    task: "related",
    locale: "en",
    target,
    candidates: [projectExpiredButTagFresh, tagExpired],
    filters: sourceFilters({
      targetCheckpoints: { timeRange: "14d" },
      projectPrompts: { projectIds: ["project-2"], timeRange: "3d" },
      tagPrompts: { tagPaths: ["Code"], timeRange: "14d" },
    }),
    allowProjectRead: false,
    forbiddenVaultPath: "C:\\vault",
    now,
    entropy: () => "fixed",
  });

  assert.match(result.requestMarkdown, /TARGET 10 DAYS|TAG RANGE WINS/);
  assert.doesNotMatch(result.requestMarkdown, /TARGET TOO OLD|TAG TOO OLD/);
  assert.equal(result.counts.eligibleOtherPromptCount, 1);
  assert.equal(result.counts.eligibleTargetHistoryVersionCount, 1);
});

test("time filtering applies per version and a qualifying checkpoint does not pull in an expired current body", () => {
  const target = draft("dr_1111111111111111", "TARGET", { tags: ["Code"] }, [
    checkpoint(
      "dr_1111111111111111",
      "cp_111111111111111111111111",
      "TARGET TOO OLD",
      "2026-05-28T11:59:59.999Z",
    ),
  ]);
  const candidateId = "dr_2222222222222222";
  const candidate = draft(candidateId, "EXPIRED CURRENT", {
    tags: ["Code"],
    updatedAt: "2026-05-01T00:00:00.000Z",
  }, [
    checkpoint(candidateId, "cp_222222222222222222222222", "AT CUTOFF", "2026-05-28T12:00:00.000Z"),
    checkpoint(candidateId, "cp_333333333333333333333333", "BEFORE CUTOFF", "2026-05-28T11:59:59.999Z"),
  ]);
  const result = buildGenerationContext({
    task: "related",
    locale: "en",
    target,
    candidates: [candidate],
    filters: filters({ timeRange: "90d" }),
    allowProjectRead: false,
    forbiddenVaultPath: "C:\\vault",
    now,
    entropy: () => "fixed",
  });
  assert.match(result.requestMarkdown, /AT CUTOFF/);
  assert.doesNotMatch(result.requestMarkdown, /EXPIRED CURRENT|BEFORE CUTOFF|TARGET TOO OLD/);
  assert.equal(result.counts.eligibleReferenceVersionCount, 1);
  assert.equal(result.includedSources[0]?.kind, "checkpoint");
});

test("budgeting never partially truncates a reference body and exposes eligible versus included counts", () => {
  const target = draft("dr_1111111111111111", "TARGET", { tags: ["Code"] });
  const baseline = buildGenerationContext({
    task: "related",
    locale: "en",
    target,
    candidates: [],
    filters: filters({ includeHistory: false }),
    allowProjectRead: false,
    forbiddenVaultPath: "C:\\vault",
    now,
    entropy: () => "fixed",
  });
  const referenceBody = `REFERENCE-BEGIN\n${"x".repeat(4_000)}\nREFERENCE-END`;
  const constrained = buildGenerationContext({
    task: "related",
    locale: "en",
    target,
    candidates: [draft("dr_2222222222222222", referenceBody, { tags: ["Code"] })],
    filters: filters({ includeHistory: false }),
    allowProjectRead: false,
    forbiddenVaultPath: "C:\\vault",
    modelContextWindowTokens: (baseline.counts.estimatedInputTokens + 20) * 2,
    now,
    entropy: () => "fixed",
  });
  assert.doesNotMatch(constrained.requestMarkdown, /REFERENCE-BEGIN|REFERENCE-END/);
  assert.equal(constrained.counts.eligibleOtherPromptCount, 1);
  assert.equal(constrained.counts.includedOtherPromptCount, 0);
  assert.equal(constrained.counts.truncated, true);
});

test("format context is Chinese-only, ignores all references, and cannot enable Project access", () => {
  const target = draft("dr_1111111111111111", "请  优化 格式", { tags: ["Code"] });
  const result = buildGenerationContext({
    task: "format",
    locale: "zh",
    target,
    candidates: [draft("dr_2222222222222222", "MUST NOT APPEAR", { tags: ["Code"] })],
    filters: filters(),
    allowProjectRead: false,
    forbiddenVaultPath: "C:\\vault",
    entropy: () => "fixed",
  });
  assert.match(result.systemPrompt, /轻度润色/);
  assert.equal(
    result.counts.estimatedInputTokens,
    estimateGenerationTokens(`${result.systemPrompt}\n${result.requestMarkdown}`),
  );
  assert.doesNotMatch(result.requestMarkdown, /MUST NOT APPEAR/);
  assert.equal(result.counts.eligibleOtherPromptCount, 0);
  assert.throws(() => buildGenerationContext({
    task: "format",
    locale: "zh",
    target,
    candidates: [],
    allowProjectRead: true,
    forbiddenVaultPath: "C:\\vault",
  }), /cannot access Project files/i);
});

test("target and reference control metadata never enter the Agent request body", () => {
  const target = draft("dr_fd1706f215518cde", "提升代码稳定性", {
    title: "阿斯顿",
    tags: ["工具", "工具/test"],
    projectId: "prj_69c4509c8cae7746",
    projectName: "worklog_plugin",
    updatedAt: "2026-08-26T09:23:08.223Z",
  });
  const result = buildGenerationContext({
    task: "format",
    locale: "zh",
    target,
    candidates: [],
    filters: null,
    allowProjectRead: false,
    forbiddenVaultPath: "C:\\vault",
    entropy: () => "fixed",
  });

  assert.match(result.requestMarkdown, /目标 PROMPT\n提升代码稳定性\n/);
  assert.doesNotMatch(
    result.requestMarkdown,
    /dr_fd1706f215518cde|阿斯顿|工具\/test|worklog_plugin|contentHash|draftId|sha256:/,
  );
  assert.match(result.systemPrompt, /边界标记均为控制信息，禁止在回复中复现/);
});

test("the target body is never truncated and an oversized target fails visibly", () => {
  const target = draft("dr_1111111111111111", "x".repeat(20_000));
  assert.throws(() => buildGenerationContext({
    task: "related",
    locale: "en",
    target,
    candidates: [],
    filters: filters(),
    allowProjectRead: false,
    forbiddenVaultPath: "C:\\vault",
    modelContextWindowTokens: 2_000,
  }), /current prompt is too large/i);
});

test("Inbox targets are rejected before any generation request is built", () => {
  const target = draft("dr_1111111111111111", "TARGET", { projectId: null, projectName: null });
  assert.throws(() => buildGenerationContext({
    task: "related",
    locale: "en",
    target,
    candidates: [],
    filters: filters(),
    allowProjectRead: false,
    forbiddenVaultPath: "C:\\vault",
  }), /assign .* to a Project/i);
});
