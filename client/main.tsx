import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { StudioView } from "./studio";

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
