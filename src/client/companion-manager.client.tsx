import { type PluginTheme } from "@getpaseo/plugin";
import { StudioView, type StudioProjectContext } from "./studio.client";

/**
 * Backward-compatible component name for plugin hosts that cached the v1 client
 * bundle. In v2 this is the scoped Scratchpad, backed by the same plaintext
 * catalog and editor as the global Prompt Studio surface.
 */
export function CompanionManager({
  theme,
  compact,
  hostLabel = "Paseo",
  projectContext,
  preferredAgentId,
}: {
  theme: PluginTheme;
  compact: boolean;
  hostLabel?: string;
  projectContext?: StudioProjectContext;
  preferredAgentId?: string | null;
}) {
  return (
    <StudioView
      compact={compact}
      projectContext={projectContext}
      hostLabel={hostLabel}
      preferredAgentId={preferredAgentId}
      scratchpad
      theme={theme}
      view="drafts"
    />
  );
}
