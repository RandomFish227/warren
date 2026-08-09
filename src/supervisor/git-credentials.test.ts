import { describe, expect, test } from "bun:test";
import {
	defaultGitCredentialsRun,
	type GitCredentialsRun,
	installGitCredentials,
} from "./git-credentials.ts";
import type { SupervisorLogger } from "./main.ts";

interface LoggedCall {
	level: "info" | "warn" | "error";
	obj: object;
	msg?: string;
}

function makeLogger(): { logger: SupervisorLogger; logs: LoggedCall[] } {
	const logs: LoggedCall[] = [];
	const logger: SupervisorLogger = {
		info: (obj, msg) => logs.push({ level: "info", obj, msg }),
		warn: (obj, msg) => logs.push({ level: "warn", obj, msg }),
		error: (obj, msg) => logs.push({ level: "error", obj, msg }),
	};
	return { logger, logs };
}

describe("installGitCredentials", () => {
	test("no-op when GITHUB_TOKEN is undefined", async () => {
		const { logger, logs } = makeLogger();
		const calls: { cmd: string; args: readonly string[] }[] = [];
		const run: GitCredentialsRun = async (cmd, args) => {
			calls.push({ cmd, args });
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		const result = await installGitCredentials({ run, logger }, { githubToken: undefined });

		expect(result.installed).toBe(false);
		expect(result.forgejoInstalled).toBe(false);
		expect(calls).toHaveLength(0);
		expect(logs[0]?.level).toBe("info");
		expect(logs[0]?.msg).toContain("GITHUB_TOKEN unset");
	});

	test("no-op when GITHUB_TOKEN is the empty string", async () => {
		const { logger } = makeLogger();
		const calls: { cmd: string; args: readonly string[] }[] = [];
		const run: GitCredentialsRun = async (cmd, args) => {
			calls.push({ cmd, args });
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		const result = await installGitCredentials({ run, logger }, { githubToken: "" });

		expect(result.installed).toBe(false);
		expect(result.forgejoInstalled).toBe(false);
		expect(calls).toHaveLength(0);
	});

	test("writes the insteadOf rule with the token baked into the rewrite URL", async () => {
		const { logger, logs } = makeLogger();
		const calls: { cmd: string; args: readonly string[] }[] = [];
		const run: GitCredentialsRun = async (cmd, args) => {
			calls.push({ cmd, args });
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		const result = await installGitCredentials({ run, logger }, { githubToken: "ghp_secret123" });

		expect(result.installed).toBe(true);
		expect(result.forgejoInstalled).toBe(false);
		expect(calls).toEqual([
			{
				cmd: "git",
				args: [
					"config",
					"--global",
					"url.https://x-access-token:ghp_secret123@github.com/.insteadOf",
					"https://github.com/",
				],
			},
		]);
		expect(logs.at(-1)?.msg).toContain("installed git insteadOf rule");
	});

	test("installs Forgejo insteadOf rule when both FORGEJO_TOKEN and WARREN_FORGEJO_HOST are set", async () => {
		const { logger } = makeLogger();
		const calls: { cmd: string; args: readonly string[] }[] = [];
		const run: GitCredentialsRun = async (cmd, args) => {
			calls.push({ cmd, args });
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		const result = await installGitCredentials(
			{ run, logger },
			{
				githubToken: "ghp_github",
				forgejoToken: "fj_secret",
				forgejoHost: "codeberg.org",
			},
		);

		expect(result.installed).toBe(true);
		expect(result.forgejoInstalled).toBe(true);
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual({
			cmd: "git",
			args: [
				"config",
				"--global",
				"url.https://x-access-token:fj_secret@codeberg.org/.insteadOf",
				"https://codeberg.org/",
			],
		});
	});

	test("skips Forgejo rule when FORGEJO_TOKEN is set but WARREN_FORGEJO_HOST is missing", async () => {
		const { logger, logs } = makeLogger();
		const calls: { cmd: string; args: readonly string[] }[] = [];
		const run: GitCredentialsRun = async (cmd, args) => {
			calls.push({ cmd, args });
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		const result = await installGitCredentials(
			{ run, logger },
			{ githubToken: "ghp_github", forgejoToken: "fj_secret" },
		);

		expect(result.forgejoInstalled).toBe(false);
		expect(calls).toHaveLength(1); // only github
		expect(logs.some((l) => l.msg?.includes("WARREN_FORGEJO_HOST unset"))).toBe(true);
	});

	test("respects the gitBinary override", async () => {
		const { logger } = makeLogger();
		const calls: { cmd: string; args: readonly string[] }[] = [];
		const run: GitCredentialsRun = async (cmd, args) => {
			calls.push({ cmd, args });
			return { exitCode: 0, stdout: "", stderr: "" };
		};

		await installGitCredentials(
			{ run, logger },
			{ githubToken: "tok", gitBinary: "/usr/local/bin/git" },
		);

		expect(calls[0]?.cmd).toBe("/usr/local/bin/git");
	});

	test("does not log the token value", async () => {
		const { logger, logs } = makeLogger();
		const run: GitCredentialsRun = async () => ({ exitCode: 0, stdout: "", stderr: "" });

		await installGitCredentials({ run, logger }, { githubToken: "ghp_super_secret" });

		const serialized = JSON.stringify(logs);
		expect(serialized).not.toContain("ghp_super_secret");
	});

	test("throws (without exposing the token in the message) on non-zero exit", async () => {
		const { logger } = makeLogger();
		const run: GitCredentialsRun = async () => ({
			exitCode: 128,
			stdout: "",
			stderr: "fatal: $HOME not set",
		});

		const promise = installGitCredentials({ run, logger }, { githubToken: "ghp_secret" });

		await expect(promise).rejects.toThrow(/git config --global failed \(exit 128\)/);
		await expect(promise).rejects.toThrow(/fatal: \$HOME not set/);
		try {
			await promise;
		} catch (err) {
			expect((err as Error).message).not.toContain("ghp_secret");
		}
	});
});

describe("defaultGitCredentialsRun", () => {
	test("returns exitCode 0 + stdout for a successful command", async () => {
		const result = await defaultGitCredentialsRun("/bin/sh", ["-c", "echo hello"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("hello");
	});

	test("returns the non-zero exit code with stderr for a failing command", async () => {
		const result = await defaultGitCredentialsRun("/bin/sh", ["-c", "echo oops 1>&2; exit 7"]);
		expect(result.exitCode).toBe(7);
		expect(result.stderr).toContain("oops");
	});
});
