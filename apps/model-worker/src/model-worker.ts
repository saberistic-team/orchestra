import {
  OLLAMA_INFERENCE_TASK_QUEUE,
  resolveModelConcurrency,
} from '@orchestra/contracts';
import { Client } from '@temporalio/client';
import { NativeConnection, Worker, bundleWorkflowCode } from '@temporalio/worker';
import {
  configureModelWorkflowClient,
  ollamaInference,
  ollamaProviderInference,
  openRouterInference,
  resolveInferencePolicy,
  runAgent,
} from './activities.js';
import {
  OLLAMA_INFERENCE_LANE_WAKE_SIGNAL,
  OLLAMA_INFERENCE_LANE_WORKFLOW_ID,
} from './model-protocol.js';
import { modelWorkerQueuePlan, parseModelWorkerMode } from './worker-topology.js';

const connection = await NativeConnection.connect({
  address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
});
const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
const client = new Client({ connection, namespace });
configureModelWorkflowClient(client);

const mode = parseModelWorkerMode(process.env.MODEL_WORKER_MODE);
const plan = modelWorkerQueuePlan(
  mode,
  process.env.MODEL_WORKER_ROLES,
  process.env.MODEL_TASK_QUEUE,
);
const needsWorkflowBundle = plan.some((entry) => entry.kind !== 'compatibility');
const workflowExtension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
const workflowsPath = new URL(`./workflows.${workflowExtension}`, import.meta.url).pathname;
const workflowBundle = needsWorkflowBundle
  ? await bundleWorkflowCode({ workflowsPath })
  : undefined;

// Signal-with-Start is idempotent for the fixed workflow ID (USE_EXISTING is
// the SDK default). Brain-only processes also bootstrap it so Ollama requests
// can be durably queued before a separate inference process is ready.
if (plan.some((entry) => entry.kind === 'ollama-inference')) {
  await client.workflow.signalWithStart('ollamaInferenceLaneWorkflow', {
    workflowId: OLLAMA_INFERENCE_LANE_WORKFLOW_ID,
    taskQueue: OLLAMA_INFERENCE_TASK_QUEUE,
    args: [],
    signal: OLLAMA_INFERENCE_LANE_WAKE_SIGNAL,
    signalArgs: [],
  });
}

const workers = await Promise.all(plan.map((entry) => {
  if (entry.kind === 'brain') {
    if (!workflowBundle) throw new Error('Model brain worker has no Workflow bundle.');
    return Worker.create({
      connection,
      namespace,
      taskQueue: entry.taskQueue,
      workflowBundle,
    });
  }
  if (entry.kind === 'routing') {
    return Worker.create({
      connection,
      namespace,
      taskQueue: entry.taskQueue,
      activities: { resolveInferencePolicy },
      maxConcurrentActivityTaskExecutions: 32,
    });
  }
  if (entry.kind === 'ollama-inference') {
    if (!workflowBundle) throw new Error('Model inference worker has no Workflow bundle.');
    return Worker.create({
      connection,
      namespace,
      taskQueue: entry.taskQueue,
      workflowBundle,
      activities: { ollamaInference, ollamaProviderInference },
      maxConcurrentActivityTaskExecutions: 1,
      maxConcurrentLocalActivityExecutions: 1,
    });
  }
  if (entry.kind === 'openrouter-inference') {
    if (!workflowBundle) throw new Error('OpenRouter inference worker has no Workflow bundle.');
    const concurrency = resolveModelConcurrency(process.env, 'openrouter');
    return Worker.create({
      connection,
      namespace,
      taskQueue: entry.taskQueue,
      workflowBundle,
      activities: { openRouterInference },
      maxConcurrentActivityTaskExecutions: concurrency,
      maxConcurrentLocalActivityExecutions: concurrency,
    });
  }
  return Worker.create({
    connection,
    namespace,
    taskQueue: entry.taskQueue,
    activities: { runAgent },
    maxConcurrentActivityTaskExecutions: 1,
    maxConcurrentLocalActivityExecutions: 1,
  });
}));

await Promise.all(workers.map((worker) => worker.run()));
