/**
 * `GitHubForge` — github.com implementation of the `Forge` interface
 * (Forge plan, step 3).
 *
 * Delegates to the canonical implementations in `./resources.ts` and
 * `./http.ts`. The credential env uses the same `GIT_CONFIG_*` scheme as
 * `githubCredentialGitEnv` in `src/workspace/git/credential-env.ts`,
 * keeping existing clone/refresh tests green while establishing the seam.
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
import {
	GH_PR_URL_RE,
	ghCheckPrMerged,
	ghFetchChecks,
	ghFindExistingPr,
	ghOpenPullRequest,
	ghParsePrUrl,
} from "./resources.ts";

export class GitHubForge implements Forge {
	readonly kind = "github" as const;

	buildGitCredentialEnv(token: string | undefined): Record<string, string> {
		if (token === undefined || token === "") return {};
		return {
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: `url.https://x-access-token:${token}@github.com/.insteadOf`,
			GIT_CONFIG_VALUE_0: "https://github.com/",
		};
	}

	openPullRequest(input: OpenPrInput): Promise<OpenPrResult> {
		return ghOpenPullRequest(input);
	}

	findExistingPr(input: Omit<OpenPrInput, "title" | "body">): Promise<string | null> {
		return ghFindExistingPr(input);
	}

	checkPrMerged(prUrl: string, token: string): Promise<PrMergeState> {
		return ghCheckPrMerged(prUrl, token);
	}

	parsePrUrl(raw: string): ParsedPrUrl | null {
		return ghParsePrUrl(raw);
	}

	fetchChecks(repo: RepoRef, sha: string, token: string): Promise<ChecksResult> {
		return ghFetchChecks(repo, sha, token);
	}
}

export { GH_PR_URL_RE };
