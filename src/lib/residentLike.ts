import { UserRole } from "@prisma/client";

/** Roles that can occupy a villa and use resident-facing app features. */
export const RESIDENT_LIKE_ROLES: UserRole[] = [UserRole.RESIDENT, UserRole.ADMIN];

export function isResidentLikeRole(role: UserRole): boolean {
  return role === UserRole.RESIDENT || role === UserRole.ADMIN;
}

/** Prisma `where.role` filter for villa occupants (notifications, visitor approval, etc.). */
export const residentLikeRoleFilter = {
  role: { in: RESIDENT_LIKE_ROLES },
} as const;
