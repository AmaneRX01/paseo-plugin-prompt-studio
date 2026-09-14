export function isAllSelected(
  selectedIds: readonly string[],
  optionIds: readonly string[],
): boolean {
  if (selectedIds.length !== optionIds.length) return false;
  const selected = new Set(selectedIds);
  return optionIds.every((id) => selected.has(id));
}

export function toggleFilterSelection(
  selectedIds: readonly string[],
  id: string,
  optionIds: readonly string[],
): string[] {
  const selected = new Set(selectedIds.filter((selectedId) => optionIds.includes(selectedId)));
  if (selected.has(id)) selected.delete(id);
  else if (optionIds.includes(id)) selected.add(id);
  return optionIds.filter((optionId) => selected.has(optionId));
}

/**
 * Facet controls render the unrestricted state as no active buttons, even
 * when the query contract represents that state by sending every option.
 */
export function activeFilterSelection(
  selectedIds: readonly string[],
  optionIds: readonly string[],
): string[] {
  if (isAllSelected(selectedIds, optionIds)) return [];
  const selected = new Set(selectedIds);
  return optionIds.filter((id) => selected.has(id));
}

/**
 * Toggle an inclusion facet while reserving both zero and every option for
 * the same unrestricted state. This is useful for contracts such as Status,
 * where sending every option is equivalent to applying no filter.
 */
export function toggleActiveFilterSelection(
  selectedIds: readonly string[],
  id: string,
  optionIds: readonly string[],
): string[] {
  const active = activeFilterSelection(selectedIds, optionIds);
  const next = toggleFilterSelection(active, id, optionIds);
  return next.length === 0 || isAllSelected(next, optionIds) ? [...optionIds] : next;
}

/**
 * Render a nullable inclusion facet. `null` is unrestricted, while an array
 * containing every visible option remains a real filter (for example, all
 * projects still excludes Inbox).
 */
export function activeNullableFilterSelection(
  selectedIds: readonly string[] | null,
  optionIds: readonly string[],
): string[] {
  if (selectedIds === null) return [];
  const selected = new Set(selectedIds);
  return optionIds.filter((id) => selected.has(id));
}

export function toggleNullableFilterSelection(
  selectedIds: readonly string[] | null,
  id: string,
  optionIds: readonly string[],
): string[] | null {
  const next = toggleFilterSelection(
    activeNullableFilterSelection(selectedIds, optionIds),
    id,
    optionIds,
  );
  return next.length ? next : null;
}

export function normalizeNullableFilterSelection(
  selectedIds: readonly string[] | null,
  optionIds: readonly string[],
): string[] | null {
  if (selectedIds === null) return null;
  const active = activeNullableFilterSelection(selectedIds, optionIds);
  return active.length ? active : null;
}
