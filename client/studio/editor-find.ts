export interface TextRange {
  start: number;
  end: number;
}

/** Literal, case-insensitive matches with offsets usable by TextInput.selection. */
export function findTextMatches(text: string, query: string): TextRange[] {
  if (!query) return [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(escaped, "gi");
  const matches: TextRange[] = [];
  for (const match of text.matchAll(expression)) {
    matches.push({ start: match.index, end: match.index + match[0].length });
  }
  return matches;
}

export function stepMatchIndex(current: number, count: number, step: -1 | 1): number {
  if (!count) return -1;
  if (current < 0) return step === 1 ? 0 : count - 1;
  return (current + step + count) % count;
}

export function replaceTextMatch(text: string, range: TextRange, replacement: string): string {
  return text.slice(0, range.start) + replacement + text.slice(range.end);
}

export function replaceAllTextMatches(text: string, matches: readonly TextRange[], replacement: string): string {
  if (!matches.length) return text;
  const pieces: string[] = [];
  let previousEnd = 0;
  for (const range of matches) {
    pieces.push(text.slice(previousEnd, range.start), replacement);
    previousEnd = range.end;
  }
  pieces.push(text.slice(previousEnd));
  return pieces.join("");
}
