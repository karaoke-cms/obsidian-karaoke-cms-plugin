import { FileSystemAdapter, Notice, Plugin, TFile } from 'obsidian';
import { DEFAULT_SETTINGS, KaraokeSettingTab, KaraokeSettings } from './settings';
import { commitAndPush, isGitRepo } from './git';

export default class KaraokePlugin extends Plugin {
	settings: KaraokeSettings;
	private statusBarItem: HTMLElement;

	// Push state
	private isPushing = false;
	private errorMessage: string | null = null;

	// Stored for retry after push failure
	private lastPushFile: string | null = null;
	private lastPushMessage: string | null = null;
	private lastPushRepoRoot: string | null = null;

	async onload() {
		await this.loadSettings();

		// Status bar — shows Draft / Published / Pushing... / error
		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.style.cursor = 'pointer';
		this.statusBarItem.addEventListener('click', () => this.onStatusBarClick());
		this.refreshStatusBar();

		// Ribbon icon — toggles publish status and pushes
		this.addRibbonIcon('send', 'Publish / Unpublish note', () => {
			void this.togglePublish();
		});

		// Update status bar when the active note changes
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => this.refreshStatusBar())
		);
		// Update status bar when the current file is saved
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (this.isPushing || this.errorMessage) return;
				const active = this.app.workspace.getActiveFile();
				if (active && file.path === active.path) this.refreshStatusBar();
			})
		);

		// Command: toggle from command palette
		this.addCommand({
			id: 'toggle-publish',
			name: 'Toggle publish status',
			checkCallback: (checking) => {
				const file = this.getActiveMarkdownFile();
				if (file) {
					if (!checking) void this.togglePublish();
					return true;
				}
				return false;
			},
		});

		// Command: retry after a push failure
		this.addCommand({
			id: 'retry-publish',
			name: 'Retry last publish',
			callback: () => void this.retryPublish(),
		});

		this.addSettingTab(new KaraokeSettingTab(this.app, this));

		// Startup: warn if vault is not a git repo
		const repoRoot = this.getRepoRoot();
		if (repoRoot) {
			isGitRepo(repoRoot).then(hasGit => {
				if (!hasGit) {
					new Notice(
						'karaoke-cms: This vault is not a git repository. ' +
						'Run `npm create @karaoke-cms@latest` to set up your site.',
						10000
					);
				}
			});
		} else {
			new Notice('karaoke-cms: Only works with a local vault on desktop.', 8000);
		}
	}

	onunload() {}

	// ── Helpers ────────────────────────────────────────────────────────────────

	private getRepoRoot(): string | null {
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) return adapter.basePath;
		return null;
	}

	getActiveMarkdownFile(): TFile | null {
		const file = this.app.workspace.getActiveFile();
		return file instanceof TFile && file.extension === 'md' ? file : null;
	}

	// ── Status bar ─────────────────────────────────────────────────────────────

	/**
	 * Refresh the status bar text based on current push state.
	 *
	 * State machine:
	 *   isPushing          → ⏳ Publishing...
	 *   errorMessage set   → ⚠ Push failed: {reason}   (click to dismiss)
	 *   no active note     → (empty)
	 *   else               → async read frontmatter → ✓ Published | · Draft
	 */
	refreshStatusBar(): void {
		if (this.isPushing) {
			this.statusBarItem.setText('⏳ Publishing...');
			return;
		}

		if (this.errorMessage) {
			this.statusBarItem.setText(`⚠ Push failed: ${this.errorMessage}`);
			this.statusBarItem.setAttribute('title', 'Click to dismiss');
			return;
		}

		const file = this.getActiveMarkdownFile();
		if (!file) {
			this.statusBarItem.setText('');
			return;
		}

		const snapshotPath = file.path;
		this.app.vault.read(file).then(content => {
			// Guard: active file may have changed during the async read
			if (this.isPushing || this.errorMessage) return;
			if (this.getActiveMarkdownFile()?.path !== snapshotPath) return;
			this.statusBarItem.setText(readPublishField(content) ? '✓ Published' : '· Draft');
			this.statusBarItem.setAttribute('title', '');
		});
	}

	private onStatusBarClick(): void {
		if (this.errorMessage) {
			this.errorMessage = null;
			this.refreshStatusBar();
		}
	}

	// ── Publish toggle ─────────────────────────────────────────────────────────

	async togglePublish(): Promise<void> {
		if (this.isPushing) return;

		const file = this.getActiveMarkdownFile();
		if (!file) {
			new Notice('karaoke-cms: Open a Markdown note to publish.');
			return;
		}

		const repoRoot = this.getRepoRoot();
		if (!repoRoot) {
			new Notice('karaoke-cms: Only works with a local vault on desktop.');
			return;
		}

		// Read, toggle, write
		const content = await this.app.vault.read(file);
		const { newContent, isNowPublished } = togglePublishFrontmatter(content);
		await this.app.vault.modify(file, newContent);

		// Build commit message from frontmatter title
		const title = getTitleFromContent(newContent, file.basename);
		const action = isNowPublished ? 'Published' : 'Unpublished';
		const message = this.settings.commitTemplate
			.replace('{title}', title)
			.replace('{action}', action);

		// Store for potential retry
		this.lastPushFile = file.path;
		this.lastPushMessage = message;
		this.lastPushRepoRoot = repoRoot;

		this.errorMessage = null;
		this.isPushing = true;
		this.refreshStatusBar();

		try {
			await commitAndPush(file.path, message, repoRoot, this.settings);
			this.isPushing = false;
			this.refreshStatusBar();
			new Notice(`karaoke-cms: ${action}. Site is building.`);
		} catch (err) {
			this.isPushing = false;
			this.errorMessage = err instanceof Error ? err.message : String(err);
			this.refreshStatusBar();
		}
	}

	// ── Retry ──────────────────────────────────────────────────────────────────

	async retryPublish(): Promise<void> {
		if (this.isPushing) return;
		if (!this.lastPushFile || !this.lastPushMessage || !this.lastPushRepoRoot) {
			new Notice('karaoke-cms: Nothing to retry.');
			return;
		}

		this.errorMessage = null;
		this.isPushing = true;
		this.refreshStatusBar();

		try {
			await commitAndPush(
				this.lastPushFile,
				this.lastPushMessage,
				this.lastPushRepoRoot,
				this.settings
			);
			this.isPushing = false;
			this.refreshStatusBar();
			new Notice('karaoke-cms: Published successfully.');
		} catch (err) {
			this.isPushing = false;
			this.errorMessage = err instanceof Error ? err.message : String(err);
			this.refreshStatusBar();
		}
	}

	// ── Settings ───────────────────────────────────────────────────────────────

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<KaraokeSettings>
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// ── Pure frontmatter helpers (exported for unit tests) ─────────────────────────

/**
 * Return true if the note has `publish: true` in its YAML frontmatter.
 */
export function readPublishField(content: string): boolean {
	if (!content.startsWith('---\n')) return false;
	const closeIdx = content.indexOf('\n---', 4);
	if (closeIdx === -1) return false;
	const body = content.slice(4, closeIdx);
	const match = body.match(/^publish:\s*(.+)$/m);
	return match !== null && match[1].trim() === 'true';
}

/**
 * Toggle the `publish` field in YAML frontmatter.
 *
 * State machine:
 *   no frontmatter          → add block with publish: true
 *   frontmatter, no publish → add publish: true
 *   publish: false (or any) → publish: true
 *   publish: true           → publish: false
 */
export function togglePublishFrontmatter(content: string): {
	newContent: string;
	isNowPublished: boolean;
} {
	// No frontmatter — prepend a minimal block
	if (!content.startsWith('---\n')) {
		return {
			newContent: `---\npublish: true\n---\n\n${content}`,
			isNowPublished: true,
		};
	}

	// Find the closing delimiter
	const closeIdx = content.indexOf('\n---', 4);
	if (closeIdx === -1) {
		// Malformed frontmatter — treat as absent
		return {
			newContent: `---\npublish: true\n---\n\n${content}`,
			isNowPublished: true,
		};
	}

	const fmOpen = content.slice(0, 4); // '---\n'
	const fmBody = content.slice(4, closeIdx); // body between delimiters
	const rest = content.slice(closeIdx); // '\n---' + everything after

	const publishRx = /^(publish:\s*)(.+)$/m;
	const match = fmBody.match(publishRx);

	if (!match) {
		// No publish field — append it
		return {
			newContent: `${fmOpen}${fmBody}\npublish: true${rest}`,
			isNowPublished: true,
		};
	}

	const isCurrentlyPublished = match[2].trim() === 'true';
	const newBody = fmBody.replace(publishRx, `$1${isCurrentlyPublished ? 'false' : 'true'}`);

	return {
		newContent: `${fmOpen}${newBody}${rest}`,
		isNowPublished: !isCurrentlyPublished,
	};
}

/**
 * Extract the title from YAML frontmatter, falling back to the file basename.
 */
export function getTitleFromContent(content: string, basename: string): string {
	if (!content.startsWith('---\n')) return basename;
	const closeIdx = content.indexOf('\n---', 4);
	if (closeIdx === -1) return basename;
	const body = content.slice(4, closeIdx);
	const match = body.match(/^title:\s*['"]?(.+?)['"]?\s*$/m);
	return match ? match[1].trim() : basename;
}
