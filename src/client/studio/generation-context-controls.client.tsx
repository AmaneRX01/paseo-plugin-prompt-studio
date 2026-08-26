import type { PluginTheme } from "@getpaseo/plugin";
import { useMemo, useState, type ReactNode } from "react";
import {
  Pressable,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from "react-native";
import type { GenerationTimeRange } from "../../shared/generation.shared";
import {
  Card,
  FieldLabel,
  Hint,
  font,
  paletteOf,
  uiMetrics,
} from "../ui.client";
import { sliderIndexAtLocation } from "./generation-slider.client";

export interface TimeRangeOption {
  id: GenerationTimeRange;
  label: string;
}

export function TimeRangeSlider({
  accessibilityLabel,
  disabled = false,
  onChange,
  options,
  theme,
  value,
}: {
  accessibilityLabel: string;
  disabled?: boolean;
  onChange: (value: GenerationTimeRange) => void;
  options: readonly TimeRangeOption[];
  theme: PluginTheme;
  value: GenerationTimeRange;
}) {
  const palette = useMemo(() => paletteOf(theme), [theme]);
  const [trackWidth, setTrackWidth] = useState(0);
  const selectedIndex = Math.max(0, options.findIndex((option) => option.id === value));
  const selected = options[selectedIndex];
  const denominator = Math.max(1, options.length - 1);
  const sideInset = options.length > 0 ? 50 / options.length : 0;
  const fillWidth = `${(selectedIndex / denominator) * (100 - sideInset * 2)}%` as `${number}%`;
  const inset = `${sideInset}%` as `${number}%`;

  function selectIndex(index: number) {
    const next = options[Math.max(0, Math.min(options.length - 1, index))];
    if (next && next.id !== value) onChange(next.id);
  }

  function selectAt(event: GestureResponderEvent) {
    if (disabled || trackWidth <= 0 || options.length === 0) return;
    selectIndex(sliderIndexAtLocation(event.nativeEvent.locationX, trackWidth, options.length));
  }

  function measureTrack(event: LayoutChangeEvent) {
    setTrackWidth(event.nativeEvent.layout.width);
  }

  return (
    <View style={{ gap: 3, opacity: disabled ? 0.5 : 1 }}>
      <View style={{ alignItems: "center", flexDirection: "row", justifyContent: "space-between" }}>
        <FieldLabel theme={theme}>{accessibilityLabel}</FieldLabel>
        <Text style={{ color: theme.colors.foreground, fontSize: font.caption, fontWeight: "500" }}>
          {selected?.label ?? ""}
        </Text>
      </View>
      <View
        aria-disabled={disabled}
        aria-valuemax={Math.max(0, options.length - 1)}
        aria-valuemin={0}
        aria-valuenow={selectedIndex}
        aria-valuetext={selected?.label}
        accessibilityActions={[{ name: "decrement" }, { name: "increment" }]}
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="adjustable"
        accessibilityState={{ disabled }}
        accessibilityValue={{
          min: 0,
          max: Math.max(0, options.length - 1),
          now: selectedIndex,
          text: selected?.label,
        }}
        onAccessibilityAction={(event) => {
          if (disabled) return;
          if (event.nativeEvent.actionName === "increment") selectIndex(selectedIndex + 1);
          if (event.nativeEvent.actionName === "decrement") selectIndex(selectedIndex - 1);
        }}
        onLayout={measureTrack}
        onMoveShouldSetResponder={() => !disabled}
        onResponderGrant={selectAt}
        onResponderMove={selectAt}
        onStartShouldSetResponder={() => !disabled}
        style={{ height: 42, justifyContent: "flex-start", position: "relative" }}
        tabIndex={disabled ? -1 : 0}
      >
        <View
          pointerEvents="none"
          style={{
            backgroundColor: palette.borderStrong,
            height: 2,
            left: inset,
            position: "absolute",
            right: inset,
            top: 8,
          }}
        />
        <View
          pointerEvents="none"
          style={{
            backgroundColor: theme.colors.accent,
            height: 2,
            left: inset,
            position: "absolute",
            top: 8,
            width: fillWidth,
          }}
        />
        <View pointerEvents="none" style={{ flexDirection: "row" }}>
          {options.map((option, index) => {
            const active = index === selectedIndex;
            const passed = index < selectedIndex;
            return (
              <View key={option.id} style={{ alignItems: "center", flex: 1, gap: 4 }}>
                <View
                  style={{
                    backgroundColor: active || passed ? theme.colors.accent : theme.colors.surface0,
                    borderColor: active ? theme.colors.accent : palette.borderStrong,
                    borderRadius: uiMetrics.pillRadius,
                    borderWidth: active ? 3 : 2,
                    height: active ? 16 : 10,
                    marginTop: active ? 0 : 3,
                    width: active ? 16 : 10,
                  }}
                />
                <Text
                  numberOfLines={1}
                  style={{
                    color: active ? theme.colors.foreground : theme.colors.foregroundMuted,
                    fontSize: font.caption,
                    fontWeight: active ? "500" : "400",
                    lineHeight: uiMetrics.compactControlLineHeight,
                  }}
                >
                  {option.label}
                </Text>
              </View>
            );
          })}
        </View>
      </View>
    </View>
  );
}

export function GenerationContextSourceCard({
  accessibilityLabel,
  children,
  compact,
  enabled,
  help,
  onEnabledChange,
  onTimeRangeChange,
  theme,
  timeLabel,
  timeOptions,
  timeRange,
  title,
}: {
  accessibilityLabel: string;
  children?: ReactNode;
  compact: boolean;
  enabled: boolean;
  help: string;
  onEnabledChange: (enabled: boolean) => void;
  onTimeRangeChange: (value: GenerationTimeRange) => void;
  theme: PluginTheme;
  timeLabel: string;
  timeOptions: readonly TimeRangeOption[];
  timeRange: GenerationTimeRange;
  title: string;
}) {
  const palette = useMemo(() => paletteOf(theme), [theme]);
  return (
    <Card style={{ gap: compact ? 8 : 10, padding: compact ? 10 : 12 }} theme={theme}>
      <Pressable
        aria-checked={enabled}
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: enabled }}
        onPress={() => onEnabledChange(!enabled)}
        style={({ pressed }) => ({
          alignItems: "flex-start",
          flexDirection: "row",
          gap: 9,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <View
          style={{
            alignItems: "center",
            backgroundColor: enabled ? theme.colors.accent : "transparent",
            borderColor: enabled ? theme.colors.accent : palette.borderStrong,
            borderRadius: uiMetrics.controlRadius,
            borderWidth: 1,
            height: 18,
            justifyContent: "center",
            marginTop: 1,
            width: 18,
          }}
        >
          {enabled ? (
            <Text
              style={{
                color: theme.colors.accentForeground,
                fontSize: font.caption,
                fontWeight: "700",
                lineHeight: 16,
              }}
            >
              ✓
            </Text>
          ) : null}
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: font.body, fontWeight: "500" }}>
            {title}
          </Text>
          <Hint theme={theme}>{help}</Hint>
        </View>
      </Pressable>
      {children ? <View style={{ gap: 6, opacity: enabled ? 1 : 0.5 }}>{children}</View> : null}
      <TimeRangeSlider
        accessibilityLabel={timeLabel}
        disabled={!enabled}
        onChange={onTimeRangeChange}
        options={timeOptions}
        theme={theme}
        value={timeRange}
      />
    </Card>
  );
}
