import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import { Text, View } from "react-native";
import type { TimelineEntry } from "../../shared/contracts.shared";
import { useI18n } from "../i18n.client";
import {
  Description,
  EmptyState,
  SectionTitle,
  font,
  paletteOf,
  uiMetrics,
} from "../ui.client";
import { dateHeading, localDayKey, timelineLabelKey } from "./studio-formatters.client";

export interface WorklogViewProps {
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

export function WorklogView({ theme, timeline }: WorklogViewProps) {
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
    <View style={{ gap: 14 }}>
      <View style={{ gap: 3, paddingHorizontal: 4 }}>
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
          {entries.map((entry) => {
            const eventColor = entry.type === "failed"
              ? theme.colors.statusDanger
              : entry.type === "sent" || entry.type === "pending" || entry.type === "draft"
                ? theme.colors.accent
                : theme.colors.foregroundMuted;
            return (
              <View key={entry.id} style={{ flexDirection: "row", minHeight: 66, paddingHorizontal: 4 }}>
                <Text
                  style={{
                    color: theme.colors.foregroundMuted,
                    fontSize: 11,
                    paddingTop: 10,
                    width: 60,
                  }}
                >
                  {formatTime(locale, entry.at)}
                </Text>
                <View style={{ alignItems: "center", position: "relative", width: 18 }}>
                  <View
                    style={{
                      backgroundColor: palette.border,
                      bottom: 0,
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
                <View style={{ flex: 1, gap: 2, paddingBottom: 12, paddingLeft: 10, paddingTop: 7 }}>
                  <Text
                    style={{
                      color: eventColor,
                      fontSize: 10,
                      fontWeight: "500",
                      letterSpacing: 0.7,
                      textTransform: "uppercase",
                    }}
                  >
                    {t(timelineLabelKey(entry.type))}
                  </Text>
                  <Text style={{ color: theme.colors.foreground, fontSize: font.body, fontWeight: "500" }}>
                    {entry.title}
                  </Text>
                  <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: font.caption, lineHeight: 17 }}>
                    {entry.summary}
                  </Text>
                  {entry.agentId ? (
                    <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                      {t("worklog.agentLine", { id: entry.agentId })}
                    </Text>
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
