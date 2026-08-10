/**
 * `GiteaForge` — Gitea / Forgejo implementation of the `Forge` interface
 * (Forge plan, step 5).
 *
 * One implementation serves both `gitea` and `forgejo` ForgeKinds because
 * Forgejo's API is a superset of Gitea's at the surface warren exposes
 * (open PR, find PR, check merge, fetch checks). The `kind` discriminant
 * preserves which the operator declared so Renovate / Woodpecker can
 * diverge later without a migration.
 *
 * API base: `https://<host>/api/v1`
 * Auth header: `Authorization: token <token>` (Gitea scheme)
 * PR noun: "pull request" (same path as GitHub but under /api/v1)
 */

import type {
	ChecksResult,
	Forge,
	ForgeKind,
	OpenPrInput,
	OpenPrResult,
	ParsedPrUrl,
	PrMergeState,
	RepoRef,
} from "../contract.ts";

function buildHeaders(token: string): Record<string, string> {
	return {
		accept: "application/json",
		authorization: `token ${token}`,
		"content-type": "application/json",
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

const PR_URL_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pulls\/(\d+)(?:[/?#].*)?$/;

export class GiteaForge implements Forge {
	readonly kind: ForgeKind;

	constructor(kind: "gitea" | "forgejo") {
		this.kind = kind;
	}

	buildGitCredentialEnv(token: string | undefined): Record<string, string> {
		if (token === undefined || token === "") return {};
		// Gitea / Forgejo use the same x-access-token scheme as GitHub
		// but the host is dynamic (self-hosted). We cannot express a
		// host-specific insteadOf without knowing the host at env-build
		// time — which we don't have here. Callers that need host-specific
		// rewrites should pass the host through and build the env there.
		// For now, return a GITEA_TOKEN env var that `git credential`
		// helpers pick up via git-credential-env or similar mechanisms.
		// See Forge plan §"Credentials" — this is a known iteration point.
		return { GITEA_TOKEN: token };
	}

	async openPullRequest(input: OpenPrInput): Promise<OpenPrResult> {
		if (input.token === "") {
			return {
				ok: false,
				reason: "missing_token",
				message: "forge token unset; cannot open pull request",
			};
		}
		const base = `https://${input.repo.host}/api/v1`;
		const url = `${base}/repos/${input.repo.owner}/${input.repo.name}/pulls`;
		let res: Response;
		try {
			res = await fetch(url, {
				method: "POST",
				headers: buildHeaders(input.token),
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
		if (res.status === 201) {
			const created = (await readJson(res)) as { html_url?: unknown } | null;
			const link = typeof created?.html_url === "string" ? created.html_url : null;
			if (link === null)
				return { ok: false, reason: "http_error", message: "POST /pulls returned no html_url" };
			return { ok: true, url: link, mode: "created" };
		}
		if (res.status === 409) {
			const existing = await this.findExistingPr(input);
			if (existing !== null) return { ok: true, url: existing, mode: "exists" };
			return {
				ok: false,
				reason: "http_error",
				message: "PR already exists but lookup did not return a url",
			};
		}
		const text = await readText(res);
		return {
			ok: false,
			reason: "http_error",
			message: `POST /pulls returned ${res.status}: ${truncate(text, 500)}`,
		};
	}

	async findExistingPr(input: Omit<OpenPrInput, "title" | "body">): Promise<string | null> {
		if (input.token === "") return null;
		const base = `https://${input.repo.host}/api/v1`;
		const params = new URLSearchParams({ state: "open", limit: "1" });
		const url = `${base}/repos/${input.repo.owner}/${input.repo.name}/pulls?${params}`;
		let res: Response;
		try {
			res = await fetch(url, { method: "GET", headers: buildHeaders(input.token) });
		} catch {
			return null;
		}
		if (!res.ok) return null;
		const list = (await readJson(res)) as Array<{
			html_url?: unknown;
			head?: { label?: unknown };
		}> | null;
		if (!Array.isArray(list)) return null;
		const match = list.find((pr) => pr.head?.label === `${input.repo.owner}:${input.head}`);
		return typeof match?.html_url === "string" ? match.html_url : null;
	}

	async checkPrMerged(prUrl: string, token: string): Promise<PrMergeState> {
		if (token === "")
			return { kind: "missing_token", message: "forge token unset; cannot check merge state" };
		const parsed = this.parsePrUrl(prUrl);
		if (parsed === null)
			return { kind: "http_error", status: 0, message: `not a Gitea/Forgejo PR URL: ${prUrl}` };
		const base = `https://${parsed.repo.host}/api/v1`;
		const url = `${base}/repos/${parsed.repo.owner}/${parsed.repo.name}/pulls/${parsed.number}`;
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
				message: `GET /pulls/${parsed.number} returned ${res.status}: ${truncate(text, 500)}`,
			};
		}
		const body = (await readJson(res)) as {
			merged?: unknown;
			state?: unknown;
			merged_at?: unknown;
		} | null;
		if (body?.merged === true || typeof body?.merged_at === "string") {
			const mergedAt =
				typeof body?.merged_at === "string" ? body.merged_at : new Date().toISOString();
			return { kind: "merged", mergedAt };
		}
		const state = typeof body?.state === "string" ? body.state : "";
		if (state === "closed") return { kind: "closed_unmerged" };
		return { kind: "open" };
	}

	parsePrUrl(raw: string): ParsedPrUrl | null {
		const m = PR_URL_RE.exec(raw.trim());
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
