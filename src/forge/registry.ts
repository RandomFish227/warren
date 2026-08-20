/**
 * Forge registry + the `WARREN_FORGE` selector (plan pl-d1c9 step 8,
 * forge-contract.md §1.1).
 *
 * One place resolves which `Forge` (contract in `./contract.ts`) a warren
 * process runs against, exactly once at boot — a deliberate mirror of the
 * runtime-provider precedent (`src/runtime/registry.ts`): same structure,
 * same failure mode. The default is `github` (`GitHubForge`, PAT/static
 * mode); `fake` (`FakeForge`) backs the campaign's falsification tests.
 *
 * Selection rules (§1.1):
 *   - `WARREN_FORGE` unset (or blank) → `github` (the default forge).
 *   - `github` → `GitHubForge` over the static `GITHUB_TOKEN` secret.
 *   - `app`    → `GitHubAppForge` (warren-f8df) over the
 *     `WARREN_GITHUB_APP_ID` / `WARREN_GITHUB_APP_INSTALLATION_ID` /
 *     `WARREN_GITHUB_APP_PRIVATE_KEY` triple; a missing or unparseable
 *     input throws `ForgeConfigError` at boot (fail loud, §4).
 *   - `fake`   → `FakeForge` with its in-memory PR store.
 *   - anything else → `UnknownForgeError` (fail loud — never silently fall
 *     back to the default, so a typo can't route runs onto the wrong forge).
 *
 * Registry CONSTRUCTION only: threading the resolved instance through boot
 * wiring and `ServerDeps` is the next step (warren-6c4c). `parseRepoRef`
 * chaining operates over the boot-registered forges in their fixed
 * registration order (§1.1) — with one real forge registered, the chain
 * has length one.
 */

import type { ForgeInstanceConfig } from "../server-config/schema.ts";
import type { Forge } from "./contract.ts";
import { ForgeConfigError, UnknownForgeError } from "./errors.ts";
import { FakeForge } from "./fake/fake-forge.ts";
import { FAKE_FORGE_STATE_FILE_ENV, FakeForgeStore } from "./fake/store.ts";
import { GitHubForge } from "./github/provider.ts";
import {
	type GitHubAppCredentials,
	GitHubAppForge,
	loadGitHubAppCredentialsFromEnv,
} from "./github-app/provider.ts";

/** Forge backends the selector understands. */
export type ForgeKind = "github" | "app" | "fake";

/** Selector default when `WARREN_FORGE` is unset — the real forge. */
export const DEFAULT_FORGE_KIND: ForgeKind = "github";

/** Every recognized `WARREN_FORGE` value (used for validation + error hints). */
export const FORGE_KINDS: readonly ForgeKind[] = ["github", "app", "fake"];

/** Minimal env surface the selector reads. */
export type ForgeEnv = Readonly<Record<string, string | undefined>>;

/**
 * Dependencies every forge the registry can build is threaded. Kept as a
 * single bag — mirroring `RuntimeProviderDeps` — so adding a backend (the
 * `app` arm landed this way in warren-f8df) doesn't change the selector's
 * signature. The token, app credentials, and the fake's store are factories
 * so the registry needn't touch a secret or construct state for the arm it
 * did not select.
 */
export interface ForgeDeps {
	/**
	 * Lazy static-secret factory for the `github` arm. Optional — when
	 * omitted the selector reads `GITHUB_TOKEN` from the same env the
	 * selection came from. A test injects a throwing factory here to prove
	 * the `fake` arm never touches the github arm's inputs.
	 */
	readonly githubToken?: () => string;
	/**
	 * OPTIONAL fetch seam for the `github` arm — a test injects a stub so
	 * the constructed `GitHubForge` never reaches the network.
	 */
	readonly githubFetch?: typeof fetch;
	/**
	 * OPTIONAL `capabilities.checkRuns` override for the `github` arm
	 * (forge-contract.md §5/§6.7): pass `false` when the configured token
	 * is a fine-grained PAT, which cannot reach the Checks API. Default
	 * true (classic PAT).
	 */
	readonly githubCheckRuns?: boolean;
	/**
	 * Lazy credential factory for the `app` arm (warren-f8df). Optional —
	 * when omitted the selector reads the `WARREN_GITHUB_APP_*` triple from
	 * the same env the selection came from. A test injects a throwing
	 * factory here to prove the other arms never touch the app arm's inputs.
	 */
	readonly githubApp?: () => GitHubAppCredentials;
	/**
	 * OPTIONAL fetch seam for the `app` arm — a test injects a stub so the
	 * constructed `GitHubAppForge` never reaches the network.
	 */
	readonly githubAppFetch?: typeof fetch;
	/**
	 * Lazy store factory for the `fake` arm — only consulted for
	 * `WARREN_FORGE=fake`. Optional: the `FakeForge` defaults to a fresh
	 * in-memory store. A test injects a throwing factory here to prove the
	 * `github` arm never constructs the fake's state.
	 */
	readonly fakeStore?: () => FakeForgeStore;
}

/**
 * Parse + validate the `WARREN_FORGE` selector. Blank/unset resolves to the
 * default; an unrecognized value throws `UnknownForgeError`.
 */
export function resolveForgeKind(env: ForgeEnv = process.env): ForgeKind {
	const raw = env.WARREN_FORGE?.trim();
	if (raw === undefined || raw === "") {
		return DEFAULT_FORGE_KIND;
	}
	if ((FORGE_KINDS as readonly string[]).includes(raw)) {
		return raw as ForgeKind;
	}
	throw new UnknownForgeError(`Unknown WARREN_FORGE "${raw}"`, {
		recoveryHint: `Set WARREN_FORGE to one of: ${FORGE_KINDS.join(", ")} (or leave it unset for "${DEFAULT_FORGE_KIND}").`,
	});
}

/**
 * Resolve the forge for this process — call ONCE at boot. Selects on
 * `WARREN_FORGE` (see module doc) and constructs the chosen forge from
 * `deps`.
 */
export function resolveForge(deps: ForgeDeps = {}, env: ForgeEnv = process.env): Forge {
	const kind = resolveForgeKind(env);
	switch (kind) {
		case "github": {
			const tokenFactory = deps.githubToken ?? (() => env.GITHUB_TOKEN ?? "");
			return new GitHubForge({
				token: tokenFactory(),
				...(deps.githubFetch !== undefined ? { fetch: deps.githubFetch } : {}),
				...(deps.githubCheckRuns !== undefined ? { checkRuns: deps.githubCheckRuns } : {}),
			});
		}
		case "app": {
			const credentials = (deps.githubApp ?? (() => loadGitHubAppCredentialsFromEnv(env)))();
			return new GitHubAppForge({
				...credentials,
				...(deps.githubAppFetch !== undefined ? { fetch: deps.githubAppFetch } : {}),
			});
		}
		case "fake": {
			if (deps.fakeStore !== undefined) {
				return new FakeForge({ store: deps.fakeStore() });
			}
			// Cross-process acceptance seam (warren-2600): the harness boots
			// warren as a subprocess, so it drives FakeForge state transitions
			// (markMerged & friends) by editing a JSON state file the store
			// reloads on every read. Unset → the pure in-memory store.
			const stateFile = env[FAKE_FORGE_STATE_FILE_ENV]?.trim();
			if (stateFile === undefined || stateFile === "") {
				return new FakeForge();
			}
			return new FakeForge({ store: new FakeForgeStore({ stateFile }) });
		}
	}
}

/**
 * Build a forge instance from a validated `[[forges]]` config entry
 * (warren-f012, multi-forge-support.md §2a).
 *
 * Fails LOUDLY at boot (throws `ForgeConfigError`) when a required env var
 * named by `tokenEnv` is missing or empty — mirrors the `app` arm's existing
 * loud-fail contract and the UnknownForgeError posture (forge-contract.md §1.1).
 */
function buildForgeInstance(config: ForgeInstanceConfig, env: ForgeEnv): Forge {
	switch (config.kind) {
		case "github": {
			// tokenEnv is guaranteed present for "github" by ForgeInstanceConfigSchema.
			const varName = config.tokenEnv as string;
			const token = env[varName];
			if (token === undefined || token === "") {
				throw new ForgeConfigError(
					`forge "${config.id}": environment variable ${varName} (tokenEnv) is not set`,
					{
						recoveryHint: `Set ${varName} to a GitHub personal access token, or remove the forge entry from warren.toml.`,
					},
				);
			}
			return new GitHubForge({ token });
		}
		case "app": {
			// GitHub App credentials are multi-var (WARREN_GITHUB_APP_*);
			// loadGitHubAppCredentialsFromEnv already throws ForgeConfigError on
			// missing inputs — that loud-fail posture covers this arm.
			const credentials = loadGitHubAppCredentialsFromEnv(env);
			return new GitHubAppForge({ ...credentials });
		}
		case "fake": {
			const stateFile = env[FAKE_FORGE_STATE_FILE_ENV]?.trim();
			if (stateFile === undefined || stateFile === "") {
				return new FakeForge();
			}
			return new FakeForge({ store: new FakeForgeStore({ stateFile }) });
		}
	}
}

/**
 * Build the forge registry from an explicit `[[forges]]` config block
 * (warren-f012). Each entry produces one `Forge` keyed by its `id`.
 *
 * When `forgesConfig` is undefined or empty — i.e. the operator has not
 * written a `[[forges]]` block in `warren.toml` — the registry falls back to
 * the existing `WARREN_FORGE` + `GITHUB_TOKEN` env-var path and returns a
 * single-entry map keyed by the resolved kind name. This preserves exact
 * backward compatibility: a warren deploy with no `warren.toml` (or one
 * without a `[[forges]]` block) behaves identically to today.
 */
export function resolveForgeRegistry(
	forgesConfig: readonly ForgeInstanceConfig[] | undefined,
	env: ForgeEnv = process.env,
): Map<string, Forge> {
	if (forgesConfig === undefined || forgesConfig.length === 0) {
		const forge = resolveForge({}, env);
		const kind = resolveForgeKind(env);
		return new Map([[kind, forge]]);
	}
	const registry = new Map<string, Forge>();
	for (const entry of forgesConfig) {
		registry.set(entry.id, buildForgeInstance(entry, env));
	}
	return registry;
}

/**
 * Resolve the default `Forge` for this process, using the `[[forges]]` config
 * block when present and falling back to the env-var path otherwise
 * (warren-f012, backward compat with WARREN_FORGE).
 *
 * The server's `ServerDeps.forge` still carries a single `Forge` until
 * warren-834e (the multi-forge router) wires the full registry. This
 * function is the bridge: it builds the registry and extracts the first
 * (or only) entry so the rest of boot wiring is unchanged.
 */
export function resolveForgeFromConfig(
	forgesConfig: readonly ForgeInstanceConfig[] | undefined,
	env: ForgeEnv = process.env,
): Forge {
	const registry = resolveForgeRegistry(forgesConfig, env);
	const first = registry.values().next().value;
	if (first === undefined) {
		throw new ForgeConfigError("forge registry resolved to an empty map", {
			recoveryHint:
				"Add at least one [[forges]] entry to warren.toml, or remove the forges key entirely to use WARREN_FORGE.",
		});
	}
	return first;
}
