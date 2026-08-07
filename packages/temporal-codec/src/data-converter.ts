import { ExternalStorage, type DataConverter } from '@temporalio/common';
import { Pool } from 'pg';
import { PostgresStorageDriver } from './postgres-driver.js';

const DEFAULT_PAYLOAD_SIZE_THRESHOLD = 256 * 1024;

export interface OrchestraDataConverterHandle {
  dataConverter: DataConverter;
  pool: Pool;
  close(): Promise<void>;
}

function resolveDatabaseUrl(connectionString?: string) {
  const url = connectionString ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required for Temporal External Storage (Postgres payload offload)');
  }
  return url;
}

function resolvePayloadSizeThreshold(explicit?: number) {
  if (explicit !== undefined) return explicit;
  const fromEnv = process.env.TEMPORAL_PAYLOAD_SIZE_THRESHOLD;
  if (fromEnv === undefined || fromEnv === '') return DEFAULT_PAYLOAD_SIZE_THRESHOLD;
  const parsed = Number(fromEnv);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`TEMPORAL_PAYLOAD_SIZE_THRESHOLD must be a non-negative number, got ${fromEnv}`);
  }
  return parsed;
}

/**
 * Build a DataConverter that offloads large Temporal payloads into Postgres.
 * Pass the same converter to every Client and Worker that reads or writes history.
 */
export function createOrchestraDataConverter(options: {
  connectionString?: string;
  payloadSizeThreshold?: number;
  driverName?: string;
} = {}): OrchestraDataConverterHandle {
  const pool = new Pool({ connectionString: resolveDatabaseUrl(options.connectionString) });
  const driver = new PostgresStorageDriver({
    pool,
    driverName: options.driverName,
  });
  const dataConverter: DataConverter = {
    externalStorage: new ExternalStorage({
      drivers: [driver],
      payloadSizeThreshold: resolvePayloadSizeThreshold(options.payloadSizeThreshold),
    }),
  };
  return {
    dataConverter,
    pool,
    async close() {
      await pool.end();
    },
  };
}
