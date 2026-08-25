import type { Checkpoint, DraftId, DraftScope, TimelineEntry } from "../../shared/contracts.shared";
import type { I18n, MessageKey } from "../i18n.client";

const DRAFT_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function draftDisplayCode(draftId: DraftId): string {
  const randomHex = draftId.slice(-6);
  return [0, 2, 4]
    .map((offset) => DRAFT_CODE_ALPHABET[Number.parseInt(randomHex.slice(offset, offset + 2), 16) & 31])
    .join("");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatWhen(locale: string, iso: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function dateHeading(locale: string, value: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(new Date(`${value}T12:00:00`));
  } catch {
    return value;
  }
}

export function localDayKey(value: string, timeZone?: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    }).formatToParts(new Date(value));
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    return year && month && day ? `${year}-${month}-${day}` : value.slice(0, 10);
  } catch {
    return value.slice(0, 10);
  }
}

export function scopeLabel(t: I18n["t"], scope: DraftScope): string {
  if (!scope.projectId) return t("scope.inbox");
  return scope.projectName ?? t("scope.project");
}

export function checkpointReasonKey(reason: Checkpoint["reason"]): MessageKey {
  switch (reason) {
    case "ready": return "checkpoint.reason.ready";
    case "periodic": return "checkpoint.reason.periodic";
    case "scope": return "checkpoint.reason.scope";
    case "send": return "checkpoint.reason.send";
    case "external-edit": return "checkpoint.reason.externalEdit";
    case "restore": return "checkpoint.reason.restore";
  }
}

export function timelineLabelKey(type: TimelineEntry["type"]): MessageKey {
  switch (type) {
    case "draft": return "timeline.draft";
    case "update": return "timeline.update";
    case "scope": return "timeline.scope";
    case "status": return "timeline.status";
    case "checkpoint": return "timeline.checkpoint";
    case "pending": return "timeline.pending";
    case "sent": return "timeline.sent";
    case "failed": return "timeline.failed";
    case "session": return "timeline.session";
    case "worklog": return "timeline.worklog";
  }
}

export function displayTitle(t: I18n["t"], title: string): string {
  return !title || title === "Untitled" ? t("drafts.untitled") : title;
}
