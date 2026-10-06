import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UserRole } from "@prisma/client";
import type { Request } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import { signAuthToken } from "../utils/jwt";
import { userOrIpKey } from "./rateLimiter";

function req(opts: { ip?: string; authorization?: string; auth?: { userId: string } }): Request {
  return {
    ip: opts.ip ?? "203.0.113.7",
    headers: { authorization: opts.authorization },
    auth: opts.auth,
  } as unknown as Request;
}

const tokenFor = (userId: string) =>
  signAuthToken({ userId, role: UserRole.RESIDENT, societyId: "society-1", villaId: null });

describe("userOrIpKey (global API rate limit key)", () => {
  it("gives two people on the same Wi-Fi address separate budgets", () => {
    const a = userOrIpKey(req({ authorization: `Bearer ${tokenFor("user-a")}` }));
    const b = userOrIpKey(req({ authorization: `Bearer ${tokenFor("user-b")}` }));
    assert.equal(a, "user-a");
    assert.equal(b, "user-b");
    assert.notEqual(a, b);
  });

  it("uses the already-authenticated user when there is one", () => {
    assert.equal(userOrIpKey(req({ auth: { userId: "user-c" } })), "user-c");
  });

  it("counts a request with no token against its IP", () => {
    assert.equal(userOrIpKey(req({ ip: "198.51.100.4" })), "198.51.100.4");
  });

  it("cannot be dodged with a forged or garbage token", () => {
    const garbage = userOrIpKey(req({ ip: "198.51.100.9", authorization: "Bearer not-a-real-token" }));
    const forged = userOrIpKey(
      req({ ip: "198.51.100.9", authorization: `Bearer ${jwt.sign({ userId: "victim" }, "some-other-secret")}` }),
    );
    assert.equal(garbage, "198.51.100.9");
    assert.equal(forged, "198.51.100.9");
  });

  it("falls back to the IP for an expired token", () => {
    const expired = jwt.sign({ userId: "user-d" }, env.JWT_SECRET, { expiresIn: -60 });
    assert.equal(userOrIpKey(req({ ip: "198.51.100.5", authorization: `Bearer ${expired}` })), "198.51.100.5");
  });
});
