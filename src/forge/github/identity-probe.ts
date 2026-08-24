/**
 * GitHub identity probe — warren-56bb, multi-forge-support.md §4b.
 *
 * Validates that a base URL serves the GitHub API by issuing an
 * unauthenticated GET to `${baseUrl}/meta` and asserting GitHub-specific
 * response headers. Separated from `provider.ts` because that file sits at
 * its 500-line budget; this concern is cohesive enough to stand alone.
 *
 * Probe measured 2026-08-19: `GET https://api.github.com/meta` → 200
 * carrying both `x-github-request-id` and `x-github-media-type`. No
 * credential is needed — the endpoint is public and the probe is strictly
 * an identity check, not an authorization check (§4b: "a version string
 * is not an authorization check").
 */

import type { ForgeResult } from "../contract.ts";

const PROBE_USER_AGENT = "warren-forge-github";

/** Headers that identify a GitHub API response (§4b observed evidence). */
const GITHUB_IDENTITY_HEADERS = ["x-github-request-id", "x-github-media-type"] as const;

/**
 * Probe `baseUrl` to confirm the host is a GitHub API instance.
 *
 * Issues an unauthenticated GET to `${baseUrl}/meta`, which on github.com
 * returns 200 with both `x-github-request-id` and `x-github-media-type`.
 * Either header is sufficient — both were observed live; either alone is
 * a stronger signal than the 200 status, which any server can return.
 *
 * The `fetchImpl` seam lets tests inject a canned response; production
 * callers supply `globalThis.fetch` (or the forge's own injected fetch).
 */
export async function probeGitHubIdentity(
	baseUrl: string,
	fetchImpl: typeof fetch,
): Promise<ForgeResult<void>> {
	const url = `${baseUrl}/meta`;
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: "GET",
			headers: { "user-agent": PROBE_USER_AGENT },
		});
	} catch (e) {
		return {
			ok: false,
			error: {
				kind: "network",
				detail: `identity probe: network error reaching ${url}: ${e instanceof Error ? e.message : String(e)}`,
			},
		};
	}
	const isGitHub = GITHUB_IDENTITY_HEADERS.some((h) => response.headers.get(h) !== null);
	if (!isGitHub) {
		return {
			ok: false,
			error: {
				kind: "http_error",
				status: response.status,
				detail: `identity probe at ${url}: GitHub identity headers absent (x-github-request-id, x-github-media-type) — is this really a GitHub instance?`,
			},
		};
	}
	return { ok: true, value: undefined };
}
