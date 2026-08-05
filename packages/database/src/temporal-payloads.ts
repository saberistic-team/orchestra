import type { DataConverter } from '@temporalio/common';
import { ProjectStore } from './index.js';
import { createTemporalDataConverter } from './temporal-payload-storage.js';

/** Infrastructure-only adapter; it does not expose application persistence to callers. */
export function createPostgresTemporalDataConverter(
  connectionString: string,
  environment: NodeJS.ProcessEnv = process.env,
): DataConverter {
  return createTemporalDataConverter(new ProjectStore(connectionString), environment);
}
