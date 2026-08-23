// Shared auth + rate-limit (+ optional admin) check every API route runs
// first. Extracted because the sequence is identical across every route
// that needs it - authenticate, rate-limit by whoever that identity is,
// optionally require admin scope - not because it's speculative
// abstraction for a need that doesn't exist yet.
import { NextRequest, NextResponse } from "next/server";
import { authenticateRequestOrSession, isAdmin, type AuthenticatedIdentity } from "./apiAuth";
import { checkRateLimit, rateLimitHeaders, type RateLimitRedis } from "./rateLimit";

export interface GuardOptions {
  /**
   * Distinguishes this route's rate-limit budget from every other route's.
   * Required (not optional) on purpose: checkRateLimit's counter key is
   * `ratelimit:<identifier>:<windowBucket>`, so two routes with the same
   * windowSeconds calling it with the same identity would land on the
   * *same* Redis key at the same moment and silently share one budget -
   * e.g. without this, one caller polling /api/schedule/status (120/60s)
   * would also eat into a completely unrelated 60s-windowed route's limit.
   * guardRoute folds this into the identifier so each route gets its own
   * counter per caller. Pick something stable and unique per route, e.g.
   * "price", "historical-prices", "schedule", "schedule-status".
   */
  routeName: string;
  /** Max requests allowed per identity within `windowSeconds`. */
  limit: number;
  windowSeconds: number;
  /** If true, only an admin-scoped identity (an admin API key, or any
   * dashboard session - see apiAuth.ts) passes; anyone else gets 403. */
  requireAdmin?: boolean;
  /** Forwarded to checkRateLimit - see RateLimitOptions.failClosed in
   * rateLimit.ts for what this means and which routes should set it. */
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
  const auth = await authenticateRequestOrSession(request);
  if (!auth.ok) {
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

  // Composing the route into the identifier (rather than passing it as a
  // separate argument to checkRateLimit) keeps rateLimit.ts's own notion of
  // "identifier" a plain opaque string - it doesn't need to know "route" is
  // a concept, and every call site is forced to supply one via the required
  // GuardOptions.routeName above.
  const rateLimitKey = `${options.routeName}:${identity.id}`;
  const rateLimit = await checkRateLimit(redis, rateLimitKey, options.limit, options.windowSeconds, {
    failClosed: options.failClosedOnRedisError,
  });
  const headers = rateLimitHeaders(rateLimit);

  if (!rateLimit.allowed) {
    // redisUnavailable means this is a fail-closed response to a Redis
    // outage, not an actual quota breach - 503 (temporarily unavailable)
    // is the honest status for that, not 429 (you made too many requests).
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
