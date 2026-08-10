/**
 * GitHub REST transport helpers (Forge plan, step 3).
 *
 * Shared between `resources.ts` (PR + checks) and any other GitHub REST
 * call site in the forge module. Extracted so the size budget
 * (`check:size`) is respected while keeping duplication (`check:dups`)
 * zero.
 *
 * These functions are re-exported from `src/runs/pr-checks.ts` for
 * backward-compat of existing import paths.
 */

export const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "warren-forge-github";

/**
 * Acceptance test seam (warren-ae00 / scenario 26). When
 * `WARREN_GH_FETCH_OVERRIDE` is set, PR REST calls short-circuit to
 * canned positive responses. Unset in production.
 */
export const GH_FETCH_OVERRIDE_ENV = "WARREN_GH_FETCH_OVERRIDE";

export function readGhFetchOverride(): "merged" | null {
	const v = process.env[GH_FETCH_OVERRIDE_ENV];
	if (typeof v !== "string") return null;
	return v.trim() === "merged" ? "merged" : null;
}

/** Standard GitHub REST headers for JSON requests. */
export function buildGithubHeaders(token: string): Record<string, string> {
	return {
		accept: "application/vnd.github+json",
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
		"user-agent": USER_AGENT,
		"x-github-api-version": "2022-11-28",
	};
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
 * delta-seconds form is honoured; absent or unparseable values return `null`.
 */
export function parseRetryAfterMs(header: string | null): number | null {
	if (header === null) return null;
	const seconds = Number.parseInt(header.trim(), 10);
	if (!Number.isFinite(seconds) || seconds < 0 || String(seconds) !== header.trim()) return null;
	return seconds * 1000;
}
