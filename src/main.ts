import UrlIntoSelection from "./core";
import { RefererModal } from "./modal";
import { DownloadImage } from "./download";
import { ImageProcessor } from "./processor";
import { Plugin, Notice, MarkdownView, TFile, Editor, normalizePath } from "obsidian";
import { ImageProcessorSettings, DEFAULT_SETTINGS, ImageProcessorSettingTab } from "./settings";


export default class ImageProcessorPlugin extends Plugin {
  settings: ImageProcessorSettings;
  private activeFile: TFile | null = null;
  private content: string = '';
  private downloadDir: string = "";
  private imageProcessor: ImageProcessor;

  pasteHandler = async (evt: ClipboardEvent, editor: Editor) => {
    // 检查是否为图片文件
    const files = evt.clipboardData?.files;
    if (files && files.length > 0 && files[0].type.startsWith('image')) {
      evt.preventDefault();
      await this.handleImagePaste(files[0], editor);
      return;
    }

    // 如果不是图片，使用原有的 URL 处理逻辑
    UrlIntoSelection(editor, evt, this.settings);
  };

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new ImageProcessorSettingTab(this.app, this));

    this.imageProcessor = new ImageProcessor();

    this.app.workspace.on("editor-paste", this.pasteHandler);

    this.addCommand({
      id: "download-and-process-images",
      name: "Download and process images",
      callback: () => this.processFile(),
    });

    // this.addCommand({
    //   id: "compress-current-file-images",
    //   name: "Compress current file images",
    //   callback: () => this.convertMarkdownToObsidian()
    // });

    this.addCommand({
      id: "convert-markdown-to-obsidian",
      name: "Convert Markdown image links to Obsidian format",
      callback: () => this.convertMarkdownToObsidian()
    });

    this.addCommand({
      id: "convert-obsidian-to-markdown",
      name: "Converted Obsidian image links to Markdown",
      callback: () => this.convertObsidianToMarkdown(),
    });
  }

  onunload() {
    this.app.workspace.off("editor-paste", this.pasteHandler);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async processFile() {
    this.activeFile = this.app.workspace.getActiveFile();
    if (!this.activeFile) {
      new Notice("You haven't opened a document!");
      return;
    }
    // new Notice(`Processing file: ${this.activeFile.name}`);

    const activeFile = this.app.workspace.getActiveFile();
    if (activeFile) {
      const metadata = this.app.metadataCache.getFileCache(activeFile);
      const hasFrontmatter = !!metadata?.frontmatter;
      // new Notice(hasFrontmatter ? "有 frontmatter" : "没有 frontmatter");
      if (!hasFrontmatter) return;
    }

    this.content = await this.app.vault.read(this.activeFile);

    // 检查是否包含 .webp 格式的图片
    const hasWebpImages = /!\[.*?\]\((http.*?webp[^)]*)\)/i.test(this.content);
    console.debug(`Has webp images: ${hasWebpImages}`);

    if (hasWebpImages) {
      // 如果有 .webp 图片，使用防盗链下载方式
      let defaultReferer = "";
      let disableModal = false;
      // 尝试从 frontmatter 获取 referer
      await this.app.fileManager.processFrontMatter(this.activeFile, (frontmatter) => {
        for (const key in frontmatter) {
          if (typeof frontmatter[key] === "string" &&
            (frontmatter[key].toLowerCase().startsWith("http://") ||
              frontmatter[key].toLowerCase().startsWith("https://"))) {
            console.debug(`Found Referer from frontmatter. ${key}: ${frontmatter[key]}`);
            defaultReferer = frontmatter[key];
            disableModal = true;
          }
        }
      });

      // 如果 frontmatter 中没有 referer，从内容前200字符中查找
      if (!defaultReferer) {
        const first200Chars = this.content.slice(0, 200);
        const urlMatch = first200Chars.match(/https?:\/\/[^\s]+/);
        if (urlMatch) {
          defaultReferer = urlMatch[0];
          console.debug("Found Referer from content:", defaultReferer);
        }
      }

      if (!disableModal) {
        // 打开 Referer 设置对话框
        const modal = new RefererModal(this.app, async (referer) => {
          if (this.activeFile) {
            await this.processFileWithReferer(this.activeFile, referer);
          }
        });
        modal.defaultReferer = defaultReferer;
        modal.open();
      } else {
        this.processFileWithReferer(this.activeFile, defaultReferer);
      }
    } else {
      // 如果没有 .webp 图片，使用普通下载方式
      console.debug("No .webp images found, using normal download");
      await this.processFileWithReferer(this.activeFile, "");
    }
  }

  async processFileWithReferer(tFile: TFile, referer: string) {
    const imageUrls = this.extractImageUrls(this.content);
    const downloadedPathsMap = new Map<string, string>();

    for (const url of imageUrls) {
      try {
        // 根据图片格式选择下载方式
        const isWebp = url.toLowerCase().endsWith('webp');
        const isGif = url.toLowerCase().endsWith('gif');
        console.debug(`Processing URL: ${url}, isWebp: ${isWebp}, isGif: ${isGif}`);

        let fileName: string | null;

        // 在下载前检查目标路径
        const attachmentPath = await this.app.fileManager.getAvailablePathForAttachment("");
        this.downloadDir = normalizePath(attachmentPath.split('/').slice(0, -1).join('/'));
        console.debug(`Download directory: ${this.downloadDir}`);

        if (isWebp && referer) {
          // 使用防盗链下载
          fileName = (await DownloadImage(this.app, url, referer)) ?? null;
        } else {
          // 使用普通下载
          fileName = await DownloadImage(this.app, url, "") ?? null;
        }

        if (fileName) {
          const filePath = `${this.downloadDir}/${fileName}`;
          const file = this.app.vault.getAbstractFileByPath(filePath);
          if (!file || !(file instanceof TFile)) {
            new Notice(`File not found: ${filePath}`);
            continue;
          }

          // 如果是 GIF，直接使用下载的文件
          if (isGif) {
            console.debug('GIF file detected, skipping processing');
            downloadedPathsMap.set(url, normalizePath(filePath));
            continue;
          }

          const fileBuffer = await this.app.vault.readBinary(file);

          const originalFormat = fileName.split('.').pop()?.toUpperCase();
          const targetFormat = this.settings.format;

          if (originalFormat && originalFormat === targetFormat) {
            console.debug(`File format matches target format (${targetFormat}), skipping conversion`);
            downloadedPathsMap.set(url, normalizePath(filePath));
            continue;
          }

          const processedBuffer = await this.processImage(fileBuffer);
          const extension = this.settings.format.toLowerCase();
          const processedFileName = fileName.replace(/\.[^/.]+$/, `.${extension}`);
          const processedPath = `${this.downloadDir}/${processedFileName}`;

          await this.app.vault.createBinary(processedPath, new Uint8Array(processedBuffer));

          const fileToDelete = this.app.vault.getAbstractFileByPath(filePath);
          if (fileToDelete) await this.app.vault.delete(fileToDelete);

          downloadedPathsMap.set(url, normalizePath(processedPath));
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`Download failed: ${url}, error message: ${errorMessage}`);
        new Notice(`Error: ${errorMessage}`);
      }
    }

    const updatedContent = this.replaceImageUrls(this.content, downloadedPathsMap);
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.editor.hasFocus()) {
      view.editor.setValue(updatedContent);
    } else if (tFile) {
      await this.app.vault.modify(tFile, updatedContent);
    }
    new Notice("Images download completed!");
  }


  async processImage(buffer: ArrayBuffer): Promise<ArrayBuffer> {
    const blob = new Blob([buffer]);
    const format = this.settings.format;
    const quality = this.settings.quality;
    const colorDepth = this.settings.colorDepth;

    // 获取原始文件类型
    const originalFormat = blob.type.split('/')[1]?.toUpperCase();

    // 如果目标格式和原始格式相同，只进行压缩
    if (originalFormat && originalFormat === format) {
      return this.imageProcessor.compressOriginalImage(
        blob,
        quality,
        'None',  // 保持原始尺寸
        800,     // 默认宽度
        600,     // 默认高度
        1000,    // 最长边
        'Auto'   // 自动调整
      );
    }

    if (format === 'JPEG') {
      return this.imageProcessor.convertToJPG(blob, quality);
    } else {
      return this.imageProcessor.convertToPNG(blob, colorDepth);
    }
  }

  private async handleImagePaste(file: File, editor: Editor): Promise<void> {
    try {
      // 获取当前文件名作为基础
      const curFileName = this.app.workspace.getActiveFile()?.name;
      const curFileNameWithoutExt = curFileName ? curFileName.split(".").slice(0, -1).join(".") : "image";

      // Remove spaces from filename
      // const curFileNameWithoutExt = curFileName
      //   ? curFileName.split(".").slice(0, -1).join(".").replace(/\s+/g, "")
      //   : "image";

      // 生成随机字符串
      const chars = "abcdefghijklmnopqrstuvwxyz123456789".split("");
      const randomStr = Array(5)
        .fill(0)
        .map(() => chars[Math.floor(Math.random() * chars.length)])
        .join("");

      // 设置文件扩展名
      const extension = this.settings.format.toLowerCase() === 'jpeg' ? '.jpg' : '.png';
      const fileName = `${curFileNameWithoutExt}_${randomStr}${extension}`;

      // 读取和处理图片
      const buffer = await file.arrayBuffer();
      const processedBuffer = await this.processImage(buffer);

      // 获取附件路径并保存
      const filePath = await this.app.fileManager.getAvailablePathForAttachment(fileName);
      await this.app.vault.createBinary(filePath, new Uint8Array(processedBuffer));

      // 如果有选中的文本，使用它作为图片描述
      const selectedText = editor.getSelection();

      let pasteLink: string;
      if(this.settings.style == 'obsidian') {
        pasteLink = selectedText ? `![[${filePath}|${selectedText}]]` : `![[${filePath}]]`
      } else {
        const markdownLink = selectedText
          ? `![${selectedText}](${filePath})`
          : `![](${filePath})`;
        pasteLink = markdownLink.replace(/ /g, '%20');
      }

      editor.replaceSelection(pasteLink);

      new Notice(`Image processed and saved as ${fileName}`);
    } catch (error) {
      console.error('Error processing pasted image:', error);
      new Notice('Failed to process pasted image');
    }
  }

  replaceImageUrls(content: string, downloadedPaths: Map<string, string>): string {
    return content.replace(/!\[(.*?)\]\((http[^)]+)\)/g, (match, alt, url) => {
      const downloadedPath = downloadedPaths.get(url);
      if (!downloadedPath) return match;
  
      if (this.settings.style === 'obsidian') {
        return alt ? `![[${downloadedPath}|${alt}]]` : `![[${downloadedPath}]]`;
      } else {
        return `![${alt}](${downloadedPath})`;
      }
    });
  }

  extractImageUrls(content: string) {
    const regex = /!\[.*?\]\((http.*?)\)/g;
    const urls: string[] = [];
    let match;
    while ((match = regex.exec(content)) !== null) {
      urls.push(match[1]);
    }
    return urls;
  }

  private async convertObsidianToMarkdown() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("No active file.");
      return this.content;
    }

    const content = await this.app.vault.read(activeFile);
    const replaced = content.replace(
      /!\[\[(.+?\.(?:png|jpg|jpeg|gif|bmp|svg|webp))(?:\|([^\]]+))?\]\]/gi,
      (_match, path, alt) => {
        const encodedPath = path.replace(/ /g, '%20');
        return alt ? `![${alt}](${encodedPath})` : `![](${encodedPath})`;
      }
    );

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.editor.hasFocus()) {
      view.editor.setValue(replaced);
    } else if (activeFile) {
      await this.app.vault.modify(activeFile, replaced);
    }
    new Notice("Converted Obsidian image links to Markdown.");
  }


  private async convertMarkdownToObsidian() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new Notice("No active file.");
      return this.content;
    }

    const content = await this.app.vault.read(activeFile);
    const replaced = content.replace(
      /!\[(.*?)\]\(([^)]+?\.(png|jpg|jpeg|gif|bmp|svg|webp))\)/gi,
      (_match, alt, path) => {
        const decodedPath = path.replace(/%20/g, ' ');
        return alt ? `![[${decodedPath}|${alt}]]` : `![[${decodedPath}]]`;
      }
    );

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.editor.hasFocus()) {
      view.editor.setValue(replaced);
    } else if (activeFile) {
      await this.app.vault.modify(activeFile, replaced);
    }
    new Notice("Converted Markdown image links to Obsidian format.");
  }
}