import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Module from "node:module";
import test from "node:test";
import type { DraftDetail, DraftScope, DraftStatus, TagTreeNode } from "../src/shared/contracts.shared";
import type { DispatchPaseo } from "../src/server/handlers.server";
import {
  appendTextIfUnchanged,
  writeIfMissing,
} from "../src/server/storage/filesystem.server";
import type { PromptStudioStore as PromptStudioStoreType, ResolvedSourceProject } from "../src/server/store.server";

const moduleInternals = Module as unknown as {
  _resolveFilename(request: string, parent: unknown, isMain: boolean, options: unknown): string;
};
const originalResolveFilename = moduleInternals._resolveFilename;
moduleInternals._resolveFilename = function resolveTestVirtualModule(request, parent, isMain, options) {
  if (request === "@getpaseo/plugin/server") return path.join(import.meta.dirname, "plugin-server.stub.cjs");
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

let PromptStudioStore: typeof PromptStudioStoreType;
let containerEnsureRpc: typeof import("../src/shared/contracts.shared").containerEnsureRpc;
let draftAutosaveRpc: typeof import("../src/shared/contracts.shared").draftAutosaveRpc;
let draftScopeRpc: typeof import("../src/shared/contracts.shared").draftScopeRpc;
let draftTagsSetRpc: typeof import("../src/shared/contracts.shared").draftTagsSetRpc;
let ensureAndRegisterInbox: typeof import("../src/server/project-registration.server").ensureAndRegisterInbox;
let ensureAndRegisterProjectContainer: typeof import("../src/server/project-registration.server").ensureAndRegisterProjectContainer;
let resolveAvailableSourceProject: typeof import("../src/server/project-registration.server").resolveAvailableSourceProject;
let createDispatchCoordinator: typeof import("../src/server/handlers.server").createDispatchCoordinator;
let createHandlers: typeof import("../src/server/handlers.server").createHandlers;
let projectLinkWarnings: typeof import("../src/server/handlers.server").projectLinkWarnings;
test.before(async () => {
  ({
    containerEnsureRpc,
    draftAutosaveRpc,
    draftScopeRpc,
    draftTagsSetRpc,
  } = await import("../src/shared/contracts.shared"));
  ({ PromptStudioStore } = await import("../src/server/store.server"));
  ({
    ensureAndRegisterInbox,
    ensureAndRegisterProjectContainer,
    resolveAvailableSourceProject,
  } = await import("../src/server/project-registration.server"));
  ({ createDispatchCoordinator, createHandlers, projectLinkWarnings } = await import("../src/server/handlers.server"));
});

const globalScope: DraftScope = {
  projectId: null,
  projectName: null,
};

const SOURCE_WORKSPACE_ID = "wks_source_123";
const source: ResolvedSourceProject = {
  projectId: "prj_source_123",
  rootPath: path.resolve("D:\\example-app"),
  name: "Example App",
};

test("Project scope RPCs accept a logical Project without a Workspace locator", () => {
  const target = { kind: "project", projectId: source.projectId } as const;
  assert.equal(containerEnsureRpc.input.safeParse(target).success, true);
  assert.equal(draftScopeRpc.input.safeParse({
    draftId: "dr_1111111111111111",
    target,
  }).success, true);
  assert.equal(containerEnsureRpc.input.safeParse({
    ...target,
    workspaceId: SOURCE_WORKSPACE_ID,
  }).success, false);
  assert.equal(draftScopeRpc.input.safeParse({
    draftId: "dr_1111111111111111",
    target: { ...target, rootPath: source.rootPath },
  }).success, false);
});

async function doesNotExist(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return false;
  } catch {
    return true;
  }
}

async function makeStore(t: test.TestContext): Promise<{ root: string; store: PromptStudioStoreType }> {
  const root = await mkdtemp(path.join(tmpdir(), "prompt-studio-v2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new PromptStudioStore(root) };
}

async function createGlobalDraft(
  t: test.TestContext,
  title = "Untitled",
  markdown = "",
): Promise<{ root: string; store: PromptStudioStoreType; draft: DraftDetail }> {
  const fixture = await makeStore(t);
  await fixture.store.ensureContainer(null);
  const draft = await fixture.store.createDraft("ct_inbox", globalScope, title, markdown);
  return { ...fixture, draft };
}

async function transitionTo(
  store: PromptStudioStoreType,
  draftId: string,
  targetStatus: DraftStatus,
): Promise<DraftDetail> {
  const current = await store.getDraft(draftId);
  return (await store.transitionDraft({
    draftId,
    targetStatus,
    expectedVersion: current.summary.version,
    expectedHash: current.summary.contentHash,
  })).draft;
}

async function markReady(store: PromptStudioStoreType, draftId: string): Promise<DraftDetail> {
  return transitionTo(store, draftId, "ready");
}

function draftPath(containerRoot: string, draftId: string): string {
  return path.join(containerRoot, "drafts", draftId);
}

function contentHash(markdown: string): string {
  return `sha256:${createHash("sha256").update(markdown).digest("hex")}`;
}

function findTagNode(nodes: readonly TagTreeNode[], pathValue: string): TagTreeNode | null {
  for (const node of nodes) {
    if (node.path.toLocaleLowerCase("en-US") === pathValue.toLocaleLowerCase("en-US")) return node;
    const nested = findTagNode(node.children, pathValue);
    if (nested) return nested;
  }
  return null;
}

async function filesBelow(root: string): Promise<string[]> {
  try {
    const files: string[] = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const filePath = path.join(root, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) files.push(...await filesBelow(filePath));
      else if (entry.isFile() && !entry.isSymbolicLink()) files.push(filePath);
    }
    return files;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code === "ENOENT") return [];
    throw error;
  }
}

interface FakeTimelineMessage {
  type: "user_message";
  text: string;
  messageId?: string;
  clientMessageId?: string;
}

interface FakeAgentState {
  id: string;
  workspaceId: string;
  provider: string;
  title: string | null;
  archivedAt?: string | null;
  refreshError?: string;
  refreshes: number;
  behavior: "success" | "reject" | "response-lost";
  sends: Array<{ text: string; messageId: string | undefined }>;
  timeline: FakeTimelineMessage[];
}

interface FakeWorkspaceState {
  id: string;
  projectId: string;
  projectRootPath: string;
  workspaceDirectory?: string;
  behavior: "success" | "reject" | "response-lost" | "refresh-not-found";
  creates: Array<{
    config: { provider: string; modeId?: string; thinkingOptionId?: string };
    prompt: string;
    requestId: string;
    clientMessageId: string;
    title?: string;
    labels?: Record<string, string>;
  }>;
}

function createFakePaseo() {
  const agents = new Map<string, FakeAgentState>();
  const workspaces = new Map<string, FakeWorkspaceState>();
  let createdAgentSequence = 0;

  function addAgent(input: Partial<FakeAgentState> & Pick<FakeAgentState, "id" | "workspaceId">): FakeAgentState {
    const state: FakeAgentState = {
      provider: "codex",
      title: input.id,
      behavior: "success",
      refreshes: 0,
      sends: [],
      timeline: [],
      ...input,
    };
    agents.set(state.id, state);
    return state;
  }

  function agentHandle(agentId: string) {
    const state = agents.get(agentId);
    if (!state) throw new Error(`Unknown fake agent: ${agentId}`);
    const snapshot = () => ({
      id: state.id,
      workspaceId: state.workspaceId,
      provider: state.provider,
      title: state.title,
      archivedAt: state.archivedAt ?? null,
    });
    return {
      id: state.id,
      workspaceId: state.workspaceId,
      current: () => snapshot(),
      refresh: async () => {
        state.refreshes += 1;
        if (state.refreshError) throw new Error(state.refreshError);
        return { agent: snapshot() };
      },
      send: async (text: string, options?: { messageId?: string }) => {
        state.sends.push({ text, messageId: options?.messageId });
        if (state.behavior === "response-lost") {
          state.timeline.push({ type: "user_message", text, messageId: options?.messageId });
          throw new Error("transport response was lost");
        }
        if (state.behavior === "reject") throw new Error("provider rejected request");
        state.timeline.push({ type: "user_message", text, messageId: options?.messageId });
      },
      timeline: {
        refetch: async () => ({
          entries: state.timeline.map((item, index) => ({
            item,
            timestamp: new Date(Date.UTC(2026, 7, 24, 1, 0, index)).toISOString(),
          })),
          startCursor: null,
          hasOlder: false,
          error: null,
        }),
      },
    };
  }

  function addWorkspace(input: Omit<FakeWorkspaceState, "creates"> & { creates?: FakeWorkspaceState["creates"] }) {
    const state: FakeWorkspaceState = { creates: [], ...input };
    workspaces.set(state.id, state);
    return state;
  }

  const paseo = {
    agents: {
      ref: (agentId: string) => agentHandle(agentId),
      list: async () => ({
        entries: [...agents.values()].map((agent) => ({
          agent: {
            id: agent.id,
            workspaceId: agent.workspaceId,
            provider: agent.provider,
            title: agent.title,
            archivedAt: agent.archivedAt ?? null,
          },
        })),
        pageInfo: { nextCursor: null, hasMore: false },
      }),
    },
    workspaces: {
      ref: (workspaceId: string) => {
        const state = workspaces.get(workspaceId);
        if (!state) throw new Error(`Unknown fake workspace: ${workspaceId}`);
        return {
          id: state.id,
          refresh: async () => ({
            id: state.id,
            projectId: state.projectId,
            projectRootPath: state.projectRootPath,
            workspaceDirectory: state.workspaceDirectory,
          }),
          agents: {
            create: async (options: FakeWorkspaceState["creates"][number]) => {
              state.creates.push(options);
              createdAgentSequence += 1;
              const agent = addAgent({
                id: `agt_created_${createdAgentSequence}`,
                workspaceId: state.id,
                provider: options.config.provider.split("/", 1)[0] ?? options.config.provider,
                title: options.title ?? "New prompt agent",
                behavior: "success",
                ...(state.behavior === "refresh-not-found"
                  ? { refreshError: `Agent not found: agt_created_${createdAgentSequence}` }
                  : {}),
                timeline: [{
                  type: "user_message",
                  text: options.prompt,
                  clientMessageId: options.clientMessageId,
                }],
              });
              if (state.behavior === "reject") {
                agents.delete(agent.id);
                throw new Error("agent creation rejected");
              }
              if (state.behavior === "response-lost") throw new Error("create response was lost");
              return agentHandle(agent.id);
            },
          },
        };
      },
    },
  };

  return { paseo: paseo as unknown as DispatchPaseo, agents, workspaces, addAgent, addWorkspace };
}

test("one Prompt Studio vault owns every Draft and keeps local links outside companion.json", async (t) => {
  const { root, store } = await makeStore(t);
  assert.equal(await doesNotExist(path.join(root, "Prompt-Studio-Inbox")), true);

  const empty = await store.scan();
  assert.deepEqual(empty.containers.map((container) => container.id), ["ct_inbox"]);
  assert.equal(await doesNotExist(path.join(root, "Prompt-Studio-Inbox")), true);
  assert.equal(await doesNotExist(path.join(root, "companions")), true);

  const ensured = await store.ensureContainer(null);
  assert.equal(ensured.created, false);
  assert.equal(ensured.summary.id, "ct_inbox");
  assert.equal(ensured.summary.registration.status, "pending");
  assert.equal(ensured.placement.companion.rootPath, root);
  assert.match(await readFile(path.join(root, "README.md"), "utf8"), /single Paseo Project/i);
  assert.match(await readFile(path.join(root, "AGENTS.md"), "utf8"), /only Paseo Project/i);

  const manifestText = await readFile(path.join(root, "companion.json"), "utf8");
  assert.doesNotMatch(manifestText, /rootPath|workspaceId|projectId/);
  const projectMapText = await readFile(path.join(root, "local", "project-map.json"), "utf8");
  assert.match(projectMapText, /rootPath/);
  assert.match(projectMapText, /"projects": \[\]/);

  const repeated = await store.ensureContainer(null);
  assert.equal(repeated.created, false);
  assert.equal(repeated.summary.id, ensured.summary.id);
});

test("vault AGENTS migration appends one managed access block without replacing user text", async (t) => {
  const { root, store } = await makeStore(t);
  await store.ensureContainer(null);
  const agentsPath = path.join(root, "AGENTS.md");
  await writeFile(agentsPath, "# My vault notes\n\nKeep this custom instruction.\n", "utf8");

  const reopened = new PromptStudioStore(root);
  await reopened.ensureContainer(null);
  const migrated = await readFile(agentsPath, "utf8");
  assert.match(migrated, /Keep this custom instruction/);
  assert.match(migrated, /must never read, search, enumerate, summarize, or modify this vault/i);
  assert.equal(migrated.match(/prompt-studio:managed-agent-access:start/g)?.length, 1);

  await new PromptStudioStore(root).ensureContainer(null);
  const stable = await readFile(agentsPath, "utf8");
  assert.equal(stable, migrated);
});

test("vault bootstrap publishes AGENTS candidates with exclusive create semantics", async (t) => {
  const { root } = await makeStore(t);
  const agentsPath = path.join(root, "exclusive-AGENTS.md");
  const [firstCreated, secondCreated] = await Promise.all([
    writeIfMissing(agentsPath, "first candidate\n", root),
    writeIfMissing(agentsPath, "second candidate\n", root),
  ]);

  assert.equal(Number(firstCreated) + Number(secondCreated), 1);
  assert.equal(
    await readFile(agentsPath, "utf8"),
    firstCreated ? "first candidate\n" : "second candidate\n",
  );
});

test("managed AGENTS append preserves an editor write injected at the commit boundary", async (t) => {
  const { root } = await makeStore(t);
  const agentsPath = path.join(root, "append-AGENTS.md");
  const observed = "# Original user instructions\n";
  const external = "# External editor replacement\n";
  const managedSuffix = "\nmanaged block\n";
  await writeFile(agentsPath, observed, "utf8");

  await assert.rejects(
    appendTextIfUnchanged(agentsPath, observed, managedSuffix, root, {
      beforeAppend: () => writeFile(agentsPath, external, "utf8"),
    }),
    /changed during conditional append/i,
  );
  assert.equal(await readFile(agentsPath, "utf8"), `${external}${managedSuffix}`);
});

test("vault leaves an outdated managed AGENTS block byte-for-byte unchanged when CAS is unavailable", async (t) => {
  const { root, store } = await makeStore(t);
  await store.ensureContainer(null);
  const agentsPath = path.join(root, "AGENTS.md");
  const outdated = `# User instructions

<!-- prompt-studio:managed-agent-access:start -->
## Previous managed rule

Keep the old rule until replacement can be committed safely.
<!-- prompt-studio:managed-agent-access:end -->

User-authored tail must remain.
`;
  await writeFile(agentsPath, outdated, "utf8");

  await assert.rejects(
    new PromptStudioStore(root).ensureContainer(null),
    /managed block cannot be replaced safely.*compare-and-swap replacement is unavailable.*left unchanged/i,
  );
  assert.equal(await readFile(agentsPath, "utf8"), outdated);
});

test("project links share the one vault registration and remain outside the portable manifest", async (t) => {
  const { root, store } = await makeStore(t);
  const ensured = await store.ensureContainer(source);
  assert.equal(ensured.created, true);
  assert.equal(ensured.summary.containerType, "project");
  assert.equal(ensured.placement.companion.rootPath, root);
  assert.equal(await doesNotExist(path.join(root, "companions")), true);

  const pending = await store.recordRegistration(ensured.summary.id, {
    status: "pending",
    error: "daemon temporarily unavailable",
  });
  assert.deepEqual(pending.registration, {
    status: "pending",
    error: "daemon temporarily unavailable",
  });

  const registered = await store.recordRegistration(ensured.summary.id, {
    status: "registered",
    projectId: "prj_companion_456",
    workspaceId: "wks_companion_456",
  });
  assert.equal(registered.registration.status, "registered");
  if (registered.registration.status === "registered") {
    assert.equal(registered.registration.projectId, "prj_companion_456");
    assert.equal(registered.registration.workspaceId, "wks_companion_456");
  }

  const manifest = await readFile(path.join(root, "companion.json"), "utf8");
  assert.doesNotMatch(manifest, /prj_companion_456|wks_companion_456/);
  const projectMap = await readFile(path.join(root, "local", "project-map.json"), "utf8");
  assert.match(projectMap, /prj_companion_456/);
  assert.match(projectMap, /prj_source_123/);
  const inbox = await store.ensureContainer(null);
  assert.deepEqual(inbox.summary.registration, registered.registration);
});

test("legacy Project maps drop Workspace locators during atomic initialization upgrade", async (t) => {
  const { root, store } = await makeStore(t);
  await store.ensureContainer(source);
  const mapPath = path.join(root, "local", "project-map.json");
  const current = JSON.parse(await readFile(mapPath, "utf8")) as {
    schemaVersion: number;
    projects: Array<{ source: null | Record<string, unknown> }>;
  };
  current.schemaVersion = 1;
  for (const project of current.projects) {
    if (project.source) project.source.workspaceId = SOURCE_WORKSPACE_ID;
  }
  await writeFile(mapPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");

  await new PromptStudioStore(root).ensureContainer(null);

  const upgraded = JSON.parse(await readFile(mapPath, "utf8")) as {
    schemaVersion: number;
    projects: Array<{ source: null | Record<string, unknown> }>;
  };
  assert.equal(upgraded.schemaVersion, 2);
  assert.equal(upgraded.projects[0]?.source?.projectId, source.projectId);
  assert.equal("workspaceId" in (upgraded.projects[0]?.source ?? {}), false);

  // Also repair a partially upgraded v2 file left by an interrupted older build.
  if (upgraded.projects[0]?.source) {
    upgraded.projects[0].source.workspaceId = "wks_partially_upgraded";
  }
  await writeFile(mapPath, `${JSON.stringify(upgraded, null, 2)}\n`, "utf8");
  await new PromptStudioStore(root).ensureContainer(null);
  const repaired = JSON.parse(await readFile(mapPath, "utf8")) as {
    schemaVersion: number;
    projects: Array<{ source: null | Record<string, unknown> }>;
  };
  assert.equal(repaired.schemaVersion, 2);
  assert.equal("workspaceId" in (repaired.projects[0]?.source ?? {}), false);
});

test("container creation immediately registers through workspaces.open and retries a pending placement", async (t) => {
  const { store } = await makeStore(t);
  let attempts = 0;
  const openedPaths: string[] = [];
  const paseo = {
    workspaces: {
      ref: (_workspaceId: string) => ({
        id: SOURCE_WORKSPACE_ID,
        projectId: source.projectId,
        refresh: async () => ({
          id: SOURCE_WORKSPACE_ID,
          projectId: source.projectId,
          projectDisplayName: source.name,
          projectRootPath: source.rootPath,
        }),
      }),
      list: async () => ({
        entries: [],
        emptyProjects: [{
          projectId: source.projectId,
          projectDisplayName: source.name,
          projectRootPath: source.rootPath,
        }],
        pageInfo: { nextCursor: null, hasMore: false },
      }),
      open: async (directory: string) => {
        openedPaths.push(directory);
        attempts += 1;
        if (attempts === 1) throw new Error("daemon temporarily unavailable");
        return {
          id: "wks_companion_retry",
          projectId: null,
          refresh: async () => ({
            id: "wks_companion_retry",
            projectId: "prj_companion_retry",
            projectDisplayName: "Prompt companion",
            projectRootPath: directory,
          }),
        };
      },
    },
  };

  const failed = await ensureAndRegisterProjectContainer(store, paseo, source.projectId);
  assert.equal(failed.created, true);
  assert.equal(failed.container.registration.status, "pending");
  assert.match(failed.registrationWarning ?? "", /temporarily unavailable/i);

  const retried = await ensureAndRegisterProjectContainer(store, paseo, source.projectId);
  assert.equal(retried.created, false);
  assert.equal(retried.registrationWarning, null);
  assert.equal(retried.container.registration.status, "registered");
  assert.equal(openedPaths[0], openedPaths[1]);
  if (retried.container.registration.status === "registered") {
    assert.equal(retried.container.registration.projectId, "prj_companion_retry");
    assert.equal(retried.container.registration.workspaceId, "wks_companion_retry");
  }
});

test("a Project without Workspaces resolves and persists without a Workspace locator", async (t) => {
  const { store } = await makeStore(t);
  const paseo = {
    workspaces: {
      ref: (workspaceId: string) => ({
        id: workspaceId,
        projectId: source.projectId,
        refresh: async () => null,
      }),
      list: async () => ({
        entries: [],
        emptyProjects: [{
          projectId: source.projectId,
          projectDisplayName: source.name,
          projectRootPath: source.rootPath,
        }],
        pageInfo: { nextCursor: null, hasMore: false },
      }),
      open: async (directory: string) => ({
        id: "wks_prompt_studio",
        projectId: "prj_prompt_studio",
        refresh: async () => ({
          id: "wks_prompt_studio",
          projectId: "prj_prompt_studio",
          projectDisplayName: "Prompt Studio",
          projectRootPath: directory,
        }),
      }),
    },
  };

  const resolved = await resolveAvailableSourceProject(paseo, source.projectId);
  assert.deepEqual(resolved, source);

  await ensureAndRegisterProjectContainer(store, paseo, source.projectId);
  const linked = await store.getLinkedProjects();
  assert.equal("workspaceId" in (linked[0] ?? {}), false);
  assert.equal(linked[0]?.rootPath, source.rootPath);
});

test("Project resolution uses Project descriptors and rejects conflicting roots", async () => {
  let refreshCount = 0;
  const descriptorPaseo = {
    workspaces: {
      ref: (_workspaceId: string) => ({
        id: "unused",
        projectId: source.projectId,
        refresh: async () => {
          refreshCount += 1;
          return null;
        },
      }),
      list: async () => ({
        entries: [{
          id: SOURCE_WORKSPACE_ID,
          projectId: source.projectId,
          projectDisplayName: source.name,
          projectRootPath: source.rootPath,
        }],
        pageInfo: { nextCursor: null, hasMore: false },
      }),
      open: async (_directory: string) => {
        throw new Error("not used");
      },
    },
  };
  assert.deepEqual(await resolveAvailableSourceProject(descriptorPaseo, source.projectId), source);
  assert.equal(refreshCount, 0, "a Project descriptor must not depend on a Workspace refresh");

  const conflictingPaseo = {
    ...descriptorPaseo,
    workspaces: {
      ...descriptorPaseo.workspaces,
      list: async () => ({
        entries: [{
          id: SOURCE_WORKSPACE_ID,
          projectId: source.projectId,
          projectDisplayName: source.name,
          projectRootPath: source.rootPath,
        }],
        emptyProjects: [{
          projectId: source.projectId,
          projectDisplayName: source.name,
          projectRootPath: path.resolve("D:\\different-example-app"),
        }],
        pageInfo: { nextCursor: null, hasMore: false },
      }),
    },
  };
  await assert.rejects(
    resolveAvailableSourceProject(conflictingPaseo, source.projectId),
    /conflicting roots/i,
  );
});

test("Inbox registration also uses workspaces.open and rejects missing Project identity", async (t) => {
  const { store } = await makeStore(t);
  let openedPath: string | null = null;
  const paseo = {
    workspaces: {
      ref: (_workspaceId: string) => {
        throw new Error("not used");
      },
      open: async (directory: string) => {
        openedPath = directory;
        return {
          id: "wks_inbox",
          projectId: null,
          refresh: async () => null,
        };
      },
    },
  };
  const result = await ensureAndRegisterInbox(store, paseo);
  assert.equal(openedPath, await store.getContainerRoot("ct_inbox"));
  assert.equal(result.container.registration.status, "pending");
  assert.match(result.registrationWarning ?? "", /without returning Project\/Workspace IDs/i);
});

test("vault subdirectories cannot be linked back as external Projects", async (t) => {
  const { root, store } = await makeStore(t);
  const legacyRoot = path.join(root, "legacy", "containers", "ct_inbox");
  let opened = false;
  const paseo = {
    workspaces: {
      ref: (workspaceId: string) => ({
        id: workspaceId,
        projectId: "prj_legacy_companion",
        refresh: async () => ({
          id: workspaceId,
          projectId: "prj_legacy_companion",
          projectDisplayName: "Legacy Prompt Studio companion",
          projectRootPath: legacyRoot,
        }),
      }),
      list: async () => ({
        entries: [],
        emptyProjects: [{
          projectId: "prj_legacy_companion",
          projectDisplayName: "Legacy Prompt Studio companion",
          projectRootPath: legacyRoot,
        }],
        pageInfo: { nextCursor: null, hasMore: false },
      }),
      open: async (_directory: string) => {
        opened = true;
        throw new Error("must not register a nested vault path");
      },
    },
  };

  await assert.rejects(
    ensureAndRegisterProjectContainer(store, paseo, "prj_legacy_companion"),
    /vault or legacy vault subdirectory cannot be linked as an external Project/i,
  );
  assert.equal(opened, false);
  assert.deepEqual(await store.getLinkedProjects(), []);
});

test("catalog access registers the single vault Project once", async (t) => {
  const { root, store } = await makeStore(t);
  await store.ensureContainer(null);
  const draft = await store.createDraft("ct_inbox", globalScope, "Vault registration", "keep me");
  let openCount = 0;
  let registrationAvailable = false;
  const paseo = {
    workspaces: {
      ref: (workspaceId: string) => ({
        id: workspaceId,
        projectId: "prj_prompt_studio_vault",
        refresh: async () => registrationAvailable
          ? {
              id: workspaceId,
              projectId: "prj_prompt_studio_vault",
              projectDisplayName: "Prompt Studio",
              projectRootPath: root,
            }
          : null,
      }),
      open: async (directory: string) => {
        openCount += 1;
        registrationAvailable = true;
        assert.equal(directory, root);
        return {
          id: "wks_prompt_studio_vault",
          projectId: "prj_prompt_studio_vault",
          refresh: async () => ({
            id: "wks_prompt_studio_vault",
            projectId: "prj_prompt_studio_vault",
            projectDisplayName: "Prompt Studio",
            projectRootPath: root,
          }),
        };
      },
    },
  };
  const handler = createHandlers(store).catalogScan;
  const context = { paseo } as unknown as Parameters<typeof handler>[1];
  const input = { query: "", statuses: null, projectIds: null, tagPaths: null, rebuild: false };
  const first = await handler(input, context);
  const second = await handler(input, context);

  assert.equal(openCount, 1);
  assert.equal(first.containers[0]?.registration.status, "registered");
  assert.equal(second.containers[0]?.registration.status, "registered");
  registrationAvailable = false;
  const recreated = await handler(input, context);
  assert.equal(openCount, 2);
  assert.ok(recreated.drafts.some((item) => item.id === draft.summary.id));
});

test("scope changes keep one physical Draft lineage while updating its logical Project link", async (t) => {
  const { root, store, draft } = await createGlobalDraft(t, "Architecture review", "# Review\n\nFind coupling.");
  const project = await store.ensureContainer(source);
  const inboxRoot = await store.getContainerRoot("ct_inbox");
  const projectRoot = await store.getContainerRoot(project.summary.id);
  await markReady(store, draft.summary.id);
  const prepared = await store.prepareDispatch(draft.summary.id, { kind: "existing_agent", agentId: "agt_before_move" });
  await store.finalizeDispatch(draft.summary.id, prepared.dispatch.id, {
    status: "failed",
    error: "fixture failure",
    agentId: "agt_before_move",
  });

  const moved = await store.moveDraftScope(draft.summary.id, project.summary.id, {
    projectId: source.projectId,
    projectName: source.name,
  });

  assert.equal(moved.summary.id, draft.summary.id);
  assert.equal(moved.summary.containerId, project.summary.id);
  assert.equal(moved.summary.scope.projectId, source.projectId);
  assert.equal(inboxRoot, projectRoot);
  assert.equal(await doesNotExist(draftPath(projectRoot, draft.summary.id)), false);
  assert.equal((await readdir(path.join(projectRoot, "drafts"))).filter((name) => name === draft.summary.id).length, 1);
  assert.equal(moved.snapshots.length, 1);
  assert.equal(moved.dispatches.length, 1);
  assert.ok(moved.checkpoints.some((checkpoint) => checkpoint.reason === "scope"));
  const moveEvent = moved.events.find((event) => event.type === "draft.scope-moved");
  assert.ok(moveEvent);
  assert.equal(moveEvent.details.sourceContainerId, "ct_inbox");
  assert.equal(moveEvent.details.targetContainerId, project.summary.id);
  assert.deepEqual(moveEvent.details.sourceScope, globalScope);
  assert.deepEqual(moveEvent.details.targetScope, moved.summary.scope);
  assert.match(moveEvent.summary, new RegExp(source.name));
  assert.doesNotMatch(moveEvent.summary, new RegExp(SOURCE_WORKSPACE_ID));

  const unchanged = await store.moveDraftScope(draft.summary.id, project.summary.id, moved.summary.scope);
  assert.equal(unchanged.summary.version, moved.summary.version);
  assert.equal(unchanged.checkpoints.length, moved.checkpoints.length);
  assert.equal(unchanged.events.filter((event) => event.type === "draft.scope-moved").length, 1);

  const scopedTimeline = await store.scan();
  assert.equal(scopedTimeline.timeline.some((entry) => entry.type === "checkpoint"), false);
  const scopedEntry = scopedTimeline.timeline.find((entry) => entry.type === "scope" && entry.draftId === draft.summary.id);
  assert.match(scopedEntry?.summary ?? "", new RegExp(source.name));
  assert.doesNotMatch(scopedEntry?.summary ?? "", new RegExp(SOURCE_WORKSPACE_ID));

  const unscoped = await store.moveDraftScope(draft.summary.id, "ct_inbox", globalScope);
  assert.equal(unscoped.summary.id, draft.summary.id);
  assert.equal(unscoped.summary.containerId, "ct_inbox");
  assert.equal(unscoped.summary.scope.projectId, null);
  assert.equal(unscoped.snapshots.length, 1);
  assert.equal(unscoped.dispatches.length, 1);
  assert.equal(await doesNotExist(draftPath(inboxRoot, draft.summary.id)), false);
  assert.equal(await doesNotExist(path.join(root, ".transactions", `scope-${draft.summary.id}.json`)), true);
});

test("legacy interrupted Scope moves recover before the companion layout is unified", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "prompt-studio-legacy-move-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const at = "2026-08-24T01:02:03.000Z";
  const draftId = "dr_1111222233334444";
  const projectContainerId = "ct_aaaaaaaaaaaaaaaa";
  const inboxRoot = path.join(root, "Prompt-Studio-Inbox");
  const projectRoot = path.join(root, "companions", "example-app-prompts--aaaaaaaa");
  const targetDraft = draftPath(projectRoot, draftId);
  const journalPath = path.join(root, ".transactions", `scope-${draftId}.json`);
  await mkdir(targetDraft, { recursive: true });
  await mkdir(path.join(inboxRoot, "drafts"), { recursive: true });
  await mkdir(path.join(root, "local", "placements"), { recursive: true });
  await mkdir(path.join(root, ".transactions"), { recursive: true });

  const inboxManifest = {
    schemaVersion: 2,
    kind: "prompt-studio-container",
    id: "ct_inbox",
    containerType: "inbox",
    title: "Prompt Studio Inbox",
    sourceProjectName: null,
    sourcePathFingerprint: null,
    createdAt: at,
    updatedAt: at,
  };
  const projectManifest = {
    ...inboxManifest,
    id: projectContainerId,
    containerType: "project",
    title: "Example App Prompts",
    sourceProjectName: source.name,
    sourcePathFingerprint: `sha256:${"a".repeat(64)}`,
  };
  await writeFile(path.join(inboxRoot, "companion.json"), `${JSON.stringify(inboxManifest, null, 2)}\n`, "utf8");
  await writeFile(path.join(projectRoot, "companion.json"), `${JSON.stringify(projectManifest, null, 2)}\n`, "utf8");
  const placement = (containerId: string, rootPath: string, linked: boolean) => ({
    schemaVersion: 2,
    containerId,
    source: linked ? source : null,
    companion: {
      rootPath,
      registration: { status: "pending", projectId: null, workspaceId: null, error: null },
    },
    updatedAt: at,
  });
  await writeFile(
    path.join(root, "local", "placements", "ct_inbox.json"),
    `${JSON.stringify(placement("ct_inbox", inboxRoot, false), null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(root, "local", "placements", `${projectContainerId}.json`),
    `${JSON.stringify(placement(projectContainerId, projectRoot, true), null, 2)}\n`,
    "utf8",
  );
  const markdown = "Never duplicate me";
  await writeFile(path.join(targetDraft, "draft.md"), markdown, "utf8");
  await writeFile(path.join(targetDraft, "meta.json"), `${JSON.stringify({
    schemaVersion: 4,
    id: draftId,
    containerId: "ct_inbox",
    title: "Crash recovery",
    status: "draft",
    tags: [],
    scope: globalScope,
    version: 1,
    contentHash: contentHash(markdown),
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    archivedFromStatus: null,
    lastCheckpointAt: null,
  }, null, 2)}\n`, "utf8");
  await writeFile(journalPath, `${JSON.stringify({
    schemaVersion: 2,
    operation: "draft-scope-move",
    draftId,
    sourceContainerId: "ct_inbox",
    targetContainerId: projectContainerId,
    targetScope: { projectId: source.projectId, projectName: source.name },
    createdAt: at,
  }, null, 2)}\n`, "utf8");

  const recoveredStore = new PromptStudioStore(root);
  const scan = await recoveredStore.scan();
  const recovered = await recoveredStore.getDraft(draftId);

  assert.equal(recovered.summary.containerId, projectContainerId);
  assert.deepEqual(recovered.summary.scope, { projectId: source.projectId, projectName: source.name });
  assert.equal(scan.drafts.filter((draft) => draft.id === draftId).length, 1);
  assert.equal(await doesNotExist(path.join(root, "drafts", draftId)), false);
  assert.equal(await doesNotExist(inboxRoot), true);
  assert.equal(await doesNotExist(projectRoot), true);
  assert.equal(await doesNotExist(path.join(root, "companions")), true);
  assert.equal(await doesNotExist(path.join(root, "legacy", "containers", projectContainerId)), false);
  assert.equal(await doesNotExist(path.join(root, "local", "project-map.json")), false);
  assert.equal(await doesNotExist(journalPath), true);
  assert.equal(await doesNotExist(path.join(root, ".transactions", "storage-unification.json")), true);
});

test("an interrupted vault-unification journal resumes without creating a second canonical Draft", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "prompt-studio-unification-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const at = "2026-08-24T03:04:05.000Z";
  const draftId = "dr_5555666677778888";
  const legacyRoot = path.join(root, "Prompt-Studio-Inbox");
  const legacyDraft = path.join(legacyRoot, "drafts", draftId);
  const unifiedDraft = path.join(root, "drafts", draftId);
  const journalPath = path.join(root, ".transactions", "storage-unification.json");
  await mkdir(path.dirname(legacyDraft), { recursive: true });
  await mkdir(path.dirname(unifiedDraft), { recursive: true });
  await mkdir(path.dirname(journalPath), { recursive: true });
  const manifest = {
    schemaVersion: 2,
    kind: "prompt-studio-container",
    id: "ct_inbox",
    containerType: "inbox",
    title: "Prompt Studio Inbox",
    sourceProjectName: null,
    sourcePathFingerprint: null,
    createdAt: at,
    updatedAt: at,
  };
  await writeFile(path.join(legacyRoot, "companion.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const markdown = "already moved before the process stopped";
  await mkdir(unifiedDraft, { recursive: true });
  await writeFile(path.join(unifiedDraft, "draft.md"), markdown, "utf8");
  await writeFile(path.join(unifiedDraft, "meta.json"), `${JSON.stringify({
    schemaVersion: 4,
    id: draftId,
    containerId: "ct_inbox",
    title: "Resume migration",
    status: "draft",
    tags: [],
    scope: globalScope,
    version: 1,
    contentHash: contentHash(markdown),
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    archivedFromStatus: null,
    lastCheckpointAt: null,
  }, null, 2)}\n`, "utf8");
  await writeFile(journalPath, `${JSON.stringify({
    schemaVersion: 1,
    operation: "unify-prompt-studio-vault",
    createdAt: at,
    containers: [{
      manifest,
      source: null,
      linkError: null,
      legacyRelativePath: "Prompt-Studio-Inbox",
    }],
    drafts: [{
      draftId,
      sourceContainerId: "ct_inbox",
      legacyRelativePath: `Prompt-Studio-Inbox/drafts/${draftId}`,
    }],
  }, null, 2)}\n`, "utf8");

  const reopened = new PromptStudioStore(root);
  const scan = await reopened.scan();
  assert.equal(scan.drafts.filter((draft) => draft.id === draftId).length, 1);
  assert.equal((await readdir(path.join(root, "drafts"))).filter((name) => name === draftId).length, 1);
  assert.equal(await doesNotExist(legacyRoot), true);
  assert.equal(await doesNotExist(path.join(root, "legacy", "containers", "ct_inbox")), false);
  assert.equal(await doesNotExist(journalPath), true);
});

test("vault unification stops when legacy and unified canonical copies both exist", async (t) => {
  const { root, draft } = await createGlobalDraft(t, "Duplicate guard", "one canonical body");
  const legacyRoot = path.join(root, "Prompt-Studio-Inbox");
  const legacyDraft = path.join(legacyRoot, "drafts", draft.summary.id);
  const journalPath = path.join(root, ".transactions", "storage-unification.json");
  await mkdir(legacyDraft, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(root, "companion.json"), "utf8")) as Record<string, unknown>;
  await writeFile(path.join(legacyRoot, "companion.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(journalPath, `${JSON.stringify({
    schemaVersion: 1,
    operation: "unify-prompt-studio-vault",
    createdAt: "2026-08-24T04:05:06.000Z",
    containers: [{
      manifest,
      source: null,
      linkError: null,
      legacyRelativePath: "Prompt-Studio-Inbox",
    }],
    drafts: [{
      draftId: draft.summary.id,
      sourceContainerId: "ct_inbox",
      legacyRelativePath: `Prompt-Studio-Inbox/drafts/${draft.summary.id}`,
    }],
  }, null, 2)}\n`, "utf8");

  await assert.rejects(new PromptStudioStore(root).scan(), /two canonical copies/i);
  assert.equal(await doesNotExist(legacyDraft), false);
  assert.equal(await doesNotExist(draftPath(root, draft.summary.id)), false);
  assert.equal(await doesNotExist(journalPath), false);
});

test("legacy Workspace/Agent scope fields are ignored while dispatch targets remain independent", async (t) => {
  const { root, store } = await makeStore(t);
  const project = await store.ensureContainer(source);
  const projectScope: DraftScope = { projectId: source.projectId, projectName: source.name };
  const draft = await store.createDraft(
    project.summary.id,
    projectScope,
    "Legacy Workspace/Agent scope",
    "dispatch this exact prompt",
  );
  await markReady(store, draft.summary.id);
  const snapshot = await store.createSnapshot(draft.summary.id);
  const containerRoot = await store.getContainerRoot(project.summary.id);
  const draftRoot = draftPath(containerRoot, draft.summary.id);
  const metaPath = path.join(draftRoot, "meta.json");
  const snapshotPath = path.join(draftRoot, "snapshots", `${snapshot.id}.json`);
  const legacyMeta = JSON.parse(await readFile(metaPath, "utf8")) as { scope: Record<string, unknown> };
  const legacySnapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as { scope: Record<string, unknown> };
  legacyMeta.scope.workspaceId = "wks_legacy_owner";
  legacyMeta.scope.agentId = "agt_legacy_owner";
  legacySnapshot.scope.workspaceId = "wks_legacy_owner";
  legacySnapshot.scope.agentId = "agt_legacy_owner";
  await writeFile(metaPath, `${JSON.stringify(legacyMeta, null, 2)}\n`, "utf8");
  await writeFile(snapshotPath, `${JSON.stringify(legacySnapshot, null, 2)}\n`, "utf8");

  const reopenedStore = new PromptStudioStore(root);
  const reopened = await reopenedStore.getDraft(draft.summary.id);
  assert.deepEqual(reopened.summary.scope, projectScope);
  assert.equal("workspaceId" in reopened.summary.scope, false);
  assert.equal("agentId" in reopened.summary.scope, false);
  assert.deepEqual(reopened.snapshots.find((item) => item.id === snapshot.id)?.scope, projectScope);

  await reopenedStore.autosaveDraft({
    draftId: draft.summary.id,
    title: reopened.summary.title,
    markdown: `${reopened.markdown}\nupdated`,
    expectedVersion: reopened.summary.version,
    expectedHash: reopened.summary.contentHash,
  });
  const normalizedMeta = JSON.parse(await readFile(metaPath, "utf8")) as { scope: Record<string, unknown> };
  const immutableSnapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as { scope: Record<string, unknown> };
  assert.equal("workspaceId" in normalizedMeta.scope, false);
  assert.equal("agentId" in normalizedMeta.scope, false);
  assert.equal(immutableSnapshot.scope.workspaceId, "wks_legacy_owner");
  assert.equal(immutableSnapshot.scope.agentId, "agt_legacy_owner");

  await markReady(reopenedStore, draft.summary.id);
  const prepared = await reopenedStore.prepareDispatch(draft.summary.id, {
    kind: "existing_agent",
    agentId: "agt_delivery_target",
  });
  assert.deepEqual(prepared.dispatch.target, { kind: "existing_agent", agentId: "agt_delivery_target" });
  assert.deepEqual(prepared.snapshot.scope, projectScope);
});

test("catalog is disposable, rebuilt from canonical files, and lexical search reads current markdown", async (t) => {
  const { root, store } = await makeStore(t);
  await store.ensureContainer(null);
  const alpha = await store.createDraft("ct_inbox", globalScope, "Alpha title", "contains-nebula-token");
  await store.createDraft("ct_inbox", globalScope, "Beta title", "different body");
  const catalogPath = path.join(root, "catalog.json");

  await rm(catalogPath, { force: true });
  const rebuilt = await new PromptStudioStore(root).scan("nebula-token");
  assert.deepEqual(rebuilt.drafts.map((draft) => draft.id), [alpha.summary.id]);
  assert.equal(await doesNotExist(catalogPath), false);
  assert.doesNotMatch(await readFile(catalogPath, "utf8"), /contains-nebula-token/);

  await writeFile(catalogPath, "{broken catalog", "utf8");
  const recovered = await new PromptStudioStore(root).scan("alpha");
  assert.deepEqual(recovered.drafts.map((draft) => draft.id), [alpha.summary.id]);
  assert.ok(recovered.warnings.some((warning) => /catalog\.json.*rebuilt/i.test(warning)));
});

test("catalog scans reuse the derived cache and autosave updates it without a canonical rescan", async (t) => {
  const { store, draft } = await createGlobalDraft(t, "Cached catalog", "first body");
  const internals = store as unknown as {
    scanCanonical(reconcileDrafts: boolean): Promise<unknown>;
  };
  const originalScan = internals.scanCanonical.bind(store);
  let canonicalScans = 0;
  internals.scanCanonical = async (reconcileDrafts) => {
    canonicalScans += 1;
    return originalScan(reconcileDrafts);
  };

  await store.scan();
  assert.equal(canonicalScans, 0);
  const saved = await store.autosaveDraft({
    draftId: draft.summary.id,
    title: "Cached catalog updated",
    markdown: "second body",
    expectedVersion: draft.summary.version,
    expectedHash: draft.summary.contentHash,
  });
  assert.equal(canonicalScans, 0);
  const cached = await store.scan();
  assert.equal(canonicalScans, 0);
  assert.equal(cached.drafts.find((item) => item.id === draft.summary.id)?.version, saved.summary.version);

  await store.scan("", null, null, true);
  assert.equal(canonicalScans, 1);
});

test("autosave uses version/hash concurrency and creates periodic checkpoints", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "prompt-studio-clock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = new Date("2026-08-24T01:00:00.000Z");
  const store = new PromptStudioStore(root, { now: () => new Date(now) });
  await store.ensureContainer(null);
  const draft = await store.createDraft("ct_inbox", globalScope, "Autosave", "version one");
  now = new Date(now.getTime() + 6 * 60_000);
  const noOp = await store.autosaveDraft({
    draftId: draft.summary.id,
    title: draft.summary.title,
    markdown: draft.markdown,
    expectedVersion: draft.summary.version,
    expectedHash: draft.summary.contentHash,
  });
  assert.equal(noOp.summary.version, draft.summary.version);
  assert.equal(noOp.event, null);
  assert.equal(noOp.checkpointCreated, false);
  const afterNoOp = await store.getDraft(draft.summary.id);
  assert.equal(afterNoOp.events.some((event) => event.type === "draft.autosaved"), false);
  assert.equal(afterNoOp.checkpoints.length, 0);

  const tagged = await store.setDraftTags({
    draftId: draft.summary.id,
    tags: ["one", "ONE", " two "],
    expectedTags: [],
  });
  assert.deepEqual(tagged.summary.tags, ["one", "two"]);
  assert.equal(tagged.summary.version, draft.summary.version);

  const first = await store.autosaveDraft({
    draftId: draft.summary.id,
    title: draft.summary.title,
    markdown: "version two",
    expectedVersion: draft.summary.version,
    expectedHash: draft.summary.contentHash,
  });
  assert.equal(first.checkpointCreated, true);
  assert.equal(first.summary.version, 2);
  assert.deepEqual(first.summary.tags, ["one", "two"]);

  const immediate = await store.autosaveDraft({
    draftId: draft.summary.id,
    title: draft.summary.title,
    markdown: "version three",
    expectedVersion: first.summary.version,
    expectedHash: first.summary.contentHash,
  });
  assert.equal(immediate.checkpointCreated, false);

  await assert.rejects(
    store.autosaveDraft({
      draftId: draft.summary.id,
      title: "stale",
      markdown: "lost update",
      expectedVersion: draft.summary.version,
      expectedHash: draft.summary.contentHash,
    }),
    /changed since it was opened/i,
  );

  now = new Date(now.getTime() + 6 * 60_000);
  const periodic = await store.autosaveDraft({
    draftId: draft.summary.id,
    title: immediate.summary.title,
    markdown: "version four",
    expectedVersion: immediate.summary.version,
    expectedHash: immediate.summary.contentHash,
  });
  assert.equal(periodic.checkpointCreated, true);
  assert.ok((await store.getDraft(draft.summary.id)).checkpoints.filter((checkpoint) => checkpoint.reason === "periodic").length >= 2);
});

test("tag-only writes are unlimited and leave ready content lineage completely unchanged", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "prompt-studio-tag-clock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = new Date("2026-08-25T02:00:00.000Z");
  const store = new PromptStudioStore(root, { now: () => new Date(now) });
  await store.ensureContainer(null);
  const created = await store.createDraft("ct_inbox", globalScope, "Tag metadata", "immutable body");
  await store.setDraftTags({ draftId: created.summary.id, tags: ["Existing"], expectedTags: [] });
  const ready = await markReady(store, created.summary.id);
  const before = await store.getDraft(created.summary.id);
  now = new Date("2026-08-25T03:00:00.000Z");
  const longTag = `Long/${"x".repeat(160)}`;
  const requested = ["existing", longTag, ...Array.from({ length: 25 }, (_, index) => `Tree/Child-${index}`)];

  assert.equal(draftTagsSetRpc.input.safeParse({
    draftId: created.summary.id,
    tags: requested,
    expectedTags: ["EXISTING"],
  }).success, true);
  const tagged = await store.setDraftTags({
    draftId: created.summary.id,
    tags: requested,
    expectedTags: ["EXISTING"],
  });
  const after = await store.getDraft(created.summary.id);

  assert.equal(tagged.changed, true);
  assert.equal(after.summary.tags.length, 27);
  assert.ok(after.summary.tags.includes(longTag));
  assert.equal(after.summary.status, "ready");
  assert.equal(after.summary.version, ready.summary.version);
  assert.equal(after.summary.contentHash, ready.summary.contentHash);
  assert.equal(after.summary.updatedAt, ready.summary.updatedAt);
  assert.equal(after.summary.lastCheckpointAt, before.summary.lastCheckpointAt);
  assert.deepEqual(after.checkpoints, before.checkpoints);
  assert.deepEqual(after.events, before.events);
  await assert.rejects(
    store.setDraftTags({ draftId: created.summary.id, tags: ["stale"], expectedTags: ["Existing"] }),
    /tags changed since they were opened/i,
  );
});

test("catalog tag search, hierarchical OR filtering, and pre-tag facet counts stay consistent", async (t) => {
  const { store, draft: reactDraft } = await createGlobalDraft(t, "React notes", "component body");
  const vueDraft = await store.createDraft("ct_inbox", globalScope, "Vue notes", "composition body");
  const apiDraft = await store.createDraft("ct_inbox", globalScope, "API notes", "service body");
  await store.setDraftTags({
    draftId: reactDraft.summary.id,
    tags: ["Work/Frontend/React", "Straße"],
    expectedTags: [],
  });
  await store.setDraftTags({
    draftId: vueDraft.summary.id,
    tags: ["work/frontend/Vue"],
    expectedTags: [],
  });
  await store.setDraftTags({
    draftId: apiDraft.summary.id,
    tags: ["Work/Backend"],
    expectedTags: [],
  });

  assert.deepEqual((await store.scan("work/frontend/react")).drafts.map((draft) => draft.id), [reactDraft.summary.id]);
  assert.deepEqual((await store.scan("STRASSE")).drafts.map((draft) => draft.id), [reactDraft.summary.id]);
  const frontend = await store.scan("", null, null, false, ["WORK/FRONTEND"]);
  assert.deepEqual(
    new Set(frontend.drafts.map((draft) => draft.id)),
    new Set([reactDraft.summary.id, vueDraft.summary.id]),
  );
  assert.equal(findTagNode(frontend.tagTree, "Work")?.count, 3);
  assert.equal(findTagNode(frontend.tagTree, "Work/Frontend")?.count, 2);
  assert.equal(findTagNode(frontend.tagTree, "Work/Frontend")?.directCount, 0);

  const queryWithNonmatchingTag = await store.scan("vue", null, null, false, ["Work/Backend"]);
  assert.deepEqual(queryWithNonmatchingTag.drafts, []);
  assert.equal(findTagNode(queryWithNonmatchingTag.tagTree, "work/frontend/Vue")?.count, 1);
  assert.equal(findTagNode(queryWithNonmatchingTag.tagTree, "Work/Backend"), null);
});

test("global rename merges collisions and batch mutation can remove exact tags or whole subtrees", async (t) => {
  const { store, draft: first } = await createGlobalDraft(t, "First tags", "one");
  const second = await store.createDraft("ct_inbox", globalScope, "Second tags", "two");
  await store.setDraftTags({
    draftId: first.summary.id,
    tags: ["A/B", "Dest/B", "Keep"],
    expectedTags: [],
  });
  await store.setDraftTags({
    draftId: second.summary.id,
    tags: ["a/C", "Dest"],
    expectedTags: [],
  });
  const beforeFirst = await store.getDraft(first.summary.id);
  const beforeSecond = await store.getDraft(second.summary.id);

  const renamed = await store.renameTag("a", "Dest");
  assert.deepEqual(new Set(renamed.changedDrafts.map((draft) => draft.id)), new Set([first.summary.id, second.summary.id]));
  assert.deepEqual((await store.getDraft(first.summary.id)).summary.tags, ["Dest/B", "Keep"]);
  assert.deepEqual((await store.getDraft(second.summary.id)).summary.tags, ["Dest/C", "Dest"]);
  assert.equal((await store.getDraft(first.summary.id)).summary.version, beforeFirst.summary.version);
  assert.equal((await store.getDraft(second.summary.id)).summary.updatedAt, beforeSecond.summary.updatedAt);

  await store.batchDraftTags({
    draftIds: [first.summary.id, second.summary.id, first.summary.id],
    addTags: ["Common", "common"],
    removeTags: ["DEST"],
    removeDescendants: false,
  });
  assert.deepEqual((await store.getDraft(first.summary.id)).summary.tags, ["Dest/B", "Keep", "Common"]);
  assert.deepEqual((await store.getDraft(second.summary.id)).summary.tags, ["Dest/C", "Common"]);

  const subtreeRemoved = await store.batchDraftTags({
    draftIds: [first.summary.id, second.summary.id],
    addTags: [],
    removeTags: ["dest"],
    removeDescendants: true,
  });
  assert.deepEqual((await store.getDraft(first.summary.id)).summary.tags, ["Keep", "Common"]);
  assert.deepEqual((await store.getDraft(second.summary.id)).summary.tags, ["Common"]);
  assert.equal(findTagNode(subtreeRemoved.tagTree, "Dest"), null);
});

test("an interrupted logical tag journal resumes idempotently and preserves unrelated external tags", async (t) => {
  const { root, store, draft: first } = await createGlobalDraft(t, "Journal one", "one");
  const second = await store.createDraft("ct_inbox", globalScope, "Journal two", "two");
  await store.setDraftTags({ draftId: first.summary.id, tags: ["A/One", "Keep"], expectedTags: [] });
  await store.setDraftTags({ draftId: second.summary.id, tags: ["A/Two", "Other"], expectedTags: [] });
  const firstMetaPath = path.join(draftPath(root, first.summary.id), "meta.json");
  const firstMeta = JSON.parse(await readFile(firstMetaPath, "utf8")) as Record<string, unknown>;
  await writeFile(firstMetaPath, `${JSON.stringify({
    ...firstMeta,
    tags: ["B/One", "Keep", "A/Late", "External"],
  }, null, 2)}\n`, "utf8");

  const journalId = `tm_${"1".repeat(24)}`;
  const journalPath = path.join(root, ".transactions", `tag-mutation-${journalId}.json`);
  await writeFile(journalPath, `${JSON.stringify({
    schemaVersion: 1,
    operation: "tag-mutation",
    kind: "rename",
    id: journalId,
    fromPath: "A",
    toPath: "B",
    addTags: [],
    removeTags: [],
    removeDescendants: false,
    createdAt: "2026-08-25T04:00:00.000Z",
    nextIndex: 0,
    entries: [
      { draftId: first.summary.id, beforeTags: ["A/One", "Keep"], afterTags: ["B/One", "Keep"] },
      { draftId: second.summary.id, beforeTags: ["A/Two", "Other"], afterTags: ["B/Two", "Other"] },
    ],
  }, null, 2)}\n`, "utf8");

  const recovered = new PromptStudioStore(root);
  const scan = await recovered.scan();
  assert.deepEqual((await recovered.getDraft(first.summary.id)).summary.tags, ["B/One", "Keep", "B/Late", "External"]);
  assert.deepEqual((await recovered.getDraft(second.summary.id)).summary.tags, ["B/Two", "Other"]);
  assert.equal(findTagNode(scan.tagTree, "B")?.count, 2);
  assert.equal(await doesNotExist(journalPath), true);
  assert.deepEqual(
    (await readdir(path.join(root, ".transactions"))).filter((name) => name.startsWith("tag-mutation-")),
    [],
  );
});

test("journal replay safely merges a renamed subtree into its existing ancestor", async (t) => {
  const { root, store, draft } = await createGlobalDraft(t, "Ancestor journal", "body");
  await store.setDraftTags({
    draftId: draft.summary.id,
    tags: ["A/B", "A/B/B", "Keep"],
    expectedTags: [],
  });
  const metaPath = path.join(draftPath(root, draft.summary.id), "meta.json");
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
  await writeFile(metaPath, `${JSON.stringify({
    ...meta,
    tags: ["A", "A/B", "Keep", "A/B/Late"],
  }, null, 2)}\n`, "utf8");
  const journalId = `tm_${"2".repeat(24)}`;
  const journalPath = path.join(root, ".transactions", `tag-mutation-${journalId}.json`);
  await writeFile(journalPath, `${JSON.stringify({
    schemaVersion: 1,
    operation: "tag-mutation",
    kind: "rename",
    id: journalId,
    fromPath: "A/B",
    toPath: "A",
    addTags: [],
    removeTags: [],
    removeDescendants: false,
    createdAt: "2026-08-25T04:30:00.000Z",
    nextIndex: 0,
    entries: [{
      draftId: draft.summary.id,
      beforeTags: ["A/B", "A/B/B", "Keep"],
      afterTags: ["A", "A/B", "Keep"],
    }],
  }, null, 2)}\n`, "utf8");

  const recovered = new PromptStudioStore(root);
  assert.deepEqual(
    (await recovered.getDraft(draft.summary.id)).summary.tags,
    ["A", "A/B", "Keep", "A/Late"],
  );
  assert.equal(await doesNotExist(journalPath), true);
  await assert.rejects(recovered.renameTag("A", "A/B"), /own descendant/i);
});

test("rename recovery never resurrects an affected tag deleted after the metadata write", async (t) => {
  const { root, store, draft } = await createGlobalDraft(t, "External tag deletion", "body");
  await store.setDraftTags({
    draftId: draft.summary.id,
    tags: ["A/B", "A/B/B", "Keep"],
    expectedTags: [],
  });
  const metaPath = path.join(draftPath(root, draft.summary.id), "meta.json");
  const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
  // The rename A/B -> A reached meta.json, then an external tool removed the
  // mapped "A" tag before the journal cursor advanced.
  await writeFile(metaPath, `${JSON.stringify({ ...meta, tags: ["A/B", "Keep"] }, null, 2)}\n`, "utf8");
  const journalId = `tm_${"3".repeat(24)}`;
  const journalPath = path.join(root, ".transactions", `tag-mutation-${journalId}.json`);
  await writeFile(journalPath, `${JSON.stringify({
    schemaVersion: 1,
    operation: "tag-mutation",
    kind: "rename",
    id: journalId,
    fromPath: "A/B",
    toPath: "A",
    addTags: [],
    removeTags: [],
    removeDescendants: false,
    createdAt: "2026-08-25T04:45:00.000Z",
    nextIndex: 0,
    entries: [{
      draftId: draft.summary.id,
      beforeTags: ["A/B", "A/B/B", "Keep"],
      afterTags: ["A", "A/B", "Keep"],
    }],
  }, null, 2)}\n`, "utf8");

  const recovered = new PromptStudioStore(root);
  assert.deepEqual((await recovered.getDraft(draft.summary.id)).summary.tags, ["A/B", "Keep"]);
  assert.equal(await doesNotExist(journalPath), true);
});

test("batch recovery markers preserve later external add/delete edits and are always cleaned", async (t) => {
  const { root, store, draft: addDraft } = await createGlobalDraft(t, "Batch add recovery", "one");
  const removeDraft = await store.createDraft("ct_inbox", globalScope, "Batch remove recovery", "two");
  const cursorDraft = await store.createDraft("ct_inbox", globalScope, "Batch cursor recovery", "three");
  const legacyDraft = await store.createDraft("ct_inbox", globalScope, "Legacy batch recovery", "four");
  await store.setDraftTags({ draftId: addDraft.summary.id, tags: ["Keep"], expectedTags: [] });
  await store.setDraftTags({ draftId: removeDraft.summary.id, tags: ["Remove", "Keep"], expectedTags: [] });
  await store.setDraftTags({ draftId: cursorDraft.summary.id, tags: ["Cursor"], expectedTags: [] });
  await store.setDraftTags({ draftId: legacyDraft.summary.id, tags: ["Legacy"], expectedTags: [] });

  async function seedBatchJournal(input: {
    id: string;
    draftId: DraftDetail["summary"]["id"];
    beforeTags: string[];
    afterTags: string[];
    currentTags: string[];
    addTags: string[];
    removeTags: string[];
    nextIndex: 0 | 1;
    marker: boolean;
  }) {
    const metaPath = path.join(draftPath(root, input.draftId), "meta.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
    await writeFile(metaPath, `${JSON.stringify({
      ...meta,
      tags: input.currentTags,
      ...(input.marker ? { pendingTagMutation: { id: input.id, index: 0 } } : {}),
    }, null, 2)}\n`, "utf8");
    const journalPath = path.join(root, ".transactions", `tag-mutation-${input.id}.json`);
    await writeFile(journalPath, `${JSON.stringify({
      schemaVersion: 1,
      operation: "tag-mutation",
      kind: "batch",
      id: input.id,
      fromPath: null,
      toPath: null,
      addTags: input.addTags,
      removeTags: input.removeTags,
      removeDescendants: false,
      createdAt: "2026-08-25T04:50:00.000Z",
      nextIndex: input.nextIndex,
      entries: [{
        draftId: input.draftId,
        beforeTags: input.beforeTags,
        afterTags: input.afterTags,
      }],
    }, null, 2)}\n`, "utf8");
    return { metaPath, journalPath };
  }

  const seeded = await Promise.all([
    seedBatchJournal({
      id: `tm_${"a".repeat(24)}`,
      draftId: addDraft.summary.id,
      beforeTags: ["Keep"],
      afterTags: ["Keep", "Added"],
      currentTags: ["Keep"],
      addTags: ["Added"],
      removeTags: [],
      nextIndex: 0,
      marker: true,
    }),
    seedBatchJournal({
      id: `tm_${"b".repeat(24)}`,
      draftId: removeDraft.summary.id,
      beforeTags: ["Remove", "Keep"],
      afterTags: ["Keep"],
      currentTags: ["Remove", "Keep"],
      addTags: [],
      removeTags: ["Remove"],
      nextIndex: 0,
      marker: true,
    }),
    seedBatchJournal({
      id: `tm_${"c".repeat(24)}`,
      draftId: cursorDraft.summary.id,
      beforeTags: ["Cursor"],
      afterTags: ["Cursor", "Added"],
      currentTags: ["Cursor", "External"],
      addTags: ["Added"],
      removeTags: [],
      nextIndex: 1,
      marker: true,
    }),
    seedBatchJournal({
      id: `tm_${"d".repeat(24)}`,
      draftId: legacyDraft.summary.id,
      beforeTags: ["Legacy"],
      afterTags: ["Legacy", "Added"],
      currentTags: ["Legacy"],
      addTags: ["Added"],
      removeTags: [],
      nextIndex: 0,
      marker: false,
    }),
  ]);

  const recovered = new PromptStudioStore(root);
  await recovered.scan();
  assert.deepEqual((await recovered.getDraft(addDraft.summary.id)).summary.tags, ["Keep"]);
  assert.deepEqual((await recovered.getDraft(removeDraft.summary.id)).summary.tags, ["Remove", "Keep"]);
  assert.deepEqual((await recovered.getDraft(cursorDraft.summary.id)).summary.tags, ["Cursor", "External"]);
  assert.deepEqual((await recovered.getDraft(legacyDraft.summary.id)).summary.tags, ["Legacy", "Added"]);
  for (const item of seeded) {
    assert.equal(await doesNotExist(item.journalPath), true);
    const meta = JSON.parse(await readFile(item.metaPath, "utf8")) as Record<string, unknown>;
    assert.equal("pendingTagMutation" in meta, false);
  }
});

test("checkpoint Markdown is readable and restoring is reversible without changing draft metadata", async (t) => {
  const { store, draft } = await createGlobalDraft(t, "Recovery", "original body");
  await store.setDraftTags({ draftId: draft.summary.id, tags: ["keep-me"], expectedTags: [] });
  const saved = await store.autosaveDraft({
    draftId: draft.summary.id,
    title: "Recovery revised",
    markdown: "latest body",
    expectedVersion: draft.summary.version,
    expectedHash: draft.summary.contentHash,
  });
  assert.ok(saved.checkpoint);

  const original = await store.getCheckpoint(draft.summary.id, saved.checkpoint.id);
  assert.equal(original.markdown, "original body");
  assert.equal(original.version, draft.summary.version);

  const restored = await store.restoreCheckpoint({
    draftId: draft.summary.id,
    checkpointId: original.id,
    expectedVersion: saved.summary.version,
    expectedHash: saved.summary.contentHash,
  });
  assert.equal(restored.restored, true);
  assert.equal(restored.draft.markdown, "original body");
  assert.equal(restored.draft.summary.version, saved.summary.version + 1);
  assert.equal(restored.draft.summary.title, "Recovery revised");
  assert.equal(restored.draft.summary.status, "draft");
  assert.deepEqual(restored.draft.summary.tags, ["keep-me"]);
  const safetyCheckpoint = restored.draft.checkpoints.find(
    (checkpoint) => checkpoint.reason === "restore" && checkpoint.version === saved.summary.version,
  );
  assert.ok(safetyCheckpoint);
  assert.equal((await store.getCheckpoint(draft.summary.id, safetyCheckpoint.id)).markdown, "latest body");
  const restoreEvent = restored.draft.events.find((event) => event.type === "checkpoint.restored");
  assert.equal(restoreEvent?.details.checkpointId, original.id);
  assert.equal(restoreEvent?.details.safetyCheckpointId, safetyCheckpoint.id);

  const checkpointCount = restored.draft.checkpoints.length;
  const eventCount = restored.draft.events.length;
  const noOp = await store.restoreCheckpoint({
    draftId: draft.summary.id,
    checkpointId: original.id,
    expectedVersion: restored.draft.summary.version,
    expectedHash: restored.draft.summary.contentHash,
  });
  assert.equal(noOp.restored, false);
  assert.equal(noOp.draft.summary.version, restored.draft.summary.version);
  assert.equal(noOp.draft.checkpoints.length, checkpointCount);
  assert.equal(noOp.draft.events.length, eventCount);

  const undone = await store.restoreCheckpoint({
    draftId: draft.summary.id,
    checkpointId: safetyCheckpoint.id,
    expectedVersion: noOp.draft.summary.version,
    expectedHash: noOp.draft.summary.contentHash,
  });
  assert.equal(undone.draft.markdown, "latest body");
  assert.equal(undone.draft.summary.version, noOp.draft.summary.version + 1);
  const scan = await store.scan();
  assert.equal(scan.drafts.find((item) => item.id === draft.summary.id)?.preview, "latest body");
  assert.ok(scan.timeline.some(
    (entry) => entry.type === "update"
      && entry.draftId === draft.summary.id
      && /Restored checkpoint/.test(entry.summary),
  ));
});

test("checkpoint restore rejects stale state and tampered recovery content", async (t) => {
  const { store, draft } = await createGlobalDraft(t, "Protected recovery", "baseline");
  const saved = await store.autosaveDraft({
    draftId: draft.summary.id,
    title: draft.summary.title,
    markdown: "second body",
    expectedVersion: draft.summary.version,
    expectedHash: draft.summary.contentHash,
  });
  assert.ok(saved.checkpoint);
  const newer = await store.autosaveDraft({
    draftId: draft.summary.id,
    title: draft.summary.title,
    markdown: "third body",
    expectedVersion: saved.summary.version,
    expectedHash: saved.summary.contentHash,
  });
  await assert.rejects(
    store.restoreCheckpoint({
      draftId: draft.summary.id,
      checkpointId: saved.checkpoint.id,
      expectedVersion: saved.summary.version,
      expectedHash: saved.summary.contentHash,
    }),
    /changed since the checkpoint preview was opened/i,
  );
  assert.equal((await store.getDraft(draft.summary.id)).markdown, "third body");

  const containerRoot = await store.getContainerRoot("ct_inbox");
  const checkpointsRoot = path.join(draftPath(containerRoot, draft.summary.id), "checkpoints");
  const checkpointFile = (await readdir(checkpointsRoot)).find((name) => name.endsWith(`-${saved.checkpoint?.id}.md`));
  assert.ok(checkpointFile);
  const checkpointPath = path.join(checkpointsRoot, checkpointFile);
  const canonical = await readFile(checkpointPath, "utf8");
  const duplicatePath = path.join(checkpointsRoot, "duplicate.md");
  await writeFile(duplicatePath, canonical, "utf8");
  await assert.rejects(store.getCheckpoint(draft.summary.id, saved.checkpoint.id), /duplicate canonical checkpoint/i);
  const duplicated = await store.getDraft(draft.summary.id);
  assert.equal(duplicated.checkpoints.some((checkpoint) => checkpoint.id === saved.checkpoint?.id), false);
  assert.ok(duplicated.warnings.some((warning) => /duplicate canonical checkpoint/i.test(warning)));
  await rm(duplicatePath);

  await writeFile(checkpointPath, canonical.replace(/\r?\n\r?\n[\s\S]*$/, "\n\ntampered body"), "utf8");

  await assert.rejects(store.getCheckpoint(draft.summary.id, saved.checkpoint.id), /checkpoint hash mismatch/i);
  await assert.rejects(
    store.restoreCheckpoint({
      draftId: draft.summary.id,
      checkpointId: saved.checkpoint.id,
      expectedVersion: newer.summary.version,
      expectedHash: newer.summary.contentHash,
    }),
    /checkpoint hash mismatch/i,
  );
  assert.equal((await store.getDraft(draft.summary.id)).markdown, "third body");
});

test("external markdown edits become a checkpoint/event and make prior editor state stale", async (t) => {
  const { store, draft } = await createGlobalDraft(t, "External edit", "original body");
  const containerRoot = await store.getContainerRoot("ct_inbox");
  await writeFile(path.join(draftPath(containerRoot, draft.summary.id), "draft.md"), "edited outside\n", "utf8");

  const reconciled = await store.getDraft(draft.summary.id);
  assert.equal(reconciled.markdown, "edited outside\n");
  assert.equal(reconciled.summary.version, draft.summary.version + 1);
  assert.ok(reconciled.checkpoints.some((checkpoint) => checkpoint.reason === "external-edit"));
  assert.ok(reconciled.events.some((event) => event.type === "draft.external-edit" && event.actor === "external"));
  await assert.rejects(
    store.autosaveDraft({
      draftId: draft.summary.id,
      title: draft.summary.title,
      markdown: "stale editor overwrite",
      expectedVersion: draft.summary.version,
      expectedHash: draft.summary.contentHash,
    }),
    /changed since it was opened/i,
  );
});

test("malformed lineage JSON degrades to a warning without hiding readable draft text", async (t) => {
  const { store, draft } = await createGlobalDraft(t, "Readable", "canonical markdown survives");
  await markReady(store, draft.summary.id);
  const prepared = await store.prepareDispatch(draft.summary.id, { kind: "existing_agent", agentId: "agt_fixture" });
  const containerRoot = await store.getContainerRoot("ct_inbox");
  const dispatchPath = path.join(
    draftPath(containerRoot, draft.summary.id),
    "dispatches",
    `${prepared.dispatch.id}.json`,
  );
  await writeFile(dispatchPath, "{malformed dispatch", "utf8");

  const detail = await store.getDraft(draft.summary.id);
  assert.equal(detail.markdown, "canonical markdown survives");
  assert.equal(detail.dispatches.length, 0);
  assert.ok(detail.warnings.some((warning) => /dispatches.*json/i.test(warning)));
  const scan = await store.scan();
  assert.ok(scan.drafts.some((item) => item.id === draft.summary.id));
  assert.ok(scan.warnings.some((warning) => /dispatches.*json/i.test(warning)));
});

test("malformed draft metadata and project map do not hide other canonical Drafts", async (t) => {
  const { root, store } = await makeStore(t);
  const inbox = await store.ensureContainer(null);
  const project = await store.ensureContainer(source);
  const readable = await store.createDraft(inbox.summary.id, globalScope, "Healthy canonical draft", "still visible");
  const broken = await store.createDraft(project.summary.id, {
    projectId: source.projectId,
    projectName: source.name,
  }, "Broken metadata fixture", "body remains on disk");
  const projectRoot = await store.getContainerRoot(project.summary.id);
  await writeFile(path.join(draftPath(projectRoot, broken.summary.id), "meta.json"), "{bad meta", "utf8");

  const metaScan = await new PromptStudioStore(root).scan();
  assert.ok(metaScan.drafts.some((draft) => draft.id === readable.summary.id));
  assert.ok(metaScan.warnings.some((warning) => warning.includes(broken.summary.id) && /json/i.test(warning)));

  await writeFile(path.join(root, "local", "project-map.json"), "{bad project map", "utf8");
  const mappingScan = await new PromptStudioStore(root).scan();
  assert.ok(mappingScan.containers.some((container) => container.id === inbox.summary.id));
  assert.ok(mappingScan.drafts.some((draft) => draft.id === readable.summary.id));
  assert.ok(mappingScan.warnings.some((warning) => /project-map\.json/i.test(warning)));
});

test("a removed linked Project reports a warning but retains its Draft until explicit plugin deletion", async (t) => {
  const { root, store } = await makeStore(t);
  const linkedRoot = await mkdtemp(path.join(tmpdir(), "prompt-studio-linked-project-"));
  t.after(() => rm(linkedRoot, { recursive: true, force: true }));
  const linkedSource: ResolvedSourceProject = {
    projectId: "prj_removable",
    rootPath: linkedRoot,
    name: "Removable Project",
  };
  const project = await store.ensureContainer(linkedSource);
  const draft = await store.createDraft(
    project.summary.id,
    { projectId: linkedSource.projectId, projectName: linkedSource.name },
    "Keep after unlink",
    "canonical Draft content",
  );
  const canonicalDraftRoot = draftPath(root, draft.summary.id);
  assert.equal(await doesNotExist(canonicalDraftRoot), false);

  const availableWithoutWorkspaces = await projectLinkWarnings(store, {
    workspaces: {
      list: async () => ({
        entries: [],
        emptyProjects: [{
          projectId: linkedSource.projectId,
          projectRootPath: linkedSource.rootPath,
        }],
        pageInfo: { nextCursor: null, hasMore: false },
      }),
    },
  });
  assert.deepEqual(availableWithoutWorkspaces, []);

  const removedFromPaseo = await projectLinkWarnings(store, {
    workspaces: {
      list: async () => ({ entries: [], pageInfo: { nextCursor: null, hasMore: false } }),
    },
  });
  assert.ok(removedFromPaseo.some(
    (warning) => /linked Paseo Project prj_removable is unavailable/i.test(warning) && /retained/i.test(warning),
  ));
  assert.equal(await doesNotExist(canonicalDraftRoot), false);

  await rm(linkedRoot, { recursive: true, force: true });
  const reopened = new PromptStudioStore(root);
  const unlinkedScan = await reopened.scan("", null, null, true);
  assert.ok(unlinkedScan.drafts.some((item) => item.id === draft.summary.id));
  assert.ok(unlinkedScan.warnings.some(
    (warning) => /Removable Project/i.test(warning) && /unavailable/i.test(warning) && /retained/i.test(warning),
  ));
  assert.equal(await doesNotExist(canonicalDraftRoot), false);
  assert.match(await readFile(path.join(root, "local", "project-map.json"), "utf8"), /prj_removable/);

  const archived = await transitionTo(reopened, draft.summary.id, "archived");
  await reopened.deleteDraft({
    draftId: draft.summary.id,
    confirmationDraftId: draft.summary.id,
    expectedVersion: archived.summary.version,
    expectedHash: archived.summary.contentHash,
  });
  assert.equal(await doesNotExist(canonicalDraftRoot), true);
  assert.match(await readFile(path.join(root, "local", "project-map.json"), "utf8"), /prj_removable/);
});

test("a junction cannot expose legacy worklog data outside a managed container", async (t) => {
  const { store } = await createGlobalDraft(t);
  const outside = await mkdtemp(path.join(tmpdir(), "prompt-studio-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const containerRoot = await store.getContainerRoot("ct_inbox");
  const worklogRoot = path.join(containerRoot, "worklog");
  await writeFile(
    path.join(outside, "2026-08-24.md"),
    "# 2026-08-24\n\n## 2026-08-24T01:02:03.000Z\n\noutside historical note\n",
    "utf8",
  );
  await symlink(outside, worklogRoot, process.platform === "win32" ? "junction" : "dir");

  const scan = await store.scan("", null, null, true);
  assert.equal(scan.timeline.some((entry) => entry.type === "worklog"), false);
  assert.ok(scan.warnings.some((warning) => /symbolic-link|junction|escapes/i.test(warning)));
});

test("separate Store instances serialize optimistic saves with a filesystem lock", async (t) => {
  const { root, store, draft } = await createGlobalDraft(t, "Concurrent", "baseline");
  const first = new PromptStudioStore(root);
  const second = new PromptStudioStore(root);
  const save = (candidate: PromptStudioStoreType, markdown: string) => candidate.autosaveDraft({
    draftId: draft.summary.id,
    title: draft.summary.title,
    markdown,
    expectedVersion: draft.summary.version,
    expectedHash: draft.summary.contentHash,
  });

  const results = await Promise.allSettled([save(first, "writer A"), save(second, "writer B")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const current = await store.getDraft(draft.summary.id);
  assert.equal(current.summary.version, 2);
  assert.ok(["writer A", "writer B"].includes(current.markdown));
});

test("tag rename and content autosave share the per-Draft lock without losing either change", async (t) => {
  const { root, store, draft } = await createGlobalDraft(t, "Concurrent tags", "baseline");
  await store.setDraftTags({ draftId: draft.summary.id, tags: ["Race/Before"], expectedTags: [] });
  const tagWriter = new PromptStudioStore(root);
  const contentWriter = new PromptStudioStore(root);

  await Promise.all([
    tagWriter.renameTag("Race", "Renamed"),
    contentWriter.autosaveDraft({
      draftId: draft.summary.id,
      title: draft.summary.title,
      markdown: "content writer",
      expectedVersion: draft.summary.version,
      expectedHash: draft.summary.contentHash,
    }),
  ]);

  const current = await store.getDraft(draft.summary.id);
  assert.deepEqual(current.summary.tags, ["Renamed/Before"]);
  assert.equal(current.markdown, "content writer");
  assert.equal(current.summary.version, draft.summary.version + 1);
});

test("sent snapshots are immutable and retry lineage reuses snapshot and clientMessageId", async (t) => {
  const { store, draft } = await createGlobalDraft(t, "Send me", "frozen prompt");
  const ready = await markReady(store, draft.summary.id);
  const prepared = await store.prepareDispatch(draft.summary.id, { kind: "existing_agent", agentId: "agt_target" });
  await store.autosaveDraft({
    draftId: draft.summary.id,
    title: "Send me, revised",
    markdown: "mutable draft changed after dispatch",
    expectedVersion: ready.summary.version,
    expectedHash: ready.summary.contentHash,
  });
  assert.equal((await store.getDraft(draft.summary.id)).markdown, "mutable draft changed after dispatch");
  assert.equal((await store.getSnapshot(draft.summary.id, prepared.snapshot.id)).markdown, "frozen prompt");
  const failed = await store.finalizeDispatch(draft.summary.id, prepared.dispatch.id, {
    status: "failed",
    error: "provider rejected request",
    agentId: "agt_target",
  });
  assert.equal(failed.status, "failed");

  const retry = await store.markDispatchAttempt(draft.summary.id, failed.id);
  assert.equal(retry.status, "pending");
  assert.equal(retry.attemptCount, 2);
  assert.equal(retry.snapshotId, prepared.dispatch.snapshotId);
  assert.equal(retry.clientMessageId, prepared.dispatch.clientMessageId);
  assert.equal((await store.getSnapshot(draft.summary.id, retry.snapshotId)).markdown, "frozen prompt");

  const containerRoot = await store.getContainerRoot("ct_inbox");
  const snapshotPath = path.join(
    draftPath(containerRoot, draft.summary.id),
    "snapshots",
    `${retry.snapshotId}.md`,
  );
  await writeFile(snapshotPath, "tampered", "utf8");
  await assert.rejects(store.getSnapshot(draft.summary.id, retry.snapshotId), /immutable snapshot hash mismatch/i);
});

test("dispatcher sends an existing Agent the exact snapshot and client message id", async (t) => {
  const { store, draft } = await createGlobalDraft(t, "Existing agent", "exact existing-agent prompt");
  await markReady(store, draft.summary.id);
  const fake = createFakePaseo();
  const agent = fake.addAgent({ id: "agt_existing", workspaceId: "wks_source" });
  const dispatch = await createDispatchCoordinator(store, fake.paseo).send(draft.summary.id, {
    kind: "existing_agent",
    agentId: agent.id,
  });

  assert.equal(dispatch.status, "accepted");
  assert.equal(dispatch.agentId, agent.id);
  assert.equal(agent.sends.length, 1);
  assert.equal(agent.sends[0].text, "exact existing-agent prompt");
  assert.equal(agent.sends[0].messageId, dispatch.clientMessageId);
  assert.equal(dispatch.linkedSession?.userMessage, "exact existing-agent prompt");
  assert.equal((await store.getSnapshot(draft.summary.id, dispatch.snapshotId)).markdown, "exact existing-agent prompt");
});

test("dispatcher creates a new Agent in the selected source Workspace with explicit configuration", async (t) => {
  const { root, store, draft } = await createGlobalDraft(t, "New agent", "exact new-agent prompt");
  await markReady(store, draft.summary.id);
  const fake = createFakePaseo();
  const workspace = fake.addWorkspace({
    id: "wks_source",
    projectId: "prj_source",
    projectRootPath: path.join(path.dirname(root), "real-source-project"),
    behavior: "success",
  });
  const dispatch = await createDispatchCoordinator(store, fake.paseo).send(draft.summary.id, {
    kind: "new_agent",
    workspaceId: workspace.id,
    config: {
      provider: "codex",
      model: "gpt-5.4-mini",
      modeId: "auto-review",
      thinkingOptionId: "low",
      title: "Prompt Studio smoke",
    },
  });

  assert.equal(dispatch.status, "accepted");
  assert.equal(dispatch.workspaceId, workspace.id);
  assert.equal(workspace.creates.length, 1);
  assert.deepEqual(workspace.creates[0].config, {
    provider: "codex/gpt-5.4-mini",
    modeId: "auto-review",
    thinkingOptionId: "low",
  });
  assert.equal(workspace.creates[0].prompt, "exact new-agent prompt");
  assert.equal(workspace.creates[0].requestId, dispatch.id);
  assert.equal(workspace.creates[0].clientMessageId, dispatch.clientMessageId);
  assert.equal(workspace.creates[0].labels?.["prompt-studio.dispatch"], dispatch.id);
  assert.equal(workspace.creates[0].labels?.["prompt-studio.snapshot"], dispatch.snapshotId);
});

test("new Agent dispatch trusts the create acknowledgement instead of racing an immediate refresh", async (t) => {
  const { root, store, draft } = await createGlobalDraft(t, "Create race", "race-free new-agent prompt");
  await markReady(store, draft.summary.id);
  const fake = createFakePaseo();
  const workspace = fake.addWorkspace({
    id: "wks_create_race",
    projectId: "prj_create_race",
    projectRootPath: path.join(path.dirname(root), "source-for-create-race"),
    behavior: "refresh-not-found",
  });

  const dispatch = await createDispatchCoordinator(store, fake.paseo).send(draft.summary.id, {
    kind: "new_agent",
    workspaceId: workspace.id,
    config: {
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      modeId: "default",
      thinkingOptionId: "low",
      title: "Prompt Studio create race",
    },
  });

  assert.equal(dispatch.status, "accepted");
  assert.ok(dispatch.agentId);
  assert.equal(fake.agents.get(dispatch.agentId)?.refreshes, 0);
  assert.equal(workspace.creates.length, 1);
  assert.equal(workspace.creates[0].requestId, dispatch.id);
});

test("a provider rejection is durable and retry reconciles before sending a duplicate", async (t) => {
  const { root, store, draft } = await createGlobalDraft(t, "Retry", "idempotent retry prompt");
  await markReady(store, draft.summary.id);
  const fake = createFakePaseo();
  const agent = fake.addAgent({
    id: "agt_retry",
    workspaceId: "wks_retry",
    behavior: "reject",
  });
  const first = await createDispatchCoordinator(store, fake.paseo).send(draft.summary.id, {
    kind: "existing_agent",
    agentId: agent.id,
  });
  assert.equal(first.status, "failed");
  assert.match(first.error ?? "", /provider rejected request/i);
  assert.equal(first.attemptCount, 1);

  // Model a response that arrived after the local failure record, then restart the plugin store.
  agent.timeline.push({
    type: "user_message",
    text: "idempotent retry prompt",
    clientMessageId: first.clientMessageId,
  });
  agent.behavior = "success";
  const restartedStore = new PromptStudioStore(root);
  const coordinator = createDispatchCoordinator(restartedStore, fake.paseo);
  const reconciled = await coordinator.retry(draft.summary.id, first.id);
  assert.equal(reconciled.status, "accepted");
  assert.equal(reconciled.attemptCount, 1);
  assert.equal(reconciled.snapshotId, first.snapshotId);
  assert.equal(reconciled.clientMessageId, first.clientMessageId);
  assert.equal(agent.sends.length, 1);

  const repeated = await coordinator.retry(draft.summary.id, first.id);
  assert.equal(repeated.status, "accepted");
  assert.equal(agent.sends.length, 1);
});

test("archived drafts block failed-dispatch retry but still allow read-only reconciliation", async (t) => {
  const { store, draft } = await createGlobalDraft(t, "Archived retry", "already authorized prompt");
  await markReady(store, draft.summary.id);
  const fake = createFakePaseo();
  const agent = fake.addAgent({
    id: "agt_archived_retry",
    workspaceId: "wks_archived_retry",
    behavior: "reject",
  });
  const coordinator = createDispatchCoordinator(store, fake.paseo);
  const failed = await coordinator.send(draft.summary.id, {
    kind: "existing_agent",
    agentId: agent.id,
  });
  assert.equal(failed.status, "failed");
  const ready = await store.getDraft(draft.summary.id);
  await store.transitionDraft({
    draftId: draft.summary.id,
    targetStatus: "archived",
    expectedVersion: ready.summary.version,
    expectedHash: ready.summary.contentHash,
  });

  await assert.rejects(coordinator.retry(draft.summary.id, failed.id), /restore the archived draft/i);
  assert.equal(agent.sends.length, 1);
  assert.equal((await store.getDispatch(draft.summary.id, failed.id)).attemptCount, 1);

  agent.timeline.push({
    type: "user_message",
    text: "already authorized prompt",
    clientMessageId: failed.clientMessageId,
  });
  const reconciled = await coordinator.reconcile(draft.summary.id, failed.id);
  assert.equal(reconciled.status, "accepted");
  assert.equal(agent.sends.length, 1);
});

test("response-lost sends reconcile from exact existing/new Agent timeline lineage", async (t) => {
  const { root, store } = await makeStore(t);
  await store.ensureContainer(null);
  const existingDraft = await store.createDraft("ct_inbox", globalScope, "Existing lost", "existing response-lost prompt");
  const newDraft = await store.createDraft("ct_inbox", globalScope, "New lost", "new response-lost prompt");
  await markReady(store, existingDraft.summary.id);
  await markReady(store, newDraft.summary.id);
  const fake = createFakePaseo();
  const existing = fake.addAgent({
    id: "agt_response_lost",
    workspaceId: "wks_source",
    behavior: "response-lost",
  });
  const workspace = fake.addWorkspace({
    id: "wks_source",
    projectId: "prj_source",
    projectRootPath: path.join(path.dirname(root), "source-for-response-lost"),
    behavior: "response-lost",
  });
  const coordinator = createDispatchCoordinator(store, fake.paseo);

  const existingDispatch = await coordinator.send(existingDraft.summary.id, {
    kind: "existing_agent",
    agentId: existing.id,
  });
  assert.equal(existingDispatch.status, "accepted");
  assert.equal(existing.sends.length, 1);
  assert.ok((await store.getDraft(existingDraft.summary.id)).events.some((event) => event.type === "dispatch.reconciled"));

  const newDispatch = await coordinator.send(newDraft.summary.id, {
    kind: "new_agent",
    workspaceId: workspace.id,
    config: {
      provider: "codex",
      model: "gpt-5.4-mini",
      modeId: "auto-review",
      thinkingOptionId: "low",
      title: "Lost response agent",
    },
  });
  assert.equal(newDispatch.status, "accepted");
  assert.equal(workspace.creates.length, 1);
  assert.equal(newDispatch.workspaceId, workspace.id);
  assert.ok((await store.getDraft(newDraft.summary.id)).events.some((event) => event.type === "dispatch.reconciled"));
});

test("restart reconcile matches clientMessageId and exact text, not an unrelated session", async (t) => {
  const { root, store, draft } = await createGlobalDraft(t, "Restart", "restart reconciliation prompt");
  await markReady(store, draft.summary.id);
  const prepared = await store.prepareDispatch(draft.summary.id, {
    kind: "existing_agent",
    agentId: "agt_restart",
  });
  const fake = createFakePaseo();
  const agent = fake.addAgent({ id: "agt_restart", workspaceId: "wks_restart" });
  agent.timeline.push(
    { type: "user_message", text: "unrelated prompt", clientMessageId: prepared.dispatch.clientMessageId },
    { type: "user_message", text: prepared.snapshot.markdown, clientMessageId: "some-other-client-id" },
  );
  const restarted = createDispatchCoordinator(new PromptStudioStore(root), fake.paseo);
  const stillPending = await restarted.reconcile(draft.summary.id, prepared.dispatch.id);
  assert.equal(stillPending.status, "pending");

  agent.timeline.push({
    type: "user_message",
    text: prepared.snapshot.markdown,
    clientMessageId: prepared.dispatch.clientMessageId,
  });
  const accepted = await restarted.reconcile(draft.summary.id, prepared.dispatch.id);
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.agentId, agent.id);
  assert.equal(agent.sends.length, 0);
});

test("new Agent dispatch refuses the managed Prompt Studio Project before agent creation", async (t) => {
  const { store, draft } = await createGlobalDraft(t, "Managed path guard", "do not run in the vault");
  await markReady(store, draft.summary.id);
  const project = await store.ensureContainer(source);
  const companionRoot = await store.getContainerRoot(project.summary.id);
  const fake = createFakePaseo();
  const workspace = fake.addWorkspace({
    id: "wks_companion",
    projectId: "prj_companion",
    projectRootPath: companionRoot,
    workspaceDirectory: companionRoot,
    behavior: "success",
  });
  const dispatch = await createDispatchCoordinator(store, fake.paseo).send(draft.summary.id, {
    kind: "new_agent",
    workspaceId: workspace.id,
    config: {
      provider: "codex",
      model: "gpt-5.4-mini",
      modeId: "auto-review",
      thinkingOptionId: "low",
      title: "Forbidden companion agent",
    },
  });

  assert.equal(dispatch.status, "failed");
  assert.match(dispatch.error ?? "", /cannot run inside.*Prompt Studio Project/i);
  assert.equal(workspace.creates.length, 0);
  assert.equal((await store.getDraft(draft.summary.id)).summary.containerId, "ct_inbox");
});

test("timeline links only accepted Prompt Studio dispatches to their target session", async (t) => {
  const { store, draft } = await createGlobalDraft(t, "Linked session", "one exact user message");
  await markReady(store, draft.summary.id);
  const acceptedPrepared = await store.prepareDispatch(draft.summary.id, {
    kind: "existing_agent",
    agentId: "agt_target",
  });
  await store.finalizeDispatch(draft.summary.id, acceptedPrepared.dispatch.id, {
    status: "accepted",
    agentId: "agt_target",
    workspaceId: "wks_target",
    agentTitle: "Target agent",
    provider: "codex",
    userMessage: acceptedPrepared.snapshot.markdown,
  });
  const failedPrepared = await store.prepareDispatch(draft.summary.id, {
    kind: "existing_agent",
    agentId: "agt_other",
  });
  await store.finalizeDispatch(draft.summary.id, failedPrepared.dispatch.id, {
    status: "failed",
    error: "not accepted",
    agentId: "agt_other",
  });
  const scan = await store.scan();
  const sessions = scan.timeline.filter((entry) => entry.type === "session");
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].agentId, "agt_target");
  assert.equal(sessions[0].summary, "one exact user message");
  assert.equal(sessions[0].snapshotId, acceptedPrepared.snapshot.id);
  assert.ok(scan.timeline.some((entry) => entry.type === "sent" && entry.snapshotId === acceptedPrepared.snapshot.id));
  assert.ok(scan.timeline.some((entry) => entry.type === "failed" && entry.agentId === "agt_other"));
});

test("new containers omit writable worklog storage while legacy notes remain inspectable", async (t) => {
  const { store, draft } = await createGlobalDraft(t, "Legacy note owner", "current draft");
  const containerRoot = await store.getContainerRoot("ct_inbox");
  const worklogRoot = path.join(containerRoot, "worklog");
  assert.equal(await doesNotExist(worklogRoot), true);

  const legacyDayRoot = path.join(worklogRoot, "2026", "08");
  await mkdir(legacyDayRoot, { recursive: true });
  await writeFile(
    path.join(legacyDayRoot, "2026-08-24.md"),
    `# 2026-08-24\n\n## 2026-08-24T01:02:03.000Z · ${draft.summary.id}\n\nhistorical decision\n`,
    "utf8",
  );

  const scan = await store.scan("", null, null, true);
  const legacy = scan.timeline.find((entry) => entry.type === "worklog");
  assert.equal(legacy?.draftId, draft.summary.id);
  assert.equal(legacy?.summary, "historical decision");
  assert.equal(legacy?.title, "Historical worklog note");
});

test("catalog filters current title/body, status, and Project scope without transcript ingestion", async (t) => {
  const { store } = await makeStore(t);
  const inbox = await store.ensureContainer(null);
  const project = await store.ensureContainer(source);
  const inboxDraft = await store.createDraft(inbox.summary.id, globalScope, "Global needle", "unscoped body");
  const projectDraft = await store.createDraft(project.summary.id, {
    projectId: source.projectId,
    projectName: source.name,
  }, "Project prompt", "heading\nalpha detail lives here\nclosing beta project-only needle");
  const secondProjectDraft = await store.createDraft(project.summary.id, {
    projectId: source.projectId,
    projectName: source.name,
  }, "Second project prompt", "beta elsewhere");
  await transitionTo(store, inboxDraft.summary.id, "archived");

  assert.deepEqual((await store.scan("project-only")).drafts.map((item) => item.id), [projectDraft.summary.id]);
  const multiToken = await store.scan("alpha beta", null, source.projectId);
  assert.deepEqual(multiToken.drafts.map((item) => item.id), [projectDraft.summary.id]);
  assert.match(multiToken.drafts[0].preview, /alpha detail lives here/);
  assert.deepEqual((await store.scan("", "archived")).drafts.map((item) => item.id), [inboxDraft.summary.id]);
  assert.deepEqual(
    new Set((await store.scan("", ["draft", "ready"])).drafts.map((item) => item.id)),
    new Set([projectDraft.summary.id, secondProjectDraft.summary.id]),
  );
  assert.deepEqual((await store.scan("", [])).drafts, []);
  assert.deepEqual(
    new Set((await store.scan("", ["draft", "ready", "archived"])).drafts.map((item) => item.id)),
    new Set([inboxDraft.summary.id, projectDraft.summary.id, secondProjectDraft.summary.id]),
  );
  assert.deepEqual(
    new Set((await store.scan("", null, source.projectId)).drafts.map((item) => item.id)),
    new Set([projectDraft.summary.id, secondProjectDraft.summary.id]),
  );
  assert.deepEqual(
    (await store.scan("", null, [])).drafts,
    [],
  );
  assert.equal((await store.scan("", null, source.projectId)).drafts.every((draft) => !("workspaceId" in draft.scope)), true);
});

test("timeline preserves draft/update events and exposes pending dispatch snapshots for exact recall", async (t) => {
  const { store, draft } = await createGlobalDraft(t, "Timeline recall", "first version");
  const saved = await store.autosaveDraft({
    draftId: draft.summary.id,
    title: "Timeline recall",
    markdown: "second version",
    expectedVersion: draft.summary.version,
    expectedHash: draft.summary.contentHash,
  });
  await markReady(store, draft.summary.id);
  const prepared = await store.prepareDispatch(draft.summary.id, {
    kind: "existing_agent",
    agentId: "agt_pending",
  });

  const pendingScan = await store.scan();
  const created = pendingScan.timeline.find((entry) => entry.type === "draft" && entry.draftId === draft.summary.id);
  const updated = pendingScan.timeline.find((entry) => entry.type === "update" && entry.draftId === draft.summary.id);
  const pending = pendingScan.timeline.find((entry) => entry.type === "pending" && entry.dispatchId === prepared.dispatch.id);
  assert.equal(created?.at, draft.summary.createdAt);
  assert.ok(saved.event);
  assert.equal(updated?.at, saved.event.at);
  assert.equal(pending?.snapshotId, prepared.snapshot.id);
  assert.match(pending?.summary ?? "", new RegExp(prepared.dispatch.clientMessageId));

  await store.finalizeDispatch(draft.summary.id, prepared.dispatch.id, {
    status: "accepted",
    agentId: "agt_pending",
    workspaceId: "wks_pending",
    agentTitle: "Pending target",
    provider: "codex",
    userMessage: prepared.snapshot.markdown,
  });
  const acceptedScan = await store.scan();
  assert.equal(acceptedScan.timeline.some((entry) => entry.type === "pending" && entry.dispatchId === prepared.dispatch.id), false);
  assert.ok(acceptedScan.timeline.some((entry) => entry.type === "sent" && entry.snapshotId === prepared.snapshot.id));

  const project = await store.ensureContainer(source);
  await store.moveDraftScope(draft.summary.id, project.summary.id, {
    projectId: source.projectId,
    projectName: source.name,
  });
  await transitionTo(store, draft.summary.id, "archived");
  const lifecycleScan = await store.scan();
  assert.ok(lifecycleScan.timeline.some((entry) => entry.type === "scope" && entry.draftId === draft.summary.id));
  assert.ok(lifecycleScan.timeline.some((entry) => entry.type === "status" && entry.draftId === draft.summary.id));
});

test("timeline collapses rapid Scope and archive round trips to their net result", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "prompt-studio-timeline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = new Date("2026-08-24T17:31:30.000Z");
  const store = new PromptStudioStore(root, { now: () => new Date(now) });
  await store.ensureContainer(null);
  const project = await store.ensureContainer(source);
  const draft = await store.createDraft("ct_inbox", globalScope, "Lifecycle noise", "body");
  const projectScope: DraftScope = { projectId: source.projectId, projectName: source.name };

  await store.moveDraftScope(draft.summary.id, project.summary.id, projectScope);
  now = new Date(now.getTime() + 1_000);
  await store.moveDraftScope(draft.summary.id, "ct_inbox", globalScope);
  const restoredNoOp = await transitionTo(store, draft.summary.id, "draft");
  assert.equal(restoredNoOp.events.filter((event) => event.type === "draft.status-changed").length, 0);
  now = new Date(now.getTime() + 1_000);
  await transitionTo(store, draft.summary.id, "archived");
  now = new Date(now.getTime() + 1_000);
  await transitionTo(store, draft.summary.id, "draft");

  const roundTrip = await store.scan("", null, null, true);
  assert.equal(roundTrip.timeline.some((entry) => entry.type === "scope" && entry.draftId === draft.summary.id), false);
  assert.equal(roundTrip.timeline.some((entry) => entry.type === "status" && entry.draftId === draft.summary.id), false);

  now = new Date(now.getTime() + 11_000);
  await store.moveDraftScope(draft.summary.id, project.summary.id, projectScope);
  now = new Date(now.getTime() + 11_000);
  await transitionTo(store, draft.summary.id, "archived");
  const settled = await store.scan("", null, null, true);
  const scopeEntries = settled.timeline.filter((entry) => entry.type === "scope" && entry.draftId === draft.summary.id);
  const statusEntries = settled.timeline.filter((entry) => entry.type === "status" && entry.draftId === draft.summary.id);
  assert.equal(scopeEntries.length, 1);
  assert.equal(scopeEntries[0].summary, `Moved from Inbox to ${source.name}`);
  assert.equal(statusEntries.length, 1);
  assert.equal(statusEntries[0].summary, "Archived Lifecycle noise");
});

test("draft lifecycle creates a checkpoint on ready and restores the pre-archive state", async (t) => {
  const { store, draft } = await createGlobalDraft(t, "Lifecycle", "body");

  const ready = await transitionTo(store, draft.summary.id, "ready");
  assert.equal(ready.summary.status, "ready");
  assert.equal(ready.summary.schemaVersion, 5);
  assert.deepEqual(ready.summary.contentOrigin, { kind: "manual" });
  const readyCheckpoints = ready.checkpoints.filter((checkpoint) => checkpoint.reason === "ready");
  assert.equal(readyCheckpoints.length, 1);
  assert.equal(readyCheckpoints[0].version, ready.summary.version);
  assert.equal((await store.getCheckpoint(draft.summary.id, readyCheckpoints[0].id)).markdown, "body");
  assert.equal(draftAutosaveRpc.input.safeParse({
    draftId: draft.summary.id,
    title: ready.summary.title,
    status: "ready",
    tags: ready.summary.tags,
    markdown: ready.markdown,
    expectedVersion: ready.summary.version,
    expectedHash: ready.summary.contentHash,
  }).success, false);

  const noOp = await store.transitionDraft({
    draftId: draft.summary.id,
    targetStatus: "ready",
    expectedVersion: ready.summary.version,
    expectedHash: ready.summary.contentHash,
  });
  assert.equal(noOp.changed, false);
  assert.equal(noOp.draft.summary.version, ready.summary.version);
  assert.equal(noOp.draft.checkpoints.filter((checkpoint) => checkpoint.reason === "ready").length, 1);

  const returnedToDraft = await transitionTo(store, draft.summary.id, "draft");
  assert.equal(returnedToDraft.summary.status, "draft");
  const readyAgain = await transitionTo(store, draft.summary.id, "ready");
  assert.equal(readyAgain.checkpoints.filter((checkpoint) => checkpoint.reason === "ready").length, 2);

  const archived = await transitionTo(store, draft.summary.id, "archived");
  assert.equal(archived.summary.status, "archived");
  assert.equal(archived.summary.archivedFromStatus, "ready");
  assert.ok(archived.summary.archivedAt);
  await assert.rejects(transitionTo(store, draft.summary.id, "draft"), /invalid draft status transition/i);
  await assert.rejects(
    store.autosaveDraft({
      draftId: draft.summary.id,
      title: archived.summary.title,
      markdown: archived.markdown,
      expectedVersion: archived.summary.version,
      expectedHash: archived.summary.contentHash,
    }),
    /restore the archived draft/i,
  );

  const restored = await transitionTo(store, draft.summary.id, "ready");
  assert.equal(restored.summary.status, "ready");
  assert.equal(restored.summary.archivedAt, null);
  assert.equal(restored.summary.archivedFromStatus, null);
  assert.ok(restored.events.some((event) => event.type === "draft.status-changed"
    && event.details.fromStatus === "archived"
    && event.details.toStatus === "ready"));
});

test("batch lifecycle handler reports stale drafts without hiding successful transitions", async (t) => {
  const { store } = await makeStore(t);
  await store.ensureContainer(null);
  const first = await store.createDraft("ct_inbox", globalScope, "First batch draft", "first");
  const stale = await store.createDraft("ct_inbox", globalScope, "Stale batch draft", "stale");

  const result = await createHandlers(store).draftBatchTransition({
    transitions: [
      {
        draftId: first.summary.id,
        targetStatus: "ready",
        expectedVersion: first.summary.version,
        expectedHash: first.summary.contentHash,
      },
      {
        draftId: stale.summary.id,
        targetStatus: "ready",
        expectedVersion: stale.summary.version + 1,
        expectedHash: stale.summary.contentHash,
      },
    ],
  });

  assert.deepEqual(result.changedDrafts.map((draft) => draft.id), [first.summary.id]);
  assert.deepEqual(result.unchangedDraftIds, []);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.draftId, stale.summary.id);
  assert.match(result.failures[0]?.message ?? "", /conflict|version/i);
  assert.equal((await store.getDraft(first.summary.id)).summary.status, "ready");
  assert.equal((await store.getDraft(stale.summary.id)).summary.status, "draft");
});

test("editing a ready draft returns it to draft for autosave, external edits, and checkpoint restore", async (t) => {
  const { store, draft } = await createGlobalDraft(t, "Ready edits", "first body");
  const ready = await markReady(store, draft.summary.id);
  const originalReadyCheckpoint = ready.checkpoints.find((checkpoint) => checkpoint.reason === "ready");
  assert.ok(originalReadyCheckpoint);

  const saved = await store.autosaveDraft({
    draftId: draft.summary.id,
    title: ready.summary.title,
    markdown: "second body",
    expectedVersion: ready.summary.version,
    expectedHash: ready.summary.contentHash,
  });
  assert.equal(saved.summary.status, "draft");
  const afterAutosave = await store.getDraft(draft.summary.id);
  assert.ok(afterAutosave.events.some((event) => event.type === "draft.status-changed"
    && event.details.fromStatus === "ready"
    && event.details.toStatus === "draft"
    && event.details.reason === "content-edited"));
  await assert.rejects(
    store.prepareDispatch(draft.summary.id, { kind: "existing_agent", agentId: "agt_blocked_after_edit" }),
    /only ready drafts can be sent/i,
  );

  const readyForExternalEdit = await markReady(store, draft.summary.id);
  const containerRoot = await store.getContainerRoot("ct_inbox");
  await writeFile(path.join(draftPath(containerRoot, draft.summary.id), "draft.md"), "edited outside\n", "utf8");
  const externallyEdited = await store.getDraft(draft.summary.id);
  assert.equal(externallyEdited.summary.status, "draft");
  assert.ok(externallyEdited.events.some((event) => event.type === "draft.status-changed" && event.actor === "external"));
  assert.ok(externallyEdited.summary.version > readyForExternalEdit.summary.version);

  const readyForRestore = await markReady(store, draft.summary.id);
  const restored = await store.restoreCheckpoint({
    draftId: draft.summary.id,
    checkpointId: originalReadyCheckpoint.id,
    expectedVersion: readyForRestore.summary.version,
    expectedHash: readyForRestore.summary.contentHash,
  });
  assert.equal(restored.restored, true);
  assert.equal(restored.draft.markdown, "first body");
  assert.equal(restored.draft.summary.status, "draft");
});

test("generated revisions create an undo checkpoint and persist/reset body provenance", async (t) => {
  const { store, draft } = await createGlobalDraft(t, "Generate me", "original body");
  const ready = await markReady(store, draft.summary.id);
  const generationId = "gn_111111111111111111111111";
  const applied = await store.applyGenerationRevision({
    draftId: draft.summary.id,
    generationId,
    task: "related",
    markdown: "optimized body",
    expectedVersion: ready.summary.version,
    expectedHash: ready.summary.contentHash,
    agentId: "agt_generated",
    provider: "codex",
    model: "gpt-test",
    counts: {
      eligibleOtherPromptCount: 3,
      includedOtherPromptCount: 2,
      eligibleReferenceVersionCount: 4,
      includedReferenceVersionCount: 3,
      eligibleTargetHistoryVersionCount: 2,
      includedTargetHistoryVersionCount: 1,
      truncated: true,
      estimatedInputTokens: 400,
      inputTokenBudget: 500,
    },
  });
  assert.equal(applied.status, "applied");
  if (applied.status !== "applied") return;
  assert.equal(applied.draft.markdown, "optimized body");
  assert.equal(applied.draft.summary.status, "draft");
  assert.deepEqual(applied.draft.summary.contentOrigin, {
    kind: "generated",
    task: "related",
    generationId,
    at: applied.draft.summary.updatedAt,
    agentId: "agt_generated",
    provider: "codex",
    model: "gpt-test",
    includedPromptCount: 2,
    includedVersionCount: 4,
  });
  const checkpoint = await store.getCheckpoint(draft.summary.id, applied.checkpointId);
  assert.equal(checkpoint.reason, "before-generation");
  assert.equal(checkpoint.markdown, "original body");
  assert.ok(applied.draft.events.some((event) => event.type === "generation.applied"
    && event.details.generationId === generationId));

  const titleOnly = await store.autosaveDraft({
    draftId: draft.summary.id,
    title: "Renamed generated prompt",
    markdown: applied.draft.markdown,
    expectedVersion: applied.draft.summary.version,
    expectedHash: applied.draft.summary.contentHash,
  });
  assert.equal(titleOnly.summary.contentOrigin.kind, "generated");
  const manualBody = await store.autosaveDraft({
    draftId: draft.summary.id,
    title: titleOnly.summary.title,
    markdown: "manually edited body",
    expectedVersion: titleOnly.summary.version,
    expectedHash: titleOnly.summary.contentHash,
  });
  assert.deepEqual(manualBody.summary.contentOrigin, { kind: "manual" });
});

test("a generated response becomes a conflict candidate instead of overwriting a newer revision", async (t) => {
  const { store, draft } = await createGlobalDraft(t, "Concurrent", "base body");
  const newer = await store.autosaveDraft({
    draftId: draft.summary.id,
    title: draft.summary.title,
    markdown: "newer body",
    expectedVersion: draft.summary.version,
    expectedHash: draft.summary.contentHash,
  });
  const result = await store.applyGenerationRevision({
    draftId: draft.summary.id,
    generationId: "gn_222222222222222222222222",
    task: "format",
    markdown: "stale generated body",
    expectedVersion: draft.summary.version,
    expectedHash: draft.summary.contentHash,
    agentId: "agt_conflict",
    provider: "kimi",
    model: "k-test",
    counts: {
      eligibleOtherPromptCount: 0,
      includedOtherPromptCount: 0,
      eligibleReferenceVersionCount: 0,
      includedReferenceVersionCount: 0,
      eligibleTargetHistoryVersionCount: 0,
      includedTargetHistoryVersionCount: 0,
      truncated: false,
      estimatedInputTokens: 100,
      inputTokenBudget: 1_000,
    },
  });
  assert.equal(result.status, "conflict");
  assert.equal(result.draft.markdown, "newer body");
  assert.equal(result.draft.summary.version, newer.summary.version);
  assert.deepEqual(result.draft.summary.contentOrigin, { kind: "manual" });
  assert.ok(result.draft.events.some((event) => event.type === "generation.conflict"));
});

test("schema-v2 archived metadata reads as v5 and naturally upgrades on restore", async (t) => {
  const { root, store, draft } = await createGlobalDraft(t, "Legacy lifecycle", "legacy body");
  const containerRoot = await store.getContainerRoot("ct_inbox");
  const metaPath = path.join(draftPath(containerRoot, draft.summary.id), "meta.json");
  const legacy = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
  legacy.schemaVersion = 2;
  legacy.status = "archived";
  legacy.archivedAt = "2026-08-24T01:00:00.000Z";
  delete legacy.archivedFromStatus;
  await writeFile(metaPath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

  const reopenedStore = new PromptStudioStore(root);
  const reopened = await reopenedStore.getDraft(draft.summary.id);
  assert.equal(reopened.summary.schemaVersion, 5);
  assert.deepEqual(reopened.summary.contentOrigin, { kind: "manual" });
  assert.equal(reopened.summary.status, "archived");
  assert.equal(reopened.summary.archivedFromStatus, "draft");

  const restored = await transitionTo(reopenedStore, draft.summary.id, "draft");
  assert.equal(restored.summary.status, "draft");
  const upgraded = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
  assert.equal(upgraded.schemaVersion, 5);
  assert.equal(upgraded.archivedFromStatus, null);
});

test("schema-v3 starred metadata migrates to ready without rewriting on read", async (t) => {
  const { root, store, draft } = await createGlobalDraft(t, "Legacy starred", "legacy favorite");
  const archivedDraft = await store.createDraft("ct_inbox", globalScope, "Legacy archived star", "archived favorite");
  const containerRoot = await store.getContainerRoot("ct_inbox");
  const activeMetaPath = path.join(draftPath(containerRoot, draft.summary.id), "meta.json");
  const archivedMetaPath = path.join(draftPath(containerRoot, archivedDraft.summary.id), "meta.json");
  const activeMeta = JSON.parse(await readFile(activeMetaPath, "utf8")) as Record<string, unknown>;
  const archivedMeta = JSON.parse(await readFile(archivedMetaPath, "utf8")) as Record<string, unknown>;
  Object.assign(activeMeta, { schemaVersion: 3, status: "starred", archivedFromStatus: null });
  Object.assign(archivedMeta, {
    schemaVersion: 3,
    status: "archived",
    archivedAt: "2026-08-24T01:00:00.000Z",
    archivedFromStatus: "starred",
  });
  await writeFile(activeMetaPath, `${JSON.stringify(activeMeta, null, 2)}\n`, "utf8");
  await writeFile(archivedMetaPath, `${JSON.stringify(archivedMeta, null, 2)}\n`, "utf8");

  const reopenedStore = new PromptStudioStore(root);
  const migratedActive = await reopenedStore.getDraft(draft.summary.id);
  const migratedArchived = await reopenedStore.getDraft(archivedDraft.summary.id);
  assert.equal(migratedActive.summary.status, "ready");
  assert.equal(migratedArchived.summary.status, "archived");
  assert.equal(migratedArchived.summary.archivedFromStatus, "ready");
  assert.equal((JSON.parse(await readFile(activeMetaPath, "utf8")) as { schemaVersion: number }).schemaVersion, 3);

  await transitionTo(reopenedStore, draft.summary.id, "draft");
  await transitionTo(reopenedStore, archivedDraft.summary.id, "ready");
  assert.equal((JSON.parse(await readFile(activeMetaPath, "utf8")) as { schemaVersion: number }).schemaVersion, 5);
  assert.equal((JSON.parse(await readFile(archivedMetaPath, "utf8")) as { schemaVersion: number }).schemaVersion, 5);
});

test("only ready drafts are sendable and status filtering has no draft star state", async (t) => {
  const { store, draft: ordinary } = await createGlobalDraft(t, "Ordinary", "not ready");
  const sendable = await store.createDraft("ct_inbox", globalScope, "Sendable", "reusable prompt");
  await assert.rejects(
    store.prepareDispatch(ordinary.summary.id, { kind: "existing_agent", agentId: "agt_blocked" }),
    /only ready drafts can be sent/i,
  );
  const ready = await markReady(store, sendable.summary.id);
  assert.deepEqual((await store.scan("", "ready")).drafts.map((item) => item.id), [sendable.summary.id]);
  const prepared = await store.prepareDispatch(ready.summary.id, { kind: "existing_agent", agentId: "agt_ready" });
  assert.equal(prepared.snapshot.markdown, "reusable prompt");
});

test("permanent deletion removes the full lineage, cross-container events, cache, and catalog entry", async (t) => {
  const { root, store, draft } = await createGlobalDraft(t, "Delete me", "sensitive prompt");
  const inboxRoot = await store.getContainerRoot("ct_inbox");
  const project = await store.ensureContainer(source);
  const projectRoot = await store.getContainerRoot(project.summary.id);
  await markReady(store, draft.summary.id);
  const prepared = await store.prepareDispatch(draft.summary.id, { kind: "existing_agent", agentId: "agt_delete" });
  await store.finalizeDispatch(draft.summary.id, prepared.dispatch.id, {
    status: "failed",
    error: "fixture failure",
    agentId: "agt_delete",
  });
  await store.moveDraftScope(draft.summary.id, project.summary.id, {
    projectId: source.projectId,
    projectName: source.name,
  });
  const active = await store.getDraft(draft.summary.id);
  await assert.rejects(
    store.deleteDraft({
      draftId: draft.summary.id,
      confirmationDraftId: draft.summary.id,
      expectedVersion: active.summary.version,
      expectedHash: active.summary.contentHash,
    }),
    /only archived drafts/i,
  );
  const archived = await transitionTo(store, draft.summary.id, "archived");
  await store.scan();
  await assert.rejects(
    store.deleteDraft({
      draftId: draft.summary.id,
      confirmationDraftId: "dr_0000000000000000",
      expectedVersion: archived.summary.version,
      expectedHash: archived.summary.contentHash,
    }),
    /confirmation did not match/i,
  );

  const result = await store.deleteDraft({
    draftId: draft.summary.id,
    confirmationDraftId: draft.summary.id,
    expectedVersion: archived.summary.version,
    expectedHash: archived.summary.contentHash,
  });
  assert.equal(result.deletedDraftId, draft.summary.id);
  assert.equal(await doesNotExist(draftPath(projectRoot, draft.summary.id)), true);
  await assert.rejects(store.getDraft(draft.summary.id), /unknown prompt studio draft/i);
  const scan = await store.scan();
  assert.equal(scan.drafts.some((item) => item.id === draft.summary.id), false);
  assert.equal(scan.timeline.some((entry) => entry.draftId === draft.summary.id), false);
  assert.doesNotMatch(await readFile(path.join(root, "catalog.json"), "utf8"), new RegExp(draft.summary.id));
  for (const containerRoot of [inboxRoot, projectRoot]) {
    for (const filePath of await filesBelow(path.join(containerRoot, "events"))) {
      assert.doesNotMatch(await readFile(filePath, "utf8"), new RegExp(draft.summary.id));
    }
  }
});

test("permanent deletion blocks pending and malformed dispatch lineage until it is resolved", async (t) => {
  const { store, draft } = await createGlobalDraft(t, "Delete guarded", "body");
  await markReady(store, draft.summary.id);
  const prepared = await store.prepareDispatch(draft.summary.id, { kind: "existing_agent", agentId: "agt_pending_delete" });
  const archived = await transitionTo(store, draft.summary.id, "archived");
  const deletion = () => store.deleteDraft({
    draftId: draft.summary.id,
    confirmationDraftId: draft.summary.id,
    expectedVersion: archived.summary.version,
    expectedHash: archived.summary.contentHash,
  });
  await assert.rejects(deletion(), /reconcile every pending dispatch/i);

  const finalized = await store.finalizeDispatch(draft.summary.id, prepared.dispatch.id, {
    status: "failed",
    error: "resolved failure",
    agentId: "agt_pending_delete",
  });
  const containerRoot = await store.getContainerRoot("ct_inbox");
  const dispatchPath = path.join(draftPath(containerRoot, draft.summary.id), "dispatches", `${prepared.dispatch.id}.json`);
  await writeFile(dispatchPath, "{malformed", "utf8");
  await assert.rejects(deletion(), /repair malformed dispatch records/i);
  await writeFile(dispatchPath, `${JSON.stringify(finalized, null, 2)}\n`, "utf8");
  await deletion();
  assert.equal(await doesNotExist(draftPath(containerRoot, draft.summary.id)), true);
});

test("an interrupted permanent deletion journal completes on restart", async (t) => {
  const { root, store, draft } = await createGlobalDraft(t, "Crash delete", "remove after restart");
  const archived = await transitionTo(store, draft.summary.id, "archived");
  const containerRoot = await store.getContainerRoot("ct_inbox");
  const canonicalRoot = draftPath(containerRoot, draft.summary.id);
  const transactionsRoot = path.join(root, ".transactions");
  const quarantineRoot = path.join(transactionsRoot, `deleting-${draft.summary.id}`);
  const journalPath = path.join(transactionsRoot, `delete-${draft.summary.id}.json`);
  await writeFile(journalPath, `${JSON.stringify({
    schemaVersion: 3,
    operation: "draft-delete",
    draftId: draft.summary.id,
    containerId: archived.summary.containerId,
    createdAt: "2026-08-24T01:00:00.000Z",
  }, null, 2)}\n`, "utf8");
  await rename(canonicalRoot, quarantineRoot);

  const recoveredStore = new PromptStudioStore(root);
  const scan = await recoveredStore.scan();
  assert.equal(scan.drafts.some((item) => item.id === draft.summary.id), false);
  assert.equal(await doesNotExist(quarantineRoot), true);
  assert.equal(await doesNotExist(journalPath), true);
  for (const filePath of await filesBelow(path.join(containerRoot, "events"))) {
    assert.doesNotMatch(await readFile(filePath, "utf8"), new RegExp(draft.summary.id));
  }
});

test("permanent deletion rejects a Junction inside the draft tree before committing", async (t) => {
  const { root, store, draft } = await createGlobalDraft(t, "Unsafe delete", "body");
  const archived = await transitionTo(store, draft.summary.id, "archived");
  const containerRoot = await store.getContainerRoot("ct_inbox");
  const outside = await mkdtemp(path.join(tmpdir(), "prompt-studio-delete-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const sentinel = path.join(outside, "keep.txt");
  await writeFile(sentinel, "keep", "utf8");
  await symlink(outside, path.join(draftPath(containerRoot, draft.summary.id), "unsafe-link"), process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    store.deleteDraft({
      draftId: draft.summary.id,
      confirmationDraftId: draft.summary.id,
      expectedVersion: archived.summary.version,
      expectedHash: archived.summary.contentHash,
    }),
    /symbolic-link|junction/i,
  );
  assert.equal(await readFile(sentinel, "utf8"), "keep");
  assert.equal(await doesNotExist(path.join(root, ".transactions", `delete-${draft.summary.id}.json`)), true);
});
