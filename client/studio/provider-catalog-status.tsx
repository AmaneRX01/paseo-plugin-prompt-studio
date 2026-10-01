import type { PluginTheme } from "@getpaseo/plugin";
import { View } from "react-native";
import { useI18n } from "../i18n";
import { Hint, NativeButton, Skeleton } from "../ui";
import { errorMessage } from "./studio-formatters";
import type { useProviderCatalog } from "./use-provider-catalog";

export function ProviderCatalogStatus({
  catalog, enabled, theme,
}: {
  catalog: ReturnType<typeof useProviderCatalog>;
  enabled: boolean;
  theme: PluginTheme;
}) {
  const { t } = useI18n();
  return (
    <View style={{ gap: 8 }}>
      {!enabled ? <Hint theme={theme}>{t("providers.chooseProject")}</Hint> : null}
      {catalog.isLoading ? <Skeleton height={28} theme={theme} /> : null}
      {enabled && catalog.discovering ? <Hint theme={theme}>{t("providers.loading")}</Hint> : null}
      {catalog.error ? <Hint danger theme={theme}>{errorMessage(catalog.error)}</Hint> : null}
      {catalog.failures.map((entry) => (
        <Hint danger key={entry.provider} theme={theme}>
          {t("providers.failed", { provider: entry.label || entry.provider, reason: entry.error || t("providers.unavailable") })}
        </Hint>
      ))}
      {enabled && catalog.isSuccess && !catalog.discovering && !catalog.entries.length ? (
        <Hint danger theme={theme}>{t("settings.generation.noProviders")}</Hint>
      ) : null}
      <NativeButton
        disabled={!enabled || catalog.isRefreshing || catalog.isFetching}
        label={catalog.isRefreshing ? t("providers.refreshing") : t("providers.refresh")}
        onPress={catalog.refresh}
        small
        theme={theme}
        variant="outline"
      />
    </View>
  );
}
