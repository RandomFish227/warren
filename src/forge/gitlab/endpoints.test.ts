import { describe, expect, test } from "bun:test";
import {
	GITLAB_API_PATH,
	gitLabApiBase,
	gitLabProjectSubUrl,
	gitLabProjectUrl,
} from "./endpoints.ts";

describe("gitLabApiBase", () => {
	test("hangs the version path off the instance origin", () => {
		expect(gitLabApiBase("https://gitlab.com")).toBe("https://gitlab.com/api/v4");
		expect(gitLabApiBase("https://gitlab.example.com:8443")).toBe(
			"https://gitlab.example.com:8443/api/v4",
		);
	});

	test("preserves a plain-http origin rather than assuming https", () => {
		expect(gitLabApiBase("http://gitlab.internal")).toBe("http://gitlab.internal/api/v4");
	});

	test("tolerates a trailing slash without doubling it", () => {
		expect(gitLabApiBase("https://gitlab.com/")).toBe("https://gitlab.com/api/v4");
		expect(gitLabApiBase("https://gitlab.com///")).toBe("https://gitlab.com/api/v4");
	});

	test("the version lives in the path, not a header", () => {
		expect(GITLAB_API_PATH).toBe("/api/v4");
	});
});

describe("gitLabProjectUrl", () => {
	const base = "https://gitlab.com/api/v4";

	test("encodes a simple owner/repo path", () => {
		expect(gitLabProjectUrl(base, "group/project")).toBe(
			"https://gitlab.com/api/v4/projects/group%2Fproject",
		);
	});

	test("encodes EVERY slash of a nested-group path, not just the first", () => {
		const url = gitLabProjectUrl(base, "group/sub/deeper/project");
		expect(url).toBe("https://gitlab.com/api/v4/projects/group%2Fsub%2Fdeeper%2Fproject");
		// The bug this guards: a per-segment encode rejoined with "/" yields a
		// different GitLab route that answers 404, which reads like a missing
		// project rather than a malformed URL.
		expect(url).not.toContain("deeper/project");
	});

	test("encodes characters a path segment may legally carry", () => {
		expect(gitLabProjectUrl(base, "group/my.project")).toContain("group%2Fmy.project");
	});
});

describe("gitLabProjectSubUrl", () => {
	const base = "https://gitlab.com/api/v4";

	test("appends a sub-resource under the encoded project", () => {
		expect(gitLabProjectSubUrl(base, "group/sub/project", "merge_requests")).toBe(
			"https://gitlab.com/api/v4/projects/group%2Fsub%2Fproject/merge_requests",
		);
	});

	test("appends the suffix verbatim so the caller owns any query string", () => {
		expect(
			gitLabProjectSubUrl(base, "g/p", "merge_requests?source_branch=feat%2Fx&state=opened"),
		).toBe(
			"https://gitlab.com/api/v4/projects/g%2Fp/merge_requests?source_branch=feat%2Fx&state=opened",
		);
	});
});
