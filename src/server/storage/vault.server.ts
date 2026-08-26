import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
} from "node:fs/promises";
import path from "node:path";
import type { ContainerId } from "../../shared/contracts.shared";
import {
  assertSafePath,
  assertTreeSafe,
  appendTextIfUnchanged,
  atomicWrite,
  atomicWriteIfUnchanged,
  exists,
  formatError,
  normalizePath,
  pathFingerprint,
  readJson,
  writeIfMissing,
  writeJson,
} from "./filesystem.server";
import {
  DRAFT_META_NAME,
  MANIFEST_NAME,
  draftMetaSchema,
  manifestSchema,
  moveJournalSchema,
  placementSchema,
  projectMapSchema,
  vaultMigrationJournalSchema,
  type LocalProjectSource,
  type LocalRegistration,
  type Manifest,
  type Placement,
  type ProjectLink,
  type ProjectMap,
  type VaultMigrationJournal,
} from "./model.server";

const PROJECT_MAP_NAME = "project-map.json";
const MIGRATION_JOURNAL_NAME = "storage-unification.json";

const ROOT_README = `# Paseo Prompt Studio

This directory is the single Paseo Project owned by Prompt Studio. Canonical Draft lineage lives under \`drafts/dr_*/\`; \`local/project-map.json\` links external project folders to Paseo Project IDs without owning or deleting those folders. \`catalog.json\` is a disposable derived index.
`;

const LEGACY_ROOT_READMES = new Set([
  "# Paseo Prompt Studio\n\nThis is a schema-v2 plaintext prompt vault. `Prompt-Studio-Inbox/` contains global drafts; project companions live under `companions/`. `catalog.json` is a disposable derived index. Daemon-local paths and Paseo IDs live only under `local/placements/`.\n",
  "# Paseo Prompt Studio\n\nThis is a schema-v3 plaintext prompt vault for Draft metadata; containers and immutable lineage remain schema v2. `Prompt-Studio-Inbox/` contains global drafts; project companions live under `companions/`. `catalog.json` is a disposable derived index. Daemon-local paths and Paseo IDs live only under `local/placements/`.\n",
]);

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
  workspaceId: string;
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
    workspaceId: source.workspaceId,
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
  readonly legacyPath: string;
  readonly legacyContainersPath: string;
  private readonly now: () => Date;

  constructor(rootPath: string, now: () => Date) {
    this.rootPath = path.resolve(rootPath);
    this.draftsPath = path.join(this.rootPath, "drafts");
    this.eventsPath = path.join(this.rootPath, "events");
    this.localPath = path.join(this.rootPath, "local");
    this.projectMapPath = path.join(this.localPath, PROJECT_MAP_NAME);
    this.transactionsPath = path.join(this.rootPath, ".transactions");
    this.legacyPath = path.join(this.rootPath, "legacy");
    this.legacyContainersPath = path.join(this.legacyPath, "containers");
    this.now = now;
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private migrationJournalPath(): string {
    return path.join(this.transactionsPath, MIGRATION_JOURNAL_NAME);
  }

  private relativePath(candidate: string): string {
    const relative = path.relative(this.rootPath, candidate);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path is outside the Prompt Studio vault: ${candidate}`);
    }
    return relative.split(path.sep).join("/");
  }

  private fromRelative(relative: string): string {
    const candidate = path.resolve(this.rootPath, ...relative.split("/"));
    const checked = path.relative(this.rootPath, candidate);
    if (!checked || checked.startsWith("..") || path.isAbsolute(checked)) {
      throw new Error(`Migration path escapes the Prompt Studio vault: ${relative}`);
    }
    return candidate;
  }

  async initialize(): Promise<void> {
    for (const directory of [
      this.draftsPath,
      this.eventsPath,
      this.localPath,
      this.transactionsPath,
      this.legacyContainersPath,
    ]) {
      await assertSafePath(this.rootPath, directory);
      await mkdir(directory, { recursive: true });
      await assertSafePath(this.rootPath, directory);
    }

    await this.recoverLegacyScopeMoves();
    let migration: VaultMigrationJournal | null = null;
    const journalPath = this.migrationJournalPath();
    if (await exists(journalPath)) {
      await assertSafePath(this.rootPath, journalPath);
      migration = vaultMigrationJournalSchema.parse(await readJson(journalPath));
    } else {
      const legacyRoots = await this.legacyManifestRoots();
      if (legacyRoots.length) migration = await this.prepareLegacyMigration(legacyRoots);
    }
    if (migration) await this.completeLegacyMigration(migration);
    await this.ensureCurrentFiles();
    await this.removeEmptyLegacyParents();
  }

  private async legacyManifestRoots(): Promise<string[]> {
    const roots: string[] = [];
    const inbox = path.join(this.rootPath, "Prompt-Studio-Inbox");
    if (await exists(path.join(inbox, MANIFEST_NAME))) roots.push(inbox);
    const companions = path.join(this.rootPath, "companions");
    if (!(await exists(companions))) return roots;
    await assertSafePath(this.rootPath, companions);
    for (const entry of await readdir(companions, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = path.join(companions, entry.name);
      if (await exists(path.join(candidate, MANIFEST_NAME))) roots.push(candidate);
    }
    return roots;
  }

  private async readLegacyContainers(roots: readonly string[]): Promise<Array<{
    root: string;
    manifest: Manifest;
    source: LocalProjectSource | null;
    linkError: string | null;
  }>> {
    const result: Array<{
      root: string;
      manifest: Manifest;
      source: LocalProjectSource | null;
      linkError: string | null;
    }> = [];
    const ids = new Set<string>();
    for (const root of roots) {
      await assertSafePath(this.rootPath, root);
      const manifest = manifestSchema.parse(await readJson(path.join(root, MANIFEST_NAME)));
      if (ids.has(manifest.id)) throw new Error(`Duplicate legacy container identity: ${manifest.id}`);
      ids.add(manifest.id);
      let source: LocalProjectSource | null = null;
      let linkError: string | null = null;
      const placementPath = path.join(this.rootPath, "local", "placements", `${manifest.id}.json`);
      try {
        const placement = placementSchema.parse(await readJson(placementPath));
        source = placement.source;
      } catch (error) {
        if (manifest.containerType === "project") {
          linkError = `Legacy project placement could not be read: ${formatError(error)}`;
        }
      }
      result.push({ root, manifest, source, linkError });
    }
    return result;
  }

  private async recoverLegacyScopeMoves(): Promise<void> {
    const legacyRoots = await this.legacyManifestRoots();
    if (!legacyRoots.length) return;
    const containers = await this.readLegacyContainers(legacyRoots);
    const roots = new Map(containers.map((container) => [container.manifest.id, container.root]));
    for (const entry of await readdir(this.transactionsPath, { withFileTypes: true })) {
      if (!entry.isFile() || entry.isSymbolicLink() || !/^scope-dr_[a-f0-9]{16}\.json$/.test(entry.name)) continue;
      const journalPath = path.join(this.transactionsPath, entry.name);
      await assertSafePath(this.rootPath, journalPath);
      const journal = moveJournalSchema.parse(await readJson(journalPath));
      const sourceRoot = roots.get(journal.sourceContainerId);
      const targetRoot = roots.get(journal.targetContainerId);
      if (!sourceRoot || !targetRoot) {
        throw new Error(`Unable to recover ${entry.name}: a legacy container is unavailable`);
      }
      const sourceDraft = path.join(sourceRoot, "drafts", journal.draftId);
      const targetDraft = path.join(targetRoot, "drafts", journal.draftId);
      const sourceExists = await exists(sourceDraft);
      const targetExists = await exists(targetDraft);
      if (sourceExists && targetExists) {
        throw new Error(`Both sides of interrupted scope move exist for ${journal.draftId}`);
      }
      if (sourceExists) {
        await assertTreeSafe(sourceRoot, sourceDraft);
        await assertSafePath(targetRoot, path.dirname(targetDraft));
        await rename(sourceDraft, targetDraft);
      }
      if (!(await exists(targetDraft))) {
        throw new Error(`Neither side of interrupted scope move exists for ${journal.draftId}`);
      }
      await assertTreeSafe(targetRoot, targetDraft);
      const metaPath = path.join(targetDraft, DRAFT_META_NAME);
      const current = draftMetaSchema.parse(await readJson(metaPath));
      if (current.id !== journal.draftId) {
        throw new Error(`Interrupted scope move Draft directory/id mismatch: ${journal.draftId}`);
      }
      if (
        current.containerId !== journal.targetContainerId
        || JSON.stringify(current.scope) !== JSON.stringify(journal.targetScope)
      ) {
        await writeJson(metaPath, {
          ...current,
          containerId: journal.targetContainerId,
          scope: journal.targetScope,
          version: current.version + 1,
          updatedAt: this.timestamp(),
        }, targetRoot);
      }
      await rm(journalPath, { force: true });
    }
  }

  private async prepareLegacyMigration(legacyRoots: readonly string[]): Promise<VaultMigrationJournal> {
    const containers = await this.readLegacyContainers(legacyRoots);
    const drafts: VaultMigrationJournal["drafts"] = [];
    for (const container of containers) {
      const draftsRoot = path.join(container.root, "drafts");
      if (!(await exists(draftsRoot))) continue;
      await assertSafePath(container.root, draftsRoot);
      for (const entry of await readdir(draftsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !/^dr_[a-f0-9]{16}$/.test(entry.name)) continue;
        drafts.push({
          draftId: entry.name as VaultMigrationJournal["drafts"][number]["draftId"],
          sourceContainerId: container.manifest.id,
          legacyRelativePath: this.relativePath(path.join(draftsRoot, entry.name)),
        });
      }
    }
    const ids = new Set<string>();
    for (const draft of drafts) {
      if (ids.has(draft.draftId)) throw new Error(`Two canonical legacy copies exist for ${draft.draftId}`);
      ids.add(draft.draftId);
    }
    const journal = vaultMigrationJournalSchema.parse({
      schemaVersion: 1,
      operation: "unify-prompt-studio-vault",
      createdAt: this.timestamp(),
      containers: containers.map((container) => ({
        manifest: container.manifest,
        source: container.source,
        linkError: container.linkError,
        legacyRelativePath: this.relativePath(container.root),
      })),
      drafts,
    });
    await writeJson(this.migrationJournalPath(), journal, this.rootPath);
    return journal;
  }

  private mapFromMigration(journal: VaultMigrationJournal): ProjectMap {
    const projects: ProjectLink[] = journal.containers
      .filter((container) => container.manifest.containerType === "project")
      .map((container) => ({
        manifest: container.manifest,
        source: container.source,
        linkError: container.linkError ?? (container.source ? null : "Legacy project link is unavailable"),
      }));
    return projectMapSchema.parse({
      schemaVersion: 1,
      kind: "prompt-studio-project-map",
      pluginProject: {
        rootPath: this.rootPath,
        registration: pendingRegistration(
          "Storage was unified into one Prompt Studio Project; register this vault path once",
        ),
      },
      projects,
      updatedAt: this.timestamp(),
    });
  }

  private rootManifestFromMigration(journal: VaultMigrationJournal): Manifest {
    const inbox = journal.containers.find((container) => container.manifest.id === "ct_inbox")?.manifest;
    const now = this.timestamp();
    return manifestSchema.parse({
      schemaVersion: 2,
      kind: "prompt-studio-container",
      id: "ct_inbox",
      containerType: "inbox",
      title: "Prompt Studio",
      sourceProjectName: null,
      sourcePathFingerprint: null,
      createdAt: inbox?.createdAt ?? now,
      updatedAt: now,
    });
  }

  private validateMigrationJournal(journal: VaultMigrationJournal): void {
    const containers = new Map<string, VaultMigrationJournal["containers"][number]>();
    for (const container of journal.containers) {
      if (containers.has(container.manifest.id)) {
        throw new Error(`Migration journal repeats container ${container.manifest.id}`);
      }
      if (
        container.legacyRelativePath !== "Prompt-Studio-Inbox"
        && !/^companions\/[^/]+$/.test(container.legacyRelativePath)
      ) {
        throw new Error(`Migration journal has an unmanaged legacy container path: ${container.legacyRelativePath}`);
      }
      containers.set(container.manifest.id, container);
    }
    const draftIds = new Set<string>();
    for (const draft of journal.drafts) {
      if (draftIds.has(draft.draftId)) throw new Error(`Migration journal repeats Draft ${draft.draftId}`);
      draftIds.add(draft.draftId);
      const container = containers.get(draft.sourceContainerId);
      if (!container) throw new Error(`Migration journal references unknown container ${draft.sourceContainerId}`);
      const expected = `${container.legacyRelativePath}/drafts/${draft.draftId}`;
      if (draft.legacyRelativePath !== expected) {
        throw new Error(`Migration journal has an invalid Draft source path: ${draft.legacyRelativePath}`);
      }
    }
  }

  private async completeLegacyMigration(journal: VaultMigrationJournal): Promise<void> {
    this.validateMigrationJournal(journal);
    const rootManifestPath = path.join(this.rootPath, MANIFEST_NAME);
    if (!(await exists(rootManifestPath))) {
      await writeJson(rootManifestPath, this.rootManifestFromMigration(journal), this.rootPath);
    } else {
      const current = manifestSchema.parse(await readJson(rootManifestPath));
      if (current.id !== "ct_inbox" || current.containerType !== "inbox") {
        throw new Error("The unified vault manifest does not identify the Prompt Studio Inbox");
      }
    }
    if (!(await exists(this.projectMapPath))) {
      await writeJson(this.projectMapPath, this.mapFromMigration(journal), this.rootPath);
    } else {
      const current = projectMapSchema.parse(await readJson(this.projectMapPath));
      const expected = this.mapFromMigration(journal);
      for (const project of expected.projects) {
        const existing = current.projects.find((candidate) => candidate.manifest.id === project.manifest.id);
        if (!existing || JSON.stringify(existing) !== JSON.stringify(project)) {
          throw new Error(`Existing project map conflicts with migration container ${project.manifest.id}`);
        }
      }
    }

    for (const draft of journal.drafts) {
      const source = this.fromRelative(draft.legacyRelativePath);
      const target = path.join(this.draftsPath, draft.draftId);
      const sourceExists = await exists(source);
      const targetExists = await exists(target);
      if (sourceExists && targetExists) {
        throw new Error(`Migration found two canonical copies of ${draft.draftId}`);
      }
      if (sourceExists) {
        const sourceBoundary = path.dirname(path.dirname(source));
        await assertTreeSafe(sourceBoundary, source);
        await assertSafePath(this.rootPath, target);
        await rename(source, target);
      }
      if (!(await exists(target))) throw new Error(`Migration lost canonical Draft ${draft.draftId}`);
    }

    for (const container of journal.containers) {
      const source = this.fromRelative(container.legacyRelativePath);
      const archive = path.join(this.legacyContainersPath, container.manifest.id);
      const sourceExists = await exists(source);
      const archiveExists = await exists(archive);
      if (sourceExists && archiveExists) {
        throw new Error(`Both active and archived legacy roots exist for ${container.manifest.id}`);
      }
      if (sourceExists) {
        const legacyDrafts = path.join(source, "drafts");
        if (await exists(legacyDrafts)) {
          const remaining = (await readdir(legacyDrafts, { withFileTypes: true })).filter(
            (entry) => entry.isDirectory() && !entry.isSymbolicLink() && /^dr_[a-f0-9]{16}$/.test(entry.name),
          );
          if (remaining.length) {
            throw new Error(`Migration journal does not cover legacy Draft ${remaining[0].name}`);
          }
        }
        await assertTreeSafe(this.rootPath, source);
        await assertSafePath(this.rootPath, archive);
        await rename(source, archive);
      }
    }

    const placements = path.join(this.localPath, "placements");
    const archivedPlacements = path.join(this.legacyPath, "placements");
    if (await exists(placements)) {
      if (await exists(archivedPlacements)) {
        throw new Error("Both active and archived legacy placement directories exist");
      }
      await assertTreeSafe(this.rootPath, placements);
      await rename(placements, archivedPlacements);
    }
    await rm(this.migrationJournalPath(), { force: true });
  }

  private async ensureCurrentFiles(): Promise<void> {
    const now = this.timestamp();
    const manifestPath = path.join(this.rootPath, MANIFEST_NAME);
    if (!(await exists(manifestPath))) {
      const manifest: Manifest = {
        schemaVersion: 2,
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
    if (await exists(readmePath)) {
      await assertSafePath(this.rootPath, readmePath);
      if (LEGACY_ROOT_READMES.has(await readFile(readmePath, "utf8"))) {
        await atomicWrite(readmePath, ROOT_README, this.rootPath);
      }
    } else {
      await writeIfMissing(readmePath, ROOT_README, this.rootPath);
    }
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

  private async removeEmptyLegacyParents(): Promise<void> {
    const companions = path.join(this.rootPath, "companions");
    if (!(await exists(companions))) return;
    await assertSafePath(this.rootPath, companions);
    const info = await lstat(companions);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    if ((await readdir(companions)).length === 0) await rmdir(companions);
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
      schemaVersion: 2,
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
    const fingerprint = pathFingerprint(normalizedSource.rootPath);
    const containerId = `ct_${fingerprint.slice(-64, -48)}` as ContainerId;
    const map = await this.readProjectMap();
    const index = map.projects.findIndex((project) => project.manifest.id === containerId);
    if (index >= 0) {
      const current = map.projects[index];
      if (current.manifest.sourcePathFingerprint !== fingerprint) {
        throw new Error(`Container identity collision for ${source.name}`);
      }
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

    const now = this.timestamp();
    const manifest: Manifest = {
      schemaVersion: 2,
      kind: "prompt-studio-container",
      id: containerId,
      containerType: "project",
      title: `${source.name} Prompts`,
      sourceProjectName: source.name,
      sourcePathFingerprint: fingerprint,
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

  async findContainerForProject(projectId: string): Promise<VaultContainerRecord | null> {
    return (await this.listContainers()).find((container) => container.source?.projectId === projectId) ?? null;
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

  async linkWarnings(): Promise<string[]> {
    let projects: ProjectLink[];
    try {
      projects = (await this.readProjectMap()).projects;
    } catch (error) {
      return [`local/${PROJECT_MAP_NAME}: ${formatError(error)}`];
    }
    const warnings: string[] = [];
    for (const project of projects) {
      if (!project.source) {
        warnings.push(
          `${project.manifest.title}: ${project.linkError ?? "local Project link is unavailable"}; Drafts were retained`,
        );
        continue;
      }
      try {
        const info = await lstat(project.source.rootPath);
        if (!info.isDirectory()) throw new Error("linked path is not a directory");
      } catch (error) {
        warnings.push(
          `${project.source.name}: linked local Project folder is unavailable at ${project.source.rootPath} (${formatError(error)}); Drafts were retained`,
        );
      }
    }
    return warnings;
  }

  async containerIdsForProjects(projectIds: ReadonlySet<string>): Promise<Set<ContainerId>> {
    const ids = new Set<ContainerId>();
    for (const container of await this.listContainers()) {
      if (container.source && projectIds.has(container.source.projectId)) ids.add(container.manifest.id);
    }
    return ids;
  }

  async legacyWorklogRoots(containerId: ContainerId): Promise<string[]> {
    const roots = containerId === "ct_inbox" ? [path.join(this.rootPath, "worklog")] : [];
    const archived = path.join(this.legacyContainersPath, containerId, "worklog");
    if (await exists(archived)) roots.push(archived);
    return roots;
  }

  async eventRoots(): Promise<string[]> {
    const roots = [this.eventsPath];
    if (!(await exists(this.legacyContainersPath))) return roots;
    for (const entry of await readdir(this.legacyContainersPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const events = path.join(this.legacyContainersPath, entry.name, "events");
      if (await exists(events)) roots.push(events);
    }
    return roots;
  }

  async readLegacyFile(relative: string): Promise<string> {
    const filePath = this.fromRelative(relative);
    await assertSafePath(this.rootPath, filePath);
    return readFile(filePath, "utf8");
  }
}
