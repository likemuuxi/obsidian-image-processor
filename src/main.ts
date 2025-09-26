import UrlIntoSelection from "./core";
import { RefererModal } from "./modal";
import { DownloadImage } from "./download";
import { ImageProcessor } from "./processor";
import {
	Plugin,
	Notice,
	MarkdownView,
	TFile,
	TAbstractFile,
	Editor,
	normalizePath,
	App,
} from "obsidian";
import * as https from 'https';
import * as http from 'http';
import {
	ImageProcessorSettings,
	DEFAULT_SETTINGS,
	ImageProcessorSettingTab,
} from "./settings";

interface HotlinkCheckResult {
    isHotlinkProtected: boolean;
    reason: string;
}

export default class ImageProcessorPlugin extends Plugin {
	settings: ImageProcessorSettings;
	private activeFile: TFile | null = null;
	private content: string = "";
	private downloadDir: string = "";
	private imageProcessor: ImageProcessor;
	private boundFileRenameHandler: (
		file: TAbstractFile,
		oldPath: string
	) => void;

	private menuHandler = (menu: any, editor: Editor) => {
		const cursor = editor.getCursor();
		const currentLine = editor.getLine(cursor.line);

		if (this.isImageLink(currentLine)) {
			menu.addItem((item: any) => {
				item.setTitle("下载并处理图片")
					.setIcon("image-down")
					.onClick(async () => {
						await this.processSingleImage(
							currentLine,
							editor,
							cursor.line
						);
					});
			});
		}
	};

	pasteHandler = async (evt: ClipboardEvent, editor: Editor) => {
		// 检查是否为图片文件
		const files = evt.clipboardData?.files;
		if (files && files.length > 0 && files[0].type.startsWith("image")) {
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

		// 绑定粘贴事件处理器
		this.app.workspace.on("editor-paste", this.pasteHandler);

		// 添加右键菜单监听器
		this.app.workspace.on("editor-menu", this.menuHandler);

		// 添加文件重命名监听器
		this.app.vault.on("rename", this.boundFileRenameHandler);

		this.addCommand({
			id: "download-and-process-images",
			name: "Download and process all images",
			callback: () => this.processFile(),
		});

		// 下载：防盗链、OB
		// 重命名
		// 格式转换
		// 压缩

		this.addCommand({
			id: "convert-markdown-to-obsidian",
			name: "Convert Markdown image links to Obsidian format",
			callback: () => this.convertMarkdownToObsidian(),
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
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async processFile() {
		this.activeFile = this.app.workspace.getActiveFile();
		if (!this.activeFile) {
			new Notice("当前没有打开的文档！");
			return;
		}

		this.content = await this.app.vault.read(this.activeFile);

		// 检查是否包含网络图片
		const networkImageUrls = this.extractNetworkImageUrls(this.content);
		const localImagePaths = this.extractLocalImagePaths(this.content);

		console.debug(`Found ${networkImageUrls.length} network images and ${localImagePaths.length} local images`);

		// 如果没有任何图片，直接返回
		if (networkImageUrls.length === 0 && localImagePaths.length === 0) {
			new Notice("当前文档没有找到任何图片");
			return;
		}

		// 检查是否包含 .webp 格式的网络图片
		// const hasWebpImages = /!\[.*?\]\((http.*?webp[^)]*)\)/i.test(this.content);
		// console.debug(`Has webp images: ${hasWebpImages}`);

		if (networkImageUrls.length) {
			let found = false;
			for (const url of networkImageUrls) {
				// 检查 URL 是否匹配任何预设的 mapping
				for (const mapping of this.settings.refererMappings) {
					if (url.includes(mapping.urlPattern)) {
						found = true;
						console.log(`Using referer mapping for ${url}: ${mapping.referer}`);
						await this.processNetworkImages(this.activeFile, networkImageUrls, mapping.referer);
						break;
					}
				}
				if (found) break;
			}

			if (!found) {
				// 如果没有匹配的预设，尝试从文档获取 referer
				// let referer = this.tryToGetReferer(this.activeFile);
				// if (!referer) {
				// 	// 如果文档中也没有找到 referer，使用第一个图片 URL 的域名
				// 	const firstUrl = new URL(networkImageUrls[0]);
				// 	referer = `${firstUrl.protocol}//${firstUrl.hostname}`;
				// }
				// await this.processNetworkImages(this.activeFile, networkImageUrls, referer);
				await this.processNetworkImages(this.activeFile, networkImageUrls, "");
			}
		}

		if(localImagePaths.length > 0) {
			// 没有网络图片，处理本地图片
			await this.processLocalImages(this.activeFile, localImagePaths);
		}
	}

	private async processNetworkImages(tFile: TFile, networkImageUrls: string[], referer: string): Promise<{ processedMap: Map<string, string>, success: number }> {
		const processedMap = new Map<string, string>();
		let successCount = 0;

		for (let i = 0; i < networkImageUrls.length; i++) {
			const url = networkImageUrls[i];
			try {
				// 下载
				const { file, filePath } = await this.downloadImageToVault(url, referer);
				if (!file || !filePath) continue;

				const buffer = await this.app.vault.readBinary(file);
				const lowerUrl = url.toLowerCase();
				const isGif = lowerUrl.endsWith("gif");
				const isSvg = lowerUrl.endsWith("svg");
				const isAnimatedWebP = !isGif && !isSvg && this.isAnimatedWebP(buffer);
	
				// 附件目录和新文件名
				const curFileName = tFile.name.split(".").slice(0, -1).join(".");
				const ext = isGif || isAnimatedWebP || isSvg
					? file.name.split(".").pop()   // 保持原后缀
					: (this.settings.format.toLowerCase() === "jpeg" ? "jpg" : this.settings.format.toLowerCase());
				const newAttachmentPath = await this.app.fileManager.getAvailablePathForAttachment(
					`${curFileName}_${this.randomSuffix()}.${ext}`
				);

				let processedBuffer: ArrayBuffer;

				if (isGif || isAnimatedWebP || isSvg) {
					// 只重命名，不处理
					processedBuffer = buffer;
				} else {
					// 静态图片 → 格式转换
					processedBuffer = await this.processImage(buffer);
				}

				// 写入新文件并删除原文件
				await this.app.vault.createBinary(newAttachmentPath, processedBuffer);
				await this.app.vault.delete(file);
				processedMap.set(url, normalizePath(newAttachmentPath));
				successCount++;

				// 更新文档中的图片链接
				if (processedMap.size > 0) {
					const updatedContent = this.replaceImageUrls(this.content, processedMap);
					const view = this.app.workspace.getActiveViewOfType(MarkdownView);
					if (view?.editor.hasFocus()) {
						view.editor.setValue(updatedContent);
					} else if (tFile) {
						await this.app.vault.modify(tFile, updatedContent);
					}
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : "未知错误";
				console.error(`网络图片处理失败: ${url}, 错误: ${msg}`);
				new Notice(`❌ 网络图片处理失败 (${i + 1}/${networkImageUrls.length}): ${msg}`);
			}
		}

		// 显示最终完成提示
		if (networkImageUrls.length > 0 && successCount === networkImageUrls.length) {
			new Notice(`网络图片处理完成！成功处理 ${successCount} 个图片`);
		} else if (networkImageUrls.length > 0) {
			new Notice(`网络图片处理完成！成功: ${successCount}，失败: ${networkImageUrls.length - successCount}`);
		}

		if (this.activeFile && successCount < networkImageUrls.length) {
			// 选择Ob or processor
			const modal = new RefererModal(this.app, async (referer) => {
				new Notice(`选择的Referer: ${referer}`);
				this.activeFile = this.app.workspace.getActiveFile();
				if (this.activeFile) {
					this.content = await this.app.vault.read(this.activeFile);
					const networkImageUrls = this.extractNetworkImageUrls(this.content);
					await this.processNetworkImages(this.activeFile, networkImageUrls, referer);
				}
			});
			modal.defaultReferer = this.tryToGetReferer(this.activeFile) ? this.tryToGetReferer(this.activeFile) : "<默认值>";
			modal.open();
		}

		return { processedMap, success: successCount };
	}

	private async processLocalImages(tFile: TFile, localImagePaths: string[]): Promise<{ processedMap: Map<string, string>, success: number }> {
		const processedMap = new Map<string, string>();
		let successCount = 0;
		let processedCount = 0;

		const allLocalImagesProcessed = await this.areLocalImagesProcessed(tFile, localImagePaths);
		if (allLocalImagesProcessed) {
			console.debug("所有本地图片均已处理");
			return { processedMap, success: successCount };
		}

		for (let i = 0; i < localImagePaths.length; i++) {
			const imagePath = localImagePaths[i];
			try {
				const fileName = imagePath.split("/").pop()!;
				if (this.isImagePathFormat(tFile, fileName)) {
					console.debug(`已处理过的图片: ${fileName}`);
					processedCount++;
					continue;
				}
	
				const resolvedPath = await this.resolveImagePath(imagePath, tFile);
				if (!resolvedPath) continue;
	
				const normalizedPath = normalizePath(resolvedPath);
				const file = this.app.vault.getAbstractFileByPath(normalizedPath);
				if (!file || !(file instanceof TFile)) continue;
	
				const lowerPath = resolvedPath.toLowerCase();
				const buffer = await this.app.vault.readBinary(file);
				const isGif = lowerPath.endsWith(".gif");
				const isSvg = lowerPath.endsWith(".svg");
				const isAnimatedWebP = !isGif && !isSvg && this.isAnimatedWebP(buffer);
	
				// 附件目录和新文件名
				const curFileName = tFile.name.split(".").slice(0, -1).join(".");
				const ext = isGif || isAnimatedWebP || isSvg
					? file.name.split(".").pop()   // 保留原后缀
					: (this.settings.format.toLowerCase() === "jpeg" ? "jpg" : this.settings.format.toLowerCase());
				const newAttachmentPath = await this.app.fileManager.getAvailablePathForAttachment(
					`${curFileName}_${this.randomSuffix()}.${ext}`
				);
	
				let processedBuffer: ArrayBuffer;
	
				if (isGif || isAnimatedWebP || isSvg) {
					// 只重命名，不处理
					processedBuffer = buffer;
				} else {
					// 静态图片 → 格式转换
					processedBuffer = await this.processImage(buffer);
				}
	
				// 写入新文件并删除原文件
				await this.app.vault.createBinary(newAttachmentPath, processedBuffer);
				await this.app.vault.delete(file);
				processedMap.set(imagePath, normalizePath(newAttachmentPath));
				successCount++;
	
				// 更新文档中的图片链接
				if (processedMap.size > 0) {
					const updatedContent = this.replaceImagePaths(this.content, processedMap);
					const view = this.app.workspace.getActiveViewOfType(MarkdownView);
					if (view?.editor.hasFocus()) {
						view.editor.setValue(updatedContent);
					} else if (tFile) {
						await this.app.vault.modify(tFile, updatedContent);
					}
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : "未知错误";
				console.error(`本地图片处理失败: ${imagePath}, 错误: ${msg}`);
				new Notice(`❌ 本地图片处理失败: ${msg}`);
			}
		}
		
		// 显示最终完成提示
		if (successCount === localImagePaths.length && localImagePaths.length > 0) {
			new Notice(`本地图片处理完成！成功处理 ${successCount} 个图片`);
		} else if (localImagePaths.length > 0) {
			new Notice(`图片处理完成！成功: ${successCount}，失败: ${localImagePaths.length - successCount - processedCount}`);
		}

		return { processedMap, success: successCount };
	}

	private async processImage(buffer: ArrayBuffer): Promise<ArrayBuffer> {
		const blob = new Blob([buffer]);
		const format = this.settings.format;
		const quality = this.settings.quality;
		const colorDepth = this.settings.colorDepth;

		// 获取原始文件类型 如果目标格式和原始格式相同，只进行压缩
		const originalFormat = blob.type.split("/")[1]?.toUpperCase();
		if (originalFormat && originalFormat === format) {
			return this.imageProcessor.compressOriginalImage(
				blob,
				quality,
				"None", // 保持原始尺寸
				800, // 默认宽度
				600, // 默认高度
				1000, // 最长边
				"Auto" // 自动调整
			);
		}

		if (format === "JPEG") {
			return this.imageProcessor.convertToJPG(blob, quality);
		} else {
			return this.imageProcessor.convertToPNG(blob, colorDepth);
		}
	}

	private async downloadImageToVault(url: string, referer: string): Promise<{ file: TFile | null, filePath: string | null }> {
		const attachmentPath = await this.app.fileManager.getAvailablePathForAttachment("");
		const downloadDir = normalizePath(attachmentPath.split("/").slice(0, -1).join("/"));

		const downloadedFileName = await DownloadImage(this.app, url, referer ?? "");
		if (!downloadedFileName) return { file: null, filePath: null };

		const filePath = `${downloadDir}/${downloadedFileName}`;
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!file || !(file instanceof TFile)) return { file: null, filePath: null };

		return { file, filePath: normalizePath(filePath) };
	}
	
	private async areLocalImagesProcessed(tFile: TFile, localImagePaths: string[]): Promise<boolean> {
		try {
			// 如果没有本地图片，认为已处理完毕
			if (localImagePaths.length === 0) {
				return true;
			}

			// 获取预期的附件目录
			const attachmentPath = await this.app.fileManager.getAvailablePathForAttachment("");
			const expectedAttachmentDir = normalizePath(attachmentPath.split("/").slice(0, -1).join("/"));

			// 获取当前文档名（不含扩展名）
			const currentFileName = tFile.name.split(".").slice(0, -1).join(".");

			// 检查每个本地图片
			for (const imagePath of localImagePaths) {
				// 解析图片路径
				const resolvedPath = await this.resolveImagePath(imagePath, tFile);
				if (!resolvedPath) {
					console.debug(`无法解析图片路径: ${imagePath}, 需要处理`);
					return false;
				}

				const imageFile = this.app.vault.getAbstractFileByPath(resolvedPath);
				if (!(imageFile instanceof TFile)) {
					console.debug(`图片文件未找到: ${resolvedPath}, 需要处理`);
					return false;
				}

				// 检查是否在正确的附件目录中
				if (!resolvedPath.startsWith(expectedAttachmentDir)) {
					console.debug(`图片不在附件目录中: ${resolvedPath}, 需要处理`);
					return false;
				}

				// 检查文件名格式： "文档名_随机字符串.扩展名"
				const fileName = resolvedPath.split("/").pop();
				if (!fileName) continue;
				const expectedPrefix = `${currentFileName}_`;
				const extension = `.${this.settings.format.toLowerCase() === "jpeg" ? "jpg" : this.settings.format.toLowerCase()}`;
				if (!fileName.startsWith(expectedPrefix) || !fileName.endsWith(extension)) {
					console.debug(`文件名格式不符合要求: ${fileName}, 需要处理`);
					return false;
				}

				// 检查随机字符串部分是否正确（应该是5位字母数字）
				const randomPart = fileName.slice(expectedPrefix.length, -extension.length);
				if (!/^[a-z0-9]{5}$/.test(randomPart)) {
					console.debug(`随机字符串格式不正确: ${randomPart}, 需要处理`);
					return false;
				}
			}

			console.debug("所有本地图片都已经符合要求");
			return true;
		} catch (error) {
			console.error("检查图片状态时出错:", error);
			return false; // 出错时假设需要处理
		}
	}

	/**
	 * 提取文档中的图片链接
	 */
	private extractNetworkImageUrls(content: string): string[] {
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

	private extractLocalImagePaths(content: string): string[] {
		const paths: string[] = [];

		// 提取 Obsidian 格式的本地图片: ![[image.jpg]] 或 ![[image.jpg|alt]]
		const obsidianMatches = content.match(
			/!\[\[([^\]|]+\.(png|jpg|jpeg|gif|bmp|svg|webp))(?:\|[^\]]+)?\]\]/gi
		);
		if (obsidianMatches) {
			obsidianMatches.forEach((match) => {
				const pathMatch = match.match(
					/!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/
				);
				if (pathMatch && pathMatch[1]) {
					paths.push(pathMatch[1]);
				}
			});
		}

		// 提取 Markdown 格式的本地图片: ![alt](image.jpg) （排除http开头的）
		const markdownMatches = content.match(
			/!\[[^\]]*\]\(([^)]+\.(png|jpg|jpeg|gif|bmp|svg|webp))\)/gi
		);
		if (markdownMatches) {
			markdownMatches.forEach((match) => {
				const pathMatch = match.match(/!\[[^\]]*\]\(([^)]+)\)/);
				if (
					pathMatch &&
					pathMatch[1] &&
					!pathMatch[1].startsWith("http")
				) {
					// 解码URL编码的空格
					const decodedPath = pathMatch[1].replace(/%20/g, " ");
					if (!paths.includes(decodedPath)) {
						paths.push(decodedPath);
					}
				}
			});
		}

		return paths;
	}

	/**
	 * 解析图片路径，将相对路径转换为 vault 中的绝对路径
	 */
	private async resolveImagePath(
		imagePath: string,
		activeFile: TFile
	): Promise<string | null> {
		try {
			// 如果路径以 http 开头，跳过（这是网络图片）
			if (imagePath.startsWith("http")) {
				return null;
			}

			// 先尝试直接作为 vault 路径查找
			let file = this.app.vault.getAbstractFileByPath(imagePath);
			if (file instanceof TFile) {
				return imagePath;
			}

			// 如果是相对路径（包含 ../ 或 ./），需要相对于当前文件解析
			if (imagePath.includes("../") || imagePath.startsWith("./")) {
				const currentDir = activeFile.parent?.path || "";
				const resolvedPath = this.resolveRelativePath(currentDir, imagePath);
				file = this.app.vault.getAbstractFileByPath(resolvedPath);
				if (file instanceof TFile) {
					return resolvedPath;
				}
			}

			// 如果只是文件名，在在附件目录中和整个 vault 中搜索
			if (!imagePath.includes("/")) {
				// 尝试在附件目录中查找
				const attachmentPath = await this.app.fileManager.getAvailablePathForAttachment("");
				const attachmentDir = normalizePath(attachmentPath.split("/").slice(0, -1).join("/"));
				if (attachmentDir) {
					const testPath = `${attachmentDir}/${imagePath}`;
					file = this.app.vault.getAbstractFileByPath(testPath);
					if (file instanceof TFile) {
						return testPath;
					}
				}

				// 尝试在当前文件目录查找
				const currentDir = activeFile.parent?.path || "";
				if (currentDir) {
					const testPath = `${currentDir}/${imagePath}`;
					file = this.app.vault.getAbstractFileByPath(testPath);
					if (file instanceof TFile) {
						return testPath;
					}
				}
				
				// 整个 vault 中搜索
				const allFiles = this.app.vault.getFiles();
				const matchingFile = allFiles.find((f) => f.name === imagePath);
				if (matchingFile) {
					return matchingFile.path;
				}
			}
			
			return null;
		} catch (error) {
			console.error(`解析图片路径时出错: ${imagePath}`, error);
			return null;
		}
	}

	/**
	 * 解析相对路径
	 */
	private resolveRelativePath(
		basePath: string,
		relativePath: string
	): string {
		const baseParts = basePath ? basePath.split("/").filter((p) => p) : [];
		const relativeParts = relativePath.split("/").filter((p) => p);

		const resolvedParts = [...baseParts];

		for (const part of relativeParts) {
			if (part === "..") {
				resolvedParts.pop();
			} else if (part !== ".") {
				resolvedParts.push(part);
			}
		}

		return resolvedParts.join("/");
	}

	/**
	 * 替换文档中的图片路径
	 */
	private replaceImageUrls(content: string, downloadedPaths: Map<string, string>): string {
		// 首先处理被链接包装的图片格式 [![](url)](url)
		// 这种格式会被转换为简单的图片格式 ![](local_path)
		let updatedContent = content.replace(
			/\[!\[(.*?)\]\((http[^)]+)\)\]\([^)]+\)/g,
			(match, alt, url) => {
				const downloadedPath = downloadedPaths.get(url);
				if (!downloadedPath) return match;

				if (this.settings.style === "wiki") {
					return alt
						? `![[${downloadedPath}|${alt}]]`
						: `![[${downloadedPath}]]`;
				} else {
					// Markdown 格式下对路径进行编码
					const encodedPath = downloadedPath.replace(/ /g, "%20");
					return `![${alt}](${encodedPath})`;
				}
			}
		);

		// 然后处理简单的图片格式 ![](url)
		return updatedContent.replace(
			/!\[(.*?)\]\((http[^)]+)\)/g,
			(match, alt, url) => {
				const downloadedPath = downloadedPaths.get(url);
				if (!downloadedPath) return match;

				if (this.settings.style === "wiki") {
					return alt
						? `![[${downloadedPath}|${alt}]]`
						: `![[${downloadedPath}]]`;
				} else {
					// Markdown 格式下对路径进行编码
					const encodedPath = downloadedPath.replace(/ /g, "%20");
					return `![${alt}](${encodedPath})`;
				}
			}
		);
	}

	private replaceImagePaths(content: string, pathsMap: Map<string, string>): string {
		let updatedContent = content;

		for (const [oldPath, newPath] of pathsMap) {
			// 替换 Obsidian 格式
			const obsidianPattern = new RegExp(
				`!\\[\\[${this.escapeRegExp(oldPath)}(\\|[^\\]]+)?\\]\\]`,
				"g"
			);
			updatedContent = updatedContent.replace(
				obsidianPattern,
				(match, altPart) => {
					if (this.settings.style === "wiki") {
						return `![[${newPath}${altPart || ""}]]`;
					} else {
						const alt = altPart ? altPart.substring(1) : "";
						return alt
							? `![${alt}](${newPath.replace(/ /g, "%20")})`
							: `![](${newPath.replace(/ /g, "%20")})`;
					}
				}
			);

			// 替换 Markdown 格式（处理编码和未编码的空格）
			const encodedOldPath = oldPath.replace(/ /g, "%20");
			const markdownPattern1 = new RegExp(
				`!\\[([^\\]]*)\\]\\(${this.escapeRegExp(encodedOldPath)}\\)`,
				"g"
			);
			const markdownPattern2 = new RegExp(
				`!\\[([^\\]]*)\\]\\(${this.escapeRegExp(oldPath)}\\)`,
				"g"
			);

			updatedContent = updatedContent.replace(
				markdownPattern1,
				(match, alt) => {
					if (this.settings.style === "wiki") {
						return alt
							? `![[${newPath}|${alt}]]`
							: `![[${newPath}]]`;
					} else {
						return `![${alt}](${newPath.replace(/ /g, "%20")})`;
					}
				}
			);

			updatedContent = updatedContent.replace(
				markdownPattern2,
				(match, alt) => {
					if (this.settings.style === "wiki") {
						return alt
							? `![[${newPath}|${alt}]]`
							: `![[${newPath}]]`;
					} else {
						return `![${alt}](${newPath.replace(/ /g, "%20")})`;
					}
				}
			);
		}

		return updatedContent;
	}



	/**
	 * 处理单个图片链接
	 */
	private async processSingleImage(
		lineText: string,
		editor: Editor,
		lineNumber: number
	): Promise<void> {
		try {
			const activeFile = this.app.workspace.getActiveFile();
			if (!activeFile) {
				new Notice("当前没有打开的文档！");
				return;
			}

			// 提取图片URL
			let imageUrl = "";
			let fullMatch = "";

			// 检测 Markdown 格式
			const markdownMatch = lineText.match(/!\[.*?\]\((http[^)]+)\)/);
			if (markdownMatch) {
				imageUrl = markdownMatch[1];
				fullMatch = markdownMatch[0];
			}

			// 检测被链接包装的格式
			if (!imageUrl) {
				const linkWrappedMatch = lineText.match(
					/\[!\[.*?\]\((http[^)]+)\)\]\([^)]+\)/
				);
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
			const isWebp = imageUrl.toLowerCase().includes("webp");

			if (isWebp) {
				// 尝试从 frontmatter 获取 referer
				await this.app.fileManager.processFrontMatter(
					activeFile,
					(frontmatter) => {
						for (const key in frontmatter) {
							if (
								typeof frontmatter[key] === "string" &&
								(frontmatter[key]
									.toLowerCase()
									.startsWith("http://") ||
									frontmatter[key]
										.toLowerCase()
										.startsWith("https://"))
							) {
								referer = frontmatter[key];
							}
						}
					}
				);

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
					const modal = new RefererModal(
						this.app,
						async (modalReferer) => {
							await this.downloadAndReplaceSingleImage(
								imageUrl,
								modalReferer,
								fullMatch,
								editor,
								lineNumber
							);
						}
					);
					modal.open();
					return;
				}
			}

			await this.downloadAndReplaceSingleImage(
				imageUrl,
				referer,
				fullMatch,
				editor,
				lineNumber
			);
		} catch (error) {
			console.error("处理单个图片时出错:", error);
			new Notice(
				`处理失败: ${error instanceof Error ? error.message : "未知错误"
				}`
			);
		}
	}

	/**
	 * 下载并替换单个图片
	 */
	private async downloadAndReplaceSingleImage(
		imageUrl: string,
		referer: string,
		originalMatch: string,
		editor: Editor,
		lineNumber: number
	): Promise<void> {
		try {
			// 获取下载目录
			const attachmentPath = await this.app.fileManager.getAvailablePathForAttachment("");
			this.downloadDir = normalizePath(attachmentPath.split("/").slice(0, -1).join("/"));

			// 下载图片
			const isWebp = imageUrl.toLowerCase().includes("webp");
			const isGif = imageUrl.toLowerCase().includes("gif");

			let downloadedFileName: string | null;

			if (isWebp && referer) {
				downloadedFileName = (await DownloadImage(this.app, imageUrl, referer)) ?? null;
			} else {
				downloadedFileName = (await DownloadImage(this.app, imageUrl, "")) ?? null;
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
				const originalFormat = downloadedFileName.split(".").pop();
				const targetFormat = this.settings.format.toLowerCase() === "jpeg" ? "jpg" : "png";

				if (originalFormat !== targetFormat) {
					const processedBuffer = await this.processImage(fileBuffer);
					const extension = targetFormat;
					const processedFileName = downloadedFileName.replace(
						/\.[^/.]+$/,
						`.${extension}`
					);
					const processedPath = `${this.downloadDir}/${processedFileName}`;

					await this.app.vault.createBinary(
						processedPath,
						processedBuffer
					);
					await this.app.vault.delete(file);
					finalPath = processedPath;
				}
			}

			// 替换当前行中的图片链接
			const normalizedPath = normalizePath(finalPath);

			// 提取原始的 alt 文本
			const altMatch = originalMatch.match(/!\[(.*?)\]/);
			const altText = altMatch ? altMatch[1] : "";

			let replacementText = "";
			if (this.settings.style === "wiki") {
				replacementText = altText
					? `![[${normalizedPath}|${altText}]]`
					: `![[${normalizedPath}]]`;
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
			console.error("下载和替换图片时出错:", error);
			new Notice(
				`处理失败: ${error instanceof Error ? error.message : "未知错误"
				}`
			);
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
				const encodedPath = path.replace(/ /g, "%20");
				return alt
					? `![${alt}](${encodedPath})`
					: `![](${encodedPath})`;
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
				const decodedPath = path.replace(/%20/g, " ");
				return alt
					? `![[${decodedPath}|${alt}]]`
					: `![[${decodedPath}]]`;
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
	 * 提取内容中的所有图片链接
	 */
	private extractAllImageLinks(content: string): string[] {
		const links: string[] = [];

		// Obsidian 格式: ![[image.jpg]] 或 ![[image.jpg|alt]]
		const obsidianMatches = content.match(
			/!\[\[[^\]]+\.(png|jpg|jpeg|gif|bmp|svg|webp)(?:\|[^\]]+)?\]\]/gi
		);
		if (obsidianMatches) {
			links.push(...obsidianMatches);
		}

		// Markdown 格式: ![alt](image.jpg)
		const markdownMatches = content.match(
			/!\[[^\]]*\]\([^)]+\.(png|jpg|jpeg|gif|bmp|svg|webp)\)/gi
		);
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
			if (!link || typeof link !== "string" || link.trim() === "") {
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
				const path = markdownMatch[1].replace(/%20/g, " ").trim(); // 解码空格
				return path || null;
			}

			return null;
		} catch (error) {
			console.error(
				`Error extracting image path from link: ${link}`,
				error
			);
			return null;
		}
	}

	/**
	 * 更新内容中的图片链接
	 */
	private updateImageLinksInContent(
		content: string,
		renamedImages: Map<string, string>
	): string {
		let updatedContent = content;

		for (const [oldPath, newPath] of renamedImages) {
			// 更新 Obsidian 格式的链接
			const obsidianPattern = new RegExp(
				`!\\[\\[${this.escapeRegExp(oldPath)}(\\|[^\\]]+)?\\]\\]`,
				"g"
			);
			updatedContent = updatedContent.replace(
				obsidianPattern,
				(match, altPart) => {
					return `![[${newPath}${altPart || ""}]]`;
				}
			);

			// 更新 Markdown 格式的链接（处理编码的空格）
			const encodedOldPath = oldPath.replace(/ /g, "%20");
			const encodedNewPath = newPath.replace(/ /g, "%20");
			const markdownPattern = new RegExp(
				`!\\[([^\\]]*)\\]\\(${this.escapeRegExp(encodedOldPath)}\\)`,
				"g"
			);
			updatedContent = updatedContent.replace(
				markdownPattern,
				`![$1](${encodedNewPath})`
			);

			// 也处理未编码的情况
			const markdownPattern2 = new RegExp(
				`!\\[([^\\]]*)\\]\\(${this.escapeRegExp(oldPath)}\\)`,
				"g"
			);
			updatedContent = updatedContent.replace(
				markdownPattern2,
				`![$1](${newPath})`
			);
		}

		return updatedContent;
	}




	private async handleImagePaste(file: File, editor: Editor): Promise<void> {
		try {
			// 获取当前文件名作为基础
			const curFileName = this.app.workspace.getActiveFile()?.name;
			const curFileNameWithoutExt = curFileName
				? curFileName.split(".").slice(0, -1).join(".")
				: "image";

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
			const extension = this.settings.format.toLowerCase() === "jpeg" ? ".jpg" : ".png";
			const fileName = `${curFileNameWithoutExt}_${randomStr}${extension}`;

			// 读取和处理图片
			const buffer = await file.arrayBuffer();
			const processedBuffer = await this.processImage(buffer);

			// 获取附件路径并保存
			const filePath = await this.app.fileManager.getAvailablePathForAttachment(fileName);
			await this.app.vault.createBinary(filePath, processedBuffer);

			// 如果有选中的文本，使用它作为图片描述
			const selectedText = editor.getSelection();

			let pasteLink: string;
			if (this.settings.style == "wiki") {
				pasteLink = selectedText
					? `![[${filePath}|${selectedText}]]`
					: `![[${filePath}]]`;
			} else {
				const markdownLink = selectedText
					? `![${selectedText}](${filePath})`
					: `![](${filePath})`;
				pasteLink = markdownLink.replace(/ /g, "%20");
			}

			editor.replaceSelection(pasteLink);

			new Notice(`Image processed and saved as ${fileName}`);
		} catch (error) {
			console.error("Error processing pasted image:", error);
			new Notice("Failed to process pasted image");
		}
	}

	/**
	 * 处理文件重命名事件
	 * 当 markdown 文件重命名时，自动更新相关图片文件的名称
	 */
	private async handleFileRename(file: TAbstractFile, oldPath: string) {
		try {
			// 只处理 TFile 类型的 markdown 文件
			if (!(file instanceof TFile) || !file.name.endsWith(".md")) {
				return;
			}

			const newPath = file.path;
			console.log(`File renamed from ${oldPath} to ${newPath}`);

			// 获取旧文件名和新文件名（不含扩展名和路径）
			const oldFileName = oldPath.split("/").pop()?.replace(/\.md$/, "") || "";
			const newFileName = newPath.split("/").pop()?.replace(/\.md$/, "") || "";

			if (!oldFileName || !newFileName || oldFileName === newFileName) {
				return;
			}

			// 延迟处理，确保文件重命名操作完全完成
			setTimeout(async () => {
				await this.handleImageRenameAfterFileRename(
					file,
					oldFileName,
					newFileName
				);
			}, 100);
		} catch (error) {
			console.error("处理文件重命名时出错:", error);
			new Notice(
				`处理文件重命名失败: ${error instanceof Error ? error.message : "未知错误"
				}`
			);
		}
	}

	/**
	 * 在文件重命名完成后处理图片重命名
	 */
	private async handleImageRenameAfterFileRename(
		file: TFile,
		oldFileName: string,
		newFileName: string
	) {
		try {
			// 读取文件内容
			const content = await this.app.vault.read(file);

			// 查找文件中的所有本地图片链接（排除网络图片）
			const imageLinks = this.extractAllImageLinks(content).filter(
				(link) => {
					const imagePath = this.extractImagePathFromLink(link);
					return imagePath && !imagePath.startsWith("http");
				}
			);

			if (imageLinks.length === 0) {
				console.debug(`No image links found in ${file.name}`);
				return;
			}

			console.debug(
				`Found ${imageLinks.length} image links in ${file.name}`
			);
			const renamedImages = new Map<string, string>();
			let hasChanges = false;

			for (const link of imageLinks) {
				try {
					const imagePath = this.extractImagePathFromLink(link);
					if (
						!imagePath ||
						typeof imagePath !== "string" ||
						imagePath.trim() === ""
					) {
						console.debug(
							`Skipping invalid image path: ${imagePath}`
						);
						continue;
					}

					// 安全地获取图片文件名
					const pathParts = imagePath.split("/");
					const imageFileName = pathParts[pathParts.length - 1];
					if (!imageFileName || imageFileName.trim() === "") {
						console.debug(
							`Skipping invalid image filename from path: ${imagePath}`
						);
						continue;
					}

					// 安全地获取文件名（不含扩展名）
					const lastDotIndex = imageFileName.lastIndexOf(".");
					if (lastDotIndex === -1) {
						console.debug(
							`Skipping file without extension: ${imageFileName}`
						);
						continue;
					}

					const imageNameWithoutExt = imageFileName.substring(
						0,
						lastDotIndex
					);
					const extension = imageFileName.substring(lastDotIndex + 1);

					if (!imageNameWithoutExt || !extension) {
						console.debug(
							`Skipping invalid filename parts: ${imageFileName}`
						);
						continue;
					}

					// 检查用户是否禁用了自动重命名功能
					if (!this.settings.fileRenameEnabled) {
						console.debug("File rename is disabled");
						continue;
					}

					console.debug(`Processing image: ${imageFileName}`);

					// 处理所有图片，不再检查特定的命名模式
					let randomStr = "";

					// 尝试从现有文件名中提取随机字符串
					const existingRandomMatch =
						imageNameWithoutExt.match(/_([a-z0-9]{5})$/);
					if (existingRandomMatch) {
						randomStr = existingRandomMatch[1];
						console.debug(
							`Found existing random string: ${randomStr}`
						);
					} else {
						// 如果没有找到随机字符串，生成一个新的
						const chars =
							"abcdefghijklmnopqrstuvwxyz123456789".split("");
						randomStr = Array(5)
							.fill(0)
							.map(
								() =>
									chars[
									Math.floor(Math.random() * chars.length)
									]
							)
							.join("");
						console.debug(
							`Generated new random string: ${randomStr}`
						);
					}

					// 首先解析图片的实际路径
					const resolvedImagePath = await this.resolveImagePath(
						imagePath,
						file
					);
					if (!resolvedImagePath) {
						console.debug(`无法解析图片路径: ${imagePath}`);
						continue;
					}

					// 检查图片文件是否存在
					const imageFile =
						this.app.vault.getAbstractFileByPath(resolvedImagePath);
					if (!(imageFile instanceof TFile)) {
						console.debug(`图片文件未找到: ${resolvedImagePath}`);
						continue;
					}

					// 生成新的图片文件名
					const newImageFileName = `${newFileName}_${randomStr}.${extension}`;

					// 获取解析后路径的目录部分
					const resolvedPathParts = resolvedImagePath.split("/");
					resolvedPathParts[resolvedPathParts.length - 1] =
						newImageFileName;
					const newResolvedImagePath = resolvedPathParts.join("/");

					try {
						await this.app.fileManager.renameFile(
							imageFile,
							newResolvedImagePath
						);
						renamedImages.set(imagePath, newResolvedImagePath);
						hasChanges = true;
						console.log(
							`Renamed image: ${resolvedImagePath} -> ${newResolvedImagePath}`
						);
					} catch (renameError) {
						console.error(
							`Failed to rename image ${resolvedImagePath}:`,
							renameError
						);
						new Notice(`重命名图片失败: ${imageFileName}`);
					}
				} catch (linkError) {
					console.error(
						`Error processing image link ${link}:`,
						linkError
					);
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
					console.error("更新文件内容失败:", updateError);
					new Notice("更新文件内容失败");
				}
			} else {
				console.debug("No images were renamed");
			}
		} catch (error) {
			console.error("处理图片重命名时出错:", error);
			new Notice(
				`处理图片重命名失败: ${error instanceof Error ? error.message : "未知错误"
				}`
			);
		}
	}

	/**
	 * 转义正则表达式特殊字符
	 */
	private escapeRegExp(string: string): string {
		return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	private randomSuffix(): string {
		const chars = "abcdefghijklmnopqrstuvwxyz123456789";
		return Array(5).fill(0).map(() => chars[Math.floor(Math.random() * chars.length)]).join("");
	}


	/**
	 * 检测当前行文本是否包含图片链接
	 */
	private isImageLink(text: string): boolean {
		if (!text.trim()) return false;

		// 检测 Markdown 格式的图片链接: ![alt](url)
		const markdownImageRegex =
			/!\[.*?\]\((http[^)]+\.(png|jpg|jpeg|gif|bmp|svg|webp))\)/i;

		// 检测 Obsidian 格式的图片链接: ![[filename]]
		const obsidianImageRegex =
			/!\[\[.+\.(png|jpg|jpeg|gif|bmp|svg|webp)(?:\|[^\]]+)?\]\]/i;

		// 检测被链接包装的图片格式: [![alt](url)](url)
		const linkWrappedImageRegex =
			/\[!\[.*?\]\((http[^)]+\.(png|jpg|jpeg|gif|bmp|svg|webp))\)\]\([^)]+\)/i;

		return (
			markdownImageRegex.test(text) ||
			obsidianImageRegex.test(text) ||
			linkWrappedImageRegex.test(text)
		);
	}

	private isImagePathFormat(file: TFile, imagePath: string): boolean {
		const targetExt = this.settings.format.toLowerCase() === "jpeg" ? ".jpg" : `.${this.settings.format.toLowerCase()}`;
		const expectedPrefix = `${file.basename}_`;

		if (!imagePath.startsWith(expectedPrefix) || !imagePath.endsWith(targetExt)) return false;

		const randomPart = imagePath.slice(expectedPrefix.length, -targetExt.length);
		return /^[a-z0-9]{5}$/.test(randomPart);
	}

	private isAnimatedWebP(buffer: ArrayBuffer): boolean {
		const bytes = new Uint8Array(buffer);

		// RIFF WebP 文件头检查
		const riff = new TextDecoder().decode(bytes.slice(0, 4));
		const webp = new TextDecoder().decode(bytes.slice(8, 12));

		if (riff !== "RIFF" || webp !== "WEBP") return false;

		// 检查是否包含 ANIM/ANMF chunk
		const text = new TextDecoder().decode(bytes);
		return text.includes("ANIM") || text.includes("ANMF");
	}

	private tryToGetReferer(file: TFile): string {
		// 尝试自动获取 referer
		let referer = "";
		// 尝试从 frontmatter 获取 referer
		this.app.fileManager.processFrontMatter(file, (frontmatter) => {
				for (const key in frontmatter) {
					if (typeof frontmatter[key] === "string" && (frontmatter[key].toLowerCase().startsWith("http://") || frontmatter[key].toLowerCase().startsWith("https://"))) {
						console.debug(`Found Referer from frontmatter. ${key}: ${frontmatter[key]}`);
						referer = frontmatter[key];
					}
				}
			}
		);

		// 如果 frontmatter 中没有 referer，从正文前200行中查找
		if (!referer) {
			const first200Chars = this.content.slice(0, 200);
			const urlMatch = first200Chars.match(/https?:\/\/[^\s]+/);
			if (urlMatch) {
				referer = urlMatch[0];
				console.debug("Found Referer from content:", referer);
			}
		}

		return referer;
	}

	async checkImageHotlink(url: string): Promise<HotlinkCheckResult> {
		return new Promise((resolve) => {
			const lib = url.startsWith("https") ? https : http;

			const req = lib.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
				const { statusCode, headers } = res;

				if (!statusCode || statusCode >= 400) {
					resolve({
						isHotlinkProtected: true,
						reason: `HTTP status code ${statusCode}`,
					});
					res.resume();
					return;
				}

				const contentType = headers["content-type"] || "";
				if (!contentType.startsWith("image/") && contentType !== "application/octet-stream") {
					resolve({
						isHotlinkProtected: true,
						reason: `Content-Type is ${contentType}`,
					});
					res.resume();
					return;
				}

				// 读取前几个字节判断文件头
				const chunks: Buffer[] = [];
				let done = false;
				res.on("data", (chunk: Buffer) => {
					if (done) return;
					chunks.push(chunk);
					const buf = Buffer.concat(chunks);
					if (buf.length >= 12) {
						done = true;
						const magic = buf.slice(0, 12);

						const isValidImage =
							magic.slice(0, 3).toString("hex") === "ffd8ff" || // JPEG
							magic.slice(0, 4).toString() === "\x89PNG" ||     // PNG
							magic.slice(0, 3).toString() === "GIF" ||         // GIF
							magic.slice(0, 4).toString() === "RIFF";          // WebP

						if (!isValidImage) {
							resolve({
								isHotlinkProtected: true,
								reason: "File header not recognized as image",
							});
						} else {
							resolve({ isHotlinkProtected: false, reason: "OK" });
						}
						res.destroy();
					}
				});

				res.on("end", () => {
					if (!done) {
						resolve({ isHotlinkProtected: false, reason: "OK" });
					}
				});

				res.on("error", (err) => {
					resolve({
						isHotlinkProtected: true,
						reason: `Network error: ${err.message}`,
					});
				});
			});

			req.on("error", (err) => {
				resolve({
					isHotlinkProtected: true,
					reason: `Request error: ${err.message}`,
				});
			});
		});
	}
}
