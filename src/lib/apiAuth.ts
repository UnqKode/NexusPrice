// API-key authentication via an env-var allowlist, not hashed keys in
// Mongo. Chosen deliberately: this project has no user accounts, no
// self-service key issuance flow, and no demonstrated multi-tenant need -
// the realistic holders of a key are the developer and a small number of
// trusted callers. Mongo-hashed keys would mean building issuance, storage,
// and revocation infrastructure for a need that doesn't exist yet; an
// env-var allowlist needs none of that and treats keys as secrets the same
// way MONGODB_URI/ALCHEMY_API_KEY already are. The tradeoff being accepted:
// keys live in plaintext in .env, not hashed, and rotating one means a
// redeploy, not an API call - correct for single-tenant, wrong the moment
// this needs self-service issuance or a per-key audit trail, at which
// point Mongo-hashed keys are the right upgrade, not a nice-to-have.
import { NextRequest } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "./authOptions";

export type ApiKeyScope = "read" | "admin";

export interface ApiKeyRecord {
  key: string;
  scope: ApiKeyScope;
}

export type AuthResult =
  | { ok: true; record: ApiKeyRecord }
  | { ok: false; status: 401; message: string };

// API_KEYS format: comma-separated `key` or `key:scope` pairs, e.g.
// "abc123,def456:admin". A bare key (no ":scope") defaults to "read".
// Parsed lazily and cached at module scope rather than on every request -
// this only changes when the process restarts (a new .env requires a
// restart anyway), so there's no correctness reason to re-parse per call.
let cachedKeys: Map<string, ApiKeyRecord> | null = null;

function loadApiKeys(): Map<string, ApiKeyRecord> {
  if (cachedKeys) return cachedKeys;

  const raw = process.env.API_KEYS ?? "";
  const map = new Map<string, ApiKeyRecord>();

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const [key, scopeRaw] = trimmed.split(":");
    const scope: ApiKeyScope = scopeRaw === "admin" ? "admin" : "read";
    map.set(key, { key, scope });
  }

  cachedKeys = map;
  return map;
}

// Test-only: forces the next call to loadApiKeys() to re-parse
// process.env.API_KEYS instead of returning the cached Map from a
// previous test's env.
export function resetApiKeyCacheForTests(): void {
  cachedKeys = null;
}

export function authenticateRequest(request: NextRequest): AuthResult {
  const key = request.headers.get("x-api-key");

  if (!key) {
    return { ok: false, status: 401, message: "Missing x-api-key header" };
  }

  const record = loadApiKeys().get(key);
  if (!record) {
    return { ok: false, status: 401, message: "Invalid API key" };
  }

  return { ok: true, record };
}

export function isAdmin(record: ApiKeyRecord): boolean {
  return record.scope === "admin";
}

// The identity a request authenticated as, regardless of which mechanism
// proved it - `id` is what rate limiting keys off of, so an api-key and a
// session both need a stable, unique-enough identifier.
export interface AuthenticatedIdentity {
  id: string;
  scope: ApiKeyScope;
  via: "api-key" | "session";
}

export type RouteAuthResult =
  | { ok: true; identity: AuthenticatedIdentity }
  | { ok: false; status: 401; message: string };

/**
 * The auth check every API route uses: a valid x-api-key (for
 * external/programmatic callers), OR a valid next-auth dashboard session
 * (for the dashboard UI's own same-origin requests, which never carry an
 * x-api-key - see the "why next-auth, not remove it" note in authOptions.ts).
 * A session is always treated as admin-scoped: this project has exactly
 * one credential pair (DASHBOARD_USERNAME/PASSWORD), so anyone with a
 * valid session IS the admin - a real multi-user setup would derive scope
 * from the session's own role/claims instead of hardcoding this.
 */
export async function authenticateRequestOrSession(request: NextRequest): Promise<RouteAuthResult> {
  const apiKeyResult = authenticateRequest(request);
  if (apiKeyResult.ok) {
    return {
      ok: true,
      identity: { id: apiKeyResult.record.key, scope: apiKeyResult.record.scope, via: "api-key" },
    };
  }

  const session = await getServerSession(authOptions);
  if (session?.user?.email) {
    return {
      ok: true,
      identity: { id: `session:${session.user.email}`, scope: "admin", via: "session" },
    };
  }

  return {
    ok: false,
    status: 401,
    message: "Missing or invalid x-api-key, and no active dashboard session",
  };
}
