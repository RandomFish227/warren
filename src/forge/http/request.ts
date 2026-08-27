/**
 * Forge REST transport — request execution.
 *
 * The one `fetch` boundary for every forge provider (plan pl-d1c9 step 1,
 * generalized when the GitLab arm arrived). Composes the fail-soft readers
 * (readers.ts), the error classifier (errors.ts), and the retry policy
 * (retry.ts) into one result-union call.
 *
 * What this module deliberately does NOT own is the header set and the API
 * base. Those are the two genuinely provider-specific parts of an HTTP call:
 * GitHub sends `application/vnd.github+json` plus a pinned
 * `x-github-api-version` to a fixed `api.github.com`, while GitLab sends a
 * plain bearer to a per-instance `https://<host>/api/v4` that is only known at
 * boot. Building headers here would force one provider's vocabulary on the
 * other, so headers arrive as an INPUT and each provider keeps its own builder.
 *
 * The injected-`fetch` convention is preserved: pass `fetch` in tests, omit it
 * in production. The result carries the raw `Response` on success so callers
 * keep owning body parsing — this module transports; the domain owns meaning
 * (forge-contract.md §3).
 */

import { classifyHttpError, type ForgeHttpError, networkError } from "./errors.ts";
import { readText, truncate } from "./readers.ts";
import { type ForgeRetryOptions, withForgeRetry } from "./retry.ts";

export type ForgeTransportResult =
	| { readonly ok: true; readonly response: Response }
	| { readonly ok: false; readonly error: ForgeHttpError };

export interface ForgeRequestInput {
	/** Absolute URL; the caller joins its own API base. */
	readonly url: string;
	readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
	/** The complete header set, built by the provider (see the module doc). */
	readonly headers: Record<string, string>;
	/** JSON-serializable request body; omitted when undefined. */
	readonly body?: unknown;
	/** Injected fetch seam; defaults to `globalThis.fetch`. */
	readonly fetch?: typeof fetch;
	/** Short call-site label folded into error messages, e.g. `GET /pulls/7`. */
	readonly context: string;
	/** Retry tuning; transient failures retry by default. Pass `maxRetries: 0` to disable. */
	readonly retry?: ForgeRetryOptions;
	/**
	 * Provider hook for a non-429 status that carries rate-limit semantics.
	 * See `ClassifyHttpErrorOptions.isRateLimited`; omitting it is correct for
	 * a forge that returns 429 directly.
	 */
	readonly isRateLimited?: (status: number, headers: Headers) => boolean;
}

/** Cap on response-body text folded into an error message. */
const ERROR_BODY_MAX_CHARS = 500;

/**
 * Execute one forge REST request: fetch with the supplied headers, classify a
 * non-2xx response, retry transient failures per the module policy. Never
 * throws — a thrown fetch surfaces as a `network` error.
 */
export async function requestForge(input: ForgeRequestInput): Promise<ForgeTransportResult> {
	const fetchImpl = input.fetch ?? globalThis.fetch;
	const init: RequestInit = {
		method: input.method ?? "GET",
		headers: input.headers,
		...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
	};

	const retried = await withForgeRetry(async () => {
		let res: Response;
		try {
			res = await fetchImpl(input.url, init);
		} catch (err) {
			return { ok: false, error: networkError(err, input.context) };
		}
		if (!res.ok) {
			const text = truncate(await readText(res), ERROR_BODY_MAX_CHARS);
			return {
				ok: false,
				error: classifyHttpError(res.status, res.headers, text, input.context, {
					...(input.isRateLimited !== undefined ? { isRateLimited: input.isRateLimited } : {}),
				}),
			};
		}
		return { ok: true, value: res };
	}, input.retry ?? {});
	if (!retried.ok) return retried;
	return { ok: true, response: retried.value };
}
