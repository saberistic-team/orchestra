import { createHash } from 'node:crypto';
import {
  StorageDriverClaim,
  type Payload,
  type StorageDriver,
  type StorageDriverRetrieveContext,
  type StorageDriverStoreContext,
  type StorageDriverTargetInfo,
} from '@temporalio/common';
import proto from '@temporalio/proto';
import type { Pool } from 'pg';
import { ensureTemporalPayloadsTable } from './ensure-table.js';

const PayloadProto = proto.temporal.api.common.v1.Payload;

export const POSTGRES_STORAGE_DRIVER_TYPE = 'orchestra.postgresdriver';
export const POSTGRES_STORAGE_DRIVER_NAME = 'orchestra.postgres';

const DEFAULT_MAX_PAYLOAD_SIZE = 50 * 1024 * 1024;

export interface PostgresStorageDriverOptions {
  pool: Pool;
  /** Per-instance routing name written into Temporal claim references. */
  driverName?: string;
  /** Reject a single payload larger than this many bytes (default 50 MiB). */
  maxPayloadSize?: number;
}

async function runAllWithAbortOnError<T>(
  external: AbortSignal | undefined,
  makeTasks: (signal: AbortSignal) => Promise<T>[],
): Promise<T[]> {
  const controller = new AbortController();
  const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
  const tasks = makeTasks(signal);
  try {
    return await Promise.all(tasks);
  } catch (error) {
    controller.abort();
    await Promise.allSettled(tasks);
    throw error;
  }
}

function targetColumns(target: StorageDriverTargetInfo | undefined) {
  if (!target) {
    return {
      namespace: null as string | null,
      targetKind: null as string | null,
      targetType: null as string | null,
      targetId: null as string | null,
      runId: null as string | null,
    };
  }
  return {
    namespace: target.namespace ?? null,
    targetKind: target.kind,
    targetType: target.type ?? null,
    targetId: target.id ?? null,
    runId: target.runId ?? null,
  };
}

/**
 * Temporal External Storage driver that persists serialized payloads in Postgres.
 * Payloads are content-addressed by SHA-256 so identical blobs are stored once.
 */
export class PostgresStorageDriver implements StorageDriver {
  readonly name: string;
  readonly type = POSTGRES_STORAGE_DRIVER_TYPE;
  private readonly pool: Pool;
  private readonly maxPayloadSize: number;
  private readonly ready: Promise<void>;

  constructor(options: PostgresStorageDriverOptions) {
    const { pool, driverName = POSTGRES_STORAGE_DRIVER_NAME, maxPayloadSize = DEFAULT_MAX_PAYLOAD_SIZE } = options;
    if (!Number.isFinite(maxPayloadSize) || maxPayloadSize <= 0) {
      throw new Error(`maxPayloadSize must be a positive finite number, got ${String(maxPayloadSize)}`);
    }
    this.pool = pool;
    this.name = driverName;
    this.maxPayloadSize = maxPayloadSize;
    this.ready = ensureTemporalPayloadsTable(pool);
  }

  async store(context: StorageDriverStoreContext, payloads: Payload[]): Promise<StorageDriverClaim[]> {
    await this.ready;
    const columns = targetColumns(context.target);
    return runAllWithAbortOnError(context.abortSignal, () =>
      payloads.map((payload) => this.storePayload(payload, columns)),
    );
  }

  async retrieve(context: StorageDriverRetrieveContext, claims: StorageDriverClaim[]): Promise<Payload[]> {
    await this.ready;
    return runAllWithAbortOnError(context.abortSignal, () =>
      claims.map((claim) => this.retrievePayload(claim)),
    );
  }

  private async storePayload(
    payload: Payload,
    columns: ReturnType<typeof targetColumns>,
  ): Promise<StorageDriverClaim> {
    const payloadBytes = Buffer.from(PayloadProto.encode(payload).finish());
    if (payloadBytes.length > this.maxPayloadSize) {
      throw new Error(
        `Payload size ${payloadBytes.length} bytes exceeds the configured maxPayloadSize of ${this.maxPayloadSize} bytes`,
      );
    }
    const hashValue = createHash('sha256').update(payloadBytes).digest('hex');
    await this.pool.query(
      `INSERT INTO temporal_payloads (
         hash_sha256, payload, size_bytes, namespace, target_kind, target_type, target_id, run_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (hash_sha256) DO NOTHING`,
      [
        hashValue,
        payloadBytes,
        payloadBytes.length,
        columns.namespace,
        columns.targetKind,
        columns.targetType,
        columns.targetId,
        columns.runId,
      ],
    );
    return new StorageDriverClaim({
      hashAlgorithm: 'sha256',
      hashValue,
    });
  }

  private async retrievePayload(claim: StorageDriverClaim): Promise<Payload> {
    const { hashAlgorithm, hashValue } = claim.claimData;
    if (!hashAlgorithm || !hashValue) {
      throw new Error("PostgresStorageDriver claimData must contain 'hashAlgorithm' and 'hashValue'");
    }
    if (hashAlgorithm !== 'sha256') {
      throw new Error(`PostgresStorageDriver unsupported hash algorithm: expected sha256, got ${hashAlgorithm}`);
    }
    const result = await this.pool.query<{ payload: Buffer }>(
      'SELECT payload FROM temporal_payloads WHERE hash_sha256 = $1',
      [hashValue],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`PostgresStorageDriver payload not found for sha256:${hashValue}`);
    }
    const payloadBytes = row.payload;
    const actualHash = createHash('sha256').update(payloadBytes).digest('hex');
    if (actualHash !== hashValue) {
      throw new Error(
        `PostgresStorageDriver integrity check failed: expected sha256:${hashValue}, got sha256:${actualHash}`,
      );
    }
    return PayloadProto.decode(payloadBytes);
  }
}

