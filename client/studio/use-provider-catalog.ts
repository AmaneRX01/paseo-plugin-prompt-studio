import { usePaseo } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import {
  createProviderCatalogReader,
  selectableProviderEntries,
  type ProviderCatalogSnapshot,
} from "./provider-catalog";

export function useProviderCatalog({ cwd, enabled }: { cwd?: string; enabled: boolean }) {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["prompt-studio", "provider-catalog", cwd ?? ""], [cwd]);
  const reader = useMemo(() => createProviderCatalogReader(paseo.providers, cwd), [paseo, cwd]);
  const query = useQuery({
    queryKey,
    queryFn: () => reader.read(),
    enabled,
    staleTime: 30_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
    // Live updates are primary; polling also recovers missed reconnect notifications.
    refetchInterval: (state) => state.state.data?.entries.some(
      (entry) => entry.enabled && entry.status === "loading",
    ) ? 2_000 : 30_000,
  });

  useEffect(() => {
    if (!enabled) return;
    return reader.subscribe((snapshot) => {
      void queryClient.cancelQueries({ queryKey, exact: true });
      queryClient.setQueryData<ProviderCatalogSnapshot>(queryKey, snapshot);
    });
  }, [enabled, queryClient, queryKey, reader]);

  const refreshMutation = useMutation({
    mutationFn: async () => ({ snapshot: await reader.refresh(), queryKey }),
    onSuccess: ({ snapshot, queryKey: refreshedKey }) => {
      queryClient.setQueryData<ProviderCatalogSnapshot>(refreshedKey, snapshot);
    },
  });
  const entries = useMemo(() => selectableProviderEntries(query.data), [query.data]);
  return {
    ...query,
    entries,
    discovering: Boolean(query.data?.entries.some((entry) => entry.enabled && entry.status === "loading")),
    failures: (query.data?.entries ?? []).filter(
      (entry) => entry.enabled && (entry.status === "error" || entry.status === "unavailable"),
    ),
    error: refreshMutation.error ?? query.error,
    isRefreshing: refreshMutation.isPending,
    refresh: () => refreshMutation.mutate(),
  };
}
