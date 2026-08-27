/**
 * The credential source behind a forge provider (forge-contract.md §4 —
 * credentials are minted, never held).
 *
 * Extracted from `src/forge/github/token-source.ts` for the GitLab arm. The
 * interface was already provider-neutral: it says "produce one secret for one
 * call, and say when it expires", which is what every forge needs. Three
 * implementations exist:
 *
 *   - `StaticTokenSource` (here): the PAT mode, used by both GitHubForge and
 *     GitLabForge. `mint()` is a free read of the configured secret with
 *     `expiresAt: null`, so the domain skips the re-mint path
 *     (`credentialLifetime: "static"`).
 *   - `InstallationTokenSource` (`src/forge/github-app/`): the GitHub App mode.
 *     `mint()` is a cache hit or a `POST /app/installations/:id/access_tokens`
 *     re-mint, and the returned secret carries a real `expiresAt`
 *     (`credentialLifetime: "short-lived"`).
 *
 * Per §6.9 this module holds NO assumption about token shape or length. A
 * GitHub installation token is a stateless `ghs_` format observed live at 383
 * characters; a GitLab PAT is 20-plus characters of a different alphabet. The
 * secret is carried verbatim and never inspected.
 */

import type { ForgeResult } from "../contract.ts";

/** A minted bearer secret plus its expiry (epoch ms; null = no known expiry). */
export interface ForgeCredentialSecret {
	readonly secret: string;
	readonly expiresAt: number | null;
}

/** Mints (or reuses) the credential for ONE forge API call. Never throws. */
export interface ForgeTokenSource {
	mint(): Promise<ForgeResult<ForgeCredentialSecret>>;
}

/**
 * PAT/static mode: the configured secret, returned verbatim on every call.
 *
 * `forgeLabel` names the forge in the `no_credential` detail so an operator
 * reading a run row learns WHICH credential is missing. It is display text
 * only, never a routing key.
 */
export class StaticTokenSource implements ForgeTokenSource {
	private readonly token: string;
	private readonly forgeLabel: string;

	constructor(token: string, forgeLabel: string) {
		this.token = token;
		this.forgeLabel = forgeLabel;
	}

	mint(): Promise<ForgeResult<ForgeCredentialSecret>> {
		if (this.token === "") {
			return Promise.resolve({
				ok: false,
				error: {
					kind: "no_credential",
					detail: `no ${this.forgeLabel} credential configured`,
				},
			});
		}
		return Promise.resolve({ ok: true, value: { secret: this.token, expiresAt: null } });
	}
}
