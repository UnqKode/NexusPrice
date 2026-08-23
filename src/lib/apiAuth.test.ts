import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { authenticateRequest, isAdmin, resetApiKeyCacheForTests } from "./apiAuth";

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/price", { headers });
}

describe("authenticateRequest", () => {
  const originalApiKeys = process.env.API_KEYS;

  beforeEach(() => {
    resetApiKeyCacheForTests();
  });

  afterEach(() => {
    process.env.API_KEYS = originalApiKeys;
    resetApiKeyCacheForTests();
  });

  it("rejects a request with no x-api-key header", () => {
    process.env.API_KEYS = "abc123";
    const result = authenticateRequest(makeRequest());
    expect(result).toEqual({ ok: false, status: 401, message: "Missing x-api-key header" });
  });

  it("rejects a key that isn't in the allowlist", () => {
    process.env.API_KEYS = "abc123";
    const result = authenticateRequest(makeRequest({ "x-api-key": "not-a-real-key" }));
    expect(result.ok).toBe(false);
  });

  it("accepts a bare key (no :scope) as scope=read", () => {
    process.env.API_KEYS = "abc123";
    const result = authenticateRequest(makeRequest({ "x-api-key": "abc123" }));
    expect(result).toEqual({ ok: true, record: { key: "abc123", scope: "read" } });
  });

  it("parses a :admin suffix as scope=admin", () => {
    process.env.API_KEYS = "abc123:admin";
    const result = authenticateRequest(makeRequest({ "x-api-key": "abc123" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.record.scope).toBe("admin");
  });

  it("parses multiple comma-separated keys with mixed scopes", () => {
    process.env.API_KEYS = "reader-key,admin-key:admin";

    const readerResult = authenticateRequest(makeRequest({ "x-api-key": "reader-key" }));
    const adminResult = authenticateRequest(makeRequest({ "x-api-key": "admin-key" }));

    expect(readerResult.ok && readerResult.record.scope).toBe("read");
    expect(adminResult.ok && adminResult.record.scope).toBe("admin");
  });

  it("rejects everything when API_KEYS is unset", () => {
    delete process.env.API_KEYS;
    const result = authenticateRequest(makeRequest({ "x-api-key": "anything" }));
    expect(result.ok).toBe(false);
  });
});

describe("isAdmin", () => {
  it("is true only for admin-scoped records", () => {
    expect(isAdmin({ key: "k", scope: "admin" })).toBe(true);
    expect(isAdmin({ key: "k", scope: "read" })).toBe(false);
  });
});
