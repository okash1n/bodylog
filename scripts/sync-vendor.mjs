// Chart.js（バージョン固定・CDN不使用）を dashboard 配下へコピーして Worker に同梱する
import { access, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
const destDir = join(root, 'src', 'dashboard', 'vendor');
const dest = join(destDir, 'chart.umd.js');

try {
  await access(src);
} catch {
  console.error(`chart.js not found at ${src}. Run \`npm install\` first.`);
  process.exit(1);
}

await mkdir(destDir, { recursive: true });
await copyFile(src, dest);
console.log(`Copied chart.umd.js -> ${dest}`);
