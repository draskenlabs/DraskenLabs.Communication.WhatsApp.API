import { ConfigService } from '@nestjs/config';
import { CookieOptions, Request, Response } from 'express';

/**
 * The cookie the SSO refresh token lives in.
 *
 * It is the console's, not the SSO's: the SSO sets `dl_refresh` for browsers
 * that talk to it directly, and this API is a confidential client that talks to
 * it on their behalf. Naming it separately keeps the two from being mistaken
 * for one another on a shared parent domain.
 */
export const REFRESH_COOKIE = 'dl_wa_refresh';

/** Only `/auth` ever needs it, so nothing else carries it. */
const COOKIE_PATH = '/auth';

/**
 * Why the refresh token is a cookie and not part of the JSON.
 *
 * A refresh token in `localStorage` is readable by every script the page ever
 * loads, and this one is good for thirty days — far longer than the ten-minute
 * access token it buys. HttpOnly puts it out of reach of page scripts entirely,
 * which is the same call the SSO made for its own browser callers.
 *
 * **`SameSite` is decided per request, from the console's own `Origin`.** A
 * `Lax` cookie is never sent on a cross-site request, so getting this wrong
 * does not fail at sign-in — the cookie is stored and everything works — it
 * fails ten minutes later, when `POST /auth/refresh` arrives without it and
 * the console signs the person out. Deriving it from the request means a
 * deployment that puts the console and this API on different sites keeps
 * working without anybody having to notice that it should have set a variable.
 * `AUTH_COOKIE_SAMESITE=lax|none` still pins it explicitly.
 */
export function refreshCookieOptions(
  config: ConfigService,
  req?: Request,
): CookieOptions {
  const sameSite = resolveSameSite(config, req);
  // Off only where it has to be — a plain-http local API. `SameSite=None` is
  // rejected by browsers without it, so that combination wins regardless.
  const secure =
    sameSite === 'none' || config.get<boolean>('AUTH_COOKIE_SECURE') !== false;
  const domain = config.get<string>('AUTH_COOKIE_DOMAIN') || undefined;

  return {
    httpOnly: true,
    secure,
    sameSite,
    path: COOKIE_PATH,
    ...(domain ? { domain } : {}),
  };
}

/**
 * `lax` or `none`, pinned by configuration or read off the request.
 *
 * `auto` — the default — calls it same-site only when the caller's `Origin`
 * host is this API's own host. That is deliberately the strict reading: a
 * console on `wa.` calling an API on `api.` of one registrable domain *is*
 * same-site by the cookie rules and would be safe with `lax`, but telling that
 * apart from two unrelated domains needs the public suffix list, and guessing
 * it wrong the other way is the failure this exists to stop. Erring towards
 * `none` costs a little CSRF hardening on one endpoint — CORS still refuses to
 * hand any other origin the response — and never costs somebody their session.
 */
function resolveSameSite(config: ConfigService, req?: Request): 'lax' | 'none' {
  const configured = config.get<string>('AUTH_COOKIE_SAMESITE');
  if (configured === 'none') return 'none';
  if (configured === 'lax') return 'lax';
  return isSameSiteRequest(req) ? 'lax' : 'none';
}

/**
 * Whether the request came from this API's own host.
 *
 * A request with no `Origin` is not a browser doing anything cross-site — a
 * server-to-server caller, curl, a test — so it is read as same-site and gets
 * the stricter cookie. A malformed `Origin` is read the other way: it is not
 * this host, so it is not same-site.
 */
function isSameSiteRequest(req?: Request): boolean {
  const origin = req?.headers.origin;
  if (!origin) return true;

  const host = req?.headers.host;
  if (!host) return false;

  try {
    // Compared without ports: the cookie rules do not look at them, and the
    // console on :5173 talking to a local API on :3000 is one host.
    return new URL(origin).hostname === hostnameOf(host);
  } catch {
    return false;
  }
}

/** The host header without its port, IPv6 literals included. */
function hostnameOf(host: string): string {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return host;
  }
}

export function setRefreshCookie(
  res: Response,
  config: ConfigService,
  token: string,
  maxAgeSeconds: number,
  req?: Request,
): void {
  res.cookie(REFRESH_COOKIE, token, {
    ...refreshCookieOptions(config, req),
    maxAge: maxAgeSeconds * 1000,
  });
}

export function clearRefreshCookie(
  res: Response,
  config: ConfigService,
  req?: Request,
): void {
  // Cleared with the same attributes it was set with — a cookie whose path or
  // domain differs by a character is a different cookie, and the old one would
  // simply stay.
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(config, req));
}

/**
 * The refresh token on a request: the cookie, or the body for a caller that
 * keeps the token itself (a server-side integration, or a test).
 */
export function readRefreshToken(
  req: Request,
  fromBody?: string,
): string | undefined {
  const cookies = (req as Request & { cookies?: Record<string, string> })
    .cookies;
  return cookies?.[REFRESH_COOKIE] || fromBody || undefined;
}
