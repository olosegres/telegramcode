/**
 * @description Generic pagination math shared by every inline-keyboard picker
 * (`/bind` folders, `/model` models). Extracted from `paginateBindList` so the
 * slice/clamp rules live in ONE place — a second picker must not re-derive
 * them and drift (e.g. clamp a stale page to an empty slice instead of the
 * last page).
 */

export interface PaginatedSlice<T> {
  /** Entries visible on the resolved page. */
  slice: T[];
  /** `page` clamped to `[0, totalPages-1]` and floored to an integer. */
  currentPage: number;
  /** Total number of pages, ≥ 1 even for an empty list. */
  totalPages: number;
}

/**
 * @description Slice `items` into the page the caller asked for.
 *
 * `pageSize` must be a positive integer. Out-of-range `page` values are clamped
 * silently rather than throwing — a stale callback (the underlying list shrank
 * between rendering the keyboard and the tap) must land on the last available
 * page, not blow up or render an empty body.
 */
export function paginateList<T>(
  items: readonly T[],
  page: number,
  pageSize: number,
): PaginatedSlice<T> {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(`paginateList: pageSize must be a positive integer, got ${pageSize}`);
  }
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const clampedPage = Math.max(0, Math.min(Math.floor(page) || 0, totalPages - 1));
  const start = clampedPage * pageSize;
  return {
    slice: items.slice(start, start + pageSize),
    currentPage: clampedPage,
    totalPages,
  };
}
