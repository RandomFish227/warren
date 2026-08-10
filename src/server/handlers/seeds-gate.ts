/**
 * The shared admission gate for every seeds-read route (warren-b41d).
 *
 * Four handlers — seed status, plan list, ready plans, open seeds — all open
 * the same way: resolve the project (404 if unknown), refuse when the clone
 * ships no `.seeds/` directory, and refuse when this warren has no `sd`
 * configured. Each one used to spell the sequence out, so the messages drifted
 * apart in wording while staying identical in meaning, and `check:dups`
 * flagged the fourth copy the moment it was written.
 *
 * The one variable is the noun in the message — "plan list", "seed status
 * read" — which callers pass so the error still names what the caller was
 * trying to do.
 */

import { ValidationError } from "../../core/errors.ts";
import type { ProjectRow } from "../../db/schema.ts";
import { ProjectLacksSeedsError } from "../../plan-runs/errors.ts";
import type { SeedsCliDeps } from "../../seeds-cli/index.ts";
import type { ServerDeps } from "../types.ts";

export interface SeedsContext {
	readonly project: ProjectRow;
	/** Non-optional here: the gate has already refused an unconfigured warren. */
	readonly seedsCli: SeedsCliDeps;
}

/**
 * Resolve a project and prove it can serve a seeds read.
 *
 * @param capability - what the caller is doing, as a noun phrase for the
 *   error message (e.g. `"plan list"`). Reads as "… ; plan list is not
 *   available" and "… requires sd".
 */
export async function requireSeedsContext(
	deps: ServerDeps,
	id: string,
	capability: string,
): Promise<SeedsContext> {
	const project = await deps.repos.projects.require(id);
	if (!project.hasSeeds) {
		throw new ProjectLacksSeedsError(
			`project ${project.id} has no .seeds/ directory; ${capability} is not available`,
			{ recoveryHint: "add a .seeds/ directory to the project clone and refresh" },
		);
	}
	if (deps.seedsCli === undefined) {
		throw new ValidationError(
			`seeds CLI is not configured on this warren; ${capability} requires sd`,
			{ recoveryHint: "set WARREN_SD_BINARY (or install sd on PATH) and restart" },
		);
	}
	return { project, seedsCli: deps.seedsCli };
}
