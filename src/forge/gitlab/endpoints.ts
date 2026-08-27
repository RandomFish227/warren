/**
 * GitLab REST transport — URL construction.
 *
 * Separate from `headers.ts` because GitLab's addressing carries two rules
 * that GitHub's does not, and both are easy to get subtly wrong:
 *
 *   1. The API base is per-instance. GitHub has one fixed `api.github.com`;
 *      GitLab's is `<origin>/api/v4`, where the origin is whatever the
 *      operator configured. The version lives in the PATH, so there is no
 *      version header to send.
 *   2. A project is addressed by its URL-encoded full path. Nested groups mean
 *      `group/sub/project`, and every slash must become `%2F` — including the
 *      inner ones. `encodeURIComponent` does exactly this, which is why the
 *      path is encoded as ONE component rather than joined per segment.
 *
 * Rule 2 is the one that bites. Encoding per segment and re-joining with `/`
 * produces `group/sub/project`, which GitLab reads as a *different* route and
 * answers with 404 — a failure that reads like a missing project rather than a
 * malformed URL.
 */

/** The version-bearing path segment. GitLab versions its API by path, not header. */
export const GITLAB_API_PATH = "/api/v4";

/** Build the API base for an instance origin (`https://gitlab.example.com`). */
export function gitLabApiBase(origin: string): string {
	return `${origin.replace(/\/+$/, "")}${GITLAB_API_PATH}`;
}

/**
 * The `/projects/:id` URL for a project path, with the path encoded as a
 * single component per rule 2 above.
 */
export function gitLabProjectUrl(apiBase: string, projectPath: string): string {
	return `${apiBase}/projects/${encodeURIComponent(projectPath)}`;
}

/**
 * A sub-resource under a project, e.g. `merge_requests` or
 * `merge_requests/7/notes`. `suffix` is appended verbatim, so a caller that
 * needs a query string builds it and any encoding its values require.
 */
export function gitLabProjectSubUrl(apiBase: string, projectPath: string, suffix: string): string {
	return `${gitLabProjectUrl(apiBase, projectPath)}/${suffix}`;
}
