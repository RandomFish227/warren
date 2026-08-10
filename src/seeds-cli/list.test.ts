import { describe, expect, test } from "bun:test";
import type { SpawnFn, SpawnResult } from "../projects/clone.ts";
import { SeedsCliError } from "./errors.ts";
import { listOpenSeeds, listSeedStatuses } from "./list.ts";

function ok(stdout: string): SpawnResult {
	return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr: string, exitCode = 1): SpawnResult {
	return { stdout: "", stderr, exitCode };
}

describe("listSeedStatuses", () => {
	test("shells out with the configured sd binary and project cwd", async () => {
		const calls: { cmd: readonly string[]; cwd: string }[] = [];
		const spawn: SpawnFn = async (cmd, opts) => {
			calls.push({ cmd, cwd: opts.cwd });
			return ok(JSON.stringify({ success: true, issues: [] }));
		};
		await listSeedStatuses({ spawn, sdBinary: "/opt/sd" }, "/data/projects/x/y");
		expect(calls).toEqual([
			{
				cmd: ["/opt/sd", "list", "--format", "json"],
				cwd: "/data/projects/x/y",
			},
		]);
	});

	test("builds a seedId → status map for mixed open/closed statuses", async () => {
		const envelope = JSON.stringify({
			success: true,
			issues: [
				{ id: "warren-aaa", status: "open", title: "first" },
				{ id: "warren-bbb", status: "closed", title: "second" },
				{ id: "warren-ccc", status: "in-progress" },
			],
		});
		const spawn: SpawnFn = async () => ok(envelope);
		const statuses = await listSeedStatuses({ spawn, sdBinary: "sd" }, "/p");
		expect(statuses.size).toBe(3);
		expect(statuses.get("warren-aaa")).toBe("open");
		expect(statuses.get("warren-bbb")).toBe("closed");
		expect(statuses.get("warren-ccc")).toBe("in-progress");
	});

	test("returns an empty map for an empty issue list", async () => {
		const spawn: SpawnFn = async () => ok(JSON.stringify({ success: true, issues: [] }));
		const statuses = await listSeedStatuses({ spawn, sdBinary: "sd" }, "/p");
		expect(statuses.size).toBe(0);
	});

	test("wraps a non-zero exit in SeedsCliError with a recoveryHint", async () => {
		const spawn: SpawnFn = async () => fail("sd: not a seeds project", 1);
		const promise = listSeedStatuses({ spawn, sdBinary: "sd" }, "/p");
		await expect(promise).rejects.toBeInstanceOf(SeedsCliError);
		await expect(promise).rejects.toMatchObject({
			recoveryHint: "run `sd doctor` in /p to diagnose",
		});
	});

	test("wraps non-JSON stdout in SeedsCliError", async () => {
		const spawn: SpawnFn = async () => ok("not json at all");
		await expect(listSeedStatuses({ spawn, sdBinary: "sd" }, "/p")).rejects.toBeInstanceOf(
			SeedsCliError,
		);
	});

	test("wraps a malformed envelope in SeedsCliError", async () => {
		const spawn: SpawnFn = async () => ok(JSON.stringify({ issues: [{ id: "warren-x" }] }));
		await expect(listSeedStatuses({ spawn, sdBinary: "sd" }, "/p")).rejects.toBeInstanceOf(
			SeedsCliError,
		);
	});
});

describe("listOpenSeeds", () => {
	const envelope = JSON.stringify({
		success: true,
		issues: [
			{ id: "warren-open", status: "open", title: "An open one" },
			{ id: "warren-wip", status: "in_progress", title: "Being worked" },
			{ id: "warren-done", status: "closed", title: "Finished" },
			{ id: "warren-bare", status: "open" },
		],
	});

	test("keeps every seed that is not closed, in report order", async () => {
		const spawn: SpawnFn = async () => ok(envelope);
		const rows = await listOpenSeeds({ spawn, sdBinary: "sd" }, "/p");
		expect(rows.map((r) => r.id)).toEqual(["warren-open", "warren-wip", "warren-bare"]);
	});

	test("keeps in_progress — a seed someone started is still dispatchable", async () => {
		const spawn: SpawnFn = async () => ok(envelope);
		const rows = await listOpenSeeds({ spawn, sdBinary: "sd" }, "/p");
		expect(rows.some((r) => r.status === "in_progress")).toBe(true);
		expect(rows.some((r) => r.status === "closed")).toBe(false);
	});

	test("surfaces the title so the picker can label its options", async () => {
		const spawn: SpawnFn = async () => ok(envelope);
		const rows = await listOpenSeeds({ spawn, sdBinary: "sd" }, "/p");
		expect(rows[0]?.title).toBe("An open one");
		expect(rows[2]?.title).toBeUndefined();
	});

	test("wraps a non-zero sd exit in SeedsCliError, like listSeedStatuses", async () => {
		const spawn: SpawnFn = async () => fail("sd: not a seeds project");
		await expect(listOpenSeeds({ spawn, sdBinary: "sd" }, "/p")).rejects.toBeInstanceOf(
			SeedsCliError,
		);
	});

	test("wraps non-JSON output in SeedsCliError", async () => {
		const spawn: SpawnFn = async () => ok("not json");
		await expect(listOpenSeeds({ spawn, sdBinary: "sd" }, "/p")).rejects.toBeInstanceOf(
			SeedsCliError,
		);
	});
});
