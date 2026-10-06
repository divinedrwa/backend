import { UserRole } from "@prisma/client";
import type { Pagination } from "../../lib/pagination";

/** A gate has to be able to pick any flat, so the guard's list is capped far above a real society. */
export const GUARD_VILLA_LIST_CAP = 1000;

/**
 * Page of `GET /villas` to return.
 *
 * The guard app loads every flat in one call and sends no `limit`; the default page of 50 would
 * silently drop every flat after the 50th (the last block) in a larger society. A guard that sends
 * no paging parameters therefore gets everything up to [GUARD_VILLA_LIST_CAP]; everyone else, and a
 * guard that does ask for a page, gets the normal paging.
 */
export function resolveVillaListPagination(
  role: string | undefined,
  query: { limit?: unknown; offset?: unknown },
  requested: Pagination,
): Pagination {
  const guardWantsAll = role === UserRole.GUARD && query.limit === undefined && query.offset === undefined;
  return guardWantsAll
    ? { take: GUARD_VILLA_LIST_CAP, skip: 0, limit: GUARD_VILLA_LIST_CAP, offset: 0 }
    : requested;
}
