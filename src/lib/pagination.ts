import type { Request } from "express";
import { z } from "zod";

/**
 * Shared pagination shape for `findMany` list endpoints. Caps `limit` at 200
 * so a misconfigured client (or an attacker) can't ask for the full table.
 *
 * Default response shape on the wire:
 *   { items: T[], total: number, limit: number, offset: number, hasMore: boolean }
 *
 * Existing endpoints that already wrap their list under a domain key
 * (e.g. `{ visitors: [...] }`) can keep their wrapper key for backwards
 * compatibility — the helper only enforces server-side bounds.
 */
const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type Pagination = {
  take: number;
  skip: number;
  limit: number;
  offset: number;
};

/**
 * Parses `?limit=` and `?offset=` from the request, applying defaults and
 * the hard cap. Throws a [ZodError] if either value is malformed; the
 * global error handler then returns 400 with the issue list.
 */
export function getPagination(req: Request): Pagination {
  const parsed = paginationSchema.parse({
    limit: req.query.limit,
    offset: req.query.offset,
  });
  return {
    take: parsed.limit,
    skip: parsed.offset,
    limit: parsed.limit,
    offset: parsed.offset,
  };
}

/**
 * Builds the metadata block for a paginated response. Spread it alongside
 * the existing domain key, e.g.
 *   res.json({ complaints, ...paginationMeta(total, items.length, pagination) })
 * so existing clients keep working and new clients can consume `total` /
 * `hasMore` for paginated UIs.
 */
export function paginationMeta(
  total: number,
  pageSize: number,
  pagination: Pagination,
) {
  return {
    total,
    limit: pagination.limit,
    offset: pagination.offset,
    hasMore: pagination.offset + pageSize < total,
  };
}
