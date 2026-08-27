/**
 * Forge REST transport — the provider-neutral error classifier.
 *
 * Extracted from `src/forge/github/errors.ts` (plan pl-d1c9 step 1) when the
 * GitLab arm arrived and needed the same taxonomy. The status-to-kind mapping
 * is not GitHub knowledge: 401 means the credential is wrong on every forge,
 * 404 means the resource is gone, 429 means slow down. Only the *exceptions*
 * to that mapping are provider-specific, and those enter through the
 * `isRateLimited` hook rather than through a second copy of the classifier.
 *
 * The extraction was forced by arithmetic, not taste. `check:dups` runs in the
 * pre-commit gate at a 1.3% ceiling with `minTokens: 100`, and a second copy of
 * this file plus the retry policy counts BOTH sides against that budget. A
 * copied transport core does not fit; a shared one does.
 *
 * Kind vocabulary aligns with the seam-level `ForgeErrorKind` in
 * `src/core/wire.ts` so a provider's map to `ForgeError` stays a rename rather
 * than a re-derivation.
 */

/** Discriminator for a classified forge transport failure. */
export type ForgeHttpErrorKind =
	/** fetch threw or returned no HTTP response (status 0). */
	| "network"
	/** 401 — expired or wrong credential. */
	| "unauthorized"
	/** 403 that is not a rate limit. */
	| "forbidden"
	/** 404/410 — the resource is gone. */
	| "not_found"
	/** 409/422 — the request conflicted with server state. */
	| "conflict"
	/** 429, or a provider status the `isRateLimited` hook claims. */
	| "rate_limited"
	/** Any other non-2xx status. */
	| "http_error";

export interface ForgeHttpError {
	readonly kind: ForgeHttpErrorKind;
	/** Transport status; 0 when fetch threw before any response arrived. */
	readonly status: number;
	/** Parsed `Retry-After` hint in ms, when the forge sent one (rate_limited only). */
	readonly retryAfterMs: number | null;
	/** Human-readable detail; body text already truncated by the caller. */
	readonly message: string;
}

export interface ClassifyHttpErrorOptions {
	/**
	 * Provider hook for a status that carries rate-limit semantics without
	 * being a 429. GitHub needs it: a secondary limit arrives as 403 with
	 * `Retry-After`, and a primary limit as 403 with `X-RateLimit-Remaining: 0`,
	 * both of which must NOT read as a permissions failure. GitLab does not
	 * need it — it returns 429 directly, and its 403 is a genuine denial.
	 *
	 * Omitting the hook therefore means "this forge says what it means", which
	 * is the correct default. A provider that guesses here would misclassify a
	 * real permission error as transient and retry it into the credential
	 * campaign's blind spot (forge-contract.md §4).
	 */
	readonly isRateLimited?: (status: number, headers: Headers) => boolean;
}

/**
 * Parse a `Retry-After` header value into milliseconds. Only the
 * delta-seconds form is honored (the HTTP-date form would need a clock);
 * absent or unparseable values return `null` so the caller falls back to
 * its own delay.
 */
export function parseRetryAfterMs(header: string | null): number | null {
	if (header === null) return null;
	const seconds = Number.parseInt(header.trim(), 10);
	if (!Number.isFinite(seconds) || seconds < 0 || String(seconds) !== header.trim()) return null;
	return seconds * 1000;
}

/**
 * Classify a non-2xx forge response. `context` is a short call-site label
 * (e.g. `GET /pulls/7`) folded into the message; `bodyText` should already be
 * truncated by the caller.
 */
export function classifyHttpError(
	status: number,
	headers: Headers,
	bodyText: string,
	context: string,
	options: ClassifyHttpErrorOptions = {},
): ForgeHttpError {
	const message = `${context} returned ${status}: ${bodyText}`;
	if (status === 429 || options.isRateLimited?.(status, headers) === true) {
		return {
			kind: "rate_limited",
			status,
			retryAfterMs: parseRetryAfterMs(headers.get("retry-after")),
			message,
		};
	}
	if (status === 401) {
		return { kind: "unauthorized", status, retryAfterMs: null, message };
	}
	if (status === 403) {
		return { kind: "forbidden", status, retryAfterMs: null, message };
	}
	if (status === 404 || status === 410) {
		return { kind: "not_found", status, retryAfterMs: null, message };
	}
	if (status === 409 || status === 422) {
		return { kind: "conflict", status, retryAfterMs: null, message };
	}
	return { kind: "http_error", status, retryAfterMs: null, message };
}

/** Wrap a thrown fetch error as a `network`-kind transport error. */
export function networkError(err: unknown, context: string): ForgeHttpError {
	return {
		kind: "network",
		status: 0,
		retryAfterMs: null,
		message: `${context} failed: ${err instanceof Error ? err.message : String(err)}`,
	};
}
