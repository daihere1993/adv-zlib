# adv-zlib

Advanced zlib utilities for Node.js

## Installation

```bash
pnpm add adv-zlib
```

## Usage

```typescript
// ESM
import { compress, decompress } from 'adv-zlib';

// CommonJS
const { compress, decompress } = require('adv-zlib');

// Example usage
const compressed = await compress(Buffer.from('Hello, World!'));
const decompressed = await decompress(compressed);
```

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
