/**
 * `Forge` seam — the provider-agnostic interface for git-hosting operations
 * (Forge plan, step 1). Every operation warren needs from a forge lives here
 * exactly once; provider implementations are swap-in-place behind this type.
 *
 * The module imports only `src/core/wire.ts` (no drizzle, no bun:sqlite),
 * so the UI can bundle it if needed.
 */

import type { ForgeKind } from "../core/wire.ts";

export type { ForgeKind };

/** A fully-qualified repo location, parsed from a project's `gitUrl`. */
export interface RepoRef {
	readonly host: string; // "github.com", "gitlab.corp.internal"
	readonly owner: string;
	readonly name: string;
}

export interface OpenPrInput {
	readonly token: string;
	readonly repo: RepoRef;
	readonly head: string;
	readonly base: string;
	readonly title: string;
	readonly body: string;
}

export type OpenPrResult =
	| { readonly ok: true; readonly url: string; readonly mode: "created" | "exists" }
	| {
			readonly ok: false;
			readonly reason: "missing_token" | "network" | "http_error";
			readonly message: string;
	  };

/**
 * PR/MR merge state (Forge plan, step 1). Mirrors `CheckPrMergedResult` from
 * `src/runs/pr-checks.ts` — the plan-run coordinator's `closed_unmerged` path
 * is load-bearing (fails the plan; collapsing to boolean loses it).
 * `rate_limited` carries `retryAfterMs` so the existing retry wrapper can
 * honour the forge's back-off hint.
 */
export type PrMergeState =
	| { readonly kind: "merged"; readonly mergedAt: string }
	| { readonly kind: "open" }
	| { readonly kind: "closed_unmerged" }
	| { readonly kind: "missing_token"; readonly message: string }
	| {
			readonly kind: "rate_limited";
			readonly retryAfterMs: number | null;
			readonly message: string;
	  }
	| { readonly kind: "http_error"; readonly status: number; readonly message: string };

/**
 * CI / check-run summary (Forge plan, step 1). `unsupported` is returned
 * (rather than `undefined`) so callers never need to null-guard or test a
 * capability flag — the method is always present on the interface.
 */
export type ChecksResult =
	| { readonly kind: "unsupported" }
	| { readonly kind: "none" }
	| {
			readonly kind: "summary";
			readonly allPassed: boolean;
			readonly failed: readonly string[];
			readonly pending: readonly string[];
	  };

/** Parsed location of a PR/MR URL emitted by this forge. */
export interface ParsedPrUrl {
	readonly repo: RepoRef;
	readonly number: number;
}

/**
 * The forge interface. One implementation per ForgeKind; resolved at runtime
 * via `forgeFor(project)` in `src/forge/registry.ts`. All network calls are
 * injected via the `fetch` seam where relevant — no hardcoded `globalThis.fetch`.
 */
export interface Forge {
	readonly kind: ForgeKind;

	/**
	 * Git credential as an ENV MAP, never a URL. The env-pair form exists so
	 * the token never appears in argv or in the clone's stored remote config.
	 * Returns `{}` when `token` is absent or empty (anonymous git / public repos).
	 */
	buildGitCredentialEnv(token: string | undefined): Record<string, string>;

	openPullRequest(input: OpenPrInput): Promise<OpenPrResult>;

	/** Locate an existing open PR for `head→base`; returns its URL or null. */
	findExistingPr(input: Omit<OpenPrInput, "title" | "body">): Promise<string | null>;

	checkPrMerged(prUrl: string, token: string): Promise<PrMergeState>;

	/** Parse a PR/MR URL this forge authored. Null when it isn't one. */
	parsePrUrl(raw: string): ParsedPrUrl | null;

	/** Returns `unsupported` rather than being optional. */
	fetchChecks(repo: RepoRef, sha: string, token: string): Promise<ChecksResult>;
}
