/**
 * Canonical hermetic git-fixture helper for tests (warren-cfa7).
 *
 * Why this exists: warren's pre-commit hook runs the whole test suite, and a
 * parent `git commit` exports repo-context GIT_* vars (GIT_DIR,
 * GIT_INDEX_FILE, GIT_WORK_TREE, GIT_COMMON_DIR, GIT_PREFIX, ...) into the
 * hook's environment. A test that spawns git against a temp fixture while
 * inheriting those vars does NOT operate on its fixture — git honors the env
 * over the cwd, so fixture commits land on the INVOKING repo's branch ref and
 * its index is rewritten. Observed 2026-07-30: the scratch 'base'/'pr'
 * commits in scripts/article-ix-gate.test.ts moved the invoking worktree's
 * branch ref and emptied its index when the suite ran under the hook.
 *
 * The defense lives at the spawn site, not in per-suite beforeEach clearing
 * (which is order-dependent: bun shares one process across test files, so a
 * suite that sets hostile env and fails before restoring it poisons every
 * later suite):
 *
 *   1. every fixture repo is created under a fresh `mkdtemp` ABSOLUTE path —
 *      never cwd, never a repo-relative path;
 *   2. every fixture git spawn passes `-C <abs path>` plus an env that drops
 *      every inherited `GIT_*` var and pins GIT_CEILING_DIRECTORIES to the
 *      fixture's parent, so upward `.git` discovery can never escape into the
 *      invoking repo even if the fixture path itself were nested inside it;
 *   3. `createGitFixture`/`createGitFixtureSync` assert post-init that
 *      `git rev-parse --git-dir` inside the fixture resolves INSIDE the
 *      fixture — never to the invoking repo (assertFixtureHermetic).
 *
 * `gitFixtureEnv(repoPath)` pins the ceiling to `dirname(repoPath)`, so pass
 * the REPO ROOT (or any direct child path of the intended discovery ceiling),
 * not a nested subdir — a subdir would ceiling discovery below its own repo.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { type RunGitResult, runGit, runGitOrThrow } from "./exec.ts";

export interface FixtureGitOptions {
	/** Merged OVER the scrubbed fixture env; an `undefined` value deletes the key. */
	env?: Record<string, string | undefined>;
	stdin?: string;
}

/** The inherited env with every `GIT_*` var dropped. No discovery ceiling. */
function scrubbedGitEnv(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (v !== undefined && !k.startsWith("GIT_")) out[k] = v;
	}
	return out;
}

/**
 * Environment for a hermetic fixture git spawn: the inherited env with every
 * `GIT_*` var dropped (a parent hook's GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE
 * can never redirect the call), plus GIT_CEILING_DIRECTORIES pinned to the
 * fixture's parent so `.git` discovery stops below the invoking repo no
 * matter where the fixture landed.
 */
export function gitFixtureEnv(
	repoPath: string,
	extra: Record<string, string | undefined> = {},
): Record<string, string> {
	const out = scrubbedGitEnv();
	out.GIT_CEILING_DIRECTORIES = dirname(resolve(repoPath));
	for (const [k, v] of Object.entries(extra)) {
		if (v === undefined) delete out[k];
		else out[k] = v;
	}
	return out;
}

/** Spawn `git -C <repoPath> <args>` with the hermetic fixture env (async). */
export function fixtureGit(
	repoPath: string,
	args: string[],
	opts: FixtureGitOptions = {},
): Promise<RunGitResult> {
	const abs = resolve(repoPath);
	return runGit(["-C", abs, ...args], {
		cwd: abs,
		env: gitFixtureEnv(abs, opts.env),
		stdin: opts.stdin,
	});
}

/** Throwing variant of {@link fixtureGit} (WorkspaceMaterializationError). */
export function fixtureGitOrThrow(
	repoPath: string,
	args: string[],
	opts: FixtureGitOptions = {},
): Promise<RunGitResult> {
	const abs = resolve(repoPath);
	return runGitOrThrow(["-C", abs, ...args], {
		cwd: abs,
		env: gitFixtureEnv(abs, opts.env),
		stdin: opts.stdin,
	});
}

/** Spawn `git -C <repoPath> <args>` with the hermetic fixture env (sync). */
export function fixtureGitSync(
	repoPath: string,
	args: string[],
	opts: FixtureGitOptions = {},
): RunGitResult {
	const abs = resolve(repoPath);
	const proc = Bun.spawnSync({
		cmd: ["git", "-C", abs, ...args],
		cwd: abs,
		env: gitFixtureEnv(abs, opts.env),
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: proc.exitCode,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

function resolveReal(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** The invoking repo's git dir (the checkout the test process runs in), or null. */
function invokingGitDirSync(): string | null {
	const cwd = process.cwd();
	const res = fixtureGitSync(cwd, ["rev-parse", "--git-dir"]);
	if (res.exitCode !== 0) return null;
	return resolveReal(resolve(cwd, res.stdout.trim()));
}

/**
 * Shared resolution check behind both guard variants: the fixture's own
 * `rev-parse --git-dir` output must resolve inside the fixture tree and must
 * never be the invoking repo's git dir.
 */
function checkGitDirResolution(
	fixturePath: string,
	gitDirRaw: string,
	invoking: string | null,
): void {
	const fixtureReal = resolveReal(resolve(fixturePath));
	const gitDirReal = resolveReal(resolve(fixtureReal, gitDirRaw));
	if (gitDirReal !== join(fixtureReal, ".git") && !gitDirReal.startsWith(fixtureReal + sep)) {
		throw new Error(
			`git fixture at ${fixtureReal} is not hermetic: 'git rev-parse --git-dir' ` +
				`resolved to ${gitDirReal}, outside the fixture (warren-cfa7). Build fixtures ` +
				`with createGitFixture so repo context can never leak in.`,
		);
	}
	if (invoking !== null && gitDirReal === invoking) {
		throw new Error(
			`git fixture at ${fixtureReal} is not hermetic: 'git rev-parse --git-dir' ` +
				`resolved to the INVOKING repo's git dir ${invoking} — a leaked GIT_* var ` +
				`diverted discovery (warren-cfa7).`,
		);
	}
}

/**
 * Guard: assert that `git rev-parse --git-dir` run inside `fixturePath`
 * resolves to a git dir INSIDE the fixture — never to the invoking repo.
 * Throws otherwise. Run after any fixture repo setup (createGitFixture does
 * it for you) so a hermeticity regression fails the suite instead of
 * damaging the invoking checkout.
 */
export async function assertFixtureHermetic(fixturePath: string): Promise<void> {
	const res = await fixtureGit(fixturePath, ["rev-parse", "--git-dir"]);
	if (res.exitCode !== 0) {
		throw new Error(
			`git fixture at ${resolve(fixturePath)}: 'git rev-parse --git-dir' failed — the ` +
				`fixture has no repo of its own and discovery cannot escape (ceiling pinned): ` +
				res.stderr.trim(),
		);
	}
	checkGitDirResolution(fixturePath, res.stdout.trim(), invokingGitDirSync());
}

/** Sync variant of {@link assertFixtureHermetic} for sync test bodies. */
export function assertFixtureHermeticSync(fixturePath: string): void {
	const res = fixtureGitSync(fixturePath, ["rev-parse", "--git-dir"]);
	if (res.exitCode !== 0) {
		throw new Error(
			`git fixture at ${resolve(fixturePath)}: 'git rev-parse --git-dir' failed — the ` +
				`fixture has no repo of its own and discovery cannot escape (ceiling pinned): ` +
				res.stderr.trim(),
		);
	}
	checkGitDirResolution(fixturePath, res.stdout.trim(), invokingGitDirSync());
}

export interface GitFixture {
	/** Absolute mkdtemp root that owns the fixture (the cleanup target). */
	root: string;
	/** Absolute path of the fixture repo (`<root>/<dir>`). */
	path: string;
	/** Run git against the fixture repo with the hermetic env. */
	git: (args: string[], opts?: FixtureGitOptions) => Promise<RunGitResult>;
	/** Remove the whole mkdtemp root. Idempotent (force). */
	cleanup: () => void;
}

export interface GitFixtureSync {
	/** Absolute mkdtemp root that owns the fixture (the cleanup target). */
	root: string;
	/** Absolute path of the fixture repo (`<root>/<dir>`). */
	path: string;
	/** Run git against the fixture repo with the hermetic env (sync). */
	git: (args: string[], opts?: FixtureGitOptions) => RunGitResult;
	/** Remove the whole mkdtemp root. Idempotent (force). */
	cleanup: () => void;
}

export interface CreateGitFixtureOptions {
	prefix?: string;
	/** Repo dir name under the mkdtemp root. Default "repo". */
	dir?: string;
	/** Initial branch. Default "main". */
	branch?: string;
	/** Repo-local commit identity. Default Fixture <fixture@warren.invalid>. */
	identity?: { name: string; email: string };
	/** When set, create an initial empty commit with this message. */
	initCommit?: string;
}

function fixtureInitArgs(opts: CreateGitFixtureOptions, path: string): string[] {
	return ["init", "-q", "-b", opts.branch ?? "main", path];
}

function fixtureIdentity(opts: CreateGitFixtureOptions): { name: string; email: string } {
	return opts.identity ?? { name: "Fixture", email: "fixture@warren.invalid" };
}

function assertAbsoluteRoot(root: string): void {
	if (!isAbsolute(root)) {
		throw new Error(
			`git fixture root ${root} is not absolute — fixtures must never fall back to a ` +
				`cwd- or repo-relative path (warren-cfa7).`,
		);
	}
}

/**
 * Create a hermetic git repo fixture under a fresh `mkdtemp` absolute path:
 * `git init` + repo-local identity + optional empty initial commit, then the
 * {@link assertFixtureHermetic} guard. The invoking repo's context can never
 * leak into any of these spawns.
 */
export async function createGitFixture(opts: CreateGitFixtureOptions = {}): Promise<GitFixture> {
	const root = mkdtempSync(join(tmpdir(), opts.prefix ?? "warren-git-fixture-"));
	assertAbsoluteRoot(root);
	const path = join(root, opts.dir ?? "repo");
	try {
		await fixtureGitOrThrow(root, fixtureInitArgs(opts, path));
		const id = fixtureIdentity(opts);
		await fixtureGitOrThrow(path, ["config", "user.email", id.email]);
		await fixtureGitOrThrow(path, ["config", "user.name", id.name]);
		if (opts.initCommit !== undefined) {
			await fixtureGitOrThrow(path, ["commit", "-q", "--allow-empty", "-m", opts.initCommit]);
		}
		await assertFixtureHermetic(path);
	} catch (err) {
		rmSync(root, { recursive: true, force: true });
		throw err;
	}
	return {
		root,
		path,
		git: (args, gitOpts) => fixtureGit(path, args, gitOpts),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/** Sync variant of {@link createGitFixture} for sync test bodies. */
export function createGitFixtureSync(opts: CreateGitFixtureOptions = {}): GitFixtureSync {
	const root = mkdtempSync(join(tmpdir(), opts.prefix ?? "warren-git-fixture-"));
	assertAbsoluteRoot(root);
	const path = join(root, opts.dir ?? "repo");
	const must = (r: RunGitResult, what: string): void => {
		if (r.exitCode !== 0) {
			throw new Error(
				`createGitFixtureSync ${what} failed (exit ${r.exitCode}): ${r.stderr.trim()}`,
			);
		}
	};
	try {
		must(fixtureGitSync(root, fixtureInitArgs(opts, path)), "init");
		const id = fixtureIdentity(opts);
		must(fixtureGitSync(path, ["config", "user.email", id.email]), "config user.email");
		must(fixtureGitSync(path, ["config", "user.name", id.name]), "config user.name");
		if (opts.initCommit !== undefined) {
			must(
				fixtureGitSync(path, ["commit", "-q", "--allow-empty", "-m", opts.initCommit]),
				"init commit",
			);
		}
		assertFixtureHermeticSync(path);
	} catch (err) {
		rmSync(root, { recursive: true, force: true });
		throw err;
	}
	return {
		root,
		path,
		git: (args, gitOpts) => fixtureGitSync(path, args, gitOpts),
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

/**
 * Temp root for fixtures whose subject is what git does when there is NO repo:
 * `discoverHostClone` returning null, `materializeProjectWorkspace` falling
 * back to a clone, `runGit` reporting "not a repository".
 *
 * `os.tmpdir()` is the wrong root for those. A sandbox may point TMPDIR inside
 * a git worktree — burrow sets it to `/workspace/.burrow-tmp` — and then the
 * `mkdtemp` dir is nested in a repo, upward discovery finds the sandbox's own
 * worktree, and every such assertion inverts.
 *
 * GIT_CEILING_DIRECTORIES is warren's usual lever against that ascent, and it
 * does stop it, but it cannot reach these call sites. The suites strip every
 * `GIT_*` var from the spawn env on purpose (warren-cfa7), which takes the
 * ceiling with it, and the functions under test accept no env argument, so
 * there is nowhere to reinstate it. A root that is not inside a repo to begin
 * with is what survives the scrub.
 *
 * Point WARREN_TEST_TMP_ROOT elsewhere when `/tmp` is unusable or itself
 * inside a checkout. {@link mkdtempOutsideRepo} verifies the root either way.
 */
export const OUTSIDE_REPO_TMP_ROOT = process.env.WARREN_TEST_TMP_ROOT ?? "/tmp";

let outsideRootVerified = false;

/**
 * `mkdtemp` a directory guaranteed to sit outside every git repo. Verifies
 * {@link OUTSIDE_REPO_TMP_ROOT} once per process and throws naming the
 * offending toplevel, so a bad root fails loudly instead of quietly inverting
 * the assertions it was chosen to protect.
 */
export function mkdtempOutsideRepo(prefix: string): string {
	if (!outsideRootVerified) {
		assertRootOutsideRepo(OUTSIDE_REPO_TMP_ROOT);
		outsideRootVerified = true;
	}
	return mkdtempSync(join(OUTSIDE_REPO_TMP_ROOT, prefix));
}

/**
 * The one fixture spawn in this module that deliberately pins NO discovery
 * ceiling. Every other spawn pins one to keep discovery from escaping; here
 * the escape IS the subject, and a ceiling would mask exactly the nesting the
 * guard exists to catch.
 */
function assertRootOutsideRepo(root: string): void {
	const proc = Bun.spawnSync({
		cmd: ["git", "-C", root, "rev-parse", "--show-toplevel"],
		cwd: root,
		env: scrubbedGitEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	if (proc.exitCode === 0) {
		throw new Error(
			`test temp root ${root} sits inside the git repo at ${proc.stdout.toString().trim()}, ` +
				`so "outside a repo" assertions would invert. Point WARREN_TEST_TMP_ROOT at a ` +
				`directory outside every checkout.`,
		);
	}
}
