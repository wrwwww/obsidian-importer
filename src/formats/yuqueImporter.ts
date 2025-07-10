import { FormatImporter } from '../format-importer';
import { ImportContext } from '../main';
import { TarEntry, TarReader } from './tarReader';
import { Doc, Meta } from './yuque/model';
import { parseHTML, stringToUtf8 } from '../util';
import {
	nodeBufferToArrayBuffer,
	NodePickedFile,
	parseFilePath,
	PickedFile,
	url as nodeUrl,
	fsPromises,
} from '../filesystem';
import { fixDocumentUrls, getImageSize, parseURL, requestURL } from './html';
import {
	CachedMetadata,
	htmlToMarkdown,
	normalizePath,
	Platform,
	Setting,
	TFile,
	TFolder,
} from 'obsidian';

import { extensionForMime } from 'mime';

import { ZipReader } from '@zip.js/zip.js';

export default class YuqueImporter extends FormatImporter {
	attachmentSizeLimit: number;
	minimumImageSize: number;
	init(): void {
		this.addFileChooserSetting('lakebook', ['lakebook'], true);
		this.addAttachmentSizeLimit(0);
		this.addMinimumImageSize(65); // 65 so that 64×64 are excluded
		this.addOutputLocationSetting('lake import');
	}
	addAttachmentSizeLimit(defaultInMB: number) {
		this.attachmentSizeLimit = defaultInMB * 10 ** 6;
		new Setting(this.modal.contentEl)
			.setName('Attachment size limit (MB)')
			.setDesc('Set 0 to disable.')
			.addText((text) =>
				text
					.then(({ inputEl }) => {
						inputEl.type = 'number';
						inputEl.step = '0.1';
					})
					.setValue(defaultInMB.toString())
					.onChange((value) => {
						const num = ['+', '-'].includes(value)
							? 0
							: Number(value);
						if (Number.isNaN(num) || num < 0) {
							text.setValue(
								(this.attachmentSizeLimit / 10 ** 6).toString()
							);
							return;
						}
						this.attachmentSizeLimit = num * 10 ** 6;
					})
			);
	}

	addMinimumImageSize(defaultInPx: number) {
		this.minimumImageSize = defaultInPx;
		new Setting(this.modal.contentEl)
			.setName('Minimum image size (px)')
			.setDesc('Set 0 to disable.')
			.addText((text) =>
				text
					.then(({ inputEl }) => (inputEl.type = 'number'))
					.setValue(defaultInPx.toString())
					.onChange((value) => {
						const num = ['+', '-'].includes(value)
							? 0
							: Number(value);
						if (!Number.isInteger(num) || num < 0) {
							text.setValue(this.minimumImageSize.toString());
							return;
						}
						this.minimumImageSize = num;
					})
			);
	}

	async import(ctx: ImportContext): Promise<void> {
		const folder = await this.getOutputFolder();

		let outputFolder = folder;
		const { files } = this;
		for (let file of files) {
			ctx.status('Processing ' + file.name);
			await readTar(file, async (e) => {
				let meta: Meta | undefined = undefined;
				let docs: Doc[] = [];

				for (let entry of e) {
					if (ctx.isCancelled()) return;
					let { fullpath, filepath, parent, name, extension } = entry;
					if (extension !== 'json') {
						ctx.reportSkipped(fullpath, 'unknown type of file');
						continue;
					}
					ctx.status('Processing ' + name);
					let text = await entry.readText();
					if (name === '$meta.json') {
						// meta = JSON.parse(text).meta;
						outputFolder = await this.createFolders(
							outputFolder?.path + '/' + file.basename
						);
					} else {
						let doc: Doc = JSON.parse(text).doc;
						docs.push(doc);
						this.processFile(ctx, outputFolder!, file, doc);
					}
					// ctx.reportFailed(fullpath, e);
				}
				// meta!.docs = docs;
			});
		}
	}
	async processFile(
		ctx: ImportContext,
		folder: TFolder,
		file: PickedFile,
		doc: Doc
	) {
		ctx.status('Processing ' + file.name);
		try {
			const htmlContent = doc.body_draft;

			const dom = parseHTML(htmlContent);
			fixDocumentUrls(dom);

			// Find all the attachments and download them
			const baseUrl =
				file instanceof NodePickedFile
					? nodeUrl.pathToFileURL(file.filepath)
					: undefined;
			const attachments = new Map<string, TFile | null>();
			const attachmentLookup = new Map<string, TFile>();
			for (let el of dom.findAll('img, audio, video')) {
				if (ctx.isCancelled()) return;

				let src = el.getAttribute('src');
				if (!src) continue;

				try {
					const url = new URL(
						src.startsWith('//') ? `https:${src}` : src,
						baseUrl
					);

					let key = url.href;
					let attachmentFile = attachments.get(key);
					if (!attachments.has(key)) {
						ctx.status('Downloading attachment for ' + file.name);
						attachmentFile = await this.downloadAttachment(
							folder,
							el,
							url
						);
						attachments.set(key, attachmentFile);
						if (attachmentFile) {
							attachmentLookup.set(
								attachmentFile.path,
								attachmentFile
							);
							ctx.reportAttachmentSuccess(attachmentFile.name);
						} else {
							ctx.reportSkipped(src);
						}
					}

					if (attachmentFile) {
						// Convert the embed into a vault absolute path
						el.setAttribute(
							'src',
							attachmentFile.path.replace(/ /g, '%20')
						);

						// Convert `<audio>` and `<video>` into `<img>` so that htmlToMarkdown can properly parse it.
						if (!(el instanceof HTMLImageElement)) {
							el.replaceWith(
								createEl('img', {
									attr: {
										src: attachmentFile.path.replace(
											/ /g,
											'%20'
										),
										alt: el.getAttr('alt'),
									},
								})
							);
						}
					}
				} catch (e) {
					ctx.reportFailed(src, e);
				}
			}

			let mdContent = htmlToMarkdown(dom);
			let mdFile = await this.saveAsMarkdownFile(
				folder,
				doc.title,
				mdContent
			);

			// Because `htmlToMarkdown` always gets us markdown links, we'll want to convert them into wikilinks, or relative links depending on the user's preference.
			if (!Object.isEmpty(attachments)) {
				// Attempt to parse links using MetadataCache
				let { metadataCache } = this.app;
				let cache: CachedMetadata;
				// @ts-ignore
				if (metadataCache.computeMetadataAsync) {
					// @ts-ignore
					cache = (await metadataCache.computeMetadataAsync(
						stringToUtf8(mdContent)
					)) as CachedMetadata;
				} else {
					cache = await new Promise<CachedMetadata>((resolve) => {
						let cache = metadataCache.getFileCache(mdFile);
						if (cache) return resolve(cache);
						const ref = metadataCache.on(
							'changed',
							(file, content, cache) => {
								if (file === mdFile) {
									metadataCache.offref(ref);
									resolve(cache);
								}
							}
						);
					});
				}

				// Gather changes to make to the document
				let changes = [];
				if (cache.embeds) {
					for (let { link, position } of cache.embeds) {
						if (attachmentLookup.has(link)) {
							let newLink =
								this.app.fileManager.generateMarkdownLink(
									attachmentLookup.get(link)!,
									mdFile.path
								);
							changes.push({
								from: position.start.offset,
								to: position.end.offset,
								text: newLink,
							});
						}
					}
				}

				// Apply changes from last to first
				changes.sort((a, b) => b.from - a.from);
				for (let change of changes) {
					mdContent =
						mdContent.substring(0, change.from) +
						change.text +
						mdContent.substring(change.to);
				}

				await this.vault.modify(mdFile, mdContent);
			}

			ctx.reportNoteSuccess(file.fullpath);
			return mdFile;
		} catch (e) {
			ctx.reportFailed(file.fullpath, e);
		}
		return null;
	}
	async downloadAttachment(folder: TFolder, el: HTMLElement, url: URL) {
		let basename = '';
		let extension = '';
		let data: ArrayBuffer;
		switch (url.protocol) {
			case 'file:':
				let filepath = nodeUrl.fileURLToPath(url.href);
				({ basename, extension } = parseFilePath(filepath));
				data = nodeBufferToArrayBuffer(
					await fsPromises.readFile(filepath)
				);
				break;
			case 'https:':
			case 'http:':
				let response = await requestURL(url);
				let pathInfo = parseURL(url);
				basename = pathInfo.basename;
				data = response.data;
				extension =
					extensionForMime(response.mime) || pathInfo.extension;
				break;
			default:
				throw new Error(url.href);
		}

		if (!this.filterAttachmentSize(data)) return null;
		if (
			el instanceof HTMLImageElement &&
			!(await this.filterImageSize(data))
		) {
			return null;
		}

		if (!extension) {
			if (el instanceof HTMLImageElement) {
				extension = 'png';
			} else if (el instanceof HTMLAudioElement) {
				extension = 'mp3';
			} else if (el instanceof HTMLVideoElement) {
				extension = 'mp4';
			} else {
				return null;
			}
		}

		let attachmentFolder = await this.createFolders(
			normalizePath(folder.path + '/Attachments')
		);

		// @ts-ignore
		const path: string = await this.vault.getAvailablePath(
			attachmentFolder.path + `/${basename}`,
			extension
		);

		return await this.vault.createBinary(path, data);
	}

	filterAttachmentSize(data: ArrayBuffer) {
		const { byteLength } = data;
		return (
			!this.attachmentSizeLimit || byteLength <= this.attachmentSizeLimit
		);
	}

	async filterImageSize(data: ArrayBuffer) {
		if (!this.minimumImageSize) {
			return true;
		}
		let size;
		try {
			size = await getImageSize(data);
		} catch {
			return true;
		}
		const { height, width } = size;
		return (
			width >= this.minimumImageSize && height >= this.minimumImageSize
		);
	}
}

export class TarEntryFile implements PickedFile {
	type: 'file' = 'file';
	entry: TarEntry;
	fullpath: string;
	parent: string;
	name: string;
	basename: string;
	extension: string;

	constructor(tar: PickedFile, entry: TarEntry) {
		this.entry = entry;
		this.fullpath = tar.fullpath + '/' + entry.header.name;
		/**
		 * Parse a filepath to get a file's parent path, name, basename (name without extension), and extension (lowercase).
		 * For example, "path/to/my/file.md" would become `{parent: "path/to/my", name: "file.md", basename: "file", extension: "md"}`
		 */
		let { parent, name, basename, extension } = parseFilePath(
			entry.header.name
		);
		this.parent = parent;
		this.name = name;
		this.basename = basename;
		this.extension = extension;
	}
	readTar(callback: (tar: TarReader) => Promise<void>): Promise<void> {
		throw new Error('Method not implemented.');
	}

	async readText(): Promise<string> {
		return this.entry.buffer.toString('utf-8');
	}

	async read(): Promise<ArrayBuffer> {
		throw new Error('Method not implemented.');
	}

	get filepath() {
		return this.entry.header.name;
	}

	get size() {
		return this.entry.header.size;
	}

	get ctime() {
		return this.entry.header.mtime;
	}

	get mtime() {
		return this.entry.header.mtime;
	}

	async readZip(
		callback: (zip: ZipReader<any>) => Promise<void>
	): Promise<void> {
		throw new Error('Method not implemented.');
	}
}
export async function readTar(
	file: PickedFile,
	callback: (entries: TarEntryFile[]) => Promise<void>
) {
	await file.readTar(async (e) => {
		let ls: TarEntryFile[] = [];
		await e.forEachEntry(async (entry: TarEntry) => {
			if (entry.header.type === 'file') {
				ls.push(new TarEntryFile(file, entry));
			}
		});
		await callback(ls);
	});
}
