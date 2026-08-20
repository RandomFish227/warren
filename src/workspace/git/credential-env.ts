/**
 * Git per-spawn credential env (warren-1154 invariant fix).
 *
 * Renders `GIT_CONFIG_{COUNT,KEY_0,VALUE_0}` env vars (git ≥2.31) that rewrite
 * `https://<host>/` to `https://<username>:<secret>@<host>/` for ONE child
 * process. No global git config is mutated, the token never appears in argv,
 * and the clone's `origin` URL stays clean.
 *
 * Taking `GitCredential` (which carries the provider-chosen username) plus the
 * remote host rather than hardcoding both is the §0 fix: the domain must never
 * name `x-access-token` or `github.com` outside `src/forge/`.
 */

import type { GitCredential } from "../../forge/contract.ts";

/**
 * Extract the HTTPS hostname from a git clone URL.
 * - `https://github.com/o/r.git` → `"github.com"`
 * - `git@github.com:o/r.git` → `"github.com"`
 * - `ssh://git@github.com/o/r` → `"github.com"`
 * Returns `undefined` for unrecognised forms.
 */
export function extractGitHost(gitUrl: string): string | undefined {
	try {
		// Handle scp-style: git@host:path
		const scp = /^[^@]+@([^:]+):/.exec(gitUrl);
		if (scp !== null) return scp[1];
		return new URL(gitUrl).hostname || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Env overrides that let a spawned git authenticate to `host` over HTTPS using
 * `cred`. Empty/absent credential or absent host → `{}`, so call sites splice
 * unconditionally and public-repo behavior is untouched. Pure.
 */
export function credentialGitEnv(
	cred: GitCredential | undefined,
	host: string | undefined,
): Record<string, string> {
	if (cred === undefined || host === undefined || cred.secret === "") return {};
	return {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: `url.https://${cred.username}:${cred.secret}@${host}/.insteadOf`,
		GIT_CONFIG_VALUE_0: `https://${host}/`,
	};
}
