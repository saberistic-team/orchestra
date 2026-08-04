import { gunzipSync, gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import * as tar from 'tar-stream';
import { PREVIEW_RUNTIME_CONTRACT } from '@orchestra/contracts';
import { previewContainerOptions } from './docker-preview.js';
import { archiveInternals, ForgejoSourceClient } from './forgejo-source.js';
import { parsePreviewDeploymentRequest } from './types.js';

const projectId = 'b67a2fd5-e829-40dc-a6f5-d15e4758515d';
const iterationId = 'c67a2fd5-e829-40dc-a6f5-d15e4758515d';
const revision = 'a'.repeat(40);

function request() {
  return {
    contractVersion: 1 as const,
    projectId,
    iterationId,
    iterationNumber: 2,
    repository: {
      owner: 'orchestra-agent',
      name: 'previewable-project',
      url: 'http://localhost:3001/orchestra-agent/previewable-project',
      branch: 'iteration-2-agents',
    },
    runtime: PREVIEW_RUNTIME_CONTRACT,
  };
}

async function archive(entries: Array<{ name: string; content?: string; type?: 'file' | 'directory' }>) {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const output = (async () => {
    for await (const chunk of pack) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  })();
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '');
    pack.entry({ name: entry.name, type: entry.type ?? 'file', size: content.length, mode: 0o644 }, content);
  }
  pack.finalize();
  await output;
  return gzipSync(Buffer.concat(chunks));
}

describe('managed preview boundary', () => {
  it('accepts only the exact managed iteration branch and runtime contract', () => {
    expect(parsePreviewDeploymentRequest(request())).toMatchObject({ iterationNumber: 2 });
    expect(() => parsePreviewDeploymentRequest({
      ...request(),
      repository: { ...request().repository, branch: 'main' },
    })).toThrow('managed iteration branches');
  });

  it('creates a non-root, local-only, resource-limited runtime without mounts or privileges', () => {
    const options = previewContainerOptions({
      image: 'preview:test',
      name: 'preview-test',
      network: 'isolated',
      routeAlias: 'preview-test-deadbeefdead',
      labels: {},
    });
    expect(options.User).toBe('65532:65532');
    expect(options.HostConfig).toMatchObject({
      NetworkMode: 'isolated',
      Privileged: false,
      CapDrop: ['ALL'],
      ReadonlyRootfs: true,
      PidsLimit: 128,
    });
    expect(options.HostConfig?.PortBindings).toBeUndefined();
    expect(options.NetworkingConfig?.EndpointsConfig?.isolated?.Aliases).toEqual(['preview-test-deadbeefdead']);
    expect(options.HostConfig?.Binds).toBeUndefined();
    expect(options.HostConfig?.Devices).toBeUndefined();
    expect(options.HostConfig?.LogConfig).toEqual({
      Type: 'local',
      Config: { 'max-size': '10m', 'max-file': '1', compress: 'false' },
    });
  });

  it('resolves an immutable SHA and strips artifacts and secrets from the build context', async () => {
    const sourceArchive = await archive([
      { name: 'previewable-project/', type: 'directory' },
      { name: 'previewable-project/Dockerfile', content: 'FROM node:26\nEXPOSE 8080\nHEALTHCHECK CMD node -e "fetch(\\\"http://127.0.0.1:8080/health\\\")"\nCMD ["node","server.js"]' },
      { name: 'previewable-project/server.js', content: 'console.log("preview")' },
      { name: 'previewable-project/src/auth.ts', content: 'export const authenticate = () => true' },
      { name: 'previewable-project/artifacts/iteration-02/threat.md', content: 'private planning evidence' },
      { name: 'previewable-project/.env', content: 'SECRET=do-not-copy' },
      { name: 'previewable-project/config/credentials.json', content: 'nested-credential-do-not-copy' },
      { name: 'previewable-project/home/.ssh/id_rsa', content: 'private-key-do-not-copy' },
    ]);
    let call = 0;
    const fetchImplementation = (async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify({ commit: { id: revision } }), { status: 200 });
      return new Response(sourceArchive, { status: 200, headers: { 'content-type': 'application/gzip' } });
    }) as typeof fetch;
    const client = new ForgejoSourceClient({
      baseUrl: 'http://forgejo.test',
      authorization: 'token read-only',
      fetchImplementation,
    });

    const result = await client.fetch(request().repository);

    expect(result.revision).toBe(revision);
    expect(result.context.toString('utf8')).toContain('server.js');
    expect(result.context.toString('utf8')).not.toContain('private planning evidence');
    expect(result.context.toString('utf8')).not.toContain('SECRET=do-not-copy');
    expect(result.context.toString('utf8')).not.toContain('nested-credential-do-not-copy');
    expect(result.context.toString('utf8')).not.toContain('private-key-do-not-copy');
    expect(result.context.toString('utf8')).toContain('authenticate');
    expect(result.contextDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('rejects crafted archives with file and descendant path collisions', async () => {
    const sourceArchive = await archive([
      { name: 'previewable-project/', type: 'directory' },
      { name: 'previewable-project/app', content: 'ambiguous file' },
      { name: 'previewable-project/app/server.js', content: 'console.log("hidden descendant")' },
    ]);

    await expect(archiveInternals.unpackArchive(gunzipSync(sourceArchive), 1024 * 1024, 100))
      .rejects.toThrow(/ambiguous path/i);
  });
});
