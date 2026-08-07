import { gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import * as tar from 'tar-stream';
import type { SourceArchive, PreviewRepositoryInput } from './types.js';

interface ForgejoBranch {
  commit?: { id?: unknown };
}

interface ArchiveEntry {
  path: string;
  content: Buffer;
  mode: number;
}

const DEFAULT_MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_CONTEXT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILES = 1_000;
const GIT_REVISION = /^[0-9a-f]{40,64}$/u;

function positiveLimit(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function forgejoAuthorization() {
  const token = process.env.FORGEJO_PREVIEW_TOKEN?.trim();
  if (token) return `token ${token}`;
  const username = process.env.FORGEJO_PREVIEW_USER?.trim()
    || process.env.FORGEJO_ADMIN_USER?.trim()
    || 'orchestra-agent';
  const password = process.env.FORGEJO_PREVIEW_PASSWORD
    ?? process.env.FORGEJO_ADMIN_PASSWORD
    ?? 'orchestra-local-admin-change-me';
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function encodePath(value: string) {
  return value.split('/').map(encodeURIComponent).join('/');
}

async function responseBody(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Forgejo source archive exceeds the compressed size limit.');
  if (!response.body) throw new Error('Forgejo returned an empty source archive.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of Readable.fromWeb(response.body as never)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > maxBytes) throw new Error('Forgejo source archive exceeds the compressed size limit.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function normalizeArchiveName(name: string) {
  if (!name
    || name.length > 4_096
    || /[\u0000-\u001f\u007f]/u.test(name)
    || name.includes('\\')
    || name.startsWith('/')) {
    throw new Error('Forgejo archive contains an unsafe path.');
  }
  const normalized = name.replace(/\/+$/u, '');
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment
    || segment === '.'
    || segment === '..'
    || Buffer.byteLength(segment) > 255)) {
    throw new Error('Forgejo archive contains an unsafe path.');
  }
  return segments;
}

function excludedRuntimePath(path: string) {
  const lower = path.toLowerCase();
  const segments = lower.split('/');
  const basename = segments.at(-1)!;
  const directories = segments.slice(0, -1);
  return lower === 'artifacts'
    || lower.startsWith('artifacts/')
    || segments.some((segment) => segment === '.git' || segment === '.ssh' || segment === '.gnupg')
    || lower === '.forgejo/workflows'
    || lower.startsWith('.forgejo/workflows/')
    || lower === '.github/workflows'
    || lower.startsWith('.github/workflows/')
    || /^\.env(?:\..*)?$/u.test(basename)
    || directories.some((segment) => /^(?:credentials?|secrets?|tokens?)$/u.test(segment))
    || /^(?:credentials?|secrets?|tokens?)(?:\.(?:json|ya?ml|toml|ini|conf|txt|env))?$/u.test(basename)
    || /^(?:\.git-credentials|\.npmrc|\.pypirc|\.netrc|\.yarnrc(?:\.yml)?|pip\.conf)$/u.test(basename)
    || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/u.test(basename)
    || /\.(?:key|pem|p12|pfx)$/u.test(basename);
}

async function readStream(stream: Readable, maxBytes: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > maxBytes) throw new Error('A file in the Forgejo archive exceeds the preview context limit.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function unpackArchive(bytes: Buffer, maxContextBytes: number, maxFiles: number): Promise<ArchiveEntry[]> {
  const extract = tar.extract();
  const raw: Array<{ segments: string[]; type: string; content: Buffer; mode: number }> = [];
  let total = 0;
  const completion = new Promise<void>((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      void (async () => {
        const segments = normalizeArchiveName(header.name);
        const type = header.type ?? 'file';
        if (!['file', 'directory'].includes(type)) throw new Error(`Unsupported ${type} entry in the Forgejo archive.`);
        const content = type === 'file' ? await readStream(stream, maxContextBytes) : Buffer.alloc(0);
        total += content.length;
        if (total > maxContextBytes) throw new Error('Forgejo source archive exceeds the expanded context limit.');
        raw.push({ segments, type, content, mode: ((header.mode ?? 0o644) & 0o777) & ~0o6000 });
        if (raw.length > maxFiles + 100) throw new Error('Forgejo source archive contains too many entries.');
        next();
      })().catch((error) => next(error instanceof Error ? error : new Error(String(error))));
    });
    extract.once('finish', resolve);
    extract.once('error', reject);
  });
  Readable.from(bytes).pipe(extract);
  await completion;

  const roots = new Set(raw.map((entry) => entry.segments[0]));
  if (roots.size !== 1) throw new Error('Forgejo archive must contain exactly one repository root.');
  const entries: ArchiveEntry[] = [];
  const exactPaths = new Set<string>();
  const caseFoldedPaths = new Set<string>();
  for (const item of raw) {
    const path = item.segments.slice(1).join('/');
    if (!path || item.type === 'directory' || excludedRuntimePath(path)) continue;
    const foldedPath = path.toLowerCase();
    const collidesWithFileAncestor = [...caseFoldedPaths].some((existing) =>
      existing.startsWith(`${foldedPath}/`) || foldedPath.startsWith(`${existing}/`));
    if (exactPaths.has(path) || caseFoldedPaths.has(foldedPath) || collidesWithFileAncestor) {
      throw new Error(`Forgejo archive contains a duplicate, case-colliding, or ambiguous path: ${path}.`);
    }
    exactPaths.add(path);
    caseFoldedPaths.add(foldedPath);
    entries.push({ path, content: item.content, mode: item.mode || 0o644 });
    if (entries.length > maxFiles) throw new Error('Forgejo source archive contains too many files.');
  }
  return entries;
}

async function bufferStream(stream: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

async function normalizedBuildContext(entries: ArchiveEntry[]) {
  const dockerfile = entries.find((entry) => entry.path === 'Dockerfile');
  if (!dockerfile) throw new Error('The Builder must provide a root Dockerfile for the managed preview.');
  if (dockerfile.content.length > 256 * 1024) throw new Error('The preview Dockerfile exceeds the 256 KiB policy limit.');
  const dockerfileText = dockerfile.content.toString('utf8');
  if (!/^\s*HEALTHCHECK\s+(?!NONE\b)/imu.test(dockerfileText)) {
    throw new Error('The preview Dockerfile must define an active HEALTHCHECK for GET /health.');
  }
  const enforcedIgnore = [
    '',
    '# Enforced by Orchestra preview isolation',
    'artifacts/',
    '.git',
    '.git*',
    '.env',
    '.env.*',
    '**/.env',
    '**/.env.*',
    '**/.ssh',
    '**/.ssh/**',
    '**/.gnupg',
    '**/.gnupg/**',
    '**/.npmrc',
    '**/.pypirc',
    '**/.netrc',
    '**/.git-credentials',
    '**/credentials',
    '**/credentials/**',
    '**/secrets',
    '**/secrets/**',
    '**/tokens',
    '**/tokens/**',
    '**/*.key',
    '**/*.pem',
    '**/*.p12',
    '**/*.pfx',
  ].join('\n');
  const ignore = entries.find((entry) => entry.path === '.dockerignore');
  if (ignore) ignore.content = Buffer.from(`${ignore.content.toString('utf8').trimEnd()}\n${enforcedIgnore}\n`);
  else entries.push({ path: '.dockerignore', content: Buffer.from(`${enforcedIgnore}\n`), mode: 0o644 });

  entries.sort((left, right) => left.path.localeCompare(right.path));
  const pack = tar.pack();
  const output = bufferStream(pack);
  for (const entry of entries) {
    pack.entry({
      name: entry.path,
      type: 'file',
      size: entry.content.length,
      mode: entry.mode,
      uid: 0,
      gid: 0,
      mtime: new Date(0),
    }, entry.content);
  }
  pack.finalize();
  return output;
}

export class ForgejoSourceClient {
  private readonly baseUrl: URL;
  private readonly authorization: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly maxCompressedBytes: number;
  private readonly maxContextBytes: number;
  private readonly maxFiles: number;

  constructor(options: { baseUrl?: string; authorization?: string; fetchImplementation?: typeof fetch } = {}) {
    this.baseUrl = new URL(options.baseUrl ?? process.env.FORGEJO_URL ?? 'http://forgejo:3000');
    this.authorization = options.authorization ?? forgejoAuthorization();
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.maxCompressedBytes = positiveLimit(process.env.PREVIEW_MAX_ARCHIVE_BYTES, DEFAULT_MAX_COMPRESSED_BYTES);
    this.maxContextBytes = positiveLimit(process.env.PREVIEW_MAX_CONTEXT_BYTES, DEFAULT_MAX_CONTEXT_BYTES);
    this.maxFiles = positiveLimit(process.env.PREVIEW_MAX_FILES, DEFAULT_MAX_FILES);
  }

  private async request(path: string) {
    return this.fetchImplementation(new URL(path, this.baseUrl), {
      headers: { authorization: this.authorization, accept: 'application/json, application/gzip' },
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
  }

  async fetch(repository: PreviewRepositoryInput, preferredRevision?: string): Promise<SourceArchive> {
    const repositoryPath = `/api/v1/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
    let revision = preferredRevision?.toLowerCase() ?? '';
    if (!GIT_REVISION.test(revision)) {
      const branchResponse = await this.request(`${repositoryPath}/branches/${encodePath(repository.branch)}`);
      if (!branchResponse.ok) throw new Error(`Forgejo branch lookup returned ${branchResponse.status}.`);
      const branch = await branchResponse.json() as ForgejoBranch;
      revision = typeof branch.commit?.id === 'string' ? branch.commit.id.toLowerCase() : '';
    }
    if (!GIT_REVISION.test(revision)) throw new Error('Forgejo returned no immutable branch revision.');

    const archiveResponse = await this.request(`${repositoryPath}/archive/${revision}.tar.gz`);
    if (!archiveResponse.ok) throw new Error(`Forgejo source archive returned ${archiveResponse.status}.`);
    const compressed = await responseBody(archiveResponse, this.maxCompressedBytes);
    if (compressed[0] !== 0x1f || compressed[1] !== 0x8b) throw new Error('Forgejo source archive was not gzip encoded.');
    let expanded: Buffer;
    try {
      expanded = gunzipSync(compressed, { maxOutputLength: this.maxContextBytes });
    } catch (error) {
      throw new Error(`Forgejo source archive could not be safely expanded: ${error instanceof Error ? error.message : String(error)}`);
    }
    const entries = await unpackArchive(expanded, this.maxContextBytes, this.maxFiles);
    const paths = entries.map((entry) => entry.path);
    const context = await normalizedBuildContext(entries);
    // Evidence files are excluded before this digest, so later Test/Gate commits
    // do not make an otherwise identical runnable source tree look different.
    const contextDigest = createHash('sha256').update(context).digest('hex');
    return { revision, context, contextDigest, paths };
  }
}

export const archiveInternals = { unpackArchive, normalizedBuildContext, excludedRuntimePath };
