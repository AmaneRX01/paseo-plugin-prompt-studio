import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginClientContext, PluginWorkspacePanelContribution } from "@getpaseo/plugin/client";
import type { ShortcutVisibilitySource } from "./preferences/shortcut-visibility";

export function registerNavigationShortcuts(
  client: PluginClientContext,
  visibility: ShortcutVisibilitySource,
  explorer: PluginWorkspacePanelContribution,
): PluginCleanup {
  let sidebar: PluginCleanup[] = [];
  let removeExplorer: PluginCleanup | null = null;
  let disposed = false;
  function sync(): void {
    if (disposed) return;
    const settings = visibility.getSnapshot();
    if (settings.showSidebarShortcuts && !sidebar.length) {
      sidebar = [
        client.addSidebarItem({ id: "prompt-studio", title: "Prompt Studio", icon: "BookOpen", surface: "prompt-studio" }),
        client.addSidebarItem({ id: "worklog", title: "Worklog", icon: "FileText", surface: "worklog" }),
      ];
    } else if (!settings.showSidebarShortcuts && sidebar.length) {
      for (const remove of sidebar) void remove();
      sidebar = [];
    }
    if (settings.showExplorerShortcut && !removeExplorer) removeExplorer = client.addWorkspacePanel(explorer);
    else if (!settings.showExplorerShortcut && removeExplorer) {
      void removeExplorer();
      removeExplorer = null;
    }
  }
  const unsubscribe = visibility.subscribe(sync);
  sync();
  return async () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    await Promise.all([...sidebar, ...(removeExplorer ? [removeExplorer] : [])].map((remove) => remove()));
    sidebar = [];
    removeExplorer = null;
  };
}
