import {
  ExternalStorage,
  StorageDriverClaim,
  type DataConverter,
  type Payload,
  type StorageDriver,
  type StorageDriverRetrieveContext,
  type StorageDriverStoreContext,
} from '@temporalio/common';
import { createHash } from 'node:crypto';

const DEFAULT_REFERENCE_THRESHOLD_BYTES = 128 * 1024;
const DEFAULT_MAX_PAYLOAD_BYTES = 20 * 1024 * 1024;

export interface TemporalPayloadBackend {
  storeTemporalPayload(
    digest: string,
    dataBase64: string,
    metadata: Record<string, string>,
    byteLength: number,
  ): Promise<void>;
  loadTemporalPayloads(digests: string[]): Promise<Array<{
    digest: string;
    dataBase64: string;
    metadata: Record<string, string>;
    byteLength: number;
  }>>;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function encodedMetadata(payload: Payload): Record<string, string> {
  return Object.fromEntries(Object.entries(payload.metadata ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, Buffer.from(value).toString('base64')]));
}

function payloadDigest(metadata: Record<string, string>, data: Uint8Array): string {
  return createHash('sha256')
    .update(JSON.stringify(metadata))
    .update('\0')
    .update(data)
    .digest('hex');
}

function isModelBoundary(context: StorageDriverStoreContext): boolean {
  const type = context.target?.type ?? '';
  return context.target?.kind === 'activity'
    ? /model|inference|runAgent/iu.test(type)
    : /model|inference/iu.test(type);
}

export function temporalPayloadShouldBeReferenced(
  context: StorageDriverStoreContext,
  payload: Payload,
  thresholdBytes: number,
): boolean {
  return isModelBoundary(context) || (payload.data?.byteLength ?? 0) >= thresholdBytes;
}

export class PostgresTemporalPayloadStorageDriver implements StorageDriver {
  readonly name = 'orchestra-postgres';
  readonly type = 'orchestra.postgres.payload.v1';

  constructor(
    private readonly backend: TemporalPayloadBackend,
    private readonly maxPayloadBytes = DEFAULT_MAX_PAYLOAD_BYTES,
  ) {}

  async store(context: StorageDriverStoreContext, payloads: Payload[]): Promise<StorageDriverClaim[]> {
    return Promise.all(payloads.map(async (payload) => {
      if (context.abortSignal?.aborted) throw context.abortSignal.reason;
      const data = Buffer.from(payload.data ?? new Uint8Array());
      if (data.byteLength > this.maxPayloadBytes) {
        throw new Error(`Temporal payload is ${data.byteLength} bytes; maximum referenced payload is ${this.maxPayloadBytes}.`);
      }
      const metadata = encodedMetadata(payload);
      const digest = payloadDigest(metadata, data);
      await this.backend.storeTemporalPayload(digest, data.toString('base64'), metadata, data.byteLength);
      return new StorageDriverClaim({ digest, byteLength: String(data.byteLength) });
    }));
  }

  async retrieve(context: StorageDriverRetrieveContext, claims: StorageDriverClaim[]): Promise<Payload[]> {
    if (context.abortSignal?.aborted) throw context.abortSignal.reason;
    const digests = claims.map((claim) => claim.claimData.digest);
    if (digests.some((digest) => !digest)) throw new Error('Temporal payload reference is missing its digest.');
    const rows = await this.backend.loadTemporalPayloads(digests);
    const byDigest = new Map(rows.map((row) => [row.digest, row]));
    return claims.map((claim) => {
      const { digest, byteLength } = claim.claimData;
      const row = byDigest.get(digest);
      if (!row) throw new Error(`Temporal payload reference not found: ${digest}`);
      const data = Buffer.from(row.dataBase64, 'base64');
      if (String(row.byteLength) !== byteLength || data.byteLength !== row.byteLength) {
        throw new Error(`Temporal payload length verification failed: ${digest}`);
      }
      if (payloadDigest(row.metadata, data) !== digest) {
        throw new Error(`Temporal payload digest verification failed: ${digest}`);
      }
      return {
        metadata: Object.fromEntries(Object.entries(row.metadata)
          .map(([key, value]) => [key, Buffer.from(value, 'base64')])),
        data,
      };
    });
  }
}

export function createTemporalDataConverter(
  backend: TemporalPayloadBackend,
  environment: NodeJS.ProcessEnv = process.env,
): DataConverter {
  const thresholdBytes = positiveInteger(
    environment.TEMPORAL_PAYLOAD_REFERENCE_THRESHOLD_BYTES,
    DEFAULT_REFERENCE_THRESHOLD_BYTES,
    'TEMPORAL_PAYLOAD_REFERENCE_THRESHOLD_BYTES',
  );
  const maxPayloadBytes = positiveInteger(
    environment.TEMPORAL_PAYLOAD_REFERENCE_MAX_BYTES,
    DEFAULT_MAX_PAYLOAD_BYTES,
    'TEMPORAL_PAYLOAD_REFERENCE_MAX_BYTES',
  );
  const driver = new PostgresTemporalPayloadStorageDriver(backend, maxPayloadBytes);
  return {
    externalStorage: new ExternalStorage({
      drivers: [driver],
      payloadSizeThreshold: 0,
      driverSelector: (context, payload) => (
        temporalPayloadShouldBeReferenced(context, payload, thresholdBytes) ? driver : null
      ),
    }),
  };
}
