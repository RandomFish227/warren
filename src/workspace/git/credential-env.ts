/**
 * Forge-credential git env, the process-scoped twin of the supervisor's
 * global `insteadOf` rule (`src/supervisor/git-credentials.ts`).
 *
 * The supervisor installs `url.https://x-access-token:<token>@<host>/
 * .insteadOf https://<host>/` into the global git config at boot — but
 * only the local topology boots through the supervisor. Under
 * `WARREN_RUNTIME=k8s` the control-plane pod runs `warren serve` directly,
 * so any host-side `git clone` / `fetch` / `push` against a private
 * repo dies on git's interactive username prompt (exit 128,
 * "could not read Username for 'https://…'").
 *
 * This helper renders the SAME rewrite as `GIT_CONFIG_{COUNT,KEY_0,VALUE_0}`
 * env vars (git ≥2.31), merged into a single spawn's environment via the
 * existing `SpawnOptions.env` seam:
 *
 *   - no global (or repo) git config is mutated — the rule lives and dies
 *     with the one child process;
 *   - the token never appears in argv (unlike a token-in-URL clone), so
 *     `ps` can't see it;
 *   - `insteadOf` rewrites on the wire only, so the clone's stored
 *     `origin` URL stays clean.
 *
 * Harmless when doubled up with the supervisor's global rule (same key,
 * same value) and on non-configured remotes (prefix never matches).
 *
 * Forgejo support (warren-fg01): `gitCredentialGitEnv` accepts a `host`
 * parameter so the rule targets the right forge instance. The legacy alias
 * `githubCredentialGitEnv` is kept for call-site compatibility and always
 * targets `github.com`.
 */

/**
 * Env overrides that let a spawned git authenticate to `host` over HTTPS
 * with `token` (the `x-access-token` app-token scheme works for both GitHub
 * and Forgejo/Gitea). Empty / undefined token → `{}`, so call sites can
 * splice unconditionally and public-repo behavior is untouched. Pure.
 */
export function gitCredentialGitEnv(
	token: string | undefined,
	host: string,
): Record<string, string> {
	if (token === undefined || token === "") return {};
	return {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: `url.https://x-access-token:${token}@${host}/.insteadOf`,
		GIT_CONFIG_VALUE_0: `https://${host}/`,
	};
}

/**
 * Backwards-compatible alias targeting `github.com`.
 * @deprecated Prefer `gitCredentialGitEnv(token, host)`.
 */
export function githubCredentialGitEnv(token: string | undefined): Record<string, string> {
	return gitCredentialGitEnv(token, "github.com");
}
