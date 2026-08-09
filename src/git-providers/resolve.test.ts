import { describe, expect, test } from "bun:test";
import {
	resolveGitProviderFromHost,
	resolveGitProviderFromUrl,
	selectProviderToken,
} from "./resolve.ts";

describe("resolveGitProviderFromHost", () => {
	test("returns GitHub provider for github.com", () => {
		const p = resolveGitProviderFromHost("github.com");
		expect(p.kind).toBe("github");
		expect(p.apiBase).toBe("https://api.github.com");
		expect(p.host).toBe("github.com");
	});

	test("is case-insensitive for GitHub", () => {
		const p = resolveGitProviderFromHost("GitHub.COM");
		expect(p.kind).toBe("github");
	});

	test("returns Forgejo provider for any other host", () => {
		const p = resolveGitProviderFromHost("codeberg.org");
		expect(p.kind).toBe("forgejo");
		expect(p.host).toBe("codeberg.org");
		expect(p.apiBase).toBe("https://codeberg.org/api/v1");
	});

	test("normalises host to lowercase for Forgejo", () => {
		const p = resolveGitProviderFromHost("Forgejo.Example.COM");
		expect(p.host).toBe("forgejo.example.com");
		expect(p.apiBase).toBe("https://forgejo.example.com/api/v1");
	});
});

describe("resolveGitProviderFromUrl", () => {
	test("resolves GitHub from a full github.com URL", () => {
		const p = resolveGitProviderFromUrl("https://github.com/owner/repo");
		expect(p.kind).toBe("github");
	});

	test("resolves Forgejo from a codeberg.org URL", () => {
		const p = resolveGitProviderFromUrl("https://codeberg.org/owner/repo");
		expect(p.kind).toBe("forgejo");
		expect(p.apiBase).toBe("https://codeberg.org/api/v1");
	});

	test("falls back to GitHub for unparseable URLs", () => {
		const p = resolveGitProviderFromUrl("not-a-url");
		expect(p.kind).toBe("github");
	});

	test("works with git@ SCP-style (treated as non-URL, falls back to GitHub)", () => {
		// SCP-style URLs aren't valid WHATWG URLs; the function falls back gracefully.
		const p = resolveGitProviderFromUrl("git@github.com:owner/repo.git");
		expect(p.kind).toBe("github");
	});
});

describe("selectProviderToken", () => {
	test("returns github token for github kind", () => {
		expect(selectProviderToken("github", "gh-token", "fj-token")).toBe("gh-token");
	});

	test("returns forgejo token for forgejo kind", () => {
		expect(selectProviderToken("forgejo", "gh-token", "fj-token")).toBe("fj-token");
	});

	test("falls back to github token when forgejoToken is undefined", () => {
		expect(selectProviderToken("forgejo", "gh-token", undefined)).toBe("gh-token");
	});

	test("falls back to github token when forgejoToken is empty string", () => {
		// undefined is the "not set" value; empty string falls back too since
		// ?? only coalesces null/undefined.
		expect(selectProviderToken("forgejo", "gh-token", "")).toBe("");
	});
});
