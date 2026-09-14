import type { PluginTheme } from "@getpaseo/plugin";
import { useQuery } from "@tanstack/react-query";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import {
  checkpointGetRpc,
  checkpointRestoreRpc,
  type DraftDetail,
} from "../../shared/contracts";
import { useI18n } from "../i18n";
import {
  Card,
  ConfirmInline,
  Description,
  ErrorBlock,
  Hint,
  MonoMeta,
  NativeButton,
  SectionTitle,
  SkeletonRows,
  StatusPill,
  font,
  uiMetrics,
} from "../ui";
import { checkpointReasonKey, errorMessage, formatWhen } from "./studio-formatters";

export function CheckpointView({
  theme,
  draftId,
  checkpointId,
  expectedVersion,
  expectedHash,
  archived,
  onClose,
  onBusyChange,
  onConflict,
  onRestored,
}: {
  theme: PluginTheme;
  draftId: string;
  checkpointId: string;
  expectedVersion: number;
  expectedHash: string;
  archived: boolean;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
  onConflict: (message: string) => void;
  onRestored: (draft: DraftDetail, restored: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const getCheckpoint = useRpc(checkpointGetRpc);
  const restoreCheckpoint = useRpc(checkpointRestoreRpc);
  const [busy, setBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["prompt-studio", "checkpoint", draftId, checkpointId],
    queryFn: () => getCheckpoint({ draftId, checkpointId }),
    staleTime: Infinity,
  });
  const checkpoint = query.data?.checkpoint;
  const alreadyCurrent = checkpoint?.contentHash === expectedHash;

  useEffect(() => {
    setRestoreError(null);
  }, [expectedHash, expectedVersion]);

  async function confirmRestore() {
    if (!checkpoint || busy || archived || alreadyCurrent) return;
    setBusy(true);
    onBusyChange(true);
    setRestoreError(null);
    let result: { draft: DraftDetail; restored: boolean } | null = null;
    try {
      result = await restoreCheckpoint({
        draftId,
        checkpointId,
        expectedVersion,
        expectedHash,
      });
    } catch (cause) {
      const message = errorMessage(cause);
      setRestoreError(message);
      if (/draft changed since|external edit|concurrent/i.test(message)) onConflict(message);
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
    if (result) onRestored(result.draft, result.restored);
  }

  return (
    <View style={{ gap: 12 }}>
      <View style={{ alignItems: "center", flexDirection: "row", gap: 10 }}>
        <NativeButton
          disabled={busy}
          label={t("checkpoint.back")}
          onPress={onClose}
          small
          theme={theme}
          variant="outline"
        />
        <View style={{ flex: 1, gap: 2 }}>
          <SectionTitle theme={theme} style={{ color: theme.colors.foreground }}>
            {t("checkpoint.title")}
          </SectionTitle>
          <MonoMeta theme={theme}>{checkpointId}</MonoMeta>
        </View>
      </View>

      {query.isPending ? <SkeletonRows rows={3} theme={theme} /> : null}
      {query.isError ? (
        <ErrorBlock
          action={(
            <NativeButton
              label={t("editor.retry")}
              onPress={() => void query.refetch()}
              small
              theme={theme}
              variant="outline"
            />
          )}
          message={errorMessage(query.error)}
          theme={theme}
        />
      ) : null}

      {checkpoint ? (
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <StatusPill label={`v${checkpoint.version}`} theme={theme} tone="accent" />
            <StatusPill label={t(checkpointReasonKey(checkpoint.reason))} theme={theme} />
            <StatusPill label={formatWhen(locale, checkpoint.at)} theme={theme} />
          </View>
          <MonoMeta theme={theme}>{checkpoint.contentHash}</MonoMeta>
          <Description theme={theme}>{t("checkpoint.readOnly")}</Description>
          <Card theme={theme} style={{ minHeight: 220 }}>
            <Text selectable style={{ color: theme.colors.foreground, fontSize: font.body, lineHeight: uiMetrics.controlLineHeight }}>
              {checkpoint.markdown || t("checkpoint.empty")}
            </Text>
          </Card>

          {restoreError ? <ErrorBlock message={restoreError} theme={theme} /> : null}
          {archived ? <Hint theme={theme}>{t("checkpoint.restore.archived")}</Hint> : null}
          {alreadyCurrent ? <Hint theme={theme}>{t("checkpoint.restore.current")}</Hint> : null}

          <ConfirmInline
            busy={busy}
            cancelLabel={t("common.cancel")}
            confirmBody={t("checkpoint.restore.confirmBody")}
            confirmLabel={t("checkpoint.restore.confirm")}
            confirmTitle={t("checkpoint.restore.confirmTitle", { version: checkpoint.version })}
            disabled={archived || alreadyCurrent}
            key={`${expectedVersion}:${expectedHash}`}
            label={busy ? t("checkpoint.restore.restoring") : t("checkpoint.restore.action")}
            onConfirm={() => void confirmRestore()}
            theme={theme}
          />
        </View>
      ) : null}
    </View>
  );
}
