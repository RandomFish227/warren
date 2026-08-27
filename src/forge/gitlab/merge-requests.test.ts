import { describe, expect, test } from "bun:test";
import { toForgeError, toPullRequestRef, toPullRequestState } from "./merge-requests.ts";

describe("toPullRequestRef", () => {
	test("uses iid — the per-project number — and never the global id", () => {
		const ref = toPullRequestRef("group/project", {
			id: 91_882,
			iid: 7,
			web_url: "https://gitlab.com/group/project/-/merge_requests/7",
		} as never);
		expect(ref?.number).toBe(7);
		expect(ref?.key).toBe("group/project!7");
		expect(JSON.stringify(ref)).not.toContain("91882");
	});

	test("packs a nested-group path into the key", () => {
		const ref = toPullRequestRef("group/sub/deeper/project", {
			iid: 12,
			web_url: "https://gitlab.example.com/group/sub/deeper/project/-/merge_requests/12",
		});
		expect(ref?.key).toBe("group/sub/deeper/project!12");
		expect(ref?.forge).toBe("gitlab");
	});

	test("returns null when iid or web_url is missing or the wrong type", () => {
		expect(toPullRequestRef("g/p", { web_url: "https://x" })).toBeNull();
		expect(toPullRequestRef("g/p", { iid: 7 })).toBeNull();
		expect(toPullRequestRef("g/p", { iid: "7", web_url: "https://x" })).toBeNull();
		expect(toPullRequestRef("g/p", { iid: 7.5, web_url: "https://x" })).toBeNull();
		expect(toPullRequestRef("g/p", { iid: 7, web_url: "" })).toBeNull();
	});
});

describe("toPullRequestState", () => {
	test("merged carries the epoch-ms stamp the merge gate blocks on", () => {
		const state = toPullRequestState({
			state: "merged",
			merged_at: "2026-08-27T10:30:00.000Z",
			sha: "abc123",
			target_branch: "main",
		});
		expect(state.lifecycle).toBe("merged");
		expect(state.mergedAt).toBe(Date.parse("2026-08-27T10:30:00.000Z"));
		expect(state.headCommit).toBe("abc123");
		expect(state.baseBranch).toBe("main");
	});

	test("opened is open", () => {
		expect(toPullRequestState({ state: "opened" }).lifecycle).toBe("open");
	});

	test("locked reads as open — it is transient during a merge, not a failure", () => {
		const state = toPullRequestState({ state: "locked" });
		expect(state.lifecycle).toBe("open");
		expect(state.mergedAt).toBeNull();
	});

	test("closed is closed_unmerged — GitLab keeps merged as its own state", () => {
		// The distinction that makes this safe: on GitHub a merged PR reports
		// state "closed" plus a merged_at, so closed alone cannot mean unmerged.
		// On GitLab a closed MR is genuinely unmerged.
		const state = toPullRequestState({ state: "closed" });
		expect(state.lifecycle).toBe("closed_unmerged");
		expect(state.mergedAt).toBeNull();
	});

	test("a merged_at stamp wins even when state disagrees", () => {
		expect(
			toPullRequestState({ state: "opened", merged_at: "2026-08-27T10:30:00.000Z" }).lifecycle,
		).toBe("merged");
	});

	test("an unparseable merged_at degrades to null rather than NaN", () => {
		const state = toPullRequestState({ state: "merged", merged_at: "not-a-date" });
		expect(state.mergedAt).toBeNull();
		expect(state.lifecycle).toBe("merged");
	});

	test("missing fields degrade to empty strings, never undefined", () => {
		const state = toPullRequestState({});
		expect(state).toEqual({
			lifecycle: "open",
			mergedAt: null,
			headCommit: "",
			baseBranch: "",
		});
	});
});

describe("toForgeError", () => {
	test("renames the transport kind and carries the status as detail", () => {
		expect(
			toForgeError({ kind: "not_found", status: 404, retryAfterMs: null, message: "gone" }),
		).toEqual({ kind: "not_found", status: 404, detail: "gone" });
	});

	test("forwards a Retry-After hint only for rate_limited", () => {
		expect(
			toForgeError({ kind: "rate_limited", status: 429, retryAfterMs: 9_000, message: "slow" }),
		).toEqual({ kind: "rate_limited", status: 429, detail: "slow", retryAfterMs: 9_000 });
		expect(
			toForgeError({ kind: "forbidden", status: 403, retryAfterMs: 9_000, message: "no" }),
		).not.toHaveProperty("retryAfterMs");
	});
});
