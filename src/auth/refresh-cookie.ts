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
 * `SameSite=Lax` is enough while the console and the API sit under one
 * registrable domain (`wa.` and `api.` of the same site), which is every
 * deployment we run and local development besides. A deployment that splits
 * them across sites sets `AUTH_COOKIE_SAMESITE=none`, which forces `Secure`.
 */
export function refreshCookieOptions(config: ConfigService): CookieOptions {
  const sameSite =
    config.get<string>('AUTH_COOKIE_SAMESITE') === 'none' ? 'none' : 'lax';
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

export function setRefreshCookie(
  res: Response,
  config: ConfigService,
  token: string,
  maxAgeSeconds: number,
): void {
  res.cookie(REFRESH_COOKIE, token, {
    ...refreshCookieOptions(config),
    maxAge: maxAgeSeconds * 1000,
  });
}

export function clearRefreshCookie(res: Response, config: ConfigService): void {
  // Cleared with the same attributes it was set with — a cookie whose path or
  // domain differs by a character is a different cookie, and the old one would
  // simply stay.
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(config));
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
