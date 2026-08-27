import { describe, expect, test } from "bun:test";
import { classifyHttpError, networkError, parseRetryAfterMs } from "./errors.ts";

function headers(init: Record<string, string>): Headers {
	return new Headers(init);
}

describe("parseRetryAfterMs", () => {
	test("parses the delta-seconds form", () => {
		expect(parseRetryAfterMs("7")).toBe(7_000);
		expect(parseRetryAfterMs(" 3 ")).toBe(3_000);
	});

	test("rejects absent, fractional, negative, and date forms", () => {
		expect(parseRetryAfterMs(null)).toBeNull();
		expect(parseRetryAfterMs("")).toBeNull();
		expect(parseRetryAfterMs("1.5")).toBeNull();
		expect(parseRetryAfterMs("-2")).toBeNull();
		expect(parseRetryAfterMs("Wed, 21 Oct 2015 07:28:00 GMT")).toBeNull();
	});
});

describe("classifyHttpError", () => {
	test("429 is rate_limited and parses Retry-After", () => {
		const err = classifyHttpError(
			429,
			headers({ "retry-after": "12" }),
			"slow down",
			"GET /pulls/7",
		);
		expect(err).toEqual({
			kind: "rate_limited",
			status: 429,
			retryAfterMs: 12_000,
			message: "GET /pulls/7 returned 429: slow down",
		});
	});

	test("401 is unauthorized; 404/410 are not_found; 409/422 are conflict", () => {
		expect(classifyHttpError(401, headers({}), "x", "c").kind).toBe("unauthorized");
		expect(classifyHttpError(404, headers({}), "x", "c").kind).toBe("not_found");
		expect(classifyHttpError(410, headers({}), "x", "c").kind).toBe("not_found");
		expect(classifyHttpError(409, headers({}), "x", "c").kind).toBe("conflict");
		expect(classifyHttpError(422, headers({}), "x", "c").kind).toBe("conflict");
	});

	test("anything else is http_error with a null hint", () => {
		const err = classifyHttpError(500, headers({}), "boom", "GET /check-runs");
		expect(err).toEqual({
			kind: "http_error",
			status: 500,
			retryAfterMs: null,
			message: "GET /check-runs returned 500: boom",
		});
	});

	test("without the hook a 403 stays forbidden — the neutral default", () => {
		expect(classifyHttpError(403, headers({ "retry-after": "30" }), "x", "c").kind).toBe(
			"forbidden",
		);
		expect(classifyHttpError(403, headers({ "x-ratelimit-remaining": "0" }), "x", "c").kind).toBe(
			"forbidden",
		);
	});

	test("the isRateLimited hook can reclassify a non-429 status", () => {
		const isRateLimited = (status: number, h: Headers): boolean =>
			status === 403 && h.get("retry-after") !== null;
		const err = classifyHttpError(403, headers({ "retry-after": "5" }), "x", "c", {
			isRateLimited,
		});
		expect(err.kind).toBe("rate_limited");
		expect(err.retryAfterMs).toBe(5_000);
	});

	test("the hook never downgrades a real 429", () => {
		const never = (): boolean => false;
		expect(classifyHttpError(429, headers({}), "x", "c", { isRateLimited: never }).kind).toBe(
			"rate_limited",
		);
	});

	test("a hook returning a non-true value leaves the status rule intact", () => {
		const undefinedish = (): boolean => undefined as unknown as boolean;
		expect(
			classifyHttpError(403, headers({}), "x", "c", { isRateLimited: undefinedish }).kind,
		).toBe("forbidden");
	});
});

describe("networkError", () => {
	test("wraps an Error message", () => {
		const err = networkError(new Error("socket hangup"), "GET /pulls/7");
		expect(err).toEqual({
			kind: "network",
			status: 0,
			retryAfterMs: null,
			message: "GET /pulls/7 failed: socket hangup",
		});
	});

	test("stringifies non-Error throws", () => {
		expect(networkError("nope", "c").message).toBe("c failed: nope");
	});
});
