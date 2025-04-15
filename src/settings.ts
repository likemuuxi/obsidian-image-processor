import { App, PluginSettingTab, Setting, DropdownComponent } from "obsidian";
import ImageProcessorPlugin from "./main";

export interface ImageProcessorSettings {
    style: 'obsidian' | 'markdown'
    format: 'JPEG' | 'PNG';
    quality: number;
    colorDepth: number;

    regex: string;
    nothingSelected: NothingSelected;
    listForImgEmbed: string;
}

export const enum NothingSelected {
    /** Default paste behaviour */
    doNothing,
    /** Automatically select word surrounding the cursor */
    autoSelect,
    /** Insert `[](url)` */
    insertInline,
    /** Insert `<url>` */
    insertBare,
}

export const DEFAULT_SETTINGS: ImageProcessorSettings = {
    style: 'obsidian',
    format: 'JPEG',
    quality: 0.8,
    colorDepth: 1,

    regex: /[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/
        .source,
    nothingSelected: NothingSelected.doNothing,
    listForImgEmbed: "",
};

export class ImageProcessorSettingTab extends PluginSettingTab {
    plugin: ImageProcessorPlugin;

    constructor(app: App, plugin: ImageProcessorPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Basic settings' });

        new Setting(containerEl)
            .setName('Image Link Style')
            .setDesc('Select the processed image link format')
            .addDropdown((dropdown: DropdownComponent) =>
                dropdown
                    .addOption('obsidian', 'Obsidian')
                    .addOption('markdown', 'Markdown')
                    .setValue(this.plugin.settings.style)
                    .onChange(async (value: 'obsidian' | 'markdown') => {
                        this.plugin.settings.style = value;
                        await this.plugin.saveSettings();
                    }));

        containerEl.createEl('h2', { text: 'Image Convert Settings' });

        new Setting(containerEl)
            .setName('Image Format')
            .setDesc('Choose output format for downloaded images')
            .addDropdown((dropdown: DropdownComponent) =>
                dropdown
                    .addOption('JPEG', 'JPEG')
                    .addOption('PNG', 'PNG')
                    .setValue(this.plugin.settings.format)
                    .onChange(async (value: 'JPEG' | 'PNG') => {
                        this.plugin.settings.format = value;
                        await this.plugin.saveSettings();
                    }));

        new Setting(containerEl)
            .setName('Image Quality')
            .setDesc('Quality for JPEG compression (0.1 to 1.0)')
            .addSlider(slider =>
                slider
                    .setLimits(0.1, 1, 0.1)
                    .setValue(this.plugin.settings.quality)
                    .onChange(async (value) => {
                        this.plugin.settings.quality = value;
                        await this.plugin.saveSettings();
                    }));


        containerEl.createEl("h2", { text: "URL-into-selection Settings" });

        new Setting(containerEl)
            .setName("Fallback Regular expression")
            .setDesc(
                "Regular expression used to match URLs when default match fails."
            )
            .addText((text) =>
                text
                    .setPlaceholder("Enter regular expression here..")
                    .setValue(this.plugin.settings.regex)
                    .onChange(async (value) => {
                        if (value.length > 0) {
                            this.plugin.settings.regex = value;
                            await this.plugin.saveSettings();
                        }
                    })
            );

        new Setting(containerEl)
            .setName("Behavior on pasting URL when nothing is selected")
            .setDesc("Auto Select: Automatically select word surrounding the cursor.")
            .addDropdown((dropdown) => {
                const options: Record<NothingSelected, string> = {
                    0: "Do nothing",
                    1: "Auto Select",
                    2: "Insert [](url)",
                    3: "Insert <url>",
                };

                dropdown
                    .addOptions(options)
                    .setValue(this.plugin.settings.nothingSelected.toString())
                    .onChange(async (value) => {
                        this.plugin.settings.nothingSelected = +value;
                        await this.plugin.saveSettings();
                        this.display();
                    });
            });
            
        new Setting(containerEl)
            .setName("Whitelist for image embed syntax")
            .setDesc(
                createFragment((el) => {
                    el.appendText(
                        "![selection](url) will be used for URL that matches the following list."
                    );
                    el.createEl("br");
                    el.appendText("Rules are regex-based, split by line break.");
                })
            )
            .addTextArea((text) => {
                text
                    .setPlaceholder("Example:\nyoutu.?be|vimeo")
                    .setValue(this.plugin.settings.listForImgEmbed)
                    .onChange((value) => {
                        this.plugin.settings.listForImgEmbed = value;
                        this.plugin.saveData(this.plugin.settings);
                        return text;
                    });
                text.inputEl.rows = 6;
                text.inputEl.cols = 25;
            });
    }
}
