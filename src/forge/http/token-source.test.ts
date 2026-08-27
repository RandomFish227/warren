import { describe, expect, test } from "bun:test";
import { StaticTokenSource } from "./token-source.ts";

describe("StaticTokenSource", () => {
	test("returns the configured secret with no known expiry (static lifetime, §4)", async () => {
		const result = await new StaticTokenSource("pat-secret", "GitHub").mint();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value).toEqual({ secret: "pat-secret", expiresAt: null });
	});

	test("an empty token reports no_credential", async () => {
		const result = await new StaticTokenSource("", "GitHub").mint();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("no_credential");
	});

	test("names the forge in the no_credential detail so the operator knows which one", async () => {
		const gitlab = await new StaticTokenSource("", "GitLab").mint();
		expect(gitlab.ok).toBe(false);
		if (!gitlab.ok) expect(gitlab.error.detail).toBe("no GitLab credential configured");
		const github = await new StaticTokenSource("", "GitHub").mint();
		expect(github.ok).toBe(false);
		if (!github.ok) expect(github.error.detail).toBe("no GitHub credential configured");
	});

	test("carries a secret verbatim regardless of shape or length (§6.9)", async () => {
		const long = `ghs_${"a".repeat(379)}`;
		const result = await new StaticTokenSource(long, "GitHub").mint();
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.secret).toBe(long);
	});
});
