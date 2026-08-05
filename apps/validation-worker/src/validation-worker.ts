import { VALIDATION_TASK_QUEUE } from '@orchestra/contracts';
import { createTemporalDataConverter, ProjectStore } from '@orchestra/database';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities.js';

const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for Temporal payload references.');
const dataConverter = createTemporalDataConverter(new ProjectStore(databaseUrl));
const worker = await Worker.create({
  connection,
  namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  taskQueue: VALIDATION_TASK_QUEUE,
  activities,
  dataConverter,
  maxConcurrentActivityTaskExecutions: 1,
});
await worker.run();
