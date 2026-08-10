/**
 * GitHub PR + check-run operations (Forge plan, step 3).
 *
 * Implements the `Forge` interface methods that talk to the GitHub REST API.
 * Split from `http.ts` (transport helpers) to keep both files under the
 * 500-line budget (`check:size`).
 *
 * `src/runs/pr.ts`, `src/runs/pr-checks.ts`, and
 * `src/ci-fixer/check-runs.ts` re-export from here for backward
 * compatibility; new callers should use `forgeFor(project)` from
 * `src/forge/registry.ts`.
 */

import type {
	ChecksResult,
	OpenPrInput,
	OpenPrResult,
	ParsedPrUrl,
	PrMergeState,
	RepoRef,
} from "../contract.ts";
import {
	buildGithubHeaders,
	GITHUB_API_BASE,
	parseRetryAfterMs,
	readGhFetchOverride,
	readJson,
	readText,
	truncate,
} from "./http.ts";

/* ----------------------------------------------------------------------- */
/* Pull-request operations                                                   */
/* ----------------------------------------------------------------------- */

async function openPrCreated(res: Response): Promise<OpenPrResult> {
	const created = (await readJson(res)) as { html_url?: unknown } | null;
	const link = typeof created?.html_url === "string" ? created.html_url : null;
	if (link === null) {
		return { ok: false, reason: "http_error", message: "POST /pulls returned no html_url" };
	}
	return { ok: true, url: link, mode: "created" };
}

async function openPr422(
	input: OpenPrInput,
	res: Response,
	fetchImpl: typeof fetch,
): Promise<OpenPrResult> {
	const body = (await readJson(res)) as { errors?: unknown; message?: unknown } | null;
	const message = typeof body?.message === "string" ? body.message : "422 from POST /pulls";
	const errorsBlob = JSON.stringify(body?.errors ?? []);
	if (/already exists|pull request already exists/i.test(errorsBlob + message)) {
		const existing = await ghFindExistingPr(input, fetchImpl);
		if (existing !== null) return { ok: true, url: existing, mode: "exists" };
		return {
			ok: false,
			reason: "http_error",
			message: "PR already exists but lookup returned no url",
		};
	}
	return { ok: false, reason: "http_error", message: `${message} errors=${errorsBlob}` };
}

export async function ghOpenPullRequest(
	input: OpenPrInput,
	fetchImpl: typeof fetch = globalThis.fetch,
): Promise<OpenPrResult> {
	if (readGhFetchOverride() === "merged") {
		return {
			ok: true,
			url: `https://github.com/${input.repo.owner}/${input.repo.name}/pull/1`,
			mode: "created",
		};
	}
	if (input.token === "") {
		return {
			ok: false,
			reason: "missing_token",
			message: "GITHUB_TOKEN unset; cannot open pull request",
		};
	}

	const url = `${GITHUB_API_BASE}/repos/${input.repo.owner}/${input.repo.name}/pulls`;
	let res: Response;
	try {
		res = await fetchImpl(url, {
			method: "POST",
			headers: buildGithubHeaders(input.token),
			body: JSON.stringify({
				title: input.title,
				body: input.body,
				head: input.head,
				base: input.base,
			}),
		});
	} catch (err) {
		return {
			ok: false,
			reason: "network",
			message: err instanceof Error ? err.message : String(err),
		};
	}

	if (res.status === 201) return openPrCreated(res);
	if (res.status === 422) return openPr422(input, res, fetchImpl);
	const text = await readText(res);
	return {
		ok: false,
		reason: "http_error",
		message: `POST /pulls returned ${res.status}: ${truncate(text, 500)}`,
	};
}

export async function ghFindExistingPr(
	input: Omit<OpenPrInput, "title" | "body">,
	fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string | null> {
	const params = new URLSearchParams({
		head: `${input.repo.owner}:${input.head}`,
		base: input.base,
		state: "open",
		per_page: "1",
	});
	const url = `${GITHUB_API_BASE}/repos/${input.repo.owner}/${input.repo.name}/pulls?${params.toString()}`;
	let res: Response;
	try {
		res = await fetchImpl(url, { method: "GET", headers: buildGithubHeaders(input.token) });
	} catch {
		return null;
	}
	if (!res.ok) return null;
	const list = (await readJson(res)) as Array<{ html_url?: unknown }> | null;
	if (!Array.isArray(list) || list.length === 0) return null;
	const first = list[0];
	return typeof first?.html_url === "string" ? first.html_url : null;
}

export async function ghCheckPrMerged(
	prUrl: string,
	token: string,
	fetchImpl: typeof fetch = globalThis.fetch,
): Promise<PrMergeState> {
	if (readGhFetchOverride() === "merged") {
		return { kind: "merged", mergedAt: new Date().toISOString() };
	}
	if (token === "") {
		return {
			kind: "missing_token",
			message: "GITHUB_TOKEN unset; cannot check pull request merge state",
		};
	}

	const parsed = ghParsePrUrl(prUrl);
	if (parsed === null) {
		return { kind: "http_error", status: 0, message: `not a GitHub PR URL: ${prUrl}` };
	}

	const url = `${GITHUB_API_BASE}/repos/${parsed.repo.owner}/${parsed.repo.name}/pulls/${parsed.number}`;
	let res: Response;
	try {
		res = await fetchImpl(url, { method: "GET", headers: buildGithubHeaders(token) });
	} catch (err) {
		return {
			kind: "http_error",
			status: 0,
			message: err instanceof Error ? err.message : String(err),
		};
	}

	if (res.status === 429) {
		const text = await readText(res);
		return {
			kind: "rate_limited",
			retryAfterMs: parseRetryAfterMs(res.headers.get("retry-after")),
			message: `GET /pulls/${parsed.number} returned 429 (rate limited): ${truncate(text, 500)}`,
		};
	}
	if (res.status !== 200) {
		const text = await readText(res);
		return {
			kind: "http_error",
			status: res.status,
			message: `GET /pulls/${parsed.number} returned ${res.status}: ${truncate(text, 500)}`,
		};
	}

	const body = (await readJson(res)) as { merged_at?: unknown; state?: unknown } | null;
	const mergedAt = typeof body?.merged_at === "string" ? body.merged_at : null;
	if (mergedAt !== null) return { kind: "merged", mergedAt };
	const state = typeof body?.state === "string" ? body.state : "";
	if (state === "closed") return { kind: "closed_unmerged" };
	return { kind: "open" };
}

export const GH_PR_URL_RE =
	/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/;

export function ghParsePrUrl(raw: string): ParsedPrUrl | null {
	const m = GH_PR_URL_RE.exec(raw.trim());
	if (m === null) return null;
	const [, owner, repo, num] = m;
	if (owner === undefined || repo === undefined || num === undefined) return null;
	const n = Number.parseInt(num, 10);
	if (!Number.isFinite(n) || n <= 0) return null;
	return { repo: { host: "github.com", owner, name: repo }, number: n };
}

/* ----------------------------------------------------------------------- */
/* Check-run operations                                                      */
/* ----------------------------------------------------------------------- */

/** Conclusions that count as a failure worth dispatching a fixer for. */
const FAILURE_CONCLUSIONS: ReadonlySet<string> = new Set([
	"failure",
	"timed_out",
	"action_required",
	"cancelled",
	"startup_failure",
]);

export async function ghFetchChecks(
	repo: RepoRef,
	sha: string,
	token: string,
	fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ChecksResult> {
	if (token === "") return { kind: "none" };

	const ref = encodeURIComponent(sha);
	const url = `${GITHUB_API_BASE}/repos/${repo.owner}/${repo.name}/commits/${ref}/check-runs?per_page=100`;
	let res: Response;
	try {
		res = await fetchImpl(url, { method: "GET", headers: buildGithubHeaders(token) });
	} catch {
		return { kind: "none" };
	}
	if (res.status !== 200) return { kind: "none" };

	const body = (await readJson(res)) as { check_runs?: unknown } | null;
	const raw = Array.isArray(body?.check_runs) ? body.check_runs : [];

	if (raw.length === 0) return { kind: "none" };

	const anyPending = raw.some((c) => {
		const obj = c as Record<string, unknown>;
		return obj.status !== "completed";
	});
	if (anyPending)
		return {
			kind: "summary",
			allPassed: false,
			failed: [],
			pending: raw.map((c) => {
				const obj = c as Record<string, unknown>;
				return typeof obj.name === "string" ? obj.name : "";
			}),
		};

	const failed: string[] = [];
	const pending: string[] = [];
	for (const c of raw) {
		const obj = c as Record<string, unknown>;
		const name = typeof obj.name === "string" ? obj.name : "";
		const conclusion = typeof obj.conclusion === "string" ? obj.conclusion : null;
		if (conclusion !== null && FAILURE_CONCLUSIONS.has(conclusion)) {
			failed.push(name);
		}
	}
	return { kind: "summary", allPassed: failed.length === 0, failed, pending };
}
