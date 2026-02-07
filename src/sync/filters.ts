import picomatch from "picomatch";

import type { Filters } from "../config/types.js";

export function applyFilters(entries: string[], filters: Filters): string[] {
  const include = filters.include.length ? filters.include : ["**"];
  const isIncluded = picomatch(include, { dot: true });
  const isExcluded = filters.exclude.length
    ? picomatch(filters.exclude, { dot: true })
    : () => false;
  return entries.filter((name) => isIncluded(name) && !isExcluded(name));
}
