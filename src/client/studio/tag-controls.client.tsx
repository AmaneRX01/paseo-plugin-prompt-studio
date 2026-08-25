import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import {
  normalizeTagPath,
  tagKey,
  type TagTreeNode,
} from "../../shared/tags.shared";
import {
  FieldLabel,
  Hint,
  NativeButton,
  NativeTextInput,
  font,
  paletteOf,
  uiMetrics,
} from "../ui.client";

export interface TagSuggestion {
  /** Canonical, slash-delimited tag path, for example `language/typescript`. */
  path: string;
  /** Number of matching entities, when the catalog has supplied one. */
  count?: number;
}

export type { TagTreeNode } from "../../shared/tags.shared";

export interface TagControlLabels {
  inputPlaceholder: string;
  inputAccessibilityLabel: string;
  suggestionsAccessibilityLabel: string;
  addSuggestion: (path: string) => string;
  removeTag: (path: string) => string;
  directoryTitle: string;
  directoryEmpty: string;
  clearFilters: string;
  expandTag: (path: string) => string;
  collapseTag: (path: string) => string;
  selectTag: (path: string) => string;
  deselectTag: (path: string) => string;
  tagCount: (path: string, directCount: number, totalCount: number) => string;
  manageTag: (path: string) => string;
  closeManagement: (path: string) => string;
  rename: string;
  renameInput: (path: string) => string;
  saveRename: string;
  delete: string;
  deletePrompt: (path: string) => string;
  confirmDelete: string;
  cancel: string;
  batchAdd: (path: string, targetCount: number) => string;
  batchRemove: (path: string, targetCount: number) => string;
}

export const defaultTagControlLabels: TagControlLabels = {
  inputPlaceholder: "Add tag…",
  inputAccessibilityLabel: "Tags",
  suggestionsAccessibilityLabel: "Tag suggestions",
  addSuggestion: (path) => `Add tag ${path}`,
  removeTag: (path) => `Remove tag ${path}`,
  directoryTitle: "Tags",
  directoryEmpty: "No tags yet",
  clearFilters: "Clear",
  expandTag: (path) => `Expand tag ${path}`,
  collapseTag: (path) => `Collapse tag ${path}`,
  selectTag: (path) => `Filter by tag ${path}`,
  deselectTag: (path) => `Remove tag filter ${path}`,
  tagCount: (path, directCount, totalCount) => (
    `${path}: ${directCount} direct, ${totalCount} including child tags`
  ),
  manageTag: (path) => `Manage tag ${path}`,
  closeManagement: (path) => `Close tag management for ${path}`,
  rename: "Rename",
  renameInput: (path) => `New name for ${path}`,
  saveRename: "Save",
  delete: "Delete",
  deletePrompt: (path) => `Delete ${path} from every entity?`,
  confirmDelete: "Delete",
  cancel: "Cancel",
  batchAdd: (path, targetCount) => `Add ${path} to ${targetCount} selected items`,
  batchRemove: (path, targetCount) => `Remove ${path} from ${targetCount} selected items`,
};

type LabelOverrides = Partial<TagControlLabels>;
type MaybePromise = void | Promise<void>;

function labelsOf(overrides?: LabelOverrides): TagControlLabels {
  return { ...defaultTagControlLabels, ...overrides };
}

function renameDestination(currentPath: string, input: string): string {
  const normalized = normalizeTagPath(input);
  if (!normalized || input.includes("/")) return normalized;
  const parentEnd = normalizeTagPath(currentPath).lastIndexOf("/");
  return parentEnd < 0 ? normalized : `${normalizeTagPath(currentPath).slice(0, parentEnd)}/${normalized}`;
}

function appendTag(
  current: readonly string[],
  candidate: string,
  preferCandidateSpelling = false,
): { changed: boolean; tags: string[] } {
  const path = normalizeTagPath(candidate);
  if (!path) return { changed: false, tags: [...current] };
  const key = tagKey(path);
  const existingIndex = current.findIndex((tag) => tagKey(tag) === key);
  if (existingIndex < 0) return { changed: true, tags: [...current, path] };
  if (!preferCandidateSpelling || current[existingIndex] === path) {
    return { changed: false, tags: [...current] };
  }
  const tags = [...current];
  tags[existingIndex] = path;
  return { changed: true, tags };
}

function removeTag(current: readonly string[], path: string): string[] {
  const key = tagKey(path);
  return current.filter((tag) => tagKey(tag) !== key);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface TagChipInputProps {
  theme: PluginTheme;
  compact: boolean;
  value: readonly string[];
  suggestions: readonly TagSuggestion[];
  onChange: (tags: string[]) => void;
  editable?: boolean;
  maxSuggestions?: number;
  labels?: LabelOverrides;
  error?: string | null;
  style?: StyleProp<ViewStyle>;
}

/** Controlled chip editor with case-insensitive completion and de-duplication. */
export function TagChipInput({
  theme,
  compact,
  value,
  suggestions,
  onChange,
  editable = true,
  maxSuggestions = 8,
  labels: labelOverrides,
  error,
  style,
}: TagChipInputProps) {
  const palette = useMemo(() => paletteOf(theme), [theme]);
  const labels = useMemo(() => labelsOf(labelOverrides), [labelOverrides]);
  const inputRef = useRef<TextInput>(null);
  const suppressBlurCommit = useRef(false);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const selectedKeys = useMemo(() => new Set(value.map(tagKey)), [value]);

  const visibleSuggestions = useMemo(() => {
    const normalizedQuery = tagKey(normalizeTagPath(query));
    if (!focused || !normalizedQuery) return [];
    const unique = new Map<string, TagSuggestion>();
    for (const suggestion of suggestions) {
      const path = normalizeTagPath(suggestion.path);
      const key = tagKey(path);
      if (!path || selectedKeys.has(key) || !key.includes(normalizedQuery)) continue;
      const prior = unique.get(key);
      if (!prior || (suggestion.count ?? 0) > (prior.count ?? 0)) {
        unique.set(key, { ...suggestion, path });
      }
    }
    return [...unique.values()]
      .sort((left, right) => {
        const leftPrefix = tagKey(left.path).startsWith(normalizedQuery) ? 0 : 1;
        const rightPrefix = tagKey(right.path).startsWith(normalizedQuery) ? 0 : 1;
        return leftPrefix - rightPrefix
          || (right.count ?? 0) - (left.count ?? 0)
          || left.path.localeCompare(right.path, undefined, { sensitivity: "base" });
      })
      .slice(0, Math.max(0, maxSuggestions));
  }, [focused, maxSuggestions, query, selectedKeys, suggestions]);

  function canonicalPath(candidate: string): string {
    const normalized = normalizeTagPath(candidate);
    const key = tagKey(normalized);
    return suggestions.find((suggestion) => tagKey(suggestion.path) === key)?.path ?? normalized;
  }

  function commitCandidates(candidates: readonly string[], preferCandidateSpelling = false) {
    let next = [...value];
    let changed = false;
    for (const candidate of candidates) {
      const result = appendTag(next, canonicalPath(candidate), preferCandidateSpelling);
      next = result.tags;
      changed = changed || result.changed;
    }
    if (changed) onChange(next);
  }

  function commitQuery() {
    if (!editable) return;
    commitCandidates([query]);
    setQuery("");
  }

  function changeQuery(nextValue: string) {
    const pieces = nextValue.split(/[,，]/);
    if (pieces.length === 1) {
      setQuery(nextValue);
      return;
    }
    const endsWithSeparator = /[,，]\s*$/.test(nextValue);
    const remainder = endsWithSeparator ? "" : pieces.pop() ?? "";
    commitCandidates(pieces);
    setQuery(remainder.trimStart());
  }

  function chooseSuggestion(path: string) {
    commitCandidates([path], true);
    setQuery("");
    suppressBlurCommit.current = false;
    inputRef.current?.focus();
  }

  return (
    <View style={[{ gap: 4 }, style]}>
      <Pressable
        accessibilityLabel={labels.inputAccessibilityLabel}
        accessibilityRole="none"
        onPress={() => inputRef.current?.focus()}
        style={{
          alignItems: "center",
          backgroundColor: palette.control,
          borderColor: focused ? theme.colors.accent : palette.border,
          borderRadius: uiMetrics.controlRadius,
          borderWidth: 1,
          flexDirection: "row",
          flexWrap: "wrap",
          gap: compact ? 4 : 6,
          minHeight: compact ? uiMetrics.compactControlHeight : uiMetrics.controlHeight,
          opacity: editable ? 1 : 0.5,
          paddingHorizontal: compact ? 5 : 7,
          paddingVertical: compact ? 4 : 5,
        }}
      >
        {value.map((tag) => (
          <View
            key={tagKey(tag)}
            style={{
              alignItems: "center",
              backgroundColor: palette.controlStrong,
              borderColor: palette.borderStrong,
              borderRadius: uiMetrics.controlRadius,
              borderWidth: 1,
              flexDirection: "row",
              maxWidth: "100%",
              minHeight: compact ? 24 : 28,
              paddingLeft: compact ? 7 : 9,
            }}
          >
            <Text
              numberOfLines={1}
              style={{
                color: theme.colors.foreground,
                flexShrink: 1,
                fontSize: font.caption,
                lineHeight: 18,
              }}
            >
              {tag}
            </Text>
            <Pressable
              accessibilityLabel={labels.removeTag(tag)}
              accessibilityRole="button"
              accessibilityState={{ disabled: !editable }}
              disabled={!editable}
              hitSlop={4}
              onPress={(event) => {
                event.stopPropagation();
                onChange(removeTag(value, tag));
                suppressBlurCommit.current = false;
                inputRef.current?.focus();
              }}
              onPressIn={() => {
                suppressBlurCommit.current = true;
              }}
              style={({ pressed }) => ({
                alignItems: "center",
                alignSelf: "stretch",
                justifyContent: "center",
                opacity: pressed ? 0.65 : 1,
                paddingHorizontal: compact ? 6 : 7,
              })}
            >
              <Text
                style={{
                  color: theme.colors.foregroundMuted,
                  fontSize: 16,
                  lineHeight: 18,
                }}
              >
                ×
              </Text>
            </Pressable>
          </View>
        ))}
        <TextInput
          ref={inputRef}
          accessibilityLabel={labels.inputAccessibilityLabel}
          autoCapitalize="none"
          autoCorrect={false}
          editable={editable}
          onBlur={() => {
            if (suppressBlurCommit.current) return;
            setFocused(false);
            commitQuery();
          }}
          onChangeText={changeQuery}
          onFocus={() => {
            suppressBlurCommit.current = false;
            setFocused(true);
          }}
          onKeyPress={({ nativeEvent }) => {
            if (nativeEvent.key === "Backspace" && !query && value.length > 0) {
              onChange(value.slice(0, -1));
            }
          }}
          onSubmitEditing={commitQuery}
          placeholder={value.length ? undefined : labels.inputPlaceholder}
          placeholderTextColor={theme.colors.foregroundMuted}
          returnKeyType="done"
          selectionColor={theme.colors.accent}
          style={{
            color: theme.colors.foreground,
            flexBasis: compact ? 80 : 120,
            flexGrow: 1,
            fontSize: font.body,
            lineHeight: compact ? uiMetrics.compactControlLineHeight : uiMetrics.controlLineHeight,
            minHeight: compact ? 24 : 28,
            minWidth: compact ? 80 : 120,
            paddingHorizontal: 4,
            paddingVertical: 0,
          }}
          value={query}
        />
      </Pressable>

      {visibleSuggestions.length ? (
        <View
          accessibilityLabel={labels.suggestionsAccessibilityLabel}
          style={{
            backgroundColor: palette.raised,
            borderColor: palette.border,
            borderRadius: uiMetrics.controlRadius,
            borderWidth: 1,
            overflow: "hidden",
          }}
        >
          {visibleSuggestions.map((suggestion, index) => (
            <Pressable
              accessibilityLabel={labels.addSuggestion(suggestion.path)}
              accessibilityRole="button"
              key={tagKey(suggestion.path)}
              onPress={() => chooseSuggestion(suggestion.path)}
              onPressIn={() => {
                suppressBlurCommit.current = true;
              }}
              onPressOut={() => {
                setTimeout(() => {
                  if (inputRef.current?.isFocused()) return;
                  suppressBlurCommit.current = false;
                  setFocused(false);
                }, 0);
              }}
              style={({ pressed }) => ({
                alignItems: "center",
                backgroundColor: pressed ? palette.controlStrong : palette.raised,
                borderTopColor: palette.border,
                borderTopWidth: index ? 1 : 0,
                flexDirection: "row",
                gap: 8,
                minHeight: compact ? uiMetrics.compactControlHeight : uiMetrics.controlHeight,
                paddingHorizontal: compact ? 9 : 11,
                paddingVertical: compact ? 5 : 7,
              })}
            >
              <Text
                numberOfLines={1}
                style={{ color: theme.colors.foreground, flex: 1, fontSize: font.body }}
              >
                {suggestion.path}
              </Text>
              {suggestion.count !== undefined ? (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: font.caption }}>
                  {suggestion.count}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </View>
      ) : null}
      {error ? <Hint danger theme={theme}>{error}</Hint> : null}
    </View>
  );
}

export interface TagFilterChipProps {
  theme: PluginTheme;
  path: string;
  onPress: (path: string) => void;
  count?: number;
  selected?: boolean;
  compact?: boolean;
  disabled?: boolean;
  labels?: LabelOverrides;
  style?: StyleProp<ViewStyle>;
}

/** Clickable tag badge intended for draft rows and other filter entry points. */
export function TagFilterChip({
  theme,
  path,
  onPress,
  count,
  selected = false,
  compact = true,
  disabled = false,
  labels: labelOverrides,
  style,
}: TagFilterChipProps) {
  const palette = useMemo(() => paletteOf(theme), [theme]);
  const labels = useMemo(() => labelsOf(labelOverrides), [labelOverrides]);
  return (
    <Pressable
      accessibilityLabel={selected ? labels.deselectTag(path) : labels.selectTag(path)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: selected, disabled }}
      disabled={disabled}
      onPress={(event) => {
        event.stopPropagation();
        onPress(path);
      }}
      style={({ pressed }) => [
        {
          alignItems: "center",
          alignSelf: "flex-start",
          backgroundColor: selected ? palette.controlStrong : pressed ? palette.controlStrong : palette.control,
          borderColor: selected ? palette.borderStrong : palette.border,
          borderRadius: uiMetrics.controlRadius,
          borderWidth: 1,
          flexDirection: "row",
          gap: 5,
          maxWidth: "100%",
          minHeight: compact ? uiMetrics.pillHeight : 28,
          opacity: disabled ? 0.5 : 1,
          paddingHorizontal: compact ? 7 : 9,
          paddingVertical: compact ? 2 : 4,
        },
        style,
      ]}
    >
      <Text
        numberOfLines={1}
        style={{
          color: selected ? theme.colors.foreground : theme.colors.foregroundMuted,
          flexShrink: 1,
          fontSize: font.caption,
          fontWeight: selected ? "500" : "400",
          lineHeight: 16,
        }}
      >
        #{path}
      </Text>
      {count !== undefined ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 16 }}>
          {count}
        </Text>
      ) : null}
    </Pressable>
  );
}

export interface TagTreeDirectoryProps {
  theme: PluginTheme;
  compact: boolean;
  nodes: readonly TagTreeNode[];
  /** Active directory filters. This is intentionally unrelated to bulk targets. */
  selectedPaths: readonly string[];
  onSelectionChange: (paths: string[]) => void;
  /** Number of drafts/entities selected elsewhere for bulk mutation. */
  bulkTargetCount?: number;
  /**
   * Rename or move a subtree. `nextPath` is always complete: a segment-only
   * edit has already been joined to the current parent by this component.
   */
  onRename?: (path: string, nextPath: string) => MaybePromise;
  onDelete?: (path: string) => MaybePromise;
  onBatchAdd?: (path: string) => MaybePromise;
  onBatchRemove?: (path: string) => MaybePromise;
  disabled?: boolean;
  busyPaths?: readonly string[];
  error?: string | null;
  expandedPaths?: readonly string[];
  defaultExpandedPaths?: readonly string[];
  onExpandedPathsChange?: (paths: string[]) => void;
  labels?: LabelOverrides;
  /** Maximum height of the independently scrollable node region. */
  maxHeight?: number;
  style?: StyleProp<ViewStyle>;
}

type PendingAction = { kind: "rename" | "delete" | "add" | "remove"; path: string };

function defaultExpanded(nodes: readonly TagTreeNode[]): string[] {
  return nodes.filter((node) => node.children.length > 0).map((node) => node.path);
}

/** Hierarchical tag filters plus opt-in catalog and bulk-management actions. */
export function TagTreeDirectory({
  theme,
  compact,
  nodes,
  selectedPaths,
  onSelectionChange,
  bulkTargetCount = 0,
  onRename,
  onDelete,
  onBatchAdd,
  onBatchRemove,
  disabled = false,
  busyPaths = [],
  error,
  expandedPaths,
  defaultExpandedPaths,
  onExpandedPathsChange,
  labels: labelOverrides,
  maxHeight,
  style,
}: TagTreeDirectoryProps) {
  const palette = useMemo(() => paletteOf(theme), [theme]);
  const labels = useMemo(() => labelsOf(labelOverrides), [labelOverrides]);
  const [internalExpanded, setInternalExpanded] = useState<string[]>(
    () => defaultExpandedPaths ? [...defaultExpandedPaths] : defaultExpanded(nodes),
  );
  const [managedPath, setManagedPath] = useState<string | null>(null);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [localError, setLocalError] = useState<{ path: string; message: string } | null>(null);
  const actualExpanded = expandedPaths ?? internalExpanded;
  const expandedKeys = useMemo(() => new Set(actualExpanded.map(tagKey)), [actualExpanded]);
  const selectedKeys = useMemo(() => new Set(selectedPaths.map(tagKey)), [selectedPaths]);
  const busyKeys = useMemo(() => new Set(busyPaths.map(tagKey)), [busyPaths]);
  const hasManagement = Boolean(onRename || onDelete || onBatchAdd || onBatchRemove);
  const directoryMaxHeight = maxHeight ?? (compact ? 420 : 280);
  const branchIndent = compact ? 14 : 18;
  const disclosureWidth = compact ? uiMetrics.pillHeight : uiMetrics.compactControlHeight;

  function toggleExpanded(path: string) {
    const key = tagKey(path);
    const next = expandedKeys.has(key)
      ? actualExpanded.filter((candidate) => tagKey(candidate) !== key)
      : [...actualExpanded, path];
    if (expandedPaths === undefined) setInternalExpanded(next);
    onExpandedPathsChange?.(next);
  }

  function toggleFilter(path: string) {
    const key = tagKey(path);
    const next = selectedKeys.has(key)
      ? selectedPaths.filter((candidate) => tagKey(candidate) !== key)
      : [...selectedPaths, path];
    onSelectionChange(next);
  }

  function openManagement(node: TagTreeNode) {
    const opening = tagKey(managedPath ?? "") !== tagKey(node.path);
    setManagedPath(opening ? node.path : null);
    setRenamingPath(null);
    setDeletingPath(null);
    setRenameValue(node.name);
    setLocalError(null);
  }

  async function runAction(
    kind: PendingAction["kind"],
    path: string,
    action: () => MaybePromise,
  ) {
    setPendingAction({ kind, path });
    setLocalError(null);
    try {
      await action();
      if (kind === "rename") setRenamingPath(null);
      if (kind === "delete") {
        setDeletingPath(null);
        setManagedPath(null);
      }
    } catch (actionError) {
      setLocalError({ path, message: errorText(actionError) });
    } finally {
      setPendingAction(null);
    }
  }

  function renderManagement(node: TagTreeNode, depth: number, rowBusy: boolean) {
    if (tagKey(managedPath ?? "") !== tagKey(node.path)) return null;
    const renaming = tagKey(renamingPath ?? "") === tagKey(node.path);
    const deleting = tagKey(deletingPath ?? "") === tagKey(node.path);
    const pending = tagKey(pendingAction?.path ?? "") === tagKey(node.path);
    const indent = branchIndent * depth + disclosureWidth;

    if (renaming) {
      const nextPath = renameDestination(node.path, renameValue);
      const unchanged = nextPath === normalizeTagPath(node.path);
      return (
        <View style={{ gap: 5, paddingBottom: 6, paddingLeft: indent, paddingRight: 6 }}>
          <View style={{ alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
            <NativeTextInput
              accessibilityLabel={labels.renameInput(node.path)}
              editable={!rowBusy && !pending}
              onChangeText={setRenameValue}
              onSubmitEditing={() => {
                if (onRename && nextPath && !unchanged) {
                  void runAction("rename", node.path, () => onRename(node.path, nextPath));
                }
              }}
              small
              style={{ flex: 1, minWidth: 120 }}
              theme={theme}
              value={renameValue}
            />
            <NativeButton
              accessibilityLabel={labels.saveRename}
              disabled={rowBusy || pending || !nextPath || unchanged}
              label={labels.saveRename}
              onPress={() => {
                if (onRename) void runAction("rename", node.path, () => onRename(node.path, nextPath));
              }}
              small
              theme={theme}
            />
            <NativeButton
              disabled={pending}
              label={labels.cancel}
              onPress={() => setRenamingPath(null)}
              small
              theme={theme}
              variant="ghost"
            />
          </View>
          {localError && tagKey(localError.path) === tagKey(node.path) ? (
            <Hint danger theme={theme}>{localError.message}</Hint>
          ) : null}
        </View>
      );
    }

    if (deleting) {
      return (
        <View style={{ gap: 5, paddingBottom: 6, paddingLeft: indent, paddingRight: 6 }}>
          <Text style={{ color: theme.colors.statusDanger, fontSize: font.caption }}>
            {labels.deletePrompt(node.path)}
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
            <NativeButton
              disabled={rowBusy || pending}
              label={labels.confirmDelete}
              onPress={() => {
                if (onDelete) void runAction("delete", node.path, () => onDelete(node.path));
              }}
              small
              theme={theme}
              variant="danger"
            />
            <NativeButton
              disabled={pending}
              label={labels.cancel}
              onPress={() => setDeletingPath(null)}
              small
              theme={theme}
              variant="ghost"
            />
          </View>
          {localError && tagKey(localError.path) === tagKey(node.path) ? (
            <Hint danger theme={theme}>{localError.message}</Hint>
          ) : null}
        </View>
      );
    }

    return (
      <View style={{ gap: 5, paddingBottom: 6, paddingLeft: indent, paddingRight: 6 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
          {onRename ? (
            <NativeButton
              disabled={rowBusy || pending}
              label={labels.rename}
              onPress={() => {
                setRenameValue(node.name);
                setRenamingPath(node.path);
                setLocalError(null);
              }}
              small
              theme={theme}
              variant="outline"
            />
          ) : null}
          {onDelete ? (
            <NativeButton
              disabled={rowBusy || pending}
              label={labels.delete}
              onPress={() => {
                setDeletingPath(node.path);
                setLocalError(null);
              }}
              small
              theme={theme}
              variant="danger"
            />
          ) : null}
          {bulkTargetCount > 0 && onBatchAdd ? (
            <NativeButton
              accessibilityLabel={labels.batchAdd(node.path, bulkTargetCount)}
              disabled={rowBusy || pending}
              label={`+ ${bulkTargetCount}`}
              onPress={() => void runAction("add", node.path, () => onBatchAdd(node.path))}
              small
              theme={theme}
              variant="outline"
            />
          ) : null}
          {bulkTargetCount > 0 && onBatchRemove ? (
            <NativeButton
              accessibilityLabel={labels.batchRemove(node.path, bulkTargetCount)}
              disabled={rowBusy || pending}
              label={`− ${bulkTargetCount}`}
              onPress={() => void runAction("remove", node.path, () => onBatchRemove(node.path))}
              small
              theme={theme}
              variant="outline"
            />
          ) : null}
        </View>
        {localError && tagKey(localError.path) === tagKey(node.path) ? (
          <Hint danger theme={theme}>{localError.message}</Hint>
        ) : null}
      </View>
    );
  }

  function renderNode(node: TagTreeNode, depth: number) {
    const key = tagKey(node.path);
    const selected = selectedKeys.has(key);
    const expanded = expandedKeys.has(key);
    const rowBusy = disabled || busyKeys.has(key);
    const managed = tagKey(managedPath ?? "") === key;
    const leftPadding = branchIndent * depth;
    return (
      <View key={key}>
        <View
          style={{
            alignItems: "center",
            backgroundColor: selected ? palette.controlStrong : "transparent",
            borderTopColor: palette.border,
            borderTopWidth: 1,
            flexDirection: "row",
            minHeight: compact ? uiMetrics.compactControlHeight : uiMetrics.controlHeight,
            paddingLeft: leftPadding,
            paddingRight: 0,
          }}
        >
          {node.children.length ? (
            <Pressable
              accessibilityLabel={expanded ? labels.collapseTag(node.path) : labels.expandTag(node.path)}
              accessibilityRole="button"
              accessibilityState={{ disabled: rowBusy, expanded }}
              disabled={rowBusy}
              hitSlop={4}
              onPress={() => toggleExpanded(node.path)}
              style={({ pressed }) => ({
                alignItems: "center",
                justifyContent: "center",
                minHeight: compact ? uiMetrics.compactControlHeight : uiMetrics.controlHeight,
                opacity: pressed ? 0.65 : 1,
                width: disclosureWidth,
              })}
            >
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: font.caption }}>
                {expanded ? "▾" : "▸"}
              </Text>
            </Pressable>
          ) : (
            <View style={{ width: disclosureWidth }} />
          )}

          <Pressable
            accessibilityLabel={selected ? labels.deselectTag(node.path) : labels.selectTag(node.path)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: selected, disabled: rowBusy }}
            disabled={rowBusy}
            onPress={() => toggleFilter(node.path)}
            style={({ pressed }) => ({
              alignItems: "center",
              flex: 1,
              flexDirection: "row",
              gap: compact ? 6 : 8,
              minHeight: compact ? uiMetrics.compactControlHeight : uiMetrics.controlHeight,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <View
              style={{
                alignItems: "center",
                backgroundColor: selected ? theme.colors.accent : "transparent",
                borderColor: selected ? theme.colors.accent : palette.borderStrong,
                borderRadius: uiMetrics.controlRadius,
                borderWidth: 1,
                height: 16,
                justifyContent: "center",
                width: 16,
              }}
            >
              {selected ? (
                <Text style={{ color: theme.colors.accentForeground, fontSize: 12, lineHeight: 14 }}>✓</Text>
              ) : null}
            </View>
            <Text
              numberOfLines={1}
              style={{
                color: selected ? theme.colors.foreground : theme.colors.foregroundMuted,
                flex: 1,
                fontSize: font.caption,
                fontWeight: selected ? "500" : "400",
              }}
            >
              {node.name}
            </Text>
            <View
              accessibilityLabel={labels.tagCount(node.path, node.directCount, node.count)}
              style={{
                alignItems: "center",
                backgroundColor: palette.control,
                borderRadius: uiMetrics.pillRadius,
                minWidth: 24,
                paddingHorizontal: 5,
                paddingVertical: 2,
              }}
            >
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 14 }}>
                {node.count}
              </Text>
            </View>
          </Pressable>

          {hasManagement ? (
            <Pressable
              accessibilityLabel={managed ? labels.closeManagement(node.path) : labels.manageTag(node.path)}
              accessibilityRole="button"
              accessibilityState={{ disabled: rowBusy, expanded: managed }}
              disabled={rowBusy}
              hitSlop={4}
              onPress={() => openManagement(node)}
              style={({ pressed }) => ({
                alignItems: "center",
                justifyContent: "center",
                minHeight: compact ? uiMetrics.compactControlHeight : uiMetrics.controlHeight,
                opacity: pressed ? 0.65 : 1,
                width: compact ? uiMetrics.compactControlHeight : uiMetrics.controlHeight,
              })}
            >
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 16, lineHeight: 18 }}>⋯</Text>
            </Pressable>
          ) : null}
        </View>
        {renderManagement(node, depth, rowBusy)}
        {expanded ? node.children.map((child) => renderNode(child, depth + 1)) : null}
      </View>
    );
  }

  return (
    <View
      style={[
        {
          borderBottomColor: palette.border,
          borderBottomWidth: 1,
          overflow: "hidden",
        },
        style,
      ]}
    >
      <View
        style={{
          alignItems: "center",
          flexDirection: "row",
          gap: 6,
          minHeight: compact ? uiMetrics.compactControlHeight : uiMetrics.controlHeight,
          paddingBottom: 6,
        }}
      >
        <FieldLabel theme={theme}>{labels.directoryTitle}</FieldLabel>
        <View style={{ flex: 1 }} />
        {selectedPaths.length ? (
          <NativeButton
            disabled={disabled}
            label={`${labels.clearFilters} · ${selectedPaths.length}`}
            onPress={() => onSelectionChange([])}
            small
            style={{ paddingHorizontal: 6 }}
            theme={theme}
            variant="ghost"
          />
        ) : null}
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        style={{ maxHeight: directoryMaxHeight }}
      >
        {nodes.length ? nodes.map((node) => renderNode(node, 0)) : (
          <View style={{ borderTopColor: palette.border, borderTopWidth: 1 }}>
            <Text
              style={{
                color: theme.colors.foregroundMuted,
                fontSize: font.caption,
                padding: compact ? 8 : 10,
              }}
            >
              {labels.directoryEmpty}
            </Text>
          </View>
        )}
      </ScrollView>
      {error ? (
        <View style={{ borderTopColor: palette.border, borderTopWidth: 1, padding: compact ? 8 : 10 }}>
          <Hint danger theme={theme}>{error}</Hint>
        </View>
      ) : null}
    </View>
  );
}
