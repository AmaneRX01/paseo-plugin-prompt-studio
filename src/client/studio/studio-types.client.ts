import type { PluginTheme } from "@getpaseo/plugin";
import type { DraftStatus } from "../../shared/contracts.shared";

export type StudioTab = "worklog" | "drafts";

export interface StudioProjectContext {
  projectId: string;
  workspaceLocatorId: string;
  projectName: string;
}

export interface StudioViewProps {
  theme: PluginTheme;
  compact: boolean;
  hostLabel: string;
  view: StudioTab;
  projectContext?: StudioProjectContext;
  preferredAgentId?: string | null;
  scratchpad?: boolean;
}

export type SaveState = "saved" | "dirty" | "saving" | "conflict" | "error";
export type { DraftStatus };
export type NavigationBlockState = Exclude<SaveState, "saved"> | "dispatching" | "updating";
