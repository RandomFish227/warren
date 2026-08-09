/**
 * Install `git insteadOf` rewrites that inject API tokens into HTTPS
 * fetches/pushes against forge hosts (warren-dcf3, warren-fg01).
 *
 * Two rewrites are supported:
 *   - GitHub (`GITHUB_TOKEN` → github.com) — always attempted.
 *   - Forgejo (`FORGEJO_TOKEN` + `WARREN_FORGEJO_HOST`) — attempted when both
 *     are set. `WARREN_FORGEJO_HOST` must be the bare hostname
 *     (e.g. `codeberg.org`), not a URL.
 *
 * The container has no credential helper configured; without these rules
 * `git push` from the reap step (and `git clone` / `git fetch` from project
 * management) prompts for a password and fails non-interactively. The
 * supervisor runs this once at boot — before spawning burrow + warren — so
 * the rewrites are in place by the time any child process shells out to git.
 *
 * `git config --global` writes `$HOME/.gitconfig`. Inside the container
 * `HOME=/root`, so the rules live at `/root/.gitconfig`. Idempotent:
 * re-invoking on container restart overwrites the existing values.
 *
 * LOCAL TOPOLOGY ONLY: the K8s control plane runs `warren serve` with no
 * supervisor, so these global rules never install there. The serve path's
 * host-side git network ops instead carry the same rewrites per-spawn via
 * `gitCredentialGitEnv` (`src/workspace/git/credential-env.ts`), threaded
 * from `AutoOpenPrConfig`. The two compose harmlessly when both are present
 * (same key, same value).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SupervisorLogger } from "./main.ts";

const execFileAsync = promisify(execFile);

export type GitCredentialsRun = (
	cmd: string,
	args: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface GitCredentialsDeps {
	readonly run: GitCredentialsRun;
	readonly logger: SupervisorLogger;
}

export interface GitCredentialsOpts {
	readonly githubToken: string | undefined;
	/** Forgejo API + git token (`FORGEJO_TOKEN`). Requires `forgejoHost`. */
	readonly forgejoToken?: string | undefined;
	/**
	 * Bare hostname of the Forgejo instance, e.g. `codeberg.org`
	 * (`WARREN_FORGEJO_HOST`). No scheme, no trailing slash.
	 */
	readonly forgejoHost?: string | undefined;
	/** Override the git binary on PATH. Default: "git". */
	readonly gitBinary?: string;
}

export interface GitCredentialsResult {
	readonly installed: boolean;
	readonly forgejoInstalled: boolean;
}

/**
 * Write the insteadOf rewrite for a single host. Throws if git config exits
 * non-zero — the supervisor surfaces that as a startup failure rather than
 * silently booting without a working credential rewrite.
 */
async function writeInsteadOf(
	deps: GitCredentialsDeps,
	git: string,
	token: string,
	host: string,
): Promise<void> {
	const rewriteUrl = `https://x-access-token:${token}@${host}/`;
	const result = await deps.run(git, [
		"config",
		"--global",
		`url.${rewriteUrl}.insteadOf`,
		`https://${host}/`,
	]);
	if (result.exitCode !== 0) {
		throw new Error(
			`git config --global failed (exit ${result.exitCode}): ${result.stderr.trim() || "no stderr"}`,
		);
	}
}

/**
 * Resolves to `{installed, forgejoInstalled}` indicating which rules were
 * written. Throws if git config exits non-zero.
 */
export async function installGitCredentials(
	deps: GitCredentialsDeps,
	opts: GitCredentialsOpts,
): Promise<GitCredentialsResult> {
	const git = opts.gitBinary ?? "git";

	let installed = false;
	const githubToken = opts.githubToken;
	if (githubToken === undefined || githubToken === "") {
		deps.logger.info(
			{},
			"supervisor: GITHUB_TOKEN unset, skipping git insteadOf install for github.com",
		);
	} else {
		await writeInsteadOf(deps, git, githubToken, "github.com");
		deps.logger.info(
			{},
			"supervisor: installed git insteadOf rule for github.com (using GITHUB_TOKEN)",
		);
		installed = true;
	}

	let forgejoInstalled = false;
	const forgejoToken = opts.forgejoToken;
	const forgejoHost = opts.forgejoHost;
	if (forgejoToken && forgejoHost) {
		await writeInsteadOf(deps, git, forgejoToken, forgejoHost);
		deps.logger.info(
			{ host: forgejoHost },
			"supervisor: installed git insteadOf rule for Forgejo host (using FORGEJO_TOKEN)",
		);
		forgejoInstalled = true;
	} else if (forgejoToken && !forgejoHost) {
		deps.logger.info(
			{},
			"supervisor: FORGEJO_TOKEN set but WARREN_FORGEJO_HOST unset — skipping Forgejo git insteadOf install",
		);
	}

	return { installed, forgejoInstalled };
}

export const defaultGitCredentialsRun: GitCredentialsRun = async (cmd, args) => {
	try {
		const { stdout, stderr } = await execFileAsync(cmd, [...args]);
		return { exitCode: 0, stdout, stderr };
	} catch (err) {
		const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
		const exitCode = typeof e.code === "number" ? e.code : 1;
		return {
			exitCode,
			stdout: typeof e.stdout === "string" ? e.stdout : "",
			stderr: typeof e.stderr === "string" ? e.stderr : (e.message ?? ""),
		};
	}
};
