import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(process.cwd());
const clientRoot = join(repositoryRoot, "src", "client");
const uiPath = join(clientRoot, "ui.client.tsx");

function clientScreens(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return clientScreens(path);
    return entry.name.endsWith(".client.tsx") && path !== uiPath ? [path] : [];
  });
}

function componentSource(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing ${start}`);
  assert.notEqual(endIndex, -1, `missing ${end}`);
  return source.slice(startIndex, endIndex);
}

test("buttons, inputs, and interactive options share one geometry scale", () => {
  const source = readFileSync(uiPath, "utf8");
  const button = componentSource(source, "export function NativeButton", "export function NativeTextInput");
  const input = componentSource(source, "export function NativeTextInput", "export interface SegmentOption");
  const options = componentSource(source, "export function SegmentedControl", "/** Read-only status pill");
  const sharedHeight = /minHeight: small \? uiMetrics\.compactControlHeight : uiMetrics\.controlHeight/;

  for (const [name, component] of [["button", button], ["input", input], ["options", options]] as const) {
    assert.match(component, sharedHeight, `${name} must use the shared control heights`);
    assert.match(component, /uiMetrics\.controlRadius/, `${name} must use the shared interactive radius`);
  }
  assert.doesNotMatch(options, /pillRadius/, "interactive options must not look like read-only pills");
  assert.match(options, /numberOfLines=\{1\}/, "option labels must not create mismatched heights");
  assert.match(options, /selectedIds/);
  assert.match(options, /borderColor: selected \? palette\.borderStrong : palette\.border/);
  assert.match(options, /accessibilityRole=\{multiSelect \? "checkbox" : "button"\}/);

  const paneSource = readFileSync(join(clientRoot, "studio", "draft-list-pane.client.tsx"), "utf8");
  assert.doesNotMatch(paneSource, /CheckboxGroup|ALL_FILTER_ID|filter\.allStatus|filter\.allProjects/);
  assert.match(paneSource, /activeFilterSelection/);
  assert.match(paneSource, /activeNullableFilterSelection/);
  assert.match(paneSource, /toggleNullableFilterSelection/);
  assert.match(paneSource, /<FieldLabel theme=\{theme\}>\{t\("filter\.statuses"\)\}<\/FieldLabel>/);
  assert.match(paneSource, /<FieldLabel theme=\{theme\}>\{t\("filter\.projects"\)\}<\/FieldLabel>/);

  const tagSource = readFileSync(join(clientRoot, "studio", "tag-controls.client.tsx"), "utf8");
  const tagTree = tagSource.slice(tagSource.indexOf("export function TagTreeDirectory"));
  assert.doesNotMatch(tagTree, /backgroundColor: palette\.raised/);
  assert.doesNotMatch(tagTree, /borderRadius: uiMetrics\.surfaceRadius/);
  assert.match(tagTree, /borderTopWidth: 1/);
  assert.match(tagTree, /<FieldLabel theme=\{theme\}>\{labels\.directoryTitle\}<\/FieldLabel>/);
  assert.match(tagTree, /const disclosureWidth = compact \? uiMetrics\.pillHeight : uiMetrics\.compactControlHeight/);
  assert.match(tagTree, /const leftPadding = branchIndent \* depth/);
  assert.match(tagTree, /<View style=\{\{ width: disclosureWidth \}\} \/>/);
  assert.match(tagTree, /const indent = branchIndent \* depth \+ disclosureWidth/);
  assert.match(tagTree, /minHeight: compact \? uiMetrics\.compactControlHeight : uiMetrics\.controlHeight/);
  assert.doesNotMatch(tagTree, /minHeight: 24/);
});

test("the editor title row uses one compact-toolbar height", () => {
  const uiSource = readFileSync(uiPath, "utf8");
  const statusPill = componentSource(uiSource, "export function StatusPill", "export function EmptyState");
  const studioSource = readFileSync(join(clientRoot, "studio.client.tsx"), "utf8");
  const editorHeader = componentSource(studioSource, "const editorHeader", "const editorBody");

  assert.match(uiSource, /lineHeight: uiMetrics\.compactControlHeight/, "toolbar metadata must occupy a 32px row");
  assert.match(statusPill, /controlSized \? uiMetrics\.compactControlHeight : uiMetrics\.pillHeight/);
  assert.match(statusPill, /controlSized \? uiMetrics\.controlRadius : uiMetrics\.pillRadius/);
  assert.match(editorHeader, /<ToolbarMeta selectable theme=\{theme\}>/);
  assert.match(editorHeader, /size="control"/);
  assert.match(editorHeader, /variant="bare"/);
});

test("floating dialogs share one theme, type scale, and close treatment", () => {
  const uiSource = readFileSync(uiPath, "utf8");
  const dialog = componentSource(uiSource, "export function NativeDialog", "export function Card");
  const dialogSources = [
    readFileSync(join(clientRoot, "studio", "studio-header.client.tsx"), "utf8"),
    readFileSync(join(clientRoot, "studio", "prompt-agent-actions.client.tsx"), "utf8"),
    readFileSync(join(clientRoot, "studio", "boilerplate-picker.client.tsx"), "utf8"),
  ];

  assert.match(dialog, /backgroundColor: theme\.colors\.surface0/);
  assert.match(dialog, /borderColor: palette\.borderStrong/);
  assert.match(dialog, /fontSize: font\.title/);
  assert.match(dialog, /fontWeight: "500"/);
  assert.match(dialog, /label="×"/);
  for (const source of dialogSources) {
    assert.match(source, /<NativeDialog/);
    assert.doesNotMatch(source, /<Modal/);
    assert.doesNotMatch(source, /accessibilityViewIsModal/);
  }
});

test("the corner settings menu owns language, descriptions, and history limits", () => {
  const headerSource = readFileSync(join(clientRoot, "studio", "studio-header.client.tsx"), "utf8");
  const uiSource = readFileSync(uiPath, "utf8");

  assert.match(headerSource, /accessibilityLabel=\{t\("settings\.open"\)\}/);
  assert.match(headerSource, /<NativeDialog/);
  assert.match(headerSource, /<SegmentedControl/);
  assert.match(headerSource, /<Switch/);
  assert.match(headerSource, /onValueChange=\{setShowDescriptions\}/);
  assert.match(headerSource, /setSnapshotLimit/);
  assert.match(headerSource, /setCheckpointLimit/);
  assert.match(headerSource, /onValueChange=\{setStarredCheckpointsCountTowardLimit\}/);
  assert.match(headerSource, /<ScrollView/);
  assert.match(headerSource, /<GenerationSettingsSection/);
  assert.match(uiSource, /export function Description/);
  assert.match(uiSource, /showDescriptions \? <Hint theme=\{theme\}>\{children\}<\/Hint> : null/);
});

test("prompt agent actions keep agent replies behind server reconciliation", () => {
  const actionSource = readFileSync(join(clientRoot, "studio", "prompt-agent-actions.client.tsx"), "utf8");
  const boilerplatePickerSource = readFileSync(
    join(clientRoot, "studio", "boilerplate-picker.client.tsx"),
    "utf8",
  );
  const boilerplatePreferencesSource = readFileSync(
    join(clientRoot, "studio", "boilerplate-preferences.client.ts"),
    "utf8",
  );
  const contextControlsSource = readFileSync(
    join(clientRoot, "studio", "generation-context-controls.client.tsx"),
    "utf8",
  );
  const draftListSource = readFileSync(join(clientRoot, "studio", "draft-list-pane.client.tsx"), "utf8");
  const settingsSource = readFileSync(join(clientRoot, "studio", "generation-settings.client.tsx"), "utf8");
  const studioSource = readFileSync(join(clientRoot, "studio.client.tsx"), "utf8");
  const i18nSource = readFileSync(join(clientRoot, "i18n.client.ts"), "utf8");

  assert.match(actionSource, /generationPreviewRpc/);
  assert.match(actionSource, /generationStartRpc/);
  assert.match(actionSource, /waitForFinish\(AGENT_WAIT_TIMEOUT_MS\)/);
  assert.match(actionSource, /generationSyncRpc/);
  assert.match(actionSource, /generationApplyCandidateRpc/);
  assert.match(actionSource, /generationDiscardRpc/);
  assert.match(actionSource, /generation\.baseVersion/);
  assert.match(actionSource, /job\.status === "prepared"/);
  assert.doesNotMatch(actionSource, /responseMarkdown:\s*/);
  assert.match(actionSource, /allowProjectRead/);
  assert.doesNotMatch(actionSource, /generation\.security\.warning/);
  assert.doesNotMatch(actionSource, /protection\.warning/);
  assert.doesNotMatch(i18nSource, /这是纵深防护|defense in depth/);
  assert.match(actionSource, /<NativeDialog/);
  assert.match(actionSource, /accessibilityRole="switch"/);
  assert.equal(actionSource.match(/<GenerationContextSourceCard/g)?.length, 3);
  assert.match(actionSource, /filters\.targetCheckpoints\.timeRange/);
  assert.match(actionSource, /filters\.projectPrompts\.timeRange/);
  assert.match(actionSource, /filters\.tagPrompts\.timeRange/);
  assert.doesNotMatch(actionSource, /filters\.(?:includeHistory|crossProject|timeRange)/);
  assert.match(actionSource, /settingsQuery\.data\?\.settings\.contextTimeRangeDays/);
  assert.match(actionSource, /generation\.time\.days/);
  assert.doesNotMatch(actionSource, /generation\.time\.(?:30|90)/);
  assert.match(contextControlsSource, /accessibilityRole="checkbox"/);
  assert.match(contextControlsSource, /accessibilityRole="adjustable"/);
  assert.match(contextControlsSource, /onResponderMove=\{selectAt\}/);
  assert.match(actionSource, /contentContainerStyle=\{\{ gap: 14, paddingBottom: 2, paddingRight:/);
  assert.match(actionSource, /tagPaths: \[\.\.\.detail\.summary\.tags\]/);
  assert.match(actionSource, /task: "format", contextFilters: null, projectRead: false/);
  assert.doesNotMatch(actionSource, /contentOrigin|editor\.generated/);
  assert.doesNotMatch(draftListSource, /contentOrigin|editor\.generated/);
  assert.doesNotMatch(i18nSource, /"editor\.generated"/);
  assert.match(actionSource, /borderTopColor: palette\.border/);
  assert.doesNotMatch(actionSource, /backgroundColor: palette\.raised/);
  assert.ok(
    actionSource.indexOf("<BoilerplatePicker") < actionSource.indexOf('label={startMutation.isPending'),
    "the boilerplate action must be the leftmost prompt action",
  );
  assert.match(boilerplatePickerSource, /replaceBoilerplates/);
  assert.match(boilerplatePickerSource, /onInsert\(boilerplate\)/);
  assert.match(boilerplatePickerSource, /<NativeDialog/);
  assert.match(boilerplatePickerSource, /showsVerticalScrollIndicator/);
  assert.match(boilerplatePickerSource, /persistentScrollbar/);
  assert.match(boilerplatePickerSource, /maxHeight: compact \? 300 : 420/);
  assert.match(boilerplatePreferencesSource, /prompt-studio\.boilerplates\.v1/);
  assert.match(studioSource, /onAppendBoilerplate=\{appendSavedBoilerplate\}/);
  assert.ok(
    studioSource.indexOf('accessibilityLabel={t("editor.markdown.placeholder")}')
      < studioSource.indexOf("<PromptAgentActions"),
    "prompt optimization actions must render below the Markdown editor",
  );
  assert.match(i18nSource, /"generation\.related\.action": "Prompt 优化"/);
  assert.match(i18nSource, /"generation\.format\.action": "快速优化"/);
  assert.match(settingsSource, /generationSettingsUpdateRpc/);
  assert.match(settingsSource, /<TimeRangeSettingsEditor/);
  assert.match(settingsSource, /contextTimeRangeDays/);
  assert.match(settingsSource, /keyboardType="number-pad"/);
  assert.match(settingsSource, /task="related"/);
  assert.match(settingsSource, /task="format"/);
  assert.match(settingsSource, /useQuery\(/);
  assert.match(settingsSource, /useMutation\(/);
  assert.doesNotMatch(settingsSource, /localStorage/);
  assert.match(actionSource, /previewQuery\.data \? \([^]*<ProtectionNotice/);
  assert.doesNotMatch(actionSource, /allowProjectRead && previewQuery\.data/);
  assert.match(actionSource, /<ProtectionNotice protection=\{job\.protection\}/);
  assert.match(
    actionSource,
    /\{previewQuery\.data \? \([^]*<ProtectionNotice protection=\{previewQuery\.data\.preview\.protection\}/,
  );
});

test("the Command Center exposes one persistent Scratchpad without Quick Draft simulations", () => {
  const indexSource = readFileSync(join(repositoryRoot, "index.ts"), "utf8");

  assert.equal(indexSource.match(/title: "Open Prompt Scratchpad"/g)?.length ?? 0, 1);
  assert.doesNotMatch(indexSource, /id: "open-prompt-scratchpad-agent"/);
  assert.doesNotMatch(indexSource, /quick-project-draft|QuickPrompt|requestQuickPrompt/);
});

test("checkpoint rows provide a dedicated star action and use the configured selectors", () => {
  const studioSource = readFileSync(join(clientRoot, "studio.client.tsx"), "utf8");
  assert.match(studioSource, /selectRecentSnapshots\(detail\.snapshots, snapshotLimit\)/);
  assert.match(studioSource, /selectVisibleCheckpoints\(/);
  assert.match(studioSource, /toggleCheckpointStar\(draftId, checkpoint\.id\)/);
  assert.match(studioSource, /editor\.checkpoint\.unstar/);
});

test("draft lifecycle UI has no draft-level star state", () => {
  const studioSource = readFileSync(join(clientRoot, "studio.client.tsx"), "utf8");
  const listSource = readFileSync(join(clientRoot, "studio", "draft-list-pane.client.tsx"), "utf8");
  assert.doesNotMatch(studioSource, /editor\.status\.starred/);
  assert.doesNotMatch(listSource, /filter\.starred|status === "starred"/);
});

test("new Agent send targets choose a Project before an expanded Workspace", () => {
  const sendSource = readFileSync(join(clientRoot, "studio", "send-panel.client.tsx"), "utf8");
  const pickerSource = readFileSync(join(clientRoot, "studio", "project-workspace-picker.client.tsx"), "utf8");

  assert.match(sendSource, /<ProjectWorkspacePicker/);
  assert.doesNotMatch(sendSource, /sourceWorkspaces\.slice/);
  assert.match(pickerSource, /groups\.map/);
  assert.match(pickerSource, /group\.workspaces\.map/);
  assert.match(pickerSource, /accessibilityState=\{\{ expanded, selected: selectedProject \}\}/);
  assert.match(pickerSource, /color: expanded \? theme\.colors\.foreground : theme\.colors\.foregroundMuted/);
  assert.match(pickerSource, /\{expanded \? \(\s*<Text[^]*send\.project\.workspaceCount/);
});

test("screens do not reintroduce numeric corner radii or hard-coded colors", () => {
  const violations: string[] = [];
  for (const path of clientScreens(clientRoot)) {
    const source = readFileSync(path, "utf8");
    if (/borderRadius:\s*\d/.test(source)) violations.push(`${path}: numeric borderRadius`);
    if (/(?:backgroundColor|borderColor|color):\s*["'](?:#|rgba?\(|hsla?\()/i.test(source)) {
      violations.push(`${path}: hard-coded color`);
    }
  }
  assert.deepEqual(violations, []);
});
