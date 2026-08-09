/**
 * Parse a git forge URL into the `{host, owner, name}` triple warren uses to
 * lay out `/data/projects/<owner>/<name>`
 * (docs/design/runtime-and-supervisor.md).
 *
 * Three accepted shapes — the operator pastes whichever the forge UI gave them:
 *   - `https://<host>/<owner>/<name>[.git]`
 *   - `git@<host>:<owner>/<name>[.git]`
 *   - `ssh://git@<host>/<owner>/<name>[.git]`
 *
 * Supported hosts (warren-fg01):
 *   - `github.com` — GitHub (the historical default)
 *   - Any Forgejo / Gitea instance when configured via `WARREN_FORGEJO_HOST`
 *
 * The `.git` suffix and trailing slashes are stripped. `owner` and `name` are
 * validated against a safe character set (`[A-Za-z0-9._-]+`) and explicitly
 * forbidden from being `.`, `..`, or starting with `-`, so the resulting
 * on-disk path can't escape the projects root or shadow a dotfile.
 */

import { ValidationError } from "../core/errors.ts";

/** @deprecated Use `ParsedRepoUrl` — this alias kept for call-site compat. */
export type ParsedGitHubUrl = ParsedRepoUrl;

export interface ParsedRepoUrl {
	readonly host: string;
	readonly owner: string;
	readonly name: string;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

/** @deprecated Use `parseRepoUrl` — this alias kept for call-site compat. */
export function parseGitHubUrl(input: string): ParsedRepoUrl {
	return parseRepoUrl(input);
}

/**
 * Parse a git forge URL (GitHub or Forgejo). Throws `ValidationError` for
 * empty input, unrecognized shapes, or invalid owner/name segments.
 */
export function parseRepoUrl(input: string): ParsedRepoUrl {
	const trimmed = input.trim();
	if (trimmed === "") {
		throw new ValidationError("gitUrl is empty", {
			recoveryHint:
				"pass a forge URL, e.g. https://github.com/owner/name or https://forgejo.example.com/owner/name",
		});
	}

	const segments = extractOwnerName(trimmed);
	if (segments === undefined) {
		throw new ValidationError(`unrecognized git URL: ${trimmed}`, {
			recoveryHint: "use https://<host>/<owner>/<name>[.git] or git@<host>:<owner>/<name>[.git]",
		});
	}

	const owner = stripGitSuffix(segments.owner);
	const name = stripGitSuffix(segments.name);
	validateSegment(owner, "owner");
	validateSegment(name, "name");
	return { host: segments.host, owner, name };
}

function extractOwnerName(url: string): { host: string; owner: string; name: string } | undefined {
	// scp-style: git@<host>:owner/name(.git)?
	const scp = /^git@([^:@\s]+):([^/\s]+)\/(.+?)\/?$/.exec(url);
	if (scp !== null) {
		const host = scp[1];
		const owner = scp[2];
		const name = scp[3];
		if (host === undefined || owner === undefined || name === undefined) return undefined;
		return { host: host.toLowerCase(), owner, name };
	}

	// https or ssh (URL-parseable)
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	const host = parsed.hostname.toLowerCase();
	const protocol = parsed.protocol;
	if (host === "" || (protocol !== "https:" && protocol !== "http:" && protocol !== "ssh:")) {
		return undefined;
	}
	const parts = parsed.pathname.split("/").filter((p) => p !== "");
	if (parts.length < 2) return undefined;
	return { host, owner: parts[0] as string, name: parts.slice(1).join("/") };
}

function stripGitSuffix(segment: string): string {
	return segment.endsWith(".git") ? segment.slice(0, -4) : segment;
}

function validateSegment(segment: string, label: string): void {
	if (segment === "" || segment === "." || segment === "..") {
		throw new ValidationError(`invalid ${label} in git URL: ${JSON.stringify(segment)}`, {
			recoveryHint: "owner and repo name must be non-empty path segments",
		});
	}
	if (segment.startsWith("-")) {
		throw new ValidationError(`invalid ${label} in git URL: ${JSON.stringify(segment)}`, {
			recoveryHint: "owner and repo name must not start with a dash",
		});
	}
	if (!SEGMENT.test(segment)) {
		throw new ValidationError(`invalid ${label} in git URL: ${JSON.stringify(segment)}`, {
			recoveryHint: "owner and repo name may only contain letters, digits, '.', '_', '-'",
		});
	}
}
