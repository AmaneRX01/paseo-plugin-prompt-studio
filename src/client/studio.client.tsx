import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type PluginTheme, usePaseo, useRpc } from "@getpaseo/plugin";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import {
  catalogScanRpc,
  containerEnsureRpc,
  draftAutosaveRpc,
  draftCreateRpc,
  draftDeleteRpc,
  draftGetRpc,
  draftScopeRpc,
  draftTagsSetRpc,
  draftTransitionRpc,
  snapshotGetRpc,
  tagBatchRpc,
  tagRenameRpc,
  type CatalogScanResult,
  type DraftDetail,
  type DraftScopeTarget,
} from "../shared/contracts.shared";
import { canTransitionDraftStatus, draftStatuses, isSendableDraftStatus } from "../shared/draft-lifecycle.shared";
import {
  foldCaseInsensitive,
  normalizeTags,
  renameTagPath,
  sameTagSet,
  tagsMatchAnyPath,
  type TagTreeNode,
} from "../shared/tags.shared";
import { useI18n, type MessageKey } from "./i18n.client";
import {
  checkpointReasonKey,
  draftDisplayCode,
  errorMessage,
  formatWhen,
  scopeLabel,
} from "./studio/studio-formatters.client";
import { CheckpointView } from "./studio/checkpoint-view.client";
import {
  DraftListPane,
  type DraftBulkTagLabels,
} from "./studio/draft-list-pane.client";
import {
  selectRecentSnapshots,
  selectVisibleCheckpoints,
  toggleCheckpointStar,
  useHistoryPreferences,
} from "./studio/history-preferences.client";
import {
  isPathInsideVault,
  projectChoicesFromWorkspaces,
  type ProjectChoice,
} from "./studio/project-choices.client";
import { normalizeNullableFilterSelection } from "./studio/filter-selection.client";
import {
  createScopeChangeQueue,
  type ScopeChangeQueue,
} from "./studio/scope-change-queue.client";
import { resolveTagSetResponse } from "./studio/tag-cache.client";
import { SendPanel, SessionSummary } from "./studio/send-panel.client";
import { StudioHeader } from "./studio/studio-header.client";
import {
  TagChipInput,
  type TagControlLabels,
  type TagSuggestion,
} from "./studio/tag-controls.client";
import type {
  DraftStatus,
  NavigationBlockState,
  SaveState,
  StudioProjectContext,
  StudioViewProps,
} from "./studio/studio-types.client";
import { WorklogView } from "./studio/worklog-view.client";
import {
  Card,
  Description,
  EmptyState,
  ErrorBlock,
  Hint,
  NativeButton,
  NativeTextInput,
  SectionTitle,
  SegmentedControl,
  StatusPill,
  ToolbarMeta,
  font,
  paletteOf,
  uiMetrics,
} from "./ui.client";

export type { StudioProjectContext, StudioTab } from "./studio/studio-types.client";

const CATALOG_STALE_TIME_MS = 60_000;
const DRAFT_STALE_TIME_MS = 30_000;

type Translate = ReturnType<typeof useI18n>["t"];

function tagSuggestionsFromTree(nodes: readonly TagTreeNode[]): TagSuggestion[] {
  const suggestions: TagSuggestion[] = [];
  const visit = (items: readonly TagTreeNode[]) => {
    for (const node of items) {
      suggestions.push({ path: node.path, count: node.count });
      visit(node.children);
    }
  };
  visit(nodes);
  return suggestions;
}

function tagControlLabels(t: Translate): Partial<TagControlLabels> {
  return {
    inputPlaceholder: t("editor.tags.placeholder"),
    inputAccessibilityLabel: t("editor.tags.placeholder"),
    suggestionsAccessibilityLabel: t("editor.tags.suggestions"),
    addSuggestion: (tag) => t("editor.tags.addSuggestion", { tag }),
    removeTag: (tag) => t("editor.tags.remove", { tag }),
    directoryTitle: t("tags.directory"),
    directoryEmpty: t("filter.tags.empty"),
    clearFilters: t("filter.tags.clear"),
    expandTag: (tag) => t("tags.expand", { tag }),
    collapseTag: (tag) => t("tags.collapse", { tag }),
    selectTag: (tag) => t("filter.tags.select", { tag }),
    deselectTag: (tag) => t("filter.tags.deselect", { tag }),
    tagCount: (tag, direct, count) => t("tags.count.detail", { tag, direct, count }),
    manageTag: (tag) => t("tags.manage", { tag }),
    closeManagement: (tag) => t("tags.manage.close", { tag }),
    rename: t("tags.rename.save"),
    renameInput: (tag) => t("tags.rename", { tag }),
    saveRename: t("tags.rename.save"),
    cancel: t("tags.rename.cancel"),
    batchAdd: (tag, count) => t("tags.batch.add", { tag, count }),
    batchRemove: (tag, count) => t("tags.batch.remove", { tag, count }),
  };
}

function bulkTagLabels(t: Translate): DraftBulkTagLabels {
  return {
    start: t("drafts.bulk.start"),
    done: t("drafts.bulk.done"),
    selectAll: t("drafts.bulk.selectAll"),
    clearSelection: t("drafts.bulk.clear"),
    selected: (count) => t("drafts.bulk.selected", { count }),
    selectDraft: (title) => t("drafts.bulk.select", { title }),
    tagsPlaceholder: t("drafts.bulk.tags.placeholder"),
    add: t("drafts.bulk.add"),
    remove: t("drafts.bulk.remove"),
    applying: t("drafts.bulk.applying"),
    empty: t("drafts.bulk.empty"),
    error: (message) => t("drafts.bulk.error", { error: message }),
  };
}

function SnapshotView({
  theme,
  draftId,
  snapshotId,
  dispatch,
  onClose,
}: {
  theme: PluginTheme;
  draftId: string;
  snapshotId: string;
  dispatch?: DraftDetail["dispatches"][number];
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const getSnapshot = useRpc(snapshotGetRpc);
  const query = useQuery({
    queryKey: ["prompt-studio", "snapshot", draftId, snapshotId],
    queryFn: () => getSnapshot({ draftId, snapshotId }),
  });
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <NativeButton label={t("snapshot.back")} onPress={onClose} small theme={theme} variant="outline" />
        <View style={{ flex: 1, gap: 2 }}>
          <SectionTitle theme={theme} style={{ color: theme.colors.foreground }}>{t("snapshot.title")}</SectionTitle>
          <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{snapshotId}</Text>
        </View>
      </View>
      {query.isPending ? <ActivityIndicator color={theme.colors.accent} /> : null}
      {query.isError ? <ErrorBlock message={errorMessage(query.error)} theme={theme} /> : null}
      {query.data ? (
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <StatusPill label={`v${query.data.snapshot.version}`} theme={theme} tone="accent" />
            <StatusPill label={formatWhen(locale, query.data.snapshot.createdAt)} theme={theme} />
            <StatusPill label={scopeLabel(t, query.data.snapshot.scope)} theme={theme} />
          </View>
          <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            {query.data.snapshot.contentHash}
          </Text>
          <Description theme={theme}>{t("snapshot.immutable")}</Description>
          {dispatch ? (
            <Card theme={theme}>
              <SectionTitle theme={theme}>{t("snapshot.dispatch")}</SectionTitle>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                <StatusPill
                  label={dispatch.status.toUpperCase()}
                  theme={theme}
                  tone={dispatch.status === "accepted" ? "accent" : dispatch.status === "failed" ? "danger" : "neutral"}
                />
                <Text style={{ color: theme.colors.foreground, fontSize: font.caption }}>
                  {dispatch.target.kind === "existing_agent"
                    ? dispatch.target.agentId
                    : `${dispatch.target.config.provider}/${dispatch.target.config.model} · ${dispatch.target.workspaceId}`}
                </Text>
              </View>
              <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                {dispatch.clientMessageId}
              </Text>
              <SessionSummary dispatch={dispatch} theme={theme} />
            </Card>
          ) : null}
          <Card theme={theme} style={{ minHeight: 220 }}>
            <Text selectable style={{ color: theme.colors.foreground, fontSize: font.body, lineHeight: 21 }}>
              {query.data.snapshot.markdown || t("snapshot.empty")}
            </Text>
          </Card>
        </View>
      ) : null}
    </View>
  );
}


function DraftEditor({
  draftId,
  theme,
  compact,
  projectContext,
  preferredAgentId,
  projects,
  tagSuggestions,
  globalTagsBusy,
  onBack,
  onCatalogRefresh,
  onCatalogDraftUpdated,
  onTagsChanged,
  onNavigationStateChange,
  onDeleted,
  managedWorkspaceIds,
  initialSnapshotId,
  autoFocusBody = false,
  onSnapshotClose,
}: {
  draftId: string;
  theme: PluginTheme;
  compact: boolean;
  projectContext?: StudioProjectContext;
  preferredAgentId?: string | null;
  projects: ProjectChoice[];
  tagSuggestions: TagSuggestion[];
  globalTagsBusy: boolean;
  onBack?: () => void;
  onCatalogRefresh: () => void;
  onCatalogDraftUpdated: (draft: DraftDetail) => void;
  onTagsChanged: () => void;
  onNavigationStateChange: (draftId: string, state: NavigationBlockState | null) => void;
  onDeleted: (draftId: string) => void;
  managedWorkspaceIds: ReadonlySet<string>;
  initialSnapshotId?: string | null;
  autoFocusBody?: boolean;
  onSnapshotClose?: () => void;
}) {
  const { t, locale } = useI18n();
  const {
    checkpointLimit,
    snapshotLimit,
    starredCheckpointIds,
    starredCheckpointsCountTowardLimit,
  } = useHistoryPreferences(draftId);
  const palette = useMemo(() => paletteOf(theme), [theme]);
  const tagLabels = useMemo(() => tagControlLabels(t), [t]);
  const getDraft = useRpc(draftGetRpc);
  const autosave = useRpc(draftAutosaveRpc);
  const setDraftTags = useRpc(draftTagsSetRpc);
  const setScope = useRpc(draftScopeRpc);
  const transitionDraft = useRpc(draftTransitionRpc);
  const deleteDraft = useRpc(draftDeleteRpc);
  const queryClient = useQueryClient();
  const queryKey = ["prompt-studio", "draft", draftId] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => getDraft({ draftId }),
    staleTime: DRAFT_STALE_TIME_MS,
    refetchOnWindowFocus: "always",
    refetchInterval: false,
  });
  const [title, setTitle] = useState("Untitled");
  const [markdown, setMarkdown] = useState("");
  const [status, setStatus] = useState<DraftStatus>("draft");
  const [tags, setTags] = useState<string[]>([]);
  const [tagsBusy, setTagsBusy] = useState(false);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [version, setVersion] = useState(1);
  const [contentHash, setContentHash] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [snapshotId, setSnapshotId] = useState<string | null>(initialSnapshotId ?? null);
  const [checkpointId, setCheckpointId] = useState<string | null>(null);
  const [checkpointBusy, setCheckpointBusy] = useState(false);
  const [checkpointNotice, setCheckpointNotice] = useState<string | null>(null);
  const [scopeBusy, setScopeBusy] = useState(false);
  const [scopeWarning, setScopeWarning] = useState<string | null>(null);
  const [pendingScope, setPendingScope] = useState<{
    draftId: string;
    projectId: string | null;
  } | null>(null);
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const latestFingerprint = useRef("");
  const latestTags = useRef<string[]>([]);
  const initializedDraft = useRef<string | null>(null);
  const scopeChangeQueue = useRef<ScopeChangeQueue | null>(null);
  scopeChangeQueue.current ??= createScopeChangeQueue();

  const pendingScopeProjectId = pendingScope?.draftId === draftId
    ? pendingScope.projectId
    : undefined;
  const scopePending = pendingScopeProjectId !== undefined;

  const fingerprint = JSON.stringify([title, markdown]);
  latestFingerprint.current = fingerprint;

  useEffect(() => () => scopeChangeQueue.current?.cancel(), [draftId]);

  useEffect(() => {
    const blockState: NavigationBlockState | null = dispatchBusy
      ? "dispatching"
      : lifecycleBusy || deleteConfirming || tagsBusy || globalTagsBusy
        ? "updating"
      : checkpointBusy
        ? "updating"
      : scopePending || scopeBusy
        ? "updating"
        : saveState === "saved"
          ? null
          : saveState;
    onNavigationStateChange(draftId, blockState);
  }, [checkpointBusy, deleteConfirming, dispatchBusy, draftId, globalTagsBusy, lifecycleBusy, onNavigationStateChange, saveState, scopeBusy, scopePending, tagsBusy]);

  useEffect(() => {
    const detail = query.data?.draft;
    if (!detail) return;
    const canonicalTags = normalizeTags(detail.summary.tags);
    if (!tagsBusy && JSON.stringify(tags) !== JSON.stringify(canonicalTags)) {
      latestTags.current = canonicalTags;
      setTags(canonicalTags);
    }
    const firstLoad = initializedDraft.current !== draftId;
    const changedWhileClean = saveState === "saved"
      && (detail.summary.version !== version || detail.summary.contentHash !== contentHash);
    if (!firstLoad && !changedWhileClean) return;
    initializedDraft.current = draftId;
    setTitle(!detail.summary.title || detail.summary.title === "Untitled" ? "" : detail.summary.title);
    setMarkdown(detail.markdown);
    setStatus(detail.summary.status);
    latestTags.current = canonicalTags;
    setTags(canonicalTags);
    setVersion(detail.summary.version);
    setContentHash(detail.summary.contentHash);
    setSaveState("saved");
    setSaveError(null);
    onCatalogDraftUpdated(detail);
  }, [contentHash, draftId, onCatalogDraftUpdated, query.data?.draft, saveState, tags, tagsBusy, version]);

  useEffect(() => {
    if (saveState !== "dirty" || !contentHash) return;
    const timer = setTimeout(() => {
      const requestedFingerprint = latestFingerprint.current;
      setSaveState("saving");
      setSaveError(null);
      void autosave({
        draftId,
        title: title.trim() || "Untitled",
        markdown,
        expectedVersion: version,
        expectedHash: contentHash,
      }).then((result) => {
        const cached = queryClient.getQueryData<{ draft: DraftDetail }>(queryKey);
        const updated = cached
          ? {
              ...cached.draft,
              summary: { ...result.summary, tags: cached.draft.summary.tags },
              markdown,
              checkpoints: result.checkpoint && !cached.draft.checkpoints.some((item) => item.id === result.checkpoint?.id)
                ? [...cached.draft.checkpoints, result.checkpoint].sort((left, right) => right.at.localeCompare(left.at))
                : cached.draft.checkpoints,
              events: !result.event || cached.draft.events.some((event) => event.id === result.event?.id)
                ? cached.draft.events
                : [result.event, ...cached.draft.events],
            }
          : null;
        if (updated) {
          queryClient.setQueryData(queryKey, { draft: updated });
          onCatalogDraftUpdated(updated);
        }
        setVersion(result.summary.version);
        setContentHash(result.summary.contentHash);
        setStatus(result.summary.status);
        if (latestFingerprint.current === requestedFingerprint) {
          setSaveState("saved");
        } else {
          setSaveState("dirty");
        }
      }).catch((cause) => {
        const message = errorMessage(cause);
        setSaveError(message);
        setSaveState(/conflict|version|hash|external/i.test(message) ? "conflict" : "error");
      });
    }, 700);
    return () => clearTimeout(timer);
  }, [autosave, contentHash, draftId, fingerprint, markdown, onCatalogDraftUpdated, queryClient, saveState, title, version]);

  async function changeTags(nextValues: string[]) {
    if (tagsBusy || globalTagsBusy) return;
    const requested = normalizeTags(nextValues);
    if (sameTagSet(tags, requested)) return;
    const previous = tags;
    latestTags.current = requested;
    setTags(requested);
    setTagsBusy(true);
    setTagsError(null);
    try {
      const result = await setDraftTags({ draftId, tags: requested, expectedTags: previous });
      const cached = queryClient.getQueryData<{ draft: DraftDetail }>(queryKey);
      const cachedTags = cached?.draft.summary.tags ?? previous;
      const reloaded = await query.refetch();
      const canonical = resolveTagSetResponse({
        previous,
        requested,
        response: result.summary.tags,
        cached: cachedTags,
        canonical: reloaded.isSuccess ? reloaded.data.draft.summary.tags : null,
      });
      latestTags.current = canonical;
      setTags(canonical);
      queryClient.setQueryData<{ draft: DraftDetail }>(queryKey, (current) => current
        ? {
            draft: {
              ...current.draft,
              summary: { ...current.draft.summary, tags: canonical },
            },
          }
        : current);
      onTagsChanged();
    } catch (cause) {
      const message = errorMessage(cause);
      const reloaded = await query.refetch();
      const canonical = reloaded.data?.draft.summary.tags ?? previous;
      latestTags.current = canonical;
      setTags(canonical);
      setTagsError(message);
    } finally {
      setTagsBusy(false);
    }
  }

  function markDirty() {
    setCheckpointNotice(null);
    if (saveState !== "saving") setSaveState("dirty");
  }

  function preserveLatestTags(updated: DraftDetail): DraftDetail {
    const cached = queryClient.getQueryData<{ draft: DraftDetail }>(queryKey);
    const currentTags = normalizeTags(cached?.draft.summary.tags ?? latestTags.current);
    return {
      ...updated,
      summary: { ...updated.summary, tags: currentTags },
    };
  }

  async function commitScopeChange(target: DraftScopeTarget) {
    setScopeBusy(true);
    setScopeWarning(null);
    try {
      const result = await setScope({ draftId, target });
      const updated = preserveLatestTags(result.draft);
      queryClient.setQueryData(queryKey, { draft: updated });
      setVersion(updated.summary.version);
      setContentHash(updated.summary.contentHash);
      setScopeWarning(result.registrationWarning);
      onCatalogRefresh();
    } catch (cause) {
      setScopeWarning(errorMessage(cause));
    } finally {
      setPendingScope((current) => current?.draftId === draftId ? null : current);
      setScopeBusy(false);
    }
  }

  function changeScope(projectId: string | null) {
    if (!query.data || saveState !== "saved" || scopeBusy || tagsBusy || globalTagsBusy) return;
    const canonicalProjectId = query.data.draft.summary.scope.projectId;
    if (projectId === canonicalProjectId) {
      const selection = scopeChangeQueue.current?.select(canonicalProjectId, projectId, () => {});
      if (selection === "cancelled") setPendingScope(null);
      return;
    }
    const project = projects.find((item) => item.projectId === projectId);
    if (projectId && (!project || !project.workspaceLocatorId)) return;
    const target: DraftScopeTarget = project
      ? { kind: "project", projectId: project.projectId, workspaceId: project.workspaceLocatorId }
      : { kind: "inbox" };
    const selection = scopeChangeQueue.current?.select(
      canonicalProjectId,
      projectId,
      () => void commitScopeChange(target),
    );
    if (selection === "queued") {
      setPendingScope({ draftId, projectId });
      setScopeWarning(null);
    }
  }

  async function changeStatus(targetStatus: DraftStatus) {
    if (!query.data || saveState !== "saved" || tagsBusy || globalTagsBusy) return;
    setLifecycleBusy(true);
    setLifecycleError(null);
    try {
      const result = await transitionDraft({
        draftId,
        targetStatus,
        expectedVersion: version,
        expectedHash: contentHash,
      });
      const updated = preserveLatestTags(result.draft);
      queryClient.setQueryData(queryKey, { draft: updated });
      setStatus(updated.summary.status);
      setVersion(updated.summary.version);
      setContentHash(updated.summary.contentHash);
      setDeleteConfirming(false);
      setDeleteConfirmation("");
      setDeleteError(null);
      onCatalogRefresh();
    } catch (cause) {
      setLifecycleError(errorMessage(cause));
    } finally {
      setLifecycleBusy(false);
    }
  }

  async function permanentlyDelete() {
    if (!query.data || deleteConfirmation !== draftId || saveState !== "saved" || tagsBusy || globalTagsBusy) return;
    setLifecycleBusy(true);
    setLifecycleError(null);
    setDeleteError(null);
    let deleted = false;
    try {
      await deleteDraft({
        draftId,
        confirmationDraftId: draftId,
        expectedVersion: version,
        expectedHash: contentHash,
      });
      deleted = true;
      queryClient.removeQueries({ queryKey, exact: true });
      onDeleted(draftId);
    } catch (cause) {
      setDeleteError(errorMessage(cause));
    } finally {
      if (!deleted) setLifecycleBusy(false);
    }
  }

  function adoptDraft(updated: DraftDetail) {
    const merged = preserveLatestTags(updated);
    queryClient.setQueryData(queryKey, { draft: merged });
    setStatus(merged.summary.status);
    setVersion(merged.summary.version);
    setContentHash(merged.summary.contentHash);
    onCatalogRefresh();
  }

  function adoptRestoredDraft(updated: DraftDetail, restored: boolean) {
    const merged = preserveLatestTags(updated);
    const nextTitle = !merged.summary.title || merged.summary.title === "Untitled" ? "" : merged.summary.title;
    initializedDraft.current = draftId;
    latestFingerprint.current = JSON.stringify([nextTitle, merged.markdown]);
    queryClient.setQueryData(queryKey, { draft: merged });
    setTitle(nextTitle);
    setMarkdown(merged.markdown);
    setStatus(merged.summary.status);
    latestTags.current = merged.summary.tags;
    setTags(merged.summary.tags);
    setVersion(merged.summary.version);
    setContentHash(merged.summary.contentHash);
    setSaveState("saved");
    setSaveError(null);
    setCheckpointId(null);
    setCheckpointNotice(t(
      restored ? "checkpoint.restore.success" : "checkpoint.restore.unchanged",
      restored ? { version: merged.summary.version } : undefined,
    ));
    onCatalogDraftUpdated(merged);
    onCatalogRefresh();
  }

  async function reloadCanonical() {
    setSaveState("saving");
    setSaveError(null);
    const result = await query.refetch();
    if (!result.data) {
      setSaveError(result.error ? errorMessage(result.error) : t("editor.conflict.reloadFailed"));
      setSaveState("conflict");
      return;
    }
    const canonical = result.data.draft;
    initializedDraft.current = draftId;
    setTitle(!canonical.summary.title || canonical.summary.title === "Untitled" ? "" : canonical.summary.title);
    setMarkdown(canonical.markdown);
    setStatus(canonical.summary.status);
    latestTags.current = canonical.summary.tags;
    setTags(canonical.summary.tags);
    setVersion(canonical.summary.version);
    setContentHash(canonical.summary.contentHash);
    setSaveState("saved");
    onCatalogRefresh();
  }

  const saveStateKey: MessageKey = saveState === "saved"
    ? "editor.state.saved"
    : saveState === "saving"
      ? "editor.state.saving"
      : saveState === "dirty"
        ? "editor.state.dirty"
        : saveState === "conflict"
          ? "editor.state.conflict"
          : "editor.state.error";

  if (query.isPending) return <ActivityIndicator color={theme.colors.accent} />;
  if (query.isError) return (
    <View style={{ gap: 10 }}>
      {onBack ? (
        <NativeButton label={`‹ ${t("editor.back")}`} onPress={onBack} small theme={theme} variant="ghost" />
      ) : null}
      <ErrorBlock
        action={<NativeButton label={t("editor.retry")} onPress={() => void query.refetch()} small theme={theme} variant="outline" />}
        message={errorMessage(query.error)}
        theme={theme}
      />
    </View>
  );
  if (!query.data) return null;
  const detail = query.data.draft;
  const visibleSnapshots = selectRecentSnapshots(detail.snapshots, snapshotLimit);
  const visibleCheckpoints = selectVisibleCheckpoints(
    detail.checkpoints,
    starredCheckpointIds,
    checkpointLimit,
    starredCheckpointsCountTowardLimit,
  );
  const archived = detail.summary.status === "archived";
  const sendable = isSendableDraftStatus(detail.summary.status);
  const hasPendingDispatch = detail.dispatches.some((dispatch) => dispatch.status === "pending");
  const listedScopeProjects = projects.slice(0, 24);
  const currentScopeProject = detail.summary.scope.projectId
    ? projects.find((project) => project.projectId === detail.summary.scope.projectId) ?? {
        projectId: detail.summary.scope.projectId,
        projectDisplayName: detail.summary.scope.projectName ?? detail.summary.scope.projectId,
        workspaceLocatorId: "",
      }
    : null;
  const scopeProjects = currentScopeProject
    && !listedScopeProjects.some((project) => project.projectId === currentScopeProject.projectId)
    ? [currentScopeProject, ...listedScopeProjects.slice(0, 23)]
    : listedScopeProjects;
  const selectedScopeProjectId = pendingScopeProjectId === undefined
    ? detail.summary.scope.projectId
    : pendingScopeProjectId;
  if (snapshotId) {
    const snapshot = (
      <SnapshotView
        theme={theme}
        draftId={draftId}
        snapshotId={snapshotId}
        dispatch={detail.dispatches.find((dispatch) => dispatch.snapshotId === snapshotId)}
        onClose={() => {
          setSnapshotId(null);
          onSnapshotClose?.();
        }}
      />
    );
    return compact ? snapshot : (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
        {snapshot}
      </ScrollView>
    );
  }

  if (checkpointId) {
    const checkpoint = (
      <CheckpointView
        archived={archived}
        checkpointId={checkpointId}
        draftId={draftId}
        expectedHash={contentHash}
        expectedVersion={version}
        onBusyChange={setCheckpointBusy}
        onClose={() => setCheckpointId(null)}
        onConflict={(message) => {
          setSaveError(message);
          setSaveState("conflict");
        }}
        onRestored={adoptRestoredDraft}
        theme={theme}
      />
    );
    return compact ? checkpoint : (
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
        {checkpoint}
      </ScrollView>
    );
  }

  const editable = !archived
    && saveState !== "conflict"
    && saveState !== "error"
    && !checkpointBusy
    && !dispatchBusy
    && !scopePending
    && !scopeBusy
    && !lifecycleBusy;
  const tagsEditable = !tagsBusy
    && !globalTagsBusy
    && !checkpointBusy
    && !dispatchBusy
    && !scopePending
    && !scopeBusy
    && !lifecycleBusy;

  const editorHeader = (
    <View>
      <View
        style={{
          alignItems: "center",
          borderBottomColor: palette.border,
          borderBottomWidth: 1,
          flexDirection: "row",
          gap: 8,
          minHeight: uiMetrics.toolbarHeight,
          paddingHorizontal: compact ? 0 : 14,
          paddingVertical: 7,
        }}
      >
        {onBack ? (
          <NativeButton label={`‹ ${t("editor.back")}`} onPress={onBack} small theme={theme} variant="ghost" />
        ) : null}
        <NativeTextInput
          accessibilityLabel={t("editor.title.placeholder")}
          editable={editable}
          onChangeText={(value) => { setTitle(value); markDirty(); }}
          placeholder={t("editor.title.placeholder")}
          small
          style={{
            flex: 1,
            fontSize: compact ? 16 : 18,
            fontWeight: "400",
            lineHeight: 24,
            minWidth: 140,
          }}
          theme={theme}
          value={title}
          variant="bare"
        />
        {!compact ? (
          <ToolbarMeta selectable theme={theme}>
            {draftDisplayCode(detail.summary.id)} · v{version}
          </ToolbarMeta>
        ) : null}
        <StatusPill
          label={t(saveStateKey)}
          size="control"
          theme={theme}
          tone={saveState === "saved" ? "accent" : saveState === "conflict" || saveState === "error" ? "danger" : "neutral"}
        />
      </View>
      <View
        style={{
          alignItems: "center",
          borderBottomColor: palette.border,
          borderBottomWidth: 1,
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 6,
          paddingHorizontal: compact ? 0 : 14,
          paddingVertical: 7,
        }}
      >
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{t("editor.scope")}</Text>
        <SegmentedControl
          onSelect={(id) => {
            if (id === "__inbox__") return void changeScope(null);
            return void changeScope(id);
          }}
          options={[
            {
              id: "__inbox__",
              label: t("editor.scope.inbox"),
              disabled: archived
                || saveState !== "saved"
                || checkpointBusy
                || scopeBusy
                || dispatchBusy
                || lifecycleBusy
                || tagsBusy
                || globalTagsBusy,
            },
            ...scopeProjects.map((project) => ({
              id: project.projectId,
              label: project.projectDisplayName,
              disabled: (!project.workspaceLocatorId && project.projectId !== detail.summary.scope.projectId)
                || archived
                || saveState !== "saved"
                || checkpointBusy
                 || scopeBusy
                 || dispatchBusy
                 || lifecycleBusy
                 || tagsBusy
                 || globalTagsBusy,
            })),
          ]}
          selectedId={selectedScopeProjectId ?? "__inbox__"}
          small
          theme={theme}
        />
        {scopePending ? <Hint theme={theme}>{t("editor.scope.pending")}</Hint> : null}
        {!scopePending && saveState !== "saved" ? <Hint theme={theme}>{t("editor.scope.locked")}</Hint> : null}
        {scopeWarning ? <Hint danger theme={theme}>{scopeWarning}</Hint> : null}
      </View>
    </View>
  );

  const editorBody = (
    <View style={{ gap: 14 }}>
      {(saveState === "conflict" || saveState === "error") ? (
        <Card danger theme={theme}>
          <Hint danger theme={theme}>{saveError}</Hint>
          <Hint theme={theme}>{t("editor.conflict.help")}</Hint>
          <NativeButton
            label={t("editor.conflict.reload")}
            onPress={() => void reloadCanonical()}
            small
            theme={theme}
            variant="outline"
          />
        </Card>
      ) : null}

      <View style={{ alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <SegmentedControl
          onSelect={(id) => void changeStatus(id as DraftStatus)}
          options={([
            { id: "draft", label: t("editor.status.draft") },
            { id: "ready", label: t("editor.status.ready") },
          ] as const).map((option) => ({
            ...option,
            disabled: archived
              || saveState !== "saved"
              || checkpointBusy
              || dispatchBusy
              || scopePending
              || scopeBusy
              || lifecycleBusy
              || tagsBusy
              || globalTagsBusy
              || !canTransitionDraftStatus(status, option.id, detail.summary.archivedFromStatus),
          }))}
          selectedId={status === "archived" ? null : status}
          small
          theme={theme}
        />
        <NativeButton
          label={lifecycleBusy && !deleteConfirming
            ? t("editor.status.updating")
            : archived ? t("editor.restore") : t("editor.archive")}
          onPress={() => void changeStatus(
            archived ? detail.summary.archivedFromStatus ?? "draft" : "archived",
          )}
          disabled={saveState !== "saved"
            || checkpointBusy
            || scopePending
            || scopeBusy
            || dispatchBusy
            || lifecycleBusy
            || tagsBusy
            || globalTagsBusy}
          small
          theme={theme}
          variant="outline"
        />
        {lifecycleError ? <Hint danger theme={theme}>{lifecycleError}</Hint> : null}
      </View>

      {archived ? (
        <Card danger theme={theme}>
          {!deleteConfirming ? (
            <NativeButton
              label={t("editor.delete.action")}
              onPress={() => {
                setDeleteConfirming(true);
                setDeleteConfirmation("");
                setDeleteError(null);
              }}
              disabled={lifecycleBusy || hasPendingDispatch || tagsBusy || globalTagsBusy}
              small
              theme={theme}
              variant="danger"
            />
          ) : (
            <View style={{ gap: 9 }}>
              <Text style={{ color: theme.colors.statusDanger, fontSize: font.body, fontWeight: "600" }}>
                {t("editor.delete.title")}
              </Text>
              <Hint theme={theme}>{t("editor.delete.body", {
                checkpoints: detail.checkpoints.length,
                snapshots: detail.snapshots.length,
                dispatches: detail.dispatches.length,
              })}</Hint>
              <Hint theme={theme}>{t("editor.delete.confirmPrompt", { id: draftId })}</Hint>
              <NativeTextInput
                accessibilityLabel={t("editor.delete.confirmPlaceholder")}
                editable={!lifecycleBusy}
                onChangeText={setDeleteConfirmation}
                placeholder={t("editor.delete.confirmPlaceholder")}
                theme={theme}
                value={deleteConfirmation}
              />
              {deleteError ? <Hint danger theme={theme}>{deleteError}</Hint> : null}
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                <NativeButton
                  label={lifecycleBusy ? t("editor.delete.deleting") : t("editor.delete.confirm")}
                  onPress={() => void permanentlyDelete()}
                  disabled={lifecycleBusy || deleteConfirmation !== draftId || tagsBusy || globalTagsBusy}
                  small
                  theme={theme}
                  variant="danger"
                />
                <NativeButton
                  label={t("editor.delete.cancel")}
                  onPress={() => {
                    setDeleteConfirming(false);
                    setDeleteConfirmation("");
                    setDeleteError(null);
                  }}
                  disabled={lifecycleBusy}
                  small
                  theme={theme}
                  variant="ghost"
                />
              </View>
            </View>
          )}
          {hasPendingDispatch ? <Hint danger theme={theme}>{t("editor.delete.pending")}</Hint> : null}
        </Card>
      ) : null}

      <View style={{ gap: 4 }}>
        <TagChipInput
          compact={compact}
          editable={tagsEditable}
          error={tagsError ? t("editor.tags.error", { error: tagsError }) : null}
          labels={tagLabels}
          onChange={(nextTags) => void changeTags(nextTags)}
          suggestions={tagSuggestions}
          theme={theme}
          value={tags}
        />
        {tagsBusy || globalTagsBusy ? <Hint theme={theme}>{t("editor.tags.saving")}</Hint> : null}
      </View>
      <NativeTextInput
        accessibilityLabel={t("editor.markdown.placeholder")}
        autoFocus={autoFocusBody}
        editable={editable}
        multiline
        onChangeText={(value) => { setMarkdown(value); markDirty(); }}
        placeholder={t("editor.markdown.placeholder")}
        style={{
          fontSize: 15,
          lineHeight: 24,
          minHeight: compact ? 260 : 420,
          paddingHorizontal: 2,
        }}
        theme={theme}
        value={markdown}
        variant="bare"
      />

      {detail.warnings.map((warning) => (
        <Hint danger key={warning} theme={theme}>{t("editor.warning", { warning })}</Hint>
      ))}
      {checkpointNotice ? <Hint theme={theme}>{checkpointNotice}</Hint> : null}

      <View style={{ borderTopColor: palette.border, borderTopWidth: 1, gap: 6, paddingTop: 10 }}>
        <SectionTitle theme={theme}>{t("editor.snapshots")}</SectionTitle>
        <Description theme={theme}>{t("editor.snapshots.subtitle")}</Description>
        <SectionTitle theme={theme}>{t("editor.snapshots.sent")}</SectionTitle>
        {visibleSnapshots.map((snapshot) => {
          const disabled = saveState !== "saved"
            || checkpointBusy
            || dispatchBusy
            || scopePending
            || scopeBusy
            || lifecycleBusy
            || tagsBusy
            || globalTagsBusy;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled }}
              disabled={disabled}
              key={snapshot.id}
              onPress={() => {
                setCheckpointNotice(null);
                setSnapshotId(snapshot.id);
              }}
              style={({ pressed }) => ({
                alignItems: "center",
                backgroundColor: pressed ? palette.control : "transparent",
                borderTopColor: palette.border,
                borderTopWidth: 1,
                flexDirection: "row",
                gap: 8,
                opacity: disabled ? 0.5 : 1,
                paddingVertical: 7,
              })}
            >
              <Text style={{ color: theme.colors.accent, fontSize: 11 }}>
                {t("editor.sentVersion", { version: snapshot.version })}
              </Text>
              <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, flex: 1, fontSize: font.caption }}>
                {snapshot.id}
              </Text>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                {formatWhen(locale, snapshot.createdAt)}
              </Text>
            </Pressable>
          );
        })}
        {!detail.snapshots.length ? <Hint theme={theme}>{t("editor.snapshots.empty")}</Hint> : null}
        <SectionTitle theme={theme}>{t("editor.checkpoints.recovery")}</SectionTitle>
        {detail.checkpoints.length ? (
          <>
            <Hint theme={theme}>
              {t("editor.checkpoints", {
                count: detail.checkpoints.length,
                time: formatWhen(locale, detail.checkpoints[0].at),
              })}
            </Hint>
            {visibleCheckpoints.map((checkpoint) => {
              const disabled = saveState !== "saved"
                || checkpointBusy
                || dispatchBusy
                || scopePending
                || scopeBusy
                || lifecycleBusy
                || tagsBusy
                || globalTagsBusy;
              const starred = starredCheckpointIds.has(checkpoint.id);
              return (
                <View
                  key={checkpoint.id}
                  style={{
                    alignItems: "center",
                    borderTopColor: palette.border,
                    borderTopWidth: 1,
                    flexDirection: "row",
                    gap: 8,
                  }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ disabled }}
                    disabled={disabled}
                    onPress={() => {
                      setCheckpointNotice(null);
                      setCheckpointId(checkpoint.id);
                    }}
                    style={({ pressed }) => ({
                      alignItems: "center",
                      backgroundColor: pressed ? palette.control : "transparent",
                      flex: 1,
                      flexDirection: "row",
                      flexWrap: "wrap",
                      gap: 8,
                      minWidth: 0,
                      opacity: disabled ? 0.5 : 1,
                      paddingVertical: 7,
                    })}
                  >
                    <Text style={{ color: theme.colors.accent, fontSize: 11 }}>
                      {t("editor.checkpointVersion", { version: checkpoint.version })}
                    </Text>
                    <StatusPill label={t(checkpointReasonKey(checkpoint.reason))} theme={theme} />
                    <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, flex: 1, fontSize: font.caption }}>
                      {checkpoint.id}
                    </Text>
                    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                      {formatWhen(locale, checkpoint.at)}
                    </Text>
                  </Pressable>
                  <NativeButton
                    accessibilityLabel={t(starred ? "editor.checkpoint.unstar" : "editor.checkpoint.star", {
                      version: checkpoint.version,
                    })}
                    label={starred ? "★" : "☆"}
                    onPress={() => toggleCheckpointStar(draftId, checkpoint.id)}
                    small
                    style={{ minWidth: uiMetrics.compactControlHeight, paddingHorizontal: 0 }}
                    theme={theme}
                    variant={starred ? "outline" : "ghost"}
                  />
                </View>
              );
            })}
          </>
        ) : <Hint theme={theme}>{t("editor.checkpoints.empty")}</Hint>}
      </View>
    </View>
  );

  const sendPanel = (
    <SendPanel
      theme={theme}
      detail={detail}
      preferredAgentId={preferredAgentId}
      projectContext={projectContext}
      onUpdated={adoptDraft}
      sendDisabled={!sendable
        || saveState !== "saved"
        || checkpointBusy
        || dispatchBusy
        || scopePending
        || scopeBusy
        || lifecycleBusy
        || tagsBusy
        || globalTagsBusy}
      sendDisabledReason={archived
        ? t("editor.send.archived")
        : !sendable
          ? t("editor.send.draft")
          : undefined}
      onBusyChange={setDispatchBusy}
      managedWorkspaceIds={managedWorkspaceIds}
      onOpenSnapshot={setSnapshotId}
    />
  );

  if (compact) return (
    <View style={{ gap: 16 }}>
      {editorHeader}
      {editorBody}
      {sendPanel}
    </View>
  );

  return (
    <View style={{ flex: 1, flexDirection: "row", minHeight: 0 }}>
      <View style={{ backgroundColor: theme.colors.surface0, flex: 1, minHeight: 0, minWidth: 360 }}>
        {editorHeader}
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
          {editorBody}
        </ScrollView>
      </View>
      <View
        style={{
          backgroundColor: palette.raised,
          borderLeftColor: palette.border,
          borderLeftWidth: 1,
          minHeight: 0,
          width: 340,
        }}
      >
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14 }}>
          {sendPanel}
        </ScrollView>
      </View>
    </View>
  );
}

export function StudioView({
  theme,
  compact,
  hostLabel,
  view,
  projectContext,
  preferredAgentId,
  scratchpad = false,
}: StudioViewProps) {
  const { t } = useI18n();
  const palette = useMemo(() => paletteOf(theme), [theme]);
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const scanCatalog = useRpc(catalogScanRpc);
  const createDraft = useRpc(draftCreateRpc);
  const renameCatalogTag = useRpc(tagRenameRpc);
  const batchCatalogTags = useRpc(tagBatchRpc);
  const [queryText, setQueryText] = useState("");
  const [search, setSearch] = useState("");
  const [statuses, setStatuses] = useState<DraftStatus[]>([...draftStatuses]);
  const [projectIds, setProjectIds] = useState<string[] | null>(null);
  const [tagPaths, setTagPaths] = useState<string[]>([]);
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [autoFocusDraftId, setAutoFocusDraftId] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [registrationBusy, setRegistrationBusy] = useState<string | null>(null);
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const [catalogRefreshError, setCatalogRefreshError] = useState<string | null>(null);
  const [tagMutationBusy, setTagMutationBusy] = useState(false);
  const [navigationBlock, setNavigationBlock] = useState<{ draftId: string; state: NavigationBlockState } | null>(null);
  const [navigationWarning, setNavigationWarning] = useState<string | null>(null);
  const ensureContainer = useRpc(containerEnsureRpc);
  const navigationBlockRef = useRef<{ draftId: string; state: NavigationBlockState } | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(queryText.trim()), 250);
    return () => clearTimeout(timer);
  }, [queryText]);

  const catalogProjectIds = projectContext ? [projectContext.projectId] : projectIds;
  const catalogQueryKey = useMemo(() => [
      "prompt-studio",
      "catalog",
      search,
      statuses,
      catalogProjectIds,
      tagPaths,
    ] as const, [catalogProjectIds, search, statuses, tagPaths]);
  const catalogQuery = useQuery({
    queryKey: catalogQueryKey,
    queryFn: () => scanCatalog({
      query: search,
      statuses,
      projectIds: catalogProjectIds,
      tagPaths: tagPaths.length ? tagPaths : null,
      rebuild: false,
    }),
    staleTime: CATALOG_STALE_TIME_MS,
    refetchOnWindowFocus: false,
    refetchInterval: false,
  });
  const workspacesQuery = useQuery({
    queryKey: ["prompt-studio", "paseo-workspaces"],
    queryFn: () => paseo.workspaces.list({
      sort: [{ key: "activity_at", direction: "desc" }],
      page: { limit: 100 },
    }),
    staleTime: CATALOG_STALE_TIME_MS,
    refetchInterval: false,
  });
  const registeredWorkspaceIds = useMemo(() => new Set(
    (catalogQuery.data?.containers ?? []).flatMap((container) =>
      container.registration.status === "registered" ? [container.registration.workspaceId] : [],
    ),
  ), [catalogQuery.data?.containers]);
  const managedWorkspaceIds = useMemo(() => {
    const ids = new Set(registeredWorkspaceIds);
    const vaultRoot = catalogQuery.data?.rootPath;
    if (vaultRoot) {
      for (const workspace of workspacesQuery.data?.entries ?? []) {
        if (isPathInsideVault(vaultRoot, workspace.projectRootPath)) ids.add(workspace.id);
      }
    }
    return ids;
  }, [catalogQuery.data?.rootPath, registeredWorkspaceIds, workspacesQuery.data?.entries]);
  const workspaces = useMemo(
    () => (workspacesQuery.data?.entries ?? []).filter((workspace) => !managedWorkspaceIds.has(workspace.id)),
    [managedWorkspaceIds, workspacesQuery.data?.entries],
  );
  const projectChoices = useMemo(() => projectChoicesFromWorkspaces(workspaces), [workspaces]);
  useEffect(() => {
    if (!workspacesQuery.isSuccess || projectIds === null) return;
    const next = normalizeNullableFilterSelection(
      projectIds,
      projectChoices.map((project) => project.projectId),
    );
    if (next !== null && next.length === projectIds.length) return;
    setProjectIds(next);
  }, [projectChoices, projectIds, workspacesQuery.isSuccess]);
  const drafts = catalogQuery.data?.drafts ?? [];
  const tagTree = catalogQuery.data?.tagTree ?? [];
  const tagSuggestions = useMemo(() => tagSuggestionsFromTree(tagTree), [tagTree]);
  const tagLabels = useMemo(() => tagControlLabels(t), [t]);
  const draftBulkLabels = useMemo(() => bulkTagLabels(t), [t]);
  const pendingVaultContainer = (catalogQuery.data?.containers.find((container) => container.id === "ct_inbox")
    ?? catalogQuery.data?.containers[0]);
  const vaultRegistrationPending = pendingVaultContainer?.registration.status === "pending";

  const updateCatalogDraft = useCallback((draft: DraftDetail) => {
    queryClient.setQueryData<CatalogScanResult>(catalogQueryKey, (current) => {
      if (!current) return current;
      const tokens = foldCaseInsensitive(search.trim()).split(/\s+/).filter(Boolean);
      const haystack = foldCaseInsensitive(
        `${draft.summary.title}\n${draft.summary.tags.join(" ")}\n${draft.summary.scope.projectName ?? ""}\n${draft.markdown}`,
      );
      const matches = tokens.every((token) => haystack.includes(token))
        && statuses.includes(draft.summary.status)
        && (catalogProjectIds === null
          || (draft.summary.scope.projectId !== null && catalogProjectIds.includes(draft.summary.scope.projectId)))
        && (!tagPaths.length || tagsMatchAnyPath(draft.summary.tags, tagPaths));
      const nextDrafts = current.drafts.filter((item) => item.id !== draft.summary.id);
      if (matches) nextDrafts.push(draft.summary);
      nextDrafts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return { ...current, drafts: nextDrafts };
    });
  }, [catalogProjectIds, catalogQueryKey, queryClient, search, statuses, tagPaths]);

  const rebuildCatalog = useCallback(async () => {
    setCatalogRefreshing(true);
    setCatalogRefreshError(null);
    try {
      const rebuilt = await scanCatalog({
        query: search,
        statuses,
        projectIds: catalogProjectIds,
        tagPaths: tagPaths.length ? tagPaths : null,
        rebuild: true,
      });
      queryClient.setQueryData(catalogQueryKey, rebuilt);
    } catch (cause) {
      setCatalogRefreshError(errorMessage(cause));
    } finally {
      setCatalogRefreshing(false);
    }
  }, [catalogProjectIds, catalogQueryKey, queryClient, scanCatalog, search, statuses, tagPaths]);

  const applyTagSummariesToDraftCaches = useCallback((changedDrafts: CatalogScanResult["drafts"]) => {
    for (const summary of changedDrafts) {
      queryClient.setQueryData<{ draft: DraftDetail }>(
        ["prompt-studio", "draft", summary.id],
        (current) => current
          ? {
              draft: {
                ...current.draft,
                summary: { ...current.draft.summary, tags: summary.tags },
              },
            }
          : current,
      );
    }
  }, [queryClient]);

  function activeTagMutationBlock(): string | null {
    const state = navigationBlockRef.current?.state;
    if (state === "dispatching") return t("nav.blocked.dispatching");
    if (state === "updating") return t("nav.blocked.updating");
    return null;
  }

  async function renameTagEverywhere(fromPath: string, toPath: string): Promise<void> {
    const blocked = activeTagMutationBlock();
    if (tagMutationBusy || blocked) {
      const message = blocked ?? t("nav.blocked.updating");
      throw new Error(message);
    }
    setTagMutationBusy(true);
    try {
      const result = await renameCatalogTag({ fromPath, toPath });
      applyTagSummariesToDraftCaches(result.changedDrafts);
      setTagPaths((current) => renameTagPath(current, fromPath, toPath));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["prompt-studio", "catalog"] }),
        queryClient.invalidateQueries({ queryKey: ["prompt-studio", "draft"] }),
      ]);
    } catch (cause) {
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: ["prompt-studio", "catalog"] }),
        queryClient.invalidateQueries({ queryKey: ["prompt-studio", "draft"] }),
      ]);
      throw new Error(t("tags.rename.error", { error: errorMessage(cause) }));
    } finally {
      setTagMutationBusy(false);
    }
  }

  async function applyBatchTags(
    draftIds: readonly string[],
    values: readonly string[],
    operation: "add" | "remove",
    removeDescendants = false,
  ): Promise<void> {
    const normalized = normalizeTags(values);
    const blocked = activeTagMutationBlock();
    if (!draftIds.length || !normalized.length) {
      throw new Error(t("drafts.bulk.empty"));
    }
    if (tagMutationBusy || blocked) {
      throw new Error(blocked ?? t("nav.blocked.updating"));
    }
    setTagMutationBusy(true);
    try {
      const result = await batchCatalogTags({
        draftIds: [...draftIds],
        addTags: operation === "add" ? normalized : [],
        removeTags: operation === "remove" ? normalized : [],
        removeDescendants: operation === "remove" && removeDescendants,
      });
      applyTagSummariesToDraftCaches(result.changedDrafts);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["prompt-studio", "catalog"] }),
        queryClient.invalidateQueries({ queryKey: ["prompt-studio", "draft"] }),
      ]);
    } catch (cause) {
      await Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: ["prompt-studio", "catalog"] }),
        queryClient.invalidateQueries({ queryKey: ["prompt-studio", "draft"] }),
      ]);
      throw cause;
    } finally {
      setTagMutationBusy(false);
    }
  }

  const onNavigationStateChange = useCallback((draftId: string, state: NavigationBlockState | null) => {
    const current = navigationBlockRef.current;
    const next = state ? { draftId, state } : current?.draftId === draftId ? null : current;
    navigationBlockRef.current = next;
    setNavigationBlock(next);
    if (!state) setNavigationWarning(null);
  }, []);

  function blockedNavigation(): boolean {
    const block = navigationBlockRef.current;
    if (!block) return false;
    const guidance = block.state === "conflict" || block.state === "error"
      ? t("nav.blocked.conflict")
      : block.state === "saving" || block.state === "dirty"
        ? t("nav.blocked.saving")
        : block.state === "dispatching"
          ? t("nav.blocked.dispatching")
          : t("nav.blocked.updating");
    setNavigationWarning(guidance);
    return true;
  }

  function requestDraft(nextDraftId: string | null) {
    if (nextDraftId === selectedDraftId && selectedSnapshotId === null) return;
    if (blockedNavigation()) return;
    setAutoFocusDraftId(null);
    setSelectedSnapshotId(null);
    setSelectedDraftId(nextDraftId);
  }

  useEffect(() => {
    if (!selectedDraftId || navigationBlock) return;
    if (!drafts.some((draft) => draft.id === selectedDraftId)) setSelectedDraftId(null);
  }, [drafts, navigationBlock, selectedDraftId]);

  useEffect(() => {
    if (view === "worklog" || compact || selectedDraftId || navigationBlock || !drafts.length) return;
    setSelectedDraftId(drafts[0].id);
  }, [compact, drafts, navigationBlock, selectedDraftId, view]);

  useEffect(() => {
    if (selectedDraftId && autoFocusDraftId === selectedDraftId) setAutoFocusDraftId(null);
  }, [autoFocusDraftId, selectedDraftId]);

  async function newDraft() {
    if (blockedNavigation()) return;
    const target = projectContext
      ? {
          kind: "project" as const,
          projectId: projectContext.projectId,
          workspaceId: projectContext.workspaceLocatorId,
        }
      : { kind: "inbox" as const };
    setCreating(true);
    setCreateError(null);
    try {
      const result = await createDraft({ target, title: "Untitled", markdown: "" });
      if (!projectContext) {
        setProjectIds(null);
        setStatuses([...draftStatuses]);
        setTagPaths([]);
        setQueryText("");
        setSearch("");
      }
      if (!navigationBlockRef.current) {
        setSelectedDraftId(result.draft.summary.id);
        setSelectedSnapshotId(null);
        setAutoFocusDraftId(result.draft.summary.id);
      } else {
        setNavigationWarning(t("nav.createdWhileBusy"));
      }
      setCreateError(result.registrationWarning);
      await catalogQuery.refetch();
    } catch (cause) {
      setCreateError(errorMessage(cause));
    } finally {
      setCreating(false);
    }
  }

  async function retryRegistration(containerId: string) {
    const container = catalogQuery.data?.containers.find((item) => item.id === containerId);
    if (!container) return;
    setRegistrationBusy(containerId);
    setRegistrationError(null);
    try {
      const result = await ensureContainer({ kind: "container", containerId });
      setRegistrationError(result.registrationWarning);
      await catalogQuery.refetch();
    } catch (cause) {
      setRegistrationError(errorMessage(cause));
    } finally {
      setRegistrationBusy(null);
    }
  }

  const draftList = (
    <DraftListPane
      theme={theme}
      compact={compact}
      drafts={drafts}
      selectedDraftId={selectedDraftId}
      queryText={queryText}
      search={search}
      statuses={statuses}
      projectIds={projectIds}
      tagTree={tagTree}
      tagPaths={tagPaths.length ? tagPaths : null}
      tagSuggestions={tagSuggestions}
      tagLabels={tagLabels}
      projectContext={projectContext}
      projectChoices={projectChoices}
      scratchpad={scratchpad}
      creating={creating}
      refreshing={catalogRefreshing}
      pending={catalogQuery.isPending}
      createError={createError}
      bulkLabels={draftBulkLabels}
      bulkBusy={tagMutationBusy}
      onQueryTextChange={setQueryText}
      onStatusChange={setStatuses}
      onProjectChange={setProjectIds}
      onTagChange={(nextPaths) => setTagPaths(normalizeTags(nextPaths ?? []))}
      onTagRename={renameTagEverywhere}
      onBulkAdd={(draftIds, values) => applyBatchTags(draftIds, values, "add")}
      onBulkRemove={(draftIds, values, removeDescendants) => (
        applyBatchTags(draftIds, values, "remove", removeDescendants)
      )}
      onCreate={() => void newDraft()}
      onRefresh={() => void rebuildCatalog()}
      onSelect={requestDraft}
      style={compact ? { width: "100%" } : { borderRightColor: palette.border, borderRightWidth: 1, width: 300 }}
    />
  );

  const draftEditor = selectedDraftId ? (
    <DraftEditor
      key={`${selectedDraftId}:${selectedSnapshotId ?? "current"}`}
      draftId={selectedDraftId}
      theme={theme}
      compact={compact}
      projectContext={projectContext}
      preferredAgentId={preferredAgentId}
      projects={projectChoices}
      tagSuggestions={tagSuggestions}
      globalTagsBusy={tagMutationBusy}
      onBack={compact ? () => requestDraft(null) : undefined}
      onCatalogRefresh={() => void catalogQuery.refetch()}
      onCatalogDraftUpdated={updateCatalogDraft}
      onTagsChanged={() => {
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: ["prompt-studio", "catalog"] }),
          queryClient.invalidateQueries({ queryKey: ["prompt-studio", "draft"] }),
        ]);
      }}
      onNavigationStateChange={onNavigationStateChange}
      onDeleted={(deletedDraftId) => {
        navigationBlockRef.current = null;
        setNavigationBlock(null);
        setNavigationWarning(null);
        setSelectedDraftId((current) => current === deletedDraftId ? null : current);
        setSelectedSnapshotId(null);
        setAutoFocusDraftId(null);
        queryClient.setQueryData<CatalogScanResult>(catalogQueryKey, (current) => current
          ? {
              ...current,
              drafts: current.drafts.filter((draft) => draft.id !== deletedDraftId),
              timeline: current.timeline.filter((entry) => entry.draftId !== deletedDraftId),
            }
          : current);
        void catalogQuery.refetch();
      }}
      managedWorkspaceIds={managedWorkspaceIds}
      initialSnapshotId={selectedSnapshotId}
      autoFocusBody={autoFocusDraftId === selectedDraftId}
      onSnapshotClose={() => setSelectedSnapshotId(null)}
    />
  ) : (
    <View style={{ flex: 1, justifyContent: "center", padding: 16 }}>
      <EmptyState theme={theme} title={t("drafts.select.title")} body={t("drafts.select.body")} />
    </View>
  );

  const notices = (
    <View style={{ gap: 8 }}>
      {catalogQuery.isError ? (
        <ErrorBlock
          action={<NativeButton label={t("scan.retry")} onPress={() => void catalogQuery.refetch()} small theme={theme} variant="outline" />}
          message={errorMessage(catalogQuery.error)}
          theme={theme}
        />
      ) : null}
      {catalogRefreshError ? <Hint danger theme={theme}>{catalogRefreshError}</Hint> : null}
      {catalogQuery.data ? (
        <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
          {t("scan.plaintextRoot", { path: catalogQuery.data.rootPath })}
        </Text>
      ) : null}
      {catalogQuery.data?.warnings.map((warning) => (
        <Hint danger key={warning} theme={theme}>{t("scan.warning", { warning })}</Hint>
      ))}
      {navigationWarning ? (
        <Card danger theme={theme}>
          <Text style={{ color: theme.colors.statusDanger, fontSize: font.caption, fontWeight: "500" }}>
            {t("nav.paused")}
          </Text>
          <Hint theme={theme}>{navigationWarning}</Hint>
        </Card>
      ) : null}
      {view !== "worklog" && pendingVaultContainer && vaultRegistrationPending ? (
        <Card danger key={pendingVaultContainer.id} theme={theme}>
          <Text style={{ color: theme.colors.foreground, fontSize: font.body, fontWeight: "500" }}>
            {t("registration.pending.title", { title: pendingVaultContainer.title })}
          </Text>
          <Hint danger theme={theme}>{pendingVaultContainer.registration.error ?? t("registration.pending.body")}</Hint>
          <NativeButton
            label={registrationBusy === pendingVaultContainer.id ? t("registration.retrying") : t("registration.retry")}
            onPress={() => void retryRegistration(pendingVaultContainer.id)}
            disabled={registrationBusy !== null}
            small
            theme={theme}
            variant="outline"
          />
        </Card>
      ) : null}
      {view !== "worklog" && registrationError ? <Hint danger theme={theme}>{registrationError}</Hint> : null}
    </View>
  );

  return (
    <View style={{ backgroundColor: theme.colors.surface0, flex: 1, minHeight: 0 }}>
      <StudioHeader
        theme={theme}
        compact={compact}
        hostLabel={hostLabel}
        title={scratchpad ? "scratchpad" : view === "worklog" ? "worklog" : "prompt-studio"}
      />

      {view === "worklog" ? (
        <View style={{ flex: 1, minHeight: 0 }}>
          <View
            style={{
              alignItems: compact ? "stretch" : "center",
              borderBottomColor: palette.border,
              borderBottomWidth: 1,
              flexDirection: compact ? "column" : "row",
              gap: 8,
              padding: compact ? 12 : 14,
            }}
          >
            <NativeTextInput
              accessibilityLabel={t("search.placeholder.worklog")}
              onChangeText={setQueryText}
              placeholder={t("search.placeholder.worklog")}
              small
              style={{ flex: 1 }}
              theme={theme}
              value={queryText}
            />
            <NativeButton
              label={t("search.refresh")}
              onPress={() => void rebuildCatalog()}
              disabled={catalogRefreshing}
              small
              style={compact ? { alignSelf: "stretch" } : undefined}
              theme={theme}
              variant="outline"
            />
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 14, padding: compact ? 12 : 16 }}>
            {catalogQuery.isPending ? <ActivityIndicator color={theme.colors.accent} /> : null}
            {notices}
            {catalogQuery.data ? <WorklogView theme={theme} timeline={catalogQuery.data.timeline} /> : null}
          </ScrollView>
        </View>
      ) : compact ? (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: 14, padding: 12 }}>
          {notices}
          {selectedDraftId ? draftEditor : draftList}
        </ScrollView>
      ) : (
        <View style={{ flex: 1, minHeight: 0 }}>
          <View style={{ paddingHorizontal: 12, paddingVertical: 6 }}>
            {notices}
          </View>
          <View style={{ flex: 1, flexDirection: "row", minHeight: 0 }}>
            {draftList}
            <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>{draftEditor}</View>
          </View>
        </View>
      )}
    </View>
  );
}
