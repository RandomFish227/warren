/**
 * GitLab REST transport — request execution.
 *
 * The GitLab-flavored entry point onto the shared transport
 * (`src/forge/http/request.ts`). It supplies the header set from `headers.ts`
 * and nothing else, which is the whole point of the extraction: GitLab needs
 * the same fetch boundary, classifier, and retry policy as GitHub, and none of
 * GitHub's vocabulary.
 *
 * No `isRateLimited` hook is passed, and that omission is a decision rather
 * than an oversight. GitLab returns 429 directly when a rate limit is hit, so
 * the shared classifier already catches it; a GitLab 403 means the token
 * genuinely lacks the scope. Reusing GitHub's 403-is-sometimes-a-limit rule
 * here would retry a real permissions failure and hide the expired-credential
 * signal forge-contract.md §4 needs surfaced loudly. GitLab does send
 * `RateLimit-*` headers on some endpoints, but they are informational
 * alongside a 429 rather than a reclassification signal on another status.
 */

import type { ForgeRequestInput, ForgeTransportResult } from "../http/request.ts";
import { requestForge } from "../http/request.ts";
import type { ForgeRetryOptions } from "../http/retry.ts";
import { buildGitLabHeaders } from "./headers.ts";

export interface GitLabRequestInput {
	/** Absolute URL; build it with the helpers in `endpoints.ts`. */
	readonly url: string;
	readonly method?: ForgeRequestInput["method"];
	readonly token: string;
	/** JSON-serializable request body; omitted when undefined. */
	readonly body?: unknown;
	/** Injected fetch seam; defaults to `globalThis.fetch`. */
	readonly fetch?: typeof fetch;
	/** Subsystem User-Agent override (see headers.ts). */
	readonly userAgent?: string;
	/** Short call-site label folded into error messages, e.g. `GET /merge_requests/7`. */
	readonly context: string;
	/** Retry tuning; transient failures retry by default. Pass `maxRetries: 0` to disable. */
	readonly retry?: ForgeRetryOptions;
}

/**
 * Execute one GitLab REST request. Never throws — a thrown fetch surfaces as a
 * `network` error.
 */
export function requestGitLab(input: GitLabRequestInput): Promise<ForgeTransportResult> {
	return requestForge({
		url: input.url,
		...(input.method !== undefined ? { method: input.method } : {}),
		headers: buildGitLabHeaders(input.token, {
			...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
		}),
		...(input.body !== undefined ? { body: input.body } : {}),
		...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
		context: input.context,
		...(input.retry !== undefined ? { retry: input.retry } : {}),
	});
}
