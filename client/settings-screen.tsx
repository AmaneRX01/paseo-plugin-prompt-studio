import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { View } from "react-native";
import { catalogScanRpc } from "../shared/contracts";
import { GenerationSettingsSection } from "./studio/generation-settings";
import { ProjectMigrationSection } from "./studio/project-migration";
import { ConfirmInline, NativeTextInput, SegmentedControl, SkeletonRows } from "./ui";
import { useEffect, useRef, useState } from "react";
import { preferencesSettingsSchema, type PreferencesSettings } from "../shared/preferences-settings";
import { useI18n } from "./i18n";
import {
  useHostPreferences,
  type HostPreferencesSnapshot,
} from "./preferences/host-preferences";

type BoilerplateField = { id: number; text: string };

function clonePreferences(values: PreferencesSettings): PreferencesSettings {
  return preferencesSettingsSchema.parse({
    ...values,
    boilerplates: [...values.boilerplates],
    checkpointStarsByDraft: Object.fromEntries(
      Object.entries(values.checkpointStarsByDraft).map(([draftId, checkpointIds]) => [draftId, [...checkpointIds]]),
    ),
    projectChoices: [...values.projectChoices],
  });
}

function fieldsFor(values: PreferencesSettings, nextId: { current: number }): BoilerplateField[] {
  return values.boilerplates.map((text) => ({ id: nextId.current++, text }));
}

function hostError(settings: HostPreferencesSnapshot, fallback: string): string | null {
  return settings.error
    ?? settings.saveError
    ?? (settings.status === "error" || settings.status === "invalid" ? fallback : null);
}

function PreferencesSettingsPanel({ theme, layout }: PluginSurfaceProps) {
  const { t } = useI18n();
  const settings = useHostPreferences();
  const nextFieldId = useRef(1);
  const [draft, setDraft] = useState<PreferencesSettings | null>(null);
  const [draftRevision, setDraftRevision] = useState<string | null>(null);
  const [fields, setFields] = useState<BoilerplateField[]>([]);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (settings.status !== "ready" || !settings.revision || dirty) return;
    const values = clonePreferences(settings.values);
    setDraft(values);
    setDraftRevision(settings.revision);
    setFields(fieldsFor(values, nextFieldId));
    setDirty(false);
  }, [dirty, draftRevision, settings.revision, settings.status, settings.values]);

  function updateDraft(patch: Partial<PreferencesSettings>): void {
    if (!draftRevision || settings.saving) return;
    setDraft((current) => current ? { ...current, ...patch } : current);
    setDirty(true);
    setNotice(null);
  }

  function updateField(id: number, text: string): void {
    setFields((current) => current.map((field) => field.id === id ? { ...field, text } : field));
    setDirty(true);
    setNotice(null);
  }

  function removeField(id: number): void {
    setFields((current) => current.filter((field) => field.id !== id));
    setDirty(true);
    setNotice(null);
  }

  function addField(): void {
    setFields((current) => [...current, { id: nextFieldId.current++, text: "" }]);
    setDirty(true);
    setNotice(null);
  }

  async function saveDraft(): Promise<void> {
    if (!draft || !draftRevision) return;
    const parsed = preferencesSettingsSchema.safeParse({
      ...draft,
      boilerplates: fields.map((field) => field.text),
    });
    if (!parsed.success) {
      setNotice(t("settings.preferences.invalidBoilerplates"));
      return;
    }
    const next = parsed.data;
    setDraft(next);
    const saved = await settings.save(next, draftRevision);
    if (saved) {
      setDirty(false);
      setNotice(t("settings.preferences.saved"));
    } else {
      setNotice(t("settings.preferences.conflict"));
    }
  }

  async function retrySave(): Promise<void> {
    const saved = await settings.retry();
    if (saved) {
      setDirty(false);
      setNotice(t("settings.preferences.saved"));
    } else {
      setNotice(t("settings.preferences.conflict"));
    }
  }

  async function reloadPreferences(): Promise<void> {
    await settings.reload();
    setDirty(false);
  }

  const error = hostError(settings, t("settings.preferences.error"));
  if (settings.status === "loading" && !draft) {
    return (
      <SettingsGroup title={t("settings.preferences.title")}>
        <SkeletonRows rows={3} theme={theme} />
      </SettingsGroup>
    );
  }
  if (!draft || !draftRevision) {
    return (
      <SettingsGroup title={t("settings.preferences.title")} info={error ?? t("settings.preferences.error")}>
        <SettingsAction
          actionLabel={t("settings.preferences.reload")}
          disabled={settings.saving}
          label={t("settings.preferences.title")}
          onPress={() => void settings.reload()}
        />
      </SettingsGroup>
    );
  }

  const limitOptions = [3, 5, 10, 20].map((value) => ({ value: String(value), label: String(value) }));
  return (
    <SettingsGroup title={t("settings.preferences.title")} info={t("settings.preferences.help")}>
      <SettingsCard>
        {([
          ["showSidebarShortcuts", "settings.shortcuts.sidebar"],
          ["showComposerShortcut", "settings.shortcuts.composer"],
          ["showHeaderShortcut", "settings.shortcuts.header"],
          ["showExplorerShortcut", "settings.shortcuts.explorer"],
        ] as const).map(([key, label]) => (
          <SettingsSwitch key={key} label={t(label)} value={draft[key]}
            onValueChange={(value) => updateDraft({ [key]: value })} disabled={settings.saving} />
        ))}
      </SettingsCard>
      <SettingsCard>
        <SettingsSelect
          disabled={settings.saving}
          label={t("language.label")}
          value={draft.language}
          options={[
            { value: "en", label: t("language.en") },
            { value: "zh", label: t("language.zh") },
          ]}
          onValueChange={(language) => updateDraft({ language: language as PreferencesSettings["language"] })}
        />
        <SettingsSwitch
          disabled={settings.saving}
          label={t("settings.descriptions.label")}
          hint={t("settings.descriptions.help")}
          value={draft.showDescriptions}
          onValueChange={(showDescriptions) => updateDraft({ showDescriptions })}
        />
      </SettingsCard>

      <SettingsCard>
        <SettingsSelect
          disabled={settings.saving}
          label={t("settings.history.snapshots")}
          value={String(draft.snapshotLimit)}
          options={limitOptions}
          onValueChange={(value) => updateDraft({ snapshotLimit: Number(value) as PreferencesSettings["snapshotLimit"] })}
        />
        <SettingsSelect
          disabled={settings.saving}
          label={t("settings.history.checkpoints")}
          value={String(draft.checkpointLimit)}
          options={limitOptions}
          onValueChange={(value) => updateDraft({ checkpointLimit: Number(value) as PreferencesSettings["checkpointLimit"] })}
        />
        <SettingsSwitch
          disabled={settings.saving}
          label={t("settings.history.starredCount.label")}
          hint={t("settings.history.starredCount.help")}
          value={draft.starredCheckpointsCountTowardLimit}
          onValueChange={(starredCheckpointsCountTowardLimit) => updateDraft({ starredCheckpointsCountTowardLimit })}
        />
      </SettingsCard>

      <SettingsCard>
        {fields.map((field) => (
          <SettingsRow
            key={`${draftRevision}:${field.id}`}
            label={t("settings.preferences.boilerplateItem", { number: field.id })}
          >
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
              <NativeTextInput
                accessibilityLabel={t("settings.preferences.boilerplateItem", { number: field.id })}
                editable={!settings.saving}
                value={field.text}
                onChangeText={(text) => updateField(field.id, text)}
                placeholder={t("settings.preferences.boilerplatePlaceholder")}
                theme={theme}
                multiline
                small
                style={{ width: layout.compact ? 240 : 340, maxWidth: "100%", flexShrink: 1 }}
              />
              <ConfirmInline
                accessibilityLabel={t("boilerplate.deleteItem", { number: field.id })}
                cancelLabel={t("common.cancel")}
                confirmBody={t("boilerplate.deleteConfirmBody")}
                confirmLabel={t("settings.preferences.removeBoilerplate")}
                confirmTitle={t("boilerplate.deleteConfirmTitle")}
                disabled={settings.saving}
                label={t("settings.preferences.removeBoilerplate")}
                onConfirm={() => removeField(field.id)}
                theme={theme}
              />
            </View>
          </SettingsRow>
        ))}
      </SettingsCard>
      <SettingsCard>
        <SettingsAction
          actionLabel={t("settings.preferences.addBoilerplate")}
          label={t("settings.preferences.boilerplates")}
          onPress={addField}
          disabled={fields.length >= 100 || settings.saving}
        />
        <SettingsAction
          actionLabel={settings.saving ? t("settings.preferences.saving") : t("settings.preferences.save")}
          disabled={settings.saving || !dirty}
          label={t("settings.preferences.title")}
          onPress={() => void saveDraft()}
        />
      </SettingsCard>

      {error || (dirty && draftRevision !== settings.revision) ? (
        <SettingsCard>
          <SettingsAction
            actionLabel={t("settings.preferences.retry")}
            disabled={settings.saving}
            label={error ?? t("settings.preferences.conflict")}
            onPress={() => void retrySave()}
          />
          <SettingsAction
            actionLabel={t("settings.preferences.reload")}
            disabled={settings.saving}
            label={t("settings.preferences.reload")}
            onPress={() => void reloadPreferences()}
          />
        </SettingsCard>
      ) : null}
      {notice ? (
        <SettingsRow label={t("settings.preferences.status")} hint={notice} error={error} />
      ) : null}
    </SettingsGroup>
  );
}

function MigrationSettingsPanel({ theme, layout }: PluginSurfaceProps) {
  const { t } = useI18n();
  const scanCatalog = useRpc(catalogScanRpc);
  const catalog = useQuery({
    queryKey: ["prompt-studio", "settings-vault"],
    queryFn: () => scanCatalog({}),
    staleTime: 60_000,
  });
  if (!catalog.data) return (
    <SettingsGroup title={t("settings.tab.migration")}>
      <SettingsRow label={t("settings.migration.loading")}
        error={catalog.error?.message} />
      {catalog.isError ? <SettingsAction label={t("settings.tab.migration")}
        actionLabel={t("settings.preferences.retry")} onPress={() => void catalog.refetch()} /> : null}
    </SettingsGroup>
  );
  return <ProjectMigrationSection compact={layout.compact} theme={theme}
    vaultRootPath={catalog.data.rootPath} visible />;
}

export function PromptStudioSettingsScreen(props: PluginSurfaceProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState("general");
  return (
    <View style={{ gap: props.layout.compact ? 12 : 16 }}>
      <SegmentedControl
        onSelect={setTab}
        options={[
          { id: "general", label: t("settings.tab.general") },
          { id: "generation", label: t("settings.tab.generation") },
          { id: "migration", label: t("settings.tab.migration") },
        ]}
        selectedId={tab}
        small
        theme={props.theme}
      />
      <View style={{ display: tab === "general" ? "flex" : "none" }}>
        <PreferencesSettingsPanel {...props} />
      </View>
      {tab === "generation" ? <GenerationSettingsSection compact={props.layout.compact}
        theme={props.theme} visible /> : null}
      {tab === "migration" ? <MigrationSettingsPanel {...props} /> : null}
    </View>
  );
}
