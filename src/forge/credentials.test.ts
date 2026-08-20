import { describe, expect, test } from "bun:test";
import { GitCredentialMintError, mintGitCredential } from "./credentials.ts";
import { FakeForge } from "./fake/fake-forge.ts";
import { GitHubForge } from "./github/provider.ts";

describe("mintGitCredential", () => {
	test("returns undefined for a URL the forge does not own", async () => {
		const forge = new GitHubForge({ token: "tok" });
		expect(await mintGitCredential(forge, "https://gitlab.com/x/y.git")).toBeUndefined();
	});

	test("mints the full credential for an owned URL under PAT mode", async () => {
		const forge = new GitHubForge({ token: "tok" });
		const cred = await mintGitCredential(forge, "https://github.com/x/y.git");
		expect(cred).not.toBeUndefined();
		expect(cred?.secret).toBe("tok");
	});

	test("maps no_credential (empty token) to anonymous git", async () => {
		const forge = new GitHubForge({ token: "" });
		expect(await mintGitCredential(forge, "https://github.com/x/y.git")).toBeUndefined();
	});

	test("mints the FakeForge credential for a fake URL", async () => {
		const forge = new FakeForge();
		const cred = await mintGitCredential(forge, "fake://repo");
		expect(cred).not.toBeUndefined();
		expect(cred?.secret).toBe("fake-credential");
	});

	test("throws GitCredentialMintError on a non-no_credential mint failure", async () => {
		const forge = new GitHubForge({ token: "tok" });
		forge.gitCredential = () =>
			Promise.resolve({
				ok: false,
				error: { kind: "network", detail: "boom" },
			});
		await expect(
			mintGitCredential(forge, "https://github.com/x/y.git"),
		).rejects.toBeInstanceOf(GitCredentialMintError);
	});
});
