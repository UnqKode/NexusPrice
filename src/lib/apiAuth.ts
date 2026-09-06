
import { NextRequest } from "next/server";
import { getServerSession } from "next-auth"; // sever the session from next-auth : username and password
import { authOptions } from "./authOptions";

export type ApiKeyScope = "read" | "admin";

export interface ApiKeyRecord { //typesafety
  key: string;
  scope: ApiKeyScope;
}

export type AuthResult = //typesafety
  | { ok: true; record: ApiKeyRecord }
  | { ok: false; status: 401; message: string };

let cachedKeys: Map<string, ApiKeyRecord> | null = null;   // map  key : {key : role}

function loadApiKeys(): Map<string, ApiKeyRecord> { // load the api key string and slice them into a map with key : role
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

export function resetApiKeyCacheForTests(): void { // reset api keys cache
  cachedKeys = null;
}

//authenticate api key only
export function authenticateRequest(request: NextRequest): AuthResult { 
  const key = request.headers.get("x-api-key");
  if (!key) {
    return { ok: false, status: 401, message: "Missing x-api-key header" }; // if key is not found 
  }
  const record = loadApiKeys().get(key);
  if (!record) {
    return { ok: false, status: 401, message: "Invalid API key" };  // invalid api key
  }
  return { ok: true, record };
}

export function isAdmin(record: ApiKeyRecord): boolean {
  return record.scope === "admin";
}


export interface AuthenticatedIdentity { //authenticate via api key or session
  id: string;
  scope: ApiKeyScope;
  via: "api-key" | "session";
}

export type RouteAuthResult =
  | { ok: true; identity: AuthenticatedIdentity }
  | { ok: false; status: 401; message: string };

//authenticate via apikey or session
export async function authenticateRequestOrSession(request: NextRequest): Promise<RouteAuthResult> {
  const apiKeyResult = authenticateRequest(request);
  if (apiKeyResult.ok) {
    return {
      ok: true,
      identity: { id: apiKeyResult.record.key, scope: apiKeyResult.record.scope, via: "api-key" }, // authenticated via api key
    };
  }


  const session = await getServerSession(authOptions);
  if (session?.user?.email) { // authenticates via session
    return {
      ok: true,
      identity: { id: `session:${session.user.email}`, scope: "admin", via: "session" },
    };
  }

  return { // neither api key nor session found
    ok: false,
    status: 401,
    message: "Missing or invalid x-api-key, and no active dashboard session",
  };
}
