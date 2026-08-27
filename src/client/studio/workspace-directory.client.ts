import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePaseo } from "@getpaseo/plugin";
import { useEffect } from "react";
import {
  applyWorkspaceDirectoryUpdate,
  fetchWorkspaceDirectory,
  normalizeWorkspaceDirectoryUpdate,
  type WorkspaceDirectorySnapshot,
  type WorkspaceDirectoryUpdate,
} from "./workspace-directory-state.client";

export const WORKSPACE_DIRECTORY_QUERY_KEY = ["prompt-studio", "paseo-workspace-directory"] as const;

interface WorkspaceSubscriptionState {
  references: number;
  pendingUpdates: WorkspaceDirectoryUpdate[];
  unsubscribe: () => void;
}

const workspaceSubscriptions = new WeakMap<object, WeakMap<object, WorkspaceSubscriptionState>>();

function subscriptionState(queryClient: object, paseo: object): WorkspaceSubscriptionState | null {
  return workspaceSubscriptions.get(queryClient)?.get(paseo) ?? null;
}

export function useWorkspaceDirectory() {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: WORKSPACE_DIRECTORY_QUERY_KEY,
    queryFn: () => fetchWorkspaceDirectory(
      (options) => paseo.workspaces.list(options),
      queryClient.getQueryData<WorkspaceDirectorySnapshot>(WORKSPACE_DIRECTORY_QUERY_KEY)?.subscriptionId,
    ),
    staleTime: 60_000,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: 60_000,
  });

  useEffect(() => {
    let byPaseo = workspaceSubscriptions.get(queryClient);
    if (!byPaseo) {
      byPaseo = new WeakMap();
      workspaceSubscriptions.set(queryClient, byPaseo);
    }
    let state = byPaseo.get(paseo);
    if (!state) {
      const next: WorkspaceSubscriptionState = {
        references: 0,
        pendingUpdates: [],
        unsubscribe: () => {},
      };
      next.unsubscribe = paseo.workspaces.subscribe((value) => {
        const update = normalizeWorkspaceDirectoryUpdate(value);
        if (!update) return;
        let applied = false;
        queryClient.setQueryData<WorkspaceDirectorySnapshot>(WORKSPACE_DIRECTORY_QUERY_KEY, (current) => {
          if (!current) return current;
          applied = true;
          return applyWorkspaceDirectoryUpdate(current, update);
        });
        if (!applied) next.pendingUpdates.push(update);
      });
      state = next;
      byPaseo.set(paseo, state);
    }
    state.references += 1;
    return () => {
      if (!state) return;
      state.references -= 1;
      if (state.references > 0) return;
      state.unsubscribe();
      byPaseo?.delete(paseo);
    };
  }, [paseo, queryClient]);

  useEffect(() => {
    const state = subscriptionState(queryClient, paseo);
    if (!query.data || !state || state.pendingUpdates.length === 0) return;
    const pending = state.pendingUpdates;
    state.pendingUpdates = [];
    queryClient.setQueryData<WorkspaceDirectorySnapshot>(WORKSPACE_DIRECTORY_QUERY_KEY, (current) => (
      current ? pending.reduce(applyWorkspaceDirectoryUpdate, current) : current
    ));
  }, [paseo, query.data, queryClient]);

  return query;
}
