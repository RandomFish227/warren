import { describe, expect, test } from "bun:test";
import { jsonResponse, recordingFetch } from "../http/test-helpers.ts";
import { requestGitLab } from "./http.ts";

const NO_RETRY = { maxRetries: 0 };
const MR_URL = "https://gitlab.com/api/v4/projects/g%2Fp/merge_requests/7";

describe("requestGitLab", () => {
	test("GETs with the GitLab header set and returns the raw response", async () => {
		const { fetch, calls } = recordingFetch([jsonResponse(200, { iid: 7 })]);
		const result = await requestGitLab({
			url: MR_URL,
			token: "glpat-x",
			context: "GET /merge_requests/7",
			fetch,
			retry: NO_RETRY,
		});
		expect(result.ok).toBe(true);
		if (result.ok) expect(await result.response.json()).toEqual({ iid: 7 });
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.headers["private-token"]).toBe("glpat-x");
		expect(calls[0]?.headers.authorization).toBeUndefined();
	});

	test("serializes a JSON body for write methods", async () => {
		const { fetch, calls } = recordingFetch([jsonResponse(201, {})]);
		await requestGitLab({
			url: MR_URL,
			method: "POST",
			token: "glpat-x",
			body: { title: "t" },
			userAgent: "warren-forge-gitlab",
			context: "POST /merge_requests",
			fetch,
			retry: NO_RETRY,
		});
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.body).toBe(JSON.stringify({ title: "t" }));
		expect(calls[0]?.headers["user-agent"]).toBe("warren-forge-gitlab");
	});

	test("classifies a non-2xx response with the truncated body", async () => {
		const { fetch } = recordingFetch([new Response("x".repeat(600), { status: 404 })]);
		const result = await requestGitLab({
			url: MR_URL,
			token: "t",
			context: "GET /merge_requests/7",
			fetch,
			retry: NO_RETRY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("not_found");
			expect(result.error.message.length).toBeLessThan(540);
		}
	});

	test("a thrown fetch surfaces as a network error", async () => {
		const throwing = (() => Promise.reject(new Error("dns"))) as unknown as typeof fetch;
		const result = await requestGitLab({
			url: MR_URL,
			token: "t",
			context: "GET /x",
			fetch: throwing,
			retry: NO_RETRY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.error).toEqual({
				kind: "network",
				status: 0,
				retryAfterMs: null,
				message: "GET /x failed: dns",
			});
	});

	test("retries a transient 5xx and recovers", async () => {
		const { fetch, calls } = recordingFetch([
			jsonResponse(502, { message: "bad gateway" }),
			jsonResponse(200, { iid: 7 }),
		]);
		const result = await requestGitLab({
			url: MR_URL,
			token: "t",
			context: "GET /merge_requests/7",
			fetch,
			retry: { sleep: () => Promise.resolve() },
		});
		expect(result.ok).toBe(true);
		expect(calls).toHaveLength(2);
	});

	test("a 429 is rate_limited and honours Retry-After", async () => {
		const limited = new Response("slow down", {
			status: 429,
			headers: { "retry-after": "9" },
		});
		const { fetch } = recordingFetch([limited]);
		const result = await requestGitLab({
			url: MR_URL,
			token: "t",
			context: "GET /merge_requests/7",
			fetch,
			retry: NO_RETRY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("rate_limited");
			expect(result.error.retryAfterMs).toBe(9_000);
		}
	});

	test("a 403 stays forbidden — GitLab denial is not a disguised rate limit", async () => {
		// The GitHub hook would reclassify this as rate_limited on the strength
		// of the headers alone. GitLab must not inherit that rule: a 403 here
		// means the token lacks the scope, and retrying it would bury the
		// expired-credential signal (§4).
		const denied = new Response("insufficient scope", {
			status: 403,
			headers: { "retry-after": "30", "x-ratelimit-remaining": "0" },
		});
		const { fetch, calls } = recordingFetch([denied]);
		const result = await requestGitLab({
			url: MR_URL,
			token: "t",
			context: "GET /merge_requests/7",
			fetch,
			retry: { sleep: () => Promise.resolve() },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("forbidden");
		expect(calls).toHaveLength(1);
	});

	test("does not retry a fatal 4xx", async () => {
		const { fetch, calls } = recordingFetch([jsonResponse(409, { message: "exists" })]);
		const result = await requestGitLab({
			url: MR_URL,
			method: "POST",
			token: "t",
			context: "POST /merge_requests",
			fetch,
			retry: { sleep: () => Promise.resolve() },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("conflict");
		expect(calls).toHaveLength(1);
	});
});
