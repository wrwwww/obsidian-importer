import { Platform } from 'obsidian';
// import { ReadEntry, t, Parser } from 'tar';

import type * as NodeFS from 'node:fs';
import { extract, Headers } from 'tar-stream';
export const fs: typeof NodeFS = Platform.isDesktopApp
	? window.require('node:original-fs')
	: null;
import { Readable } from 'stream';

export interface TarEntry {
	header: Headers;
	buffer: Buffer;
}

export class TarReader {
	private readonly extract = extract();
	private readonly entryQueue: ((entry: TarEntry) => void)[] = [];
	private readonly entryWaiters: (() => void)[] = [];
	private finished = false;

	constructor(readStream: NodeFS.ReadStream) {
		readStream.pipe(this.extract);

		this.extract.on('entry', async (header, stream, next) => {
			const chunks: Buffer[] = [];

			for await (const chunk of stream) {
				chunks.push(chunk as Buffer);
			}
			const buffer = Buffer.concat(chunks);

			const entry: TarEntry = { header, buffer };

			const waiter = this.entryQueue.shift();
			if (waiter) {
				waiter(entry);
			} else {
				this.entryWaiters.push(() => this.emitEntry(entry));
			}

			next(); // 必须在末尾调用
		});

		this.extract.on('finish', () => {
			this.finished = true;
			this.entryQueue.forEach((fn) => fn(null as any));
		});
	}

	private emitEntry(entry: TarEntry) {
		const waiter = this.entryQueue.shift();
		if (waiter) waiter(entry);
		else this.entryWaiters.push(() => this.emitEntry(entry));
	}

	async forEachEntry(fn: (entry: TarEntry) => Promise<void>): Promise<void> {
		while (true) {
			const entry = await new Promise<TarEntry | null>((resolve) => {
				if (this.finished) return resolve(null);
				this.entryQueue.push(resolve);
				while (this.entryWaiters.length > 0) {
					const emit = this.entryWaiters.shift();
					emit?.();
				}
			});

			if (!entry) break;
			await fn(entry);
		}
	}
}
