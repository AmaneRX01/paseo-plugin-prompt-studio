import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { StudioView } from "./studio";

export function PromptStudioSurface({ theme, host, layout, navigation }: PluginSurfaceProps) {
  return (
    <StudioView
      compact={layout.compact}
      hostLabel={host.label}
      hostId={host.id}
      navigation={navigation}
      theme={theme}
      view="drafts"
    />
  );
}

export function WorklogSurface({ theme, host, layout, navigation }: PluginSurfaceProps) {
  return (
    <StudioView
      compact={layout.compact}
      hostLabel={host.label}
      hostId={host.id}
      navigation={navigation}
      theme={theme}
      view="worklog"
    />
  );
}
