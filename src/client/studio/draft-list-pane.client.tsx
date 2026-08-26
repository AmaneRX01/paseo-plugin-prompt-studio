import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import type { DraftSummary } from "../../shared/contracts.shared";
import { draftStatuses } from "../../shared/draft-lifecycle.shared";
import { normalizeTags, tagKey, type TagTreeNode } from "../../shared/tags.shared";
import { useI18n } from "../i18n.client";
import {
  EmptyState,
  Divider,
  FieldLabel,
  Hint,
  NativeButton,
  NativeTextInput,
  SegmentedControl,
  StatusPill,
  font,
  paletteOf,
  uiMetrics,
} from "../ui.client";
import {
  activeFilterSelection,
  activeNullableFilterSelection,
  toggleActiveFilterSelection,
  toggleNullableFilterSelection,
} from "./filter-selection.client";
import type { ProjectChoice } from "./project-choices.client";
import { displayTitle, formatWhen, scopeLabel } from "./studio-formatters.client";
import {
  TagChipInput,
  TagFilterChip,
  TagTreeDirectory,
  type TagControlLabels,
  type TagSuggestion,
} from "./tag-controls.client";
import type { DraftStatus, StudioProjectContext } from "./studio-types.client";

function HighlightedText({
  value,
  query,
  theme,
  style,
  numberOfLines,
}: {
  value: string;
  query: string;
  theme: PluginTheme;
  style: StyleProp<TextStyle>;
  numberOfLines?: number;
}) {
  const tokens = [...new Set(query.trim().split(/\s+/).filter(Boolean))];
  if (!tokens.length) return <Text numberOfLines={numberOfLines} style={style}>{value}</Text>;
  const pattern = new RegExp(`(${tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "ig");
  const normalizedTokens = new Set(tokens.map((token) => token.toLocaleLowerCase()));
  return (
    <Text numberOfLines={numberOfLines} style={style}>
      {value.split(pattern).map((part, index) => normalizedTokens.has(part.toLocaleLowerCase()) ? (
        <Text key={`${index}:${part}`} style={{ color: theme.colors.accent, fontWeight: "600" }}>{part}</Text>
      ) : part)}
    </Text>
  );
}

export interface DraftListPaneProps {
  theme: PluginTheme;
  compact: boolean;
  drafts: DraftSummary[];
  selectedDraftId: string | null;
  queryText: string;
  search: string;
  statuses: DraftStatus[];
  projectIds: string[] | null;
  tagTree: readonly TagTreeNode[];
  tagPaths: readonly string[] | null;
  tagSuggestions: readonly TagSuggestion[];
  tagLabels: Partial<TagControlLabels>;
  projectContext?: StudioProjectContext;
  projectChoices: ProjectChoice[];
  scratchpad: boolean;
  creating: boolean;
  refreshing: boolean;
  pending: boolean;
  createError?: string | null;
  bulkLabels: DraftBulkTagLabels;
  bulkBusy?: boolean;
  bulkError?: string | null;
  onQueryTextChange: (value: string) => void;
  onStatusChange: (value: DraftStatus[]) => void;
  onProjectChange: (value: string[] | null) => void;
  onTagChange: (value: string[] | null) => void;
  onTagRename: (fromPath: string, toPath: string) => void | Promise<void>;
  onBulkAdd: (draftIds: string[], tags: string[]) => void | Promise<void>;
  onBulkRemove: (
    draftIds: string[],
    tags: string[],
    removeDescendants: boolean,
  ) => void | Promise<void>;
  onCreate: () => void;
  onRefresh: () => void;
  onSelect: (draftId: string) => void;
  style?: StyleProp<ViewStyle>;
}

export interface DraftBulkTagLabels {
  start: string;
  done: string;
  selectAll: string;
  clearSelection: string;
  selected: (count: number) => string;
  selectDraft: (title: string, selected: boolean) => string;
  tagsPlaceholder: string;
  add: string;
  remove: string;
  applying: string;
  empty: string;
  error: (message: string) => string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function DraftListPane({
  theme,
  compact,
  drafts,
  selectedDraftId,
  queryText,
  search,
  statuses,
  projectIds,
  tagTree,
  tagPaths,
  tagSuggestions,
  tagLabels,
  projectContext,
  projectChoices,
  scratchpad,
  creating,
  refreshing,
  pending,
  createError,
  bulkLabels,
  bulkBusy = false,
  bulkError,
  onQueryTextChange,
  onStatusChange,
  onProjectChange,
  onTagChange,
  onTagRename,
  onBulkAdd,
  onBulkRemove,
  onCreate,
  onRefresh,
  onSelect,
  style,
}: DraftListPaneProps) {
  const { t, locale } = useI18n();
  const palette = useMemo(() => paletteOf(theme), [theme]);
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedBulkDraftIds, setSelectedBulkDraftIds] = useState<string[]>([]);
  const [bulkTags, setBulkTags] = useState<string[]>([]);
  const [localBulkBusy, setLocalBulkBusy] = useState(false);
  const [localBulkError, setLocalBulkError] = useState<string | null>(null);
  const statusIds = draftStatuses;
  const projectOptionIds = useMemo(
    () => projectChoices.map((project) => project.projectId),
    [projectChoices],
  );
  const selectedStatusIds = useMemo(
    () => activeFilterSelection(statuses, statusIds),
    [statuses, statusIds],
  );
  const selectedProjectIds = useMemo(
    () => activeNullableFilterSelection(projectIds, projectOptionIds),
    [projectIds, projectOptionIds],
  );
  const selectedTagKeys = useMemo(() => new Set((tagPaths ?? []).map(tagKey)), [tagPaths]);
  const tagCounts = useMemo(
    () => new Map(tagSuggestions.map((suggestion) => [tagKey(suggestion.path), suggestion.count])),
    [tagSuggestions],
  );
  const visibleDraftIdSet = useMemo(() => new Set(drafts.map((draft) => draft.id)), [drafts]);
  const applyingBulk = bulkBusy || localBulkBusy;

  useEffect(() => {
    setSelectedBulkDraftIds((current) => {
      const next = current.filter((draftId) => visibleDraftIdSet.has(draftId));
      return next.length === current.length ? current : next;
    });
  }, [visibleDraftIdSet]);

  function toggleStatusFilter(id: string) {
    onStatusChange(toggleActiveFilterSelection(statuses, id, statusIds) as DraftStatus[]);
  }

  function toggleProjectFilter(id: string) {
    onProjectChange(toggleNullableFilterSelection(projectIds, id, projectOptionIds));
  }

  function toggleTagFilter(path: string) {
    const normalized = normalizeTags(tagPaths ?? []);
    const key = tagKey(path);
    const next = selectedTagKeys.has(key)
      ? normalized.filter((candidate) => tagKey(candidate) !== key)
      : normalizeTags([...normalized, path]);
    onTagChange(next.length ? next : null);
  }

  function setTagFilters(paths: string[]) {
    const normalized = normalizeTags(paths);
    onTagChange(normalized.length ? normalized : null);
  }

  function toggleBulkDraft(draftId: string) {
    setSelectedBulkDraftIds((current) => current.includes(draftId)
      ? current.filter((candidate) => candidate !== draftId)
      : [...current, draftId]);
  }

  function leaveBulkMode() {
    setBulkMode(false);
    setSelectedBulkDraftIds([]);
    setBulkTags([]);
    setLocalBulkError(null);
  }

  async function applyBulk(
    action: "add" | "remove",
    tags: readonly string[],
    removeDescendants: boolean,
  ) {
    const normalized = normalizeTags(tags);
    if (!selectedBulkDraftIds.length || !normalized.length || applyingBulk) return;
    setLocalBulkBusy(true);
    setLocalBulkError(null);
    try {
      if (action === "add") {
        await onBulkAdd([...selectedBulkDraftIds], normalized);
      } else {
        await onBulkRemove([...selectedBulkDraftIds], normalized, removeDescendants);
      }
      setBulkTags([]);
    } catch (error) {
      setLocalBulkError(bulkLabels.error(errorText(error)));
      throw error;
    } finally {
      setLocalBulkBusy(false);
    }
  }

  const allVisibleSelected = drafts.length > 0
    && drafts.every((draft) => selectedBulkDraftIds.includes(draft.id));
  const canApplyBulk = selectedBulkDraftIds.length > 0 && bulkTags.length > 0 && !applyingBulk;
  const bulkInputLabels = {
    ...tagLabels,
    inputPlaceholder: bulkLabels.tagsPlaceholder,
    inputAccessibilityLabel: bulkLabels.tagsPlaceholder,
  };

  const bulkPanel = bulkMode ? (
    <View
      style={{
        backgroundColor: palette.raised,
        borderColor: palette.border,
        borderRadius: uiMetrics.surfaceRadius,
        borderWidth: 1,
        gap: 6,
        padding: compact ? 8 : 10,
      }}
    >
      <View style={{ alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <Text style={{ color: theme.colors.foreground, flex: 1, fontSize: font.caption, fontWeight: "500" }}>
          {bulkLabels.selected(selectedBulkDraftIds.length)}
        </Text>
        <NativeButton
          disabled={applyingBulk || allVisibleSelected || !drafts.length}
          label={bulkLabels.selectAll}
          onPress={() => setSelectedBulkDraftIds(drafts.map((draft) => draft.id))}
          small
          theme={theme}
          variant="outline"
        />
        <NativeButton
          disabled={applyingBulk || !selectedBulkDraftIds.length}
          label={bulkLabels.clearSelection}
          onPress={() => setSelectedBulkDraftIds([])}
          small
          theme={theme}
          variant="ghost"
        />
      </View>
      <TagChipInput
        compact
        editable={!applyingBulk}
        labels={bulkInputLabels}
        onChange={setBulkTags}
        suggestions={tagSuggestions}
        theme={theme}
        value={bulkTags}
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <NativeButton
          disabled={!canApplyBulk}
          label={applyingBulk ? bulkLabels.applying : bulkLabels.add}
          onPress={() => {
            void applyBulk("add", bulkTags, false).catch(() => undefined);
          }}
          small
          theme={theme}
        />
        <NativeButton
          disabled={!canApplyBulk}
          label={applyingBulk ? bulkLabels.applying : bulkLabels.remove}
          onPress={() => {
            void applyBulk("remove", bulkTags, false).catch(() => undefined);
          }}
          small
          theme={theme}
          variant="outline"
        />
      </View>
      {!selectedBulkDraftIds.length ? (
        <Hint theme={theme}>{bulkLabels.empty}</Hint>
      ) : null}
      {bulkError ? <Hint danger theme={theme}>{bulkError}</Hint> : null}
      {localBulkError ? <Hint danger theme={theme}>{localBulkError}</Hint> : null}
    </View>
  ) : null;

  const rows = drafts.map((draft) => {
    const selected = selectedDraftId === draft.id;
    const bulkSelected = selectedBulkDraftIds.includes(draft.id);
    const title = displayTitle(t, draft.title);
    const statusLabel = t(
      draft.status === "archived"
        ? "filter.archived"
        : draft.status === "ready"
          ? "filter.ready"
          : "filter.draft",
    );
    return (
      <Pressable
        accessibilityLabel={bulkMode ? bulkLabels.selectDraft(title, bulkSelected) : `${statusLabel}: ${title}`}
        accessibilityRole={bulkMode ? "checkbox" : "button"}
        accessibilityState={bulkMode
          ? { checked: bulkSelected, disabled: applyingBulk }
          : { selected, disabled: applyingBulk }}
        disabled={applyingBulk}
        key={draft.id}
        onPress={() => bulkMode ? toggleBulkDraft(draft.id) : onSelect(draft.id)}
        style={({ pressed }) => ({
          backgroundColor: bulkSelected || selected ? palette.controlStrong : pressed ? palette.control : "transparent",
          borderBottomColor: palette.border,
          borderBottomWidth: 1,
          gap: 4,
          paddingHorizontal: compact ? 12 : 14,
          paddingVertical: 10,
        })}
      >
        <View style={{ alignItems: "baseline", flexDirection: "row", gap: 8 }}>
          {bulkMode ? (
            <View
              style={{
                alignItems: "center",
                alignSelf: "center",
                backgroundColor: bulkSelected ? theme.colors.accent : "transparent",
                borderColor: bulkSelected ? theme.colors.accent : palette.borderStrong,
                borderRadius: uiMetrics.controlRadius,
                borderWidth: 1,
                height: 18,
                justifyContent: "center",
                width: 18,
              }}
            >
              {bulkSelected ? (
                <Text style={{ color: theme.colors.accentForeground, fontSize: 12, lineHeight: 14 }}>✓</Text>
              ) : null}
            </View>
          ) : null}
          <HighlightedText
            numberOfLines={1}
            query={search}
            style={{ color: theme.colors.foreground, flex: 1, fontSize: font.body, fontWeight: "500" }}
            theme={theme}
            value={title}
          />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            {formatWhen(locale, draft.updatedAt)}
          </Text>
        </View>
        <HighlightedText
          numberOfLines={2}
          query={search}
          style={{ color: theme.colors.foregroundMuted, fontSize: font.caption, lineHeight: 17 }}
          theme={theme}
          value={draft.preview || t("drafts.emptyMarkdown")}
        />
        <View style={{ alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
          <StatusPill
            label={statusLabel}
            theme={theme}
            tone={draft.status === "ready" ? "accent" : "neutral"}
          />
          <StatusPill label={scopeLabel(t, draft.scope)} theme={theme} />
          {draft.contentOrigin.kind === "generated" ? (
            <StatusPill label={t("editor.generated")} theme={theme} tone="accent" />
          ) : null}
          {draft.tags.slice(0, 2).map((tag) => (
            <TagFilterChip
              compact
              count={tagCounts.get(tagKey(tag))}
              disabled={applyingBulk}
              key={tagKey(tag)}
              labels={tagLabels}
              onPress={toggleTagFilter}
              path={tag}
              selected={selectedTagKeys.has(tagKey(tag))}
              theme={theme}
            />
          ))}
          {draft.dispatchCount ? <StatusPill label={`sent ×${draft.dispatchCount}`} theme={theme} tone="accent" /> : null}
        </View>
      </Pressable>
    );
  });

  const list = !drafts.length && !pending ? (
    <View style={{ padding: 12 }}>
      <EmptyState theme={theme} title={t("drafts.empty.title")} body={t("drafts.empty.body")} />
    </View>
  ) : compact ? <View>{rows}</View> : <ScrollView style={{ flex: 1 }}>{rows}</ScrollView>;

  return (
    <View
      style={[
        {
          backgroundColor: palette.raised,
          minHeight: 0,
          overflow: "hidden",
        },
        style,
      ]}
    >
      <View style={{ borderBottomColor: palette.border, borderBottomWidth: 1, gap: 8, padding: compact ? 12 : 14 }}>
        <View style={{ alignItems: "center", flexDirection: "row", gap: 8 }}>
          <Text style={{ color: theme.colors.foregroundMuted, flex: 1, fontSize: font.caption, fontWeight: "500" }}>
            {scratchpad ? t("drafts.scoped") : t("drafts.all")} · {drafts.length}
          </Text>
          <NativeButton
            disabled={applyingBulk}
            label={bulkMode ? bulkLabels.done : bulkLabels.start}
            onPress={() => bulkMode ? leaveBulkMode() : setBulkMode(true)}
            small
            theme={theme}
            variant={bulkMode ? "secondary" : "outline"}
          />
          <NativeButton
            label={creating ? t("drafts.creating") : `+ ${t("drafts.new")}`}
            onPress={onCreate}
            disabled={creating || bulkMode || applyingBulk}
            small
            theme={theme}
          />
        </View>
        <View style={{ alignItems: "center", flexDirection: "row", gap: 6 }}>
          <NativeTextInput
            accessibilityLabel={t("search.placeholder")}
            onChangeText={onQueryTextChange}
            editable={!applyingBulk}
            placeholder={t("search.placeholder")}
            small
            style={{ flex: 1 }}
            theme={theme}
            value={queryText}
          />
          <NativeButton
            accessibilityLabel={t("search.refresh")}
            label="↻"
            onPress={onRefresh}
            disabled={refreshing || applyingBulk}
            small
            theme={theme}
            variant="outline"
          />
        </View>
        {bulkPanel}
        <View style={{ gap: 6 }}>
          <FieldLabel theme={theme}>{t("filter.statuses")}</FieldLabel>
          <SegmentedControl
            options={[
              { id: "draft", label: t("filter.draft"), disabled: applyingBulk },
              { id: "ready", label: t("filter.ready"), disabled: applyingBulk },
              { id: "archived", label: t("filter.archived"), disabled: applyingBulk },
            ]}
            onSelect={toggleStatusFilter}
            selectedIds={selectedStatusIds}
            small
            theme={theme}
          />
        </View>
        <Divider theme={theme} />
        <View style={{ gap: 6 }}>
          <FieldLabel theme={theme}>{t("filter.projects")}</FieldLabel>
          {!projectContext ? (
            <SegmentedControl
              options={projectChoices.map((project) => ({
                id: project.projectId,
                label: project.projectDisplayName,
                disabled: applyingBulk,
              }))}
              onSelect={toggleProjectFilter}
              selectedIds={selectedProjectIds}
              small
              theme={theme}
            />
          ) : <StatusPill label={projectContext.projectName} size="control" theme={theme} tone="accent" />}
        </View>
        <Divider theme={theme} />
        <TagTreeDirectory
          bulkTargetCount={bulkMode ? selectedBulkDraftIds.length : 0}
          compact
          disabled={applyingBulk}
          labels={tagLabels}
          maxHeight={compact ? 260 : 180}
          nodes={tagTree}
          onBatchAdd={bulkMode ? (path) => applyBulk("add", [path], false) : undefined}
          onBatchRemove={bulkMode ? (path) => applyBulk("remove", [path], true) : undefined}
          onRename={onTagRename}
          onSelectionChange={setTagFilters}
          selectedPaths={tagPaths ?? []}
          theme={theme}
        />
        {createError ? <Hint danger theme={theme}>{createError}</Hint> : null}
      </View>
      {pending ? <ActivityIndicator color={theme.colors.accent} style={{ margin: 16 }} /> : null}
      {list}
    </View>
  );
}
