import {
  MODEL_ROUTING_TASK_QUEUE,
  OLLAMA_INFERENCE_TASK_QUEUE,
  OPENROUTER_INFERENCE_TASK_QUEUE,
  type AgentArtifactDraft,
  type AgentExecutionInput,
  type InferenceRoutingPolicy,
} from '@orchestra/contracts';
import {
  ApplicationFailure,
  condition,
  continueAsNew,
  defineSignal,
  executeChild,
  getExternalWorkflowHandle,
  proxyActivities,
  patched,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import {
  OLLAMA_INFERENCE_LANE_REQUEST_SIGNAL,
  OLLAMA_INFERENCE_LANE_RESPONSE_SIGNAL,
  OLLAMA_INFERENCE_LANE_WAKE_SIGNAL,
  OLLAMA_INFERENCE_LANE_WORKFLOW_ID,
  executeModelInteraction,
  formatInferenceFailure,
  type OllamaInferenceLaneRequest,
  type OllamaInferenceLaneResponse,
  type BoundInferenceRequest,
  type OllamaInferenceRequest,
  type OllamaInferenceResult,
} from './model-protocol.js';

interface InferenceActivities {
  ollamaInference(request: OllamaInferenceRequest): Promise<OllamaInferenceResult>;
  ollamaProviderInference(request: BoundInferenceRequest): Promise<OllamaInferenceResult>;
  openRouterInference(request: BoundInferenceRequest): Promise<OllamaInferenceResult>;
  resolveInferencePolicy(role?: AgentExecutionInput['role']): Promise<InferenceRoutingPolicy>;
}

const legacyInferenceActivities = proxyActivities<Pick<InferenceActivities, 'ollamaInference'>>({
  taskQueue: OLLAMA_INFERENCE_TASK_QUEUE,
  startToCloseTimeout: '30 minutes',
  scheduleToCloseTimeout: '2 hours',
  // Retrying an ambiguous timeout could overlap the prior HTTP call. A new
  // model interaction must be started deliberately instead.
  retry: { maximumAttempts: 1 },
});

const ollamaActivities = proxyActivities<Pick<InferenceActivities, 'ollamaProviderInference'>>({
  taskQueue: OLLAMA_INFERENCE_TASK_QUEUE,
  startToCloseTimeout: '30 minutes',
  scheduleToCloseTimeout: '2 hours',
  retry: { maximumAttempts: 1 },
});

const openRouterActivities = proxyActivities<Pick<InferenceActivities, 'openRouterInference'>>({
  taskQueue: OPENROUTER_INFERENCE_TASK_QUEUE,
  startToCloseTimeout: '15 minutes',
  scheduleToCloseTimeout: '30 minutes',
  heartbeatTimeout: '30 seconds',
  // HTTP retries are bounded inside the Activity, where status and Retry-After are visible.
  retry: { maximumAttempts: 1 },
});

const policyActivities = proxyActivities<Pick<InferenceActivities, 'resolveInferencePolicy'>>({
  taskQueue: MODEL_ROUTING_TASK_QUEUE,
  startToCloseTimeout: '30 seconds',
  scheduleToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3 },
});

const submitOllamaInference = defineSignal<[OllamaInferenceLaneRequest]>(
  OLLAMA_INFERENCE_LANE_REQUEST_SIGNAL,
);
const ollamaInferenceCompleted = defineSignal<[OllamaInferenceLaneResponse]>(
  OLLAMA_INFERENCE_LANE_RESPONSE_SIGNAL,
);
const wakeOllamaInferenceLane = defineSignal(OLLAMA_INFERENCE_LANE_WAKE_SIGNAL);

/** The sole Workflow entry point that is allowed to invoke the inference Activity. */
export async function ollamaInferenceWorkflow(
  request: BoundInferenceRequest,
): Promise<OllamaInferenceResult> {
  return await ollamaActivities.ollamaProviderInference(request);
}

/** A visible, independently timed child execution for one hosted-provider request. */
export async function openRouterInferenceWorkflow(
  request: BoundInferenceRequest,
): Promise<OllamaInferenceResult> {
  return await openRouterActivities.openRouterInference(request);
}

/**
 * A single, stable Workflow execution is the global Ollama serialization
 * invariant. Requests are accepted through a FIFO mailbox, and each inference
 * child is awaited before the next request is started.
 */
export async function ollamaInferenceLaneWorkflow(): Promise<never> {
  const inbox: OllamaInferenceLaneRequest[] = [];
  const queuedRequestIds = new Set<string>();

  setHandler(submitOllamaInference, (request) => {
    if (queuedRequestIds.has(request.requestId)) return;
    queuedRequestIds.add(request.requestId);
    inbox.push(request);
  });
  setHandler(wakeOllamaInferenceLane, () => undefined);

  while (true) {
    await condition(() => inbox.length > 0);
    const request = inbox.shift();
    if (!request) continue;

    let response: OllamaInferenceLaneResponse;
    try {
      const result = await executeChild<typeof ollamaInferenceWorkflow>('ollamaInferenceWorkflow', {
        workflowId: `ollama-inference/${request.requestId}`,
        taskQueue: OLLAMA_INFERENCE_TASK_QUEUE,
        args: [request.inference],
      });
      response = { requestId: request.requestId, ok: true, result };
    } catch (error) {
      // Preserve Activity/ChildWorkflow cause chains (e.g. HeadersTimeout) for the brain.
      response = { requestId: request.requestId, ok: false, error: formatInferenceFailure(error) };
    }

    try {
      await getExternalWorkflowHandle(request.replyWorkflowId, request.replyWorkflowRunId)
        .signal(ollamaInferenceCompleted, response);
    } catch {
      // The requester may have been cancelled; it must not poison the global lane.
    }
    queuedRequestIds.delete(request.requestId);

    if (inbox.length === 0 && workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof ollamaInferenceLaneWorkflow>();
    }
  }
}

/**
 * Role-specific brain Workflow: generate, independently review, and perform a
 * bounded number of complete revisions before returning an artifact draft.
 * Local Ollama uses the singleton FIFO lane. OpenRouter uses one visible child
 * workflow per request while allowing independent brains to run in parallel.
 */
export async function modelInteractionWorkflow(
  input: AgentExecutionInput,
): Promise<AgentArtifactDraft> {
  const execution = workflowInfo();
  const providerBoundRouting = patched('provider-bound-inference-v1');
  const visibleOpenRouterRequests = providerBoundRouting
    && patched('openrouter-request-workflow-v1');
  const perRequestRouting = providerBoundRouting
    && patched('per-request-inference-routing-v1');
  const interactionPolicy = providerBoundRouting
    ? perRequestRouting
      ? undefined
      : await policyActivities.resolveInferencePolicy(input.role)
    : await proxyActivities<Pick<InferenceActivities, 'resolveInferencePolicy'>>({
      taskQueue: OLLAMA_INFERENCE_TASK_QUEUE,
      startToCloseTimeout: '30 seconds',
      scheduleToCloseTimeout: '2 minutes',
      retry: { maximumAttempts: 3 },
    }).resolveInferencePolicy();
  const responses = new Map<string, OllamaInferenceLaneResponse>();
  let requestSequence = 0;

  setHandler(ollamaInferenceCompleted, (response) => {
    responses.set(response.requestId, response);
  });

  try {
    return await executeModelInteraction(input, async (inference) => {
      if (!providerBoundRouting) {
        return await legacyInferenceActivities.ollamaInference(inference);
      }

      const policy = perRequestRouting
        ? await policyActivities.resolveInferencePolicy(inference.role)
        : interactionPolicy;
      if (!policy) {
        throw ApplicationFailure.nonRetryable(
          `No inference route was resolved for ${inference.role}.`,
          'InferenceRouteMissing',
        );
      }
      const boundInference: BoundInferenceRequest = {
        ...inference,
        provider: policy.provider,
        model: policy.model,
      };
      if (!policy.serialize) {
        if (!visibleOpenRouterRequests) {
          return await openRouterActivities.openRouterInference(boundInference);
        }
        requestSequence += 1;
        return await executeChild<typeof openRouterInferenceWorkflow>('openRouterInferenceWorkflow', {
          workflowId: `openrouter-inference/${execution.runId}/${requestSequence}-${inference.purpose}-r${inference.round}`,
          taskQueue: OPENROUTER_INFERENCE_TASK_QUEUE,
          args: [boundInference],
        });
      }

      requestSequence += 1;
      const requestId = `${execution.runId}:${requestSequence}`;
      const request: OllamaInferenceLaneRequest = {
        requestId,
        replyWorkflowId: execution.workflowId,
        replyWorkflowRunId: execution.runId,
        inference: boundInference,
      };

      await getExternalWorkflowHandle(OLLAMA_INFERENCE_LANE_WORKFLOW_ID)
        .signal(submitOllamaInference, request);
      await condition(() => responses.has(requestId));
      const response = responses.get(requestId);
      responses.delete(requestId);
      if (!response) {
        throw ApplicationFailure.nonRetryable(
          `Ollama inference response ${requestId} was lost.`,
          'OllamaInferenceLost',
        );
      }
      if (!response.ok) {
        // Plain Error would only fail the Workflow Task and retry forever in the UI.
        throw ApplicationFailure.nonRetryable(response.error, 'OllamaInferenceFailed');
      }
      return response.result;
    });
  } catch (error) {
    if (error instanceof ApplicationFailure) throw error;
    throw ApplicationFailure.nonRetryable(
      formatInferenceFailure(error),
      'ModelInteractionFailed',
    );
  }
}
