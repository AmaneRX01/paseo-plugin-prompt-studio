const TAG_SEPARATOR = "/";

export interface ParsedTagPath {
  path: string;
  key: string;
  segments: readonly string[];
  segmentKeys: readonly string[];
}

export interface TagTreeNode {
  name: string;
  path: string;
  count: number;
  directCount: number;
  children: TagTreeNode[];
}

export interface Taggable {
  readonly tags: readonly string[];
}

export interface RemoveTagsOptions {
  includeDescendants?: boolean;
}

export interface TagBatchChange extends RemoveTagsOptions {
  add?: readonly string[];
  remove?: readonly string[];
}

interface MutableTagTreeNode {
  key: string;
  name: string;
  path: string;
  count: number;
  directCount: number;
  childKeys: Set<string>;
}

export function foldCaseInsensitive(value: string): string {
  // The upper/lower round trip covers Unicode folds such as ß/SS and ς/σ that
  // a single lower-case pass does not. NFC is repeated because case folding can expand text.
  return value.toUpperCase().toLowerCase().normalize("NFC");
}

function compareKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isPathPrefix(candidate: ParsedTagPath, prefix: ParsedTagPath): boolean {
  return candidate.segmentKeys.length >= prefix.segmentKeys.length
    && prefix.segmentKeys.every((segment, index) => candidate.segmentKeys[index] === segment);
}

/**
 * Produces the canonical display path for a tag. Whitespace is trimmed per
 * segment, empty slash segments are discarded, and text is stored as NFC.
 */
export function normalizeTag(tag: string): string {
  return tag
    .normalize("NFC")
    .split(TAG_SEPARATOR)
    .map((segment) => segment.trim().normalize("NFC"))
    .filter(Boolean)
    .join(TAG_SEPARATOR);
}

export const normalizeTagPath = normalizeTag;

/** Returns a normalized path plus its locale-independent, case-insensitive key. */
export function parseTagPath(tag: string): ParsedTagPath | null {
  const path = normalizeTag(tag);
  if (!path) return null;
  const segments = path.split(TAG_SEPARATOR);
  const segmentKeys = segments.map(foldCaseInsensitive);
  return {
    path,
    key: segmentKeys.join(TAG_SEPARATOR),
    segments,
    segmentKeys,
  };
}

/** Invalid or empty paths have the empty key and never match a valid tag. */
export function tagKey(tag: string): string {
  return parseTagPath(tag)?.key ?? "";
}

/**
 * Normalizes a tag set, removes invalid paths, and de-duplicates by key. The
 * first spelling and position are retained as the stable display value.
 */
export function normalizeTags(tags: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    const parsed = parseTagPath(tag);
    if (!parsed || seen.has(parsed.key)) continue;
    seen.add(parsed.key);
    normalized.push(parsed.path);
  }
  return normalized;
}

/** Compares two tag collections as case-insensitive, order-independent sets. */
export function sameTagSet(left: readonly string[], right: readonly string[]): boolean {
  const leftKeys = new Set(normalizeTags(left).map(tagKey));
  const rightKeys = new Set(normalizeTags(right).map(tagKey));
  if (leftKeys.size !== rightKeys.size) return false;
  return [...leftKeys].every((key) => rightKeys.has(key));
}

/** True when tag is the selected path itself or one of its descendants. */
export function tagMatchesPath(tag: string, selectedPath: string): boolean {
  const candidate = parseTagPath(tag);
  const selected = parseTagPath(selectedPath);
  return Boolean(candidate && selected && isPathPrefix(candidate, selected));
}

/**
 * Implements tag-filter semantics: no selected paths means no restriction;
 * otherwise a draft matches when any of its tags is under any selected path.
 */
export function tagsMatchAnyPath(
  tags: readonly string[],
  selectedPaths: readonly string[],
): boolean {
  const selections = normalizeTags(selectedPaths);
  if (selections.length === 0) return true;
  return normalizeTags(tags).some((tag) => selections.some((path) => tagMatchesPath(tag, path)));
}

/** Filters taggable entities with parent-includes-descendants and OR semantics. */
export function filterByTagPaths<T extends Taggable>(
  items: readonly T[],
  selectedPaths: readonly string[],
): T[] {
  return items.filter((item) => tagsMatchAnyPath(item.tags, selectedPaths));
}

/**
 * Builds a hierarchical tag directory. directCount counts drafts carrying the
 * exact tag; count counts unique drafts carrying that tag or any descendant.
 */
export function buildTagTree(drafts: readonly Taggable[]): TagTreeNode[] {
  const nodes = new Map<string, MutableTagTreeNode>();
  const rootKeys = new Set<string>();

  for (const draft of drafts) {
    const directKeys = new Set<string>();
    const aggregateKeys = new Set<string>();

    for (const tag of normalizeTags(draft.tags)) {
      const parsed = parseTagPath(tag);
      if (!parsed) continue;

      for (let depth = 1; depth <= parsed.segments.length; depth += 1) {
        const segments = parsed.segments.slice(0, depth);
        const segmentKeys = parsed.segmentKeys.slice(0, depth);
        const key = segmentKeys.join(TAG_SEPARATOR);
        const parentKey = segmentKeys.slice(0, -1).join(TAG_SEPARATOR);

        if (!nodes.has(key)) {
          const parent = parentKey ? nodes.get(parentKey) : null;
          const name = segments[segments.length - 1];
          nodes.set(key, {
            key,
            name,
            path: parent ? `${parent.path}${TAG_SEPARATOR}${name}` : name,
            count: 0,
            directCount: 0,
            childKeys: new Set<string>(),
          });
          if (parent) parent.childKeys.add(key);
          else rootKeys.add(key);
        }

        aggregateKeys.add(key);
        if (depth === parsed.segments.length) directKeys.add(key);
      }
    }

    for (const key of directKeys) {
      const node = nodes.get(key);
      if (node) node.directCount += 1;
    }
    for (const key of aggregateKeys) {
      const node = nodes.get(key);
      if (node) node.count += 1;
    }
  }

  const materialize = (key: string): TagTreeNode => {
    const node = nodes.get(key);
    if (!node) throw new Error(`Missing tag-tree node: ${key}`);
    return {
      name: node.name,
      path: node.path,
      count: node.count,
      directCount: node.directCount,
      children: [...node.childKeys].sort(compareKeys).map(materialize),
    };
  };

  return [...rootKeys].sort(compareKeys).map(materialize);
}

/** Adds one or more tags, preserving existing display spellings on conflicts. */
export function addTags(tags: readonly string[], additions: readonly string[]): string[] {
  return normalizeTags([...tags, ...additions]);
}

/** Removes tags case-insensitively, optionally including every descendant. */
export function removeTags(
  tags: readonly string[],
  removals: readonly string[],
  options: RemoveTagsOptions = {},
): string[] {
  const removalPaths = normalizeTags(removals);
  if (removalPaths.length === 0) return normalizeTags(tags);
  return normalizeTags(tags).filter((tag) => !removalPaths.some((path) => (
    options.includeDescendants ? tagMatchesPath(tag, path) : tagKey(tag) === tagKey(path)
  )));
}

/** Applies a bulk remove-then-add operation; additions win when both lists overlap. */
export function applyTagBatch(tags: readonly string[], change: TagBatchChange): string[] {
  const remaining = removeTags(tags, change.remove ?? [], {
    includeDescendants: change.includeDescendants,
  });
  return addTags(remaining, change.add ?? []);
}

/**
 * Renames an exact path and its full subtree. A case-insensitive destination
 * collision is folded into the existing set automatically.
 */
export function renameTagPath(
  tags: readonly string[],
  fromPath: string,
  toPath: string,
): string[] {
  const from = parseTagPath(fromPath);
  const to = parseTagPath(toPath);
  const current = normalizeTags(tags);
  if (!from || !to) return current;

  return normalizeTags(current.map((tag) => {
    const parsed = parseTagPath(tag);
    if (!parsed || !isPathPrefix(parsed, from)) return tag;
    const suffix = parsed.segments.slice(from.segments.length);
    return [...to.segments, ...suffix].join(TAG_SEPARATOR);
  }));
}
