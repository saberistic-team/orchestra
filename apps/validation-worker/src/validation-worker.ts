import { VALIDATION_TASK_QUEUE } from '@orchestra/contracts';
import { createOrchestraDataConverter } from '@orchestra/temporal-codec';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities.js';

const dataConverterHandle = createOrchestraDataConverter();
const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
const worker = await Worker.create({
  connection,
  namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
  taskQueue: VALIDATION_TASK_QUEUE,
  activities,
  dataConverter: dataConverterHandle.dataConverter,
  maxConcurrentActivityTaskExecutions: 1,
});
await worker.run();
