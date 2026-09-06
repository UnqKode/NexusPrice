import { NextRequest, NextResponse } from "next/server"; //typeSafety for typeScript
import { authenticateRequestOrSession, isAdmin, type AuthenticatedIdentity } from "./apiAuth"; // serves a method to authenticate via api key or active session (userID or session)
import { checkRateLimit, rateLimitHeaders, type RateLimitRedis } from "./rateLimit"; // a simple rate limiter using redis and header generation for rate limit info

export interface GuardOptions {
  routeName: string; // a unique name for the route, used to generate a rate limit key
  limit: number; // the maximum number of requests allowed in the window
  windowSeconds: number; // the length of the window in seconds
  requireAdmin?: boolean; // whether the route requires an admin-scoped API key or dashboard session
  failClosedOnRedisError?: boolean;
}

export type GuardResult =
  | { ok: true; identity: AuthenticatedIdentity; headers: Record<string, string> }
  | { ok: false; response: NextResponse };

export async function guardRoute(
  request: NextRequest,
  redis: RateLimitRedis,
  options: GuardOptions
): Promise<GuardResult> {

  const auth = await authenticateRequestOrSession(request); //authenticate the request or session, returning an object with ok, message, status, and identity if successful
  if (!auth.ok) { // no session or api key found, or invalid api key, return 401 with message
    return {
      ok: false,
      response: NextResponse.json({ success: false, message: auth.message }, { status: auth.status }),
    };
  }

  const { identity } = auth;

  if (options.requireAdmin && !isAdmin({ key: identity.id, scope: identity.scope })) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, message: "This endpoint requires an admin-scoped API key or dashboard session" },
        { status: 403 }
      ),
    };
  }

  const rateLimitKey = `${options.routeName}:${identity.id}`;
  const rateLimit = await checkRateLimit(redis, rateLimitKey, options.limit, options.windowSeconds, { // return {true , false} if the request is allowed or not, and some metadata about the rate limit
    failClosed: options.failClosedOnRedisError,
  });
  const headers = rateLimitHeaders(rateLimit); // convert the rate limit result into headers to be sent back to the client

  if (!rateLimit.allowed) {
    const status = rateLimit.redisUnavailable ? 503 : 429;
    const message = rateLimit.redisUnavailable
      ? "Rate limiter temporarily unavailable, try again shortly"
      : "Rate limit exceeded";
    return {
      ok: false,
      response: NextResponse.json({ success: false, message }, { status, headers }),
    };
  }

  return { ok: true, identity, headers };
}
