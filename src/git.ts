/**
 * src/git.ts — native git operations via child_process.
 *
 * Design decisions (from eng review):
 * - Uses the system git binary (child_process.spawn), NOT isomorphic-git.
 *   Obsidian Git (the dominant git plugin) uses the same approach on desktop:
 *   native git for desktop, isomorphic-git only for mobile.
 * - karaoke-cms users have git installed by definition (npm create @karaoke-cms@latest
 *   requires git to clone and push).
 * - Auth is handled by the system credential store (macOS Keychain, Windows Credential
 *   Manager, SSH keys) — no PAT stored in the plugin.
 *
 * Flow for commitAndPush:
 *   git add <filePath>
 *   git commit -m <message>   (if "nothing to commit", skip — retry scenario)
 *   git push origin <branch>
 */

import { execFile as _execFile } from 'child_process';
import { promisify } from 'util';
import type { KaraokeSettings } from './settings';

const execFile = promisify(_execFile);

// ── Typed errors ───────────────────────────────────────────────────────────────

export class GitAuthError extends Error {
	constructor(detail: string) {
		super(`auth error — check your git credentials (${detail})`);
		this.name = 'GitAuthError';
	}
}

export class GitConflictError extends Error {
	constructor(detail: string) {
		super(`remote has new commits — pull first (${detail})`);
		this.name = 'GitConflictError';
	}
}

export class GitNetworkError extends Error {
	constructor(detail: string) {
		super(`network error — check your connection (${detail})`);
		this.name = 'GitNetworkError';
	}
}

export class GitNotARepoError extends Error {
	constructor() {
		super('not a git repository — run `npm create @karaoke-cms@latest` to set up your site');
		this.name = 'GitNotARepoError';
	}
}

export class GitUnknownError extends Error {
	constructor(detail: string) {
		super(detail);
		this.name = 'GitUnknownError';
	}
}

export type GitError =
	| GitAuthError
	| GitConflictError
	| GitNetworkError
	| GitNotARepoError
	| GitUnknownError;

// ── Error parsing ──────────────────────────────────────────────────────────────

/**
 * Parse git stderr output into a typed error.
 * Exported for unit testing — all the platform-specific string matching lives here.
 *
 * Pattern coverage:
 *   Auth:     "Authentication failed", "could not read Username", 401/403 in URL errors
 *   Conflict: "rejected", "non-fast-forward", "fetch first", "failed to push"
 *   Network:  "could not resolve host", "unable to connect", "timed out"
 *   No repo:  "not a git repository"
 *   Fallback: first non-empty line of stderr
 */
export function parseGitError(stderr: string): GitError {
	const s = stderr.toLowerCase();

	if (
		s.includes('authentication failed') ||
		s.includes('could not read username') ||
		s.includes('invalid credentials') ||
		s.includes('permission denied') ||
		s.includes(': 401') ||
		s.includes(': 403')
	) {
		return new GitAuthError(firstLine(stderr));
	}

	if (
		s.includes('[rejected]') ||
		s.includes('non-fast-forward') ||
		s.includes('fetch first') ||
		s.includes('failed to push some refs') ||
		s.includes('updates were rejected')
	) {
		return new GitConflictError(firstLine(stderr));
	}

	if (
		s.includes('could not resolve host') ||
		s.includes('unable to access') ||
		s.includes('unable to connect') ||
		s.includes('timed out') ||
		s.includes('network is unreachable')
	) {
		return new GitNetworkError(firstLine(stderr));
	}

	if (s.includes('not a git repository')) {
		return new GitNotARepoError();
	}

	return new GitUnknownError(firstLine(stderr) || stderr.trim());
}

function firstLine(s: string): string {
	return s.split('\n').find(l => l.trim().length > 0)?.trim() ?? s.trim();
}

// ── Core operations ────────────────────────────────────────────────────────────

/**
 * Stage a single file, commit, and push.
 *
 * @param filePath  Vault-relative path from the repo root (e.g. "content/blog/my-note.md").
 *                  isomorphic-git convention: relative to repo root, forward slashes.
 * @param message   Commit message.
 * @param repoRoot  Absolute filesystem path to the git repo root (app.vault.adapter.basePath).
 * @param settings  Plugin settings (branch).
 *
 * @throws {GitError} on git failure. Never throws a plain Error.
 */
export async function commitAndPush(
	filePath: string,
	message: string,
	repoRoot: string,
	settings: KaraokeSettings,
): Promise<void> {
	const opts = { cwd: repoRoot };

	// Stage the single modified file only.
	// Do NOT use `git add .` — that would stage unrelated vault edits.
	try {
		await execFile('git', ['add', filePath], opts);
	} catch (err) {
		throw parseGitError(stderrOf(err));
	}

	// Commit. If "nothing to commit", the previous commit already captured this
	// file (retry scenario after a push failure) — skip and proceed to push.
	try {
		await execFile('git', ['commit', '-m', message], opts);
	} catch (err) {
		const combined = (stderrOf(err) + stdoutOf(err)).toLowerCase();
		if (
			combined.includes('nothing to commit') ||
			combined.includes('nothing added to commit')
		) {
			// Already committed — fall through to push
		} else {
			throw parseGitError(stderrOf(err));
		}
	}

	// Push to the configured branch.
	try {
		await execFile('git', ['push', 'origin', settings.branch], opts);
	} catch (err) {
		throw parseGitError(stderrOf(err));
	}
}

/**
 * Return true if repoRoot is inside a git repository.
 */
export async function isGitRepo(repoRoot: string): Promise<boolean> {
	try {
		await execFile('git', ['rev-parse', '--git-dir'], { cwd: repoRoot });
		return true;
	} catch {
		return false;
	}
}

// ── Internal helpers ───────────────────────────────────────────────────────────

interface ExecError {
	stderr?: string;
	stdout?: string;
}

function stderrOf(err: unknown): string {
	return String((err as ExecError)?.stderr ?? '');
}

function stdoutOf(err: unknown): string {
	return String((err as ExecError)?.stdout ?? '');
}
