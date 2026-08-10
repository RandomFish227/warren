/**
 * `GET /projects/:id/seeds` — the project's open seeds (warren-b41d).
 *
 * Feeds the NewRun form's seed picker: when a project's prompt template
 * carries a `{seed_id}` placeholder, the form offers the real queue rather
 * than asking the operator to remember an id. Returns `{id, title, status}`
 * per seed because an id alone (`warren-a63d`) is not something a person can
 * choose between.
 *
 * Lives in its own module rather than beside the other project handlers
 * because `projects.ts` sits close to the per-file line budget
 * (`check:size`), and a read-only listing has no coupling to the rest of it.
 *
 * Gates mirror `listProjectSeedPlansHandler` so the seeds-read contract
 * stays uniform: project 404 via `projects.require`, `hasSeeds` gate
 * (ProjectLacksSeedsError → 400), `seedsCli` configured (ValidationError →
 * 400), and a `SeedsCliError` from the reader bubbles up as 500.
 */

import { listOpenSeeds } from "../../seeds-cli/index.ts";
import { jsonResponse } from "../response.ts";
import type { RouteHandler, ServerDeps } from "../types.ts";
import { requireParam } from "./index.ts";
import { requireSeedsContext } from "./seeds-gate.ts";

export function listProjectOpenSeedsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		const { project, seedsCli } = await requireSeedsContext(deps, id, "seed list");
		const rows = await listOpenSeeds(seedsCli, project.localPath);
		return jsonResponse(200, {
			seeds: rows.map((row) => ({
				id: row.id,
				status: row.status,
				...(row.title !== undefined ? { title: row.title } : {}),
			})),
		});
	};
}
