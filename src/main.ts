import UrlIntoSelection from "./core";
import { RefererModal } from "./modal";
import { DownloadImage } from "./download";
import { ImageProcessor } from "./processor";
import { Plugin, Notice, MarkdownView, TFile, TAbstractFile, Editor, normalizePath } from "obsidian";
import { ImageProcessorSettings, DEFAULT_SETTINGS, ImageProcessorSettingTab } from "./settings";


export default class ImageProcessorPlugin extends Plugin {
  settings: ImageProcessorSettings;
  private activeFile: TFile | null = null;
  private content: string = '';
  private downloadDir: string = "";
  private imageProcessor: ImageProcessor;
  private boundFileRenameHandler: (file: TAbstractFile, oldPath: string) => void;
  
  private menuHandler = (menu: any, editor: Editor) => {
    const cursor = editor.getCursor();
    const currentLine = editor.getLine(cursor.line);
    
    if (this.isImageLink(currentLine)) {
      menu.addItem((item: any) => {
        item
          .setTitle("下载并处理图片")
          .setIcon("image-down")
          .onClick(async () => {
            await this.processSingleImage(currentLine, editor, cursor.line);
          });
      });
    }
  };

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

    // 绑定文件重命名处理器
    this.boundFileRenameHandler = this.handleFileRename.bind(this);

    this.app.workspace.on("editor-paste", this.pasteHandler);

    // 添加右键菜单监听器
    this.app.workspace.on("editor-menu", this.menuHandler);

    // 添加文件重命名监听器
    this.app.vault.on("rename", this.boundFileRenameHandler);

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
    this.app.workspace.off("editor-menu", this.menuHandler);
    this.app.vault.off("rename", this.boundFileRenameHandler);
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

    // 显示开始处理的提示
    if (imageUrls.length > 0) {
      new Notice(`开始处理 ${imageUrls.length} 个图片...`);
    }

    for (let i = 0; i < imageUrls.length; i++) {
      const url = imageUrls[i];
      try {

        // 根据图片格式选择下载方式
        const isWebp = url.toLowerCase().endsWith('webp');
        const isGif = url.toLowerCase().endsWith('gif');
        console.debug(`Processing URL: ${url}, isWebp: ${isWebp}, isGif: ${isGif}`);

        let downloadedFileName: string | null;

        // 在下载前检查目标路径
        const attachmentPath = await this.app.fileManager.getAvailablePathForAttachment("");
        this.downloadDir = normalizePath(attachmentPath.split('/').slice(0, -1).join('/'));
        console.debug(`Download directory: ${this.downloadDir}`);

        if (isWebp && referer) {
          // 使用防盗链下载
          downloadedFileName = (await DownloadImage(this.app, url, referer)) ?? null;
        } else {
          // 使用普通下载
          downloadedFileName = await DownloadImage(this.app, url, "") ?? null;
        }

        if (downloadedFileName) {
          const filePath = `${this.downloadDir}/${downloadedFileName}`;
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

          const originalFormat = downloadedFileName.split('.').pop()?.toUpperCase();
          const targetFormat = this.settings.format;

          if (originalFormat && originalFormat === targetFormat) {
            console.debug(`File format matches target format (${targetFormat}), skipping conversion`);
            downloadedPathsMap.set(url, normalizePath(filePath));
            continue;
          }

          const processedBuffer = await this.processImage(fileBuffer);
          const extension = this.settings.format.toLowerCase();
          const processedFileName = downloadedFileName.replace(/\.[^/.]+$/, `.${extension}`);
          const processedPath = `${this.downloadDir}/${processedFileName}`;

          await this.app.vault.createBinary(processedPath, new Uint8Array(processedBuffer));

          const fileToDelete = this.app.vault.getAbstractFileByPath(filePath);
          if (fileToDelete) await this.app.vault.delete(fileToDelete);

          downloadedPathsMap.set(url, normalizePath(processedPath));
        }
              } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(`Download failed: ${url}, error message: ${errorMessage}`);
        new Notice(`❌ 处理失败 (${i + 1}/${imageUrls.length}): ${errorMessage}`);
      }
    }

    const updatedContent = this.replaceImageUrls(this.content, downloadedPathsMap);
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.editor.hasFocus()) {
      view.editor.setValue(updatedContent);
    } else if (tFile) {
      await this.app.vault.modify(tFile, updatedContent);
    }
    
    // 显示最终完成提示
    const successCount = downloadedPathsMap.size;
    const totalCount = imageUrls.length;
    if (successCount === totalCount && totalCount > 0) {
      new Notice(`图片处理完成！成功处理 ${successCount} 个图片`);
    } else if (totalCount > 0) {
      new Notice(`图片处理完成！成功: ${successCount}，失败: ${totalCount - successCount}`);
    }
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
    // 首先处理被链接包装的图片格式 [![](url)](url)
    // 这种格式会被转换为简单的图片格式 ![](local_path)
    let updatedContent = content.replace(/\[!\[(.*?)\]\((http[^)]+)\)\]\([^)]+\)/g, (match, alt, url) => {
      const downloadedPath = downloadedPaths.get(url);
      if (!downloadedPath) return match;
  
      if (this.settings.style === 'obsidian') {
        return alt ? `![[${downloadedPath}|${alt}]]` : `![[${downloadedPath}]]`;
      } else {
        return `![${alt}](${downloadedPath})`;
      }
    });

    // 然后处理简单的图片格式 ![](url)
    return updatedContent.replace(/!\[(.*?)\]\((http[^)]+)\)/g, (match, alt, url) => {
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
    const urls: string[] = [];
    
    // 提取被链接包装的图片URL [![](url)](url)
    const linkWrappedRegex = /\[!\[.*?\]\((http.*?)\)\]\([^)]+\)/g;
    let match;
    while ((match = linkWrappedRegex.exec(content)) !== null) {
      urls.push(match[1]);
    }
    
    // 提取简单的图片URL ![](url)
    const simpleRegex = /!\[.*?\]\((http.*?)\)/g;
    while ((match = simpleRegex.exec(content)) !== null) {
      // 避免重复添加已经从链接包装格式中提取的URL
      if (!urls.includes(match[1])) {
        urls.push(match[1]);
      }
    }
    
    return urls;
  }

  /**
   * 检测当前行文本是否包含图片链接
   */
  private isImageLink(text: string): boolean {
    if (!text.trim()) return false;
    
    // 检测 Markdown 格式的图片链接: ![alt](url)
    const markdownImageRegex = /!\[.*?\]\((http[^)]+\.(png|jpg|jpeg|gif|bmp|svg|webp))\)/i;
    
    // 检测 Obsidian 格式的图片链接: ![[filename]]
    const obsidianImageRegex = /!\[\[.+\.(png|jpg|jpeg|gif|bmp|svg|webp)(?:\|[^\]]+)?\]\]/i;
    
    // 检测被链接包装的图片格式: [![alt](url)](url)
    const linkWrappedImageRegex = /\[!\[.*?\]\((http[^)]+\.(png|jpg|jpeg|gif|bmp|svg|webp))\)\]\([^)]+\)/i;
    
    return markdownImageRegex.test(text) || obsidianImageRegex.test(text) || linkWrappedImageRegex.test(text);
  }

  /**
   * 处理单个图片链接
   */
  private async processSingleImage(lineText: string, editor: Editor, lineNumber: number): Promise<void> {
    try {
      const activeFile = this.app.workspace.getActiveFile();
      if (!activeFile) {
        new Notice("当前没有打开的文档！");
        return;
      }

      // 提取图片URL
      let imageUrl = '';
      let fullMatch = '';
      
      // 检测 Markdown 格式
      const markdownMatch = lineText.match(/!\[.*?\]\((http[^)]+)\)/);
      if (markdownMatch) {
        imageUrl = markdownMatch[1];
        fullMatch = markdownMatch[0];
      }
      
      // 检测被链接包装的格式
      if (!imageUrl) {
        const linkWrappedMatch = lineText.match(/\[!\[.*?\]\((http[^)]+)\)\]\([^)]+\)/);
        if (linkWrappedMatch) {
          imageUrl = linkWrappedMatch[1];
          fullMatch = linkWrappedMatch[0];
        }
      }

      if (!imageUrl) {
        new Notice("未找到有效的图片URL！");
        return;
      }

      new Notice("开始处理图片...");

      // 检查是否需要防盗链处理
      let referer = "";
      const isWebp = imageUrl.toLowerCase().includes('webp');
      
      if (isWebp) {
        // 尝试从 frontmatter 获取 referer
        await this.app.fileManager.processFrontMatter(activeFile, (frontmatter) => {
          for (const key in frontmatter) {
            if (typeof frontmatter[key] === "string" &&
              (frontmatter[key].toLowerCase().startsWith("http://") ||
                frontmatter[key].toLowerCase().startsWith("https://"))) {
              referer = frontmatter[key];
            }
          }
        });

        // 如果没有找到 referer，从文档内容前200字符查找
        if (!referer) {
          const content = await this.app.vault.read(activeFile);
          const first200Chars = content.slice(0, 200);
          const urlMatch = first200Chars.match(/https?:\/\/[^\s]+/);
          if (urlMatch) {
            referer = urlMatch[0];
          }
        }

        // 如果是 webp 且没有 referer，打开设置对话框
        if (!referer) {
          const modal = new RefererModal(this.app, async (modalReferer) => {
            await this.downloadAndReplaceSingleImage(imageUrl, modalReferer, fullMatch, editor, lineNumber);
          });
          modal.open();
          return;
        }
      }

      await this.downloadAndReplaceSingleImage(imageUrl, referer, fullMatch, editor, lineNumber);

    } catch (error) {
      console.error('处理单个图片时出错:', error);
      new Notice(`处理失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  }

  /**
   * 下载并替换单个图片
   */
  private async downloadAndReplaceSingleImage(imageUrl: string, referer: string, originalMatch: string, editor: Editor, lineNumber: number): Promise<void> {
    try {
      // 获取下载目录
      const attachmentPath = await this.app.fileManager.getAvailablePathForAttachment("");
      this.downloadDir = normalizePath(attachmentPath.split('/').slice(0, -1).join('/'));

      // 下载图片
      const isWebp = imageUrl.toLowerCase().includes('webp');
      const isGif = imageUrl.toLowerCase().includes('gif');
      
      let downloadedFileName: string | null;
      
      if (isWebp && referer) {
        downloadedFileName = await DownloadImage(this.app, imageUrl, referer) ?? null;
      } else {
        downloadedFileName = await DownloadImage(this.app, imageUrl, "") ?? null;
      }

      if (!downloadedFileName) {
        new Notice("图片下载失败！");
        return;
      }

      const filePath = `${this.downloadDir}/${downloadedFileName}`;
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!file || !(file instanceof TFile)) {
        new Notice(`文件未找到: ${filePath}`);
        return;
      }

      let finalPath = filePath;

      // 如果不是 GIF，进行格式转换和处理
      if (!isGif) {
        const fileBuffer = await this.app.vault.readBinary(file);
        const originalFormat = downloadedFileName.split('.').pop()?.toUpperCase();
        const targetFormat = this.settings.format;

        if (originalFormat !== targetFormat) {
          const processedBuffer = await this.processImage(fileBuffer);
          const extension = this.settings.format.toLowerCase();
          const processedFileName = downloadedFileName.replace(/\.[^/.]+$/, `.${extension}`);
          const processedPath = `${this.downloadDir}/${processedFileName}`;

          await this.app.vault.createBinary(processedPath, new Uint8Array(processedBuffer));
          await this.app.vault.delete(file);
          finalPath = processedPath;
        }
      }

      // 替换当前行中的图片链接
      const normalizedPath = normalizePath(finalPath);
      
      // 提取原始的 alt 文本
      const altMatch = originalMatch.match(/!\[(.*?)\]/);
      const altText = altMatch ? altMatch[1] : '';

      let replacementText = '';
      if (this.settings.style === 'obsidian') {
        replacementText = altText ? `![[${normalizedPath}|${altText}]]` : `![[${normalizedPath}]]`;
      } else {
        replacementText = `![${altText}](${normalizedPath})`;
      }

      // 获取当前行内容并替换
      const currentLine = editor.getLine(lineNumber);
      const newLine = currentLine.replace(originalMatch, replacementText);
      
      // 替换整行内容
      editor.setLine(lineNumber, newLine);
      
      new Notice("图片处理完成！");

    } catch (error) {
      console.error('下载和替换图片时出错:', error);
      new Notice(`处理失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
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

     /**
    * 处理文件重命名事件
    * 当 markdown 文件重命名时，自动更新相关图片文件的名称
    */
   private async handleFileRename(file: TAbstractFile, oldPath: string) {
     try {
       // 只处理 TFile 类型的 markdown 文件
       if (!(file instanceof TFile) || !file.name.endsWith('.md')) {
         return;
       }

       const newPath = file.path;
       console.log(`File renamed from ${oldPath} to ${newPath}`);

       // 获取旧文件名和新文件名（不含扩展名和路径）
       const oldFileName = oldPath.split('/').pop()?.replace(/\.md$/, '') || '';
       const newFileName = newPath.split('/').pop()?.replace(/\.md$/, '') || '';

       if (!oldFileName || !newFileName || oldFileName === newFileName) {
         return;
       }

       // 延迟处理，确保文件重命名操作完全完成
       setTimeout(async () => {
         await this.processImageRenameAfterFileRename(file, oldFileName, newFileName);
       }, 100);

     } catch (error) {
       console.error('处理文件重命名时出错:', error);
       new Notice(`处理文件重命名失败: ${error instanceof Error ? error.message : '未知错误'}`);
     }
   }

   /**
    * 在文件重命名完成后处理图片重命名
    */
   private async processImageRenameAfterFileRename(file: TFile, oldFileName: string, newFileName: string) {
     try {
              // 读取文件内容
       const content = await this.app.vault.read(file);
       
       // 查找文件中的所有图片链接
       const imageLinks = this.extractAllImageLinks(content);
       
       if (imageLinks.length === 0) {
         console.debug(`No image links found in ${file.name}`);
         return;
       }

       console.debug(`Found ${imageLinks.length} image links in ${file.name}`);
       const renamedImages = new Map<string, string>();
       let hasChanges = false;

       for (const link of imageLinks) {
         try {
           const imagePath = this.extractImagePathFromLink(link);
           if (!imagePath || typeof imagePath !== 'string' || imagePath.trim() === '') {
             console.debug(`Skipping invalid image path: ${imagePath}`);
             continue;
           }

           // 安全地获取图片文件名
           const pathParts = imagePath.split('/');
           const imageFileName = pathParts[pathParts.length - 1];
           if (!imageFileName || imageFileName.trim() === '') {
             console.debug(`Skipping invalid image filename from path: ${imagePath}`);
             continue;
           }

           // 安全地获取文件名（不含扩展名）
           const lastDotIndex = imageFileName.lastIndexOf('.');
           if (lastDotIndex === -1) {
             console.debug(`Skipping file without extension: ${imageFileName}`);
             continue;
           }
           
           const imageNameWithoutExt = imageFileName.substring(0, lastDotIndex);
           const extension = imageFileName.substring(lastDotIndex + 1);
           
           if (!imageNameWithoutExt || !extension) {
             console.debug(`Skipping invalid filename parts: ${imageFileName}`);
             continue;
           }
           
           // 检查用户是否禁用了自动重命名功能
           if (!this.settings.fileRenameEnabled) {
             console.debug('File rename is disabled');
             continue;
           }
           
           console.debug(`Processing image: ${imageFileName}`);
           
           // 处理所有图片，不再检查特定的命名模式
           let randomStr = '';
           
           // 尝试从现有文件名中提取随机字符串
           const existingRandomMatch = imageNameWithoutExt.match(/_([a-z0-9]{5})$/);
           if (existingRandomMatch) {
             randomStr = existingRandomMatch[1];
             console.debug(`Found existing random string: ${randomStr}`);
           } else {
             // 如果没有找到随机字符串，生成一个新的
             const chars = "abcdefghijklmnopqrstuvwxyz123456789".split("");
             randomStr = Array(5)
               .fill(0)
               .map(() => chars[Math.floor(Math.random() * chars.length)])
               .join("");
             console.debug(`Generated new random string: ${randomStr}`);
           }

           // 生成新的图片文件名
           const newImageFileName = `${newFileName}_${randomStr}.${extension}`;
           const newImagePath = imagePath.replace(imageFileName, newImageFileName);

           // 检查图片文件是否存在
           const imageFile = this.app.vault.getAbstractFileByPath(imagePath);
           if (imageFile instanceof TFile) {
             try {
               await this.app.fileManager.renameFile(imageFile, newImagePath);
               renamedImages.set(imagePath, newImagePath);
               hasChanges = true;
               console.log(`Renamed image: ${imagePath} -> ${newImagePath}`);
             } catch (renameError) {
               console.error(`Failed to rename image ${imagePath}:`, renameError);
               new Notice(`重命名图片失败: ${imageFileName}`);
             }
           } else {
             console.debug(`Image file not found: ${imagePath}`);
           }
         } catch (linkError) {
           console.error(`Error processing image link ${link}:`, linkError);
           // 继续处理下一个链接
           continue;
         }
       }

       // 如果有图片被重命名，更新文件内容中的链接
       if (hasChanges) {
         try {
           const updatedContent = this.updateImageLinksInContent(content, renamedImages);
           await this.app.vault.modify(file, updatedContent);
           new Notice(`已更新 ${renamedImages.size} 个图片文件名`);
         } catch (updateError) {
           console.error('更新文件内容失败:', updateError);
           new Notice('更新文件内容失败');
         }
       } else {
         console.debug('No images were renamed');
       }

     } catch (error) {
       console.error('处理图片重命名时出错:', error);
       new Notice(`处理图片重命名失败: ${error instanceof Error ? error.message : '未知错误'}`);
     }
  }

  /**
   * 提取内容中的所有图片链接
   */
  private extractAllImageLinks(content: string): string[] {
    const links: string[] = [];
    
    // Obsidian 格式: ![[image.jpg]] 或 ![[image.jpg|alt]]
    const obsidianMatches = content.match(/!\[\[[^\]]+\.(png|jpg|jpeg|gif|bmp|svg|webp)(?:\|[^\]]+)?\]\]/gi);
    if (obsidianMatches) {
      links.push(...obsidianMatches);
    }
    
    // Markdown 格式: ![alt](image.jpg)
    const markdownMatches = content.match(/!\[[^\]]*\]\([^)]+\.(png|jpg|jpeg|gif|bmp|svg|webp)\)/gi);
    if (markdownMatches) {
      links.push(...markdownMatches);
    }
    
    return links;
  }

     /**
    * 从图片链接中提取图片路径
    */
   private extractImagePathFromLink(link: string): string | null {
     try {
       if (!link || typeof link !== 'string' || link.trim() === '') {
         return null;
       }

       // Obsidian 格式: ![[path/image.jpg]] 或 ![[path/image.jpg|alt]]
       const obsidianMatch = link.match(/!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/);
       if (obsidianMatch && obsidianMatch[1]) {
         const path = obsidianMatch[1].trim();
         return path || null;
       }
       
       // Markdown 格式: ![alt](path/image.jpg)
       const markdownMatch = link.match(/!\[[^\]]*\]\(([^)]+)\)/);
       if (markdownMatch && markdownMatch[1]) {
         const path = markdownMatch[1].replace(/%20/g, ' ').trim(); // 解码空格
         return path || null;
       }
       
       return null;
     } catch (error) {
       console.error(`Error extracting image path from link: ${link}`, error);
       return null;
     }
   }

  /**
   * 更新内容中的图片链接
   */
  private updateImageLinksInContent(content: string, renamedImages: Map<string, string>): string {
    let updatedContent = content;
    
    for (const [oldPath, newPath] of renamedImages) {
      // 更新 Obsidian 格式的链接
      const obsidianPattern = new RegExp(`!\\[\\[${this.escapeRegExp(oldPath)}(\\|[^\\]]+)?\\]\\]`, 'g');
      updatedContent = updatedContent.replace(obsidianPattern, (match, altPart) => {
        return `![[${newPath}${altPart || ''}]]`;
      });
      
      // 更新 Markdown 格式的链接（处理编码的空格）
      const encodedOldPath = oldPath.replace(/ /g, '%20');
      const encodedNewPath = newPath.replace(/ /g, '%20');
      const markdownPattern = new RegExp(`!\\[([^\\]]*)\\]\\(${this.escapeRegExp(encodedOldPath)}\\)`, 'g');
      updatedContent = updatedContent.replace(markdownPattern, `![$1](${encodedNewPath})`);
      
      // 也处理未编码的情况
      const markdownPattern2 = new RegExp(`!\\[([^\\]]*)\\]\\(${this.escapeRegExp(oldPath)}\\)`, 'g');
      updatedContent = updatedContent.replace(markdownPattern2, `![$1](${newPath})`);
    }
    
    return updatedContent;
  }

  /**
   * 转义正则表达式特殊字符
   */
  private escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}