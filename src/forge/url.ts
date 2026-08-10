/**
 * Host-agnostic git URL parser (Forge plan, step 1 / step 3).
 *
 * Accepted shapes, all host-independent:
 *   - `https://<host>/<owner>/<name>[.git]`
 *   - `git@<host>:<owner>/<name>[.git]`
 *   - `ssh://git@<host>/<owner>/<name>[.git]`
 *
 * Unlike the old `parseGitHubUrl` this parser accepts any host, so a GitLab,
 * Gitea, or Forgejo URL is valid input. The forge-kind is stored separately
 * on the project row and never inferred from the host (Forge plan §"The
 * principle: declared, not detected").
 *
 * `parseGitHubUrl` remains in `src/projects/url.ts` as a deprecated shim
 * that delegates here and asserts `host === "github.com"`, so existing callers
 * keep working while the migration proceeds.
 */

import { ValidationError } from "../core/errors.ts";
import type { RepoRef } from "./contract.ts";

/** Same character set GitHub and most forges use. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Parse any valid git remote URL into a `RepoRef`. Throws `ValidationError`
 * for empty, unrecognised, or structurally invalid input.
 */
export function parseRepoUrl(input: string): RepoRef {
	const trimmed = input.trim();
	if (trimmed === "") {
		throw new ValidationError("gitUrl is empty", {
			recoveryHint: "pass a git URL, e.g. https://github.com/owner/name",
		});
	}

	const segments = extractHostOwnerName(trimmed);
	if (segments === undefined) {
		throw new ValidationError(`unrecognized git URL: ${trimmed}`, {
			recoveryHint: "use https://<host>/<owner>/<name>[.git] or git@<host>:<owner>/<name>[.git]",
		});
	}

	const owner = stripGitSuffix(segments.owner);
	const name = stripGitSuffix(segments.name);
	validateSegment(owner, "owner");
	validateSegment(name, "name");
	return { host: segments.host.toLowerCase(), owner, name };
}

function extractHostOwnerName(
	url: string,
): { host: string; owner: string; name: string } | undefined {
	// scp-style: git@<host>:owner/name(.git)?
	const scp = /^git@([^:]+):([^/]+)\/(.+?)\/?$/.exec(url);
	if (scp !== null) {
		return { host: scp[1] as string, owner: scp[2] as string, name: scp[3] as string };
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
	if (!host) return undefined;
	if (protocol !== "https:" && protocol !== "http:" && protocol !== "ssh:") {
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
