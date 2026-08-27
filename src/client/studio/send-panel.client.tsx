import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type PluginTheme, usePaseo, useRpc } from "@getpaseo/plugin";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import {
  dispatchReconcileRpc,
  dispatchRetryRpc,
  dispatchSendRpc,
  type Dispatch,
  type DispatchTarget,
  type DraftDetail,
} from "../../shared/contracts.shared";
import { useI18n } from "../i18n.client";
import {
  Card,
  Description,
  FieldLabel,
  Hint,
  NativeButton,
  NativeTextInput,
  SectionTitle,
  SegmentedControl,
  StatusPill,
  font,
  paletteOf,
  uiMetrics,
} from "../ui.client";
import { errorMessage, formatWhen } from "./studio-formatters.client";
import { ProjectWorkspacePicker } from "./project-workspace-picker.client";
import { isSamePath, type ProjectChoice } from "./project-choices.client";
import type { StudioProjectContext } from "./studio-types.client";
import { WORKSPACE_DIRECTORY_QUERY_KEY } from "./workspace-directory.client";
import type { WorkspaceDirectoryEntry } from "./workspace-directory-state.client";
import { groupWorkspacesByProject } from "./workspace-groups.client";

const RESOURCE_STALE_TIME_MS = 30_000;
type NewAgentPlacementKind = "existing_workspace" | "new_workspace";

interface RetainedWorkspacePlacement {
  id: string;
  projectId: string;
  projectRootPath: string;
}

export function SessionSummary({ dispatch, theme }: { dispatch: Dispatch; theme: PluginTheme }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!dispatch.linkedSession) return null;
  return (
    <View style={{ gap: 6 }}>
      <NativeButton
        label={open ? t("session.close") : t("session.open")}
        onPress={() => setOpen((value) => !value)}
        small
        theme={theme}
        variant="ghost"
      />
      {open ? (
        <Card theme={theme}>
          <Text style={{ color: theme.colors.foreground, fontSize: font.body, fontWeight: "500" }}>
            {dispatch.linkedSession.agentTitle ?? t("session.defaultTitle")}
          </Text>
          <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            {dispatch.linkedSession.provider ?? t("session.providerUnknown")} · {dispatch.linkedSession.agentId}
          </Text>
          <FieldLabel theme={theme}>{t("session.exactMessage")}</FieldLabel>
          <Text selectable style={{ color: theme.colors.foreground, fontSize: font.caption, lineHeight: 18 }}>
            {dispatch.linkedSession.userMessage}
          </Text>
          <Description theme={theme}>{t("session.note")}</Description>
        </Card>
      ) : null}
    </View>
  );
}

export interface SendPanelProps {
  theme: PluginTheme;
  detail: DraftDetail;
  preferredAgentId?: string | null;
  projectContext?: StudioProjectContext;
  onUpdated: (draft: DraftDetail) => void;
  sendDisabled?: boolean;
  sendDisabledReason?: string;
  onBusyChange?: (busy: boolean) => void;
  workspaces: readonly WorkspaceDirectoryEntry[];
  projects: readonly ProjectChoice[];
  workspacesPending: boolean;
  workspacesError: unknown;
  onOpenSnapshot?: (snapshotId: string) => void;
}

export function SendPanel({
  theme,
  detail,
  preferredAgentId,
  projectContext,
  onUpdated,
  sendDisabled,
  sendDisabledReason,
  onBusyChange,
  workspaces,
  projects,
  workspacesPending,
  workspacesError,
  onOpenSnapshot,
}: SendPanelProps) {
  const { t, locale } = useI18n();
  const palette = useMemo(() => paletteOf(theme), [theme]);
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const sendDispatch = useRpc(dispatchSendRpc);
  const retryDispatch = useRpc(dispatchRetryRpc);
  const reconcileDispatch = useRpc(dispatchReconcileRpc);
  const [targetKind, setTargetKind] = useState<"existing_agent" | "new_agent">(preferredAgentId ? "existing_agent" : "new_agent");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(preferredAgentId ?? null);
  const [agentQuery, setAgentQuery] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [placementKind, setPlacementKind] = useState<NewAgentPlacementKind>("existing_workspace");
  const [retainedWorkspace, setRetainedWorkspace] = useState<RetainedWorkspacePlacement | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  const initializedDefaultTargetRef = useRef<string | null>(null);
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [modeId, setModeId] = useState<string | null>(null);
  const [thinkingId, setThinkingId] = useState<string | null>(null);
  const [agentTitle, setAgentTitle] = useState("");
  const [busyDispatchId, setBusyDispatchId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const agentsQuery = useQuery({
    queryKey: ["prompt-studio", "paseo-agents"],
    queryFn: () => paseo.agents.list({
      filter: { includeArchived: false },
      sort: [{ key: "updated_at", direction: "desc" }],
      page: { limit: 100 },
    }),
    staleTime: RESOURCE_STALE_TIME_MS,
    refetchInterval: false,
  });
  const currentProjectId = detail.summary.scope.projectId ?? projectContext?.projectId ?? null;
  const workspaceGroups = useMemo(
    () => groupWorkspacesByProject(workspaces, currentProjectId, projects),
    [currentProjectId, projects, workspaces],
  );
  const contextualWorkspace = projectContext?.projectId === currentProjectId
    ? workspaces.find((workspace) => workspace.id === projectContext.preferredWorkspaceId) ?? null
    : null;
  const currentProjectWorkspace = contextualWorkspace
    ?? workspaces.find((workspace) => workspace.projectId === currentProjectId)
    ?? null;
  const preferredWorkspaceId = currentProjectWorkspace?.id ?? null;
  const selectedWorkspace = workspaces.find(
    (workspace) => workspace.id === workspaceId && workspace.projectId === selectedProjectId,
  ) ?? null;
  const retainedSelection = retainedWorkspace?.id === workspaceId
    && retainedWorkspace.projectId === selectedProjectId
    ? retainedWorkspace
    : null;
  const selectedWorkspaceId = selectedWorkspace?.id ?? retainedSelection?.id ?? null;
  const selectedProject = projects.find((project) => project.projectId === selectedProjectId) ?? null;
  const providerDirectory = placementKind === "new_workspace"
    ? selectedProject?.projectRootPath ?? null
    : selectedWorkspace?.workspaceDirectory
      ?? selectedWorkspace?.projectRootPath
      ?? retainedSelection?.projectRootPath
      ?? null;
  const providersQuery = useQuery({
    queryKey: ["prompt-studio", "providers", providerDirectory ?? ""],
    queryFn: () => paseo.providers.waitForReady({
      cwd: providerDirectory ?? undefined,
      timeoutMs: 20_000,
    }),
    enabled: targetKind === "new_agent" && Boolean(providerDirectory),
    staleTime: RESOURCE_STALE_TIME_MS,
    refetchInterval: false,
  });
  const providerEntries = useMemo(
    () => (providersQuery.data?.entries ?? []).filter((entry) => entry.enabled && entry.status === "ready" && (entry.models?.length ?? 0) > 0),
    [providersQuery.data?.entries],
  );
  const selectedProvider = providerEntries.find((entry) => entry.provider === providerId) ?? null;
  const models = (selectedProvider?.models ?? []).filter((model) => model.isSelectable !== false);
  const selectedModel = models.find((model) => model.id === modelId) ?? null;
  const modes = selectedProvider?.modes ?? [];
  const thinkingOptions = selectedModel?.thinkingOptions ?? [];

  useEffect(() => {
    if (preferredAgentId) setSelectedAgentId(preferredAgentId);
  }, [preferredAgentId]);

  useEffect(() => {
    if (!workspaceGroups.length) return;
    const defaultTargetKey = `${detail.summary.id}:${currentProjectId ?? "inbox"}`;
    const defaultGroup = workspaceGroups.find((group) => group.projectId === currentProjectId)
      ?? workspaceGroups.find((group) => group.workspaces.length > 0)
      ?? workspaceGroups[0];
    if (initializedDefaultTargetRef.current !== defaultTargetKey) {
      const defaultWorkspace = currentProjectWorkspace?.projectId === defaultGroup.projectId
        ? currentProjectWorkspace
        : defaultGroup.workspaces[0] ?? null;
      setSelectedProjectId(defaultGroup.projectId);
      setExpandedProjectId(defaultGroup.projectId);
      setWorkspaceId(defaultWorkspace?.id ?? "");
      setPlacementKind(defaultWorkspace ? "existing_workspace" : "new_workspace");
      initializedDefaultTargetRef.current = defaultTargetKey;
      return;
    }
    const currentWorkspace = workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
    const selectedProjectExists = workspaceGroups.some((group) => group.projectId === selectedProjectId);
    if (selectedProjectExists) {
      if (currentWorkspace && currentWorkspace.projectId !== selectedProjectId) {
        const selectedGroup = workspaceGroups.find((group) => group.projectId === selectedProjectId);
        const replacement = selectedGroup?.workspaces[0] ?? null;
        setWorkspaceId(replacement?.id ?? "");
        setPlacementKind(replacement ? "existing_workspace" : "new_workspace");
      }
      if (
        expandedProjectId !== null
        && !workspaceGroups.some((group) => group.projectId === expandedProjectId)
      ) {
        setExpandedProjectId(selectedProjectId);
      }
      return;
    }
    const fallbackWorkspace = currentProjectWorkspace?.projectId === defaultGroup.projectId
      ? currentProjectWorkspace
      : defaultGroup.workspaces[0] ?? null;
    setSelectedProjectId(defaultGroup.projectId);
    setExpandedProjectId(defaultGroup.projectId);
    setWorkspaceId(fallbackWorkspace?.id ?? "");
    setPlacementKind(fallbackWorkspace ? "existing_workspace" : "new_workspace");
  }, [
    currentProjectId,
    currentProjectWorkspace,
    detail.summary.id,
    expandedProjectId,
    selectedProjectId,
    workspaces,
    workspaceGroups,
    workspaceId,
  ]);

  useEffect(() => {
    if (!providerEntries.length) return;
    const provider = providerEntries.find((entry) => entry.provider === providerId) ?? providerEntries[0];
    if (provider.provider !== providerId) setProviderId(provider.provider);
  }, [providerEntries, providerId]);

  useEffect(() => {
    if (!selectedProvider) return;
    const model = models.find((entry) => entry.id === modelId) ?? models.find((entry) => entry.isDefault) ?? models[0];
    if (model && model.id !== modelId) setModelId(model.id);
    const mode = modes.find((entry) => entry.id === modeId) ?? modes.find((entry) => entry.id === selectedProvider.defaultModeId) ?? modes[0];
    if ((mode?.id ?? null) !== modeId) setModeId(mode?.id ?? null);
  }, [modelId, modeId, models, modes, selectedProvider]);

  useEffect(() => {
    if (!selectedModel) return;
    const thinking = thinkingOptions.find((entry) => entry.id === thinkingId)
      ?? thinkingOptions.find((entry) => entry.id === selectedModel.defaultThinkingOptionId)
      ?? thinkingOptions.find((entry) => entry.isDefault)
      ?? thinkingOptions[0];
    if ((thinking?.id ?? null) !== thinkingId) setThinkingId(thinking?.id ?? null);
  }, [selectedModel, thinkingId, thinkingOptions]);

  const agents = useMemo(() => {
    const normalized = agentQuery.trim().toLocaleLowerCase();
    const preferredProjectId = currentProjectId;
    const workspaceProjects = new Map(workspaces.map((workspace) => [workspace.id, workspace.projectId]));
    const rank = (agentWorkspaceId: string | undefined) => {
      if (agentWorkspaceId && agentWorkspaceId === preferredWorkspaceId) return 2;
      if (agentWorkspaceId && preferredProjectId && workspaceProjects.get(agentWorkspaceId) === preferredProjectId) return 1;
      return 0;
    };
    return (agentsQuery.data?.entries ?? [])
      .filter(({ agent }) => !agent.archivedAt && (!normalized || `${agent.title ?? ""} ${agent.id} ${agent.provider} ${agent.model ?? ""}`.toLocaleLowerCase().includes(normalized)))
      .sort((a, b) => {
        return rank(b.agent.workspaceId) - rank(a.agent.workspaceId)
          || b.agent.updatedAt.localeCompare(a.agent.updatedAt);
      });
  }, [agentQuery, agentsQuery.data?.entries, currentProjectId, preferredWorkspaceId, workspaces]);

  async function send() {
    if (targetKind === "existing_agent" && !selectedAgentId) return;
    if (targetKind === "new_agent" && (!providerId || !modelId)) return;
    if (
      targetKind === "new_agent"
      && placementKind === "existing_workspace"
      && !selectedWorkspaceId
    ) return;
    if (
      targetKind === "new_agent"
      && placementKind === "new_workspace"
      && !selectedProject?.projectRootPath
    ) return;
    setError(null);
    setBusyDispatchId(
      targetKind === "new_agent" && placementKind === "new_workspace" ? "workspace" : "new",
    );
    onBusyChange?.(true);
    try {
      let target: DispatchTarget;
      if (targetKind === "existing_agent") {
        target = { kind: "existing_agent", agentId: selectedAgentId as string };
      } else {
        let targetWorkspaceId = selectedWorkspaceId ?? "";
        if (placementKind === "new_workspace") {
          const project = selectedProject as ProjectChoice & { projectRootPath: string };
          const workspace = await paseo.workspaces.create({
            source: {
              kind: "directory",
              path: project.projectRootPath,
              projectId: project.projectId,
            },
          });
          if (!workspace.id) throw new Error(t("send.project.workspaceCreateUnavailable"));
          if (workspace.projectId && workspace.projectId !== project.projectId) {
            throw new Error(t("send.project.workspaceCreateWrongProject"));
          }
          targetWorkspaceId = workspace.id;
          // Retain the acknowledged Workspace before any follow-up call. If
          // refresh or dispatch fails, retry targets this exact Workspace and
          // never issues another create request implicitly.
          setRetainedWorkspace({
            id: targetWorkspaceId,
            projectId: project.projectId,
            projectRootPath: project.projectRootPath,
          });
          setWorkspaceId(targetWorkspaceId);
          setPlacementKind("existing_workspace");
          void queryClient.invalidateQueries({ queryKey: WORKSPACE_DIRECTORY_QUERY_KEY });
          const current = await workspace.refresh();
          if (!current) throw new Error(t("send.project.workspaceCreateUnavailable"));
          if (current.id !== targetWorkspaceId) {
            throw new Error(t("send.project.workspaceCreateUnavailable"));
          }
          if (current.projectId !== project.projectId) {
            throw new Error(t("send.project.workspaceCreateWrongProject"));
          }
          if (!isSamePath(current.projectRootPath, project.projectRootPath)) {
            throw new Error(t("send.project.workspaceCreateWrongRoot"));
          }
          setBusyDispatchId("new");
        }
        target = {
          kind: "new_agent",
          workspaceId: targetWorkspaceId,
          config: {
            provider: providerId,
            model: modelId,
            modeId,
            thinkingOptionId: thinkingId,
            title: agentTitle.trim() || null,
          },
        };
      }
      const result = await sendDispatch({ draftId: detail.summary.id, target });
      onUpdated(result.draft);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyDispatchId(null);
      onBusyChange?.(false);
    }
  }

  function selectProject(projectId: string) {
    if (projectId === selectedProjectId) {
      setExpandedProjectId((current) => current === projectId ? null : projectId);
      return;
    }
    setSelectedProjectId(projectId);
    setExpandedProjectId(projectId);
    const workspace = workspaceGroups.find((group) => group.projectId === projectId)?.workspaces[0] ?? null;
    const retained = !workspace && retainedWorkspace?.projectId === projectId ? retainedWorkspace : null;
    setWorkspaceId(workspace?.id ?? retained?.id ?? "");
    setPlacementKind(workspace || retained ? "existing_workspace" : "new_workspace");
  }

  function selectNewWorkspace(projectId: string) {
    setSelectedProjectId(projectId);
    setExpandedProjectId(projectId);
    setWorkspaceId("");
    setPlacementKind("new_workspace");
  }

  function selectWorkspace(nextWorkspaceId: string) {
    const workspace = workspaces.find((candidate) => candidate.id === nextWorkspaceId);
    if (!workspace) return;
    setSelectedProjectId(workspace.projectId);
    setExpandedProjectId(workspace.projectId);
    setWorkspaceId(workspace.id);
    setPlacementKind("existing_workspace");
  }

  async function mutateDispatch(kind: "retry" | "reconcile", dispatch: Dispatch) {
    setError(null);
    setBusyDispatchId(dispatch.id);
    onBusyChange?.(true);
    try {
      const result = kind === "retry"
        ? await retryDispatch({ draftId: detail.summary.id, dispatchId: dispatch.id })
        : await reconcileDispatch({ draftId: detail.summary.id, dispatchId: dispatch.id });
      onUpdated(result.draft);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusyDispatchId(null);
      onBusyChange?.(false);
    }
  }

  const canSend = targetKind === "existing_agent"
    ? Boolean(selectedAgentId)
    : Boolean(
        providerDirectory
        && providerId
        && modelId
        && (modes.length === 0 || modeId)
        && (placementKind === "new_workspace" ? selectedProject : selectedWorkspaceId),
      );
  const currentWorkspaceId = preferredWorkspaceId;

  return (
    <View style={{ gap: 16 }}>
      <View style={{ borderBottomColor: palette.border, borderBottomWidth: 1, gap: 12, paddingBottom: 16 }}>
        <View style={{ gap: 3 }}>
          <SectionTitle theme={theme} style={{ color: theme.colors.foreground }}>{t("send.title")}</SectionTitle>
          <Description theme={theme}>{t("send.subtitle")}</Description>
        </View>
        <SegmentedControl
          onSelect={(id) => setTargetKind(id as "existing_agent" | "new_agent")}
          options={[
            { id: "existing_agent", label: t("send.target.existing") },
            { id: "new_agent", label: t("send.target.new") },
          ]}
          selectedId={targetKind}
          theme={theme}
        />

        {targetKind === "existing_agent" ? (
          <View style={{ gap: 8 }}>
            <NativeTextInput
              accessibilityLabel={t("send.searchAgents")}
              onChangeText={setAgentQuery}
              placeholder={t("send.searchAgents.placeholder")}
              theme={theme}
              value={agentQuery}
            />
            {agentsQuery.isPending ? <ActivityIndicator color={theme.colors.accent} /> : null}
            {agentsQuery.isError ? <Hint danger theme={theme}>{errorMessage(agentsQuery.error)}</Hint> : null}
            <View style={{ borderBottomColor: palette.border, borderBottomWidth: 1 }}>
              {agents.slice(0, 18).map(({ agent }) => {
                const selected = agent.id === selectedAgentId;
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    key={agent.id}
                    onPress={() => setSelectedAgentId(agent.id)}
                    style={({ pressed }) => ({
                      alignItems: "center",
                      backgroundColor: selected ? palette.controlStrong : pressed ? palette.control : "transparent",
                      borderTopColor: palette.border,
                      borderTopWidth: 1,
                      flexDirection: "row",
                      gap: 9,
                      paddingHorizontal: 8,
                      paddingVertical: 8,
                    })}
                  >
                    <View
                      style={{
                        backgroundColor: selected ? theme.colors.accent : palette.controlStrong,
                        borderColor: selected ? theme.colors.accent : palette.borderStrong,
                        borderRadius: uiMetrics.pillRadius,
                        borderWidth: 1,
                        height: uiMetrics.indicatorSize,
                        width: uiMetrics.indicatorSize,
                      }}
                    />
                    <View style={{ flex: 1, gap: 1 }}>
                      <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: font.body }}>
                        {agent.title || agent.id.slice(0, 12)}
                      </Text>
                      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                        {agent.provider}{agent.model ? ` · ${agent.model}` : ""}{agent.workspaceId === currentWorkspaceId ? ` · ${t("send.sameWorkspace")}` : ""}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
            {!agentsQuery.isPending && !agents.length ? <Hint theme={theme}>{t("send.noAgents")}</Hint> : null}
          </View>
        ) : (
          <View style={{ gap: 10 }}>
            <FieldLabel theme={theme}>{t("send.project.required")}</FieldLabel>
            <ProjectWorkspacePicker
              expandedProjectId={expandedProjectId}
              groups={workspaceGroups}
              onNewWorkspaceSelect={selectNewWorkspace}
              onProjectPress={selectProject}
              onWorkspaceSelect={selectWorkspace}
              selectedNewWorkspace={placementKind === "new_workspace"}
              selectedProjectId={selectedProjectId}
              selectedWorkspaceId={selectedWorkspaceId}
              theme={theme}
            />
            {workspacesPending ? <ActivityIndicator color={theme.colors.accent} /> : null}
            {workspacesError ? <Hint danger theme={theme}>{errorMessage(workspacesError)}</Hint> : null}
            {!workspacesPending
              && selectedProjectId
              && workspaceGroups.find((group) => group.projectId === selectedProjectId)?.workspaces.length === 0
              ? <Hint theme={theme}>{t("send.project.noWorkspaces")}</Hint>
              : null}
            {!workspacesPending && selectedProjectId && !selectedProject?.projectRootPath
              ? <Hint danger theme={theme}>{t("send.project.rootUnavailable")}</Hint>
              : null}
            {retainedSelection && !selectedWorkspace
              ? <Hint theme={theme}>{t("send.project.workspaceRetained")}</Hint>
              : null}

            <FieldLabel theme={theme}>{t("send.provider.required")}</FieldLabel>
            {providersQuery.isPending ? <ActivityIndicator color={theme.colors.accent} /> : null}
            {providersQuery.isError ? <Hint danger theme={theme}>{errorMessage(providersQuery.error)}</Hint> : null}
            <SegmentedControl
              onSelect={setProviderId}
              options={providerEntries.map((provider) => ({
                id: provider.provider,
                label: provider.label ?? provider.provider,
              }))}
              selectedId={providerId || null}
              small
              theme={theme}
            />

            <FieldLabel theme={theme}>{t("send.model.required")}</FieldLabel>
            <SegmentedControl
              onSelect={setModelId}
              options={models.map((model) => ({ id: model.id, label: model.label || model.id }))}
              selectedId={modelId || null}
              small
              theme={theme}
            />

            <FieldLabel theme={theme}>
              {modes.length ? t("send.mode.required") : t("send.mode.providerDefault")}
            </FieldLabel>
            <SegmentedControl
              onSelect={setModeId}
              options={modes.map((mode) => ({ id: mode.id, label: mode.label || mode.id }))}
              selectedId={modeId}
              small
              theme={theme}
            />
            {!modes.length && selectedProvider ? <StatusPill label={t("send.providerDefault")} theme={theme} /> : null}

            <FieldLabel theme={theme}>{t("send.thinking")}</FieldLabel>
            <SegmentedControl
              onSelect={setThinkingId}
              options={thinkingOptions.map((option) => ({ id: option.id, label: option.label || option.id }))}
              selectedId={thinkingId}
              small
              theme={theme}
            />
            {!thinkingOptions.length && selectedModel ? <StatusPill label={t("send.modelDefault")} theme={theme} /> : null}
            <NativeTextInput
              accessibilityLabel={t("send.agentTitle.label")}
              onChangeText={setAgentTitle}
              placeholder={t("send.agentTitle.placeholder")}
              theme={theme}
              value={agentTitle}
            />
            <Description theme={theme}>{t("send.newAgentNote")}</Description>
          </View>
        )}

        {error ? <Hint danger theme={theme}>{error}</Hint> : null}
        {sendDisabled ? <Hint theme={theme}>{sendDisabledReason ?? t("send.waitForAutosave")}</Hint> : null}
        <NativeButton
          label={busyDispatchId === "workspace"
            ? t("send.creatingWorkspace")
            : busyDispatchId === "new" ? t("send.sending") : t("send.action")}
          onPress={() => void send()}
          disabled={!canSend || busyDispatchId !== null || sendDisabled}
          style={{ alignSelf: "stretch" }}
          theme={theme}
        />
      </View>

      <View>
        <SectionTitle theme={theme} style={{ marginBottom: 6 }}>{t("send.lineage")}</SectionTitle>
        {!detail.dispatches.length ? <Hint theme={theme}>{t("send.lineage.empty")}</Hint> : null}
        {[...detail.dispatches].reverse().map((dispatch) => (
          <View
            key={dispatch.id}
            style={{
              borderTopColor: dispatch.status === "failed" ? theme.colors.statusDanger : palette.border,
              borderTopWidth: 1,
              gap: 6,
              paddingVertical: 10,
            }}
          >
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
              <StatusPill
                label={dispatch.status.toUpperCase()}
                theme={theme}
                tone={dispatch.status === "accepted" ? "accent" : dispatch.status === "failed" ? "danger" : "neutral"}
              />
              <Text style={{ color: theme.colors.foreground, fontSize: font.body, fontWeight: "500" }}>
                {dispatch.target.kind === "existing_agent"
                  ? t("send.lineage.toExisting", { id: dispatch.snapshotId.slice(-8) })
                  : t("send.lineage.toNew", { id: dispatch.snapshotId.slice(-8) })}
              </Text>
            </View>
            <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{dispatch.clientMessageId}</Text>
            <Hint theme={theme}>
              {formatWhen(locale, dispatch.updatedAt)} · {t("send.attempt", { count: dispatch.attemptCount })}
            </Hint>
            {dispatch.error ? <Hint danger theme={theme}>{dispatch.error}</Hint> : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {onOpenSnapshot ? (
                <NativeButton
                  label={t("snapshot.view")}
                  onPress={() => onOpenSnapshot(dispatch.snapshotId)}
                  small
                  theme={theme}
                  variant="ghost"
                />
              ) : null}
              {dispatch.status === "failed" ? (
                <NativeButton
                  label={busyDispatchId === dispatch.id ? t("send.retrying") : t("send.retry")}
                  onPress={() => void mutateDispatch("retry", dispatch)}
                  disabled={busyDispatchId !== null || detail.summary.status === "archived"}
                  small
                  theme={theme}
                  variant="outline"
                />
              ) : null}
              {dispatch.status === "pending" ? (
                <NativeButton
                  label={busyDispatchId === dispatch.id ? t("send.reconciling") : t("send.reconcile")}
                  onPress={() => void mutateDispatch("reconcile", dispatch)}
                  disabled={busyDispatchId !== null}
                  small
                  theme={theme}
                  variant="outline"
                />
              ) : null}
            </View>
            <SessionSummary dispatch={dispatch} theme={theme} />
          </View>
        ))}
      </View>
    </View>
  );
}
