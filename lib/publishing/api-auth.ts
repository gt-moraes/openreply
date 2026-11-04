import { timingSafeEqual } from "crypto";

/**
 * Bearer-token auth for the publishing API, used by the creator's local
 * script. Separate from CRON_SECRET so either can be rotated alone. Returns
 * null when the request is allowed, or the HTTP status to answer with.
 */
export function checkPublishingToken(
  authorization: string | null
): 401 | 503 | null {
  const expected = process.env.PUBLISHING_API_TOKEN;
  if (!expected || expected.length < 32) return 503;

  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) return 401;
  const given = Buffer.from(authorization.slice(prefix.length));
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    return 401;
  }
  return null;
}
