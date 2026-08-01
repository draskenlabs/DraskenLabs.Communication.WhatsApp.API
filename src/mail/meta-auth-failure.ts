/**
 * Did Meta reject our credentials, rather than the request?
 *
 * Meta answers a revoked, expired or invalidated token with error code 190
 * (and OAuthException), or a plain 401. Everything else — a malformed
 * template, a rate limit, a banned number — is the caller's problem and must
 * not trigger a "reconnect your account" email.
 */
export function isMetaAuthFailure(err: unknown): boolean {
  const response = (err as { response?: { status?: number; data?: unknown } })
    ?.response;
  if (!response) return false;
  if (response.status === 401) return true;

  const error = (response.data as { error?: { code?: number; type?: string } })
    ?.error;
  return error?.code === 190 || error?.type === 'OAuthException';
}

/** Meta's own wording for the failure, when it gives any. */
export function metaErrorMessage(err: unknown): string | undefined {
  const error = (
    err as {
      response?: {
        data?: { error?: { error_user_msg?: string; message?: string } };
      };
    }
  )?.response?.data?.error;
  return error?.error_user_msg ?? error?.message;
}
