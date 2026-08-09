/**
 * Git provider resolution (warren-fg01).
 *
 * Warren currently supports two forge providers:
 *   - `github`  — github.com, the default. GitHub REST API at
 *                 `https://api.github.com`.
 *   - `forgejo` — any self-hosted Forgejo / Gitea instance. REST API at
 *                 `https://<host>/api/v1`. URLs use `/pulls/<n>` (plural)
 *                 vs GitHub's `/pull/<n>` (singular).
 *
 * Provider is resolved from the hostname in the project's git URL — no extra
 * config key is needed to distinguish providers at add-project time. The
 * supervisor wires git insteadOf rules at boot for each configured host
 * (`GITHUB_TOKEN` → github.com, `FORGEJO_TOKEN` + `WARREN_FORGEJO_HOST` →
 * the Forgejo instance).
 */

export type GitProviderKind = "github" | "forgejo";

export interface GitProviderInfo {
	readonly kind: GitProviderKind;
	readonly host: string;
	readonly apiBase: string;
}

export const GITHUB_HOST = "github.com";

/**
 * Resolve the git provider for a given hostname (lower-cased). `github.com`
 * → GitHub; anything else → Forgejo (Gitea-compatible API surface).
 */
export function resolveGitProviderFromHost(host: string): GitProviderInfo {
	const h = host.toLowerCase();
	if (h === GITHUB_HOST) {
		return { kind: "github", host: GITHUB_HOST, apiBase: "https://api.github.com" };
	}
	return { kind: "forgejo", host: h, apiBase: `https://${h}/api/v1` };
}

/**
 * Resolve the git provider from a full git URL. Falls back to GitHub on
 * parse failure so a malformed URL surfaces as a GitHub-shaped error (the
 * same error the caller would have seen before Forgejo support landed).
 */
export function resolveGitProviderFromUrl(gitUrl: string): GitProviderInfo {
	try {
		const parsed = new URL(gitUrl);
		if (parsed.hostname !== "") {
			return resolveGitProviderFromHost(parsed.hostname);
		}
	} catch {
		// fall through to GitHub default
	}
	return resolveGitProviderFromHost(GITHUB_HOST);
}

/**
 * Select the right API token for a given provider. Forgejo uses
 * `FORGEJO_TOKEN` (falling back to `GITHUB_TOKEN`); GitHub always uses
 * `GITHUB_TOKEN`. Pass `forgejoToken` from `AutoOpenPrConfig`.
 */
export function selectProviderToken(
	kind: GitProviderKind,
	githubToken: string,
	forgejoToken: string | undefined,
): string {
	if (kind === "forgejo") return forgejoToken ?? githubToken;
	return githubToken;
}
