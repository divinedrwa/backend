import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseCookieHeader,
  readBearerOrCookieToken,
  readRefreshTokenFromCookie,
} from "./tenantAuthCookie.js";

describe("tenantAuthCookie", () => {
  it("parseCookieHeader decodes values", () => {
    const cookies = parseCookieHeader("tenant_token=abc%20123; other=x");
    assert.equal(cookies.tenant_token, "abc 123");
    assert.equal(cookies.other, "x");
  });

  it("readBearerOrCookieToken prefers Bearer", () => {
    const token = readBearerOrCookieToken("Bearer from-header", "tenant_token=from-cookie");
    assert.equal(token, "from-header");
  });

  it("readRefreshTokenFromCookie returns null when httponly auth disabled", () => {
    const prev = process.env.TENANT_HTTPONLY_AUTH;
    process.env.TENANT_HTTPONLY_AUTH = "false";
    process.env.NODE_ENV = "test";
    try {
      assert.equal(readRefreshTokenFromCookie("tenant_refresh=rt"), null);
    } finally {
      process.env.TENANT_HTTPONLY_AUTH = prev;
    }
  });
});
