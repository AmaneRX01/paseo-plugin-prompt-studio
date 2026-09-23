import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useI18n } from "../i18n";
import { Card, NativeButton, NativeTextInput, SectionTitle, font, uiMetrics } from "../ui";
import {
  findTextMatches,
  replaceAllTextMatches,
  replaceTextMatch,
  stepMatchIndex,
  type TextRange,
} from "./editor-find";

export function EditorFindBar({
  text,
  editable,
  compact,
  theme,
  onSelect,
  onReplace,
  onClose,
}: {
  text: string;
  editable: boolean;
  compact: boolean;
  theme: PluginTheme;
  onSelect: (range: TextRange) => void;
  onReplace: (nextText: string, selection: TextRange) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [replacedCount, setReplacedCount] = useState<number | null>(null);
  const matches = useMemo(() => findTextMatches(text, query), [text, query]);
  const activeIndex = selectedIndex < matches.length ? selectedIndex : -1;

  function navigate(step: -1 | 1) {
    const index = stepMatchIndex(activeIndex, matches.length, step);
    if (index < 0) return;
    setSelectedIndex(index);
    setReplacedCount(null);
    onSelect(matches[index]);
  }

  function replaceCurrent() {
    if (!editable || !matches.length) return;
    const index = activeIndex < 0 ? 0 : activeIndex;
    const range = matches[index];
    const nextText = replaceTextMatch(text, range, replacement);
    if (nextText === text) { setReplacedCount(0); return; }
    const nextMatches = findTextMatches(nextText, query);
    const nextIndex = nextMatches.findIndex((match) => match.start >= range.start + replacement.length);
    const selected = nextMatches[nextIndex < 0 ? 0 : nextIndex]
      ?? { start: range.start + replacement.length, end: range.start + replacement.length };
    setSelectedIndex(nextMatches.length ? (nextIndex < 0 ? 0 : nextIndex) : -1);
    setReplacedCount(1);
    onReplace(nextText, selected);
  }

  function replaceAll() {
    if (!editable || !matches.length) return;
    const nextText = replaceAllTextMatches(text, matches, replacement);
    if (nextText === text) { setReplacedCount(0); return; }
    setSelectedIndex(-1);
    setReplacedCount(matches.length);
    onReplace(nextText, { start: matches[0].start, end: matches[0].start + replacement.length });
  }

  return (
    <Card theme={theme} style={{ gap: 8 }}>
      <View style={{ alignItems: "center", flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <SectionTitle theme={theme}>{t("editor.find.title")}</SectionTitle>
        <NativeButton label={t("editor.find.close")} onPress={onClose} small theme={theme} variant="outline" />
      </View>
      <View style={{ flexDirection: compact ? "column" : "row", alignItems: compact ? "stretch" : "center", gap: 8 }}>
        <NativeTextInput
          accessibilityLabel={t("editor.find.query")}
          autoFocus
          onChangeText={(value) => { setQuery(value); setSelectedIndex(-1); setReplacedCount(null); }}
          onSubmitEditing={() => navigate(1)}
          placeholder={t("editor.find.query")}
          small
          style={compact ? undefined : { flex: 1 }}
          theme={theme}
          value={query}
        />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: font.caption, lineHeight: uiMetrics.compactControlLineHeight }}>
          {t("editor.find.count", { current: activeIndex + 1, total: matches.length })}
        </Text>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <NativeButton disabled={!matches.length} label={t("editor.find.previous")} onPress={() => navigate(-1)} small theme={theme} variant="outline" />
        <NativeButton disabled={!matches.length} label={t("editor.find.next")} onPress={() => navigate(1)} small theme={theme} variant="outline" />
      </View>
      <NativeTextInput
        accessibilityLabel={t("editor.find.replacement")}
        editable={editable}
        onChangeText={setReplacement}
        placeholder={t("editor.find.replacement")}
        small
        theme={theme}
        value={replacement}
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <NativeButton disabled={!editable || !matches.length} label={t("editor.find.replace")} onPress={replaceCurrent} small theme={theme} variant="outline" />
        <NativeButton disabled={!editable || !matches.length} label={t("editor.find.replaceAll")} onPress={replaceAll} small theme={theme} variant="outline" />
      </View>
      {replacedCount !== null ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: font.caption, lineHeight: uiMetrics.compactControlLineHeight }}>
          {t("editor.find.replaced", { count: replacedCount })}
        </Text>
      ) : null}
    </Card>
  );
}
