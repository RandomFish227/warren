/**
 * Lean reader for `sd list --format json` that returns the status of every
 * issue in a project — not just the scheduled ones (warren-6807 / pl-3fc4
 * step 2).
 *
 * Where `listScheduledSeeds` (extensions.ts) shells the same command but
 * filters down to seeds carrying a `scheduledFor` extension, this reader
 * keeps the full set so callers can answer "is this seed open or closed?"
 * for arbitrary ids. The ready-to-dispatch surface (GET
 * /projects/:id/ready-plans) uses it to decide whether a plan still has
 * open children.
 *
 * Shares the same `SeedsCliDeps` + `SpawnFn` injection and
 * `SeedsCliError` wrapping as the rest of the facade (mx-371491) so tests
 * reuse the same stubs.
 */

import { formatError } from "../core/errors.ts";
import { SeedsCliError } from "./errors.ts";
import type { SeedsCliDeps } from "./extensions.ts";
import { type SeedRow, SeedsListEnvelopeSchema } from "./schema.ts";
import { DEFAULT_SD_TIMEOUT_MS, truncate } from "./util.ts";

/**
 * Resolve a `seedId → status` map for every issue in a project via
 * `sd list --format json`. Shell + parse failures wrap in `SeedsCliError`
 * with a copy-paste recoveryHint, matching `listScheduledSeeds`.
 */
export async function listSeedStatuses(
	deps: SeedsCliDeps,
	projectPath: string,
): Promise<ReadonlyMap<string, string>> {
	const statuses = new Map<string, string>();
	for (const row of await readSeedRows(deps, projectPath)) {
		statuses.set(row.id, row.status);
	}
	return statuses;
}

/**
 * Seeds that are not closed, in the order `sd list` reports them.
 *
 * Where `listSeedStatuses` collapses the response to `id → status`, this
 * keeps the row so callers get the title too — the NewRun form's seed
 * picker labels its options with it, and an id alone (`warren-a63d`) is not
 * something an operator can choose between.
 *
 * "Not closed" rather than `status === "open"` on purpose: seeds also carry
 * `in_progress`, and a seed someone is already working is still a valid
 * dispatch target. Only `closed` is excluded.
 */
export async function listOpenSeeds(
	deps: SeedsCliDeps,
	projectPath: string,
): Promise<readonly SeedRow[]> {
	const rows = await readSeedRows(deps, projectPath);
	return rows.filter((row) => row.status !== "closed");
}

/**
 * Shell `sd list --format json` once and parse the envelope. Shared by both
 * readers above so the command, the timeout, and the two error shapes have
 * exactly one definition.
 */
async function readSeedRows(deps: SeedsCliDeps, projectPath: string): Promise<readonly SeedRow[]> {
	const result = await deps.spawn([deps.sdBinary, "list", "--format", "json"], {
		cwd: projectPath,
		timeoutMs: deps.timeoutMs ?? DEFAULT_SD_TIMEOUT_MS,
	});
	if (result.exitCode !== 0) {
		throw new SeedsCliError(
			`sd list exited ${result.exitCode}: ${truncate(result.stderr || result.stdout)}`,
			{
				recoveryHint: `run \`${deps.sdBinary} doctor\` in ${projectPath} to diagnose`,
			},
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch (err) {
		throw new SeedsCliError(`sd list returned non-JSON output: ${formatError(err)}`, {
			cause: err,
		});
	}

	const envelope = SeedsListEnvelopeSchema.safeParse(parsed);
	if (!envelope.success) {
		throw new SeedsCliError(
			`sd list response did not match expected envelope: ${envelope.error.issues
				.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
				.join("; ")}`,
		);
	}

	return envelope.data.issues;
}
