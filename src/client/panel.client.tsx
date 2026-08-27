import {
  type PluginAgentPanelProps,
  type PluginTheme,
  type PluginWorkspacePanelProps,
  useAgent,
  useWorkspace,
} from "@getpaseo/plugin";
import { Text, View } from "react-native";
import { CompanionManager } from "./companion-manager.client";
import { useI18n, type MessageKey } from "./i18n.client";
import { SectionTitle, font } from "./ui.client";

function MissingContext({ theme, messageKey }: { theme: PluginTheme; messageKey: MessageKey }) {
  const { t } = useI18n();
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0, padding: 16, gap: 6 }}>
      <SectionTitle theme={theme} style={{ color: theme.colors.foreground }}>
        {t("app.title.scratchpad")}
      </SectionTitle>
      <Text style={{ color: theme.colors.statusDanger, fontSize: font.caption, lineHeight: 17 }}>
        {t(messageKey)}
      </Text>
    </View>
  );
}

function WorkspaceScratchpad({
  theme,
  host,
  workspaceId,
  compact,
}: PluginWorkspacePanelProps & { compact: boolean }) {
  const workspace = useWorkspace(workspaceId, ({ projectId, projectDisplayName }) => ({
    projectId,
    projectName: projectDisplayName,
  }));

  if (!workspace) {
    return <MissingContext theme={theme} messageKey="panel.missingWorkspace" />;
  }

  return (
    <CompanionManager
      compact={compact}
      projectContext={{
        projectId: workspace.projectId,
        preferredWorkspaceId: workspaceId,
        projectName: workspace.projectName,
      }}
      hostLabel={host.label}
      theme={theme}
    />
  );
}

export function PromptWorkspacePanel(props: PluginWorkspacePanelProps) {
  return <WorkspaceScratchpad {...props} compact={props.layout.compact} />;
}

export function PromptWorkspaceExplorerPanel(props: PluginWorkspacePanelProps) {
  return <WorkspaceScratchpad {...props} compact />;
}

export function PromptAgentPanel({ theme, host, layout, workspaceId, agentId }: PluginAgentPanelProps) {
  const workspace = useWorkspace(workspaceId, ({ projectId, projectDisplayName }) => ({
    projectId,
    projectName: projectDisplayName,
  }));
  const agent = useAgent(agentId, ({ id, title, workspaceId: agentWorkspaceId }) => ({
    id,
    title,
    workspaceId: agentWorkspaceId,
  }));

  if (!workspace || !agent || agent.workspaceId !== workspaceId) {
    return <MissingContext theme={theme} messageKey="panel.missingAgent" />;
  }

  return (
    <CompanionManager
      compact={layout.compact}
      projectContext={{
        projectId: workspace.projectId,
        preferredWorkspaceId: workspaceId,
        projectName: workspace.projectName,
      }}
      hostLabel={`${host.label} · ${agent.title ?? agent.id}`}
      preferredAgentId={agent.id}
      theme={theme}
    />
  );
}
