import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type PluginTheme, usePaseo, useRpc } from "@getpaseo/plugin";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import {
  generationTimeRangeDaysSchema,
  generationSettingsGetRpc,
  generationSettingsUpdateRpc,
  type GenerationSettings,
  type GenerationProviderConfig,
  type GenerationTask,
  type GenerationTimeRangeDays,
} from "../../shared/generation.shared";
import { useI18n } from "../i18n.client";
import {
  Card,
  FieldLabel,
  Hint,
  NativeButton,
  NativeTextInput,
  SectionTitle,
  SegmentedControl,
  font,
} from "../ui.client";
import { errorMessage } from "./studio-formatters.client";

const SETTINGS_QUERY_KEY = ["prompt-studio", "generation-settings"] as const;
const PROVIDERS_STALE_TIME_MS = 30_000;
const DEFAULT_THINKING_ID = "__model_default__";

interface ThinkingOption {
  id: string;
  label: string;
  isDefault: boolean;
}

interface ModelOption {
  id: string;
  label: string;
  isDefault: boolean;
  defaultThinkingOptionId: string | null;
  thinkingOptions: ThinkingOption[];
}

interface ProviderOption {
  id: string;
  label: string;
  models: ModelOption[];
}

interface EditableSettings {
  version: number;
  related: GenerationProviderConfig | null;
  format: GenerationProviderConfig | null;
  contextTimeRangeDays: [string, string, string];
}

const TIME_RANGE_INPUT_INDICES = [0, 1, 2] as const;

function editableSettings(settings: GenerationSettings): EditableSettings {
  return {
    version: settings.version,
    related: settings.related,
    format: settings.format,
    contextTimeRangeDays: settings.contextTimeRangeDays.map(String) as [string, string, string],
  };
}

function parsedTimeRangeDays(values: EditableSettings["contextTimeRangeDays"]): GenerationTimeRangeDays | null {
  if (values.some((value) => !/^\d+$/.test(value))) return null;
  const parsed = generationTimeRangeDaysSchema.safeParse(values.map(Number));
  return parsed.success ? parsed.data : null;
}

function defaultModel(provider: ProviderOption): ModelOption | null {
  return provider.models.find((model) => model.isDefault) ?? provider.models[0] ?? null;
}

function defaultThinking(model: ModelOption): string | null {
  return model.defaultThinkingOptionId
    ?? model.thinkingOptions.find((option) => option.isDefault)?.id
    ?? null;
}

function ProviderTaskEditor({
  task,
  config,
  providers,
  theme,
  onChange,
}: {
  task: GenerationTask;
  config: GenerationProviderConfig | null;
  providers: ProviderOption[];
  theme: PluginTheme;
  onChange: (config: GenerationProviderConfig | null) => void;
}) {
  const { t } = useI18n();
  const provider = providers.find((entry) => entry.id === config?.provider) ?? null;
  const model = provider?.models.find((entry) => entry.id === config?.model) ?? null;
  const providerInvalid = Boolean(config && !provider);
  const modelInvalid = Boolean(config && provider && !model);
  const thinkingOptions = model?.thinkingOptions ?? [];
  const thinkingInvalid = Boolean(
    config?.thinkingOptionId
    && model
    && !thinkingOptions.some((option) => option.id === config.thinkingOptionId),
  );

  return (
    <Card theme={theme}>
      <Text style={{ color: theme.colors.foreground, fontSize: font.body, fontWeight: "500" }}>
        {t(task === "related" ? "settings.generation.related" : "settings.generation.format")}
      </Text>
      <View style={{ gap: 6 }}>
        <FieldLabel theme={theme}>{t("settings.generation.provider")}</FieldLabel>
        <SegmentedControl
          onSelect={(providerId) => {
            const nextProvider = providers.find((entry) => entry.id === providerId);
            const nextModel = nextProvider ? defaultModel(nextProvider) : null;
            onChange(nextProvider && nextModel
              ? {
                  provider: nextProvider.id,
                  model: nextModel.id,
                  thinkingOptionId: defaultThinking(nextModel),
                }
              : null);
          }}
          options={providers.map((entry) => ({ id: entry.id, label: entry.label }))}
          selectedId={config?.provider ?? null}
          small
          theme={theme}
        />
      </View>
      {provider ? (
        <View style={{ gap: 6 }}>
          <FieldLabel theme={theme}>{t("settings.generation.model")}</FieldLabel>
          <SegmentedControl
            onSelect={(modelId) => {
              const nextModel = provider.models.find((entry) => entry.id === modelId);
              if (!nextModel) return;
              onChange({
                provider: provider.id,
                model: nextModel.id,
                thinkingOptionId: defaultThinking(nextModel),
              });
            }}
            options={provider.models.map((entry) => ({ id: entry.id, label: entry.label }))}
            selectedId={config?.model ?? null}
            small
            theme={theme}
          />
        </View>
      ) : null}
      {model ? (
        <View style={{ gap: 6 }}>
          <FieldLabel theme={theme}>{t("settings.generation.thinking")}</FieldLabel>
          <SegmentedControl
            onSelect={(thinkingOptionId) => onChange({
              provider: provider!.id,
              model: model.id,
              thinkingOptionId: thinkingOptionId === DEFAULT_THINKING_ID ? null : thinkingOptionId,
            })}
            options={[
              { id: DEFAULT_THINKING_ID, label: t("settings.generation.defaultThinking") },
              ...thinkingOptions.map((entry) => ({ id: entry.id, label: entry.label })),
            ]}
            selectedId={config?.thinkingOptionId ?? DEFAULT_THINKING_ID}
            small
            theme={theme}
          />
        </View>
      ) : null}
      {providerInvalid || modelInvalid || thinkingInvalid ? (
        <Hint danger theme={theme}>
          {t("settings.generation.invalid", {
            value: providerInvalid
              ? config?.provider ?? ""
              : modelInvalid
                ? config?.model ?? ""
                : config?.thinkingOptionId ?? "",
          })}
        </Hint>
      ) : null}
    </Card>
  );
}

function TimeRangeSettingsEditor({
  values,
  valid,
  theme,
  onChange,
}: {
  values: EditableSettings["contextTimeRangeDays"];
  valid: boolean;
  theme: PluginTheme;
  onChange: (values: EditableSettings["contextTimeRangeDays"]) => void;
}) {
  const { t } = useI18n();
  return (
    <Card theme={theme}>
      <Text style={{ color: theme.colors.foreground, fontSize: font.body, fontWeight: "500" }}>
        {t("settings.generation.timeRanges.title")}
      </Text>
      <Hint theme={theme}>{t("settings.generation.timeRanges.help")}</Hint>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {TIME_RANGE_INPUT_INDICES.map((index) => (
          <View
            key={index}
            style={{ flexBasis: 64, flexGrow: 1, gap: 4 }}
          >
            <FieldLabel theme={theme}>
              {t("settings.generation.timeRanges.option", { number: index + 1 })}
            </FieldLabel>
            <NativeTextInput
              accessibilityLabel={t("settings.generation.timeRanges.option", { number: index + 1 })}
              keyboardType="number-pad"
              onChangeText={(value) => {
                const next = [...values] as EditableSettings["contextTimeRangeDays"];
                next[index] = value.replace(/\D/g, "").slice(0, 4);
                onChange(next);
              }}
              small
              style={{ minWidth: 48, textAlign: "center" }}
              theme={theme}
              value={values[index]}
            />
          </View>
        ))}
      </View>
      {!valid ? <Hint danger theme={theme}>{t("settings.generation.timeRanges.invalid")}</Hint> : null}
    </Card>
  );
}

export function GenerationSettingsSection({
  compact,
  theme,
  visible,
}: {
  compact: boolean;
  theme: PluginTheme;
  visible: boolean;
}) {
  const { t } = useI18n();
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const getSettings = useRpc(generationSettingsGetRpc);
  const updateSettings = useRpc(generationSettingsUpdateRpc);
  const [editable, setEditable] = useState<EditableSettings | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const initializedVersion = useRef<number | null>(null);

  const settingsQuery = useQuery({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: () => getSettings({}),
    enabled: visible,
    staleTime: 30_000,
    refetchInterval: false,
  });
  const providersQuery = useQuery({
    queryKey: ["prompt-studio", "generation-providers"],
    queryFn: () => paseo.providers.waitForReady({ timeoutMs: 20_000 }),
    enabled: visible,
    staleTime: PROVIDERS_STALE_TIME_MS,
    refetchInterval: false,
  });

  const providers = useMemo<ProviderOption[]>(() => (
    (providersQuery.data?.entries ?? [])
      .filter((entry) => entry.enabled && entry.status === "ready")
      .map((entry) => ({
        id: entry.provider,
        label: entry.label || entry.provider,
        models: (entry.models ?? [])
          .filter((model) => model.isSelectable !== false)
          .map((model) => ({
            id: model.id,
            label: model.label || model.id,
            isDefault: Boolean(model.isDefault),
            defaultThinkingOptionId: model.defaultThinkingOptionId ?? null,
            thinkingOptions: (model.thinkingOptions ?? []).map((option) => ({
              id: option.id,
              label: option.label || option.id,
              isDefault: Boolean(option.isDefault),
            })),
          })),
      }))
      .filter((entry) => entry.models.length > 0)
  ), [providersQuery.data?.entries]);

  useEffect(() => {
    const settings = settingsQuery.data?.settings;
    if (!settings || initializedVersion.current !== null) return;
    initializedVersion.current = settings.version;
    setEditable(editableSettings(settings));
  }, [settingsQuery.data?.settings]);

  const updateMutation = useMutation({
    mutationFn: (settings: EditableSettings) => {
      const contextTimeRangeDays = parsedTimeRangeDays(settings.contextTimeRangeDays);
      if (!contextTimeRangeDays) throw new Error(t("settings.generation.timeRanges.invalid"));
      return updateSettings({
        expectedVersion: settings.version,
        related: settings.related,
        format: settings.format,
        contextTimeRangeDays,
      });
    },
    onSuccess: (result) => {
      initializedVersion.current = result.settings.version;
      setEditable(editableSettings(result.settings));
      queryClient.setQueryData(SETTINGS_QUERY_KEY, result);
      setNotice(t("settings.generation.saved"));
    },
    onError: (cause) => {
      const message = errorMessage(cause);
      setNotice(/conflict|version/i.test(message) ? t("settings.generation.conflict") : message);
    },
  });

  async function reloadSettings() {
    setNotice(null);
    const result = await settingsQuery.refetch();
    if (!result.data) return;
    const settings = result.data.settings;
    initializedVersion.current = settings.version;
    setEditable(editableSettings(settings));
  }

  const validConfiguration = (config: GenerationProviderConfig | null) => {
    if (!config) return true;
    return providers.some((provider) => provider.id === config.provider
      && provider.models.some((model) => model.id === config.model
        && (config.thinkingOptionId === null
          || model.thinkingOptions.some((option) => option.id === config.thinkingOptionId))));
  };
  const validTimeRangeDays = editable ? parsedTimeRangeDays(editable.contextTimeRangeDays) !== null : false;
  const canSave = Boolean(
    editable
    && validTimeRangeDays
    && validConfiguration(editable.related)
    && validConfiguration(editable.format)
    && !updateMutation.isPending,
  );

  return (
    <View style={{ gap: compact ? 8 : 10 }}>
      <SectionTitle theme={theme}>{t("settings.generation.title")}</SectionTitle>
      <Hint theme={theme}>{t("settings.generation.help")}</Hint>
      {settingsQuery.isPending || providersQuery.isPending ? (
        <View style={{ alignItems: "center", flexDirection: "row", gap: 8 }}>
          <ActivityIndicator color={theme.colors.accent} size="small" />
          <Hint theme={theme}>{t("settings.generation.loadingProviders")}</Hint>
        </View>
      ) : null}
      {settingsQuery.isError ? <Hint danger theme={theme}>{errorMessage(settingsQuery.error)}</Hint> : null}
      {providersQuery.isError ? <Hint danger theme={theme}>{errorMessage(providersQuery.error)}</Hint> : null}
      {settingsQuery.isError ? (
        <NativeButton
          disabled={settingsQuery.isFetching}
          label={t("settings.generation.reload")}
          onPress={() => void reloadSettings()}
          small
          theme={theme}
          variant="outline"
        />
      ) : null}
      {providersQuery.isError ? (
        <NativeButton
          disabled={providersQuery.isFetching}
          label={t("settings.generation.retryProviders")}
          onPress={() => void providersQuery.refetch()}
          small
          theme={theme}
          variant="outline"
        />
      ) : null}
      {!providersQuery.isPending && !providers.length ? (
        <Hint danger theme={theme}>{t("settings.generation.noProviders")}</Hint>
      ) : null}
      {editable ? (
        <>
          <TimeRangeSettingsEditor
            onChange={(contextTimeRangeDays) => {
              setEditable((current) => current ? { ...current, contextTimeRangeDays } : current);
              setNotice(null);
            }}
            theme={theme}
            valid={validTimeRangeDays}
            values={editable.contextTimeRangeDays}
          />
          <ProviderTaskEditor
            config={editable.related}
            onChange={(related) => {
              setEditable((current) => current ? { ...current, related } : current);
              setNotice(null);
            }}
            providers={providers}
            task="related"
            theme={theme}
          />
          <ProviderTaskEditor
            config={editable.format}
            onChange={(format) => {
              setEditable((current) => current ? { ...current, format } : current);
              setNotice(null);
            }}
            providers={providers}
            task="format"
            theme={theme}
          />
          {!canSave && !updateMutation.isPending ? (
            <Hint theme={theme}>{t("settings.generation.unsaved")}</Hint>
          ) : null}
          <View style={{ alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <NativeButton
              disabled={!canSave}
              label={updateMutation.isPending ? t("settings.generation.saving") : t("settings.generation.save")}
              onPress={() => {
                if (editable) updateMutation.mutate(editable);
              }}
              small
              theme={theme}
            />
            <NativeButton
              disabled={settingsQuery.isFetching || updateMutation.isPending}
              label={t("settings.generation.reload")}
              onPress={() => void reloadSettings()}
              small
              theme={theme}
              variant="ghost"
            />
          </View>
          {notice ? <Hint danger={Boolean(updateMutation.error)} theme={theme}>{notice}</Hint> : null}
        </>
      ) : null}
    </View>
  );
}
