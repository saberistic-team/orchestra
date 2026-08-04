import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

async function dockerfiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries
    .filter((entry) => !['.git', 'node_modules', '.reports'].includes(entry.name))
    .map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? dockerfiles(path) : entry.name === 'Dockerfile' ? [path] : [];
    }));
  return nested.flat();
}

const files = [...await dockerfiles(process.cwd()), 'compose.yaml', 'package.json'];
const references = [];

for (const file of files) {
  const contents = await readFile(file, 'utf8');
  const displayFile = relative(process.cwd(), file) || file;
  const patterns = file.endsWith('Dockerfile')
    ? [/^FROM\s+(\S+)/gm]
    : file === 'compose.yaml'
      ? [/^\s*image:\s*(\S+)/gm]
      : [/(?:aquasec\/trivy|prowlercloud\/prowler):[^\s"]+/g];
  for (const pattern of patterns) {
    for (const match of contents.matchAll(pattern)) {
      const image = match[1] ?? match[0];
      if (file.endsWith('Dockerfile') && !image.includes(':') && !image.includes('@')) continue;
      references.push({ file: displayFile, image });
    }
  }
}

const unpinned = references.filter(({ image }) => !image.includes('@sha256:'));
if (unpinned.length) {
  for (const item of unpinned) console.error(`${item.file}: unpinned image ${item.image}`);
  process.exitCode = 1;
} else {
  console.log(`Verified ${references.length} immutable container image references.`);
}
