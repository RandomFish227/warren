# Multi-Forge Support (Forgejo, Gitea, GitLab) — Research Notes

**Status:** Research note. Two scope decisions recorded (§7 Q0, Q2);
the architecture question (§5) is still open and carries no owner go.
This document records what the existing design already decided, what it
deliberately left open, and what an audit of HEAD found. It is the
input to a plan, not the plan.

**Decisions recorded 2026-08-19, by the operator of this fork:**
- **Architecture: in-core provider, built to falsify (§5 Shape A).**
  `src/forge/forgejo/` as a new registry arm. The falsification test is
  the deliverable, not a checkbox — it is the evidence that answers the
  upstream refusal.
- **Instance configuration: a config file for shape, env for secrets
  (§7 Q3, now §2a).** Non-secret instance metadata in a `forges:`
  block; every credential resolved from a named env var. This honors
  the standing precedent that warren never stores a forge credential
  (`src/forge/github-app/registration.ts:28` — "Nothing here persists:
  the converted credentials exist only in the rendered page for the
  operator to copy into their secret store").
- **Target: upstreamable.** Work lands in `RandomFish227/warren` but is
  shaped so `jayminwest/warren` could accept it.

  **AMENDED 2026-08-19, later the same day: the refusal is lifted.**
  The upstream owner reached out unprompted, named the forge seam
  first, and offered to help land a second forge upstream rather than
  have this fork carry it alone. So §0's "refused for now" is now
  historical context, not a constraint to overcome, and §5's Shape A
  choice is no longer a bet against upstream taste — it is the shape
  upstream is offering to review.

  Two things change, and neither is a licence to skip the rigor. The
  falsification test (§8 step 6) stays the centrepiece, because it is
  what proves the seam holds rather than merely what persuades a
  reviewer. And §7 Q1 (in-core vs bridge) is now a question to ask
  upstream directly instead of inferring from `ROADMAP.md:136` — the
  owner is available, and a design record is a poor substitute for
  asking the person who wrote it.
- **Multi-forge is in scope from the start.** One instance hosts
  GitHub, Forgejo, GitLab, and others at once. **The user selects the
  host when the project is created.** This is a harder requirement than
  §2's first draft assumed, and §2 is rewritten around it.
**Date:** 2026-08-19.
**Grounded in:** a read of `docs/design/forge-contract.md` (the shipped
spike), `docs/design/2026-07-29-planning-session-record.md`,
`ROADMAP.md`, `docs/design/extensions.md`, and a leak audit of `src/`
at HEAD. API claims about Forgejo and GitLab are marked UNVERIFIED
where no spike has run.
**Companion:** [`forge-contract.md`](./forge-contract.md) §0, §1.1, §3, §5.
**Tracker:** warren-9b6b (umbrella). This document, not the seed, is the
spec — the seed carries a summary and the scope decisions.

---

## 0. What the existing design already decided

Three findings matter before anyone writes a provider. All three are
quotations from shipped documents, not inference.

**A second vendor forge was refused, not forgotten.** The planning
record lists it as a resolved question:

> 5. Gitea/GitLab demand — refused for now (capability-minimal Forge).
> — `docs/design/2026-07-29-planning-session-record.md:252`

The same record fixes the contract's direction as
"capability-minimal (repo refs, git auth, PR open/find, checks, error
taxonomy), **FakeForge as implementation #2**, no `mergePr`, **no
GitLab-shaped generality**" (line 117). The refusal is a scope
decision, not a technical objection. It removes speculative generality;
it does not forbid a real provider once someone needs one.

**Whether a forge arrives in-core or through a bridge is parked.**
This is the one open architectural question, and both documents that
touch it decline to answer:

> **One thing this document does not decide.** Whether forges
> eventually follow trackers through the bridge stays parked.
> — `forge-contract.md:626`

> - **Forge extensions** — the same bridge logic applied to forges cuts
>   deeper (PR-opening sits directly behind the kernel's push); parked.
>   — `extensions.md` §5

`ROADMAP.md:136` says the same from the tracker side: the
`warren-tracker/v1` bridge decision explicitly does not extend to
forges.

**The contract was built as the attachment point for exactly this.**
`forge-contract.md:334` states the reason `gitCredential` and
`openPullRequest` sit behind one seam: "Keeping the two together gives
a future bridge one attachment point instead of two."

**No tracker or expertise record proposes a second forge.** A sweep of
`.seeds/issues.jsonl` and `.mulch/` (60 expertise records, including a
dedicated `forge` domain) for `gitlab|gitea|forgejo|codeberg|bitbucket`
returns exactly one hit, and it is unrelated: warren-9bbc added GitLab
*token shapes* to the secret scrubber. The three quotations above are
therefore the complete recorded *intent*, and this section's inference
rests on them alone.

`.mulch/expertise/forge.jsonl` does carry a great deal about *how* to
build a provider, which §4a collects. Recorded intent and recorded
practice are different things, and only the former is silent here.

So the creator's intent reads: the seam is ready, the vendor is not
chosen, and the in-core-vs-bridge call is the first thing a plan must
settle.

---

## 1. What the contract already gives us

The `Forge` interface (`src/forge/contract.ts`) is genuinely
vendor-neutral. It carries no GitHub noun. Ten methods, all of which
map onto a Forgejo or GitLab concept:

| Method | Forgejo / Gitea | GitLab |
| --- | --- | --- |
| `parseRepoRef` | host + owner/repo | host + project path or id |
| `gitCredential` | token over https | token over https |
| `openPullRequest` | pull request | merge request |
| `findPullRequest` | list PRs by head/base | list MRs by source/target |
| `getPullRequest` | PR state + merged | MR state + merged |
| `setPullRequestBody` | PATCH PR body | PUT MR description |
| `listChecks` | commit statuses | pipelines + jobs |
| `fetchJobLogTail` | Actions task logs | job trace |
| `deleteBranch` | delete ref | delete branch |
| `botIdentity` | token owner | token owner |

Four design choices carry the neutrality, and each is load-bearing for
a second forge:

- **`RepoRef` and `PullRequestRef` are opaque.** `RepoRef` carries only
  `{ forge, key }`, and the doc block says "NOTHING outside the
  provider destructures a `RepoRef`". A GitLab project id and a
  Forgejo owner/repo pair both fit `key` with no domain change.
- **`RepoRef.forge` already names its registry key.** A ref knows which
  forge owns it. Routing needs no new field.
- **Capabilities are flags with stated fallbacks (§5).** The domain
  branches on `checkRuns`, `jobLogs`, `pullRequestBodyEdit`,
  `branchDelete`, `botIdentity`, and `credentialLifetime` rather than
  on a vendor name. This is exactly the machinery a forge with a
  weaker CI API needs.
- **No `mergePullRequest`, on purpose.** `contract.ts:180` — warren
  observes a merge, it never performs one. Verified against HEAD: the
  plan-run merge gate only polls `getPullRequest`
  (`src/plan-runs/merge-gate.ts:96`), and no core code enables
  auto-merge. The merge mechanism is the target repo's business.
  Forgejo and GitLab both ship one, so nothing is owed here.

The `ForgeError` taxonomy and the `ForgeResult<T>` convention (§2.2)
are likewise vendor-free. A new provider classifies its own transport
errors into the same `ForgeErrorKind` set.

**Assessment:** the `Forge` *interface* needs no widening to admit
Forgejo. That is a strong result and it bounds the work.

Read it precisely, though. It covers the interface, not the registry,
and §4b proposes one deliberate addition (a host-validation method).
Per-instance base URLs and credentials have no home in the contract and
should not get one — they are registry configuration, and §7 Q3 names
that as the biggest undecided question. "The contract is ready" and
"the configuration story is unresolved" are both true.

---

## 2. Multi-forge routing: why URL sniffing cannot deliver it

The contract is neutral. The *registry* is not yet plural, and the
operator's requirement — pick the host at project-creation time —
rules out the routing mechanism the original design sketched.

**Where HEAD stands.** `WARREN_FORGE` selects one kind at boot
(`src/forge/registry.ts:105-141`), the arms are `github | app | fake`,
and `src/server/main/index.ts:179` resolves a single instance that
`ServerDeps.forge` carries everywhere. `POST /projects` accepts only
`gitUrl` (`src/server/handlers/projects.ts:110`) and reaches for
`deps.forge` at four sites in that handler alone. There is no `forge`
column on `projects` (`src/db/schema/sqlite.ts:77-96`). An instance
hosts GitHub projects **or** FakeForge projects, never both.

**The design's answer, and why it is not enough.** §1.1 of the contract
anticipated the plural case:

> **`parseRepoRef` chaining operates over the boot-registered forges in
> their fixed registration order**, and only there. It is how the
> registry routes a clone URL to the forge that owns it.
> — `forge-contract.md:139`

That is discovery by URL grammar. It works for the forges that exist
today because each owns a distinctive grammar: `github.com` is a known
constant host, and FakeForge owns the `fake://` scheme.

**It breaks the moment forges are self-hosted, which is the whole point
of Forgejo.** A clone URL of `https://git.example.com/owner/repo` is a
valid Forgejo URL, a valid Gitea URL, and a valid GitLab URL. Nothing
in the string distinguishes them. Grammar-based ownership can only
guess, and a wrong guess sends the wrong API calls with the wrong
credential to a real server. Probing the host to identify the software
would be discovery-by-side-effect, which §1.1 explicitly rules out
("not a runtime discovery mechanism").

So the operator's requirement is not a UX preference layered over the
design. It is the correctness fix for a routing mechanism that cannot
work for self-hosted forges. **Explicit selection at creation, then
persist it.**

**Consequence 1 — a schema change is required.** The first draft of
these notes concluded no schema change was needed. That conclusion was
built on URL re-derivation and does not survive the requirement.
`projects` gains a forge discriminator, `POST /projects` gains the
field, and the UI gains a picker.

**Consequence 2 — forge *instances*, not just forge *kinds*.** Two
self-hosted Forgejo servers are two different forges with different
base URLs and different credentials, both of kind `forgejo`. So the
registry key must identify an instance, and per-forge configuration
(base URL, credential, capabilities) must live somewhere richer than a
single `WARREN_FORGE` env var. This is the largest single design
question the plan must answer, and it is not a question the existing
documents anticipated.

**The contract absorbs both consequences without a change, which is the
good news.** `RepoRef.forge` is typed `string` and documented as
"registry key" (`src/forge/contract.ts:38-39`), not as a union of
vendor names. An instance id fits it exactly. `PullRequestRef.forge`
(line 49) is the same. Nothing in `Forge` assumes one instance per
process.

**What `parseRepoRef` becomes.** Not discovery — validation. Once the
user has named the forge, `parseRepoRef` answers "does this forge
accept this URL?" and still returns `null` when it does not. That keeps
the method, its contract, and every existing caller honest, and it
keeps the reconstruction path below working.

**But it cannot answer that question today, and this is a real
correction.** `parseGitHubRepoRef` (`src/forge/github/repo-ref.ts:31`)
is a **pure function of the URL**. It closes over no configuration: the
host is the `github.com` literal baked into five grammars, the key is
the template `` `github.com/${owner}/${repo}` ``, and the ref's `forge`
field is the module constant `GITHUB_FORGE_KIND = "github"`. FakeForge
and GitHubApp follow the same shape.

For a host-constant forge that is correct. For self-hosted forges it
fails at exactly the point this section relies on: two Forgejo
instances at `git.a.example` and `git.b.example` would each return
non-null for the other's URLs, because a pure grammar has nothing to
discriminate on. "Validation, not discovery" collapses back into
guessing.

So a provider instance must **close over its configured base URL**, and
`RepoRef.forge` must carry the **instance id** rather than the kind.
The contract already permits this — the field is typed `string` and
documented "registry key" — but every existing provider hardcodes its
kind there, so this is a concrete per-provider change and it belongs in
§8 step 4 rather than in the Forgejo provider. It is also the strongest
argument that instance configuration (§7 Q3) must be settled first:
`parseRepoRef` is a contract method that cannot be written correctly
until an instance knows its own base URL.

**Persistence of PR refs does *not* need a discriminator, and this was
checked.** The `runs` table stores `pr_url`, `pr_state`, and
`pr_merged_at` (`src/db/schema/sqlite.ts:160,248,249`) with no forge
column and no stored PR key. `resolvePollTarget` in
`src/runs/pr-merge.ts:117` rebuilds a `PullRequestRef` by asking
`forge.parseRepoRef(prUrl)` for ownership and reading the number off
the URL's trailing numeric segment. The comment at line 86 states the
rule: the regex "is deliberately NOT a host grammar". That
trailing-number grammar already fits GitHub's `/pull/123`, Forgejo's
`/pulls/123`, and GitLab's `/-/merge_requests/123`. Once a run's
project resolves to a forge instance, the ref rebuilds from the stored
URL with no extra column. The routing change is therefore
**project-scoped**, and does not propagate into run state.

---

## 2a. Forge-instance configuration (decided)

**The shape.** A `forges` list, one entry per instance. `id` is the
registry key that lands in `RepoRef.forge`. `tokenEnv` names the
variable holding the credential; the credential itself never appears in
the file.

```yaml
forges:
  - id: gh
    kind: github
    tokenEnv: GITHUB_TOKEN
  - id: work
    kind: forgejo
    baseUrl: https://git.corp.example/
    tokenEnv: WORK_FORGEJO_TOKEN
  - id: personal
    kind: forgejo
    baseUrl: https://git.me.example/
    tokenEnv: PERSONAL_FORGEJO_TOKEN
```

**This introduces warren's first server-level config file, and the plan
must own that.** `src/warren-config/` is entirely per-project: it loads
`.warren/config.yaml` from a project clone
(`src/diagnostics/checks-config.ts:100` passes a `projectPath`). Server
configuration today is env vars only. A reviewer will ask why env was
not enough, and the answer must be on the record: an instance list with
per-entry base URLs and capability overrides is a nested, ordered
structure, and indexed env keys express that badly. The `forges:`
schema should reuse the zod conventions in
`src/warren-config/schema.ts` rather than inventing a second style.

**Backward compatibility is the upstream-acceptability lever, and it is
cheap here.** With no config file present, `WARREN_FORGE` plus
`GITHUB_TOKEN` must keep working exactly as today, resolving to a
single-entry registry. The file is the opt-in for plural. That way the
change is additive for every existing deployment, and the diff a
reviewer reads is "a new optional surface", not "a migration".

**Two things the schema must carry beyond the sketch.**

- **`baseUrl` is required for self-hosted kinds and forbidden for
  `github`.** It is also what `parseRepoRef` closes over (§2) and what
  the §4b identity probe targets, so it is load-bearing twice over. The
  subpath caveat means it is a full base URL, not a host.
- **A missing `tokenEnv` variable must fail loudly at boot**, in the
  style of `UnknownForgeError` (`forge-contract.md` §1.1: unknown
  selections fail loudly, no silent fallback). A forge that resolves
  with an absent credential would surface later as an unauthorized
  error on a real run, which is exactly the deferred-failure shape §4
  of the contract argues against.

**Open sub-question the plan must still answer.** Whether `id` values
are free-form strings or constrained. They land in `RepoRef.forge`,
they will appear in logs and on persisted rows, and §2 makes them the
routing key — so they want the same path-safety discipline
`src/forge/github/repo-ref.ts` applies to owner and repo segments.

---

## 3. Leak audit — what is NOT behind the seam

`check:layers` enforces two rules
(`scripts/layer-rules.json`): `github-api-literal-is-forge-only`
forbids the `api.github.com` literal outside `src/forge/`, and
`forge-transport-is-forge-only` forbids importing
`src/forge/github/` or octokit packages. Both hold.

But the rules match `api.github.com`, not `github.com`. A sweep for the
bare host found the true production leak surface. It is small, which is
good news, and it is real, which the plan must fund.

**Leak 1 — `src/workspace/git/credential-env.ts:38` (the significant
one).**

```ts
GIT_CONFIG_KEY_0: `url.https://x-access-token:${token}@github.com/.insteadOf`,
GIT_CONFIG_VALUE_0: "https://github.com/",
```

This builds the git credential env for every host-side git spawn
(clone, fetch, push) and hardcodes both the host and GitHub's
`x-access-token` username. `forge-contract.md` §0 names
`x-access-token` as one of the six things the domain must never leak.
It leaks here. The module even documents itself as "Harmless on
non-github.com remotes (prefix never matches)" — which is exactly the
failure mode for a Forgejo remote: silent no-auth, then git's
interactive username prompt.

The fix is contract-shaped and already available: `GitCredential`
carries a provider-chosen `username`
(`contract.ts:61` — "`username` is provider-chosen: GitHub Apps use
`x-access-token`, and no domain code ever names that string"). The
helper should take a `GitCredential` plus the remote host and render
the rewrite from those. This is a prerequisite for any second forge,
and it is worth doing on its own merit as a seam-integrity fix.

Call sites threading a raw token today: `src/projects/clone.ts:165`,
`src/projects/refresh.ts`, `src/projects/manage.ts`,
`src/plan-runs/dispatch.ts`, `src/runs/retry/infra-lost-retry.ts`,
`src/triggers/project-heal.ts`, plus the K8s token path
(`src/runtime/k8s/git-tokens.ts:75`, which falls back to
`GITHUB_TOKEN`).

**Leak 2 — `src/projects/url.ts:71`.** `parseGitHubUrl` hard-rejects
any host other than `github.com`. A forge-owned fallback already exists
beside it (`parseForgeOwnedUrl`, warren-2600, line 98) and routes
through `forge.parseRepoRef`, so the registration boundary is
half-migrated. The fallback only consults the single boot forge, so it
becomes the natural seam for the router in §2.

**Leak 3 — `src/projects/public-allowlist.ts:186`.** The public-mode
org allowlist reconstructs `https://github.com/${entry}` and parses it
as a GitHub URL. Org semantics are per-forge; this needs a decision for
multi-forge public instances.

**Leak 4 — two process-global forge-kind gates (surfaced by the
multi-forge decision).** Both ask a whole-instance question that has no
correct answer once forges are plural:

- `src/server/github-app-gate.ts:86` — `if (resolveForgeKind(env) === "app")`
- `src/server/main/forge-heartbeat-wiring.ts:46` — `if (resolveForgeKind(env) !== "app") return undefined`

In an instance serving one GitHub App forge plus two Forgejo PAT
forges, "is the forge an App?" is neither true nor false. The
App-registration endpoints and the credential heartbeat both become
per-instance concerns. `check:layers` cannot see this class of problem,
which is what it shares with Leak 1: a global assumption, not a
forbidden literal.

**Disposition, so it constrains the plan rather than sitting on a
list.** Make the heartbeat per-instance — it loops over registered
forges and probes each whose `credentialLifetime` is `short-lived`,
which is the capability-flag style the contract already mandates and
which needs no new vocabulary. Keep the App *registration* gate
instance-scoped instead: the `/github-app/*` pages register one GitHub
App, so they should be reachable when at least one registered forge is
of kind `app`, and should name which. That split keeps the
`credentialLifetime` flag as the only thing the runtime branches on,
and confines vendor knowledge to the registration UI, where
`mx-a5f213` already constrains the page policy.

**Not leaks, correctly GitHub-specific.**
`src/server/handlers/github-app.ts` (App registration UI and its CSP
`form-action https://github.com`) and `src/diagnostics/checks.ts:78`
(a hint string naming a noreply address). GitHub App mode is a GitHub
credential mechanism by definition, per the 2026-08-03 decision in
`ROADMAP.md:135`. A Forgejo provider is a peer of `github`, not of
`app`.

---

## 4. Capability mapping — where Forgejo and GitLab will bend

The contract absorbs vendor difference through `ForgeCapabilities`.
These are the cells to fill. **Every claim below is UNVERIFIED and
needs a spike (§6).**

| Capability | Forgejo / Gitea | GitLab | Risk |
| --- | --- | --- | --- |
| `checkRuns` | commit statuses, not a Checks API | pipelines + jobs | The shape differs most here |
| `jobLogs` | Actions task logs | job trace endpoint | Medium |
| `pullRequestBodyEdit` | expected yes | expected yes | Low |
| `branchDelete` | expected yes | expected yes | Low |
| `botIdentity` | token owner lookup | token owner lookup | Low |
| `credentialLifetime` | `static` (PAT) | `static` (PAT) | Low |

`listChecks` is the method to design against first, exactly as it was
for GitHub. §5 of the contract records that a fine-grained GitHub PAT
cannot reach the Checks API at all, and that this asymmetry is "the
strongest argument in the whole design for the capability-flag house
style". A forge whose CI reports as commit statuses rather than check
runs is the same class of problem, and the same flag absorbs it. The
declared fallback is already written: the CI-fixer poller stays idle
and logs one notice per project.

`credentialLifetime: "static"` means a Forgejo provider skips the §4
re-mint path entirely. That removes the hardest part of the GitHub App
work (§4.1, the run that outlives its token). A first Forgejo provider
is materially simpler than `GitHubApp` was.

---

## 4a. Implementation constraints already recorded in mulch

`.mulch/expertise/forge.jsonl` is the campaign's practice record. These
are binding on a new provider, and none of them appear in the design
doc. Each is cheaper to read now than to rediscover.

- **`parseRepoRef` must round-trip the forge's own PR web URLs**
  (mx-9cf91f). The merge gate rebuilds a `PullRequestRef` from a stored
  `webUrl`, so a provider that cannot re-own its own PR links breaks the
  gate. GitHubForge handles `/pull/<n>`; FakeForge strips `/pulls/<n>`.
  ForgejoForge must handle `/pulls/<n>`, GitLab `/-/merge_requests/<n>`.
  This is a contract obligation that the interface signature does not
  express, and it is the single most likely thing a new provider gets
  wrong.
- **Transport retry direction is settled: transient is
  network/5xx/429, and every other 4xx is fatal** (mx-90f27c,
  mx-3aab77). The rationale is not generic politeness — retrying a 401
  or 403 inside transport hides the expired-credential signal that
  forge-contract §4 exists to surface. A new provider copies this
  direction rather than inventing one.
- **Capability flags gate *before* any forge call** (mx-0aebaa). The
  poller stays idle rather than calling and handling a failure, and the
  once-per-project notice is rate-limited through the
  `ProjectHealTracker` notice-gate.
- **New credential-carrying field names must be added to
  `SECRET_FIELDS` in `src/observability/log-redact.ts`** (mx-06bd81).
  Per-instance forge credentials will add such fields, so this is on
  the router's critical path, not the provider's.
- **Provider tests use FakeForge plus `Object.defineProperty` to flip
  readonly capability flags, and reap tests use the
  `fakeForge()` / `stubForge()` helpers in
  `src/runs/reap/test-helpers.ts` — never hand-rolled fetch mocks**
  (mx-0aebaa, mx-195e69). The same record notes both inline-reap cancel
  sites route through `cancelRunWiring`, so binding a forge there
  migrates both at once.
- **Transport shape to mirror** (mx-37f192, mx-230461): a request
  helper taking a user agent and a context label, a `retry?` options
  passthrough so tests inject `sleep: async () => {}`, and
  `recordingFetch` / `jsonResponse` test helpers. Note `jsonResponse`
  takes `(status, body)` — the opposite order from several legacy
  copies.
- **Boot wiring goes in extracted modules, and the budget is never
  raised** (mx-7f711e). Verified at HEAD, with the number corrected:
  the record says `src/server/main/index.ts` sat at 500/500
  `check:size` lines when it was written in August; today it is
  **486/500**, as are `src/forge/github/provider.ts` and
  `src/forge/github-app/registration.ts`. Fourteen lines of headroom is
  not enough for router wiring, so §8 step 4 must land its wiring in a
  new module.

Two process records worth carrying into execution, if any of this work
is dispatched to warren agents rather than written by hand:

- **Name the design-doc section as the spec, not the seed** (mx-9cc840,
  mx-928a02). pl-d1c9's children carried stub descriptions, and the
  runs that went well were the ones whose prompts cited exact sections.
  Narrow the tracker issue *before* dispatch so `sd show <id>` reads
  the same scope the prompt states.
- **A wrong citation propagates by imitation** (mx-74fdd4). Agents copy
  the spelling of neighbouring comments. Any section reference this
  document introduces will be copied verbatim into code comments, so
  the §-numbers here need to stay stable once code cites them.

---

## 4b. Forge identity validation — verify the selection, never infer it

The operator's requirement is explicit selection plus automatic
validation: the user names the forge, and warren proves the host is
what they said. This is strictly better than the grammar-based
discovery §2 rejects, because a probe that *confirms* a stated answer
can fail loudly, while a probe that *guesses* one silently picks wrong.

**Every candidate forge is identifiable, and the probes were run.**
Measured 2026-08-19 against live public instances with `curl`, not
taken from documentation. Following the `warren-bc4c` precedent, each
row carries its observed evidence.

| Forge | Probe | Observed |
| --- | --- | --- |
| Forgejo | `GET /api/forgejo/v1/version` | codeberg.org → **200** `{"version":"16.0.0-dev-694-33ae492b+gitea-1.22.0"}` |
| Gitea | `GET /api/v1/version` **and** `/api/forgejo/v1/version` | gitea.com → **200** `{"version":"1.27.0+dev-836-g5f846d7aa5"}` and **404** `Not found.` |
| GitLab | `GET /api/v4/version` | gitlab.com → **401**, with header `x-gitlab-meta: {"correlation_id":…,"version":"1"}` |
| GitHub | `GET /meta` (or `/api/v3/meta` for Enterprise) | api.github.com → **200**, headers `x-github-request-id`, `x-github-media-type: github.v3; format=json` |

Four findings make this a solid design rather than a heuristic pile.

- **Forgejo ships a purpose-built discriminator.** `/api/forgejo/v1/version`
  exists precisely so tools can tell Forgejo from Gitea, and Gitea
  returns 404 on it. That is the one distinction that grammar could
  never make, and it is the exact pair the operator wants to run side
  by side. Confirmed on both sides, not just the positive case.
- **GitLab identifies itself without a credential.** The
  `x-gitlab-meta` response header rides even a 401. So a GitLab probe
  separates "wrong forge type" from "bad credential" — two failures
  that would otherwise look identical.
- **Negative probes are as clean as positive ones.** Codeberg returns
  404 on `/api/v4/version`; gitea.com returns 404 on the Forgejo path.
  Validation can assert both "the selected forge answers" and "the
  others do not", which turns a guess into a proof.
- **No credential is needed for identity.** All four probes above ran
  unauthenticated. That matters for the registration UX: the picker can
  validate the host before the operator has pasted a token.

**The design this points at — two checks, at two different times.**
Conflating them is the easy mistake, because both feel like
"validation".

1. **Identity, at forge-instance registration.** "Is the software at
   this base URL really Forgejo?" The probes above answer this, and
   they run against a configured base URL — which, per the subpath
   caveat below, is operator-supplied config and not something derived
   from a clone URL. So this check belongs on the instance-registration
   surface from §7 Q3, and it runs **once per forge instance**, not
   once per project. In work-list terms it ships with step 1, not
   step 4.
2. **Ownership and reach, at project creation.** "Does the selected
   instance own this clone URL, and can its credential see the repo?"
   That is `parseRepoRef` non-null plus one authenticated read. It is
   much cheaper than a software-identity probe, and it is what
   `POST /projects` actually needs.

Make the identity probe a contract method so each provider owns its own
probe and FakeForge satisfies it by owning `fake://`.

**Justify the widening by invariant, not convenience.** This is the
only addition to the `Forge` interface these notes propose, and §1's
"the contract needs no widening" is the strongest single argument in
the upstream case, so the framing has to hold up. The invariant
argument is the one that survives review: §0 forbids the domain
learning which software a host runs, and a validation probe is exactly
such knowledge, so it must live behind the seam. A hook added because
the registration form wanted one does not survive the same review.

**Run the probe authenticated once a credential exists.** Warren holds
one at registration, and an authenticated probe validates the forge
type *and* the credential *and* the reachability in a single call.
GitLab's `/api/v4/version` returns the version rather than a 401 once
authenticated, so the same request does double duty.

**Three caveats the plan must carry.**

- **Sign-in-required instances.** Gitea and Forgejo can be configured
  to require authentication for all views, which would turn an
  unauthenticated probe into a 401 or a redirect. The authenticated
  probe is therefore the primary path, and the unauthenticated one is a
  pre-credential convenience, not the contract.
- **Subpath installs.** A forge served at `https://example.com/git/`
  puts its API at `https://example.com/git/api/v1/…`. Deriving the API
  base from a clone URL is not always "scheme plus host", so the base
  URL belongs in per-instance configuration (§7 Q3) rather than being
  inferred.
- **A version string is not an authorization check.** Identity says
  which software answers. It says nothing about whether the credential
  can open a PR on the target repo. Keep them separate and report them
  separately.

**This adds a capability question, not a contract break.** Validation
is a new method on the seam, so it widens the `Forge` interface — the
first widening these notes propose. Weigh it in §5: it is small, every
provider can implement it, and FakeForge satisfies it trivially by
owning its `fake://` scheme.

---

## 5. The two candidate shapes

The parked question from §0, with the evidence for each side.

**Shape A — in-core provider.** `src/forge/forgejo/`, a new
`FORGE_KINDS` arm, mirroring `src/forge/github/`.

- For: the contract exists and needs no change. The registry pattern is
  established. The `github` tree (486-line provider plus a decomposed
  transport core) is a working template. Fastest path to a testable
  result. The user can test Forgejo and GitLab directly, so the
  falsification evidence is available.
- Against: `ROADMAP.md:100` establishes the house instinct for
  *trackers* — "Every tracker after Seeds arrives as an external
  container" — and `extensions.md` §5 says the bridge logic "cuts
  deeper" for forges. Each in-core vendor is a permanent maintenance
  commitment against someone else's API.

**Shape B — a `RemoteForge` bridge.** A `warren-forge/v1` wire
protocol to an out-of-process container, mirroring `RemoteTracker`.

- For: consistent with the tracker decision. Vendors ship without a
  core commit. Credentials stay in the extension; warren never stores a
  Forgejo token.
- Against: the bridge does not exist yet, and the tracker one is still
  unbuilt — `warren-53ea` (the `warren-tracker/v1` conformance suite
  and `FakeTracker` reference server) is **open and blocked** at P1. A
  wire protocol is "a far heavier promise than a TypeScript interface"
  (`extensions.md` §5), and `forge-contract.md:328` notes PR-opening
  sits directly behind the kernel's push, so the bridge cuts across the
  kernel guarantee. Building the forge bridge before the tracker bridge
  has proven itself inverts the established sequencing.

**DECIDED 2026-08-19: Shape A.** The reasoning that carried it, which
is also the argument to put upstream. Shape A for Forgejo, deliberately framed as the second real
implementation whose job is to falsify the contract. The parked
question stays parked until a real provider has stressed the seam,
which is the only thing that can tell us what a bridge would have to
carry. `FakeForge` proved the seam holds against a fake; a real foreign
vendor is a much stronger test, and it is the evidence a bridge
decision needs. This also matches PHILOSOPHY rule 4's insistence on
proof over assertion.

**The multi-forge decision (§2) adds a new argument for Shape A that
neither existing document considered.** Under Shape B, a forge instance
is a container. An operator running GitHub plus two self-hosted Forgejo
servers runs three sidecar containers, each holding a credential, each
a failure domain, each needing its own health story — to serve a
control plane whose entire pitch is "one container, one volume, one
HTTP API, one UI" (`AGENTS.md`). Per-instance multiplication is the
cost the tracker bridge never had to pay, because an instance runs one
tracker. It runs many forges.

Note the precedent still cuts both ways and upstream should be asked
directly: the tracker decision (`ROADMAP.md:136`) is recent, explicit,
and points at containers.

---

## 6. Recommended next step: an empirical spike

The repo has a precedent for exactly this situation, and it is the
strongest procedural finding in these notes. Before the GitHub App
phase shipped, seed `warren-bc4c` ran a spike against the live API to
answer four questions the docs did not, and the answers were folded
back into the design with their observed evidence
(`forge-contract.md:583-615`). Q1 through Q4 each carry the response
that was actually seen.

A Forgejo spike should answer, against a live instance:

1. Does a Forgejo PAT reach PR create, PR list-by-head-and-base, PR
   patch-body, and branch delete? Which scopes are required?
2. What does Forgejo report for CI — commit statuses, an Actions API,
   or both? Does it expose a per-job log endpoint? This sets
   `checkRuns` and `jobLogs`.
3. Is PR creation idempotent-resolvable? The contract requires that a
   duplicate resolve to the existing PR rather than surface a conflict
   (`contract.ts:201`). What does Forgejo return on a duplicate?
4. Can the token owner be read for `botIdentity`, and does Forgejo
   accept `insteadOf`-style https credential injection the same way
   (this validates the Leak 1 fix)?

0. Confirm the §4b probes against the operator's *own* Forgejo, not
   just Codeberg: does `/api/forgejo/v1/version` answer, and does it
   still answer when the instance requires sign-in? This is the one
   §4b caveat that public instances cannot test.
5. What exactly is the PR web URL shape, and does it round-trip
   through `parseRepoRef`? Per mx-9cf91f (§4a) this is a hard contract
   obligation and the most likely thing a new provider gets wrong.
   Capture a real URL from a real PR rather than assuming `/pulls/<n>`.

Answer the same five for GitLab, where MR-vs-PR vocabulary,
project-id-vs-path, and the `/-/merge_requests/<n>` URL infix are the
extra unknowns.

---

## 7. Questions — two answered, the rest open

**0. Does this land upstream, or in this fork? — ANSWERED:
upstreamable.** Work lands in `RandomFish227/warren`, shaped so
`jayminwest/warren` could accept it. `origin` is the fork; the homepage
constant at `src/server/handlers/github-app.ts:58` names upstream.
Consequence: the refusal at `planning-session-record:252` is a live
constraint. It was justified as "capability-minimal" — a refusal of
*speculative generality*. The counter-argument is not "we want GitLab";
it is a working provider plus a passing falsification test, which is
evidence the refusal was scoped to speculation and not to a real payer.
That makes §8 step 5 the deliverable that earns the upstream
conversation, and it should be treated as the point of the campaign
rather than as a final checkbox.

**2. One forge per instance, or many? — ANSWERED: many, with explicit
selection.** One instance hosts GitHub, Forgejo, GitLab, and others
simultaneously. The user picks the host at project-creation time. §2 is
rewritten around this, and it makes the router a first-class part of
the work rather than an optional step.

Still open:

**1. In-core provider or bridge? — ANSWERED: in-core (§5 Shape A).**
Built to falsify. The bridge stays parked, and warren-53ea (the
tracker-bridge conformance suite) remains its blocker if it ever
returns.

**3. How are forge instances configured? — ANSWERED: config file for
shape, env for secrets (§2a).** One open sub-question survives there:
whether instance `id` values are constrained.

**4. Where do per-forge credentials live? — ANSWERED: env, named by
`tokenEnv`.** Warren stores no forge credential, per
`registration.ts:28`. A public-mode instance must still not leak one
forge's token into another forge's request path, and that stays a
review item for §8 step 4.

Still open:

5. **Does the plan-run and seeds machinery hold?** The plan-run
   coordinator gates on PR merge and closes child seeds. The merge gate
   reads forge-neutral (`src/plan-runs/merge-gate.ts:96`), but the full
   path needs an audit before a Forgejo plan-run is promised.
6. **Public-mode org allowlist under multi-forge?** Leak 3 in §3. Org
   semantics differ per forge.
7. **Does `forgejo` want an `app`-style peer?** Forgejo has no
   GitHub-App equivalent, so PAT is the only mode and
   `credentialLifetime` is `static` forever. Confirm that is acceptable
   rather than a gap to fill later.

---

## 8. Bounded work list

Ordered, each item independently reviewable. Revised for the
multi-forge decision: the router is no longer optional, and the
configuration question gates the provider work.

1. **Settle forge-instance configuration (§7 Q3).** How an operator
   declares two Forgejo servers plus GitHub, and where each credential
   lives. Everything below depends on the answer, so it comes first —
   and §2 sharpens why: `parseRepoRef` cannot be written correctly for
   a self-hosted forge until an instance knows its own base URL. The
   §4b identity probe ships with this surface, because it validates a
   configured base URL at registration time.
2. **Seam fix, no new forge.** Make
   `src/workspace/git/credential-env.ts` take a `GitCredential` and a
   host instead of hardcoding `github.com` and `x-access-token`.
   Tighten the `check:layers` pattern from `api\.github\.com` to catch
   the bare host outside `src/forge/`.

   Justify this as an **invariant fix, not a multi-forge fix**. No test
   fails today and FakeForge's `fake://` URLs never exercise an
   authenticated non-GitHub remote, so a multi-forge argument here is
   the speculative generality that `planning-session-record:117`
   refused. The argument that survives review is §0's: the domain must
   never leak `x-access-token`, and line 38 leaks it.
3. **Spike (§6).** Answer the four questions against a live Forgejo,
   which the operator can run. Amend §4's capability table with
   observed evidence, following the `warren-bc4c` precedent.
4. **The router.** `projects` gains a forge discriminator,
   `POST /projects` gains the field, `ServerDeps` carries a resolver
   instead of one `Forge`, and `parseRepoRef` demotes from discovery to
   validation (§2). Land this with **GitHub and FakeForge only** — two
   forges already prove the plural path, and doing it before Forgejo
   exists keeps the router honest rather than Forgejo-shaped. The UI
   picker rides here, as do the Leak 4 dispositions, the §4b
   *ownership* check, and the `parseRepoRef` instance-scoping
   correction from §2 (every provider's ref must carry an instance id
   and close over a configured base URL). The §4b *identity* probe does
   NOT ride here — it belongs to instance registration, in step 1.

   **Measured blast radius**, so this step is not one sentence hiding
   the campaign's biggest unknown: `deps.forge` has **11 references
   across 7 files** — `src/server/handlers/projects.ts`,
   `plan-runs.ts`, `alerts.ts`, `runs/dispatch.ts`,
   `runs/pause-resume.ts`, `runs/git-credential.ts`, and
   `src/server/main/bridges-wiring.ts` — plus the `ServerDeps` field
   itself and the two `resolveForgeKind` gates from Leak 4. That is
   modest, and it is the strongest evidence that phase 3 of the
   original campaign did its job. Per mx-195e69 the two inline-reap
   cancel sites migrate together through `cancelRunWiring`. Per §4a the
   wiring lands in a new module, because `src/server/main/index.ts` has
   14 lines of headroom.

   Estimate on that evidence: two PRs, one for the schema plus the
   resolver seam and one for the handler and UI surface. Not five.
5. **`src/forge/forgejo/`.** Transport core, error classifier, retry
   policy, provider — mirroring the `src/forge/github/` decomposition,
   which exists because the naive union exceeded the 500-line budget.
   Tests land in the same PR: Article II, and the coverage ratchet does
   not fund an untested tree.
6. **Falsification test — the deliverable that matters.** A
   Forgejo-hosted project registers and completes dispatch → reap →
   push → PR with **zero domain-code changes**, on an instance that is
   simultaneously serving a GitHub project. If it needs a domain
   change, the contract failed, and that finding is worth more than the
   provider. This is the artifact to put in front of upstream (§7 Q0).
7. **GitLab.** Same shape, after Forgejo has proven the path. The extra
   unknowns are MR-vs-PR vocabulary and project-id-vs-path.

**Sequencing note.** Steps 2 and 4 are pure warren work with no
external dependency, and both improve the codebase whatever upstream
decides about Forgejo. Step 1 is a design conversation. Only steps 3,
5, and 6 depend on a live Forgejo. That ordering front-loads the work
that is defensible on its own merit and defers the work that needs the
refusal overturned.
