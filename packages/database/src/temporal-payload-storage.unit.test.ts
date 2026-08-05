import type { Payload, StorageDriverStoreContext } from '@temporalio/common';
import { describe, expect, it } from 'vitest';
import {
  PostgresTemporalPayloadStorageDriver,
  temporalPayloadShouldBeReferenced,
  type TemporalPayloadBackend,
} from './temporal-payload-storage.js';

class MemoryBackend implements TemporalPayloadBackend {
  readonly rows = new Map<string, {
    digest: string;
    dataBase64: string;
    metadata: Record<string, string>;
    byteLength: number;
  }>();
  stores = 0;

  async storeTemporalPayload(
    digest: string,
    dataBase64: string,
    metadata: Record<string, string>,
    byteLength: number,
  ) {
    this.stores += 1;
    this.rows.set(digest, { digest, dataBase64, metadata, byteLength });
  }

  async loadTemporalPayloads(digests: string[]) {
    return digests.flatMap((digest) => {
      const row = this.rows.get(digest);
      return row ? [row] : [];
    });
  }
}

const smallPayload: Payload = {
  metadata: { encoding: Buffer.from('json/plain') },
  data: Buffer.from('{"ok":true}'),
};

describe('Temporal payload reference storage', () => {
  it('references every model boundary even when the payload is small', () => {
    const activityContext: StorageDriverStoreContext = {
      target: { kind: 'activity', namespace: 'default', type: 'openRouterInference' },
    };
    const workflowContext: StorageDriverStoreContext = {
      target: { kind: 'workflow', namespace: 'default', type: 'modelReasoningWorkflow' },
    };
    expect(temporalPayloadShouldBeReferenced(activityContext, smallPayload, 128 * 1024)).toBe(true);
    expect(temporalPayloadShouldBeReferenced(workflowContext, smallPayload, 128 * 1024)).toBe(true);
  });

  it('keeps small control payloads inline and references large non-model payloads', () => {
    const context: StorageDriverStoreContext = {
      target: { kind: 'workflow', namespace: 'default', type: 'projectWorkflow' },
    };
    expect(temporalPayloadShouldBeReferenced(context, smallPayload, 128)).toBe(false);
    expect(temporalPayloadShouldBeReferenced(
      context,
      { ...smallPayload, data: Buffer.alloc(128) },
      128,
    )).toBe(true);
  });

  it('round trips content-addressed data and verifies references', async () => {
    const backend = new MemoryBackend();
    const driver = new PostgresTemporalPayloadStorageDriver(backend);
    const context: StorageDriverStoreContext = {
      target: { kind: 'activity', namespace: 'default', type: 'runAgent' },
    };
    const [claim] = await driver.store(context, [smallPayload]);
    const [hydrated] = await driver.retrieve({}, [claim]);
    expect(Buffer.from(hydrated.data ?? []).toString()).toBe('{"ok":true}');
    expect(Buffer.from(hydrated.metadata?.encoding ?? []).toString()).toBe('json/plain');
    expect(claim.claimData.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('fails closed when referenced content is missing or corrupt', async () => {
    const backend = new MemoryBackend();
    const driver = new PostgresTemporalPayloadStorageDriver(backend);
    const [claim] = await driver.store({}, [smallPayload]);
    backend.rows.get(claim.claimData.digest)!.dataBase64 = Buffer.from('corrupt').toString('base64');
    await expect(driver.retrieve({}, [claim])).rejects.toThrow(/verification failed/u);
    backend.rows.clear();
    await expect(driver.retrieve({}, [claim])).rejects.toThrow(/not found/u);
  });
});
