/**
 * `parseRepoRef` support for the GitLab arm (warren-7ba8) — the clone/MR URL
 * grammars and the packed `RepoRef.key` shape, split out of `provider.ts` from
 * the first commit because `src/forge/github/provider.ts` sits at 486/500
 * against `check:size` and forge files are granted no budget entry.
 *
 * Three things make this parser structurally different from
 * `src/forge/github/repo-ref.ts`, and none of them are cosmetic:
 *
 *  1. THE HOST IS CONFIGURED, NOT A LITERAL. GitHub owns exactly two hostnames
 *     so its parser can hardcode them. A GitLab deployment is self-hosted at an
 *     operator-chosen origin, so the host is injected. A parser that guessed
 *     would claim every URL it was handed and break the registry's fixed-order
 *     `parseRepoRef` chain (forge-contract.md §1.1), where returning `null` is
 *     how a forge disowns a URL and lets the next one try.
 *
 *  2. THE PROJECT PATH IS N SEGMENTS, NOT TWO. GitLab nests groups
 *     (`group/subgroup/.../project`), so `owner/repo` is not the shape. The ref
 *     carries the whole path and only the provider destructures it.
 *
 *  3. `/-/` IS THE SENTINEL. GitLab separates a project's path from its
 *     sub-resources with a literal `/-/` segment, which is precisely what makes
 *     an N-segment path unambiguous: everything before `/-/` is the project.
 *     That is why `.../-/merge_requests/<n>` parses without a segment-count rule.
 *
 * Everything here NEVER throws — an unowned URL returns `null` per §1.1.
 */

import type { RepoRef } from "../contract.ts";

/** Registry key this forge answers to (`FORGE_KINDS`). */
export const GITLAB_FORGE_KIND = "gitlab";

/**
 * Path-safety rule, preserved from `src/projects/url.ts` (mx-e741b0) and
 * applied to EVERY segment of the project path.
 *
 * This is warren's on-disk path guard, not GitLab's validation rule — the two
 * differ and warren's is the stricter. A project whose path GitLab accepts but
 * this rejects is disowned rather than registered onto a path that could escape
 * `/data/projects/` or shadow a dotfile.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function isSafeSegment(segment: string): boolean {
	return (
		SAFE_SEGMENT.test(segment) && segment !== "." && segment !== ".." && !segment.startsWith("-")
	);
}

/**
 * GitLab's own sentinel between a project path and its sub-resources. A project
 * path can never contain it, which is what makes an N-segment path parseable.
 */
const DASH_SENTINEL = "-";

/**
 * Top-level paths GitLab reserves for its own routes. A URL starting with one
 * of these is a GitLab page, not a project, so claiming it would register a
 * project that cannot be cloned.
 *
 * Deliberately short: it covers the routes a human can plausibly paste out of
 * the GitLab UI. It is not, and cannot be, GitLab's full reserved list — the
 * authority for whether a project exists is the API, and a wrong guess here
 * fails at clone time with a clear error rather than silently.
 */
const RESERVED_TOP_LEVEL: ReadonlySet<string> = new Set([
	"admin",
	"api",
	"dashboard",
	"explore",
	"groups",
	"help",
	"projects",
	"public",
	"search",
	"users",
]);

/** Minimum project path depth: a project always lives under at least one group. */
const MIN_PATH_SEGMENTS = 2;

/**
 * GitLab caps group nesting at 20 levels, so a project path is at most 21
 * segments. The bound exists so a pathological URL cannot walk an unbounded
 * path into the ref.
 */
const MAX_PATH_SEGMENTS = 21;

/**
 * Parse a clone or MR URL into this forge's opaque ref, or `null` when this
 * GitLab instance does not own it.
 *
 * `host` is the configured instance authority (`gitlab.com`,
 * `gitlab.example.com`, or `gitlab.example.com:8443`) — see
 * `normalizeGitLabHost`. The comparison includes the port, because a forge on a
 * non-default port is a different remote to git.
 *
 * The packed key is `<host>/<project/path>`. Only this provider destructures
 * it (forge-contract.md §0); the API path form is built by
 * {@link gitLabProjectPath}.
 */
export function parseGitLabRepoRef(cloneUrl: string, host: string): RepoRef | null {
	const path = extractProjectPath(cloneUrl.trim(), host);
	if (path === null) return null;
	return { forge: GITLAB_FORGE_KIND, key: `${host}/${path}` };
}

/**
 * The project path held inside a ref this module produced, ready to be
 * URL-encoded into `/api/v4/projects/:id`. Returns `null` for a ref belonging
 * to another forge or another instance, so a caller can never address one
 * instance's project against another's API.
 */
export function gitLabProjectPath(ref: RepoRef, host: string): string | null {
	if (ref.forge !== GITLAB_FORGE_KIND) return null;
	const prefix = `${host}/`;
	if (!ref.key.startsWith(prefix)) return null;
	const path = ref.key.slice(prefix.length);
	return path === "" ? null : path;
}

/**
 * An operator-configured instance URL (`WARREN_GITLAB_URL`) in the two forms
 * the provider needs.
 *
 * `host` is the scheme-less authority the packed `RepoRef` key is built from
 * and compared against. `origin` is `scheme://host`, which the transport needs
 * to build an API base.
 *
 * Both come out of ONE parse deliberately. They differ in exactly one case — a
 * self-hosted instance served over plain http — and deriving the origin
 * separately by assuming https would point the transport at a host that may
 * not answer there, while ref matching kept working. The failure would look
 * like an unreachable API on a project that registered fine.
 */
export interface GitLabInstanceUrl {
	/** Lowercased authority; port preserved only when not the scheme default. */
	readonly host: string;
	/** `scheme://host` — the base the `/api/v4` path hangs off. */
	readonly origin: string;
}

/**
 * Parse an operator-configured instance URL. Returns `null` for input that
 * names no host, so boot can fail loud rather than construct a forge that owns
 * nothing.
 */
export function parseGitLabInstanceUrl(instanceUrl: string): GitLabInstanceUrl | null {
	const trimmed = instanceUrl.trim();
	if (trimmed === "") return null;
	// A bare authority (`gitlab.example.com`) is what an operator most often
	// types; `new URL` needs a scheme, so supply one rather than reject it.
	const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
	let parsed: URL;
	try {
		parsed = new URL(withScheme);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
	const host = parsed.host.toLowerCase();
	if (host === "") return null;
	return { host, origin: `${parsed.protocol}//${host}` };
}

/**
 * Normalize an instance URL to the authority this parser compares against.
 * Thin read of `parseGitLabInstanceUrl` so the scheme rule lives in one place.
 */
export function normalizeGitLabHost(instanceUrl: string): string | null {
	return parseGitLabInstanceUrl(instanceUrl)?.host ?? null;
}

/** Extract the project path from any accepted grammar. */
function extractProjectPath(input: string, host: string): string | null {
	if (input === "" || host === "") return null;

	// Grammar: scp-style `git@<host>:group/sub/project[.git]`. The authority in
	// this spelling carries no port, so it is compared against the host with any
	// port stripped — an scp remote reaches ssh, not the configured http port.
	const scp = /^[^@\s/]+@([^:\s/]+):(.+)$/.exec(input);
	if (scp !== null) {
		if ((scp[1] as string).toLowerCase() !== hostWithoutPort(host)) return null;
		return finishPath((scp[2] as string).split("/"));
	}

	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		return null;
	}
	const protocol = parsed.protocol;
	if (protocol !== "https:" && protocol !== "http:" && protocol !== "ssh:") return null;
	// ssh:// URLs address the ssh port, so they match on host alone, like scp.
	const authority = protocol === "ssh:" ? parsed.hostname.toLowerCase() : parsed.host.toLowerCase();
	const expected = protocol === "ssh:" ? hostWithoutPort(host) : host;
	if (authority !== expected) return null;

	const parts = parsed.pathname.split("/").filter((p) => p !== "");
	// API grammar: `/api/v4/projects/<encoded path>[/...]`. The id is
	// percent-encoded by construction, so it is decoded back to a path here.
	const api = fromApiPath(parts);
	if (api !== null) return api;
	return finishPath(parts);
}

/**
 * `/api/v4/projects/:id` where `:id` is the URL-encoded full path. A numeric id
 * is rejected: it names a project this parser cannot resolve to a path without
 * calling the API, and a ref must be derivable offline.
 */
function fromApiPath(parts: readonly string[]): string | null {
	if (parts.length < 4) return null;
	if (parts[0] !== "api" || parts[1] !== "v4" || parts[2] !== "projects") return null;
	const raw = parts[3] as string;
	if (/^\d+$/.test(raw)) return null;
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		return null;
	}
	return finishPath(decoded.split("/"));
}

/**
 * Trim a path at the `/-/` sentinel, drop a `.git` suffix, and validate every
 * remaining segment. Returns the joined project path, or `null`.
 */
function finishPath(rawSegments: readonly string[]): string | null {
	const segments: string[] = [];
	for (const segment of rawSegments) {
		if (segment === "") continue;
		// Everything from `/-/` onward is a sub-resource, not the project.
		if (segment === DASH_SENTINEL) break;
		segments.push(segment);
	}
	if (segments.length === 0) return null;

	const lastIndex = segments.length - 1;
	segments[lastIndex] = stripGitSuffix(segments[lastIndex] as string);

	if (segments.length < MIN_PATH_SEGMENTS || segments.length > MAX_PATH_SEGMENTS) return null;
	if (RESERVED_TOP_LEVEL.has((segments[0] as string).toLowerCase())) return null;
	for (const segment of segments) {
		if (!isSafeSegment(segment)) return null;
	}
	return segments.join("/");
}

function stripGitSuffix(segment: string): string {
	return segment.endsWith(".git") ? segment.slice(0, -4) : segment;
}

/**
 * The authority with any `:port` removed, for the ssh-family comparisons.
 *
 * A naive `lastIndexOf(":")` slice corrupts an IPv6 authority — bare `[::1]`
 * would become `[:` — and the failure mode is silent: the host stops matching
 * and the forge disowns a URL it owns, so the project simply never registers.
 * The port is therefore stripped only when what follows the final colon is
 * actually a port, and never from inside a bracketed address.
 */
function hostWithoutPort(host: string): string {
	if (host.endsWith("]")) return host;
	const colon = host.lastIndexOf(":");
	if (colon === -1) return host;
	const port = host.slice(colon + 1);
	return /^\d+$/.test(port) ? host.slice(0, colon) : host;
}
