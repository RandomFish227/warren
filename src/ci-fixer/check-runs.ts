/**
 * GitHub check-run polling for the CI-fixer (warren-05ea).
 *
 * Pure helper that fetches the check-runs for a commit ref and classifies
 * the aggregate state. Mirrors `src/runs/pr.ts`'s posture: a direct REST
 * call against `GET /repos/:owner/:repo/commits/:ref/check-runs`,
 * `Authorization: Bearer <token>` from `GITHUB_TOKEN`, fetch injected as a
 * seam. The caller (the poller) decides what each shape means; this module
 * does not dispatch.
 *
 * Classification rules:
 *   - `pending`  — at least one check-run is not `completed`. Wait; don't
 *                  dispatch a fixer mid-CI.
 *   - `passing`  — every check-run completed with a success-ish conclusion
 *                  (`success`, `neutral`, `skipped`). Nothing to fix.
 *   - `failing`  — every check-run completed AND at least one has a
 *                  failure-ish conclusion (`failure`, `timed_out`,
 *                  `action_required`, `cancelled`, `startup_failure`).
 *                  Fix-eligible.
 *   - `no_checks` — the ref has zero check-runs (no CI configured, or
 *                  checks haven't registered yet). Not fix-eligible.
 *
 * Each failing check-run carries its `id` (the GitHub Actions job id where
 * applicable) and `detailsUrl` so the poller's log-extraction step can
 * fetch the job log or fall back to the details URL for third-party CI.
 */

import type { GitProviderKind } from "../git-providers/resolve.ts";
import { buildApiHeaders } from "../runs/pr-checks.ts";

const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "warren-ci-fixer";

/** Conclusions that count as a failure worth dispatching a fixer for. */
const FAILURE_CONCLUSIONS: ReadonlySet<string> = new Set([
	"failure",
	"timed_out",
	"action_required",
	"cancelled",
	"startup_failure",
]);

export interface CheckRun {
	readonly id: number;
	readonly name: string;
	readonly status: string;
	readonly conclusion: string | null;
	readonly detailsUrl: string | null;
}

export interface FetchCheckRunsInput {
	readonly owner: string;
	readonly repo: string;
	/** Commit SHA or branch ref the PR head points at. */
	readonly ref: string;
	readonly token: string;
	readonly fetch?: typeof fetch;
	/** Forge API base URL. Defaults to `GITHUB_API_BASE`. (warren-fg01) */
	readonly apiBase?: string;
	/** Provider kind — controls request headers. Defaults to `"github"`. */
	readonly kind?: GitProviderKind;
}

export type FetchCheckRunsResult =
	| { readonly kind: "ok"; readonly checkRuns: readonly CheckRun[] }
	| { readonly kind: "missing_token"; readonly message: string }
	| { readonly kind: "http_error"; readonly status: number; readonly message: string };

export async function fetchCheckRuns(input: FetchCheckRunsInput): Promise<FetchCheckRunsResult> {
	if (input.token === "") {
		return {
			kind: "missing_token",
			message: "forge token unset; cannot fetch check-runs",
		};
	}

	const fetchImpl = input.fetch ?? globalThis.fetch;
	const apiBase = input.apiBase ?? GITHUB_API_BASE;
	const kind = input.kind ?? "github";
	const ref = encodeURIComponent(input.ref);
	const url = `${apiBase}/repos/${input.owner}/${input.repo}/commits/${ref}/check-runs?per_page=100`;

	let res: Response;
	try {
		res = await fetchImpl(url, {
			method: "GET",
			headers: buildApiHeaders(input.token, kind, USER_AGENT),
		});
	} catch (err) {
		return {
			kind: "http_error",
			status: 0,
			message: err instanceof Error ? err.message : String(err),
		};
	}

	if (res.status !== 200) {
		const text = await readText(res);
		return {
			kind: "http_error",
			status: res.status,
			message: `GET /check-runs returned ${res.status}: ${truncate(text, 500)}`,
		};
	}

	const body = (await readJson(res)) as { check_runs?: unknown } | null;
	const raw = Array.isArray(body?.check_runs) ? body.check_runs : [];
	const checkRuns = raw.map(parseCheckRun).filter((c): c is CheckRun => c !== null);
	return { kind: "ok", checkRuns };
}

function parseCheckRun(raw: unknown): CheckRun | null {
	if (typeof raw !== "object" || raw === null) return null;
	const obj = raw as Record<string, unknown>;
	if (typeof obj.id !== "number") return null;
	return {
		id: obj.id,
		name: typeof obj.name === "string" ? obj.name : "",
		status: typeof obj.status === "string" ? obj.status : "",
		conclusion: typeof obj.conclusion === "string" ? obj.conclusion : null,
		detailsUrl: typeof obj.details_url === "string" ? obj.details_url : null,
	};
}

export type CheckRunsVerdict = "pending" | "passing" | "failing" | "no_checks";

export interface ClassifyCheckRunsResult {
	readonly verdict: CheckRunsVerdict;
	/** The failure-ish check-runs, populated only when verdict is `failing`. */
	readonly failures: readonly CheckRun[];
}

/**
 * Classify the aggregate state of a commit's check-runs. The poller treats
 * `failing` as fix-eligible; everything else is a no-op for this tick.
 */
export function classifyCheckRuns(checkRuns: readonly CheckRun[]): ClassifyCheckRunsResult {
	if (checkRuns.length === 0) {
		return { verdict: "no_checks", failures: [] };
	}
	const anyPending = checkRuns.some((c) => c.status !== "completed");
	if (anyPending) {
		return { verdict: "pending", failures: [] };
	}
	const failures = checkRuns.filter(
		(c) => c.conclusion !== null && FAILURE_CONCLUSIONS.has(c.conclusion),
	);
	if (failures.length > 0) {
		return { verdict: "failing", failures };
	}
	return { verdict: "passing", failures: [] };
}

/**
 * Parse the GitHub Actions job id from a check-run's `details_url`. Actions
 * check-runs link to `.../actions/runs/<run_id>/job/<job_id>`; the trailing
 * job id is what `GET /actions/jobs/:id/logs` needs. Falls back to the
 * check-run `id` when the URL has no `job/<id>` segment (third-party CI, or a
 * malformed url) — the logs fetch then resolves against that id or degrades
 * to null, which the caller already handles.
 */
export function extractJobId(detailsUrl: string | null, fallbackId: number): number {
	if (detailsUrl !== null) {
		const match = /\/job\/(\d+)/.exec(detailsUrl);
		if (match?.[1] !== undefined) {
			const parsed = Number.parseInt(match[1], 10);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return fallbackId;
}

export interface FetchJobLogInput {
	readonly owner: string;
	readonly repo: string;
	readonly jobId: number;
	readonly token: string;
	readonly fetch?: typeof fetch;
	/** Forge API base URL. Defaults to `GITHUB_API_BASE`. (warren-fg01) */
	readonly apiBase?: string;
	/** Provider kind — controls request headers. Defaults to `"github"`. */
	readonly kind?: GitProviderKind;
}

export type FetchJobLogTailFn = (
	input: FetchJobLogInput,
	tailLines: number,
) => Promise<string | null>;

/**
 * Fetch the tail of a GitHub Actions job log so the fixer prompt carries the
 * failure context without the multi-megabyte full log. `GET
 * /actions/jobs/:id/logs` 302-redirects to a plaintext download; fetch
 * follows the redirect and we keep the last `tailLines` lines. Returns null
 * on any failure (missing token, non-2xx — e.g. 410 for expired logs,
 * network error, empty body); `buildFixerPrompt` handles a null tail by
 * telling the agent to diagnose from the check names instead.
 */
export async function fetchJobLogTail(
	input: FetchJobLogInput,
	tailLines: number,
): Promise<string | null> {
	if (input.token === "" || tailLines <= 0) return null;
	const fetchImpl = input.fetch ?? globalThis.fetch;
	const apiBase = input.apiBase ?? GITHUB_API_BASE;
	const kind = input.kind ?? "github";
	const url = `${apiBase}/repos/${input.owner}/${input.repo}/actions/jobs/${input.jobId}/logs`;
	let res: Response;
	try {
		res = await fetchImpl(url, {
			method: "GET",
			headers: buildApiHeaders(input.token, kind, USER_AGENT),
		});
	} catch {
		return null;
	}
	if (!res.ok) return null;
	return tailLog(await readText(res), tailLines);
}

/** Keep the last `tailLines` lines of `text`, trimming trailing whitespace.
 * Returns null for an effectively empty log so the caller skips the block. */
function tailLog(text: string, tailLines: number): string | null {
	const trimmed = text.replace(/\s+$/, "");
	if (trimmed === "") return null;
	const lines = trimmed.split("\n");
	if (lines.length <= tailLines) return trimmed;
	return lines.slice(lines.length - tailLines).join("\n");
}

async function readJson(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		return null;
	}
}

async function readText(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return "";
	}
}

function truncate(input: string, max: number): string {
	return input.length <= max ? input : `${input.slice(0, max)}…`;
}
