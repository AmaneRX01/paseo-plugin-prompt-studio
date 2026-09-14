import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { PluginCleanup } from "@getpaseo/plugin";
import { PromptStudioSurface, WorklogSurface } from "./client/main";
import {
  PromptAgentPanel,
  PromptStudioWorkspacePanel,
  PromptWorklogWorkspacePanel,
  PromptWorkspaceExplorerPanel,
  PromptWorkspacePanel,
} from "./client/panel";
import { PromptStudioSettingsScreen } from "./client/settings-screen";
import { DispatchProvenanceRenderer } from "./client/timeline/dispatch-provenance-renderer";
import { draftAttachmentsSource } from "./shared/draft-attachments";
import { registerClientActions } from "./client/client-actions";
import { connectHostPreferences, shortcutVisibility } from "./client/preferences/settings-connection";
import { registerNavigationShortcuts } from "./client/navigation-shortcuts";
import {
  DISPATCH_PROVENANCE_KIND,
  DISPATCH_PROVENANCE_VERSION,
  dispatchProvenanceDataSchema,
} from "./shared/provenance";

export default function contribute(client: PluginClientContext) {
  const cleanupActions = registerClientActions(client, shortcutVisibility);
  const cleanups: PluginCleanup[] = [cleanupActions];
  const track = (cleanup: PluginCleanup): void => {
    cleanups.push(cleanup);
  };
  track(client.addSettingsScreen({
    id: "prompt-studio",
    title: "Prompt Studio",
    icon: "BookOpen",
    Component: PromptStudioSettingsScreen,
  }));
  track(client.addTimelineRenderer({
    kind: DISPATCH_PROVENANCE_KIND,
    version: DISPATCH_PROVENANCE_VERSION,
    schema: dispatchProvenanceDataSchema,
    Component: DispatchProvenanceRenderer,
  }));
  track(client.addAttachmentSource(draftAttachmentsSource));
  // Global Studio/Worklog surfaces are safe on Paseo builds where the native
  // New Workspace → Draft Agent handoff race is fixed (creation idempotency).
  track(client.addSurface("prompt-studio", PromptStudioSurface));
  track(client.addSurface("worklog", WorklogSurface));
  track(client.addWorkspacePanel({
    id: "prompt-studio-workspace",
    title: "Prompt Studio",
    icon: "BookOpen",
    context: "workspace",
    locations: ["workspace"],
    Component: PromptStudioWorkspacePanel,
  }));
  track(client.addWorkspacePanel({
    id: "worklog-workspace",
    title: "Worklog",
    icon: "FileText",
    context: "workspace",
    locations: ["workspace"],
    Component: PromptWorklogWorkspacePanel,
  }));
  track(client.addWorkspacePanel({
    id: "prompt-scratchpad-workspace",
    title: "Prompt Scratchpad",
    icon: "FileText",
    context: "workspace",
    locations: ["workspace"],
    Component: PromptWorkspacePanel,
  }));
  track(client.addWorkspacePanel({
    id: "prompt-scratchpad-agent",
    title: "Prompt Scratchpad",
    icon: "FileText",
    context: "agent",
    locations: ["workspace"],
    Component: PromptAgentPanel,
  }));
  track(registerNavigationShortcuts(client, shortcutVisibility, {
    id: "prompt-scratchpad-explorer",
    title: "Prompt Scratchpad",
    icon: "FileText",
    context: "workspace",
    locations: ["explorer"],
    Component: PromptWorkspaceExplorerPanel,
  }));
  track(client.addCommandCenterItem({
    id: "open-prompt-studio",
    title: "Open Prompt Studio",
    icon: "BookOpen",
    keywords: ["prompt", "draft", "studio", "草稿"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("prompt-studio");
    },
  }));
  track(client.addCommandCenterItem({
    id: "open-worklog",
    title: "Open Worklog",
    icon: "FileText",
    keywords: ["worklog", "log", "timeline", "日志", "工作日志"],
    context: "global",
    onSelect({ openSurface }) {
      openSurface("worklog");
    },
  }));
  track(client.addCommandCenterItem({
    id: "open-prompt-scratchpad-workspace",
    title: "Open Prompt Scratchpad",
    icon: "FileText",
    keywords: ["prompt", "scratchpad", "draft", "workspace", "草稿"],
    context: "workspace",
    onSelect({ openPanel }) {
      if (shortcutVisibility.getSnapshot().showExplorerShortcut) {
        openPanel("prompt-scratchpad-explorer", { location: "explorer" });
      } else {
        openPanel("prompt-scratchpad-workspace", { location: "workspace" });
      }
    },
  }));
  track(client.addCommandCenterItem({
    id: "open-prompt-studio-settings", title: "Prompt Studio settings", icon: "Settings",
    context: "global", onSelect: ({ openSettings }) => openSettings("prompt-studio"),
  }));
  track(connectHostPreferences(client));
  let cleaned = false;
  return async () => {
    if (cleaned) return;
    cleaned = true;
    await Promise.all(cleanups.map((cleanup) => cleanup()));
  };
}
