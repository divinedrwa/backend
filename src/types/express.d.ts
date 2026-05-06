import { UserRole } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      /** Populated by requireAuth from database (not raw JWT fields). */
      auth?: {
        userId: string;
        role: UserRole;
        /** Real society id for tenants; empty string for SUPER_ADMIN (path-blocked from tenant APIs). */
        societyId: string;
        villaId: string | null;
      };
    }
  }
}

export {};
