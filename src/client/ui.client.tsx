import { type PluginTheme } from "@getpaseo/plugin";
import { useMemo, useState, type ReactNode } from "react";
import {
  Pressable,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { useI18n } from "./i18n.client";

/**
 * Native-style kit for Prompt Studio surfaces.
 *
 * The host only hands plugins six color tokens, so the discrete surface ladder
 * Paseo uses internally (surface1 card / surface2 control / border) is derived
 * here as alpha steps of `foreground` over `surface0`, mirroring the relative
 * ladder in the app theme. Typography, spacing, radii, and control heights
 * follow the app's tokens: 14px body / 12px captions, 4pt spacing grid,
 * 38px regular controls / 32px compact controls, radius 6 for every
 * interactive control, radius 8 for surfaces, and full radius only for
 * read-only pills or circular indicators. Borders are 1px, disabled opacity
 * is 0.5, and pressed opacity is 0.85.
 */

export interface NativePalette {
  /** Card / raised fill (~surface1). */
  raised: string;
  /** Input & control fill (~surface2). */
  control: string;
  /** Selected / hover fill (~surface3). */
  controlStrong: string;
  /** Hairline borders and dividers. */
  border: string;
  /** Hover / focus-strength border (~borderAccent). */
  borderStrong: string;
}

function withAlpha(color: string, alpha: number): string {
  const hex = color.trim();
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex);
  if (!match) return color;
  let body = match[1];
  if (body.length === 3) body = body.split("").map((c) => c + c).join("");
  const r = parseInt(body.slice(0, 2), 16);
  const g = parseInt(body.slice(2, 4), 16);
  const b = parseInt(body.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function paletteOf(theme: PluginTheme): NativePalette {
  const fg = theme.colors.foreground;
  return {
    raised: withAlpha(fg, 0.04),
    control: withAlpha(fg, 0.07),
    controlStrong: withAlpha(fg, 0.12),
    border: withAlpha(fg, 0.14),
    borderStrong: withAlpha(fg, 0.28),
  };
}

export const font = {
  caption: 12,
  body: 14,
  section: 14,
  title: 16,
} as const;

/** Shared geometry for every Prompt Studio surface and panel. */
export const uiMetrics = {
  controlHeight: 38,
  compactControlHeight: 32,
  headerHeight: 48,
  compactHeaderHeight: 44,
  toolbarHeight: 46,
  controlRadius: 6,
  surfaceRadius: 8,
  pillRadius: 9999,
  pillHeight: 24,
  indicatorSize: 10,
  controlLineHeight: 20,
  compactControlLineHeight: 18,
} as const;

export function Divider({ theme, style }: { theme: PluginTheme; style?: StyleProp<ViewStyle> }) {
  const palette = useMemo(() => paletteOf(theme), [theme]);
  return <View style={[{ height: 1, backgroundColor: palette.border }, style]} />;
}

export function SectionTitle({
  theme,
  children,
  style,
}: {
  theme: PluginTheme;
  children: ReactNode;
  style?: StyleProp<TextStyle>;
}) {
  return (
    <Text
      style={[
        {
          color: theme.colors.foregroundMuted,
          fontSize: font.section,
          fontWeight: "500",
          lineHeight: uiMetrics.controlLineHeight,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

export function FieldLabel({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  return (
    <Text
      style={{
        color: theme.colors.foregroundMuted,
        fontSize: font.caption,
        fontWeight: "500",
        lineHeight: uiMetrics.compactControlLineHeight,
      }}
    >
      {children}
    </Text>
  );
}

/** Metadata text that occupies exactly one compact-toolbar control row. */
export function ToolbarMeta({
  theme,
  children,
  selectable,
}: {
  theme: PluginTheme;
  children: ReactNode;
  selectable?: boolean;
}) {
  return (
    <Text
      numberOfLines={1}
      selectable={selectable}
      style={{
        color: theme.colors.foregroundMuted,
        fontSize: font.caption,
        lineHeight: uiMetrics.compactControlHeight,
      }}
    >
      {children}
    </Text>
  );
}

export function Hint({ theme, danger, children }: { theme: PluginTheme; danger?: boolean; children: ReactNode }) {
  return (
    <Text
      style={{
        color: danger ? theme.colors.statusDanger : theme.colors.foregroundMuted,
        fontSize: font.caption,
        lineHeight: uiMetrics.compactControlLineHeight,
      }}
    >
      {children}
    </Text>
  );
}

/** Optional explanatory copy controlled by the shared Prompt Studio setting. */
export function Description({ theme, children }: { theme: PluginTheme; children: ReactNode }) {
  const { showDescriptions } = useI18n();
  return showDescriptions ? <Hint theme={theme}>{children}</Hint> : null;
}

export function Card({
  theme,
  danger,
  children,
  style,
}: {
  theme: PluginTheme;
  danger?: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const palette = useMemo(() => paletteOf(theme), [theme]);
  return (
    <View
      style={[
        {
          backgroundColor: palette.raised,
          borderColor: danger ? theme.colors.statusDanger : palette.border,
          borderRadius: uiMetrics.surfaceRadius,
          borderWidth: 1,
          gap: 8,
          padding: 12,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";

export function NativeButton({
  theme,
  label,
  onPress,
  disabled,
  variant = "primary",
  small,
  accessibilityLabel,
  style,
}: {
  theme: PluginTheme;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: ButtonVariant;
  small?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const palette = useMemo(() => paletteOf(theme), [theme]);
  const [pressed, setPressed] = useState(false);
  const colors = {
    primary: { bg: theme.colors.accent, border: theme.colors.accent, text: theme.colors.accentForeground },
    secondary: { bg: palette.controlStrong, border: palette.controlStrong, text: theme.colors.foreground },
    outline: { bg: "transparent", border: palette.borderStrong, text: theme.colors.foreground },
    ghost: { bg: "transparent", border: "transparent", text: theme.colors.foregroundMuted },
    danger: { bg: "transparent", border: theme.colors.statusDanger, text: theme.colors.statusDanger },
  }[variant];
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[
        {
          alignItems: "center",
          alignSelf: "flex-start",
          backgroundColor: colors.bg,
          borderColor: colors.border,
          borderRadius: uiMetrics.controlRadius,
          borderWidth: 1,
          flexDirection: "row",
          justifyContent: "center",
          maxWidth: "100%",
          minHeight: small ? uiMetrics.compactControlHeight : uiMetrics.controlHeight,
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
          paddingHorizontal: small ? 10 : 14,
          paddingVertical: small ? 5 : 7,
        },
        style,
      ]}
    >
      <Text
        numberOfLines={1}
        style={{
          color: colors.text,
          flexShrink: 1,
          fontSize: small ? font.caption : font.body,
          lineHeight: small ? uiMetrics.compactControlLineHeight : uiMetrics.controlLineHeight,
          textAlign: "center",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function NativeTextInput({
  theme,
  value,
  onChangeText,
  placeholder,
  accessibilityLabel,
  autoFocus,
  editable = true,
  multiline,
  small,
  variant = "filled",
  style,
  onSubmitEditing,
}: {
  theme: PluginTheme;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  accessibilityLabel: string;
  autoFocus?: boolean;
  editable?: boolean;
  multiline?: boolean;
  small?: boolean;
  variant?: "filled" | "bare";
  style?: StyleProp<TextStyle>;
  onSubmitEditing?: () => void;
}) {
  const palette = useMemo(() => paletteOf(theme), [theme]);
  const [focused, setFocused] = useState(false);
  const bare = variant === "bare";
  return (
    <TextInput
      accessibilityLabel={accessibilityLabel}
      autoFocus={autoFocus}
      editable={editable}
      multiline={multiline}
      onBlur={() => setFocused(false)}
      onChangeText={onChangeText}
      onFocus={() => setFocused(true)}
      onSubmitEditing={onSubmitEditing}
      placeholder={placeholder}
      placeholderTextColor={theme.colors.foregroundMuted}
      selectionColor={theme.colors.accent}
      style={[
        {
          backgroundColor: bare ? "transparent" : palette.control,
          borderColor: !bare && focused ? theme.colors.accent : "transparent",
          borderRadius: bare ? 0 : uiMetrics.controlRadius,
          borderWidth: 1,
          color: theme.colors.foreground,
          fontSize: font.body,
          lineHeight: small ? uiMetrics.compactControlLineHeight : uiMetrics.controlLineHeight,
          minHeight: small ? uiMetrics.compactControlHeight : uiMetrics.controlHeight,
          opacity: editable ? 1 : 0.5,
          paddingHorizontal: bare ? 0 : small ? 10 : 12,
          paddingVertical: bare ? 0 : small ? 5 : 7,
        },
        { textAlignVertical: multiline ? "top" as const : "center" as const },
        style,
      ]}
      value={value}
    />
  );
}

export interface SegmentOption {
  id: string;
  label: string;
  disabled?: boolean;
}

/** Interactive option group; both sizes deliberately share one geometry. */
export function SegmentedControl({
  theme,
  options,
  selectedId,
  selectedIds,
  onSelect,
  small,
}: {
  theme: PluginTheme;
  options: SegmentOption[];
  selectedId?: string | null;
  selectedIds?: readonly string[];
  onSelect?: (id: string) => void;
  small?: boolean;
}) {
  const palette = useMemo(() => paletteOf(theme), [theme]);
  const selectedSet = useMemo(() => new Set(selectedIds ?? []), [selectedIds]);
  const multiSelect = selectedIds !== undefined;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {options.map((option) => {
        const selected = multiSelect ? selectedSet.has(option.id) : option.id === selectedId;
        const disabled = Boolean(option.disabled || !onSelect);
        return (
          <Pressable
            accessibilityRole={multiSelect ? "checkbox" : "button"}
            accessibilityState={multiSelect ? { checked: selected, disabled } : { selected, disabled }}
            disabled={disabled}
            key={option.id}
            onPress={() => onSelect?.(option.id)}
            style={({ pressed }) => ({
              backgroundColor: selected ? palette.controlStrong : pressed ? palette.control : "transparent",
              borderColor: selected ? palette.borderStrong : palette.border,
              alignItems: "center",
              borderRadius: uiMetrics.controlRadius,
              borderWidth: 1,
              justifyContent: "center",
              maxWidth: "100%",
              minHeight: small ? uiMetrics.compactControlHeight : uiMetrics.controlHeight,
              opacity: disabled ? 0.5 : 1,
              paddingHorizontal: small ? 8 : 12,
              paddingVertical: small ? 5 : 7,
            })}
          >
            <Text
              numberOfLines={1}
              style={{
                color: selected ? theme.colors.foreground : theme.colors.foregroundMuted,
                flexShrink: 1,
                fontSize: small ? font.caption : font.body,
                fontWeight: selected ? "500" : "400",
                lineHeight: small ? uiMetrics.compactControlLineHeight : uiMetrics.controlLineHeight,
              }}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Read-only status pill, matching the app status badge. */
export function StatusPill({
  theme,
  label,
  tone = "neutral",
  size = "pill",
}: {
  theme: PluginTheme;
  label: string;
  tone?: "neutral" | "accent" | "danger";
  size?: "pill" | "control";
}) {
  const palette = useMemo(() => paletteOf(theme), [theme]);
  const color = tone === "accent" ? theme.colors.accent : tone === "danger" ? theme.colors.statusDanger : theme.colors.foregroundMuted;
  const backgroundColor = tone === "neutral" ? palette.control : withAlpha(color, 0.12);
  const borderColor = tone === "neutral" ? palette.border : withAlpha(color, 0.5);
  const controlSized = size === "control";
  return (
    <View
      style={{
        alignSelf: "flex-start",
        alignItems: "center",
        backgroundColor,
        borderColor,
        borderRadius: controlSized ? uiMetrics.controlRadius : uiMetrics.pillRadius,
        borderWidth: 1,
        justifyContent: "center",
        maxWidth: "100%",
        minHeight: controlSized ? uiMetrics.compactControlHeight : uiMetrics.pillHeight,
        paddingHorizontal: controlSized ? 10 : 8,
        paddingVertical: controlSized ? 5 : 2,
      }}
    >
      <Text
        numberOfLines={1}
        style={{
          color,
          flexShrink: 1,
          fontSize: font.caption,
          lineHeight: controlSized ? uiMetrics.compactControlLineHeight : 16,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

export function EmptyState({
  theme,
  title,
  body,
  action,
}: {
  theme: PluginTheme;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  const palette = useMemo(() => paletteOf(theme), [theme]);
  return (
    <View
      style={{
        alignItems: "center",
        backgroundColor: theme.colors.surface0,
        borderColor: palette.border,
        borderRadius: uiMetrics.surfaceRadius,
        borderWidth: 1,
        gap: 10,
        paddingHorizontal: 16,
        paddingVertical: 24,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: font.caption, fontWeight: "500", textAlign: "center" }}>
        {title}
      </Text>
      {body ? (
        <Text
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: font.caption,
            lineHeight: uiMetrics.compactControlLineHeight,
            textAlign: "center",
          }}
        >
          {body}
        </Text>
      ) : null}
      {action}
    </View>
  );
}

export function ErrorBlock({
  theme,
  message,
  action,
}: {
  theme: PluginTheme;
  message: string;
  action?: ReactNode;
}) {
  return (
    <Card danger theme={theme}>
      <Text
        selectable
        style={{
          color: theme.colors.statusDanger,
          fontSize: font.caption,
          lineHeight: uiMetrics.compactControlLineHeight,
        }}
      >
        {message}
      </Text>
      {action}
    </Card>
  );
}
