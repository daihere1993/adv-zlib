import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cjsDir = path.resolve(__dirname, '../dist/cjs');

// Create package.json for CommonJS build
fs.writeFileSync(path.join(cjsDir, 'package.json'), JSON.stringify({
  type: 'commonjs'
}, null, 2));

function updateFileContent(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  const isIndexFile = path.basename(filePath) === 'index.js';
  
  // Convert import statements to require
  content = content.replace(/import\s*{([^}]+)}\s*from\s*['"]([^'"]+)\.js['"]/g, (_, imports, modulePath) => {
    const importList = imports.split(',').map(i => i.trim());
    return `const { ${importList.join(', ')} } = require('${modulePath}.cjs')`;
  });

  if (isIndexFile) {
    // For index.js, remove the __esModule declaration and directly export AdvZlib
    content = content.replace(/Object\.defineProperty\(exports,\s*["']__esModule["'],\s*{\s*value:\s*true\s*}\);/, '');
    content = content.replace(/exports\.default = ([^;]+);/, 'module.exports = $1;');
  } else {
    // For other files, keep named exports
    content = content.replace(/export\s*{([^}]+)}/g, (_, exports) => {
      return `module.exports = { ${exports} }`;
    });
  }

  // Fix any remaining .js requires to .cjs
  content = content.replace(/require\(['"]([^'"]+)\.js['"]\)/g, (_, modulePath) => {
    return `require('${modulePath}.cjs')`;
  });

  fs.writeFileSync(filePath, content);
}

function renameJsToCjs(dir) {
  const files = fs.readdirSync(dir);
  
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      renameJsToCjs(fullPath);
    } else if (file.endsWith('.js')) {
      // First update the content to fix imports
      updateFileContent(fullPath);
      // Then rename the file
      const newPath = fullPath.replace(/\.js$/, '.cjs');
      fs.renameSync(fullPath, newPath);
    }
  }
}

renameJsToCjs(cjsDir);
