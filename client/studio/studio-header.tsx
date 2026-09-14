import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import { Text, View } from "react-native";
import { useI18n, type MessageKey } from "../i18n";
import { font, paletteOf, uiMetrics } from "../ui";

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
      </View>
    </View>
  );
}
