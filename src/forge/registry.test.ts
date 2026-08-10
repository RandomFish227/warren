import { describe, expect, test } from "bun:test";
import { GiteaForge } from "./gitea/index.ts";
import { GitHubForge } from "./github/index.ts";
import { GitLabForge } from "./gitlab/index.ts";
import { forgeFor, forgeTokenFor } from "./registry.ts";

describe("forgeFor", () => {
	test("returns a GitHubForge for 'github'", () => {
		const f = forgeFor({ forgeKind: "github", gitUrl: "https://github.com/o/r" });
		expect(f).toBeInstanceOf(GitHubForge);
		expect(f.kind).toBe("github");
	});

	test("returns a GitLabForge for 'gitlab'", () => {
		const f = forgeFor({ forgeKind: "gitlab", gitUrl: "https://gitlab.com/o/r" });
		expect(f).toBeInstanceOf(GitLabForge);
		expect(f.kind).toBe("gitlab");
	});

	test("returns a GiteaForge for 'gitea'", () => {
		const f = forgeFor({ forgeKind: "gitea", gitUrl: "https://gitea.example.com/o/r" });
		expect(f).toBeInstanceOf(GiteaForge);
		expect(f.kind).toBe("gitea");
	});

	test("returns a GiteaForge for 'forgejo'", () => {
		const f = forgeFor({ forgeKind: "forgejo", gitUrl: "https://codeberg.org/o/r" });
		expect(f).toBeInstanceOf(GiteaForge);
		expect(f.kind).toBe("forgejo");
	});

	test("returns the same instance on repeated calls (memoised)", () => {
		const a = forgeFor({ forgeKind: "github", gitUrl: "https://github.com/o/r" });
		const b = forgeFor({ forgeKind: "github", gitUrl: "https://github.com/o/r2" });
		expect(a).toBe(b);
	});
});

describe("forgeTokenFor", () => {
	test("returns per-host token when WARREN_FORGE_TOKEN__<host> is set", () => {
		const token = forgeTokenFor(
			{ forgeKind: "github", gitUrl: "https://github.com/o/r" },
			{ WARREN_FORGE_TOKEN__github_com: "host-token", GITHUB_TOKEN: "kind-token" },
		);
		expect(token).toBe("host-token");
	});

	test("falls back to GITHUB_TOKEN when no per-host token", () => {
		const token = forgeTokenFor(
			{ forgeKind: "github", gitUrl: "https://github.com/o/r" },
			{ GITHUB_TOKEN: "kind-token" },
		);
		expect(token).toBe("kind-token");
	});

	test("falls back to GITLAB_TOKEN for gitlab kind", () => {
		const token = forgeTokenFor(
			{ forgeKind: "gitlab", gitUrl: "https://gitlab.com/o/r" },
			{ GITLAB_TOKEN: "gl-token" },
		);
		expect(token).toBe("gl-token");
	});

	test("falls back to GITEA_TOKEN for gitea kind", () => {
		const token = forgeTokenFor(
			{ forgeKind: "gitea", gitUrl: "https://gitea.example.com/o/r" },
			{ GITEA_TOKEN: "tea-token" },
		);
		expect(token).toBe("tea-token");
	});

	test("falls back to FORGEJO_TOKEN for forgejo kind", () => {
		const token = forgeTokenFor(
			{ forgeKind: "forgejo", gitUrl: "https://codeberg.org/o/r" },
			{ FORGEJO_TOKEN: "fj-token" },
		);
		expect(token).toBe("fj-token");
	});

	test("returns empty string when no token env var is set", () => {
		const token = forgeTokenFor({ forgeKind: "github", gitUrl: "https://github.com/o/r" }, {});
		expect(token).toBe("");
	});

	test("handles SCP-style gitUrl for per-host token resolution", () => {
		const token = forgeTokenFor(
			{ forgeKind: "github", gitUrl: "git@github.com:owner/repo.git" },
			{ WARREN_FORGE_TOKEN__github_com: "scp-host-token" },
		);
		expect(token).toBe("scp-host-token");
	});

	test("ignores empty per-host token and falls back to kind token", () => {
		const token = forgeTokenFor(
			{ forgeKind: "github", gitUrl: "https://github.com/o/r" },
			{ WARREN_FORGE_TOKEN__github_com: "", GITHUB_TOKEN: "fallback" },
		);
		expect(token).toBe("fallback");
	});

	test("returns empty string for unparseable gitUrl with no kind token", () => {
		const token = forgeTokenFor({ forgeKind: "github", gitUrl: "totally-invalid" }, {});
		expect(token).toBe("");
	});

	test("host dots and hyphens are normalised to underscores in the env key", () => {
		const token = forgeTokenFor(
			{ forgeKind: "gitlab", gitUrl: "https://gitlab.corp-internal.example.com/o/r" },
			{ WARREN_FORGE_TOKEN__gitlab_corp_internal_example_com: "internal-token" },
		);
		expect(token).toBe("internal-token");
	});
});
