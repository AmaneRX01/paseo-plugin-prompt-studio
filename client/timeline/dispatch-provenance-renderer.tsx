import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";
import {
  dispatchProvenanceDataSchema,
  type DispatchProvenanceData,
} from "../../shared/provenance";
import { MonoMeta, font, paletteOf, shortId, uiMetrics } from "../ui";

export function DispatchProvenanceRenderer({
  item,
  theme,
  timestamp,
}: PluginTimelineItemProps<DispatchProvenanceData>) {
  // Registration validates incoming host data. Parsing here keeps the
  // renderer safe when it is exercised directly by a host preview or test.
  const data = dispatchProvenanceDataSchema.parse(item.data);
  // The host theme contract only ships six tokens; derive surface/border
  // from the palette ladder like every other Prompt Studio surface.
  const palette = useMemo(() => paletteOf(theme), [theme]);
  return (
    <View
      style={{
        backgroundColor: palette.raised,
        borderColor: palette.border,
        borderRadius: uiMetrics.surfaceRadius,
        borderWidth: 1,
        gap: 4,
        padding: 8,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: font.body, fontWeight: "500", lineHeight: uiMetrics.controlLineHeight }}>
        {data.draftTitle}
      </Text>
      <MonoMeta selectable={false} theme={theme} truncate="none">
        {`Prompt Studio · revision ${data.revision} · ${shortId(data.dispatchId)} · ${timestamp.toLocaleString()}`}
      </MonoMeta>
    </View>
  );
}
