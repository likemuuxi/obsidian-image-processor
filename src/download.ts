import { Notice, App } from "obsidian";
import * as https from "https";
import * as fs from "fs";


export async function DownloadImage(app: App, url: string, referer: string): Promise<string> {
    try {
        const result = referer
            ? await downloadWithReferer(app, encodeURI(url), referer)
            : await downloadNormalImage(app, encodeURI(url));
        
        if (!result) {
            throw new Error("Failed to download image");
        }
        return result;
    } catch (error) {
        console.warn("Download error:", error);
        throw error; // 向上传递错误，让调用者处理
    }
}

async function downloadNormalImage(app: App, url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const request = https.get(url, {
            headers: {
                'Accept': 'image/*',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        }, async (response) => {
            try {
                const contentType = response.headers["content-type"] || "";
                if (!contentType.startsWith('image/')) {
                    reject(new Error("Not an image file"));
                    return;
                }

                const extension = getExtensionFromContentType(contentType, url);
                const fileName = await generateFileName(app, extension);
                const buffer = await streamToBuffer(response);

                // 用更智能的方式验证图片文件
                if (!isValidImageBuffer(buffer, contentType)) {
                    reject(new Error("Invalid image file"));
                    return;
                }

                const filePath = await app.fileManager.getAvailablePathForAttachment(fileName);
                await app.vault.createBinary(filePath, buffer);
                resolve(fileName);
            } catch (error) {
                reject(error);
            }
        });

        request.on('error', reject);
    });
}

async function downloadWithReferer(app: App, url: string, referer: string): Promise<string> {
    const options = {
        headers: {
            Accept: "*/*",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
            Referer: referer ? encodeURI(referer) : "",
        },
    };

    return new Promise((resolve, reject) => {
        https.get(url, options, async (response) => {
            let data: Buffer[] = [];
            const contentType = response.headers["content-type"] || "application/octet-stream";
            let extension = "";

            const typeMap: { [key: string]: string } = {
                jpeg: ".jpg",
                jpg: ".jpg",
                png: ".png",
                gif: ".gif",
                webp: ".webp",
                "svg+xml": ".svg",
                tiff: ".tiff",
                bmp: ".bmp",
                ico: ".ico",
                avif: ".avif",
                heic: ".heic",
                heif: ".heif",
            };

            const type = contentType.split("/")[1];
            if (contentType.split("/")[0] === "text") {
                reject(new Error("Remote resource is not image, please check your Referer."));
                return;
            }

            if (typeMap[type]) {
                extension = typeMap[type];
            } else if (url.toLowerCase().includes(".webp") && contentType === "application/octet-stream") {
                extension = ".webp";
            } else {
                console.error("Unsupported file type:", contentType, "for URL:", url);
                reject(new Error("Unsupported file type: " + contentType));
                return;
            }

            response.on("data", (chunk) => {
                data.push(chunk);
            });

            response.on("end", async () => {
                try {
                    const buffer = Buffer.concat(data);
                    // console.debug(`Image file size: ${buffer.length} bytes`);

                    // 用更智能的方式验证图片文件
                    if (!isValidImageBuffer(buffer, contentType)) {
                        reject(new Error("Invalid image file"));
                        return;
                    }

                    const curFileName = app.workspace.getActiveFile()?.name;
                    const curFileNameWithoutExt = curFileName ? curFileName.split(".").slice(0, -1).join(".") : "image";

                    // Remove spaces from filename
                    // const curFileNameWithoutExt = curFileName
                    //   ? curFileName.split(".").slice(0, -1).join(".").replace(/\s+/g, "")
                    //   : "image";

                    const chars = "abcdefghijklmnopqrstuvwxyz123456789".split("");
                    const randomStr = Array(5)
                        .fill(0)
                        .map(() => chars[Math.floor(Math.random() * chars.length)])
                        .join("");
                    const fileName = `${curFileNameWithoutExt}_${randomStr}${extension}`;
                    const filePath = await app.fileManager.getAvailablePathForAttachment(fileName);
                    
                    await app.vault.createBinary(filePath, buffer);
                    resolve(fileName);
                } catch (err) {
                    console.error(`Error processing image[${url}]:`, err.message);
                    reject(err);
                }
            });

            response.on("error", (err) => {
                console.error(`Error downloading image[${url}]:`, err.message);
                reject(err);
            });
        }).on("error", (err) => {
            console.error(`Error initiating request for image[${url}]:`, err.message);
            reject(err);
        });
    });
}

// 辅助函数
function getExtensionFromContentType(contentType: string, url: string): string {
    const typeMap: { [key: string]: string } = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/svg+xml': '.svg',
        'image/tiff': '.tiff',
        'image/bmp': '.bmp',
        'image/x-icon': '.ico',
        'image/avif': '.avif',
        'image/heic': '.heic',
        'image/heif': '.heif'
    };

    const type = contentType.toLowerCase();
    if (typeMap[type]) {
        return typeMap[type];
    }

    // 从 URL 中提取扩展名作为后备
    const urlExt = url.split('.').pop()?.toLowerCase();
    if (urlExt && Object.values(typeMap).includes(`.${urlExt}`)) {
        return `.${urlExt}`;
    }

    return '.jpg'; // 默认扩展名
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => resolve(Buffer.concat(chunks)));
        stream.on('error', reject);
    });
}

async function generateFileName(app: App, extension: string): Promise<string> {
    const curFileName = app.workspace.getActiveFile()?.name;
    const curFileNameWithoutExt = curFileName
        ? curFileName.split(".").slice(0, -1).join(".").replace(/\s+/g, "")
        : "image";
    
    const chars = "abcdefghijkmnpqrstuvwxyz23456789".split("");
    const randomStr = Array(5)
        .fill(0)
        .map(() => chars[Math.floor(Math.random() * chars.length)])
        .join("");
    
    return `${curFileNameWithoutExt}_${randomStr}${extension}`;
}

function isValidImageBuffer(buffer: Buffer, contentType: string): boolean {
    if (buffer.length === 0) {
        return false;
    }

    // SVG 文件可以很小，只需要检查是否为空
    if (contentType.includes('svg')) {
        return buffer.length > 0;
    }

    // 检查常见图片格式的文件头
    const signatures: { [key: string]: number[] } = {
        'image/jpeg': [0xFF, 0xD8, 0xFF],
        'image/png': [0x89, 0x50, 0x4E, 0x47],
        'image/gif': [0x47, 0x49, 0x46],
        'image/webp': [0x52, 0x49, 0x46, 0x46],
        'image/bmp': [0x42, 0x4D],
        'image/tiff': [0x49, 0x49, 0x2A, 0x00], // TIFF little-endian
        'image/x-icon': [0x00, 0x00, 0x01, 0x00],
    };

    // 对于未知类型，如果太小则可能有问题（但放宽限制到100字节）
    if (!signatures[contentType] && buffer.length < 100) {
        return false;
    }

    // 检查文件头签名
    const signature = signatures[contentType];
    if (signature) {
        if (buffer.length < signature.length) {
            return false;
        }
        
        for (let i = 0; i < signature.length; i++) {
            if (buffer[i] !== signature[i]) {
                return false;
            }
        }
    }

    return true;
}