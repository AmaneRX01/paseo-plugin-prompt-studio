import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useI18n } from "../i18n.client";
import { font, paletteOf, uiMetrics } from "../ui.client";
import type { ProjectWorkspaceGroup } from "./workspace-groups.client";

export function ProjectWorkspacePicker({
  expandedProjectId,
  groups,
  onNewWorkspaceSelect,
  onProjectPress,
  onWorkspaceSelect,
  selectedNewWorkspace,
  selectedProjectId,
  selectedWorkspaceId,
  theme,
}: {
  expandedProjectId: string | null;
  groups: readonly ProjectWorkspaceGroup[];
  onNewWorkspaceSelect: (projectId: string) => void;
  onProjectPress: (projectId: string) => void;
  onWorkspaceSelect: (workspaceId: string) => void;
  selectedNewWorkspace: boolean;
  selectedProjectId: string | null;
  selectedWorkspaceId: string | null;
  theme: PluginTheme;
}) {
  const { t } = useI18n();
  const palette = useMemo(() => paletteOf(theme), [theme]);

  return (
    <View style={{ borderBottomColor: palette.border, borderBottomWidth: 1 }}>
      {groups.map((group) => {
        const expanded = group.projectId === expandedProjectId;
        const selectedProject = group.projectId === selectedProjectId;
        const selectedWorkspace = group.workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
        return (
          <View key={group.projectId}>
            <Pressable
              accessibilityLabel={t(expanded ? "send.project.collapse" : "send.project.expand", {
                project: group.projectDisplayName,
              })}
              accessibilityRole="button"
              accessibilityState={{ expanded, selected: selectedProject }}
              onPress={() => onProjectPress(group.projectId)}
              style={({ pressed }) => ({
                alignItems: "center",
                backgroundColor: expanded ? palette.control : pressed ? palette.control : "transparent",
                borderTopColor: palette.border,
                borderTopWidth: 1,
                flexDirection: "row",
                gap: 9,
                minHeight: expanded ? uiMetrics.controlHeight : uiMetrics.compactControlHeight,
                paddingHorizontal: 8,
                paddingVertical: expanded ? 7 : 5,
              })}
            >
              <Text
                style={{
                  color: expanded ? theme.colors.accent : theme.colors.foregroundMuted,
                  fontSize: expanded ? font.body : font.caption,
                  fontWeight: expanded ? "600" : "400",
                  textAlign: "center",
                  width: 18,
                }}
              >
                {expanded ? "−" : "+"}
              </Text>
              <View style={{ flex: 1, gap: 1 }}>
                <Text
                  numberOfLines={1}
                  style={{
                    color: expanded ? theme.colors.foreground : theme.colors.foregroundMuted,
                    fontSize: expanded ? font.body : font.caption,
                    fontWeight: expanded ? "600" : "400",
                  }}
                >
                  {group.projectDisplayName}
                </Text>
                {expanded ? (
                  <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                    {t("send.project.workspaceCount", { count: group.workspaces.length })}
                    {selectedWorkspace ? ` · ${selectedWorkspace.name}` : ""}
                  </Text>
                ) : null}
              </View>
            </Pressable>

            {expanded ? (
              <View style={{ borderLeftColor: palette.borderStrong, borderLeftWidth: 2, marginLeft: 16 }}>
                <Pressable
                  accessibilityLabel={t("send.project.newWorkspace")}
                  accessibilityRole="button"
                  accessibilityState={{ selected: selectedProject && selectedNewWorkspace }}
                  onPress={() => onNewWorkspaceSelect(group.projectId)}
                  style={({ pressed }) => ({
                    alignItems: "center",
                    backgroundColor: selectedProject && selectedNewWorkspace
                      ? palette.controlStrong
                      : pressed ? palette.control : "transparent",
                    borderTopColor: palette.border,
                    borderTopWidth: 1,
                    flexDirection: "row",
                    gap: 9,
                    minHeight: uiMetrics.compactControlHeight,
                    paddingHorizontal: 12,
                    paddingVertical: 7,
                  })}
                >
                  <View
                    style={{
                      backgroundColor: selectedProject && selectedNewWorkspace
                        ? theme.colors.accent
                        : palette.controlStrong,
                      borderColor: selectedProject && selectedNewWorkspace
                        ? theme.colors.accent
                        : palette.borderStrong,
                      borderRadius: uiMetrics.pillRadius,
                      borderWidth: 1,
                      height: uiMetrics.indicatorSize,
                      width: uiMetrics.indicatorSize,
                    }}
                  />
                  <Text
                    style={{
                      color: selectedProject && selectedNewWorkspace
                        ? theme.colors.foreground
                        : theme.colors.foregroundMuted,
                      flex: 1,
                      fontSize: font.caption,
                      fontWeight: selectedProject && selectedNewWorkspace ? "500" : "400",
                    }}
                  >
                    {t("send.project.newWorkspace")}
                  </Text>
                </Pressable>
                {group.workspaces.map((workspace) => {
                  const selected = workspace.id === selectedWorkspaceId;
                  return (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      key={workspace.id}
                      onPress={() => onWorkspaceSelect(workspace.id)}
                      style={({ pressed }) => ({
                        alignItems: "center",
                        backgroundColor: selected ? palette.controlStrong : pressed ? palette.control : "transparent",
                        borderTopColor: palette.border,
                        borderTopWidth: 1,
                        flexDirection: "row",
                        gap: 9,
                        minHeight: uiMetrics.compactControlHeight,
                        paddingHorizontal: 12,
                        paddingVertical: 7,
                      })}
                    >
                      <View
                        style={{
                          backgroundColor: selected ? theme.colors.accent : palette.controlStrong,
                          borderColor: selected ? theme.colors.accent : palette.borderStrong,
                          borderRadius: uiMetrics.pillRadius,
                          borderWidth: 1,
                          height: uiMetrics.indicatorSize,
                          width: uiMetrics.indicatorSize,
                        }}
                      />
                      <Text
                        numberOfLines={1}
                        style={{
                          color: selected ? theme.colors.foreground : theme.colors.foregroundMuted,
                          flex: 1,
                          fontSize: font.caption,
                          fontWeight: selected ? "500" : "400",
                        }}
                      >
                        {workspace.name}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
