import { App, TFile } from 'obsidian';
import ImageProcessorPlugin from './main';
import { getAllLinkMatchesInFile, LinkMatch } from './linkDetector';

/* ------------------ Image Handlers  ------------------ */

const imageRegex = /.*(jpe?g|png|gif|svg|bmp|webp|avif)/i;
const bannerRegex = /!\[\[(.*?)\]\]/i;
const imageExtensions: Set<string> = new Set(['jpeg', 'jpg', 'png', 'gif', 'svg', 'bmp', 'webp', 'avif']);

// Create the List of Unused Images
export const getUnusedAttachments = async (
    app: App,
    type: 'image' | 'all',
    plugin?: ImageProcessorPlugin
): Promise<TFile[]> => {
    const allAttachmentsInVault: TFile[] =
        getAttachmentsInVault(app, type, plugin);

    const unusedAttachments: TFile[] = [];

    const usedAttachmentsSet =
        await getAttachmentPathSetForVault(app);

    for (const attachment of allAttachmentsInVault) {
        if (!usedAttachmentsSet.has(attachment.path)) {
            unusedAttachments.push(attachment);
        }
    }

    return unusedAttachments;
};


// Getting all available images saved in vault
const getAttachmentsInVault = (
    app: App,
    type: 'image' | 'all',
    plugin?: ImageProcessorPlugin
): TFile[] => {
    const allFiles = app.vault.getFiles();
    const attachments: TFile[] = [];

    const excludedExtArr =
        plugin?.settings?.excludedExtensions
            ?.split(',')
            .map(ext => ext.trim().toLowerCase()) ?? [];

    for (const file of allFiles) {
        const fileExt = file.extension.toLowerCase();

        if (
            excludedExtArr.includes(fileExt) ||
            ['md', 'canvas', 'base'].includes(fileExt)
        ) {
            continue;
        }

        if (imageExtensions.has(fileExt)) {
            attachments.push(file);
        } else if (type === 'all') {
            attachments.push(file);
        }
    }

    return attachments;
};

// New Method for Getting All Used Attachments
const getAttachmentPathSetForVault = async (app: App): Promise<Set<string>> => {
    var attachmentsSet: Set<string> = new Set();
    var resolvedLinks = app.metadataCache.resolvedLinks;
    if (resolvedLinks) {
        for (const [mdFile, links] of Object.entries(resolvedLinks)) {
            for (const [filePath, nr] of Object.entries(resolvedLinks[mdFile])) {
                if (!(filePath as String).endsWith('.md')) {
                    attachmentsSet.add(filePath);
                }
            }
        }
    }
    // Loop Files and Check Frontmatter/Canvas
    let allFiles = app.vault.getFiles();
    for (let i = 0; i < allFiles.length; i++) {
        let obsFile = allFiles[i];
        // Check Frontmatter for md files and additional links that might be missed in resolved links
        if (obsFile.extension === 'md') {
            const fileCache = app.metadataCache.getFileCache(obsFile);
            if (!fileCache?.frontmatter) continue;
        
            const frontmatter = fileCache.frontmatter;
        
            for (const k of Object.keys(frontmatter)) {
                const value = frontmatter[k];
                if (typeof value !== 'string') continue;
        
                if (bannerRegex.test(value)) {
                    const match = value.match(bannerRegex);
                    if (!match) continue;
        
                    const file = app.metadataCache.getFirstLinkpathDest(
                        match[1],
                        obsFile.path
                    );
                    if (file) addToSet(attachmentsSet, file.path);
                } else if (pathIsAnImage(value)) {
                    addToSet(attachmentsSet, value);
                }
            }
        
            const linkMatches: LinkMatch[] = await getAllLinkMatchesInFile(obsFile, app);
            for (const linkMatch of linkMatches) {
                addToSet(attachmentsSet, linkMatch.linkText);
            }
        }        
        // Check Canvas for links
        else if (obsFile.extension === 'canvas') {
            let fileRead = await app.vault.cachedRead(obsFile);
        
            if (!fileRead) {
                console.warn('Empty canvas file:', obsFile.path);
                continue;
            }
        
            let canvasData;
            try {
                canvasData = JSON.parse(fileRead);
            } catch (e) {
                console.error('Invalid canvas JSON:', obsFile.path, fileRead, e);
                continue;
            }
        
            if (Array.isArray(canvasData.nodes)) {
                for (const node of canvasData.nodes) {
                    if (node.type === 'file') {
                        addToSet(attachmentsSet, node.file);
                    } else if (node.type === 'text') {
                        let linkMatches: LinkMatch[] =
                            await getAllLinkMatchesInFile(obsFile, app, node.text);
                        for (let linkMatch of linkMatches) {
                            addToSet(attachmentsSet, linkMatch.linkText);
                        }
                    }
                }
            }
        }
    }
    return attachmentsSet;
};

const pathIsAnImage = (path: string) => {
    return path.match(imageRegex);
};

/* ------------------ Deleting Handlers  ------------------ */

// Clear Images From the Provided List
export const deleteFilesInTheList = async (
    fileList: TFile[],
    plugin: ImageProcessorPlugin,
    app: App
): Promise<{ deletedImages: number; textToView: string }> => {
    var deleteOption = plugin.settings.deleteOption;
    var deletedImages = 0;
    let textToView = '';
    for (let file of fileList) {
        if (fileIsInExcludedFolder(file, plugin)) {
            console.log('File not referenced but excluded: ' + file.path);
        } else {
            if (deleteOption === '.trash') {
                await app.vault.trash(file, false);
                textToView += `<span style="color:#ef4444">` + `[+] Moved to Obsidian Trash: ` + file.path + '</br>';
            } else if (deleteOption === 'system-trash') {
                await app.vault.trash(file, true);
                textToView += `<span style="color:#ef4444">` + `[+] Moved to System Trash: ` + file.path + '</br>';
            } else if (deleteOption === 'permanent') {
                await app.vault.delete(file);
                textToView += `<span style="color:#ef4444">` + `[+] Deleted Permanently: ` + file.path + '</br>';
            }
            deletedImages++;
        }
    }
    return { deletedImages, textToView };
};

// Check if File is Under Excluded Folders
const fileIsInExcludedFolder = (file: TFile, plugin: ImageProcessorPlugin): boolean => {
    var excludedFoldersSettings = plugin.settings.excludedFolders;
    var excludeSubfolders = plugin.settings.excludeSubfolders;
    if (excludedFoldersSettings === '') {
        return false;
    } else {
        // Get All Excluded Folder Paths
        const excludedFolderPaths = new Set(
            excludedFoldersSettings.split(',').map((folderPath: string) => folderPath.trim())
        );

        if (excludeSubfolders) {
            // If subfolders included, check if any provided path partially match
            for (let exludedFolderPath of excludedFolderPaths) {
                var pathRegex = new RegExp(exludedFolderPath + '.*');
                if (file.parent && file.parent.path && file.parent.path.match(pathRegex)) {
                    return true;
                }
            }
        } else {
            // Full path of parent should match if subfolders are not included
            if (file.parent && file.parent.path && excludedFolderPaths.has(file.parent.path)) {
                return true;
            }
        }

        return false;
    }
};

/* ------------------ Helpers  ------------------ */

export const getFormattedDate = () => {
    let dt = new Date();
    return dt.toLocaleDateString('en-GB', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
};

const addToSet = (setObj: Set<string>, value: string) => {
    if (!setObj.has(value)) {
        setObj.add(value);
    }
};
