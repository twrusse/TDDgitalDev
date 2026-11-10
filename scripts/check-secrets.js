import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'data']);
const KEY_PATTERN = /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/;
const WEBHOOK_PATTERN = /\bwhsec_[A-Za-z0-9]{16,}/;

async function walk(directory, files) {
  const entries = await readdir(directory);
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const fullPath = path.join(directory, entry);
    const info = await stat(fullPath);
    if (info.isDirectory()) {
      await walk(fullPath, files);
    } else if (info.isFile() && info.size < 1_000_000) {
      files.push(fullPath);
    }
  }
}

export async function findSecrets(root) {
  const files = [];
  await walk(root, files);
  const hits = [];
  for (const file of files) {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (KEY_PATTERN.test(line) || WEBHOOK_PATTERN.test(line)) {
        hits.push(`${path.relative(root, file)}:${index + 1}`);
      }
    });
  }
  return hits;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isDirectRun) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const hits = await findSecrets(root);
  if (hits.length > 0) {
    console.error('Possible Stripe secret in source:');
    for (const hit of hits) console.error(`  ${hit}`);
    process.exit(1);
  }
  console.log('No Stripe API keys or webhook secrets found.');
}
