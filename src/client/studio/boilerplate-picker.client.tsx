import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useI18n } from "../i18n.client";
import {
  Card,
  FieldLabel,
  Hint,
  NativeButton,
  NativeDialog,
  NativeTextInput,
  font,
} from "../ui.client";
import { replaceBoilerplates, useBoilerplates } from "./boilerplate-preferences.client";

export function BoilerplatePicker({
  theme,
  compact,
  disabled,
  onInsert,
}: {
  theme: PluginTheme;
  compact: boolean;
  disabled?: boolean;
  onInsert: (boilerplate: string) => void;
}) {
  const { t } = useI18n();
  const boilerplates = useBoilerplates();
  const [open, setOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | "new" | null>(null);
  const [editingValue, setEditingValue] = useState("");

  useEffect(() => {
    if (!disabled) return;
    setOpen(false);
    setEditingIndex(null);
    setEditingValue("");
  }, [disabled]);

  function close() {
    setOpen(false);
    setEditingIndex(null);
    setEditingValue("");
  }

  function beginEdit(index: number) {
    setEditingIndex(index);
    setEditingValue(boilerplates[index] ?? "");
  }

  function saveEdit() {
    const value = editingValue.trim();
    if (!value) return;
    if (editingIndex === "new") {
      replaceBoilerplates([...boilerplates, value]);
    } else if (editingIndex !== null) {
      replaceBoilerplates(boilerplates.map((current, index) => index === editingIndex ? value : current));
    }
    setEditingIndex(null);
    setEditingValue("");
  }

  return (
    <>
      <NativeButton
        disabled={disabled}
        label={t("boilerplate.action")}
        onPress={() => setOpen(true)}
        small
        style={compact ? { flexGrow: 1 } : undefined}
        theme={theme}
        variant="outline"
      />
      <NativeDialog
        accessibilityLabel={t("boilerplate.close")}
        compact={compact}
        description={t("boilerplate.help")}
        onClose={close}
        theme={theme}
        title={t("boilerplate.title")}
        visible={open}
      >
        <ScrollView
          contentContainerStyle={{ gap: 8, paddingBottom: 2, paddingRight: compact ? 2 : 6 }}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
          persistentScrollbar
          showsVerticalScrollIndicator
          style={{ flexShrink: 1, maxHeight: compact ? 300 : 420, minHeight: 0 }}
        >
          {boilerplates.map((boilerplate, index) => (
            <Card key={`${index}:${boilerplate}`} theme={theme}>
              <Text selectable style={{ color: theme.colors.foreground, fontSize: font.body, lineHeight: 21 }}>
                {boilerplate}
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                <NativeButton
                  label={t("boilerplate.insert")}
                  onPress={() => {
                    onInsert(boilerplate);
                    close();
                  }}
                  small
                  theme={theme}
                />
                <NativeButton
                  accessibilityLabel={t("boilerplate.editItem", { number: index + 1 })}
                  label={t("boilerplate.edit")}
                  onPress={() => beginEdit(index)}
                  small
                  theme={theme}
                  variant="outline"
                />
                <NativeButton
                  accessibilityLabel={t("boilerplate.deleteItem", { number: index + 1 })}
                  label={t("boilerplate.delete")}
                  onPress={() => {
                    replaceBoilerplates(boilerplates.filter((_, itemIndex) => itemIndex !== index));
                    if (editingIndex === index) {
                      setEditingIndex(null);
                      setEditingValue("");
                    } else if (typeof editingIndex === "number" && editingIndex > index) {
                      setEditingIndex(editingIndex - 1);
                    }
                  }}
                  small
                  theme={theme}
                  variant="danger"
                />
              </View>
            </Card>
          ))}
          {!boilerplates.length ? <Hint theme={theme}>{t("boilerplate.empty")}</Hint> : null}
        </ScrollView>

        {editingIndex !== null ? (
          <Card theme={theme}>
            <FieldLabel theme={theme}>{t("boilerplate.text")}</FieldLabel>
            <NativeTextInput
              accessibilityLabel={t("boilerplate.text")}
              autoFocus
              multiline
              onChangeText={setEditingValue}
              placeholder={t("boilerplate.placeholder")}
              style={{ minHeight: compact ? 84 : 108 }}
              theme={theme}
              value={editingValue}
            />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <NativeButton
                disabled={!editingValue.trim()}
                label={t("boilerplate.save")}
                onPress={saveEdit}
                small
                theme={theme}
              />
              <NativeButton
                label={t("boilerplate.cancel")}
                onPress={() => {
                  setEditingIndex(null);
                  setEditingValue("");
                }}
                small
                theme={theme}
                variant="ghost"
              />
            </View>
          </Card>
        ) : (
          <NativeButton
            label={t("boilerplate.new")}
            onPress={() => {
              setEditingIndex("new");
              setEditingValue("");
            }}
            small
            theme={theme}
            variant="outline"
          />
        )}
      </NativeDialog>
    </>
  );
}
