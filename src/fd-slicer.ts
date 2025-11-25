// This was adapted from https://github.com/andrewrk/node-fd-slicer by Andrew Kelley under the MIT License.
import { EventEmitter } from 'node:events';
import { Readable, Writable, PassThrough } from 'node:stream';
import type { FileHandle } from 'node:fs/promises';
import PQueue from 'p-queue';

// ============================================================================
// Type Definitions
// ============================================================================

export interface FdSlicerOptions {
  autoClose?: boolean;
}

export interface BufferSlicerOptions {
  maxChunkSize?: number;
}

export interface ReadStreamOptions {
  start?: number;
  end?: number;
  highWaterMark?: number;
}

export interface WriteStreamOptions {
  start?: number;
  end?: number;
  highWaterMark?: number;
}

export interface ReadResult {
  bytesRead: number;
  buffer: Buffer;
}

export interface WriteResult {
  bytesWritten: number;
  buffer: Buffer;
}

// ============================================================================
// FdSlicer Class
// ============================================================================

export class FdSlicer extends EventEmitter {
  public fileHandle: FileHandle;
  public queue: PQueue;
  private refCount: number;
  private autoClose: boolean;

  constructor(fileHandle: FileHandle, options: FdSlicerOptions = {}) {
    super();
    this.fileHandle = fileHandle;
    this.queue = new PQueue({ concurrency: 1 });
    this.refCount = 0;
    this.autoClose = !!options.autoClose;
  }

  // Getter for backward compatibility with code that accesses fd
  get fd(): number {
    return this.fileHandle.fd;
  }

  async read(buffer: Buffer, offset: number, length: number, position: number): Promise<ReadResult> {
    return this.queue.add(async () => {
      const result = await this.fileHandle.read(buffer, offset, length, position);
      return { bytesRead: result.bytesRead, buffer: result.buffer };
    });
  }

  async write(buffer: Buffer, offset: number, length: number, position: number): Promise<WriteResult> {
    return this.queue.add(async () => {
      const result = await this.fileHandle.write(buffer, offset, length, position);
      return { bytesWritten: result.bytesWritten, buffer: result.buffer };
    });
  }

  createReadStream(options?: ReadStreamOptions): ReadStream {
    return new ReadStream(this, options);
  }

  createWriteStream(options?: WriteStreamOptions): WriteStream {
    return new WriteStream(this, options);
  }

  ref(): void {
    this.refCount += 1;
  }

  unref(): void {
    this.refCount -= 1;

    if (this.refCount > 0) return;
    if (this.refCount < 0) throw new Error('invalid unref');

    if (this.autoClose) {
      this.fileHandle
        .close()
        .then(() => {
          this.emit('close');
        })
        .catch((err) => {
          this.emit('error', err);
        });
    }
  }
}

// ============================================================================
// ReadStream Class
// ============================================================================

class ReadStream extends Readable {
  private context: FdSlicer;
  private start: number;
  private endOffset: number | undefined;
  private pos: number;
  public destroyed: boolean;

  constructor(context: FdSlicer, options: ReadStreamOptions = {}) {
    super(options);
    this.context = context;
    this.context.ref();
    this.start = options.start || 0;
    this.endOffset = options.end;
    this.pos = this.start;
    this.destroyed = false;
  }

  _read(n: number): void {
    if (this.destroyed) return;

    let toRead = Math.min((this as any)._readableState.highWaterMark, n);
    if (this.endOffset != null) {
      toRead = Math.min(toRead, this.endOffset - this.pos);
    }
    if (toRead <= 0) {
      this.destroyed = true;
      this.push(null);
      this.context.unref();
      return;
    }

    this.context.queue
      .add(async () => {
        if (this.destroyed) return;
        const buffer = Buffer.allocUnsafe(toRead);
        try {
          const result = await this.context.fileHandle.read(buffer, 0, toRead, this.pos);
          if (result.bytesRead === 0) {
            this.destroyed = true;
            this.push(null);
            this.context.unref();
          } else {
            this.pos += result.bytesRead;
            this.push(buffer.slice(0, result.bytesRead));
          }
        } catch (err) {
          this.destroy(err as Error);
        }
      })
      .catch((err: Error) => {
        this.destroy(err);
      });
  }

  override destroy(error?: Error): this {
    if (this.destroyed) return this;
    const err = error || new Error('stream destroyed');
    this.destroyed = true;
    this.emit('error', err);
    this.context.unref();
    return this;
  }
}

// ============================================================================
// WriteStream Class
// ============================================================================

class WriteStream extends Writable {
  private context: FdSlicer;
  private start: number;
  private endOffset: number;
  public bytesWritten: number;
  private pos: number;
  public destroyed: boolean;

  constructor(context: FdSlicer, options: WriteStreamOptions = {}) {
    super(options);
    this.context = context;
    this.context.ref();
    this.start = options.start || 0;
    this.endOffset = options.end == null ? Infinity : +options.end;
    this.bytesWritten = 0;
    this.pos = this.start;
    this.destroyed = false;

    this.on('finish', this.destroy.bind(this));
  }

  _write(buffer: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.destroyed) return;

    if (this.pos + buffer.length > this.endOffset) {
      const err = new Error('maximum file length exceeded') as NodeJS.ErrnoException;
      err.code = 'ETOOBIG';
      this.destroy();
      callback(err);
      return;
    }

    this.context.queue
      .add(async () => {
        if (this.destroyed) return;
        try {
          const result = await this.context.fileHandle.write(buffer, 0, buffer.length, this.pos);
          this.bytesWritten += result.bytesWritten;
          this.pos += result.bytesWritten;
          this.emit('progress');
          callback();
        } catch (err) {
          this.destroy();
          callback(err as Error);
        }
      })
      .catch((err: Error) => {
        this.destroy();
        callback(err);
      });
  }

  override destroy(error?: Error): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.context.unref();
    return this;
  }
}

// ============================================================================
// BufferSlicer Class
// ============================================================================

export class BufferSlicer extends EventEmitter {
  private refCount: number;
  public buffer: Buffer;
  private maxChunkSize: number;

  constructor(buffer: Buffer, options: BufferSlicerOptions = {}) {
    super();
    this.refCount = 0;
    this.buffer = buffer;
    this.maxChunkSize = options.maxChunkSize || Number.MAX_SAFE_INTEGER;
  }

  async read(buffer: Buffer, offset: number, length: number, position: number): Promise<ReadResult> {
    if (!(0 <= offset && offset <= buffer.length)) {
      throw new RangeError(`offset outside buffer: 0 <= ${offset} <= ${buffer.length}`);
    }
    if (position < 0) {
      throw new RangeError(`position is negative: ${position}`);
    }
    if (offset + length > buffer.length) {
      // The caller's buffer can't hold all the bytes they're trying to read.
      // Clamp the length instead of giving an error.
      // The callback will be informed of fewer than expected bytes written.
      length = buffer.length - offset;
    }
    if (position + length > this.buffer.length) {
      // Clamp any attempt to read past the end of the source buffer.
      length = this.buffer.length - position;
    }
    if (length <= 0) {
      // After any clamping, we're fully out of bounds or otherwise have nothing to do.
      // This isn't an error; it's just zero bytes written.
      return { bytesRead: 0, buffer };
    }
    this.buffer.copy(buffer, offset, position, position + length);
    return { bytesRead: length, buffer };
  }

  async write(buffer: Buffer, offset: number, length: number, position: number): Promise<WriteResult> {
    buffer.copy(this.buffer, position, offset, offset + length);
    return { bytesWritten: length, buffer };
  }

  createReadStream(
    options: ReadStreamOptions = {},
  ): PassThrough & { destroyed: boolean; start: number; endOffset?: number; pos: number } {
    const readStream = new PassThrough(options) as PassThrough & {
      destroyed: boolean;
      start: number;
      endOffset?: number;
      pos: number;
    };
    readStream.destroyed = false;
    readStream.start = options.start || 0;
    readStream.endOffset = options.end;
    // by the time this function returns, we'll be done.
    readStream.pos = readStream.endOffset || this.buffer.length;

    // respect the maxChunkSize option to slice up the chunk into smaller pieces.
    const entireSlice = this.buffer.slice(readStream.start, readStream.pos);
    let offset = 0;
    while (true) {
      const nextOffset = offset + this.maxChunkSize;
      if (nextOffset >= entireSlice.length) {
        // last chunk
        if (offset < entireSlice.length) {
          readStream.write(entireSlice.slice(offset, entireSlice.length));
        }
        break;
      }
      readStream.write(entireSlice.slice(offset, nextOffset));
      offset = nextOffset;
    }

    readStream.end();
    const originalDestroy = readStream.destroy.bind(readStream);
    readStream.destroy = (error?: Error) => {
      readStream.destroyed = true;
      return originalDestroy(error);
    };
    return readStream;
  }

  createWriteStream(
    options: WriteStreamOptions = {},
  ): Writable & { start: number; endOffset: number; bytesWritten: number; pos: number; destroyed: boolean } {
    const bufferSlicer = this;
    const writeStream = new Writable(options) as Writable & {
      start: number;
      endOffset: number;
      bytesWritten: number;
      pos: number;
      destroyed: boolean;
    };
    writeStream.start = options.start || 0;
    writeStream.endOffset = options.end == null ? this.buffer.length : +options.end;
    writeStream.bytesWritten = 0;
    writeStream.pos = writeStream.start;
    writeStream.destroyed = false;

    writeStream._write = (buffer: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void) => {
      if (writeStream.destroyed) return;

      const end = writeStream.pos + buffer.length;
      if (end > writeStream.endOffset) {
        const err = new Error('maximum file length exceeded') as NodeJS.ErrnoException;
        err.code = 'ETOOBIG';
        writeStream.destroyed = true;
        callback(err);
        return;
      }
      buffer.copy(bufferSlicer.buffer, writeStream.pos, 0, buffer.length);

      writeStream.bytesWritten += buffer.length;
      writeStream.pos = end;
      writeStream.emit('progress');
      callback();
    };

    const originalDestroy = writeStream.destroy.bind(writeStream);
    writeStream.destroy = (error?: Error) => {
      writeStream.destroyed = true;
      return originalDestroy(error);
    };
    return writeStream;
  }

  ref(): void {
    this.refCount += 1;
  }

  unref(): void {
    this.refCount -= 1;

    if (this.refCount < 0) {
      throw new Error('invalid unref');
    }
  }
}

// ============================================================================
// RingBuffer Class
// ============================================================================

/**
 * A ring buffer that keeps only the tail of a stream in memory.
 * This allows processing very large streams with fixed memory usage.
 */
class RingBuffer {
  private buffer: Buffer;
  private maxSize: number;
  private writePos: number = 0;
  private totalBytesRead: number = 0;
  private filled: boolean = false;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
    this.buffer = Buffer.allocUnsafe(maxSize);
  }

  /**
   * Write data to the ring buffer
   */
  write(chunk: Buffer): void {
    const chunkSize = chunk.length;
    this.totalBytesRead += chunkSize;

    if (chunkSize >= this.maxSize) {
      // Chunk is larger than buffer, just keep the tail
      chunk.copy(this.buffer, 0, chunkSize - this.maxSize);
      this.writePos = 0;
      this.filled = true;
      return;
    }

    let sourceOffset = 0;
    let remaining = chunkSize;

    while (remaining > 0) {
      const spaceInBuffer = this.maxSize - this.writePos;
      const bytesToWrite = Math.min(remaining, spaceInBuffer);

      chunk.copy(this.buffer, this.writePos, sourceOffset, sourceOffset + bytesToWrite);

      this.writePos += bytesToWrite;
      sourceOffset += bytesToWrite;
      remaining -= bytesToWrite;

      // Wrap around if we reach the end
      if (this.writePos >= this.maxSize) {
        this.writePos = 0;
        this.filled = true;
      }
    }
  }

  /**
   * Get the last N bytes from the buffer
   */
  getLast(size: number): Buffer {
    const availableSize = this.filled ? this.maxSize : this.writePos;
    const actualSize = Math.min(size, availableSize);

    if (!this.filled) {
      // Buffer hasn't wrapped yet, data is sequential
      return this.buffer.subarray(0, actualSize);
    }

    // Buffer has wrapped, need to reconstruct in correct order
    const result = Buffer.allocUnsafe(actualSize);

    if (actualSize < this.maxSize) {
      // We want less than the full buffer
      let sourceStart = this.writePos - actualSize;
      if (sourceStart < 0) {
        sourceStart += this.maxSize;
      }

      if (sourceStart + actualSize <= this.maxSize) {
        // Data is contiguous
        this.buffer.copy(result, 0, sourceStart, sourceStart + actualSize);
      } else {
        // Data wraps around
        const firstPartSize = this.maxSize - sourceStart;
        this.buffer.copy(result, 0, sourceStart, this.maxSize);
        this.buffer.copy(result, firstPartSize, 0, actualSize - firstPartSize);
      }
    } else {
      // Return the entire buffer in correct order
      const firstPartSize = this.maxSize - this.writePos;
      this.buffer.copy(result, 0, this.writePos, this.maxSize);
      this.buffer.copy(result, firstPartSize, 0, this.writePos);
    }

    return result;
  }

  /**
   * Get data from a specific offset (if still available in the buffer)
   */
  getFrom(offset: number, size: number): Buffer | null {
    const startOffset = this.totalBytesRead - (this.filled ? this.maxSize : this.writePos);

    // Check if the requested data is still in the buffer
    if (offset < startOffset) {
      return null; // Data has been overwritten
    }

    const bufferOffset = offset - startOffset;
    const availableSize = (this.filled ? this.maxSize : this.writePos) - bufferOffset;

    if (availableSize < size) {
      return null; // Not enough data available
    }

    if (!this.filled) {
      // Buffer hasn't wrapped yet
      return this.buffer.subarray(bufferOffset, bufferOffset + size);
    }

    // Buffer has wrapped, need to calculate actual position
    const actualStart = (this.writePos + bufferOffset) % this.maxSize;
    const result = Buffer.allocUnsafe(size);

    if (actualStart + size <= this.maxSize) {
      // Data is contiguous
      this.buffer.copy(result, 0, actualStart, actualStart + size);
    } else {
      // Data wraps around
      const firstPartSize = this.maxSize - actualStart;
      this.buffer.copy(result, 0, actualStart, this.maxSize);
      this.buffer.copy(result, firstPartSize, 0, size - firstPartSize);
    }

    return result;
  }

  /**
   * Get the total number of bytes read through this buffer
   */
  getTotalBytesRead(): number {
    return this.totalBytesRead;
  }

  /**
   * Get the current size of valid data in the buffer
   */
  getCurrentSize(): number {
    return this.filled ? this.maxSize : this.writePos;
  }
}

// ============================================================================
// StreamSlicer Class
// ============================================================================

export class StreamSlicer extends BufferSlicer {
  private ringBuffer: RingBuffer | null = null;
  private fileSize: number = 0;

  /**
   * Create a StreamSlicer from a readable stream using a ring buffer.
   * This keeps only the tail of the stream in memory for fixed memory usage.
   * @param stream The readable stream to consume
   * @param options Buffer slicer options including maxBufferSize for ring buffer
   */
  static async fromStream(
    stream: Readable,
    options: BufferSlicerOptions & { maxBufferSize?: number } = {},
  ): Promise<StreamSlicer> {
    const maxBufferSize = options.maxBufferSize;

    // If no maxBufferSize specified, fall back to full buffering
    if (!maxBufferSize) {
      const chunks: Buffer[] = [];

      return new Promise((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });

        stream.on('error', (err: Error) => {
          reject(err);
        });

        stream.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve(new StreamSlicer(buffer, options));
        });
      });
    }

    // Use ring buffer for memory-efficient streaming
    const ringBuffer = new RingBuffer(maxBufferSize);

    return new Promise((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        ringBuffer.write(bufferChunk);
      });

      stream.on('error', (err: Error) => {
        reject(err);
      });

      stream.on('end', () => {
        // Create a StreamSlicer with the ring buffer's current data
        const finalBuffer = ringBuffer.getLast(ringBuffer.getCurrentSize());
        const slicer = new StreamSlicer(finalBuffer, options);
        slicer.ringBuffer = ringBuffer;
        slicer.fileSize = ringBuffer.getTotalBytesRead();
        resolve(slicer);
      });
    });
  }

  /**
   * Get the total size of the buffered stream data
   */
  get size(): number {
    return this.ringBuffer ? this.fileSize : this.buffer.length;
  }

  /**
   * Slice the last `size` bytes from the stream buffer
   */
  sliceLast(size: number): Buffer {
    if (this.ringBuffer) {
      return this.ringBuffer.getLast(size);
    }
    const startOffset = Math.max(0, this.buffer.length - size);
    return this.buffer.slice(startOffset);
  }

  sliceFrom(offset: number, size: number): Buffer {
    if (this.ringBuffer) {
      const result = this.ringBuffer.getFrom(offset, size);
      if (!result) {
        throw new Error(
          `Data at offset ${offset} (size: ${size}) is no longer available in the ring buffer. ` +
            `Ring buffer only keeps the last ${this.ringBuffer.getCurrentSize()} bytes.`,
        );
      }
      return result;
    }
    return this.buffer.slice(offset, offset + size);
  }

  /**
   * Create a read stream for the last `size` bytes
   */
  createReadStreamForLast(size: number, options: ReadStreamOptions = {}): ReturnType<BufferSlicer['createReadStream']> {
    const startOffset = Math.max(0, this.buffer.length - size);
    return this.createReadStream({
      ...options,
      start: startOffset,
      end: this.buffer.length,
    });
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

export function createFromBuffer(buffer: Buffer, options?: BufferSlicerOptions): BufferSlicer {
  return new BufferSlicer(buffer, options);
}

export function createFromFd(fileHandle: FileHandle, options?: FdSlicerOptions): FdSlicer {
  return new FdSlicer(fileHandle, options);
}

export async function createFromStream(stream: Readable, options?: BufferSlicerOptions): Promise<StreamSlicer> {
  return StreamSlicer.fromStream(stream, options);
}
