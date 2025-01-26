<h1 align="center">
🚀 adv-zlib
</h1>

<p align="center">
The go-to package for working with large ZIP files—fast, efficient, and effortlessly handles nested archives.
</p>

<div align="center">
  <a href="https://www.npmjs.com/package/adv-zlib"><img src="https://img.shields.io/npm/v/adv-zlib"></a>
  <a href="https://github.com/daihere1993/adv-zlib/actions/workflows/ci.yml"><img src="https://github.com/daihere1993/adv-zlib/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg"></a>
</div>

## Features

- **Optimized for large ZIP files**: Handle massive ZIP files with incredible speed and ultra-low memory usage. Check the benchmarks I provided for proof.
- **Effortless nested ZIP handling**: Easily work with deeply nested ZIP files like `/a.zip/b.zip/c.txt` without needing to fully extract intermediate archives.
- **ESM-first with CJS compatibility**: Fully embraces ESM, while also providing `.cjs` builds for CommonJS projects.
- **Non-blocking**: All I/O operations are implemented with Streams to maximize performance and scalability.
- **Modern async/await APIs**: Simplified APIs using async/await, no callbacks required.

## Installation

Using `npm`:
```bash
npm install adv-zlib
```

Using `pnpm`:
```bash
pnpm add adv-zlib
```

Using `yarn`:
```bash
yarn add adv-zlib
```

Once the package installed, you can import the library using `import` or `require` approach:
```typescript
// With import
import AdvZlib from 'adv-zlib';

// With require
const AdvZlib = require('adv-zlib');
```

## Examples
### Check if an specific file exists under a ZIP file
```typescript
import AdvZlib from 'adv-zlib';
const advZlib = new AdvZlib();

// Work with normal zip file
const exsitence1 = await advZlib.exists('/a/b.zip/c.txt');

// Work with nested zip file
const exsitence2 = await advZlib.exists('/a/b.zip/c.zip/d.txt');

// Work with filter function
const esistence3 = await advZlib.exists('/a/b.zip', (entry) => entry.fileName === 'c.txt');
```

### Read content from an specific file within a ZIP file
```typescript
import AdvZlib from 'adv-zlib';
const advZlib = new AdvZlib();

// Work with normal zip file
const content1 = await advZlib.read('/a/b.zip/c.txt');

// Work with nested zip file
const content2 = await advZlib.read('/a/b.zip/c.zip/d.txt');

// Work with filter function
const content3 = await advZlib.read('/a/b.zip', (entry) => entry.fileName === 'c.txt');
// The content is a `Buffer`, you can get its `toString` method
console.log(content3.toString());
```

### Extract content
```typescript
import AdvZlib from 'adv-zlib';
const advZlib = new AdvZlib();

// Extract entire zip to a destination directory
await advZlib.extract('/a/b.zip', '/destination/dir');

// Extract a specific file to a destination directory
await advZlib.extract('/a/b.zip/c.txt', '/destination/dir');

// Extract a specific file into a destination file(this file could not exist)
await advZlib.extract('/a/b.zip/c.txt', '/destination/file.txt');

// Extract specific file to a destination file
await advZlib.extract('/a/b.zip', '/desctination/dir', (entry) => entry.endsWith('.txt'));
```

## Upcoming

- **Compression APIs**: passible based on [archiver](https://github.com/archiverjs/node-archiver) to provide several sementic APIs for zip compression.
- **Encryption APIs**: would provide APIs like `isEncrypted()` and add new arguments `password` to current existed APIs.

## Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Build
pnpm build

# Type check
pnpm typecheck
```

## License

MIT
