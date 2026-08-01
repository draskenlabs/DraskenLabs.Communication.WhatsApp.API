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

/**
 * The message to show a person when a Graph call fails.
 *
 * Meta's own wording is far more useful than "Unexpected server error" — it
 * names the missing permission, the invalidated session or the unknown object.
 * Falls back to a caller-supplied line when Meta says nothing useful.
 */
export function metaFailureMessage(err: unknown, fallback: string): string {
  const message = metaErrorMessage(err);
  if (message) return message;

  const status = (err as { response?: { status?: number } })?.response?.status;
  if (status === 404) {
    return 'Meta does not recognise this account any more. It may have been deleted or moved to another business.';
  }
  if (status === 403) {
    return 'Meta refused the request. The connected account may no longer grant us permission.';
  }
  return fallback;
}
