import type { PreferencesSettings } from "../../shared/preferences-settings";

export type ShortcutVisibility = Pick<PreferencesSettings,
  "showSidebarShortcuts" | "showComposerShortcut" | "showHeaderShortcut" | "showExplorerShortcut">;

export interface ShortcutVisibilitySource {
  getSnapshot(): ShortcutVisibility;
  subscribe(listener: () => void): () => void;
}

export const DEFAULT_SHORTCUT_VISIBILITY: ShortcutVisibility = {
  showSidebarShortcuts: true, showComposerShortcut: true,
  showHeaderShortcut: true, showExplorerShortcut: true,
};

export const defaultShortcutVisibilitySource: ShortcutVisibilitySource = {
  getSnapshot: () => DEFAULT_SHORTCUT_VISIBILITY,
  subscribe: () => () => {},
};
