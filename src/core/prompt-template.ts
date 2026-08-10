/**
 * Generic `{placeholder}` substitution for operator-authored prompts.
 *
 * A project ships named starting prompts in `.warren/config.yaml`
 * (`promptTemplates`, see `src/warren-config/schema.ts`); the NewRun form
 * offers them, asks for whatever they leave blank, and dispatches the
 * result. Nothing on the dispatch path reads a template — by the time a run
 * exists the prompt is already a plain string — so a malformed placeholder
 * is a cosmetic problem in the form, never a failed run.
 *
 * Relationship to `./plan-run-prompt.ts`: that module owns the plan-run
 * contract, where `{seed_id}` is *required* because a template without it
 * dispatches every child identically. This module owns the general syntax,
 * and `{seed_id}` renders here exactly as it does there — the same token
 * means the same thing on both surfaces, so an operator can lift a prompt
 * from one to the other.
 *
 * Lives in the dependency-free kernel because the form that renders these
 * runs in the browser. It imports nothing.
 *
 * ## Syntax
 *
 * A placeholder is `{name}` where `name` starts with a lowercase letter and
 * continues with lowercase letters, digits, or underscores. The narrowness
 * is deliberate: prompts routinely quote code and JSON, and `{}`, `{ x }`,
 * `{Foo}` and `${x}` must all survive untouched rather than being mistaken
 * for a placeholder an operator forgot to fill.
 *
 * ## Unresolved placeholders are left verbatim
 *
 * A token with no value — missing, empty, or whitespace-only — stays in the
 * output as written and is reported on `unresolved`. Substituting an empty
 * string would silently produce a prompt like "Read sd . Plan in 5 steps",
 * which reads as a complete instruction and is not obviously broken. Leaving
 * `{seed_id}` visible makes the gap self-describing, in the form and in the
 * dispatched prompt if the operator sends it anyway.
 */

/**
 * Matches one `{name}` placeholder. Global: callers rely on `matchAll` and
 * `replace`-all semantics, both of which require the `g` flag.
 *
 * The `(?<!\$)` lookbehind excludes `${name}`. Prompts routinely name shell
 * variables — `$WARREN_QUALITY_GATE`, `${HOME}` — and rewriting one into a
 * literal value would corrupt a command the agent is meant to run verbatim.
 */
const PLACEHOLDER_RE = /(?<!\$)\{([a-z][a-z0-9_]*)\}/g;

/** Outcome of rendering a template against a set of values. */
export interface RenderedPrompt {
	/** The prompt with every resolved placeholder substituted. */
	readonly prompt: string;
	/**
	 * Placeholder names still present in `prompt`, in first-appearance order
	 * and de-duplicated. Empty when everything resolved.
	 */
	readonly unresolved: readonly string[];
}

/**
 * Every distinct placeholder in `template`, in first-appearance order.
 * The form uses this to render one input per placeholder before the
 * operator has typed anything.
 */
export function listPromptPlaceholders(template: string): readonly string[] {
	const seen = new Set<string>();
	for (const match of template.matchAll(PLACEHOLDER_RE)) {
		const name = match[1];
		if (name !== undefined) seen.add(name);
	}
	return [...seen];
}

/**
 * Substitute `values` into `template`. Every occurrence of a resolved
 * placeholder is replaced — a single-replace would silently leave later
 * occurrences behind, the bug `renderPlanRunPrompt` calls out.
 */
export function renderPromptTemplate(
	template: string,
	values: Readonly<Record<string, string | undefined>>,
): RenderedPrompt {
	const unresolved: string[] = [];
	const prompt = template.replace(PLACEHOLDER_RE, (token, rawName: string) => {
		const value = values[rawName];
		if (value === undefined || value.trim() === "") {
			if (!unresolved.includes(rawName)) unresolved.push(rawName);
			return token;
		}
		return value;
	});
	return { prompt, unresolved };
}
