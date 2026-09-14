import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useI18n } from "../i18n";
import { Glyph, SelectionIndicator, font, paletteOf, uiMetrics } from "../ui";
import type { ProjectWorkspaceGroup } from "./workspace-groups";

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
                gap: 8,
                minHeight: expanded ? uiMetrics.controlHeight : uiMetrics.compactControlHeight,
                paddingHorizontal: 8,
                paddingVertical: expanded ? 7 : 5,
              })}
            >
              <View style={{ alignItems: "center", width: 18 }}>
                <Glyph name={expanded ? "expand" : "collapse"} theme={theme} />
              </View>
              <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
                <Text
                  numberOfLines={1}
                  style={{
                    color: theme.colors.foreground,
                    fontSize: font.body,
                    fontWeight: expanded ? "500" : "400",
                    lineHeight: uiMetrics.controlLineHeight,
                  }}
                >
                  {group.projectDisplayName}
                </Text>
                {expanded ? (
                  <Text
                    numberOfLines={1}
                    style={{
                      color: theme.colors.foregroundMuted,
                      fontSize: font.caption,
                      lineHeight: uiMetrics.compactControlLineHeight,
                    }}
                  >
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
                    gap: 8,
                    minHeight: uiMetrics.compactControlHeight,
                    paddingHorizontal: 12,
                    paddingVertical: 7,
                  })}
                >
                  <Glyph name="add" size={12} theme={theme} />
                  <SelectionIndicator
                    checked={selectedProject && selectedNewWorkspace}
                    kind="radio"
                    theme={theme}
                  />
                  <Text
                    style={{
                      color: selectedProject && selectedNewWorkspace
                        ? theme.colors.foreground
                        : theme.colors.foregroundMuted,
                      flex: 1,
                      fontSize: font.caption,
                      fontWeight: selectedProject && selectedNewWorkspace ? "500" : "400",
                      lineHeight: uiMetrics.compactControlLineHeight,
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
                        gap: 8,
                        minHeight: uiMetrics.compactControlHeight,
                        paddingHorizontal: 12,
                        paddingVertical: 7,
                      })}
                    >
                      <SelectionIndicator checked={selected} kind="radio" theme={theme} />
                      <Text
                        numberOfLines={1}
                        style={{
                          color: selected ? theme.colors.foreground : theme.colors.foregroundMuted,
                          flex: 1,
                          fontSize: font.caption,
                          fontWeight: selected ? "500" : "400",
                          lineHeight: uiMetrics.compactControlLineHeight,
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
