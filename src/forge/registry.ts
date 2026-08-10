/**
 * Forge registry — `forgeFor(project)` resolves the `Forge` implementation
 * for a project (Forge plan, step 3 / registry).
 *
 * The forge is declared on the project row (`project.forgeKind`) and
 * resolved once per call (memoised by kind+host for the common case).
 * Warren never auto-detects the forge kind from the URL — the operator's
 * declaration is authoritative.
 *
 * Token resolution: per-host env wins, then per-kind default:
 *   `WARREN_FORGE_TOKEN__<host_with_underscores>=…`  (host-specific)
 *   `GITLAB_TOKEN=…`, `GITEA_TOKEN=…`, `FORGEJO_TOKEN=…`             (kind fallback)
 *   `GITHUB_TOKEN=…`                                                   (GitHub)
 */

import type { ForgeKind } from "../core/wire.ts";
import type { Forge } from "./contract.ts";
import { GiteaForge } from "./gitea/index.ts";
import { GitHubForge } from "./github/index.ts";
import { GitLabForge } from "./gitlab/index.ts";

/** Project-row subset needed to resolve the forge. */
export interface ForgeableProject {
	readonly forgeKind: ForgeKind;
	readonly gitUrl: string;
}

/** Env-like — process.env by default, injected by tests. */
export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Resolve the `Forge` implementation for `project`.
 * Memoised per `ForgeKind` (since each implementation is stateless), so
 * the registry allocates at most four objects across the process lifetime.
 */
export function forgeFor(project: ForgeableProject): Forge {
	return resolveForge(project.forgeKind);
}

/** The token warren should pass to forge operations for this project. */
export function forgeTokenFor(project: ForgeableProject, env: EnvLike = process.env): string {
	const { forgeKind, gitUrl } = project;

	// Per-host token wins. Host key: dots and hyphens become underscores.
	let host: string | undefined;
	try {
		host = new URL(gitUrl).hostname;
	} catch {
		const scp = /^git@([^:]+):/.exec(gitUrl);
		host = scp?.[1];
	}
	if (host !== undefined) {
		const hostKey = `WARREN_FORGE_TOKEN__${host.replace(/[.-]/g, "_")}`;
		const hostToken = env[hostKey];
		if (hostToken !== undefined && hostToken !== "") return hostToken;
	}

	// Per-kind fallback
	const kindKey: Record<ForgeKind, string> = {
		github: "GITHUB_TOKEN",
		gitlab: "GITLAB_TOKEN",
		gitea: "GITEA_TOKEN",
		forgejo: "FORGEJO_TOKEN",
	};
	return env[kindKey[forgeKind]] ?? "";
}

// --- private ---

const cache = new Map<ForgeKind, Forge>();

function resolveForge(kind: ForgeKind): Forge {
	const cached = cache.get(kind);
	if (cached !== undefined) return cached;
	const forge = buildForge(kind);
	cache.set(kind, forge);
	return forge;
}

function buildForge(kind: ForgeKind): Forge {
	switch (kind) {
		case "github":
			return new GitHubForge();
		case "gitlab":
			return new GitLabForge();
		case "gitea":
			return new GiteaForge("gitea");
		case "forgejo":
			return new GiteaForge("forgejo");
	}
}
