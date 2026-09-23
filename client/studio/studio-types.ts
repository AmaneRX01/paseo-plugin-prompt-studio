import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { DraftStatus } from "../../shared/contracts";

export type StudioTab = "worklog" | "drafts";

export interface StudioProjectContext {
  projectId: string;
  preferredWorkspaceId: string;
  projectName: string;
}

export interface StudioViewProps {
  theme: PluginTheme;
  compact: boolean;
  hostLabel: string;
  hostId?: string;
  navigation?: PluginSurfaceProps["navigation"];
  view: StudioTab;
  projectContext?: StudioProjectContext;
  preferredAgentId?: string | null;
  scratchpad?: boolean;
}

export type SaveState = "saved" | "dirty" | "saving" | "conflict" | "error";
export type { DraftStatus };
export type NavigationBlockState = Exclude<SaveState, "saved"> | "dispatching" | "updating";
