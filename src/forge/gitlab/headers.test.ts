import { describe, expect, test } from "bun:test";
import { buildGitLabHeaders, DEFAULT_GITLAB_USER_AGENT } from "./headers.ts";

describe("buildGitLabHeaders", () => {
	test("authenticates with PRIVATE-TOKEN, not an Authorization bearer", () => {
		const headers = buildGitLabHeaders("glpat-secret");
		expect(headers["private-token"]).toBe("glpat-secret");
		expect(headers.authorization).toBeUndefined();
	});

	test("sends no GitHub vocabulary — no vendor accept type, no version header", () => {
		const headers = buildGitLabHeaders("t");
		expect(headers.accept).toBe("application/json");
		expect(headers["x-github-api-version"]).toBeUndefined();
		expect(JSON.stringify(headers)).not.toContain("github");
	});

	test("always sets content-type so write methods work", () => {
		expect(buildGitLabHeaders("t")["content-type"]).toBe("application/json");
	});

	test("defaults the User-Agent and honours a subsystem override", () => {
		expect(buildGitLabHeaders("t")["user-agent"]).toBe(DEFAULT_GITLAB_USER_AGENT);
		expect(buildGitLabHeaders("t", { userAgent: "warren-forge-gitlab" })["user-agent"]).toBe(
			"warren-forge-gitlab",
		);
	});

	test("carries the token verbatim, making no assumption about its shape", () => {
		const odd = "glpat-_aB3.-x".repeat(9);
		expect(buildGitLabHeaders(odd)["private-token"]).toBe(odd);
	});
});
