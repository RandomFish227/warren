import { describe, expect, test } from "bun:test";
import { classifyHttpError } from "../http/errors.ts";
import { isGitHubRateLimited, isRateLimitedForbidden } from "./errors.ts";

function headers(init: Record<string, string>): Headers {
	return new Headers(init);
}

describe("isRateLimitedForbidden", () => {
	test("true with a Retry-After header (secondary limit)", () => {
		expect(isRateLimitedForbidden(headers({ "retry-after": "30" }))).toBe(true);
	});

	test("true with x-ratelimit-remaining: 0 (primary limit)", () => {
		expect(isRateLimitedForbidden(headers({ "x-ratelimit-remaining": "0" }))).toBe(true);
	});

	test("false for a plain 403", () => {
		expect(isRateLimitedForbidden(headers({ "x-ratelimit-remaining": "59" }))).toBe(false);
		expect(isRateLimitedForbidden(headers({}))).toBe(false);
	});
});

describe("isGitHubRateLimited", () => {
	test("claims only 403 — a 429 is already the shared rule's", () => {
		expect(isGitHubRateLimited(403, headers({ "retry-after": "30" }))).toBe(true);
		expect(isGitHubRateLimited(429, headers({ "retry-after": "30" }))).toBe(false);
	});

	test("does not claim other statuses carrying rate-limit headers", () => {
		expect(isGitHubRateLimited(500, headers({ "x-ratelimit-remaining": "0" }))).toBe(false);
		expect(isGitHubRateLimited(404, headers({ "retry-after": "1" }))).toBe(false);
	});
});

describe("the GitHub hook composed with the neutral classifier", () => {
	test("403 with rate-limit headers is rate_limited; plain 403 is forbidden", () => {
		const opts = { isRateLimited: isGitHubRateLimited };
		expect(
			classifyHttpError(403, headers({ "x-ratelimit-remaining": "0" }), "x", "c", opts).kind,
		).toBe("rate_limited");
		expect(classifyHttpError(403, headers({}), "x", "c", opts).kind).toBe("forbidden");
	});

	test("a rate-limited 403 still carries the Retry-After hint", () => {
		const err = classifyHttpError(403, headers({ "retry-after": "12" }), "slow", "GET /pulls/7", {
			isRateLimited: isGitHubRateLimited,
		});
		expect(err).toEqual({
			kind: "rate_limited",
			status: 403,
			retryAfterMs: 12_000,
			message: "GET /pulls/7 returned 403: slow",
		});
	});
});
