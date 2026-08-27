/**
 * GitHub REST transport — request execution.
 *
 * The GitHub-flavored entry point onto the shared transport
 * (`src/forge/http/request.ts`): it supplies the two parts that are genuinely
 * GitHub's — the canonical header set from `headers.ts` and the 403-is-a-rate-
 * limit hook from `errors.ts` — and delegates fetch, classification, and retry.
 *
 * The token-in / headers-out split is what lets the GitLab arm reuse the same
 * transport without inheriting `application/vnd.github+json`.
 */

import type { ForgeHttpError } from "../http/errors.ts";
import {
	type ForgeRequestInput,
	type ForgeTransportResult,
	requestForge,
} from "../http/request.ts";
import type { ForgeRetryOptions } from "../http/retry.ts";
import { isGitHubRateLimited } from "./errors.ts";
import { buildGitHubHeaders } from "./headers.ts";

export type { ForgeHttpError, ForgeTransportResult };

export interface GitHubRequestInput {
	/** Absolute URL, or a path relative to the API base resolved by the caller. */
	readonly url: string;
	readonly method?: ForgeRequestInput["method"];
	readonly token: string;
	/** JSON-serializable request body; omitted when undefined. */
	readonly body?: unknown;
	/** Injected fetch seam; defaults to `globalThis.fetch`. */
	readonly fetch?: typeof fetch;
	/** Subsystem User-Agent override (see headers.ts). */
	readonly userAgent?: string;
	/** Short call-site label folded into error messages, e.g. `GET /pulls/7`. */
	readonly context: string;
	/** Retry tuning; transient failures retry by default. Pass `maxRetries: 0` to disable. */
	readonly retry?: ForgeRetryOptions;
}

/**
 * Execute one GitHub REST request. Never throws — a thrown fetch surfaces as a
 * `network` error.
 */
export function requestGitHub(input: GitHubRequestInput): Promise<ForgeTransportResult> {
	return requestForge({
		url: input.url,
		...(input.method !== undefined ? { method: input.method } : {}),
		headers: buildGitHubHeaders(input.token, {
			...(input.userAgent !== undefined ? { userAgent: input.userAgent } : {}),
		}),
		...(input.body !== undefined ? { body: input.body } : {}),
		...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
		context: input.context,
		...(input.retry !== undefined ? { retry: input.retry } : {}),
		isRateLimited: isGitHubRateLimited,
	});
}
