/**
 * GitHub REST transport — the GitHub-specific slice of error classification.
 *
 * The status-to-kind taxonomy itself moved to `src/forge/http/errors.ts` when
 * the GitLab arm arrived, because 401/404/409/429 mean the same thing on every
 * forge. What stays here is the one rule that is genuinely GitHub knowledge:
 * a 403 is sometimes a rate limit rather than a permissions failure, and only
 * GitHub signals it that way.
 *
 * Getting that rule wrong is expensive in both directions. Read as `forbidden`
 * and the poller gives up on a limit that would have cleared; read as
 * `rate_limited` on a forge where 403 means denial and the retry policy hides
 * the expired-credential signal the credential campaign needs to surface
 * loudly (forge-contract.md §4).
 */

/**
 * True when a 403 response is actually a rate limit rather than a real
 * permissions failure. GitHub signals this via `Retry-After` (secondary
 * limits) or `X-RateLimit-Remaining: 0` (primary limits).
 */
export function isRateLimitedForbidden(headers: Headers): boolean {
	if (headers.get("retry-after") !== null) return true;
	return headers.get("x-ratelimit-remaining") === "0";
}

/**
 * The `isRateLimited` hook GitHub hands the neutral classifier. Scoped to 403
 * on purpose: a 429 is already rate-limited by the shared rule, and widening
 * this to other statuses would let a header GitHub sends for another reason
 * reclassify a hard failure as transient.
 */
export function isGitHubRateLimited(status: number, headers: Headers): boolean {
	return status === 403 && isRateLimitedForbidden(headers);
}
