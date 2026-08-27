/**
 * GitLab REST transport — header builder.
 *
 * The canonical header set for every GitLab API call. Deliberately short,
 * because most of what the GitHub builder carries has no GitLab equivalent:
 * there is no vendor accept type and no API-version header, since GitLab
 * versions by URL path (`/api/v4`, see endpoints.ts).
 *
 * Authentication uses `PRIVATE-TOKEN`, which is the documented header for
 * personal, project, and group access tokens — the credential shapes an
 * operator actually configures for warren. GitLab also accepts
 * `Authorization: Bearer` for those, and requires Bearer for OAuth2 tokens,
 * but OAuth2 is not a mode warren offers yet. Adding it is a change to this
 * builder alone, not to the transport.
 *
 * Note the asymmetry with git-over-HTTPS: the git credential username is
 * `oauth2` (see the provider's `gitCredential`), which is unrelated to the API
 * header above. Both are correct; they authenticate different protocols.
 */

/**
 * Default `User-Agent` when the caller does not name its subsystem. Kept
 * present on every request because a UA-less client is indistinguishable from
 * a scraper to an instance behind a WAF.
 */
export const DEFAULT_GITLAB_USER_AGENT = "warren";

export interface BuildGitLabHeadersOptions {
	/** Subsystem UA (e.g. "warren-forge-gitlab"). Defaults to `DEFAULT_GITLAB_USER_AGENT`. */
	readonly userAgent?: string;
}

/** Build the canonical GitLab REST header set. */
export function buildGitLabHeaders(
	token: string,
	options: BuildGitLabHeadersOptions = {},
): Record<string, string> {
	return {
		accept: "application/json",
		"content-type": "application/json",
		"private-token": token,
		"user-agent": options.userAgent ?? DEFAULT_GITLAB_USER_AGENT,
	};
}
