/**
 * `GitLabForge` — gitlab.com / self-hosted GitLab implementation of the
 * `Forge` interface (Forge plan, step 6).
 *
 * GitLab uses "merge requests" (MRs) rather than "pull requests" (PRs).
 * Translation happens internally; callers only ever see the canonical
 * `Forge` vocabulary.
 *
 * Key differences from GitHub:
 *   - API base: `https://<host>/api/v4`
 *   - Project id: URL-encoded `owner%2Frepo` in path segments
 *   - Branch fields: `source_branch` / `target_branch`
 *   - Auth header: `PRIVATE-TOKEN: <token>` (not `Authorization: Bearer`)
 *   - Merged state: `state: "merged"` (not `merged_at !== null`)
 *   - MR URL path: `/-/merge_requests/<n>` (not `/pull/<n>`)
 */

import type {
	ChecksResult,
	Forge,
	OpenPrInput,
	OpenPrResult,
	ParsedPrUrl,
	PrMergeState,
	RepoRef,
} from "../contract.ts";

function buildHeaders(token: string): Record<string, string> {
	return {
		accept: "application/json",
		"content-type": "application/json",
		"PRIVATE-TOKEN": token,
	};
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

function encodedProjectId(owner: string, name: string): string {
	return encodeURIComponent(`${owner}/${name}`);
}

const MR_URL_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/-\/merge_requests\/(\d+)(?:[/?#].*)?$/;

export class GitLabForge implements Forge {
	readonly kind = "gitlab" as const;

	buildGitCredentialEnv(token: string | undefined): Record<string, string> {
		if (token === undefined || token === "") return {};
		// GitLab uses oauth2:<token> for HTTPS access-token auth
		return { GITLAB_TOKEN: token };
	}

	async openPullRequest(input: OpenPrInput): Promise<OpenPrResult> {
		if (input.token === "") {
			return {
				ok: false,
				reason: "missing_token",
				message: "GitLab token unset; cannot open merge request",
			};
		}
		const base = `https://${input.repo.host}/api/v4`;
		const pid = encodedProjectId(input.repo.owner, input.repo.name);
		const url = `${base}/projects/${pid}/merge_requests`;
		let res: Response;
		try {
			res = await fetch(url, {
				method: "POST",
				headers: buildHeaders(input.token),
				body: JSON.stringify({
					title: input.title,
					description: input.body,
					source_branch: input.head,
					target_branch: input.base,
				}),
			});
		} catch (err) {
			return {
				ok: false,
				reason: "network",
				message: err instanceof Error ? err.message : String(err),
			};
		}
		if (res.status === 201) {
			const created = (await readJson(res)) as { web_url?: unknown } | null;
			const link = typeof created?.web_url === "string" ? created.web_url : null;
			if (link === null)
				return {
					ok: false,
					reason: "http_error",
					message: "POST /merge_requests returned no web_url",
				};
			return { ok: true, url: link, mode: "created" };
		}
		if (res.status === 409) {
			const existing = await this.findExistingPr(input);
			if (existing !== null) return { ok: true, url: existing, mode: "exists" };
			return {
				ok: false,
				reason: "http_error",
				message: "MR already exists but lookup did not return a url",
			};
		}
		const text = await readText(res);
		return {
			ok: false,
			reason: "http_error",
			message: `POST /merge_requests returned ${res.status}: ${truncate(text, 500)}`,
		};
	}

	async findExistingPr(input: Omit<OpenPrInput, "title" | "body">): Promise<string | null> {
		if (input.token === "") return null;
		const base = `https://${input.repo.host}/api/v4`;
		const pid = encodedProjectId(input.repo.owner, input.repo.name);
		const params = new URLSearchParams({
			state: "opened",
			source_branch: input.head,
			target_branch: input.base,
		});
		const url = `${base}/projects/${pid}/merge_requests?${params}`;
		let res: Response;
		try {
			res = await fetch(url, { method: "GET", headers: buildHeaders(input.token) });
		} catch {
			return null;
		}
		if (!res.ok) return null;
		const list = (await readJson(res)) as Array<{ web_url?: unknown }> | null;
		if (!Array.isArray(list) || list.length === 0) return null;
		const first = list[0];
		return typeof first?.web_url === "string" ? first.web_url : null;
	}

	async checkPrMerged(prUrl: string, token: string): Promise<PrMergeState> {
		if (token === "")
			return { kind: "missing_token", message: "GitLab token unset; cannot check merge state" };
		const parsed = this.parsePrUrl(prUrl);
		if (parsed === null)
			return { kind: "http_error", status: 0, message: `not a GitLab MR URL: ${prUrl}` };
		const base = `https://${parsed.repo.host}/api/v4`;
		const pid = encodedProjectId(parsed.repo.owner, parsed.repo.name);
		const url = `${base}/projects/${pid}/merge_requests/${parsed.number}`;
		let res: Response;
		try {
			res = await fetch(url, { method: "GET", headers: buildHeaders(token) });
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
				message: `GET /merge_requests/${parsed.number} returned ${res.status}: ${truncate(text, 500)}`,
			};
		}
		const body = (await readJson(res)) as { state?: unknown; merged_at?: unknown } | null;
		const state = typeof body?.state === "string" ? body.state : "";
		if (state === "merged") {
			const mergedAt =
				typeof body?.merged_at === "string" ? body.merged_at : new Date().toISOString();
			return { kind: "merged", mergedAt };
		}
		if (state === "closed") return { kind: "closed_unmerged" };
		return { kind: "open" };
	}

	parsePrUrl(raw: string): ParsedPrUrl | null {
		const m = MR_URL_RE.exec(raw.trim());
		if (m === null) return null;
		const [, host, owner, name, num] = m;
		if (host === undefined || owner === undefined || name === undefined || num === undefined)
			return null;
		const n = Number.parseInt(num, 10);
		if (!Number.isFinite(n) || n <= 0) return null;
		return { repo: { host, owner, name }, number: n };
	}

	fetchChecks(_repo: RepoRef, _sha: string, _token: string): Promise<ChecksResult> {
		return Promise.resolve({ kind: "unsupported" });
	}
}
