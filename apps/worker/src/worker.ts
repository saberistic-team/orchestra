import { NativeConnection, Worker, bundleWorkflowCode } from '@temporalio/worker';
import * as activities from './activities.js';
import { parseWorkerMode, workerQueuePlan } from './worker-topology.js';

const connection = await NativeConnection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
});
const workflowExtension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
const workflowsPath = new URL(`./workflows.${workflowExtension}`, import.meta.url).pathname;
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
const mode = parseWorkerMode(process.env.ORCHESTRA_WORKER_MODE);
const plan = workerQueuePlan(mode, process.env.AGENT_WORKER_ROLES);
const workflowBundle = plan.some((entry) => entry.kind === 'workflow')
  ? await bundleWorkflowCode({ workflowsPath })
  : undefined;

const workers = await Promise.all(plan.map((entry) => Worker.create({
  connection,
  namespace,
  taskQueue: entry.taskQueue,
  ...(entry.kind === 'workflow'
    ? {
      workflowBundle: workflowBundle!,
      ...(entry.compatibilityActivities ? { activities } : {}),
    }
    : { activities }),
})));

await Promise.all(workers.map((worker) => worker.run()));
