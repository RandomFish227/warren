/**
 * `src/runs/pr-checks.ts` — the PR merge-check / URL-parse group split out of
 * `src/runs/pr.ts` (warren-db9a / pl-88bb step 1) to keep both files under
 * the per-file line budget. Houses `checkPullRequestMerged`,
 * `parsePullRequestUrl`, and the shared forge REST helpers
 * (`buildApiHeaders`/`readJson`/`readText`/`truncate`) used by this module
 * and `pr.ts`. `pr.ts` re-exports the public symbols so existing
 * `../runs/pr.ts` import paths keep resolving.
 *
 * Forgejo support (warren-fg01): `parsePullRequestUrl` now handles both
 * GitHub (`/pull/<n>`) and Forgejo (`/pulls/<n>`) PR URL shapes and returns
 * the provider-specific `apiBase` and `kind` so callers can route to the
 * correct REST endpoint without a separate provider lookup.
 */

import type { GitProviderKind } from "../git-providers/resolve.ts";

export const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "warren-reap-pr-open";

/**
 * Acceptance test seam (warren-ae00 / scenario 26). When
 * `WARREN_GH_FETCH_OVERRIDE` is set, every forge REST call short-circuits
 * to a canned positive response — `openPullRequest` returns a synthetic
 * `pull/1` URL and `checkPullRequestMerged` returns `merged` immediately.
 * Lets the in-proc plan-run roundtrip exercise reap's PR open + the
 * coordinator's pr_open → merged transition without standing up a real
 * GitHub fixture. Unset in production deployments.
 */
export const GH_FETCH_OVERRIDE_ENV = "WARREN_GH_FETCH_OVERRIDE";

export function readGhFetchOverride(): "merged" | null {
	const v = process.env[GH_FETCH_OVERRIDE_ENV];
	if (typeof v !== "string") return null;
	return v.trim() === "merged" ? "merged" : null;
}

/**
 * Build forge API request headers. GitHub requires `x-github-api-version` and
 * the `application/vnd.github+json` accept type; Forgejo uses plain
 * `application/json` and no version header.
 */
export function buildApiHeaders(
	token: string,
	kind: GitProviderKind,
	userAgent: string,
): Record<string, string> {
	if (kind === "forgejo") {
		return {
			accept: "application/json",
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			"user-agent": userAgent,
		};
	}
	return {
		accept: "application/vnd.github+json",
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
		"user-agent": userAgent,
		"x-github-api-version": "2022-11-28",
	};
}

/** Convenience wrapper defaulting to the GitHub provider and this module's user-agent. */
export function buildHeaders(
	token: string,
	kind: GitProviderKind = "github",
): Record<string, string> {
	return buildApiHeaders(token, kind, USER_AGENT);
}

export async function readJson(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		return null;
	}
}

export async function readText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return "";
	}
}

export function truncate(input: string, max: number): string {
	return input.length <= max ? input : `${input.slice(0, max)}…`;
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

/* ----------------------------------------------------------------------- */
/* PR-merge polling                                                         */
/* ----------------------------------------------------------------------- */

/**
 * `checkPullRequestMerged` — poll a PR's merge state for the PlanRun
 * coordinator (warren-9e4c). Pure helper: the caller decides what each
 * non-merged shape means (`open` = wait, `closed_unmerged` = fail the plan).
 *
 * Mirrors `openPullRequest`'s posture: direct REST call against
 * `GET /repos/:owner/:repo/pulls/:number`, `Authorization: Bearer <token>`,
 * fetch injected as a seam. Provider-aware via `apiBase` and `kind`
 * (warren-fg01): defaults to GitHub when omitted.
 */
export interface CheckPullRequestMergedInput {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	readonly token: string;
	readonly fetch?: typeof fetch;
	/** Defaults to `GITHUB_API_BASE`. Pass Forgejo's `https://<host>/api/v1`. */
	readonly apiBase?: string;
	/** Defaults to `"github"`. Controls which headers are sent. */
	readonly kind?: GitProviderKind;
}

export type CheckPrMergedResult =
	| { readonly kind: "merged"; readonly mergedAt: string }
	| { readonly kind: "open" }
	| { readonly kind: "closed_unmerged" }
	| { readonly kind: "missing_token"; readonly message: string }
	| {
			readonly kind: "rate_limited";
			/** Parsed `Retry-After` seconds as ms, when the forge sent the header. */
			readonly retryAfterMs: number | null;
			readonly message: string;
	  }
	| { readonly kind: "http_error"; readonly status: number; readonly message: string };

export async function checkPullRequestMerged(
	input: CheckPullRequestMergedInput,
): Promise<CheckPrMergedResult> {
	if (readGhFetchOverride() === "merged") {
		return { kind: "merged", mergedAt: new Date().toISOString() };
	}
	if (input.token === "") {
		return {
			kind: "missing_token",
			message: "token unset; cannot check pull request merge state",
		};
	}

	const fetchImpl = input.fetch ?? globalThis.fetch;
	const base = input.apiBase ?? GITHUB_API_BASE;
	const providerKind = input.kind ?? "github";
	const url = `${base}/repos/${input.owner}/${input.repo}/pulls/${input.number}`;

	let res: Response;
	try {
		res = await fetchImpl(url, {
			method: "GET",
			headers: buildHeaders(input.token, providerKind),
		});
	} catch (err) {
		return {
			kind: "http_error",
			status: 0,
			message: err instanceof Error ? err.message : String(err),
		};
	}

	if (res.status === 429) {
		// warren-9bbc: rate limiting is its own retryable class.
		const text = await readText(res);
		return {
			kind: "rate_limited",
			retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
			message: `GET /pulls/${input.number} returned 429 (rate limited): ${truncate(text, 500)}`,
		};
	}

	if (res.status !== 200) {
		const text = await readText(res);
		return {
			kind: "http_error",
			status: res.status,
			message: `GET /pulls/${input.number} returned ${res.status}: ${truncate(text, 500)}`,
		};
	}

	const body = (await readJson(res)) as { merged_at?: unknown; state?: unknown } | null;
	const mergedAt = typeof body?.merged_at === "string" ? body.merged_at : null;
	if (mergedAt !== null) {
		return { kind: "merged", mergedAt };
	}
	const state = typeof body?.state === "string" ? body.state : "";
	if (state === "closed") {
		return { kind: "closed_unmerged" };
	}
	return { kind: "open" };
}

/* ----------------------------------------------------------------------- */
/* PR URL parsing                                                           */
/* ----------------------------------------------------------------------- */

/**
 * Extended parse result that carries forge-provider info alongside the PR
 * coordinates. `apiBase` and `kind` let callers route to the correct REST
 * endpoint without a separate provider lookup (warren-fg01).
 */
export interface ParsedPullRequestUrl {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	/** Forge API base URL — `https://api.github.com` or `https://<host>/api/v1`. */
	readonly apiBase: string;
	/** Which provider owns this PR URL. */
	readonly kind: GitProviderKind;
}

/**
 * GitHub PR web URL: `https://github.com/<owner>/<repo>/pull/<n>`.
 * (singular `/pull/`)
 */
export const PR_URL_RE = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;

/**
 * Forgejo/Gitea PR web URL: `https://<host>/<owner>/<repo>/pulls/<n>`.
 * (plural `/pulls/` — Gitea uses plural, GitHub uses singular, no ambiguity)
 * Negative lookahead excludes github.com so it can never match here.
 */
const FORGEJO_PR_URL_RE =
	/^https:\/\/(?!github\.com\/)([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pulls\/(\d+)(?:[/?#].*)?$/;

/**
 * Parse a PR web URL from either GitHub or Forgejo. Returns `null` for
 * unrecognized shapes (e.g. GHE-hosted, malformed) so the coordinator treats
 * them as "cannot verify merge" rather than "merged".
 *
 * GitHub:  `https://github.com/<owner>/<repo>/pull/<n>`
 * Forgejo: `https://<host>/<owner>/<repo>/pulls/<n>`  (plural `/pulls/`)
 */
export function parsePullRequestUrl(prUrl: string): ParsedPullRequestUrl | null {
	const trimmed = prUrl.trim();

	// GitHub
	const ghMatch = PR_URL_RE.exec(trimmed);
	if (ghMatch !== null) {
		const [, owner, repo, num] = ghMatch;
		if (owner === undefined || repo === undefined || num === undefined) return null;
		const n = Number.parseInt(num, 10);
		if (!Number.isFinite(n) || n <= 0) return null;
		return { owner, repo, number: n, apiBase: GITHUB_API_BASE, kind: "github" };
	}

	// Forgejo/Gitea (plural /pulls/, github.com excluded by lookahead)
	const fjMatch = FORGEJO_PR_URL_RE.exec(trimmed);
	if (fjMatch !== null) {
		const [, host, owner, repo, num] = fjMatch;
		if (host === undefined || owner === undefined || repo === undefined || num === undefined)
			return null;
		const n = Number.parseInt(num, 10);
		if (!Number.isFinite(n) || n <= 0) return null;
		return {
			owner,
			repo,
			number: n,
			apiBase: `https://${host}/api/v1`,
			kind: "forgejo",
		};
	}

	return null;
}
