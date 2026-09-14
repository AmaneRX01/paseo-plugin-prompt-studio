import {
  mkdir,
  readFile,
} from "node:fs/promises";
import path from "node:path";
import type { ContainerId } from "../../shared/contracts";
import {
  assertSafePath,
  appendTextIfUnchanged,
  atomicWriteIfUnchanged,
  exists,
  formatError,
  normalizePath,
  pathFingerprint,
  projectIdFingerprint,
  readJson,
  writeIfMissing,
  writeJson,
} from "./filesystem";
import {
  MANIFEST_NAME,
  manifestSchema,
  placementSchema,
  projectMapSchema,
  type LocalProjectSource,
  type LocalRegistration,
  type Manifest,
  type Placement,
  type ProjectLink,
  type ProjectMap,
} from "./model";

const PROJECT_MAP_NAME = "project-map.json";

const ROOT_README = `# Paseo Prompt Studio

This directory is the single Paseo Project owned by Prompt Studio. Canonical Draft lineage lives under \`drafts/dr_*/\`; \`local/project-map.json\` links external project folders to Paseo Project IDs without owning or deleting those folders. \`catalog.json\` is a disposable derived index.
`;

const AGENTS_MANAGED_START = "<!-- prompt-studio:managed-agent-access:start -->";
const AGENTS_MANAGED_END = "<!-- prompt-studio:managed-agent-access:end -->";
const AGENTS_MANAGED_BLOCK = `${AGENTS_MANAGED_START}
## Generated-Agent access boundary

The Prompt Studio managed vault is application data, not project context. Any Agent launched by Prompt Studio must never read, search, enumerate, summarize, or modify this vault or any descendant path. Prompt Studio's trusted daemon process may access it only to implement storage and recovery workflows.
${AGENTS_MANAGED_END}`;

const ROOT_AGENTS = `# Prompt Studio vault

This is the only Paseo Project managed by Prompt Studio. Drafts are plaintext under \`drafts/dr_*/draft.md\`; \`meta.json\` records optimistic version/hash metadata and Project Scope. Treat checkpoints, snapshots, and dispatch records as lineage. External project folders are links recorded in \`local/project-map.json\`; a missing linked folder must never cause Draft deletion. Worklog is a read-only derived view and \`catalog.json\` is not canonical.

${AGENTS_MANAGED_BLOCK}
`;

type ManagedAgentsBlockPlan =
  | { kind: "current" }
  | { kind: "append"; suffix: string }
  | { kind: "replace"; next: string };

function planManagedAgentsBlock(current: string): ManagedAgentsBlockPlan {
  const start = current.indexOf(AGENTS_MANAGED_START);
  const end = current.indexOf(AGENTS_MANAGED_END);
  const duplicateStart = start === -1
    ? -1
    : current.indexOf(AGENTS_MANAGED_START, start + AGENTS_MANAGED_START.length);
  const duplicateEnd = end === -1
    ? -1
    : current.indexOf(AGENTS_MANAGED_END, end + AGENTS_MANAGED_END.length);
  if (
    (start === -1) !== (end === -1)
    || (start !== -1 && end < start)
    || duplicateStart !== -1
    || duplicateEnd !== -1
  ) {
    throw new Error("Prompt Studio AGENTS.md contains a malformed managed access block");
  }
  if (start === -1) {
    const separator = current.length === 0 || current.endsWith("\n\n")
      ? ""
      : current.endsWith("\n")
        ? "\n"
        : "\n\n";
    return { kind: "append", suffix: `${separator}${AGENTS_MANAGED_BLOCK}\n` };
  }
  const after = end + AGENTS_MANAGED_END.length;
  const existingBlock = current.slice(start, after);
  if (existingBlock === AGENTS_MANAGED_BLOCK) return { kind: "current" };
  return {
    kind: "replace",
    next: `${current.slice(0, start)}${AGENTS_MANAGED_BLOCK}${current.slice(after)}`,
  };
}

export interface ResolvedSourceProject {
  projectId: string;
  rootPath: string;
  name: string;
}

export interface VaultContainerRecord {
  manifest: Manifest;
  source: LocalProjectSource | null;
  linkError: string | null;
}

export interface EnsureVaultContainerResult {
  created: boolean;
  manifest: Manifest;
  placement: Placement;
}

export type RegistrationUpdate =
  | { status: "registered"; projectId: string; workspaceId: string }
  | { status: "pending"; error: string };

function pendingRegistration(error: string | null = null): LocalRegistration {
  return { status: "pending", projectId: null, workspaceId: null, error };
}

function sourceFromResolved(source: ResolvedSourceProject): LocalProjectSource {
  return {
    projectId: source.projectId,
    rootPath: path.resolve(source.rootPath),
    name: source.name,
  };
}

export class VaultRepository {
  readonly rootPath: string;
  readonly draftsPath: string;
  readonly eventsPath: string;
  readonly localPath: string;
  readonly projectMapPath: string;
  readonly transactionsPath: string;
  private readonly now: () => Date;

  constructor(rootPath: string, now: () => Date) {
    this.rootPath = path.resolve(rootPath);
    this.draftsPath = path.join(this.rootPath, "drafts");
    this.eventsPath = path.join(this.rootPath, "events");
    this.localPath = path.join(this.rootPath, "local");
    this.projectMapPath = path.join(this.localPath, PROJECT_MAP_NAME);
    this.transactionsPath = path.join(this.rootPath, ".transactions");
    this.now = now;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  async initialize(): Promise<void> {
    for (const directory of [
      this.draftsPath,
      this.eventsPath,
      this.localPath,
      this.transactionsPath,
    ]) {
      await assertSafePath(this.rootPath, directory);
      await mkdir(directory, { recursive: true });
      await assertSafePath(this.rootPath, directory);
    }
    await this.ensureCurrentFiles();
  }

  private async ensureCurrentFiles(): Promise<void> {
    const now = this.timestamp();
    const manifestPath = path.join(this.rootPath, MANIFEST_NAME);
    if (!(await exists(manifestPath))) {
      const manifest: Manifest = {
        schemaVersion: 1,
        kind: "prompt-studio-container",
        id: "ct_inbox",
        containerType: "inbox",
        title: "Prompt Studio",
        sourceProjectName: null,
        sourcePathFingerprint: null,
        createdAt: now,
        updatedAt: now,
      };
      await writeJson(manifestPath, manifest, this.rootPath);
    } else {
      manifestSchema.parse(await readJson(manifestPath));
    }

    if (!(await exists(this.projectMapPath))) {
      const map: ProjectMap = {
        schemaVersion: 1,
        kind: "prompt-studio-project-map",
        pluginProject: { rootPath: this.rootPath, registration: pendingRegistration() },
        projects: [],
        updatedAt: now,
      };
      await writeJson(this.projectMapPath, map, this.rootPath);
    } else {
      try {
        const current = projectMapSchema.parse(await readJson(this.projectMapPath));
        if (normalizePath(current.pluginProject.rootPath) !== normalizePath(this.rootPath)) {
          await this.writeProjectMap({
            ...current,
            pluginProject: {
              rootPath: this.rootPath,
              registration: pendingRegistration("Prompt Studio vault path changed; register the new path"),
            },
            updatedAt: now,
          });
        }
      } catch {
        // Do not overwrite a malformed canonical map. Scans retain readable Drafts
        // and surface a warning; mutations stay blocked until the map is repaired.
      }
    }
    const readmePath = path.join(this.rootPath, "README.md");
    await writeIfMissing(readmePath, ROOT_README, this.rootPath);
    const agentsPath = path.join(this.rootPath, "AGENTS.md");
    const createdAgents = await writeIfMissing(agentsPath, ROOT_AGENTS, this.rootPath);
    if (!createdAgents) {
      await assertSafePath(this.rootPath, agentsPath);
      const observed = await readFile(agentsPath, "utf8");
      const plan = planManagedAgentsBlock(observed);
      if (plan.kind === "append") {
        try {
          await appendTextIfUnchanged(agentsPath, observed, plan.suffix, this.rootPath);
        } catch (error) {
          throw new Error(
            `Prompt Studio AGENTS.md changed while its managed block was being appended; `
            + `external content was not overwritten: ${formatError(error)}`,
          );
        }
      } else if (plan.kind === "replace") {
        try {
          await atomicWriteIfUnchanged(agentsPath, observed, plan.next, this.rootPath);
        } catch (error) {
          throw new Error(
            `Prompt Studio AGENTS.md managed block cannot be replaced safely; `
            + `${formatError(error)}`,
          );
        }
      }
    }
  }

  private async readProjectMap(): Promise<ProjectMap> {
    await assertSafePath(this.rootPath, this.projectMapPath);
    const map = projectMapSchema.parse(await readJson(this.projectMapPath));
    const ids = new Set<string>();
    for (const project of map.projects) {
      if (project.manifest.containerType !== "project") {
        throw new Error(`Project map contains a non-project container: ${project.manifest.id}`);
      }
      if (ids.has(project.manifest.id)) throw new Error(`Duplicate project link: ${project.manifest.id}`);
      ids.add(project.manifest.id);
    }
    return map;
  }

  private async writeProjectMap(map: ProjectMap): Promise<void> {
    await writeJson(this.projectMapPath, projectMapSchema.parse(map), this.rootPath);
  }

  async listContainers(): Promise<VaultContainerRecord[]> {
    const root = await this.rootContainer();
    const map = await this.readProjectMap();
    return [
      root,
      ...map.projects.map((project) => ({ ...project })),
    ];
  }

  async rootContainer(): Promise<VaultContainerRecord> {
    const manifest = manifestSchema.parse(await readJson(path.join(this.rootPath, MANIFEST_NAME)));
    return { manifest, source: null, linkError: null };
  }

  async findContainer(containerId: ContainerId): Promise<VaultContainerRecord> {
    if (containerId === "ct_inbox") return this.rootContainer();
    const found = (await this.listContainers()).find((container) => container.manifest.id === containerId);
    if (!found) throw new Error(`Unknown Prompt Studio container: ${containerId}`);
    return found;
  }

  async placementFor(containerId: ContainerId): Promise<Placement> {
    const container = await this.findContainer(containerId);
    const map = await this.readProjectMap();
    return placementSchema.parse({
      schemaVersion: 1,
      containerId,
      source: container.source,
      companion: {
        rootPath: this.rootPath,
        registration: map.pluginProject.registration,
      },
      updatedAt: map.updatedAt,
    });
  }

  async ensureContainer(source: ResolvedSourceProject | null): Promise<EnsureVaultContainerResult> {
    if (!source) {
      const manifest = manifestSchema.parse(await readJson(path.join(this.rootPath, MANIFEST_NAME)));
      return { created: false, manifest, placement: await this.placementFor("ct_inbox") };
    }
    const normalizedSource = sourceFromResolved(source);
    const map = await this.readProjectMap();
    // Link identity is the Paseo projectId; the linked folder path is payload
    // that follows the Project wherever it lives.
    const index = map.projects.findIndex((project) => project.source?.projectId === normalizedSource.projectId);
    if (index >= 0) {
      const current = map.projects[index];
      const containerId = current.manifest.id;
      const changed = JSON.stringify(current.source) !== JSON.stringify(normalizedSource)
        || current.linkError !== null
        || current.manifest.sourceProjectName !== source.name;
      if (changed) {
        const now = this.timestamp();
        const updated: ProjectLink = {
          manifest: {
            ...current.manifest,
            title: `${source.name} Prompts`,
            sourceProjectName: source.name,
            updatedAt: now,
          },
          source: normalizedSource,
          linkError: null,
        };
        const projects = [...map.projects];
        projects[index] = updated;
        await this.writeProjectMap({ ...map, projects, updatedAt: now });
      }
      return { created: false, manifest: (changed ? (await this.findContainer(containerId)) : current).manifest, placement: await this.placementFor(containerId) };
    }

    const fingerprint = projectIdFingerprint(normalizedSource.projectId);
    const containerId = `ct_${fingerprint.slice(-64, -48)}` as ContainerId;
    if (map.projects.some((project) => project.manifest.id === containerId)) {
      throw new Error(`Container identity collision for ${source.name}`);
    }
    const now = this.timestamp();
    const manifest: Manifest = {
      schemaVersion: 1,
      kind: "prompt-studio-container",
      id: containerId,
      containerType: "project",
      title: `${source.name} Prompts`,
      sourceProjectName: source.name,
      sourcePathFingerprint: pathFingerprint(normalizedSource.rootPath),
      createdAt: now,
      updatedAt: now,
    };
    await this.writeProjectMap({
      ...map,
      projects: [...map.projects, { manifest, source: normalizedSource, linkError: null }],
      updatedAt: now,
    });
    return { created: true, manifest, placement: await this.placementFor(containerId) };
  }

  async removeProjectLink(projectId: string): Promise<boolean> {
    const map = await this.readProjectMap();
    const remaining = map.projects.filter((project) => project.source?.projectId !== projectId);
    if (remaining.length === map.projects.length) return false;
    await this.writeProjectMap({ ...map, projects: remaining, updatedAt: this.timestamp() });
    return true;
  }

  async recordRegistration(registration: RegistrationUpdate): Promise<void> {
    const map = await this.readProjectMap();
    const nextRegistration: LocalRegistration = registration.status === "registered"
      ? {
          status: "registered",
          projectId: registration.projectId,
          workspaceId: registration.workspaceId,
          error: null,
        }
      : pendingRegistration(registration.error);
    await this.writeProjectMap({
      ...map,
      pluginProject: { rootPath: this.rootPath, registration: nextRegistration },
      updatedAt: this.timestamp(),
    });
  }

  async findContainerByRoot(rootPath: string): Promise<VaultContainerRecord | null> {
    const normalized = normalizePath(rootPath);
    if (normalized === normalizePath(this.rootPath)) return this.findContainer("ct_inbox");
    return null;
  }

  async getContainerSource(containerId: ContainerId): Promise<ResolvedSourceProject | null> {
    const source = (await this.findContainer(containerId)).source;
    return source ? { ...source } : null;
  }

  // Per-link availability is reported through the structured project-link
  // status RPC (Settings → Migration), not as scan warnings; a malformed map
  // is the only map condition that stays a scan warning.
  async linkEntries(): Promise<ProjectLink[]> {
    return (await this.readProjectMap()).projects.map((project) => ({ ...project }));
  }

  async containerIdsForProjects(projectIds: ReadonlySet<string>): Promise<Set<ContainerId>> {
    const ids = new Set<ContainerId>();
    for (const container of await this.listContainers()) {
      if (container.source && projectIds.has(container.source.projectId)) ids.add(container.manifest.id);
    }
    return ids;
  }

  async eventRoots(): Promise<string[]> {
    return [this.eventsPath];
  }
}
