/**
 * Read an ordered set to its end, one range at a time.
 *
 * A search decision is only as complete as what it read. One unpaged query
 * is cut silently by the server's row cap (PostgREST max-rows), and the
 * rows that fall outside change the answer: a node is never considered, an
 * affirmed claim is never seen, a contradicting row is never seen.
 *
 * `fetchRange(from, to)` must return rows `from..to` (inclusive) of ONE
 * fixed, total order. The read ends on an empty range, not a short one (a
 * row cap makes ranges short long before the end). A failed range fails the
 * whole read: a partial set is never presented as the set.
 *
 * Same contract as hemmabo-smart-stays contracts/ts/neutral-paging-core.ts
 * (readAllInOrder).
 */
export const READ_PAGE = 1000;

/** Ids per `in (...)` list: keeps the request line short. */
export const ID_BATCH = 100;

export type RangeResult<T> = { data: T[] | null; error: { message?: string } | null };

export async function readAllInOrder<T>(
  fetchRange: (from: number, to: number) => PromiseLike<RangeResult<T>>,
  size = READ_PAGE,
): Promise<{ failed: boolean; rows: T[]; message?: string }> {
  const rows: T[] = [];
  for (;;) {
    let page: RangeResult<T>;
    try {
      page = await fetchRange(rows.length, rows.length + size - 1);
    } catch (e) {
      return { failed: true, rows: [], message: e instanceof Error ? e.message : String(e) };
    }
    if (page.error || !Array.isArray(page.data)) {
      return { failed: true, rows: [], message: page.error?.message ?? "no rows returned" };
    }
    if (page.data.length === 0) return { failed: false, rows };
    rows.push(...page.data);
  }
}
