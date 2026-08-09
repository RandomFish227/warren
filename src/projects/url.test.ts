import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { parseGitHubUrl, parseRepoUrl } from "./url.ts";

describe("parseGitHubUrl / parseRepoUrl", () => {
	test("accepts https URLs with and without the .git suffix", () => {
		expect(parseGitHubUrl("https://github.com/jayminwest/warren")).toMatchObject({
			host: "github.com",
			owner: "jayminwest",
			name: "warren",
		});
		expect(parseGitHubUrl("https://github.com/jayminwest/warren.git")).toMatchObject({
			owner: "jayminwest",
			name: "warren",
		});
		expect(parseGitHubUrl("https://github.com/jayminwest/warren/")).toMatchObject({
			owner: "jayminwest",
			name: "warren",
		});
	});

	test("accepts the scp-style git@github.com:owner/name shape", () => {
		expect(parseGitHubUrl("git@github.com:jayminwest/warren.git")).toMatchObject({
			host: "github.com",
			owner: "jayminwest",
			name: "warren",
		});
		expect(parseGitHubUrl("git@github.com:jayminwest/warren")).toMatchObject({
			owner: "jayminwest",
			name: "warren",
		});
	});

	test("accepts ssh:// URLs", () => {
		expect(parseGitHubUrl("ssh://git@github.com/jayminwest/warren.git")).toMatchObject({
			owner: "jayminwest",
			name: "warren",
		});
	});

	test("trims surrounding whitespace before parsing", () => {
		expect(parseGitHubUrl("  https://github.com/jayminwest/warren\n")).toMatchObject({
			owner: "jayminwest",
			name: "warren",
		});
	});

	test("rejects empty input", () => {
		expect(() => parseGitHubUrl("")).toThrow(ValidationError);
		expect(() => parseGitHubUrl("   ")).toThrow(ValidationError);
	});

	test("rejects file:// and other non-git schemes", () => {
		expect(() => parseGitHubUrl("file:///tmp/repo")).toThrow(ValidationError);
		expect(() => parseGitHubUrl("ftp://github.com/owner/name")).toThrow(ValidationError);
	});

	test("rejects URLs missing owner or name", () => {
		expect(() => parseGitHubUrl("https://github.com/")).toThrow(ValidationError);
		expect(() => parseGitHubUrl("https://github.com/jayminwest")).toThrow(ValidationError);
		expect(() => parseGitHubUrl("git@github.com:jayminwest")).toThrow(ValidationError);
	});

	test("rejects path-traversal segments and dash-leading names", () => {
		expect(() => parseGitHubUrl("https://github.com/../escape.git")).toThrow(ValidationError);
		expect(() => parseGitHubUrl("https://github.com/owner/..")).toThrow(ValidationError);
		expect(() => parseGitHubUrl("https://github.com/owner/.")).toThrow(ValidationError);
		expect(() => parseGitHubUrl("https://github.com/-owner/repo")).toThrow(ValidationError);
		expect(() => parseGitHubUrl("https://github.com/owner/-repo")).toThrow(ValidationError);
	});

	test("rejects names with disallowed characters (slashes, spaces, etc.)", () => {
		expect(() => parseGitHubUrl("https://github.com/owner/sub/dir/repo")).toThrow(ValidationError);
		expect(() => parseGitHubUrl("https://github.com/owner/repo name")).toThrow(ValidationError);
	});
});

describe("Forgejo URL support (warren-fg01)", () => {
	test("accepts Forgejo HTTPS URLs and returns the correct host", () => {
		expect(parseRepoUrl("https://codeberg.org/owner/repo")).toEqual({
			host: "codeberg.org",
			owner: "owner",
			name: "repo",
		});
		expect(parseRepoUrl("https://forgejo.example.com/owner/repo.git")).toEqual({
			host: "forgejo.example.com",
			owner: "owner",
			name: "repo",
		});
	});

	test("accepts scp-style git@ URLs for Forgejo hosts", () => {
		expect(parseRepoUrl("git@codeberg.org:owner/repo.git")).toEqual({
			host: "codeberg.org",
			owner: "owner",
			name: "repo",
		});
	});

	test("accepts Forgejo URLs with .git suffix", () => {
		expect(parseRepoUrl("https://codeberg.org/owner/repo.git")).toMatchObject({
			host: "codeberg.org",
			owner: "owner",
			name: "repo",
		});
	});

	test("returns host in lowercase", () => {
		expect(parseRepoUrl("https://Codeberg.Org/owner/repo").host).toBe("codeberg.org");
	});

	test("rejects path-traversal on Forgejo hosts too", () => {
		expect(() => parseRepoUrl("https://codeberg.org/../escape")).toThrow(ValidationError);
		expect(() => parseRepoUrl("https://codeberg.org/-owner/repo")).toThrow(ValidationError);
	});

	test("rejects empty input on Forgejo URLs", () => {
		expect(() => parseRepoUrl("")).toThrow(ValidationError);
	});
});
