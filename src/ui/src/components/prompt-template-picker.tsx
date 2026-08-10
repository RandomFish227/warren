import { useMemo, useState } from "react";
import type { PromptTemplate } from "@/api/types.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { listPromptPlaceholders, renderPromptTemplate } from "../../../core/prompt-template.ts";

/**
 * Starting-prompt picker for the NewRun form (project `promptTemplates`).
 *
 * A project ships the prompts that encode how work is meant to be scoped in
 * it; this offers them, asks for whatever placeholders they leave open, and
 * hands the rendered string back to the form. The form still owns the prompt
 * — applying a template writes the textarea once and the operator edits
 * freely afterwards, so nothing here is a commitment.
 *
 * Renders nothing when the project declares no templates, so projects that
 * don't opt in see the form exactly as before.
 */
export interface PromptTemplatePickerProps {
	readonly templates: readonly PromptTemplate[];
	/** Applied when the operator confirms a template. */
	readonly onApply: (prompt: string, agent?: string) => void;
	/**
	 * Seed ids offered for the `{seed_id}` placeholder. Empty when the
	 * project ships no `.seeds/` queue — the field falls back to free text.
	 */
	readonly seedIds?: readonly string[];
}

export function PromptTemplatePicker({
	templates,
	onApply,
	seedIds = [],
}: PromptTemplatePickerProps) {
	const [selected, setSelected] = useState<string | null>(null);
	const [values, setValues] = useState<Record<string, string>>({});

	const active = templates.find((t) => t.name === selected) ?? null;
	const placeholders = useMemo(
		() => (active === null ? [] : listPromptPlaceholders(active.prompt)),
		[active],
	);
	const rendered = useMemo(
		() => (active === null ? null : renderPromptTemplate(active.prompt, values)),
		[active, values],
	);

	if (templates.length === 0) return null;

	function pick(name: string) {
		setSelected((current) => (current === name ? null : name));
		setValues({});
	}

	return (
		<div className="space-y-2 rounded-md border border-border p-3">
			<div className="space-y-1">
				<Label>Start from a template</Label>
				<p className="text-xs text-muted-foreground">
					Defined in this project's <code>.warren/config.yaml</code>. Applying one fills the prompt
					below; you can still edit it.
				</p>
			</div>

			<div className="flex flex-wrap gap-2">
				{templates.map((t) => (
					<Button
						key={t.name}
						type="button"
						size="sm"
						variant={t.name === selected ? "default" : "outline"}
						aria-pressed={t.name === selected}
						title={t.description ?? t.prompt}
						onClick={() => pick(t.name)}
					>
						{t.name}
					</Button>
				))}
			</div>

			{active !== null && rendered !== null && (
				<div className="space-y-2 pt-1">
					{active.description !== undefined && (
						<p className="text-xs text-muted-foreground">{active.description}</p>
					)}

					{placeholders.map((name) => (
						<div key={name} className="space-y-1">
							<Label htmlFor={`tpl-${name}`} className="text-xs">
								{name}
							</Label>
							{name === "seed_id" && seedIds.length > 0 ? (
								<select
									id={`tpl-${name}`}
									className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
									value={values[name] ?? ""}
									onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
								>
									<option value="">Select a seed…</option>
									{seedIds.map((id) => (
										<option key={id} value={id}>
											{id}
										</option>
									))}
								</select>
							) : (
								<Input
									id={`tpl-${name}`}
									value={values[name] ?? ""}
									placeholder={`value for {${name}}`}
									onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
								/>
							)}
						</div>
					))}

					<pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
						{rendered.prompt}
					</pre>

					{rendered.unresolved.length > 0 && (
						<p className="text-xs text-muted-foreground">
							Still unfilled: {rendered.unresolved.join(", ")}. These stay in the prompt as written
							so the gap is visible rather than silently blank.
						</p>
					)}

					<Button
						type="button"
						size="sm"
						onClick={() => {
							onApply(rendered.prompt, active.agent);
							setSelected(null);
							setValues({});
						}}
					>
						Use this prompt
					</Button>
				</div>
			)}
		</div>
	);
}
