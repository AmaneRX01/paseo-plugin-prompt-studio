import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type PluginTheme, usePaseo, useRpc } from "@getpaseo/plugin";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, Switch, Text, View } from "react-native";
import type { DraftDetail } from "../../shared/contracts.shared";
import {
  defaultGenerationContextFilters,
  generationAbandonRpc,
  generationApplyCandidateRpc,
  generationDiscardRpc,
  generationGetRpc,
  generationPreviewRpc,
  generationSettingsGetRpc,
  generationStartRpc,
  generationSyncRpc,
  type GenerationContextCounts,
  type GenerationContextFilters,
  type GenerationJob,
  type GenerationProtection,
  type GenerationTask,
  type GenerationTimeRange,
} from "../../shared/generation.shared";
import { useI18n } from "../i18n.client";
import {
  Card,
  FieldLabel,
  Hint,
  NativeButton,
  SegmentedControl,
  StatusPill,
  font,
  paletteOf,
  uiMetrics,
} from "../ui.client";
import { errorMessage } from "./studio-formatters.client";
import {
  generationStatusMessageKey,
  isUnresolvedGenerationStatus,
} from "./generation-state.client";
import type { ProjectChoice } from "./project-choices.client";
import type { SaveState } from "./studio-types.client";
import type { TagSuggestion } from "./tag-controls.client";

const SETTINGS_QUERY_KEY = ["prompt-studio", "generation-settings"] as const;
const JOB_POLL_INTERVAL_MS = 4_000;
const AGENT_WAIT_TIMEOUT_MS = 10 * 60_000;

interface JobEnvelope {
  job: GenerationJob | null;
}

export interface PromptAgentActionsProps {
  theme: PluginTheme;
  compact: boolean;
  detail: DraftDetail;
  saveState: SaveState;
  projects: readonly ProjectChoice[];
  tagSuggestions?: readonly TagSuggestion[];
  disabled?: boolean;
  disabledReason?: string;
  onUpdated: (draft: DraftDetail) => void;
  onBusyChange?: (busy: boolean) => void;
}

function toggleValue(values: readonly string[], value: string): string[] {
  return values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value];
}

function countsView(counts: GenerationContextCounts, theme: PluginTheme) {
  return {
    eligible: counts.eligibleOtherPromptCount,
    included: counts.includedOtherPromptCount,
    eligibleVersions: counts.eligibleReferenceVersionCount,
    includedVersions: counts.includedReferenceVersionCount,
    eligibleHistory: counts.eligibleTargetHistoryVersionCount,
    includedHistory: counts.includedTargetHistoryVersionCount,
    truncated: counts.truncated,
    theme,
  };
}

function ContextCounts({
  eligible,
  included,
  eligibleVersions,
  includedVersions,
  eligibleHistory,
  includedHistory,
  truncated,
  theme,
}: ReturnType<typeof countsView>) {
  const { t } = useI18n();
  return (
    <View style={{ gap: 3 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: font.caption }}>
        {t("generation.preview.eligible", { eligible, included })}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: font.caption }}>
        {t("generation.preview.versions", { eligible: eligibleVersions, included: includedVersions })}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: font.caption }}>
        {t("generation.preview.history", { eligible: eligibleHistory, included: includedHistory })}
      </Text>
      <Hint danger={truncated} theme={theme}>
        {t(truncated ? "generation.preview.truncated" : "generation.preview.complete")}
      </Hint>
    </View>
  );
}

function ProtectionNotice({ protection, theme }: { protection: GenerationProtection; theme: PluginTheme }) {
  const { t } = useI18n();
  return (
    <View style={{ gap: 5 }}>
      <StatusPill
        label={t(protection.level === "native-policy"
          ? "generation.security.native"
          : "generation.security.behavioral")}
        theme={theme}
        tone={protection.level === "native-policy" ? "accent" : "danger"}
      />
      {protection.warning ? <Hint danger theme={theme}>{protection.warning}</Hint> : null}
      <Hint danger theme={theme}>{t("generation.security.warning")}</Hint>
    </View>
  );
}

function JobStatusCard({
  job,
  theme,
  mutationPending,
  onSync,
  onResume,
  onApply,
  onDiscard,
  onAbandon,
}: {
  job: GenerationJob;
  theme: PluginTheme;
  mutationPending: boolean;
  onSync: () => void;
  onResume: () => void;
  onApply: () => void;
  onDiscard: () => void;
  onAbandon: () => void;
}) {
  const { t } = useI18n();
  const unresolved = isUnresolvedGenerationStatus(job.status);
  const tone = job.status === "failed" || job.status === "conflict" || job.status === "needs-attention"
    ? "danger"
    : job.status === "applied"
      ? "accent"
      : "neutral";
  const canSync = ["launching", "running", "result-ready", "needs-attention"].includes(job.status);
  const canAbandon = ["prepared", "launching", "running", "needs-attention"].includes(job.status);

  return (
    <Card danger={tone === "danger"} theme={theme}>
      <View style={{ alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <StatusPill label={t(generationStatusMessageKey(job.status))} theme={theme} tone={tone} />
        <Text numberOfLines={1} selectable style={{ color: theme.colors.foregroundMuted, flex: 1, fontSize: font.caption }}>
          {job.configuration.provider} / {job.configuration.model}
        </Text>
      </View>
      <ContextCounts {...countsView(job.counts, theme)} />
      <ProtectionNotice protection={job.protection} theme={theme} />
      {job.error ? <Hint danger theme={theme}>{job.error}</Hint> : null}
      {job.archiveWarning ? <Hint danger theme={theme}>{job.archiveWarning}</Hint> : null}
      {job.status === "conflict" && job.responseMarkdown !== null ? (
        <View style={{ gap: 6 }}>
          <FieldLabel theme={theme}>{t("generation.candidate.title")}</FieldLabel>
          <ScrollView
            nestedScrollEnabled
            style={{ maxHeight: 240 }}
          >
            <Text selectable style={{ color: theme.colors.foreground, fontSize: font.caption, lineHeight: 19 }}>
              {job.responseMarkdown}
            </Text>
          </ScrollView>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <NativeButton
              disabled={mutationPending}
              label={mutationPending ? t("generation.candidate.applying") : t("generation.candidate.apply")}
              onPress={onApply}
              small
              theme={theme}
            />
            <NativeButton
              disabled={mutationPending}
              label={mutationPending ? t("generation.candidate.discarding") : t("generation.candidate.discard")}
              onPress={onDiscard}
              small
              theme={theme}
              variant="danger"
            />
          </View>
        </View>
      ) : null}
      {unresolved && job.status !== "conflict" ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {job.status === "prepared" ? (
            <NativeButton
              disabled={mutationPending}
              label={mutationPending ? t("generation.resuming") : t("generation.resume")}
              onPress={onResume}
              small
              theme={theme}
              variant="outline"
            />
          ) : null}
          {canSync ? (
            <NativeButton
              disabled={mutationPending}
              label={mutationPending ? t("generation.syncing") : t("generation.sync")}
              onPress={onSync}
              small
              theme={theme}
              variant="outline"
            />
          ) : null}
          {canAbandon ? (
            <NativeButton
              disabled={mutationPending}
              label={mutationPending ? t("generation.abandoning") : t("generation.abandon")}
              onPress={onAbandon}
              small
              theme={theme}
              variant="danger"
            />
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

export function PromptAgentActions({
  theme,
  compact,
  detail,
  saveState,
  projects,
  tagSuggestions = [],
  disabled = false,
  disabledReason,
  onUpdated,
  onBusyChange,
}: PromptAgentActionsProps) {
  const { language, t } = useI18n();
  const palette = useMemo(() => paletteOf(theme), [theme]);
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const getSettings = useRpc(generationSettingsGetRpc);
  const previewGeneration = useRpc(generationPreviewRpc);
  const startGeneration = useRpc(generationStartRpc);
  const getGeneration = useRpc(generationGetRpc);
  const syncGeneration = useRpc(generationSyncRpc);
  const applyCandidate = useRpc(generationApplyCandidateRpc);
  const discardGeneration = useRpc(generationDiscardRpc);
  const abandonGeneration = useRpc(generationAbandonRpc);

  const [modalOpen, setModalOpen] = useState(false);
  const [filters, setFilters] = useState<GenerationContextFilters>(() => ({
    ...defaultGenerationContextFilters,
    tagPaths: [...detail.summary.tags],
  }));
  const [allowProjectRead, setAllowProjectRead] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [waitEpoch, setWaitEpoch] = useState(0);
  const waitingGenerationId = useRef<string | null>(null);
  const syncingCapturedGenerationId = useRef<string | null>(null);
  const observedUnresolvedGenerationId = useRef<string | null>(null);
  const mounted = useRef(true);
  const onUpdatedRef = useRef(onUpdated);
  const jobQueryKey = useMemo(
    () => ["prompt-studio", "generation-job", detail.summary.id] as const,
    [detail.summary.id],
  );

  const settingsQuery = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => getSettings({}),
    staleTime: 30_000,
    refetchInterval: false,
  });
  const jobQuery = useQuery({
    queryKey: jobQueryKey,
    queryFn: () => getGeneration({ draftId: detail.summary.id, generationId: null }),
    refetchInterval: (query) => {
      const job = (query.state.data as JobEnvelope | undefined)?.job;
      return job && isUnresolvedGenerationStatus(job.status) ? JOB_POLL_INTERVAL_MS : false;
    },
    refetchOnWindowFocus: "always",
  });
  const job = jobQuery.data?.job ?? null;

  useEffect(() => {
    onUpdatedRef.current = onUpdated;
  }, [onUpdated]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const tagOptions = useMemo(() => {
    const paths = new Set(detail.summary.tags);
    for (const suggestion of tagSuggestions) paths.add(suggestion.path);
    return [...paths].sort((left, right) => left.localeCompare(right));
  }, [detail.summary.tags, tagSuggestions]);
  const projectOptions = useMemo(() => {
    const entries = new Map(projects.map((project) => [project.projectId, project.projectDisplayName]));
    const currentId = detail.summary.scope.projectId;
    if (currentId && !entries.has(currentId)) {
      entries.set(currentId, detail.summary.scope.projectName ?? currentId);
    }
    return [...entries].map(([id, label]) => ({ id, label }));
  }, [detail.summary.scope.projectId, detail.summary.scope.projectName, projects]);

  useEffect(() => {
    setFilters({
      ...defaultGenerationContextFilters,
      tagPaths: [...detail.summary.tags],
    });
    setAllowProjectRead(false);
    setModalOpen(false);
    setOperationError(null);
    setWaitEpoch(0);
    waitingGenerationId.current = null;
    syncingCapturedGenerationId.current = null;
  }, [detail.summary.id]);

  const commitJobResult = useCallback((result: { job: GenerationJob; draft?: DraftDetail | null }) => {
    queryClient.setQueryData<JobEnvelope>(jobQueryKey, { job: result.job });
    if (result.draft) {
      // Waiting deliberately survives navigation. Keep the canonical caches
      // current even when this Draft's editor has already unmounted; only the
      // local editor-state adoption is gated by mounted.
      queryClient.setQueryData(
        ["prompt-studio", "draft", result.job.draftId],
        { draft: result.draft },
      );
      void queryClient.invalidateQueries({ queryKey: ["prompt-studio", "catalog"] });
      if (mounted.current) onUpdatedRef.current(result.draft);
    }
  }, [jobQueryKey, queryClient]);

  const syncMutation = useMutation({
    mutationFn: (generation: GenerationJob) => syncGeneration({
      draftId: generation.draftId,
      generationId: generation.id,
    }),
    onSuccess: commitJobResult,
    onError: (cause) => setOperationError(errorMessage(cause)),
  });
  const applyMutation = useMutation({
    mutationFn: (generation: GenerationJob) => applyCandidate({
      draftId: generation.draftId,
      generationId: generation.id,
      expectedVersion: detail.summary.version,
      expectedHash: detail.summary.contentHash,
    }),
    onSuccess: commitJobResult,
    onError: (cause) => {
      setOperationError(errorMessage(cause));
      // A stale candidate apply means canonical content advanced again. Pull
      // that revision into the clean, locked editor before the user retries.
      void queryClient.invalidateQueries({
        exact: true,
        queryKey: ["prompt-studio", "draft", detail.summary.id],
      });
    },
  });
  const discardMutation = useMutation({
    mutationFn: (generation: GenerationJob) => discardGeneration({
      draftId: generation.draftId,
      generationId: generation.id,
    }),
    onSuccess: (result) => commitJobResult(result),
    onError: (cause) => setOperationError(errorMessage(cause)),
  });
  const abandonMutation = useMutation({
    mutationFn: (generation: GenerationJob) => abandonGeneration({
      draftId: generation.draftId,
      generationId: generation.id,
    }),
    onSuccess: (result) => commitJobResult(result),
    onError: (cause) => setOperationError(errorMessage(cause)),
  });
  const startMutation = useMutation({
    mutationFn: ({
      task,
      contextFilters,
      projectRead,
    }: {
      task: GenerationTask;
      contextFilters: GenerationContextFilters | null;
      projectRead: boolean;
    }) => startGeneration({
      draftId: detail.summary.id,
      generationId: null,
      expectedVersion: detail.summary.version,
      expectedHash: detail.summary.contentHash,
      task,
      locale: language,
      allowProjectRead: projectRead,
      filters: contextFilters,
    }),
    onSuccess: (result) => {
      commitJobResult(result);
      setModalOpen(false);
      setAllowProjectRead(false);
    },
    onError: (cause) => {
      setOperationError(errorMessage(cause));
      // The plugin RPC transport can time out while the server-side Agent
      // launch continues. Re-read durable job state before allowing another
      // start so the UI reconciles the frozen request instead of appearing idle.
      void queryClient.invalidateQueries({ exact: true, queryKey: jobQueryKey });
    },
  });
  const resumeMutation = useMutation({
    mutationFn: (generation: GenerationJob) => startGeneration({
      draftId: generation.draftId,
      generationId: generation.id,
      expectedVersion: generation.baseVersion,
      expectedHash: generation.baseHash,
      task: generation.task,
      locale: generation.locale,
      allowProjectRead: generation.allowProjectRead,
      filters: generation.filters,
    }),
    onSuccess: (result) => commitJobResult(result),
    onError: (cause) => {
      setOperationError(errorMessage(cause));
      void queryClient.invalidateQueries({ exact: true, queryKey: jobQueryKey });
    },
  });

  const unresolved = Boolean(job && isUnresolvedGenerationStatus(job.status));
  const mutationPending = syncMutation.isPending
    || applyMutation.isPending
    || discardMutation.isPending
    || abandonMutation.isPending
    || startMutation.isPending
    || resumeMutation.isPending;
  useEffect(() => {
    onBusyChange?.(jobQuery.isPending || jobQuery.isError || unresolved || mutationPending);
    return () => onBusyChange?.(false);
  }, [jobQuery.isError, jobQuery.isPending, mutationPending, onBusyChange, unresolved]);

  useEffect(() => {
    if (job && isUnresolvedGenerationStatus(job.status)) {
      observedUnresolvedGenerationId.current = job.id;
      return;
    }
    if (job) {
      observedUnresolvedGenerationId.current = null;
      return;
    }
    if (!jobQuery.data || !observedUnresolvedGenerationId.current) return;
    observedUnresolvedGenerationId.current = null;
    void queryClient.invalidateQueries({
      exact: true,
      queryKey: ["prompt-studio", "draft", detail.summary.id],
    });
  }, [detail.summary.id, job, jobQuery.data, queryClient]);

  const shouldWaitForAgent = Boolean(job?.agentId && job.status === "running");
  useEffect(() => {
    if (!job?.agentId || !shouldWaitForAgent) return;
    if (waitingGenerationId.current === job.id) return;
    waitingGenerationId.current = job.id;
    let retryAfterTimeout = false;
    void paseo.agents.ref(job.agentId).waitForFinish(AGENT_WAIT_TIMEOUT_MS)
      .then(async (waitResult) => {
        const result = await syncGeneration({ draftId: job.draftId, generationId: job.id });
        commitJobResult(result);
        if (mounted.current) setOperationError(null);
        if (waitResult.status === "timeout" && result.job.status === "running" && mounted.current) {
          retryAfterTimeout = true;
        }
      })
      .catch((cause) => {
        if (mounted.current) {
          setOperationError(errorMessage(cause));
          // A transient SDK/transport failure does not terminate the durable
          // Agent. Retry with a small delay instead of silently falling back to
          // a manual-only reconcile path.
          setTimeout(() => {
            if (mounted.current) setWaitEpoch((current) => current + 1);
          }, JOB_POLL_INTERVAL_MS);
        }
      })
      .finally(() => {
        if (waitingGenerationId.current === job.id) waitingGenerationId.current = null;
        if (retryAfterTimeout && mounted.current) setWaitEpoch((current) => current + 1);
      });
  }, [commitJobResult, job?.agentId, job?.draftId, job?.id, paseo.agents, shouldWaitForAgent, syncGeneration, waitEpoch]);

  useEffect(() => {
    if (!job || job.status !== "result-ready" || syncMutation.isPending) return;
    if (syncingCapturedGenerationId.current === job.id) return;
    syncingCapturedGenerationId.current = job.id;
    syncMutation.mutate(job);
  }, [job?.id, job?.status, syncMutation.isPending]);

  const baseDisabledReason = disabledReason
    ?? (!detail.summary.scope.projectId
      ? t("generation.disabled.inbox")
      : detail.summary.status === "archived"
        ? t("generation.disabled.archived")
        : saveState !== "saved"
          ? t("generation.disabled.unsaved")
          : null);
  const baseDisabled = disabled
    || Boolean(baseDisabledReason)
    || unresolved
    || mutationPending
    || jobQuery.isPending
    || jobQuery.isError;
  const relatedConfigured = Boolean(settingsQuery.data?.settings.related);
  const formatConfigured = Boolean(settingsQuery.data?.settings.format);

  const previewQuery = useQuery({
    queryKey: [
      "prompt-studio",
      "generation-preview",
      detail.summary.id,
      detail.summary.version,
      detail.summary.contentHash,
      filters.includeHistory,
      filters.timeRange,
      filters.tagPaths.join("\u001f"),
      filters.crossProject,
      filters.projectIds.join("\u001f"),
      filters.includeInbox,
      allowProjectRead,
      language,
      settingsQuery.data?.settings.version ?? 0,
    ],
    queryFn: () => previewGeneration({
      draftId: detail.summary.id,
      expectedVersion: detail.summary.version,
      expectedHash: detail.summary.contentHash,
      task: "related",
      locale: language,
      filters,
      allowProjectRead,
    }),
    enabled: modalOpen && !baseDisabled && relatedConfigured,
    staleTime: 5_000,
    refetchInterval: false,
  });

  function openRelatedModal() {
    const currentProjectId = detail.summary.scope.projectId;
    setFilters({
      ...defaultGenerationContextFilters,
      tagPaths: [...detail.summary.tags],
      projectIds: currentProjectId ? [currentProjectId] : [],
    });
    setAllowProjectRead(false);
    setOperationError(null);
    setModalOpen(true);
  }

  const relatedDisabled = baseDisabled || !relatedConfigured || settingsQuery.isPending;
  const formatDisabled = baseDisabled || !formatConfigured || settingsQuery.isPending;
  const settingsMissing = !settingsQuery.isPending && (!relatedConfigured || !formatConfigured);

  return (
    <View style={{ gap: 8 }}>
      <View
        style={{
          alignItems: "center",
          backgroundColor: palette.raised,
          borderColor: palette.border,
          borderRadius: uiMetrics.surfaceRadius,
          borderWidth: 1,
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          padding: compact ? 8 : 10,
        }}
      >
        <NativeButton
          disabled={relatedDisabled}
          label={startMutation.isPending ? t("generation.starting") : t("generation.related.action")}
          onPress={openRelatedModal}
          small
          theme={theme}
        />
        <NativeButton
          accessibilityLabel={t("generation.format.action")}
          disabled={formatDisabled}
          label={t("generation.format.action")}
          onPress={() => {
            setOperationError(null);
            startMutation.mutate({ task: "format", contextFilters: null, projectRead: false });
          }}
          small
          theme={theme}
          variant="outline"
        />
        {detail.summary.contentOrigin.kind === "generated" ? (
          <StatusPill label={t("editor.generated")} theme={theme} tone="accent" />
        ) : null}
        {jobQuery.isFetching && !job ? <ActivityIndicator color={theme.colors.accent} size="small" /> : null}
      </View>

      {baseDisabledReason ? <Hint theme={theme}>{baseDisabledReason}</Hint> : null}
      {settingsMissing ? <Hint danger theme={theme}>{t("generation.disabled.settings")}</Hint> : null}
      {settingsQuery.isError ? <Hint danger theme={theme}>{errorMessage(settingsQuery.error)}</Hint> : null}
      {jobQuery.isError ? (
        <Card danger theme={theme}>
          <Hint danger theme={theme}>{errorMessage(jobQuery.error)}</Hint>
          <NativeButton
            label={t("editor.retry")}
            onPress={() => void jobQuery.refetch()}
            small
            theme={theme}
            variant="outline"
          />
        </Card>
      ) : null}
      {operationError ? <Hint danger theme={theme}>{operationError}</Hint> : null}
      {job ? (
        <JobStatusCard
          job={job}
          mutationPending={mutationPending}
          onAbandon={() => {
            setOperationError(null);
            abandonMutation.mutate(job);
          }}
          onApply={() => {
            setOperationError(null);
            applyMutation.mutate(job);
          }}
          onDiscard={() => {
            setOperationError(null);
            discardMutation.mutate(job);
          }}
          onSync={() => {
            setOperationError(null);
            syncMutation.mutate(job);
          }}
          onResume={() => {
            setOperationError(null);
            resumeMutation.mutate(job);
          }}
          theme={theme}
        />
      ) : null}

      <Modal
        animationType="fade"
        onRequestClose={() => {
          setModalOpen(false);
          setAllowProjectRead(false);
        }}
        transparent
        visible={modalOpen}
      >
        <View style={{ alignItems: "center", flex: 1, justifyContent: "center", padding: compact ? 12 : 24 }}>
          <Pressable
            accessibilityLabel={t("generation.close")}
            accessibilityRole="button"
            onPress={() => {
              setModalOpen(false);
              setAllowProjectRead(false);
            }}
            style={{ bottom: 0, left: 0, position: "absolute", right: 0, top: 0 }}
          />
          <View
            accessibilityViewIsModal
            style={{
              backgroundColor: theme.colors.surface0,
              borderColor: palette.borderStrong,
              borderRadius: uiMetrics.surfaceRadius,
              borderWidth: 1,
              maxHeight: "90%",
              maxWidth: 680,
              padding: compact ? 12 : 16,
              width: "100%",
            }}
          >
            <View style={{ alignItems: "center", flexDirection: "row", gap: 10, paddingBottom: 10 }}>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={{ color: theme.colors.foreground, fontSize: font.title, fontWeight: "500" }}>
                  {t("generation.related.title")}
                </Text>
                <Hint theme={theme}>{t("generation.related.help")}</Hint>
              </View>
              <NativeButton
                accessibilityLabel={t("generation.close")}
                label="×"
                onPress={() => {
                  setModalOpen(false);
                  setAllowProjectRead(false);
                }}
                small
                style={{ minWidth: uiMetrics.compactControlHeight, paddingHorizontal: 0 }}
                theme={theme}
                variant="ghost"
              />
            </View>
            <ScrollView
              contentContainerStyle={{ gap: 14, paddingBottom: 2 }}
              keyboardShouldPersistTaps="handled"
              style={{ minHeight: 0 }}
            >
              <View style={{ alignItems: "center", flexDirection: "row", gap: 12 }}>
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: font.body, fontWeight: "500" }}>
                    {t("generation.history.label")}
                  </Text>
                  <Hint theme={theme}>{t("generation.history.help")}</Hint>
                </View>
                <Switch
                  accessibilityLabel={t("generation.history.label")}
                  accessibilityRole="switch"
                  onValueChange={(includeHistory) => setFilters((current) => ({ ...current, includeHistory }))}
                  thumbColor={filters.includeHistory ? theme.colors.accentForeground : theme.colors.foregroundMuted}
                  trackColor={{ false: palette.controlStrong, true: theme.colors.accent }}
                  value={filters.includeHistory}
                />
              </View>

              <View style={{ gap: 6 }}>
                <FieldLabel theme={theme}>{t("generation.time.label")}</FieldLabel>
                <SegmentedControl
                  onSelect={(timeRange) => setFilters((current) => ({
                    ...current,
                    timeRange: timeRange as GenerationTimeRange,
                  }))}
                  options={([
                    ["7d", "generation.time.7"],
                    ["30d", "generation.time.30"],
                    ["90d", "generation.time.90"],
                    ["all", "generation.time.all"],
                  ] as const).map(([id, key]) => ({ id, label: t(key) }))}
                  selectedId={filters.timeRange}
                  small
                  theme={theme}
                />
              </View>

              <View style={{ gap: 6 }}>
                <FieldLabel theme={theme}>{t("generation.tags.label")}</FieldLabel>
                {tagOptions.length ? (
                  <SegmentedControl
                    onSelect={(tag) => setFilters((current) => ({
                      ...current,
                      tagPaths: toggleValue(current.tagPaths, tag),
                    }))}
                    options={tagOptions.map((tag) => ({ id: tag, label: tag }))}
                    selectedIds={filters.tagPaths}
                    small
                    theme={theme}
                  />
                ) : null}
                {!filters.tagPaths.length ? <Hint theme={theme}>{t("generation.tags.none")}</Hint> : null}
              </View>

              <View style={{ alignItems: "center", flexDirection: "row", gap: 12 }}>
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: font.body, fontWeight: "500" }}>
                    {t("generation.projects.cross")}
                  </Text>
                  <Hint theme={theme}>{t("generation.projects.same")}</Hint>
                </View>
                <Switch
                  accessibilityLabel={t("generation.projects.cross")}
                  accessibilityRole="switch"
                  onValueChange={(crossProject) => setFilters((current) => ({
                    ...current,
                    crossProject,
                    projectIds: crossProject && detail.summary.scope.projectId
                      ? [detail.summary.scope.projectId]
                      : [],
                    includeInbox: false,
                  }))}
                  thumbColor={filters.crossProject ? theme.colors.accentForeground : theme.colors.foregroundMuted}
                  trackColor={{ false: palette.controlStrong, true: theme.colors.accent }}
                  value={filters.crossProject}
                />
              </View>
              {filters.crossProject ? (
                <View style={{ gap: 6 }}>
                  <FieldLabel theme={theme}>{t("generation.projects.label")}</FieldLabel>
                  <SegmentedControl
                    onSelect={(projectId) => {
                      if (projectId === "__inbox__") {
                        setFilters((current) => ({ ...current, includeInbox: !current.includeInbox }));
                        return;
                      }
                      setFilters((current) => ({
                        ...current,
                        projectIds: toggleValue(current.projectIds, projectId),
                      }));
                    }}
                    options={[
                      ...projectOptions,
                      { id: "__inbox__", label: t("generation.projects.inbox") },
                    ]}
                    selectedIds={[
                      ...filters.projectIds,
                      ...(filters.includeInbox ? ["__inbox__"] : []),
                    ]}
                    small
                    theme={theme}
                  />
                </View>
              ) : null}

              <Card theme={theme}>
                <View style={{ alignItems: "center", flexDirection: "row", gap: 12 }}>
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text style={{ color: theme.colors.foreground, fontSize: font.body, fontWeight: "500" }}>
                      {t("generation.projectRead.label")}
                    </Text>
                    <Hint theme={theme}>{t("generation.projectRead.help")}</Hint>
                  </View>
                  <Switch
                    accessibilityLabel={t("generation.projectRead.label")}
                    accessibilityRole="switch"
                    onValueChange={setAllowProjectRead}
                    thumbColor={allowProjectRead ? theme.colors.accentForeground : theme.colors.foregroundMuted}
                    trackColor={{ false: palette.controlStrong, true: theme.colors.accent }}
                    value={allowProjectRead}
                  />
                </View>
                <Hint danger theme={theme}>{t("generation.security.warning")}</Hint>
              </Card>

              {previewQuery.isPending && previewQuery.fetchStatus === "fetching" ? (
                <View style={{ alignItems: "center", flexDirection: "row", gap: 8 }}>
                  <ActivityIndicator color={theme.colors.accent} size="small" />
                  <Hint theme={theme}>{t("generation.preview.loading")}</Hint>
                </View>
              ) : null}
              {previewQuery.isError ? <Hint danger theme={theme}>{errorMessage(previewQuery.error)}</Hint> : null}
              {previewQuery.data ? (
                <Card theme={theme}>
                  <ContextCounts {...countsView(previewQuery.data.preview.counts, theme)} />
                  <Hint theme={theme}>
                    {t("generation.provider.summary", {
                      provider: previewQuery.data.preview.configuration.provider,
                      model: previewQuery.data.preview.configuration.model,
                      thinking: previewQuery.data.preview.configuration.thinkingOptionId
                        ?? t("settings.generation.defaultThinking"),
                    })}
                  </Hint>
                  <ProtectionNotice protection={previewQuery.data.preview.protection} theme={theme} />
                </Card>
              ) : null}
              {!relatedConfigured ? <Hint danger theme={theme}>{t("generation.disabled.settings")}</Hint> : null}
              <NativeButton
                disabled={!previewQuery.data || previewQuery.isFetching || startMutation.isPending}
                label={startMutation.isPending ? t("generation.starting") : t("generation.start")}
                onPress={() => {
                  setOperationError(null);
                  startMutation.mutate({
                    task: "related",
                    contextFilters: filters,
                    projectRead: allowProjectRead,
                  });
                }}
                theme={theme}
              />
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}
