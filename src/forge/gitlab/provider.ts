/**
 * GitLabForge — implementation #2 of the `Forge` contract (forge-contract.md
 * §1), the PAT/static-credential mode over the shared transport
 * (`src/forge/http/`).
 *
 * What is DIFFERENT from the GitHub provider, beyond vocabulary:
 *
 *   - The host is instance state, not a constant. `parseRepoRef` is only able
 *     to claim a URL once an operator has named the instance, so the
 *     constructor refuses an unparseable `instanceUrl` rather than
 *     constructing a forge that owns nothing (§4's fail-loud-at-boot rule).
 *   - A project path is N segments deep because GitLab has nested groups, so
 *     `owner/repo` is not the shape and the packed key is `<host>/<path>`.
 *   - The git credential username is `oauth2`, GitLab's convention for
 *     token-over-HTTPS. No domain code names it, same as `x-access-token`.
 *
 * CAPABILITY NOTE, and read this before assuming the platform is the limit:
 * `checkRuns` and `jobLogs` are false because warren has not implemented the
 * GitLab Pipelines and Jobs APIs yet, NOT because GitLab cannot serve them.
 * GitLab has both. This is a warren gap with a clear filling, unlike the
 * GitHub PAT case where a fine-grained token genuinely cannot reach the Checks
 * API (§6.7). The domain degrades per §5 either way: the CI-fixer poller stays
 * idle and the trigger emits one notice per project.
 *
 * PLAN-RUN LIMITATION: this provider supports SINGLE runs. A plan-run gates
 * each child on the previous PR merging, and warren performs that merge
 * through GitHub's auto-merge workflow rather than through the seam — which is
 * why the contract deliberately has no `mergePullRequest`. A GitLab project
 * has no such workflow, so nothing transitions the MR and the plan-run waits
 * to `parent_pr_merge_timeout`. Closing this needs either a GitLab
 * merge-when-pipeline-succeeds call behind a new capability flag, or a
 * dispatch-time guard that refuses a plan-run on a forge that cannot
 * self-merge. Tracked on warren-75e8.
 */

import type {
	CheckSummary,
	Forge,
	ForgeCapabilities,
	ForgeError,
	ForgeResult,
	GitCredential,
	GitIdentity,
	PullRequestDraft,
	PullRequestQuery,
	PullRequestRef,
	PullRequestState,
	RepoRef,
} from "../contract.ts";
import { ForgeConfigError } from "../errors.ts";
import type { ForgeCredentialSecret, ForgeTokenSource } from "../http/token-source.ts";
import { StaticTokenSource } from "../http/token-source.ts";
import { gitLabApiBase, gitLabProjectSubUrl } from "./endpoints.ts";
import { requestGitLab } from "./http.ts";
import {
	createMergeRequest,
	findMergeRequest,
	type GitLabCallContext,
	getMergeRequest,
	setMergeRequestDescription,
	toForgeError,
} from "./merge-requests.ts";
import { gitLabProjectPath, parseGitLabInstanceUrl, parseGitLabRepoRef } from "./repo-ref.ts";

export { GITLAB_FORGE_KIND } from "./repo-ref.ts";

const USER_AGENT = "warren-forge-gitlab";

/**
 * GitLab's username for token-over-HTTPS git. The provider owns this string
 * and no domain code names it, mirroring `x-access-token` on the GitHub side.
 */
const GIT_USERNAME = "oauth2";

/** Env vars the registry's `gitlab` arm reads. */
export const GITLAB_URL_ENV = "WARREN_GITLAB_URL";
export const GITLAB_TOKEN_ENV = "GITLAB_TOKEN";

/** The two inputs the `gitlab` arm needs, resolved from env at boot. */
export interface GitLabConfig {
	readonly instanceUrl: string;
	readonly token: string;
}

/**
 * The registry's default config factory for the `gitlab` arm: read the
 * instance URL and the credential, failing loud at boot when the URL is
 * missing.
 *
 * The URL is required and the token is NOT, which is deliberate rather than
 * lax. A missing token surfaces later as `no_credential` on the first call,
 * naming the repo it failed for — a clear, recoverable error, and the same
 * behaviour the `github` arm has. A missing URL has no such moment: the forge
 * would construct, claim no clone URL at all, and every project would simply
 * fail to register with nothing naming the cause.
 *
 * The token order matches the `github` arm (warren-1b6f): the forge-neutral
 * `WARREN_GIT_TOKEN` wins, with the forge-specific name as the fallback, so
 * one variable names the git credential whatever the forge is.
 */
export function loadGitLabConfigFromEnv(
	env: Readonly<Record<string, string | undefined>>,
): GitLabConfig {
	const instanceUrl = env[GITLAB_URL_ENV]?.trim() ?? "";
	if (instanceUrl === "") {
		throw new ForgeConfigError(`WARREN_FORGE=gitlab requires ${GITLAB_URL_ENV} to be set`, {
			recoveryHint:
				"Set WARREN_GITLAB_URL to the instance origin, e.g. https://gitlab.com or https://gitlab.example.com:8443, or select a different WARREN_FORGE.",
		});
	}
	const token = firstGitLabToken(env.WARREN_GIT_TOKEN, env[GITLAB_TOKEN_ENV]);
	return { instanceUrl, token };
}

/**
 * The first env token that carries something, trimmed. An operator who exports
 * `WARREN_GIT_TOKEN=""` has not chosen a neutral token, so a blank value must
 * not shadow a valid `GITLAB_TOKEN` behind it.
 */
function firstGitLabToken(...raw: readonly (string | undefined)[]): string {
	for (const value of raw) {
		const trimmed = value?.trim();
		if (trimmed !== undefined && trimmed !== "") return trimmed;
	}
	return "";
}

export interface GitLabForgeOptions {
	/**
	 * The instance URL (`WARREN_GITLAB_URL`), e.g. `https://gitlab.com` or a
	 * self-hosted `https://gitlab.example.com:8443`. Required — there is no
	 * default host, because a wrong guess would claim URLs this forge does not
	 * own and break the registry's parse chain.
	 */
	readonly instanceUrl: string;
	/** The static secret (a personal, project, or group access token). */
	readonly token?: string;
	/** Dynamic per-call credential source (§4). */
	readonly tokenSource?: ForgeTokenSource;
	/** Injected fetch seam; defaults to `globalThis.fetch`. */
	readonly fetch?: typeof fetch;
}

function ok<T>(value: T): ForgeResult<T> {
	return { ok: true, value };
}

function err<T>(error: ForgeError): ForgeResult<T> {
	return { ok: false, error };
}

export class GitLabForge implements Forge {
	readonly capabilities: ForgeCapabilities;

	private readonly tokens: ForgeTokenSource;
	private readonly fetch: typeof fetch;
	private readonly host: string;
	private readonly apiBase: string;

	constructor(options: GitLabForgeOptions) {
		const instance = parseGitLabInstanceUrl(options.instanceUrl);
		if (instance === null) {
			throw new ForgeConfigError(
				`WARREN_GITLAB_URL is not a usable instance URL: ${JSON.stringify(options.instanceUrl)}`,
				{
					recoveryHint:
						"Set WARREN_GITLAB_URL to the instance origin, e.g. https://gitlab.com or https://gitlab.example.com:8443.",
				},
			);
		}
		this.host = instance.host;
		this.apiBase = gitLabApiBase(instance.origin);
		this.tokens = options.tokenSource ?? new StaticTokenSource(options.token ?? "", "GitLab");
		this.fetch = options.fetch ?? globalThis.fetch;
		this.capabilities = {
			// Not implemented in warren yet — see the CAPABILITY NOTE above.
			checkRuns: false,
			jobLogs: false,
			pullRequestBodyEdit: true,
			branchDelete: true,
			// The token authorizes; it does not name the author (§6.8).
			botIdentity: false,
			credentialLifetime: "static",
		};
	}

	parseRepoRef(cloneUrl: string): RepoRef | null {
		return parseGitLabRepoRef(cloneUrl, this.host);
	}

	async gitCredential(ref: RepoRef): Promise<ForgeResult<GitCredential>> {
		const minted = await this.mint(ref);
		if (!minted.ok) return err(minted.error);
		return ok({
			username: GIT_USERNAME,
			secret: minted.value.secret,
			expiresAt: minted.value.expiresAt,
		});
	}

	async openPullRequest(ref: RepoRef, req: PullRequestDraft): Promise<ForgeResult<PullRequestRef>> {
		const ctx = await this.context(ref);
		if (!ctx.ok) return err(ctx.error);
		return createMergeRequest(ctx.value, req);
	}

	async findPullRequest(
		ref: RepoRef,
		q: PullRequestQuery,
	): Promise<ForgeResult<PullRequestRef | null>> {
		const ctx = await this.context(ref);
		if (!ctx.ok) return err(ctx.error);
		return findMergeRequest(ctx.value, q);
	}

	async getPullRequest(ref: RepoRef, pr: PullRequestRef): Promise<ForgeResult<PullRequestState>> {
		const ctx = await this.context(ref);
		if (!ctx.ok) return err(ctx.error);
		return getMergeRequest(ctx.value, pr.number);
	}

	async setPullRequestBody(
		ref: RepoRef,
		pr: PullRequestRef,
		body: string,
	): Promise<ForgeResult<void>> {
		const ctx = await this.context(ref);
		if (!ctx.ok) return err(ctx.error);
		return setMergeRequestDescription(ctx.value, pr.number, body);
	}

	/** Gated by `capabilities.checkRuns` — see the CAPABILITY NOTE. */
	listChecks(_ref: RepoRef, _commit: string): Promise<ForgeResult<CheckSummary>> {
		return Promise.resolve(
			err({
				kind: "unsupported",
				detail:
					"capabilities.checkRuns is false — warren has not implemented the GitLab Pipelines API yet (warren-75e8); GitLab itself serves it",
			}),
		);
	}

	/** Best-effort by contract: a forge that cannot supply logs returns ok with null. */
	fetchJobLogTail(
		_ref: RepoRef,
		_jobId: string,
		_maxBytes: number,
	): Promise<ForgeResult<string | null>> {
		return Promise.resolve(ok(null));
	}

	async deleteBranch(ref: RepoRef, branch: string): Promise<ForgeResult<void>> {
		const ctx = await this.context(ref);
		if (!ctx.ok) return err(ctx.error);
		const result = await requestGitLab({
			url: gitLabProjectSubUrl(
				this.apiBase,
				ctx.value.projectPath,
				`repository/branches/${encodeURIComponent(branch)}`,
			),
			method: "DELETE",
			token: ctx.value.token,
			userAgent: USER_AGENT,
			context: `DELETE /repository/branches/${branch}`,
			fetch: this.fetch,
		});
		if (!result.ok) return err(toForgeError(result.error));
		return ok(undefined);
	}

	/** PAT mode holds no bot identity (§5): the domain falls back to env. */
	botIdentity(): Promise<ForgeResult<GitIdentity>> {
		return Promise.resolve(
			err({
				kind: "unsupported",
				detail:
					"GitLabForge (PAT/static mode) holds no bot identity — warren names the author via WARREN_GIT_AUTHOR_* (§6.8)",
			}),
		);
	}

	/* ------------------------------------------------------------------- */

	/**
	 * Mint the credential for ONE API call (§4) and resolve the ref's project
	 * path in the same step, so every seam method above is three lines.
	 *
	 * A ref this forge does not own fails as `not_found` rather than throwing:
	 * seam methods never throw, and the only way to reach here with a foreign
	 * ref is a caller that mixed forges, which is a lookup failure.
	 */
	private async context(ref: RepoRef): Promise<ForgeResult<GitLabCallContext>> {
		const projectPath = gitLabProjectPath(ref, this.host);
		if (projectPath === null) {
			return err({
				kind: "not_found",
				detail: `repo ref ${JSON.stringify(ref.key)} does not belong to the GitLab instance at ${this.host}`,
			});
		}
		const minted = await this.mint(ref);
		if (!minted.ok) return err(minted.error);
		return ok({
			apiBase: this.apiBase,
			projectPath,
			token: minted.value.secret,
			fetch: this.fetch,
			userAgent: USER_AGENT,
		});
	}

	private async mint(ref: RepoRef): Promise<ForgeResult<ForgeCredentialSecret>> {
		const minted = await this.tokens.mint();
		if (minted.ok) return minted;
		if (minted.error.kind === "no_credential") {
			return err({
				kind: "no_credential",
				detail: `no GitLab credential configured; cannot call the forge for ${ref.key}`,
			});
		}
		return err(minted.error);
	}
}
