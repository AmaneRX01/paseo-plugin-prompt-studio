import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useRef, useState } from "react";
import { Platform, View, type TextInput } from "react-native";
import { useI18n } from "../i18n";
import { NativeTextInput, uiMetrics } from "../ui";
import { EditorFindBar } from "./editor-find-bar";
import type { TextRange } from "./editor-find";

interface BrowserFindKeyEvent {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  key: string;
  preventDefault(): void;
  stopPropagation(): void;
}

interface BrowserKeyboardTarget {
  addEventListener(type: "keydown", listener: (event: BrowserFindKeyEvent) => void, capture: boolean): void;
  removeEventListener(type: "keydown", listener: (event: BrowserFindKeyEvent) => void, capture: boolean): void;
}

export function FindableMarkdownInput({
  value,
  onChangeText,
  editable,
  autoFocus,
  compact,
  findOpen,
  onFindOpenChange,
  theme,
}: {
  value: string;
  onChangeText: (value: string) => void;
  editable: boolean;
  autoFocus: boolean;
  compact: boolean;
  findOpen: boolean;
  onFindOpenChange: (open: boolean) => void;
  theme: PluginTheme;
}) {
  const { t } = useI18n();
  const [selection, setSelection] = useState<TextRange | undefined>();
  const inputRef = useRef<TextInput>(null);
  const focused = useRef(false);

  useEffect(() => {
    const browser = (globalThis as typeof globalThis & { window?: BrowserKeyboardTarget }).window;
    if (Platform.OS !== "web" || !browser) return;
    const openFind = (event: BrowserFindKeyEvent) => {
      if (!focused.current || !(event.ctrlKey || event.metaKey)
        || event.altKey || event.key.toLowerCase() !== "f") return;
      event.preventDefault();
      event.stopPropagation();
      onFindOpenChange(true);
    };
    browser.addEventListener("keydown", openFind, true);
    return () => browser.removeEventListener("keydown", openFind, true);
  }, [onFindOpenChange]);

  function selectRange(range: TextRange) {
    inputRef.current?.focus();
    setSelection(range);
  }

  function replaceText(nextText: string, range: TextRange) {
    if (!editable) return;
    onChangeText(nextText);
    selectRange(range);
  }

  return (
    <View style={{ gap: 8 }}>
      {findOpen ? (
        <EditorFindBar
          compact={compact}
          editable={editable}
          onClose={() => onFindOpenChange(false)}
          onReplace={replaceText}
          onSelect={selectRange}
          text={value}
          theme={theme}
        />
      ) : null}
      <NativeTextInput
        accessibilityLabel={t("editor.markdown.placeholder")}
        autoFocus={autoFocus}
        editable={editable}
        inputRef={inputRef}
        multiline
        onBlur={() => { focused.current = false; }}
        onChangeText={(nextValue) => { setSelection(undefined); onChangeText(nextValue); }}
        onFocus={() => { focused.current = true; }}
        onSelectionChange={() => setSelection(undefined)}
        placeholder={t("editor.markdown.placeholder")}
        selection={selection}
        style={{
          fontSize: 15,
          lineHeight: uiMetrics.longformLineHeight,
          minHeight: compact ? 260 : 420,
          paddingHorizontal: 0,
        }}
        theme={theme}
        value={value}
        variant="bare"
      />
    </View>
  );
}
