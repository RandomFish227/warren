import { describe, expect, test } from "bun:test";
import { credentialGitEnv, extractGitHost } from "./credential-env.ts";

const GITHUB_CRED = { username: "x-access-token", secret: "tok", expiresAt: null };

describe("credentialGitEnv", () => {
	test("renders the insteadOf rule as GIT_CONFIG_* vars", () => {
		expect(credentialGitEnv(GITHUB_CRED, "github.com")).toEqual({
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "url.https://x-access-token:tok@github.com/.insteadOf",
			GIT_CONFIG_VALUE_0: "https://github.com/",
		});
	});

	test("undefined credential → empty overrides (public repos clone anonymously)", () => {
		expect(credentialGitEnv(undefined, "github.com")).toEqual({});
	});

	test("empty secret → empty overrides", () => {
		expect(
			credentialGitEnv({ username: "x-access-token", secret: "", expiresAt: null }, "github.com"),
		).toEqual({});
	});

	test("undefined host → empty overrides", () => {
		expect(credentialGitEnv(GITHUB_CRED, undefined)).toEqual({});
	});

	test("non-github host", () => {
		expect(
			credentialGitEnv({ username: "user", secret: "tok", expiresAt: null }, "forgejo.example.com"),
		).toEqual({
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "url.https://user:tok@forgejo.example.com/.insteadOf",
			GIT_CONFIG_VALUE_0: "https://forgejo.example.com/",
		});
	});
});

describe("extractGitHost", () => {
	test("https URL", () => expect(extractGitHost("https://github.com/o/r.git")).toBe("github.com"));
	test("scp-style", () => expect(extractGitHost("git@github.com:o/r.git")).toBe("github.com"));
	test("ssh URL", () => expect(extractGitHost("ssh://git@github.com/o/r")).toBe("github.com"));
	test("unrecognised form", () => expect(extractGitHost("not-a-url")).toBeUndefined());
});
