import { normalizeTags, sameTagSet } from "../../shared/tags.shared";

export interface ResolveTagSetResponseInput {
  previous: readonly string[];
  requested: readonly string[];
  response: readonly string[];
  cached: readonly string[];
  /** Null means the canonical refresh failed; an empty array is a valid refresh result. */
  canonical: readonly string[] | null;
}

/**
 * A canonical refresh always wins. If it failed, a cache value written by a
 * different Tag operation wins over a delayed set response.
 */
export function resolveTagSetResponse(input: ResolveTagSetResponseInput): string[] {
  if (input.canonical !== null) return normalizeTags(input.canonical);
  const cacheAdvanced = !sameTagSet(input.cached, input.previous)
    && !sameTagSet(input.cached, input.requested);
  return normalizeTags(cacheAdvanced ? input.cached : input.response);
}
