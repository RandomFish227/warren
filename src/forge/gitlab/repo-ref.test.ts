import { describe, expect, test } from "bun:test";
import {
	GITLAB_FORGE_KIND,
	gitLabProjectPath,
	normalizeGitLabHost,
	parseGitLabRepoRef,
} from "./repo-ref.ts";

const SAAS = "gitlab.com";
const SELF = "gitlab.example.com";

describe("parseGitLabRepoRef", () => {
	test("parses the https clone grammar, stripping .git and trailing slashes", () => {
		for (const url of [
			"https://gitlab.com/group/project",
			"https://gitlab.com/group/project.git",
			"https://gitlab.com/group/project.git/",
			"https://gitlab.com/group/project/",
		]) {
			expect(parseGitLabRepoRef(url, SAAS)).toEqual({
				forge: GITLAB_FORGE_KIND,
				key: "gitlab.com/group/project",
			});
		}
	});

	test("carries the whole path when groups are nested", () => {
		expect(parseGitLabRepoRef("https://gitlab.com/acme/team/sub/project.git", SAAS)).toEqual({
			forge: GITLAB_FORGE_KIND,
			key: "gitlab.com/acme/team/sub/project",
		});
	});

	test("parses the scp-style grammar across nested groups", () => {
		expect(parseGitLabRepoRef("git@gitlab.com:acme/team/project.git", SAAS)).toEqual({
			forge: GITLAB_FORGE_KIND,
			key: "gitlab.com/acme/team/project",
		});
	});

	test("parses the ssh:// grammar", () => {
		expect(parseGitLabRepoRef("ssh://git@gitlab.com/acme/project.git", SAAS)).toEqual({
			forge: GITLAB_FORGE_KIND,
			key: "gitlab.com/acme/project",
		});
	});

	test("trims a merge-request web URL at the /-/ sentinel", () => {
		expect(
			parseGitLabRepoRef("https://gitlab.com/acme/team/project/-/merge_requests/42", SAAS),
		).toEqual({ forge: GITLAB_FORGE_KIND, key: "gitlab.com/acme/team/project" });
	});

	test("trims any other /-/ sub-resource at the same sentinel", () => {
		expect(parseGitLabRepoRef("https://gitlab.com/acme/project/-/tree/main/src", SAAS)).toEqual({
			forge: GITLAB_FORGE_KIND,
			key: "gitlab.com/acme/project",
		});
	});

	test("decodes the api/v4 project grammar back into a path", () => {
		expect(
			parseGitLabRepoRef("https://gitlab.com/api/v4/projects/acme%2Fteam%2Fproject", SAAS),
		).toEqual({ forge: GITLAB_FORGE_KIND, key: "gitlab.com/acme/team/project" });
	});

	test("disowns an api/v4 URL that names a project by numeric id", () => {
		// A numeric id cannot be resolved to a path without calling the API, and
		// a ref must be derivable offline.
		expect(parseGitLabRepoRef("https://gitlab.com/api/v4/projects/1234", SAAS)).toBeNull();
	});

	test("owns a self-hosted instance and disowns every other host", () => {
		expect(parseGitLabRepoRef("https://gitlab.example.com/acme/project", SELF)).toEqual({
			forge: GITLAB_FORGE_KIND,
			key: "gitlab.example.com/acme/project",
		});
		expect(parseGitLabRepoRef("https://gitlab.com/acme/project", SELF)).toBeNull();
		expect(parseGitLabRepoRef("https://github.com/owner/repo", SAAS)).toBeNull();
	});

	test("treats a non-default port as part of the https authority", () => {
		expect(
			parseGitLabRepoRef("https://gitlab.example.com:8443/acme/project", "gitlab.example.com:8443"),
		).toEqual({
			forge: GITLAB_FORGE_KIND,
			key: "gitlab.example.com:8443/acme/project",
		});
		// The port is load-bearing: git treats a different port as a different
		// remote, so a portless URL must not match a ported instance.
		expect(
			parseGitLabRepoRef("https://gitlab.example.com/acme/project", "gitlab.example.com:8443"),
		).toBeNull();
	});

	test("matches the ssh grammars on host alone, ignoring the configured http port", () => {
		// An scp/ssh remote reaches the ssh port, never the configured web port.
		expect(
			parseGitLabRepoRef("git@gitlab.example.com:acme/project.git", "gitlab.example.com:8443"),
		).toEqual({ forge: GITLAB_FORGE_KIND, key: "gitlab.example.com:8443/acme/project" });
	});

	test("disowns a path with fewer than two segments", () => {
		expect(parseGitLabRepoRef("https://gitlab.com/project", SAAS)).toBeNull();
		expect(parseGitLabRepoRef("https://gitlab.com/", SAAS)).toBeNull();
	});

	test("disowns GitLab's own reserved top-level routes", () => {
		for (const url of [
			"https://gitlab.com/users/someone",
			"https://gitlab.com/explore/projects",
			"https://gitlab.com/admin/runners",
			"https://gitlab.com/help/user/index",
		]) {
			expect(parseGitLabRepoRef(url, SAAS)).toBeNull();
		}
	});

	test("disowns path-unsafe segments", () => {
		for (const url of [
			"https://gitlab.com/acme/../etc",
			"https://gitlab.com/acme/.",
			"https://gitlab.com/-hidden/project",
			"https://gitlab.com/acme/pro ject",
		]) {
			expect(parseGitLabRepoRef(url, SAAS)).toBeNull();
		}
	});

	test("disowns unparseable input and unsupported schemes", () => {
		expect(parseGitLabRepoRef("", SAAS)).toBeNull();
		expect(parseGitLabRepoRef("   ", SAAS)).toBeNull();
		expect(parseGitLabRepoRef("not a url", SAAS)).toBeNull();
		expect(parseGitLabRepoRef("file:///srv/acme/project", SAAS)).toBeNull();
		expect(parseGitLabRepoRef("fake://owner/name", SAAS)).toBeNull();
	});

	test("never throws for arbitrary input", () => {
		for (const url of ["://", "https://", "%%%", "git@:", "https://gitlab.com/%E0%A4%A"]) {
			expect(() => parseGitLabRepoRef(url, SAAS)).not.toThrow();
		}
	});
});

describe("gitLabProjectPath", () => {
	test("returns the path a ref from this instance carries", () => {
		const ref = parseGitLabRepoRef("https://gitlab.com/acme/team/project", SAAS);
		expect(ref).not.toBeNull();
		expect(gitLabProjectPath(ref as { forge: string; key: string }, SAAS)).toBe(
			"acme/team/project",
		);
	});

	test("refuses a ref from another forge or another instance", () => {
		expect(gitLabProjectPath({ forge: "github", key: "github.com/owner/repo" }, SAAS)).toBeNull();
		expect(
			gitLabProjectPath({ forge: GITLAB_FORGE_KIND, key: "gitlab.example.com/a/b" }, SAAS),
		).toBeNull();
	});
});

describe("normalizeGitLabHost", () => {
	test("accepts a full URL and reduces it to the authority", () => {
		expect(normalizeGitLabHost("https://gitlab.com")).toBe("gitlab.com");
		expect(normalizeGitLabHost("https://GitLab.Example.COM/")).toBe("gitlab.example.com");
		expect(normalizeGitLabHost("http://gitlab.internal:3000")).toBe("gitlab.internal:3000");
	});

	test("accepts a bare authority, which is what operators usually type", () => {
		expect(normalizeGitLabHost("gitlab.example.com")).toBe("gitlab.example.com");
		expect(normalizeGitLabHost("  gitlab.example.com:8443  ")).toBe("gitlab.example.com:8443");
	});

	test("drops the port when it is the scheme default", () => {
		expect(normalizeGitLabHost("https://gitlab.com:443")).toBe("gitlab.com");
		expect(normalizeGitLabHost("http://gitlab.internal:80")).toBe("gitlab.internal");
	});

	test("returns null for input that names no usable host", () => {
		expect(normalizeGitLabHost("")).toBeNull();
		expect(normalizeGitLabHost("   ")).toBeNull();
		expect(normalizeGitLabHost("ssh://gitlab.com")).toBeNull();
		expect(normalizeGitLabHost("file:///srv")).toBeNull();
	});
});
