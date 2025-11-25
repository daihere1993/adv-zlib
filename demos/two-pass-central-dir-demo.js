#!/usr/bin/env node
import fs from 'fs';
import zlib from 'zlib';
import { Transform } from 'stream';

/**
 * TailCapture — keeps only the last `maxSize` bytes of the stream.
 */
class TailCapture extends Transform {
  constructor(maxSize = 70 * 1024) {
    super();
    this.maxSize = maxSize;
    this.buffer = Buffer.alloc(0);
    this.total = 0;
  }

  _transform(chunk, _enc, cb) {
    this.total += chunk.length;
    const combined = Buffer.concat([this.buffer, chunk]);
    this.buffer = combined.slice(-this.maxSize);
    cb();
  }

  _flush(cb) {
    this.push(this.buffer);
    cb();
  }
}

/**
 * Find EOCD and parse offset/size fields.
 */
function findEOCD(buffer) {
  const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const idx = buffer.lastIndexOf(sig);
  if (idx === -1) return null;
  const entryCount = buffer.readUInt16LE(idx + 10);
  const cdSize = buffer.readUInt32LE(idx + 12);
  const cdOffset = buffer.readUInt32LE(idx + 16);
  const commentLen = buffer.readUInt16LE(idx + 20);
  return { cdSize, cdOffset, commentLen, entryCount, eocdPos: idx };
}

/**
 * Pass 1: stream inflate, keep tail, parse EOCD.
 */
async function pass1_detectEOCD(compressedPath) {
  const start = performance.now();
  const inflate = zlib.createInflateRaw();
  const tail = new TailCapture(70 * 1024);

  await new Promise((res, rej) =>
    fs.createReadStream(compressedPath).pipe(inflate).pipe(tail).on('finish', res).on('error', rej),
  );

  const eocd = findEOCD(tail.buffer);
  if (!eocd) throw new Error('EOCD not found');
  const totalBytes = tail.total;
  const keepSize = totalBytes - eocd.cdOffset;
  const elapsed = performance.now() - start;

  console.log(`Pass1: inflated=${(totalBytes / 1024 / 1024).toFixed(2)} MB, tail=${tail.buffer.length}B`);
  console.log(`→ EOCD found: cdOffset=${eocd.cdOffset}, cdSize=${eocd.cdSize}Bytes, entry count=${eocd.entryCount}`);
  console.log(`Pass1 time: ${elapsed.toFixed(1)} ms`);
  return { eocd, keepSize };
}

/**
 * Pass 2: re-inflate but skip until offset, collect cdSize, stop early.
 * Returns a read stream of the Central Directory.
 */
function pass2_extractCentralDir(compressedPath, cdOffset, cdSize) {
  const inflate = zlib.createInflateRaw();

  let total = 0;
  let collected = 0;
  const collector = new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length;
      if (total <= cdOffset) return cb(); // skip before CD start

      // calculate slice range within current chunk
      const startInChunk = Math.max(0, cdOffset - (total - chunk.length));
      const remaining = cdSize - collected;
      const slice = chunk.slice(startInChunk, startInChunk + remaining);
      collected += slice.length;
      this.push(slice);

      if (collected >= cdSize) {
        console.log(`→ Collected ${collected} bytes of Central Directory`);
        this.end();
      }
      cb();
    },
  });

  // Create the pipeline and return the collector stream
  fs.createReadStream(compressedPath).pipe(inflate).pipe(collector);

  return collector;
}

/**
 * Entry point.
 */
async function main() {
  const inputFile = '/Users/zowu/Downloads/snapshot_raw.zip';
  if (!fs.existsSync(inputFile)) {
    console.error(`❌ Missing ${inputFile}`);
    console.error('Create one quickly:\n' + "  echo 'Hello World'.repeat(1e6) | gzip -c > example-nested.deflate");
    process.exit(1);
  }

  const { eocd } = await pass1_detectEOCD(inputFile);
  const cdStream = pass2_extractCentralDir(inputFile, eocd.cdOffset, eocd.cdSize);

  // Example: pipe the Central Directory stream to a file
  const outputPath = './central-dir.bin';
  await new Promise((res, rej) => cdStream.pipe(fs.createWriteStream(outputPath)).on('finish', res).on('error', rej));

  console.log(`✅ Central Directory written to ${outputPath}`);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
