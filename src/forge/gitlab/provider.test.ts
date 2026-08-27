import { describe, expect, test } from "bun:test";
import { ForgeConfigError } from "../errors.ts";
import { jsonResponse, recordingFetch } from "../http/test-helpers.ts";
import { GitLabForge } from "./provider.ts";

const INSTANCE = "https://gitlab.example.com";
const CLONE = "https://gitlab.example.com/group/sub/project.git";

function forge(responses: ReadonlyArray<Response | (() => Response)>, token = "glpat-x") {
	const { fetch, calls } = recordingFetch(responses);
	return { forge: new GitLabForge({ instanceUrl: INSTANCE, token, fetch }), calls };
}

function ref(f: GitLabForge) {
	const parsed = f.parseRepoRef(CLONE);
	if (parsed === null) throw new Error("fixture clone URL must parse");
	return parsed;
}

const MR_JSON = {
	iid: 7,
	web_url: "https://gitlab.example.com/group/sub/project/-/merge_requests/7",
	state: "opened",
	sha: "deadbeef",
	target_branch: "main",
	source_branch: "warren/run_1",
};

describe("GitLabForge construction", () => {
	test("refuses an unusable instance URL at boot rather than owning nothing", () => {
		expect(() => new GitLabForge({ instanceUrl: "" })).toThrow(ForgeConfigError);
		expect(() => new GitLabForge({ instanceUrl: "ssh://gitlab.com" })).toThrow(ForgeConfigError);
	});

	test("the config error names the variable and how to fix it", () => {
		try {
			new GitLabForge({ instanceUrl: "   " });
			throw new Error("expected a throw");
		} catch (e) {
			expect(e).toBeInstanceOf(ForgeConfigError);
			expect((e as ForgeConfigError).message).toContain("WARREN_GITLAB_URL");
			expect((e as { recoveryHint?: string }).recoveryHint).toContain("https://gitlab.com");
		}
	});

	test("accepts a bare authority and a self-hosted port", () => {
		expect(() => new GitLabForge({ instanceUrl: "gitlab.example.com" })).not.toThrow();
		expect(() => new GitLabForge({ instanceUrl: "https://gitlab.example.com:8443" })).not.toThrow();
	});
});

describe("GitLabForge capabilities", () => {
	test("checkRuns and jobLogs are false because warren has not built them yet", () => {
		const { forge: f } = forge([]);
		expect(f.capabilities.checkRuns).toBe(false);
		expect(f.capabilities.jobLogs).toBe(false);
	});

	test("body edit, branch delete, and a static credential lifetime", () => {
		const { forge: f } = forge([]);
		expect(f.capabilities.pullRequestBodyEdit).toBe(true);
		expect(f.capabilities.branchDelete).toBe(true);
		expect(f.capabilities.botIdentity).toBe(false);
		expect(f.capabilities.credentialLifetime).toBe("static");
	});

	test("autoMerge is false — plan-runs are refused at dispatch; single-run PR ops are unaffected (warren-3e09)", async () => {
		// The forge has no GitHub-style auto-merge workflow. The plan-run
		// coordinator would poll forever, so createPlanRun refuses the dispatch.
		// Single-run operations (parseRepoRef, openPullRequest) are not gated.
		const { forge: f } = forge([jsonResponse(201, MR_JSON)]);
		expect(f.capabilities.autoMerge).toBe(false);
		// openPullRequest is the single-run PR seam — it must keep working.
		const r = ref(f);
		const result = await f.openPullRequest(r, {
			title: "warren: run_1",
			body: "",
			headBranch: "warren/run_1",
			baseBranch: "main",
		});
		expect(result.ok).toBe(true);
	});
});

describe("GitLabForge.parseRepoRef", () => {
	test("claims a URL on its own instance, including a nested group path", () => {
		const { forge: f } = forge([]);
		expect(f.parseRepoRef(CLONE)).toEqual({
			forge: "gitlab",
			key: "gitlab.example.com/group/sub/project",
		});
	});

	test("disowns another host so the registry chain tries the next forge", () => {
		const { forge: f } = forge([]);
		expect(f.parseRepoRef("https://github.com/o/r.git")).toBeNull();
		expect(f.parseRepoRef("https://gitlab.com/group/project.git")).toBeNull();
	});
});

describe("GitLabForge.gitCredential", () => {
	test("mints with GitLab's oauth2 username and no expiry under a PAT", async () => {
		const { forge: f } = forge([]);
		const result = await f.gitCredential(ref(f));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({ username: "oauth2", secret: "glpat-x", expiresAt: null });
		}
	});

	test("an empty token reports no_credential naming the repo", async () => {
		const { forge: f } = forge([], "");
		const result = await f.gitCredential(ref(f));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("no_credential");
			expect(result.error.detail).toContain("gitlab.example.com/group/sub/project");
		}
	});
});

describe("GitLabForge.openPullRequest", () => {
	test("POSTs source/target/title/description to the encoded project path", async () => {
		const { forge: f, calls } = forge([jsonResponse(201, MR_JSON)]);
		const result = await f.openPullRequest(ref(f), {
			title: "Fix the thing",
			body: "why",
			headBranch: "warren/run_1",
			baseBranch: "main",
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.number).toBe(7);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url).toBe(
			"https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fproject/merge_requests",
		);
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({
			source_branch: "warren/run_1",
			target_branch: "main",
			title: "Fix the thing",
			description: "why",
		});
	});

	test("a draft becomes GitLab's title prefix, not an API flag", async () => {
		const { forge: f, calls } = forge([jsonResponse(201, MR_JSON)]);
		await f.openPullRequest(ref(f), {
			title: "WIP work",
			body: "",
			headBranch: "b",
			baseBranch: "main",
			draft: true,
		});
		const body = JSON.parse(calls[0]?.body ?? "{}");
		expect(body.title).toBe("Draft: WIP work");
		expect(body.draft).toBeUndefined();
	});

	test("draft:false sends the bare title", async () => {
		const { forge: f, calls } = forge([jsonResponse(201, MR_JSON)]);
		await f.openPullRequest(ref(f), {
			title: "Ready",
			body: "",
			headBranch: "b",
			baseBranch: "main",
			draft: false,
		});
		expect(JSON.parse(calls[0]?.body ?? "{}").title).toBe("Ready");
	});

	test("a 409 duplicate resolves to the existing MR — idempotent by contract", async () => {
		const conflict = jsonResponse(409, {
			message: ["Another open merge request already exists for this source branch: !7"],
		});
		const { forge: f, calls } = forge([conflict, jsonResponse(200, [MR_JSON])]);
		const result = await f.openPullRequest(ref(f), {
			title: "t",
			body: "b",
			headBranch: "warren/run_1",
			baseBranch: "main",
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.number).toBe(7);
		// Resolution is a search, NOT a parse of the human-facing 409 prose.
		expect(calls[1]?.method).toBe("GET");
		expect(calls[1]?.url).toContain("merge_requests?");
	});

	test("a 409 with no findable MR still surfaces the conflict", async () => {
		const { forge: f } = forge([jsonResponse(409, { message: "nope" }), jsonResponse(200, [])]);
		const result = await f.openPullRequest(ref(f), {
			title: "t",
			body: "b",
			headBranch: "b",
			baseBranch: "main",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("conflict");
	});

	test("a non-409 failure never triggers the duplicate search", async () => {
		const { forge: f, calls } = forge([jsonResponse(403, { message: "forbidden" })]);
		const result = await f.openPullRequest(ref(f), {
			title: "t",
			body: "b",
			headBranch: "b",
			baseBranch: "main",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("forbidden");
		expect(calls).toHaveLength(1);
	});

	test("an unreadable creation body is an http_error, not a silent success", async () => {
		const { forge: f } = forge([new Response("<html>", { status: 201 })]);
		const result = await f.openPullRequest(ref(f), {
			title: "t",
			body: "b",
			headBranch: "b",
			baseBranch: "main",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("http_error");
	});
});

describe("GitLabForge.findPullRequest", () => {
	test("filters by source and target branch, narrowing to opened server-side", async () => {
		const { forge: f, calls } = forge([jsonResponse(200, [MR_JSON])]);
		const result = await f.findPullRequest(ref(f), {
			headBranch: "warren/run_1",
			baseBranch: "main",
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value?.number).toBe(7);
		const url = calls[0]?.url ?? "";
		expect(url).toContain("source_branch=warren%2Frun_1");
		expect(url).toContain("target_branch=main");
		expect(url).toContain("state=opened");
	});

	test("returns ok(null) when nothing matches — a missing MR is not an error", async () => {
		const { forge: f } = forge([jsonResponse(200, [])]);
		const result = await f.findPullRequest(ref(f), { headBranch: "b", baseBranch: "main" });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toBeNull();
	});

	test("the seam's closed queries all and filters locally, so merged is included", async () => {
		// GitLab's own `closed` excludes merged; the seam follows GitHub, where
		// closed means not-open. Querying GitLab's closed would silently miss
		// every merged MR.
		const merged = { ...MR_JSON, state: "merged" };
		const { forge: f, calls } = forge([jsonResponse(200, [merged])]);
		const result = await f.findPullRequest(ref(f), {
			headBranch: "warren/run_1",
			baseBranch: "main",
			state: "closed",
		});
		expect(calls[0]?.url).toContain("state=all");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value?.number).toBe(7);
	});

	test("an open query skips a merged MR the server returned anyway", async () => {
		const { forge: f } = forge([jsonResponse(200, [{ ...MR_JSON, state: "merged" }])]);
		const result = await f.findPullRequest(ref(f), {
			headBranch: "warren/run_1",
			baseBranch: "main",
			state: "open",
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toBeNull();
	});

	test("a non-array body is an http_error rather than a silent null", async () => {
		const { forge: f } = forge([jsonResponse(200, { message: "unexpected" })]);
		const result = await f.findPullRequest(ref(f), { headBranch: "b", baseBranch: "main" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("http_error");
	});
});

describe("GitLabForge.getPullRequest", () => {
	test("GETs by iid and maps the lifecycle", async () => {
		const merged = { ...MR_JSON, state: "merged", merged_at: "2026-08-27T10:30:00.000Z" };
		const { forge: f, calls } = forge([jsonResponse(200, merged)]);
		const prRef = { forge: "gitlab", key: "group/sub/project!7", number: 7, webUrl: "x" };
		const result = await f.getPullRequest(ref(f), prRef);
		expect(calls[0]?.url).toBe(
			"https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fproject/merge_requests/7",
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.lifecycle).toBe("merged");
			expect(result.value.mergedAt).toBe(Date.parse("2026-08-27T10:30:00.000Z"));
			expect(result.value.headCommit).toBe("deadbeef");
		}
	});

	test("a 404 surfaces as not_found", async () => {
		const { forge: f } = forge([jsonResponse(404, { message: "404 Not found" })]);
		const prRef = { forge: "gitlab", key: "group/sub/project!9", number: 9, webUrl: "x" };
		const result = await f.getPullRequest(ref(f), prRef);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("not_found");
	});
});

describe("GitLabForge.setPullRequestBody", () => {
	test("PUTs the description — the domain composed it, this only transports", async () => {
		const { forge: f, calls } = forge([jsonResponse(200, MR_JSON)]);
		const prRef = { forge: "gitlab", key: "group/sub/project!7", number: 7, webUrl: "x" };
		const result = await f.setPullRequestBody(ref(f), prRef, "new body");
		expect(result.ok).toBe(true);
		expect(calls[0]?.method).toBe("PUT");
		expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ description: "new body" });
	});
});

describe("GitLabForge.deleteBranch", () => {
	test("DELETEs the branch with the ref encoded", async () => {
		const { forge: f, calls } = forge([new Response(null, { status: 204 })]);
		const result = await f.deleteBranch(ref(f), "warren/run_1");
		expect(result.ok).toBe(true);
		expect(calls[0]?.method).toBe("DELETE");
		expect(calls[0]?.url).toBe(
			"https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fproject/repository/branches/warren%2Frun_1",
		);
	});
});

describe("GitLabForge degradations", () => {
	test("listChecks reports unsupported and names it as a warren gap", async () => {
		const { forge: f, calls } = forge([]);
		const result = await f.listChecks(ref(f), "abc");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("unsupported");
			expect(result.error.detail).toContain("warren has not implemented");
		}
		expect(calls).toHaveLength(0);
	});

	test("fetchJobLogTail is best-effort: ok with null, never an error", async () => {
		const { forge: f, calls } = forge([]);
		const result = await f.fetchJobLogTail(ref(f), "job-1", 1024);
		expect(result).toEqual({ ok: true, value: null });
		expect(calls).toHaveLength(0);
	});

	test("botIdentity is unsupported so the domain falls back to env", async () => {
		const { forge: f } = forge([]);
		const result = await f.botIdentity();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("unsupported");
	});
});

describe("GitLabForge foreign refs", () => {
	test("a ref from another forge fails as not_found without a request", async () => {
		const { forge: f, calls } = forge([]);
		const foreign = { forge: "github", key: "github.com/o/r" };
		const result = await f.openPullRequest(foreign, {
			title: "t",
			body: "b",
			headBranch: "b",
			baseBranch: "main",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("not_found");
		expect(calls).toHaveLength(0);
	});

	test("a ref for a different GitLab instance is also not_found", async () => {
		const { forge: f } = forge([]);
		const otherInstance = { forge: "gitlab", key: "gitlab.com/group/project" };
		const result = await f.getPullRequest(otherInstance, {
			forge: "gitlab",
			key: "gitlab.com/group/project!1",
			number: 1,
			webUrl: "x",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.detail).toContain("does not belong");
	});
});
