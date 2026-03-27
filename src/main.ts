import { FileSystemAdapter, Notice, Plugin, TFile } from 'obsidian';
import { DEFAULT_SETTINGS, KaraokeSettingTab, KaraokeSettings } from './settings';

export default class KaraokePlugin extends Plugin {
	settings: KaraokeSettings;
	private statusBarItem: HTMLElement;

	async onload() {
		await this.loadSettings();

		// Status bar — shows Draft / Published for the active note
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
	}

	onunload() {}

	// ── Helpers ────────────────────────────────────────────────────────────────

	getRepoRoot(): string | null {
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) return adapter.basePath;
		return null;
	}

	getActiveMarkdownFile(): TFile | null {
		const file = this.app.workspace.getActiveFile();
		return file instanceof TFile && file.extension === 'md' ? file : null;
	}

	// ── Status bar ─────────────────────────────────────────────────────────────

	/** Override in subclass or after git wiring to show pushing / error states. */
	protected getStatusText(file: TFile): Promise<string> {
		return this.app.vault.read(file).then(content =>
			readPublishField(content) ? '✓ Published' : '· Draft'
		);
	}

	refreshStatusBar(): void {
		const file = this.getActiveMarkdownFile();
		if (!file) {
			this.statusBarItem.setText('');
			return;
		}
		this.getStatusText(file).then(text => {
			// Guard: file may have changed during the async read
			if (this.getActiveMarkdownFile()?.path === file.path) {
				this.statusBarItem.setText(text);
			}
		});
	}

	protected onStatusBarClick(): void {
		// Overridden after git wiring to dismiss error state
	}

	// ── Publish toggle ─────────────────────────────────────────────────────────

	async togglePublish(): Promise<void> {
		const file = this.getActiveMarkdownFile();
		if (!file) {
			new Notice('karaoke-cms: Open a Markdown note to publish.');
			return;
		}

		const content = await this.app.vault.read(file);
		const { newContent, isNowPublished } = togglePublishFrontmatter(content);
		await this.app.vault.modify(file, newContent);

		const action = isNowPublished ? 'Published' : 'Unpublished';
		new Notice(`karaoke-cms: ${action} (git push not yet wired).`);
		this.refreshStatusBar();
	}

	async retryPublish(): Promise<void> {
		new Notice('karaoke-cms: Nothing to retry.');
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
