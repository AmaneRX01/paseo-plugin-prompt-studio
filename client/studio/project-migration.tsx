import type { PluginTheme } from "@getpaseo/plugin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Text, View } from "react-native";
import {
  projectLinkDeleteRpc,
  projectLinkMigrateRpc,
  projectLinksListRpc,
  type ProjectLinkSummary,
} from "../../shared/project-links";
import { useI18n } from "../i18n";
import {
  Card,
  ConfirmInline,
  Description,
  EmptyState,
  ErrorBlock,
  FieldLabel,
  Hint,
  MonoMeta,
  NativeButton,
  SectionTitle,
  SegmentedControl,
  SkeletonRows,
  StatusPill,
  font,
} from "../ui";
import { isPathInsideVault, projectChoicesFromWorkspaces } from "./project-choices";
import { useWorkspaceDirectory } from "./workspace-directory";

const PROJECT_LINKS_QUERY_KEY = ["prompt-studio", "project-links"] as const;
const PROJECT_LINKS_STALE_TIME_MS = 30_000;
const INBOX_TARGET_ID = "__inbox__";

interface MigrationTarget {
  id: string;
  projectId: string | null;
  label: string;
}

function statusMessageKey(link: ProjectLinkSummary) {
  switch (link.status) {
    case "project_missing":
      return "settings.migration.status.projectMissing" as const;
    case "folder_missing":
      return "settings.migration.status.folderMissing" as const;
    default:
      return "settings.migration.status.unknown" as const;
  }
}

function DeadProjectRow({
  link,
  migratePending,
  deletePending,
  targets,
  theme,
  onMigrate,
  onDelete,
}: {
  link: ProjectLinkSummary;
  migratePending: boolean;
  deletePending: boolean;
  targets: readonly MigrationTarget[];
  theme: PluginTheme;
  onMigrate: (link: ProjectLinkSummary, target: { kind: "inbox" } | { kind: "project"; projectId: string }) => Promise<unknown>;
  onDelete: (link: ProjectLinkSummary) => void;
}) {
  const { t } = useI18n();
  const [migrating, setMigrating] = useState(false);
  const [targetId, setTargetId] = useState<string | null>(null);
  const busy = migratePending || deletePending;

  const selectedTarget = targets.find((target) => target.id === targetId) ?? null;

  return (
    <Card theme={theme} style={{ gap: 10 }}>
      <View style={{ alignItems: "center", flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
        <Text
          numberOfLines={1}
          style={{ color: theme.colors.foreground, fontSize: font.body, fontWeight: "500" }}
        >
          {link.name}
        </Text>
        <StatusPill label={t(statusMessageKey(link))} size="pill" theme={theme} tone="danger" />
      </View>
      <MonoMeta theme={theme}>{link.projectId}</MonoMeta>
      {link.rootPath ? <MonoMeta theme={theme}>{link.rootPath}</MonoMeta> : null}
      <Hint theme={theme}>{t("settings.migration.draftCount", { count: link.draftCount })}</Hint>

      {!migrating ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <NativeButton
            disabled={busy}
            label={t("settings.migration.action.migrate")}
            onPress={() => setMigrating(true)}
            small
            theme={theme}
            variant="outline"
          />
          <ConfirmInline
            busy={deletePending}
            cancelLabel={t("settings.migration.delete.cancel")}
            confirmBody={t("settings.migration.delete.confirmBody", { count: link.draftCount })}
            confirmLabel={t("settings.migration.delete.confirm")}
            confirmTitle={t("settings.migration.delete.confirmTitle")}
            disabled={busy}
            label={deletePending ? t("settings.migration.delete.pending") : t("settings.migration.action.delete")}
            onConfirm={() => onDelete(link)}
            theme={theme}
            variant="danger"
          />
        </View>
      ) : null}

      {migrating ? (
        <View style={{ gap: 10 }}>
          <FieldLabel theme={theme}>{t("settings.migration.target.label")}</FieldLabel>
          <SegmentedControl
            onSelect={setTargetId}
            options={targets.map((target) => ({ id: target.id, label: target.label }))}
            selectedId={targetId}
            small
            theme={theme}
          />
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <NativeButton
              disabled={busy || !selectedTarget}
              label={migratePending
                ? t("settings.migration.migrate.pending")
                : t("settings.migration.migrate.confirm")}
              onPress={() => {
                if (!selectedTarget) return;
                void onMigrate(link, selectedTarget.projectId
                  ? { kind: "project", projectId: selectedTarget.projectId }
                  : { kind: "inbox" }).then(
                  () => {
                    setMigrating(false);
                    setTargetId(null);
                  },
                  () => {},
                );
              }}
              small
              theme={theme}
            />
            <NativeButton
              disabled={busy}
              label={t("settings.migration.migrate.cancel")}
              onPress={() => {
                setMigrating(false);
                setTargetId(null);
              }}
              small
              theme={theme}
              variant="ghost"
            />
          </View>
          <Description theme={theme}>{t("settings.migration.migrate.help")}</Description>
        </View>
      ) : null}
    </Card>
  );
}

/**
 * Settings → Migration: list Project links whose Paseo Project or linked
 * folder is gone, and move or permanently delete their content. Broken links
 * are silent on Studio surfaces, so this page is their only surface.
 */
export function ProjectMigrationSection({
  compact,
  theme,
  vaultRootPath,
  visible,
}: {
  compact: boolean;
  theme: PluginTheme;
  vaultRootPath: string | null;
  visible: boolean;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const listLinks = useRpc(projectLinksListRpc);
  const migrateLink = useRpc(projectLinkMigrateRpc);
  const deleteLink = useRpc(projectLinkDeleteRpc);
  const directoryQuery = useWorkspaceDirectory();

  const linksQuery = useQuery({
    queryKey: PROJECT_LINKS_QUERY_KEY,
    queryFn: () => listLinks({}),
    enabled: visible,
    refetchInterval: false,
    staleTime: PROJECT_LINKS_STALE_TIME_MS,
  });

  const migrateMutation = useMutation({
    mutationFn: migrateLink,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["prompt-studio"] });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: deleteLink,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["prompt-studio"] });
    },
  });

  const targets = (() => {
    if (!directoryQuery.data) return [];
    const managedRoots = vaultRootPath ? [vaultRootPath] : [];
    const workspaces = directoryQuery.data.entries.filter((entry) => (
      !managedRoots.some((root) => isPathInsideVault(root, entry.projectRootPath))
    ));
    const emptyProjects = directoryQuery.data.emptyProjects.filter((entry) => (
      !managedRoots.some((root) => isPathInsideVault(root, entry.projectRootPath))
    ));
    const targets: MigrationTarget[] = [
      { id: INBOX_TARGET_ID, projectId: null, label: t("scope.inbox") },
    ];
    for (const choice of projectChoicesFromWorkspaces(workspaces, emptyProjects)) {
      targets.push({
        id: choice.projectId,
        projectId: choice.projectId,
        label: choice.projectDisplayName,
      });
    }
    return targets;
  })();

  const unavailable = (linksQuery.data?.links ?? []).filter((link) => link.status !== "available");
  const migrateFailures = migrateMutation.data?.failures ?? [];
  const deleteFailures = deleteMutation.data?.failures ?? [];

  return (
    <ScrollView
      contentContainerStyle={{ gap: 12, paddingBottom: 4, paddingRight: compact ? 2 : 6 }}
      keyboardShouldPersistTaps="handled"
      nestedScrollEnabled
      persistentScrollbar
      showsVerticalScrollIndicator
      style={{ flexShrink: 1, minHeight: 0 }}
    >
      <SectionTitle theme={theme} style={{ color: theme.colors.foreground }}>
        {t("settings.migration.title")}
      </SectionTitle>
      <Description theme={theme}>{t("settings.migration.help")}</Description>

      {linksQuery.isPending && visible ? (
        <SkeletonRows rows={3} theme={theme} />
      ) : null}

      {linksQuery.isError ? (
        <ErrorBlock
          action={(
            <NativeButton
              label={t("settings.migration.retry")}
              onPress={() => void linksQuery.refetch()}
              small
              theme={theme}
              variant="outline"
            />
          )}
          message={linksQuery.error.message}
          theme={theme}
        />
      ) : null}

      {linksQuery.data && linksQuery.data.verificationError ? (
        <ErrorBlock message={linksQuery.data.verificationError} theme={theme} />
      ) : null}

      {linksQuery.data && !linksQuery.data.verificationError && unavailable.length === 0 ? (
        <EmptyState body={t("settings.migration.empty.body")} theme={theme} title={t("settings.migration.empty.title")} />
      ) : null}

      {unavailable.map((link) => (
        <View key={link.projectId} style={{ gap: 8 }}>
          <DeadProjectRow
            deletePending={deleteMutation.isPending && deleteMutation.variables?.projectId === link.projectId}
            link={link}
            migratePending={migrateMutation.isPending
              && migrateMutation.variables?.sourceProjectId === link.projectId}
            targets={targets}
            theme={theme}
            onDelete={(target) => {
              migrateMutation.reset();
              deleteMutation.reset();
              deleteMutation.mutate({
                projectId: target.projectId,
                confirmationProjectId: target.projectId,
              });
            }}
            onMigrate={(target, migrateTarget) => {
              deleteMutation.reset();
              migrateMutation.reset();
              return migrateMutation.mutateAsync({
                sourceProjectId: target.projectId,
                target: migrateTarget,
              });
            }}
          />
          {migrateMutation.data && migrateMutation.variables?.sourceProjectId === link.projectId ? (
            migrateFailures.length > 0 ? (
              migrateFailures.map((failure) => (
                <Hint danger key={failure.draftId} theme={theme}>
                  {`${failure.draftId}: ${failure.message}`}
                </Hint>
              ))
            ) : (
              <Hint theme={theme}>
                {t("settings.migration.result.moved", { count: migrateMutation.data.movedDraftIds.length })}
              </Hint>
            )
          ) : null}
          {deleteMutation.data && deleteMutation.variables?.projectId === link.projectId ? (
            deleteFailures.length > 0 ? (
              deleteFailures.map((failure) => (
                <Hint danger key={failure.draftId} theme={theme}>
                  {`${failure.draftId}: ${failure.message}`}
                </Hint>
              ))
            ) : (
              <Hint theme={theme}>
                {t("settings.migration.result.deleted", { count: deleteMutation.data.deletedDraftIds.length })}
              </Hint>
            )
          ) : null}
        </View>
      ))}
    </ScrollView>
  );
}
