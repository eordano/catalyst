import { Readable, Duplex } from "stream";

export interface ContentStorage {
    store(category: string, id: string, content: Buffer, append?: boolean): Promise<void>;
    delete(category: string, id: string): Promise<void>;
    getContent(category: string, id: string): Promise<ContentItem | undefined>;
    listIds(category: string): Promise<string[]>;
    exists(category: string, id: string): Promise<boolean>;
}

export interface ContentItem {
    getLength(): number | undefined
    asBuffer(): Promise<Buffer>
    asStream(): Readable
}

export class SimpleContentItem implements ContentItem {
    private constructor(private buffer?: Buffer, private stream?: Readable, private length?: number) { }

    static fromBuffer(buffer: Buffer): SimpleContentItem {
        return new SimpleContentItem(buffer, undefined, buffer.length)
    }

    static fromStream(stream: Readable, length?: number): SimpleContentItem {
        return new SimpleContentItem(undefined, stream, length)
    }

    async asBuffer(): Promise<Buffer> {
        if (this.buffer) {
            return this.buffer
        }
        return streamToBuffer(this.stream)
    }

    asStream(): Readable {
        if (this.stream) {
            return this.stream
        }
        return bufferToStream(this.buffer)
    }

    getLength(): number | undefined {
        return this.length;
    }
}

export function bufferToStream(buffer): Readable {
    let streamDuplex = new Duplex();
    streamDuplex.push(buffer);
    streamDuplex.push(null);
    return streamDuplex;
}

export function streamToBuffer(stream): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        let buffers: any[] = [];
        stream.on('error', reject)
        stream.on('data', (data) => buffers.push(data))
        stream.on('end', () => resolve(Buffer.concat(buffers)))
    });
}
