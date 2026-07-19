import type { Prisma } from "@prisma/client";

type Db = {
  user: {
    findFirst: (args: {
      where: { id: string; societyId: string };
      select: {
        name: true;
        username: true;
        isActive: true;
        villa: { select: { villaNumber: true } };
      };
    }) => Promise<{
      name: string;
      username: string;
      isActive: boolean;
      villa: { villaNumber: string } | null;
    } | null>;
  };
};

export type AnalyticsUserSnapshot = {
  userName: string | null;
  username: string | null;
  villaNumber: string | null;
  userIsActive: boolean;
};

export async function loadAnalyticsUserSnapshot(
  db: Db,
  societyId: string,
  userId: string,
): Promise<AnalyticsUserSnapshot> {
  const user = await db.user.findFirst({
    where: { id: userId, societyId },
    select: {
      name: true,
      username: true,
      isActive: true,
      villa: { select: { villaNumber: true } },
    },
  });
  if (!user) {
    return {
      userName: null,
      username: null,
      villaNumber: null,
      userIsActive: true,
    };
  }
  return {
    userName: user.name,
    username: user.username,
    villaNumber: user.villa?.villaNumber ?? null,
    userIsActive: user.isActive,
  };
}

export function mergeUserIntoProperties(
  snapshot: AnalyticsUserSnapshot,
  userId: string,
  role: string,
  extra?: Record<string, unknown>,
): Prisma.InputJsonValue {
  return {
    ...(extra ?? {}),
    userId,
    role,
    userName: snapshot.userName,
    username: snapshot.username,
    villaNumber: snapshot.villaNumber,
    userIsActive: snapshot.userIsActive,
  } as Prisma.InputJsonValue;
}
