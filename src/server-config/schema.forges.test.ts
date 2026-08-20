/**
 * Tests for the `[[forges]]` block in the warren server config schema
 * (warren-f012, multi-forge-support.md §2a).
 */

import { describe, expect, test } from "bun:test";
import {
	ForgeInstanceConfigSchema,
	ForgesConfigSchema,
	parseWarrenServerFileConfig,
} from "./schema.ts";

describe("ForgeInstanceConfigSchema", () => {
	describe("valid entries", () => {
		test("minimal github entry with tokenEnv", () => {
			const result = ForgeInstanceConfigSchema.safeParse({
				id: "github",
				kind: "github",
				tokenEnv: "GITHUB_TOKEN",
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.id).toBe("github");
				expect(result.data.kind).toBe("github");
				expect(result.data.tokenEnv).toBe("GITHUB_TOKEN");
				expect(result.data.baseUrl).toBeUndefined();
			}
		});

		test("github entry with a non-default tokenEnv name", () => {
			const result = ForgeInstanceConfigSchema.safeParse({
				id: "github-work",
				kind: "github",
				tokenEnv: "WORK_GITHUB_PAT",
			});
			expect(result.success).toBe(true);
		});

		test("app entry with no tokenEnv (app reads WARREN_GITHUB_APP_* vars)", () => {
			const result = ForgeInstanceConfigSchema.safeParse({
				id: "github-app",
				kind: "app",
			});
			expect(result.success).toBe(true);
		});

		test("fake entry with no credential fields", () => {
			const result = ForgeInstanceConfigSchema.safeParse({
				id: "fake",
				kind: "fake",
			});
			expect(result.success).toBe(true);
		});

		test("id accepts dots, dashes, underscores after first char", () => {
			for (const id of ["a.b", "my-forge", "forge_1", "gh.internal-1"]) {
				const result = ForgeInstanceConfigSchema.safeParse({
					id,
					kind: "fake",
				});
				expect(result.success).toBe(true);
			}
		});
	});

	describe("id validation", () => {
		test("empty id is rejected", () => {
			const result = ForgeInstanceConfigSchema.safeParse({ id: "", kind: "fake" });
			expect(result.success).toBe(false);
		});

		test("id starting with uppercase is rejected", () => {
			const result = ForgeInstanceConfigSchema.safeParse({ id: "GitHub", kind: "fake" });
			expect(result.success).toBe(false);
		});

		test("id starting with a dash is rejected", () => {
			const result = ForgeInstanceConfigSchema.safeParse({ id: "-forge", kind: "fake" });
			expect(result.success).toBe(false);
		});

		test("id with spaces is rejected", () => {
			const result = ForgeInstanceConfigSchema.safeParse({ id: "my forge", kind: "fake" });
			expect(result.success).toBe(false);
		});

		test("id with slash is rejected", () => {
			const result = ForgeInstanceConfigSchema.safeParse({ id: "github/main", kind: "fake" });
			expect(result.success).toBe(false);
		});
	});

	describe("kind validation", () => {
		test("unknown kind is rejected", () => {
			const result = ForgeInstanceConfigSchema.safeParse({
				id: "forge",
				kind: "forgejo",
				tokenEnv: "TOKEN",
			});
			expect(result.success).toBe(false);
		});

		test("gitlab is not yet accepted", () => {
			const result = ForgeInstanceConfigSchema.safeParse({
				id: "gl",
				kind: "gitlab",
				tokenEnv: "GITLAB_TOKEN",
			});
			expect(result.success).toBe(false);
		});
	});

	describe("baseUrl constraint — forbidden for all current kinds", () => {
		test("baseUrl on github entry is rejected", () => {
			const result = ForgeInstanceConfigSchema.safeParse({
				id: "github",
				kind: "github",
				tokenEnv: "GITHUB_TOKEN",
				baseUrl: "https://github.com",
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				const paths = result.error.issues.map((i) => i.path.join("."));
				expect(paths).toContain("baseUrl");
			}
		});

		test("baseUrl on app entry is rejected", () => {
			const result = ForgeInstanceConfigSchema.safeParse({
				id: "gh-app",
				kind: "app",
				baseUrl: "https://github.com",
			});
			expect(result.success).toBe(false);
		});

		test("baseUrl on fake entry is rejected", () => {
			const result = ForgeInstanceConfigSchema.safeParse({
				id: "fake",
				kind: "fake",
				baseUrl: "https://fake.example.com",
			});
			expect(result.success).toBe(false);
		});
	});

	describe("tokenEnv constraint — required for github, not applicable to others", () => {
		test("github without tokenEnv is rejected", () => {
			const result = ForgeInstanceConfigSchema.safeParse({
				id: "github",
				kind: "github",
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				const paths = result.error.issues.map((i) => i.path.join("."));
				expect(paths).toContain("tokenEnv");
			}
		});

		test("tokenEnv must be UPPER_SNAKE_CASE", () => {
			const result = ForgeInstanceConfigSchema.safeParse({
				id: "github",
				kind: "github",
				tokenEnv: "github_token",
			});
			expect(result.success).toBe(false);
		});

		test("tokenEnv with a leading digit is rejected", () => {
			const result = ForgeInstanceConfigSchema.safeParse({
				id: "github",
				kind: "github",
				tokenEnv: "1TOKEN",
			});
			expect(result.success).toBe(false);
		});

		test("app can optionally carry tokenEnv (schema permits it, but ignored)", () => {
			// app kind reads WARREN_GITHUB_APP_* vars; schema does not forbid tokenEnv
			// on app (it would be unused but not harmful) — no cross-field reject here.
			const result = ForgeInstanceConfigSchema.safeParse({
				id: "gh-app",
				kind: "app",
				tokenEnv: "APP_TOKEN",
			});
			expect(result.success).toBe(true);
		});
	});

	describe("strict — unknown fields are rejected", () => {
		test("extra field is rejected", () => {
			const result = ForgeInstanceConfigSchema.safeParse({
				id: "github",
				kind: "github",
				tokenEnv: "GITHUB_TOKEN",
				extra: "boom",
			});
			expect(result.success).toBe(false);
		});
	});
});

describe("ForgesConfigSchema", () => {
	test("empty array is valid", () => {
		const result = ForgesConfigSchema.safeParse([]);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data).toEqual([]);
		}
	});

	test("single valid entry is accepted", () => {
		const result = ForgesConfigSchema.safeParse([
			{ id: "github", kind: "github", tokenEnv: "GITHUB_TOKEN" },
		]);
		expect(result.success).toBe(true);
	});

	test("multiple distinct ids are accepted", () => {
		const result = ForgesConfigSchema.safeParse([
			{ id: "github", kind: "github", tokenEnv: "GITHUB_TOKEN" },
			{ id: "fake", kind: "fake" },
		]);
		expect(result.success).toBe(true);
	});

	test("duplicate ids are rejected", () => {
		const result = ForgesConfigSchema.safeParse([
			{ id: "github", kind: "github", tokenEnv: "GITHUB_TOKEN" },
			{ id: "github", kind: "fake" },
		]);
		expect(result.success).toBe(false);
		if (!result.success) {
			const messages = result.error.issues.map((i) => i.message).join(" ");
			expect(messages).toContain("github");
		}
	});
});

describe("parseWarrenServerFileConfig — forges block integration", () => {
	test("no forges key → valid empty config", () => {
		const result = parseWarrenServerFileConfig({});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.forges).toBeUndefined();
		}
	});

	test("forges: [] is valid and preserved", () => {
		const result = parseWarrenServerFileConfig({ forges: [] });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.forges).toEqual([]);
		}
	});

	test("valid forges block is parsed", () => {
		const result = parseWarrenServerFileConfig({
			forges: [{ id: "github", kind: "github", tokenEnv: "GITHUB_TOKEN" }],
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.forges).toHaveLength(1);
			expect(result.value.forges?.[0]?.id).toBe("github");
		}
	});

	test("malformed forge entry surfaces a descriptive error", () => {
		const result = parseWarrenServerFileConfig({
			forges: [{ id: "github", kind: "github" }],
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("tokenEnv");
		}
	});
});
