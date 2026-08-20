/**
 * Zod schema for warren's server-level TOML config
 * (pl-9ba1 step 7 / warren-3909).
 *
 * The `[[forges]]` block (warren-f012, multi-forge-support.md §2a) is the
 * first top-level key. It declares one forge instance per entry with the
 * shape `{ id, kind, baseUrl?, tokenEnv? }`:
 *   - `id`       — path-safe instance identifier that lands in `RepoRef.forge`
 *                  and persisted rows; constrained to kebab/snake-case so
 *                  it is URL-safe and log-safe without escaping.
 *   - `kind`     — selects the provider implementation (same vocabulary as
 *                  `WARREN_FORGE`; future kinds extend the enum here first).
 *   - `baseUrl`  — required for self-hosted forges (forgejo, gitlab); forbidden
 *                  for forges that operate against a fixed endpoint (github, app).
 *   - `tokenEnv` — names the env var that holds the PAT; required for PAT kinds
 *                  (github); not applicable to the multi-var `app` kind or to
 *                  `fake`. The var's VALUE is never stored — only the NAME
 *                  crosses the config boundary (registration.ts:28 precedent).
 *
 * No `[[forges]]` block → the loader returns an empty config `{}`, and the
 * registry falls back to `WARREN_FORGE` + `GITHUB_TOKEN` — exactly today's
 * behaviour. The block is opt-in; an existing deploy sees no change.
 *
 * `parseWarrenServerFileConfig` returns a discriminated result instead of
 * throwing. The loader (load.ts) decides which failures become
 * `ValidationError`; tests can exercise the parser in isolation.
 */

import { z } from "zod";

// Instance ID: must start with alphanumeric; interior allows dots, dashes,
// underscores. Same grammar as TriggerIdSchema in warren-config/schema.ts.
// Ids land in RepoRef.forge and on persisted rows, so path-safety matters.
const ForgeInstanceIdSchema = z
	.string()
	.min(1, "forge id must be non-empty")
	.regex(
		/^[a-z0-9][a-z0-9._-]*$/,
		"forge id must be kebab/snake-case (lowercase alphanumeric, dots, dashes, underscores)",
	);

// Env-var name schema reused from tracker-config.ts pattern.
const TokenEnvSchema = z
	.string()
	.min(1, "tokenEnv must be non-empty")
	.max(128, "tokenEnv must be at most 128 characters")
	.regex(/^[A-Z_][A-Z0-9_]*$/, "tokenEnv must be an environment variable name (UPPER_SNAKE_CASE)");

/**
 * Per-instance forge config entry. One `[[forges]]` block in `warren.toml`
 * maps to one entry here. Cross-field constraints are enforced in
 * `.superRefine()` so the error message names the offending field.
 */
export const ForgeInstanceConfigSchema = z
	.object({
		id: ForgeInstanceIdSchema,
		// Same kind vocabulary as FORGE_KINDS in src/forge/registry.ts.
		// Future kinds (forgejo, gitlab) extend this enum when their provider
		// lands; the schema is the first place a new kind appears.
		kind: z.enum(["github", "app", "fake"]),
		// Required for self-hosted kinds (not yet implemented); forbidden for
		// forges with a fixed endpoint (github, app, fake). Optional at the
		// field level; the cross-field refine below enforces the constraint.
		baseUrl: z.string().url("baseUrl must be an absolute URL").optional(),
		// Required for PAT kinds (github). Not applicable to app (reads its own
		// triple: WARREN_GITHUB_APP_*) or fake (no credential). Optional at the
		// field level; the refine below requires it for "github".
		tokenEnv: TokenEnvSchema.optional(),
	})
	.strict()
	.superRefine((entry, ctx) => {
		// baseUrl is forbidden for all current kinds, which all operate against
		// a fixed endpoint. Self-hosted kinds (forgejo, gitlab) will lift this
		// when they land and will require baseUrl instead.
		if (entry.baseUrl !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["baseUrl"],
				message: `baseUrl is not allowed for kind "${entry.kind}" (it has a fixed endpoint)`,
			});
		}
		// tokenEnv is required for PAT kinds so the registry can resolve the
		// credential at boot and fail loud if the var is missing.
		if (entry.kind === "github" && entry.tokenEnv === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["tokenEnv"],
				message: `tokenEnv is required for kind "github"`,
			});
		}
	});

export type ForgeInstanceConfig = z.infer<typeof ForgeInstanceConfigSchema>;

export const ForgesConfigSchema = z.array(ForgeInstanceConfigSchema).superRefine((list, ctx) => {
	const seen = new Set<string>();
	list.forEach((entry, index) => {
		if (seen.has(entry.id)) {
			ctx.addIssue({
				code: "custom",
				path: [index, "id"],
				message: `duplicate forge id "${entry.id}"`,
			});
		}
		seen.add(entry.id);
	});
});

export type ForgesConfig = z.infer<typeof ForgesConfigSchema>;

export const WarrenServerFileConfigSchema = z
	.object({
		forges: ForgesConfigSchema.optional(),
	})
	.strict();

export type WarrenServerFileConfig = z.infer<typeof WarrenServerFileConfigSchema>;

export type ParseResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly message: string };

export function parseWarrenServerFileConfig(raw: unknown): ParseResult<WarrenServerFileConfig> {
	// An empty/missing-body file (Bun.TOML.parse on "" returns {}) is the
	// same as no config — operators may keep the file present as a stub
	// or for the documentation comments alone.
	if (raw === undefined || raw === null) {
		return { ok: true, value: {} };
	}
	const parsed = WarrenServerFileConfigSchema.safeParse(raw);
	if (parsed.success) {
		return { ok: true, value: parsed.data };
	}
	return { ok: false, message: parsed.error.issues.map(formatZodIssue).join("; ") };
}

function formatZodIssue(issue: z.core.$ZodIssue): string {
	const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
	return `${path}: ${issue.message}`;
}
