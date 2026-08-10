/**
 * `FakeForge` — in-memory forge implementation for acceptance tests
 * (Forge plan, step 8).
 *
 * Selected by `WARREN_FORGE_OVERRIDE=fake`. Deliberately NOT a `ForgeKind`
 * value — the fake can never be persisted on a project row or chosen by an
 * operator. It is the acceptance seam that replaces `WARREN_GH_FETCH_OVERRIDE`
 * once all call sites use the forge seam.
 *
 * The falsification test: a FakeForge project completes the full
 * dispatch → reap → push → PR cycle with zero changes to domain code.
 * If domain code needs touching, the seam is in the wrong place.
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

/** Env var that selects the fake forge instead of a real one. */
export const WARREN_FORGE_OVERRIDE_ENV = "WARREN_FORGE_OVERRIDE";

export class FakeForge implements Forge {
	readonly kind = "github" as const;

	private readonly prs = new Map<string, { url: string; merged: boolean }>();
	private prCounter = 0;

	buildGitCredentialEnv(_token: string | undefined): Record<string, string> {
		return {};
	}

	async openPullRequest(input: OpenPrInput): Promise<OpenPrResult> {
		const key = `${input.repo.owner}/${input.repo.name}/${input.head}→${input.base}`;
		const existing = this.prs.get(key);
		if (existing !== undefined) return { ok: true, url: existing.url, mode: "exists" };
		this.prCounter += 1;
		const url = `https://github.com/${input.repo.owner}/${input.repo.name}/pull/${this.prCounter}`;
		this.prs.set(key, { url, merged: false });
		return Promise.resolve({ ok: true, url, mode: "created" });
	}

	async findExistingPr(input: Omit<OpenPrInput, "title" | "body">): Promise<string | null> {
		const key = `${input.repo.owner}/${input.repo.name}/${input.head}→${input.base}`;
		return Promise.resolve(this.prs.get(key)?.url ?? null);
	}

	async checkPrMerged(prUrl: string, _token: string): Promise<PrMergeState> {
		for (const pr of this.prs.values()) {
			if (pr.url === prUrl) {
				if (pr.merged) return { kind: "merged", mergedAt: new Date().toISOString() };
				return { kind: "open" };
			}
		}
		return Promise.resolve({ kind: "missing_token", message: "fake: PR not found" });
	}

	parsePrUrl(raw: string): ParsedPrUrl | null {
		const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(raw);
		if (m === null) return null;
		const [, owner, name, num] = m;
		if (owner === undefined || name === undefined || num === undefined) return null;
		const n = Number.parseInt(num, 10);
		return { repo: { host: "github.com", owner, name }, number: n };
	}

	fetchChecks(_repo: RepoRef, _sha: string, _token: string): Promise<ChecksResult> {
		return Promise.resolve({ kind: "none" });
	}

	/** Test helper: mark a PR as merged. */
	mergePr(prUrl: string): void {
		for (const pr of this.prs.values()) {
			if (pr.url === prUrl) {
				pr.merged = true;
				return;
			}
		}
	}
}
