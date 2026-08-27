/**
 * GitLab Merge Request API — the four PR-shaped seam operations.
 *
 * Split out of `provider.ts` so neither file approaches the 500-line budget
 * `check:size` enforces, and because the vocabulary translation deserves to be
 * read in one place. GitLab calls it a Merge Request; the seam calls it a Pull
 * Request; nothing outside this file sees both names.
 *
 * Three translations carry real risk and are pinned by tests:
 *
 *   1. `iid`, never `id`. A GitLab MR has BOTH: `id` is globally unique across
 *      the instance, `iid` is the per-project number shown in the UI and in
 *      `!7` references. The seam's `PullRequestRef.number` is the human-facing
 *      one, so it must be `iid`. Using `id` builds URLs that 404 on every
 *      project except the first one ever created.
 *   2. Lifecycle. GitLab's `state` is `opened|closed|locked|merged`, with
 *      `merged` as its OWN state rather than a flavour of closed. GitHub
 *      reports `closed` plus a `merged_at`, which is why the seam's
 *      `closed_unmerged` is spelled the way it is. A GitLab `closed` MR is
 *      genuinely unmerged, and `locked` is a transient state during a merge,
 *      so it reads as `open` rather than as a failure.
 *   3. `state` in a query. The seam's `closed` follows GitHub and means "not
 *      open", merged included. GitLab's `closed` excludes merged. Querying
 *      GitLab's `closed` for the seam's `closed` would silently miss every
 *      merged MR, so the filter is applied locally against `all` instead.
 *
 * Drafts are a title convention on GitLab (`Draft: `) rather than an API flag.
 */

import type {
	ForgeError,
	ForgeResult,
	PullRequestDraft,
	PullRequestQuery,
	PullRequestRef,
	PullRequestState,
} from "../contract.ts";
import { readJson } from "../http/readers.ts";
import { gitLabProjectSubUrl } from "./endpoints.ts";
import { requestGitLab } from "./http.ts";
import { GITLAB_FORGE_KIND } from "./repo-ref.ts";

/** The `Draft: ` title prefix GitLab uses in place of a draft flag. */
const DRAFT_PREFIX = "Draft: ";

/** Everything one MR call needs. `token` is minted per call, never held (§4). */
export interface GitLabCallContext {
	readonly apiBase: string;
	readonly projectPath: string;
	readonly token: string;
	readonly fetch: typeof fetch;
	readonly userAgent: string;
}

/** The subset of GitLab's MR JSON this module reads. */
export interface GitLabMrJson {
	readonly iid?: unknown;
	readonly web_url?: unknown;
	readonly state?: unknown;
	readonly merged_at?: unknown;
	readonly sha?: unknown;
	readonly source_branch?: unknown;
	readonly target_branch?: unknown;
}

function ok<T>(value: T): ForgeResult<T> {
	return { ok: true, value };
}

function err<T>(error: ForgeError): ForgeResult<T> {
	return { ok: false, error };
}

function str(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Build the seam ref from MR JSON. `key` packs `<project/path>!<iid>`, which is
 * GitLab's own MR reference syntax — stable, safe to log, and parsed by nothing
 * outside this provider.
 */
export function toPullRequestRef(projectPath: string, json: GitLabMrJson): PullRequestRef | null {
	const iid = typeof json.iid === "number" && Number.isInteger(json.iid) ? json.iid : null;
	const webUrl = str(json.web_url);
	if (iid === null || webUrl === null) return null;
	return {
		forge: GITLAB_FORGE_KIND,
		key: `${projectPath}!${iid}`,
		number: iid,
		webUrl,
	};
}

/** Translate GitLab's MR JSON into the seam's lifecycle view (translation 2). */
export function toPullRequestState(json: GitLabMrJson): PullRequestState {
	const parsed = typeof json.merged_at === "string" ? Date.parse(json.merged_at) : Number.NaN;
	const mergedAt = Number.isFinite(parsed) ? parsed : null;
	const state = str(json.state);
	// `merged_at` wins when present. A merged MR always carries `state:
	// "merged"`, but reading the stamp first means a response that reports one
	// without the other still resolves to the lifecycle the merge gate needs.
	const lifecycle =
		mergedAt !== null || state === "merged"
			? "merged"
			: state === "closed"
				? "closed_unmerged"
				: "open";
	return {
		lifecycle,
		mergedAt,
		headCommit: str(json.sha) ?? "",
		baseBranch: str(json.target_branch) ?? "",
	};
}

/** True when an MR's raw state satisfies the seam-level query state. */
function matchesQueryState(raw: unknown, want: PullRequestQuery["state"]): boolean {
	if (want === undefined || want === "open") return raw === "opened" || raw === "locked";
	if (want === "closed") return raw !== "opened" && raw !== "locked";
	return true;
}

/**
 * Find an open (or otherwise filtered) MR for a source/target branch pair.
 * Returns ok with `null` when none exists — a missing MR is not an error.
 *
 * Unlike the GitHub provider there is no second fork-scoped pass: warren
 * pushes the run branch into the project itself, and GitLab's `source_branch`
 * filter matches project branches directly.
 */
export async function findMergeRequest(
	ctx: GitLabCallContext,
	q: PullRequestQuery,
): Promise<ForgeResult<PullRequestRef | null>> {
	const want = q.state ?? "open";
	// Translation 3: only the `open` case can be narrowed server-side.
	const apiState = want === "open" ? "opened" : "all";
	const query = new URLSearchParams({
		source_branch: q.headBranch,
		target_branch: q.baseBranch,
		state: apiState,
		per_page: "100",
	});
	const result = await requestGitLab({
		url: gitLabProjectSubUrl(ctx.apiBase, ctx.projectPath, `merge_requests?${query}`),
		method: "GET",
		token: ctx.token,
		userAgent: ctx.userAgent,
		context: "GET /merge_requests",
		fetch: ctx.fetch,
	});
	if (!result.ok) return err(toForgeError(result.error));
	const body = await readJson(result.response);
	if (!Array.isArray(body)) {
		return err({ kind: "http_error", detail: "GET /merge_requests returned a non-array body" });
	}
	for (const raw of body as GitLabMrJson[]) {
		if (!matchesQueryState(raw.state, want)) continue;
		const ref = toPullRequestRef(ctx.projectPath, raw);
		if (ref !== null) return ok(ref);
	}
	return ok(null);
}

/**
 * Open a merge request. Idempotent by contract (§1): GitLab answers a
 * duplicate source branch with 409 and a message naming the existing MR, and
 * that conflict resolves to the existing ref rather than surfacing.
 *
 * The resolution goes through `findMergeRequest` rather than parsing the `!7`
 * out of the 409 message, because that message is human-facing prose GitLab is
 * free to reword or localize.
 */
export async function createMergeRequest(
	ctx: GitLabCallContext,
	req: PullRequestDraft,
): Promise<ForgeResult<PullRequestRef>> {
	const title = req.draft === true ? `${DRAFT_PREFIX}${req.title}` : req.title;
	const result = await requestGitLab({
		url: gitLabProjectSubUrl(ctx.apiBase, ctx.projectPath, "merge_requests"),
		method: "POST",
		token: ctx.token,
		userAgent: ctx.userAgent,
		context: "POST /merge_requests",
		body: {
			source_branch: req.headBranch,
			target_branch: req.baseBranch,
			title,
			description: req.body,
		},
		fetch: ctx.fetch,
	});
	if (!result.ok) {
		if (result.error.status === 409) {
			const existing = await findMergeRequest(ctx, {
				headBranch: req.headBranch,
				baseBranch: req.baseBranch,
			});
			if (existing.ok && existing.value !== null) return ok(existing.value);
		}
		return err(toForgeError(result.error));
	}
	const created = (await readJson(result.response)) as GitLabMrJson | null;
	if (created === null) {
		return err({ kind: "http_error", detail: "POST /merge_requests returned an unreadable body" });
	}
	const ref = toPullRequestRef(ctx.projectPath, created);
	if (ref === null) {
		return err({ kind: "http_error", detail: "forge response carried no MR iid/web_url" });
	}
	return ok(ref);
}

/** Read MR lifecycle state. The plan-run merge gate and merge-watcher consume this. */
export async function getMergeRequest(
	ctx: GitLabCallContext,
	iid: number,
): Promise<ForgeResult<PullRequestState>> {
	const result = await requestGitLab({
		url: gitLabProjectSubUrl(ctx.apiBase, ctx.projectPath, `merge_requests/${iid}`),
		method: "GET",
		token: ctx.token,
		userAgent: ctx.userAgent,
		context: `GET /merge_requests/${iid}`,
		fetch: ctx.fetch,
	});
	if (!result.ok) return err(toForgeError(result.error));
	const body = (await readJson(result.response)) as GitLabMrJson | null;
	if (body === null) {
		return err({ kind: "http_error", detail: `GET /merge_requests/${iid} returned no body` });
	}
	return ok(toPullRequestState(body));
}

/** Rewrite an MR description. The domain composes the text; this only transports it (§3). */
export async function setMergeRequestDescription(
	ctx: GitLabCallContext,
	iid: number,
	description: string,
): Promise<ForgeResult<void>> {
	const result = await requestGitLab({
		url: gitLabProjectSubUrl(ctx.apiBase, ctx.projectPath, `merge_requests/${iid}`),
		method: "PUT",
		token: ctx.token,
		userAgent: ctx.userAgent,
		context: `PUT /merge_requests/${iid}`,
		body: { description },
		fetch: ctx.fetch,
	});
	if (!result.ok) return err(toForgeError(result.error));
	return ok(undefined);
}

/**
 * Transport kind to seam kind — a rename, since the two vocabularies were
 * kept aligned deliberately (forge-contract.md §6.4).
 */
export function toForgeError(error: {
	kind: ForgeError["kind"];
	status: number;
	retryAfterMs: number | null;
	message: string;
}): ForgeError {
	const base: ForgeError = { kind: error.kind, status: error.status, detail: error.message };
	if (error.kind === "rate_limited" && error.retryAfterMs !== null) {
		return { ...base, retryAfterMs: error.retryAfterMs };
	}
	return base;
}
