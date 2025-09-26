import { App, PluginSettingTab, Setting, DropdownComponent } from "obsidian";
import ImageProcessorPlugin from "./main";

// 先定义一个新的接口来表示 URL 和 Referer 的映射
export interface RefererMapping {
    urlPattern: string;  // URL匹配模式
    referer: string;    // 对应的 Referer
}

export interface ImageProcessorSettings {
    style: 'wiki' | 'markdown'
    format: 'JPEG' | 'PNG';

    quality: number;
    colorDepth: number;
    
    // 文件重命名相关设置
    fileRenameEnabled: boolean;

    // webp 动画转换为 gif 设置
    convertWebpToGif: boolean;

    regex: string;
    nothingSelected: NothingSelected;
    listForImgEmbed: string;

    // 替换原来的 customReferers
    refererMappings: RefererMapping[];
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
    style: 'wiki',
    format: 'JPEG',
    quality: 0.8,
    colorDepth: 1,
    
    // 文件重命名功能默认启用
    fileRenameEnabled: true,

    // webp 动画转换为 gif 默认启用
    convertWebpToGif: true,

    regex: /[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/
        .source,
    nothingSelected: NothingSelected.doNothing,
    listForImgEmbed: "",

    // 替换原来的 customReferers
    refererMappings: [
        {
            urlPattern: "sspai.com",
            referer: "https://sspai.com/"
        },
        {
            urlPattern: "byteimg.com",
            referer: "https://juejin.cn/"
        }
    ],
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
            .setName('Image link style')
            .setDesc('Select the processed image link format')
            .addDropdown((dropdown: DropdownComponent) =>
                dropdown
                    .addOption('wiki', 'Wiki')
                    .addOption('markdown', 'Markdown')
                    .setValue(this.plugin.settings.style)
                    .onChange(async (value: 'wiki' | 'markdown') => {
                        this.plugin.settings.style = value;
                        await this.plugin.saveSettings();
                    }));

        new Setting(containerEl)
            .setName('Auto rename images')
            .setDesc('Automatically rename all images in a file when the file is renamed. Images will be renamed to match the new filename format.')
            .addToggle(toggle =>
                toggle
                    .setValue(this.plugin.settings.fileRenameEnabled)
                    .onChange(async (value: boolean) => {
                        this.plugin.settings.fileRenameEnabled = value;
                        await this.plugin.saveSettings();
                    }));

        containerEl.createEl('h2', { text: 'Image convert settings' });
        new Setting(containerEl)
            .setName('Image format')
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
            .setName('Image quality')
            .setDesc('Quality for JPEG compression (0.1 to 1.0)')
            .addSlider(slider =>
                slider
                    .setLimits(0.1, 1, 0.1)
                    .setValue(this.plugin.settings.quality)
                    .onChange(async (value) => {
                        this.plugin.settings.quality = value;
                        await this.plugin.saveSettings();
                    }));

        containerEl.createEl("h2", { text: "URL-into-selection settings" });
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

        
        containerEl.createEl("h2", { text: "Download settings" });
        
        // 替换原来的 Custom referers 设置
        const refererDiv = containerEl.createDiv('referer-mappings');
        refererDiv.createEl('p', {
            text: '配置 URL 模式和对应的 Referer，用于绕过防盗链',
            cls: 'setting-item-description'
        });

        this.plugin.settings.refererMappings.forEach((mapping, index) => {
            const mappingDiv = refererDiv.createDiv('referer-mapping-item');
            
            new Setting(mappingDiv)
                .addText(text => text
                    .setPlaceholder('URL pattern (e.g., byteimg.com)')
                    .setValue(mapping.urlPattern)
                    .onChange(async (value) => {
                        this.plugin.settings.refererMappings[index].urlPattern = value;
                        await this.plugin.saveSettings();
                    }))
                .addText(text => text
                    .setPlaceholder('Referer (e.g., https://juejin.cn/)')
                    .setValue(mapping.referer)
                    .onChange(async (value) => {
                        this.plugin.settings.refererMappings[index].referer = value;
                        await this.plugin.saveSettings();
                    }))
                .addButton(button => button
                    .setIcon('trash')
                    .onClick(async () => {
                        this.plugin.settings.refererMappings.splice(index, 1);
                        await this.plugin.saveSettings();
                        this.display();
                    }));
        });

        // 添加新映射的按钮
        new Setting(refererDiv)
            .addButton(button => button
                .setButtonText('Add new referer map')
                .onClick(async () => {
                    this.plugin.settings.refererMappings.push({
                        urlPattern: '',
                        referer: ''
                    });
                    await this.plugin.saveSettings();
                    this.display();
                }));
    }
}
