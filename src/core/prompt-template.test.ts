import { describe, expect, test } from "bun:test";
import { DEFAULT_PLAN_RUN_PROMPT_TEMPLATE } from "./plan-run-prompt.ts";
import { listPromptPlaceholders, renderPromptTemplate } from "./prompt-template.ts";

// Biome's noTemplateCurlyInString flags a literal `${` inside a plain string.
// These cases are precisely about that sequence surviving untouched, so build
// it from an escaped dollar rather than suppressing the rule.
const D = "\u0024";

describe("listPromptPlaceholders", () => {
	test("returns an empty list for a template with no placeholders", () => {
		expect(listPromptPlaceholders("just do the thing")).toEqual([]);
	});

	test("returns placeholders in first-appearance order", () => {
		expect(listPromptPlaceholders("{task} against {branch}, then {task} again")).toEqual([
			"task",
			"branch",
		]);
	});

	test("accepts digits and underscores after the first letter", () => {
		expect(listPromptPlaceholders("{seed_id} {step2}")).toEqual(["seed_id", "step2"]);
	});

	test("ignores shapes that are not placeholders so quoted code survives", () => {
		const template = 'emit {} and { spaced } and {Upper} and JSON {"k":1}';
		expect(listPromptPlaceholders(template)).toEqual([]);
	});

	test("ignores a shell expansion so a command the agent must run verbatim survives", () => {
		expect(listPromptPlaceholders(`run ${D}{WARREN_QUALITY_GATE:-bun run check:all}`)).toEqual([]);
		expect(listPromptPlaceholders(`resolve ${D}{gate} then {task}`)).toEqual(["task"]);
	});
});

describe("renderPromptTemplate", () => {
	test("substitutes a resolved placeholder", () => {
		const result = renderPromptTemplate("work on sd {seed_id}", { seed_id: "warren-1234" });
		expect(result.prompt).toBe("work on sd warren-1234");
		expect(result.unresolved).toEqual([]);
	});

	test("substitutes every occurrence, not just the first", () => {
		const result = renderPromptTemplate("{task}; when done, re-read {task}", { task: "the audit" });
		expect(result.prompt).toBe("the audit; when done, re-read the audit");
	});

	test("leaves an unfilled placeholder verbatim and reports it", () => {
		const result = renderPromptTemplate("read sd {seed_id} then run {gate}", { gate: "bun test" });
		expect(result.prompt).toBe("read sd {seed_id} then run bun test");
		expect(result.unresolved).toEqual(["seed_id"]);
	});

	test("treats an empty or whitespace-only value as unresolved", () => {
		const result = renderPromptTemplate("do {a} and {b}", { a: "", b: "   " });
		expect(result.prompt).toBe("do {a} and {b}");
		expect(result.unresolved).toEqual(["a", "b"]);
	});

	test("reports each unresolved placeholder once even when repeated", () => {
		const result = renderPromptTemplate("{task} then {task}", {});
		expect(result.unresolved).toEqual(["task"]);
	});

	test("ignores values with no matching placeholder", () => {
		const result = renderPromptTemplate("fixed prompt", { unused: "x" });
		expect(result.prompt).toBe("fixed prompt");
		expect(result.unresolved).toEqual([]);
	});

	test("does not disturb braces that are not placeholders", () => {
		const template = 'return {"ok": true} and {Upper}';
		expect(renderPromptTemplate(template, {}).prompt).toBe(template);
	});

	test("leaves a shell expansion alone even when a same-named value is supplied", () => {
		const result = renderPromptTemplate(`echo ${D}{home} then cd {home}`, { home: "/data" });
		expect(result.prompt).toBe(`echo ${D}{home} then cd /data`);
		expect(result.unresolved).toEqual([]);
	});

	test("renders the plan-run default template, so {seed_id} means the same on both surfaces", () => {
		const result = renderPromptTemplate(DEFAULT_PLAN_RUN_PROMPT_TEMPLATE, {
			seed_id: "warren-a1b2",
		});
		expect(result.prompt).toBe("work on sd warren-a1b2");
		expect(result.unresolved).toEqual([]);
	});
});
