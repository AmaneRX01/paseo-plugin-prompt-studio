import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import { Text, View } from "react-native";
import type { TimelineEntry } from "../../shared/contracts";
import { useI18n } from "../i18n";
import {
  Description,
  EmptyState,
  MonoMeta,
  SectionTitle,
  StatusPill,
  font,
  paletteOf,
  shortId,
  uiMetrics,
} from "../ui";
import { dateHeading, localDayKey, timelineLabelKey } from "./studio-formatters";

export interface WorklogViewProps {
  /** Tighter row gutters for narrow layouts. */
  compact?: boolean;
  theme: PluginTheme;
  timeline: TimelineEntry[];
}

function formatTime(locale: string, value: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  } catch {
    return value;
  }
}

export function WorklogView({ compact = false, theme, timeline }: WorklogViewProps) {
  const { t, locale } = useI18n();
  const palette = useMemo(() => paletteOf(theme), [theme]);
  const grouped = useMemo(() => {
    const groups = new Map<string, TimelineEntry[]>();
    for (const item of timeline) {
      const day = localDayKey(item.at);
      groups.set(day, [...(groups.get(day) ?? []), item]);
    }
    return [...groups.entries()].sort(([a], [b]) => b.localeCompare(a));
  }, [timeline]);

  return (
    <View style={{ gap: 16 }}>
      <View style={{ gap: 4, paddingHorizontal: 4 }}>
        <SectionTitle theme={theme} style={{ color: theme.colors.foreground, fontSize: font.title }}>
          {t("worklog.title")}
        </SectionTitle>
        <Description theme={theme}>{t("worklog.subtitle")}</Description>
      </View>

      {!grouped.length ? (
        <EmptyState theme={theme} title={t("worklog.empty.title")} body={t("worklog.empty.body")} />
      ) : null}

      {grouped.map(([day, entries]) => (
        <View key={day}>
          <View style={{ alignItems: "center", flexDirection: "row", gap: 10, paddingBottom: 6, paddingHorizontal: 4, paddingTop: 10 }}>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: font.caption, fontWeight: "500" }}>
              {dateHeading(locale, day)}
            </Text>
            <View style={{ backgroundColor: palette.border, flex: 1, height: 1 }} />
          </View>
          {entries.map((entry, index) => {
            const eventColor = entry.type === "failed"
              ? theme.colors.statusDanger
              : entry.type === "sent" || entry.type === "pending" || entry.type === "draft"
                ? theme.colors.accent
                : theme.colors.foregroundMuted;
            const pillTone = entry.type === "failed" ? "danger" : entry.type === "sent" ? "accent" : "neutral";
            const lastInGroup = index === entries.length - 1;
            return (
              <View key={entry.id} style={{ flexDirection: "row", minHeight: 66, paddingHorizontal: compact ? 0 : 4 }}>
                <Text
                  style={{
                    color: theme.colors.foregroundMuted,
                    fontSize: font.caption,
                    paddingTop: 10,
                    width: 68,
                  }}
                >
                  {formatTime(locale, entry.at)}
                </Text>
                <View style={{ alignItems: "center", position: "relative", width: 18 }}>
                  <View
                    style={{
                      backgroundColor: palette.border,
                      ...(lastInGroup ? { height: 10 + uiMetrics.indicatorSize / 2 } : { bottom: 0 }),
                      position: "absolute",
                      top: 0,
                      width: 1,
                    }}
                  />
                  <View
                    style={{
                      backgroundColor: eventColor,
                      borderColor: theme.colors.surface0,
                      borderRadius: uiMetrics.pillRadius,
                      borderWidth: 2,
                      height: uiMetrics.indicatorSize,
                      marginTop: 10,
                      width: uiMetrics.indicatorSize,
                    }}
                  />
                </View>
                <View style={{ flex: 1, gap: 2, paddingBottom: 12, paddingLeft: 10, paddingTop: 6 }}>
                  <StatusPill label={t(timelineLabelKey(entry.type))} theme={theme} tone={pillTone} />
                  <Text style={{ color: theme.colors.foreground, fontSize: font.body, fontWeight: "500" }}>
                    {entry.title}
                  </Text>
                  <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: font.caption, lineHeight: uiMetrics.compactControlLineHeight }}>
                    {entry.summary}
                  </Text>
                  {entry.agentId ? (
                    <MonoMeta theme={theme}>
                      {t("worklog.agentLine", { id: shortId(entry.agentId) })}
                    </MonoMeta>
                  ) : null}
                </View>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}
