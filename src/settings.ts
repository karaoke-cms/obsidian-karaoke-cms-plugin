import { App, PluginSettingTab, Setting } from 'obsidian';
import type KaraokePlugin from './main';

export interface KaraokeSettings {
	/** Git branch to push to when publishing. */
	branch: string;
	/**
	 * Commit message template.
	 * Supports: {title} → note title (or filename), {action} → "Published" | "Unpublished"
	 */
	commitTemplate: string;
}

export const DEFAULT_SETTINGS: KaraokeSettings = {
	branch: 'main',
	commitTemplate: 'Published: {title}',
};

export class KaraokeSettingTab extends PluginSettingTab {
	plugin: KaraokePlugin;

	constructor(app: App, plugin: KaraokePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'karaoke-cms' });

		new Setting(containerEl)
			.setName('Branch')
			.setDesc('The git branch to push to when you publish a note.')
			.addText(text =>
				text
					.setPlaceholder('main')
					.setValue(this.plugin.settings.branch)
					.onChange(async value => {
						this.plugin.settings.branch = value.trim() || 'main';
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Commit message template')
			.setDesc('Use {title} for the note title, {action} for "Published" or "Unpublished".')
			.addText(text =>
				text
					.setPlaceholder('Published: {title}')
					.setValue(this.plugin.settings.commitTemplate)
					.onChange(async value => {
						this.plugin.settings.commitTemplate = value.trim() || 'Published: {title}';
						await this.plugin.saveSettings();
					})
			);
	}
}
