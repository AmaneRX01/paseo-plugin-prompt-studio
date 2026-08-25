import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, useState } from "react";
import { Modal, Pressable, Switch, Text, View } from "react-native";
import { useI18n, type MessageKey } from "../i18n.client";
import { Hint, NativeButton, SegmentedControl, font, paletteOf, uiMetrics } from "../ui.client";
import {
  HISTORY_LIMIT_OPTIONS,
  setCheckpointLimit,
  setSnapshotLimit,
  setStarredCheckpointsCountTowardLimit,
  useHistoryPreferences,
  type HistoryLimit,
} from "./history-preferences.client";

function StudioSettings({ theme, compact }: { theme: PluginTheme; compact: boolean }) {
  const { language, setLanguage, setShowDescriptions, showDescriptions, t } = useI18n();
  const { checkpointLimit, snapshotLimit, starredCheckpointsCountTowardLimit } = useHistoryPreferences();
  const palette = useMemo(() => paletteOf(theme), [theme]);
  const [open, setOpen] = useState(false);
  return (
    <>
      <NativeButton
        accessibilityLabel={t("settings.open")}
        label="⚙"
        onPress={() => setOpen(true)}
        small
        style={{ minWidth: uiMetrics.compactControlHeight, paddingHorizontal: 0 }}
        theme={theme}
        variant="ghost"
      />
      <Modal
        animationType="fade"
        onRequestClose={() => setOpen(false)}
        transparent
        visible={open}
      >
        <View style={{ alignItems: "flex-end", flex: 1, padding: compact ? 12 : 16, paddingTop: compact ? 56 : 64 }}>
          <Pressable
            accessibilityLabel={t("settings.close")}
            accessibilityRole="button"
            onPress={() => setOpen(false)}
            style={{ bottom: 0, left: 0, position: "absolute", right: 0, top: 0 }}
          />
          <View
            accessibilityViewIsModal
            style={{
              backgroundColor: theme.colors.surface0,
              borderColor: palette.borderStrong,
              borderRadius: uiMetrics.surfaceRadius,
              borderWidth: 1,
              elevation: 12,
              gap: 16,
              maxWidth: 360,
              padding: 16,
              shadowColor: theme.colors.foreground,
              shadowOffset: { height: 4, width: 0 },
              shadowOpacity: 0.18,
              shadowRadius: 12,
              width: compact ? "100%" : 320,
            }}
          >
            <View style={{ alignItems: "center", flexDirection: "row", gap: 12 }}>
              <Text style={{ color: theme.colors.foreground, flex: 1, fontSize: font.title, fontWeight: "500" }}>
                {t("settings.title")}
              </Text>
              <NativeButton
                accessibilityLabel={t("settings.close")}
                label="×"
                onPress={() => setOpen(false)}
                small
                style={{ minWidth: uiMetrics.compactControlHeight, paddingHorizontal: 0 }}
                theme={theme}
                variant="ghost"
              />
            </View>

            <View style={{ gap: 8 }}>
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: font.caption, fontWeight: "500" }}>
                {t("language.label")}
              </Text>
              <SegmentedControl
                onSelect={(id) => setLanguage(id === "zh" ? "zh" : "en")}
                options={[
                  { id: "en", label: t("language.en") },
                  { id: "zh", label: t("language.zh") },
                ]}
                selectedId={language}
                small
                theme={theme}
              />
            </View>

            <View style={{ alignItems: "center", flexDirection: "row", gap: 12 }}>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={{ color: theme.colors.foreground, fontSize: font.body, fontWeight: "500" }}>
                  {t("settings.descriptions.label")}
                </Text>
                <Hint theme={theme}>{t("settings.descriptions.help")}</Hint>
              </View>
              <Switch
                accessibilityLabel={t("settings.descriptions.label")}
                accessibilityRole="switch"
                onValueChange={setShowDescriptions}
                thumbColor={showDescriptions ? theme.colors.accentForeground : theme.colors.foregroundMuted}
                trackColor={{ false: palette.controlStrong, true: theme.colors.accent }}
                value={showDescriptions}
              />
            </View>

            <View style={{ gap: 10 }}>
              <Text style={{ color: theme.colors.foreground, fontSize: font.body, fontWeight: "500" }}>
                {t("settings.history.title")}
              </Text>
              <View style={{ gap: 6 }}>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: font.caption, fontWeight: "500" }}>
                  {t("settings.history.snapshots")}
                </Text>
                <SegmentedControl
                  onSelect={(id) => setSnapshotLimit(Number(id) as HistoryLimit)}
                  options={HISTORY_LIMIT_OPTIONS.map((count) => ({
                    id: String(count),
                    label: t("settings.history.items", { count }),
                  }))}
                  selectedId={String(snapshotLimit)}
                  small
                  theme={theme}
                />
              </View>
              <View style={{ gap: 6 }}>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: font.caption, fontWeight: "500" }}>
                  {t("settings.history.checkpoints")}
                </Text>
                <SegmentedControl
                  onSelect={(id) => setCheckpointLimit(Number(id) as HistoryLimit)}
                  options={HISTORY_LIMIT_OPTIONS.map((count) => ({
                    id: String(count),
                    label: t("settings.history.items", { count }),
                  }))}
                  selectedId={String(checkpointLimit)}
                  small
                  theme={theme}
                />
              </View>
              <View style={{ alignItems: "center", flexDirection: "row", gap: 12 }}>
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={{ color: theme.colors.foreground, fontSize: font.body, fontWeight: "500" }}>
                    {t("settings.history.starredCount.label")}
                  </Text>
                  <Hint theme={theme}>{t("settings.history.starredCount.help")}</Hint>
                </View>
                <Switch
                  accessibilityLabel={t("settings.history.starredCount.label")}
                  accessibilityRole="switch"
                  onValueChange={setStarredCheckpointsCountTowardLimit}
                  thumbColor={starredCheckpointsCountTowardLimit ? theme.colors.accentForeground : theme.colors.foregroundMuted}
                  trackColor={{ false: palette.controlStrong, true: theme.colors.accent }}
                  value={starredCheckpointsCountTowardLimit}
                />
              </View>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );
}

export function StudioHeader({
  theme,
  compact,
  hostLabel,
  title,
}: {
  theme: PluginTheme;
  compact: boolean;
  hostLabel: string;
  title: "prompt-studio" | "worklog" | "scratchpad";
}) {
  const { t } = useI18n();
  const palette = useMemo(() => paletteOf(theme), [theme]);
  const titleKey: MessageKey = title === "scratchpad"
    ? "app.title.scratchpad"
    : title === "worklog"
      ? "app.title.worklog"
      : "app.title";
  return (
    <View
      style={{
        backgroundColor: palette.raised,
        borderBottomColor: palette.border,
        borderBottomWidth: 1,
        minHeight: compact ? uiMetrics.compactHeaderHeight : uiMetrics.headerHeight,
        paddingHorizontal: compact ? 12 : 14,
        paddingVertical: compact ? 6 : 8,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <View style={{ alignItems: "baseline", flex: 1, flexDirection: "row", gap: 7, minWidth: 180 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: compact ? font.body : font.title, fontWeight: "500" }}>
            {t(titleKey)}
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: font.caption }}>
            · {hostLabel}
          </Text>
        </View>
        <StudioSettings compact={compact} theme={theme} />
      </View>
    </View>
  );
}
