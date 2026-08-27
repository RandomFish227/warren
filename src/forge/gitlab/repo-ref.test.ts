import { describe, expect, test } from "bun:test";
import {
	GITLAB_FORGE_KIND,
	gitLabProjectPath,
	normalizeGitLabHost,
	parseGitLabInstanceUrl,
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

	test("survives an IPv6 authority instead of slicing into the address", () => {
		// A naive lastIndexOf(":") strip turns bare [::1] into "[:" and the forge
		// silently disowns a URL it owns.
		expect(parseGitLabRepoRef("https://[::1]:8443/acme/project", "[::1]:8443")).toEqual({
			forge: GITLAB_FORGE_KIND,
			key: "[::1]:8443/acme/project",
		});
		expect(parseGitLabRepoRef("ssh://git@[::1]/acme/project.git", "[::1]:8443")).toEqual({
			forge: GITLAB_FORGE_KIND,
			key: "[::1]:8443/acme/project",
		});
		expect(parseGitLabRepoRef("https://[::1]/acme/project", "[::1]")).toEqual({
			forge: GITLAB_FORGE_KIND,
			key: "[::1]/acme/project",
		});
	});

	test("yields no project when /-/ leaves fewer than two path segments", () => {
		// Pinned deliberately: this falls out of MIN_PATH_SEGMENTS today, and the
		// next edit to that constant must not silently change it.
		expect(parseGitLabRepoRef("https://gitlab.com/-/profile", SAAS)).toBeNull();
		expect(parseGitLabRepoRef("https://gitlab.com/acme/-/something", SAAS)).toBeNull();
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

describe("parseGitLabInstanceUrl", () => {
	test("yields the scheme-less host and the scheme-bearing origin together", () => {
		expect(parseGitLabInstanceUrl("https://gitlab.com")).toEqual({
			host: "gitlab.com",
			origin: "https://gitlab.com",
		});
	});

	test("preserves a plain-http scheme in the origin", () => {
		// The whole reason host and origin come from one parse: assuming https
		// for the origin would point the transport somewhere the ref matching
		// never went, so the project registers and the API is unreachable.
		expect(parseGitLabInstanceUrl("http://gitlab.internal:3000")).toEqual({
			host: "gitlab.internal:3000",
			origin: "http://gitlab.internal:3000",
		});
	});

	test("a bare authority defaults to https in both halves", () => {
		expect(parseGitLabInstanceUrl("gitlab.example.com")).toEqual({
			host: "gitlab.example.com",
			origin: "https://gitlab.example.com",
		});
	});

	test("drops a default port from the origin as well as the host", () => {
		expect(parseGitLabInstanceUrl("https://gitlab.com:443")).toEqual({
			host: "gitlab.com",
			origin: "https://gitlab.com",
		});
	});

	test("returns null for input naming no host, matching normalizeGitLabHost", () => {
		for (const bad of ["", "   ", "ssh://gitlab.com", "file:///srv"]) {
			expect(parseGitLabInstanceUrl(bad)).toBeNull();
			expect(normalizeGitLabHost(bad)).toBeNull();
		}
	});

	test("normalizeGitLabHost stays a thin read of this parse", () => {
		for (const input of [
			"https://gitlab.com",
			"gitlab.example.com",
			"http://h:3000",
			"  h:8443  ",
		]) {
			expect(normalizeGitLabHost(input)).toBe(parseGitLabInstanceUrl(input)?.host ?? null);
		}
	});
});
