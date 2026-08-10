import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { parseRepoUrl } from "./url.ts";

describe("parseRepoUrl", () => {
	test("parses https URL without .git suffix", () => {
		const ref = parseRepoUrl("https://github.com/owner/repo");
		expect(ref).toEqual({ host: "github.com", owner: "owner", name: "repo" });
	});

	test("parses https URL with .git suffix", () => {
		const ref = parseRepoUrl("https://github.com/owner/repo.git");
		expect(ref).toEqual({ host: "github.com", owner: "owner", name: "repo" });
	});

	test("parses SCP-style git@ URL", () => {
		const ref = parseRepoUrl("git@github.com:owner/repo.git");
		expect(ref).toEqual({ host: "github.com", owner: "owner", name: "repo" });
	});

	test("parses ssh:// URL", () => {
		const ref = parseRepoUrl("ssh://git@gitlab.com/owner/repo");
		expect(ref).toEqual({ host: "gitlab.com", owner: "owner", name: "repo" });
	});

	test("normalises host to lowercase", () => {
		const ref = parseRepoUrl("https://GitHub.COM/Owner/Repo");
		expect(ref.host).toBe("github.com");
	});

	test("parses GitLab host", () => {
		const ref = parseRepoUrl("https://gitlab.example.com/group/project");
		expect(ref).toEqual({ host: "gitlab.example.com", owner: "group", name: "project" });
	});

	test("throws ValidationError for empty input", () => {
		expect(() => parseRepoUrl("")).toThrow(ValidationError);
		expect(() => parseRepoUrl("   ")).toThrow(ValidationError);
	});

	test("throws ValidationError for unrecognized URL shape", () => {
		expect(() => parseRepoUrl("ftp://example.com/owner/repo")).toThrow(ValidationError);
	});

	test("throws ValidationError when owner is empty (e.g. .git suffix only)", () => {
		// https://host/.git/name → owner becomes "" after stripGitSuffix
		expect(() => parseRepoUrl("https://github.com/.git/name")).toThrow(ValidationError);
	});

	test("throws ValidationError when owner is '.'", () => {
		expect(() => parseRepoUrl("https://github.com/./repo")).toThrow(ValidationError);
	});

	test("throws ValidationError when owner is '..'", () => {
		expect(() => parseRepoUrl("https://github.com/../repo")).toThrow(ValidationError);
	});

	test("throws ValidationError when owner starts with a dash", () => {
		expect(() => parseRepoUrl("https://github.com/-invalid/repo")).toThrow(ValidationError);
	});

	test("throws ValidationError when name starts with a dash", () => {
		expect(() => parseRepoUrl("https://github.com/owner/-bad-name")).toThrow(ValidationError);
	});

	test("throws ValidationError when owner contains invalid characters", () => {
		expect(() => parseRepoUrl("https://github.com/owner!/repo")).toThrow(ValidationError);
	});

	test("throws ValidationError when name contains invalid characters", () => {
		expect(() => parseRepoUrl("https://github.com/owner/repo!name")).toThrow(ValidationError);
	});

	test("error messages include the offending segment", () => {
		try {
			parseRepoUrl("https://github.com/-bad/repo");
		} catch (err) {
			expect(err).toBeInstanceOf(ValidationError);
			const ve = err as ValidationError;
			expect(ve.message).toMatch(/owner/);
		}
	});
});
