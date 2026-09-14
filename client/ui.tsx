import type { PluginTheme } from "@getpaseo/plugin";
import { Modal, TextInput as HostTextInput } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  Text,
  View,
  type DimensionValue,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { useI18n } from "./i18n";

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
 *
 * Beyond the base kit this module also owns the shared building blocks added
 * for the 2026 UI pass: `Glyph`/`IconButton` for symbol actions, `CardTitle`
 * and `MonoMeta` (+ `shortId`) for headings and technical IDs, `SelectionRow`/
 * `SelectionIndicator` as the single checkbox/radio visual language,
 * `ConfirmInline` for two-step destructive confirmations, and `Skeleton`/
 * `SkeletonRows` for content loading (bare spinners are reserved for live
 * background activity). Font sizes never go below `font.caption` (12px) and
 * text line heights come from `uiMetrics` only.
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
  /** Longform Markdown reading (body 14/15px text). */
  longformLineHeight: 24,
  selectionSize: 16,
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

export function Hint({
  theme,
  danger,
  accent,
  children,
}: {
  theme: PluginTheme;
  danger?: boolean;
  accent?: boolean;
  children: ReactNode;
}) {
  return (
    <Text
      style={{
        color: danger ? theme.colors.statusDanger : accent ? theme.colors.accent : theme.colors.foregroundMuted,
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

/** Shared modal shell for Prompt Studio dialogs and settings. */
export function NativeDialog({
  children,
  description,
  onClose,
  theme,
  title,
  visible,
}: {
  children: ReactNode;
  description?: string;
  onClose: () => void;
  theme: PluginTheme;
  title: string;
  visible: boolean;
}) {
  return (
    <Modal
      open={visible}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={title}
    >
      <Modal.Content scrollable={false}>
        {description ? <Hint theme={theme}>{description}</Hint> : null}
        {children}
      </Modal.Content>
    </Modal>
  );
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
  busy,
  variant = "primary",
  small,
  accessibilityLabel,
  style,
}: {
  theme: PluginTheme;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** Shows a spinner before the label and blocks presses while true. */
  busy?: boolean;
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
  const inactive = Boolean(disabled || busy);
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: Boolean(busy) }}
      disabled={inactive}
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
          opacity: inactive ? 0.5 : pressed ? 0.85 : 1,
          paddingHorizontal: small ? 10 : 14,
          paddingVertical: small ? 5 : 7,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={colors.text} size="small" style={{ marginRight: 6 }} />
      ) : null}
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
  keyboardType,
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
  keyboardType?: TextInputProps["keyboardType"];
  small?: boolean;
  variant?: "filled" | "bare";
  style?: StyleProp<TextStyle>;
  onSubmitEditing?: () => void;
}) {
  const palette = useMemo(() => paletteOf(theme), [theme]);
  const [focused, setFocused] = useState(false);
  const bare = variant === "bare";
  return (
    <HostTextInput
      accessibilityLabel={accessibilityLabel}
      autoFocus={autoFocus}
      editable={editable}
      keyboardType={keyboardType}
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
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, maxWidth: "100%" }}>
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
  glyph,
  action,
}: {
  theme: PluginTheme;
  title: string;
  body?: string;
  glyph?: GlyphName;
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
      {glyph ? <Glyph color={theme.colors.foregroundMuted} name={glyph} size={20} theme={theme} /> : null}
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

/* ------------------------------------------------------------------------ */
/* Glyphs & icon buttons                                                     */
/* ------------------------------------------------------------------------ */

const glyphChars = {
  add: "+",
  back: "‹",
  check: "✓",
  close: "×",
  collapse: "▸",
  expand: "▾",
  more: "⋯",
  refresh: "↻",
  remove: "−",
  star: "★",
  starOutline: "☆",
} as const;

export type GlyphName = keyof typeof glyphChars;

/**
 * Text glyphs, rendered with one sizing/alignment convention so the same
 * symbol looks identical in every surface (raw characters drift per file).
 */
export function Glyph({
  theme,
  name,
  size = 14,
  color,
}: {
  theme: PluginTheme;
  name: GlyphName;
  size?: number;
  color?: string;
}) {
  return (
    <Text
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        color: color ?? theme.colors.foregroundMuted,
        fontSize: size,
        includeFontPadding: false,
        lineHeight: Math.round(size * 1.3),
        textAlign: "center",
      }}
    >
      {glyphChars[name]}
    </Text>
  );
}

/** Compact square button for glyph-only actions; always a 32px touch target. */
export function IconButton({
  theme,
  glyph,
  onPress,
  accessibilityLabel,
  disabled,
  busy,
  variant = "ghost",
  glyphColor,
  glyphSize = 14,
  style,
}: {
  theme: PluginTheme;
  glyph: GlyphName;
  onPress: () => void;
  accessibilityLabel: string;
  disabled?: boolean;
  busy?: boolean;
  variant?: "ghost" | "outline" | "secondary";
  glyphColor?: string;
  glyphSize?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const palette = useMemo(() => paletteOf(theme), [theme]);
  const inactive = Boolean(disabled || busy);
  const colors = {
    ghost: { bg: "transparent", border: "transparent", text: theme.colors.foregroundMuted },
    outline: { bg: "transparent", border: palette.borderStrong, text: theme.colors.foreground },
    secondary: { bg: palette.controlStrong, border: palette.controlStrong, text: theme.colors.foreground },
  }[variant];
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: Boolean(busy) }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        {
          alignItems: "center",
          backgroundColor: colors.bg,
          borderColor: colors.border,
          borderRadius: uiMetrics.controlRadius,
          borderWidth: 1,
          height: uiMetrics.compactControlHeight,
          justifyContent: "center",
          opacity: inactive ? 0.5 : pressed ? 0.85 : 1,
          width: uiMetrics.compactControlHeight,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={colors.text} size="small" />
      ) : (
        <Glyph color={glyphColor ?? colors.text} name={glyph} size={glyphSize} theme={theme} />
      )}
    </Pressable>
  );
}

/* ------------------------------------------------------------------------ */
/* Section content primitives                                                */
/* ------------------------------------------------------------------------ */

/** One shared "card heading" style; replaces the five copied inline styles. */
export function CardTitle({
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
          color: theme.colors.foreground,
          fontSize: font.body,
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

const monoFontFamily = Platform.select({ ios: "Menlo", default: "monospace" });

/**
 * Technical metadata (IDs, hashes, paths) in one legible style: caption size,
 * monospace, middle-truncated when constrained, selectable for copying.
 * Replaces the old "11px gray raw ID" pattern.
 */
export function MonoMeta({
  theme,
  children,
  selectable = true,
  truncate = "middle",
  style,
}: {
  theme: PluginTheme;
  children: ReactNode;
  selectable?: boolean;
  truncate?: "middle" | "tail" | "none";
  style?: StyleProp<TextStyle>;
}) {
  return (
    <Text
      ellipsizeMode={truncate === "none" ? undefined : truncate}
      numberOfLines={truncate === "none" ? undefined : 1}
      selectable={selectable}
      style={[
        {
          color: theme.colors.foregroundMuted,
          fontFamily: monoFontFamily,
          fontSize: font.caption,
          lineHeight: uiMetrics.compactControlLineHeight,
        },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

/** Shortens a long ID/hash for unconstrained spots: `abcdef…wxyz`. */
export function shortId(value: string, head = 6, tail = 4): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/* ------------------------------------------------------------------------ */
/* Selection controls — one visual language for checkbox / radio             */
/* ------------------------------------------------------------------------ */

export type SelectionKind = "checkbox" | "radio";

export function SelectionIndicator({
  theme,
  kind,
  checked,
  disabled,
}: {
  theme: PluginTheme;
  kind: SelectionKind;
  checked: boolean;
  disabled?: boolean;
}) {
  const size = uiMetrics.selectionSize;
  const base = {
    alignItems: "center" as const,
    borderColor: checked ? theme.colors.accent : paletteOf(theme).borderStrong,
    justifyContent: "center" as const,
    height: size,
    opacity: disabled ? 0.5 : 1,
    width: size,
  };
  if (kind === "radio") {
    return (
      <View style={[base, { borderRadius: size / 2, borderWidth: checked ? 2 : 1 }]}>
        {checked ? (
          <View
            style={{
              backgroundColor: theme.colors.accent,
              borderRadius: (size - 8) / 2,
              height: size - 8,
              width: size - 8,
            }}
          />
        ) : null}
      </View>
    );
  }
  return (
    <View
      style={[
        base,
        {
          backgroundColor: checked ? theme.colors.accent : "transparent",
          borderRadius: 4,
          borderWidth: 1,
        },
      ]}
    >
      {checked ? (
        <Glyph color={theme.colors.accentForeground} name="check" size={12} theme={theme} />
      ) : null}
    </View>
  );
}

/** Tappable row with a selection indicator, title, and optional subtitle. */
export function SelectionRow({
  theme,
  kind = "radio",
  checked,
  onPress,
  disabled,
  title,
  subtitle,
  right,
  style,
}: {
  theme: PluginTheme;
  kind?: SelectionKind;
  checked: boolean;
  onPress?: () => void;
  disabled?: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const palette = useMemo(() => paletteOf(theme), [theme]);
  return (
    <Pressable
      accessibilityRole={kind === "checkbox" ? "checkbox" : "radio"}
      accessibilityState={{ checked, disabled: Boolean(disabled) }}
      disabled={disabled || !onPress}
      onPress={onPress}
      style={({ pressed }) => [
        {
          alignItems: "center",
          backgroundColor: pressed ? palette.control : "transparent",
          borderRadius: uiMetrics.controlRadius,
          flexDirection: "row",
          gap: 8,
          minHeight: uiMetrics.compactControlHeight,
          opacity: disabled ? 0.5 : 1,
          paddingHorizontal: 8,
          paddingVertical: 4,
        },
        style,
      ]}
    >
      <SelectionIndicator checked={checked} disabled={disabled} kind={kind} theme={theme} />
      <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{
            color: theme.colors.foreground,
            flexShrink: 1,
            fontSize: font.body,
            fontWeight: checked ? "500" : "400",
            lineHeight: uiMetrics.controlLineHeight,
          }}
        >
          {title}
        </Text>
        {subtitle ? (
          <Text
            numberOfLines={1}
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: font.caption,
              lineHeight: uiMetrics.compactControlLineHeight,
            }}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </Pressable>
  );
}

/* ------------------------------------------------------------------------ */
/* Inline two-step confirmation                                              */
/* ------------------------------------------------------------------------ */

/**
 * Uniform destructive-action confirmation: the trigger button swaps to an
 * inline danger card with confirm/cancel. `busy` is surfaced on the trigger
 * after the card closes (confirm closes the card and starts the operation).
 */
export function ConfirmInline({
  theme,
  label,
  onConfirm,
  disabled,
  busy,
  confirmTitle,
  confirmBody,
  confirmLabel,
  cancelLabel,
  variant = "danger",
  small = true,
  accessibilityLabel,
  style,
}: {
  theme: PluginTheme;
  label: string;
  onConfirm: () => void;
  disabled?: boolean;
  busy?: boolean;
  confirmTitle: string;
  confirmBody?: string;
  confirmLabel: string;
  cancelLabel: string;
  variant?: ButtonVariant;
  small?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <NativeButton
        accessibilityLabel={accessibilityLabel}
        busy={busy}
        disabled={disabled}
        label={label}
        onPress={() => setArmed(true)}
        small={small}
        style={style}
        theme={theme}
        variant={variant}
      />
    );
  }
  return (
    <Card danger={variant === "danger"} style={style} theme={theme}>
      <Text
        style={{
          color: variant === "danger" ? theme.colors.statusDanger : theme.colors.foreground,
          fontSize: font.caption,
          fontWeight: "500",
          lineHeight: uiMetrics.compactControlLineHeight,
        }}
      >
        {confirmTitle}
      </Text>
      {confirmBody ? <Hint theme={theme}>{confirmBody}</Hint> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <NativeButton
          label={confirmLabel}
          onPress={() => {
            setArmed(false);
            onConfirm();
          }}
          small
          theme={theme}
          variant={variant}
        />
        <NativeButton
          label={cancelLabel}
          onPress={() => setArmed(false)}
          small
          theme={theme}
          variant="ghost"
        />
      </View>
    </Card>
  );
}

/* ------------------------------------------------------------------------ */
/* Loading skeletons                                                         */
/* ------------------------------------------------------------------------ */

/** Pulsing placeholder block; replaces bare spinners for content loading. */
export function Skeleton({
  theme,
  height = 12,
  width = "100%",
  radius = uiMetrics.controlRadius,
  style,
}: {
  theme: PluginTheme;
  height?: number;
  width?: DimensionValue;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const palette = useMemo(() => paletteOf(theme), [theme]);
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { duration: 700, toValue: 0.45, useNativeDriver: true }),
        Animated.timing(opacity, { duration: 700, toValue: 1, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={[
        { backgroundColor: palette.control, borderRadius: radius, height, opacity, width },
        style,
      ]}
    />
  );
}

const skeletonRowWidths = ["88%", "72%", "80%", "64%"] as const;

/** Stacked list-row skeleton with a title line and a shorter meta line. */
export function SkeletonRows({
  theme,
  rows = 3,
  style,
}: {
  theme: PluginTheme;
  rows?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[{ gap: 4 }, style]}>
      {Array.from({ length: rows }, (_, index) => (
        <View key={index} style={{ gap: 6, paddingHorizontal: 4, paddingVertical: 10 }}>
          <Skeleton
            height={14}
            theme={theme}
            width={skeletonRowWidths[index % skeletonRowWidths.length]}
          />
          <Skeleton height={12} theme={theme} width="52%" />
        </View>
      ))}
    </View>
  );
}
