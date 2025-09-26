
type ResizeMode = 'None' | 'Fit';
type ImageFormat = 'JPEG' | 'PNG';

export class ImageProcessor {
    /**
     * 转换并压缩图片
     */
    async convertAndCompress(
        file: Blob,
        format: ImageFormat,
        quality: number = 0.8,
        colorDepth: number = 1
    ): Promise<ArrayBuffer> {
        switch (format) {
            case 'JPEG':
                return this.convertToJPG(file, quality);
            case 'PNG':
                return this.convertToPNG(file, colorDepth);
            default:
                return file.arrayBuffer();
        }
    }

    /**
     * 调整图片大小
     */
    async resizeImage(
        file: Blob,
        resizeMode: ResizeMode = 'None',
        desiredWidth: number = 800,
        desiredHeight: number = 600
    ): Promise<ArrayBuffer> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const { width: imageWidth, height: imageHeight } = this.calculateDimensions(
                        img,
                        resizeMode,
                        desiredWidth,
                        desiredHeight
                    );

                    const canvas = document.createElement('canvas');
                    canvas.width = imageWidth;
                    canvas.height = imageHeight;

                    const ctx = canvas.getContext('2d');
                    if (!ctx) {
                        reject(new Error('Failed to get canvas context'));
                        return;
                    }

                    ctx.drawImage(img, 0, 0, imageWidth, imageHeight);

                    canvas.toBlob(
                        async (blob) => {
                            if (!blob) {
                                reject(new Error('Failed to create blob'));
                                return;
                            }
                            resolve(await blob.arrayBuffer());
                        },
                        file.type
                    );
                };
                img.onerror = () => reject(new Error('Failed to load image'));
                img.src = e.target?.result as string;
            };
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
        });
    }

    public async convertToJPG(file: Blob, quality: number): Promise<ArrayBuffer> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth;
                    canvas.height = img.naturalHeight;

                    const ctx = canvas.getContext('2d', { alpha: false });
                    if (!ctx) {
                        reject(new Error('Failed to get canvas context'));
                        return;
                    }

                    ctx.drawImage(img, 0, 0);

                    canvas.toBlob(
                        async (blob) => {
                            if (!blob) {
                                reject(new Error('Failed to create blob'));
                                return;
                            }
                            resolve(await blob.arrayBuffer());
                        },
                        'image/jpeg',
                        quality
                    );
                };
                img.onerror = () => reject(new Error('Failed to load image'));
                img.src = e.target?.result as string;
            };
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
        });
    }

    public async convertToPNG(file: Blob, colorDepth: number): Promise<ArrayBuffer> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth;
                    canvas.height = img.naturalHeight;

                    const ctx = canvas.getContext('2d', { alpha: true });
                    if (!ctx) {
                        reject(new Error('Failed to get canvas context'));
                        return;
                    }

                    ctx.drawImage(img, 0, 0);

                    canvas.toBlob(
                        async (blob) => {
                            if (!blob) {
                                reject(new Error('Failed to create blob'));
                                return;
                            }
                            resolve(await blob.arrayBuffer());
                        },
                        'image/png'
                    );
                };
                img.onerror = () => reject(new Error('Failed to load image'));
                img.src = e.target?.result as string;
            };
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
        });
    }

    /**
     * 压缩图片但保持原始格式
     */
    public async compressOriginalImage(
        file: Blob,
        quality: number,
        resizeMode: ResizeMode = 'None',
        desiredWidth: number = 800,
        desiredHeight: number = 600,
        desiredLongestEdge: number = 1000,
        enlargeOrReduce: 'Auto' | 'Reduce' | 'Enlarge' = 'Auto'
    ): Promise<ArrayBuffer> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth;
                    canvas.height = img.naturalHeight;

                    const ctx = canvas.getContext('2d', {
                        alpha: file.type.includes('png')  // PNG保留透明度
                    });
                    
                    if (!ctx) {
                        reject(new Error('Failed to get canvas context'));
                        return;
                    }

                    ctx.drawImage(img, 0, 0);

                    // 使用原始文件类型
                    canvas.toBlob(
                        async (blob) => {
                            if (!blob) {
                                reject(new Error('Failed to create blob'));
                                return;
                            }
                            resolve(await blob.arrayBuffer());
                        },
                        file.type,  // 保持原始类型
                        file.type.includes('jpeg') ? quality : undefined  // 仅对JPEG应用质量参数
                    );
                };
                img.onerror = () => reject(new Error('Failed to load image'));
                img.src = e.target?.result as string;
            };
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsDataURL(file);
        });
    }

    private calculateDimensions(
        image: HTMLImageElement,
        resizeMode: ResizeMode,
        desiredWidth: number,
        desiredHeight: number
    ): { width: number; height: number } {
        if (resizeMode === 'None') {
            return {
                width: image.naturalWidth,
                height: image.naturalHeight
            };
        }

        const aspectRatio = image.naturalWidth / image.naturalHeight;

        if (aspectRatio > desiredWidth / desiredHeight) {
            return {
                width: desiredWidth,
                height: desiredWidth / aspectRatio
            };
        } else {
            return {
                width: desiredHeight * aspectRatio,
                height: desiredHeight
            };
        }
    }
}