/**
 * Parse a GitHub URL into the `{owner, name}` pair warren uses to lay
 * out `/data/projects/<owner>/<name>` (docs/design/runtime-and-supervisor.md).
 *
 * Three accepted shapes — the operator pastes whichever GitHub UI gave
 * them:
 *   - `https://github.com/<owner>/<name>[.git]`
 *   - `git@github.com:<owner>/<name>[.git]`
 *   - `ssh://git@github.com/<owner>/<name>[.git]`
 *
 * The `.git` suffix and trailing slashes are stripped. `owner` and `name`
 * are validated against GitHub's character set (`[A-Za-z0-9._-]+`) and
 * explicitly forbidden from being `.`, `..`, or starting with `-`, so
 * the resulting on-disk path can't escape the projects root or shadow a
 * dotfile.
 *
 * Forge plan: `parseGitHubUrl` remains here for backward compatibility.
 * The host-agnostic `parseRepoUrl` in `src/forge/url.ts` is the canonical
 * parser for multi-forge workloads; this function delegates to it and then
 * asserts the host is `github.com` so V1 callers retain their host guard.
 */

import { ValidationError } from "../core/errors.ts";
import { parseRepoUrl } from "../forge/url.ts";

export interface ParsedGitHubUrl {
	readonly owner: string;
	readonly name: string;
}

/** Known public GitHub hosts (covers github.com; GHE detection is declaration-side). */
const GITHUB_HOSTS: ReadonlySet<string> = new Set(["github.com"]);

export function parseGitHubUrl(input: string): ParsedGitHubUrl {
	const ref = parseRepoUrl(input);
	if (!GITHUB_HOSTS.has(ref.host)) {
		throw new ValidationError(`unrecognized GitHub URL: ${input.trim()}`, {
			recoveryHint:
				"use https://github.com/<owner>/<name>[.git] or git@github.com:<owner>/<name>[.git]",
		});
	}
	return { owner: ref.owner, name: ref.name };
}
