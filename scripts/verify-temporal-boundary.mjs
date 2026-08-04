import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = new URL('../apps/api/', import.meta.url);
const sourceRoot = fileURLToPath(new URL('src/', apiRoot));
const modelSourceRoot = fileURLToPath(new URL('../apps/model-worker/src/', import.meta.url));
const appsRoot = fileURLToPath(new URL('../apps/', import.meta.url));
const packageJson = JSON.parse(await readFile(new URL('package.json', apiRoot), 'utf8'));
const forbiddenPackages = ['@orchestra/database', 'drizzle-orm', 'pg', 'postgres', 'ioredis', 'redis'];

const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies'];
const dependencyViolations = dependencySections.flatMap((section) =>
  forbiddenPackages
    .filter((dependency) => packageJson[section]?.[dependency])
    .map((dependency) => `${section}.${dependency}`),
);

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : [path];
    }),
  );
  return nested.flat().filter((path) => path.endsWith('.ts') && !path.includes('.test.'));
}

const files = await sourceFiles(sourceRoot);
const importViolations = [];
const serviceViolations = [];
const modelBoundaryViolations = [];

for (const file of files) {
  const source = await readFile(file, 'utf8');
  const displayPath = relative(process.cwd(), file);

  for (const dependency of forbiddenPackages) {
    if (source.includes(`from '${dependency}`) || source.includes(`from \"${dependency}`)) {
      importViolations.push(`${displayPath} imports ${dependency}`);
    }
  }

  if (file.endsWith('.service.ts') && !source.includes('TEMPORAL_GATEWAY')) {
    serviceViolations.push(`${displayPath} does not use TEMPORAL_GATEWAY`);
  }
}

for (const file of await sourceFiles(appsRoot)) {
  const source = await readFile(file, 'utf8');
  const isInferenceActivity = file === join(modelSourceRoot, 'activities.ts');
  const providerBoundaryPatterns = ['OLLAMA_HOST', '/api/chat', 'OPENROUTER_API_KEY', 'openrouter.ai', '/chat/completions'];
  if (!isInferenceActivity && providerBoundaryPatterns.some((pattern) => source.includes(pattern))) {
    modelBoundaryViolations.push(`${relative(process.cwd(), file)} reaches a model-provider boundary outside the dedicated inference Activity`);
  }
}

const violations = [...dependencyViolations, ...importViolations, ...serviceViolations, ...modelBoundaryViolations];
if (violations.length > 0) {
  console.error('The API must reach application state through Temporal only:');
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log('Temporal boundaries verified: API state access and model-provider inference remain on their dedicated workers.');
}
