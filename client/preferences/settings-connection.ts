import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { QueryClient } from "@tanstack/react-query";
import { preferencesSettings, preferencesSettingsSchema } from "../../shared/preferences-settings";
import { hostPreferences } from "./host-preferences";
import type { ShortcutVisibilitySource } from "./shortcut-visibility";

const hidden = {
  showSidebarShortcuts: false, showComposerShortcut: false,
  showHeaderShortcut: false, showExplorerShortcut: false,
};

export const shortcutVisibility: ShortcutVisibilitySource = {
  getSnapshot: () => {
    const state = hostPreferences.getSnapshot();
    return state.revision ? state.values : hidden;
  },
  subscribe: hostPreferences.subscribe,
};

/** Load preferences even when no plugin surface is mounted. */
export function connectHostPreferences(client: PluginClientContext): () => void {
  const contract = settingsRpc(preferencesSettings.id);
  const queries = new QueryClient();
  let disposed = false;
  let reading = false;
  const save = async (values: ReturnType<typeof preferencesSettingsSchema.parse>, revision: string) => {
    const result = await client.rpc(contract.write, { values, revision });
    if (result.status !== "saved") throw new Error(result.error);
    return { values: preferencesSettingsSchema.parse(result.values), revision: result.revision };
  };
  async function reload(): Promise<void> {
    if (disposed || reading || hostPreferences.getSnapshot().saving) return;
    reading = true;
    const before = hostPreferences.getSnapshot();
    try {
      const result = await queries.fetchQuery({
        queryKey: ["preferences"], queryFn: () => client.rpc(contract.read, {}),
        staleTime: 0, retry: false,
      });
      if (disposed || before !== hostPreferences.getSnapshot()) return;
      hostPreferences.sync(result.status === "ready" ? {
        status: "ready", fresh: true, values: preferencesSettingsSchema.parse(result.values),
        revision: result.revision, save, reload,
      } : { status: "invalid", error: result.error, revision: result.revision, save, reload });
    } catch (error) {
      if (!disposed && before === hostPreferences.getSnapshot()) hostPreferences.sync({
        status: "error", error: error instanceof Error ? error.message : String(error), save, reload,
      });
    } finally {
      reading = false;
    }
  }
  void reload();
  // useSettings pushes updates while a component is mounted. This read keeps
  // contribution visibility current on clients with no plugin UI open.
  const timer = setInterval(() => void reload(), 15_000);
  return () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    queries.clear();
  };
}
