import { type PluginSurfaceProps } from "@getpaseo/plugin";
import { StudioView } from "./studio.client";

export function PromptStudioSurface({ theme, host, layout }: PluginSurfaceProps) {
  return (
    <StudioView
      compact={layout.compact}
      hostLabel={host.label}
      theme={theme}
      view="drafts"
    />
  );
}

export function WorklogSurface({ theme, host, layout }: PluginSurfaceProps) {
  return (
    <StudioView
      compact={layout.compact}
      hostLabel={host.label}
      theme={theme}
      view="worklog"
    />
  );
}
