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
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';
import {
  OLLAMA_INFERENCE_LANE_REQUEST_SIGNAL,
  OLLAMA_INFERENCE_LANE_RESPONSE_SIGNAL,
  OLLAMA_INFERENCE_LANE_WAKE_SIGNAL,
  OLLAMA_INFERENCE_LANE_WORKFLOW_ID,
  buildAgentModelActionRequest,
  completeAgentModelAction,
  executeModelInteraction,
  finalizeAgentModelCandidate,
  formatInferenceFailure,
  remainingModelInferenceDeadlineMs,
  type AgentModelActionRequest,
  type AgentModelActionResult,
  type OllamaInferenceLaneRequest,
  type OllamaInferenceLaneResponse,
  type BoundInferenceRequest,
  type OllamaInferenceRequest,
  type OllamaInferenceResult,
} from './model-protocol.js';

function remainingInferenceWaitMs(inference: OllamaInferenceRequest) {
  return inference.inferenceBudget
    ? remainingModelInferenceDeadlineMs(inference.inferenceBudget, Date.now())
    : undefined;
}

function assertInferenceDeadlineOpen(inference: OllamaInferenceRequest) {
  const remainingMs = remainingInferenceWaitMs(inference);
  if (remainingMs !== undefined && remainingMs <= 0) {
    throw ApplicationFailure.nonRetryable(
      'Inference deadline elapsed before provider execution.',
      'InferenceDeadlineExceeded',
    );
  }
  return remainingMs;
}

interface InferenceActivities {
  ollamaProviderInference(request: BoundInferenceRequest): Promise<OllamaInferenceResult>;
  openRouterInference(request: BoundInferenceRequest): Promise<OllamaInferenceResult>;
  resolveInferencePolicy(role?: AgentExecutionInput['role']): Promise<InferenceRoutingPolicy>;
}

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
      const remainingMs = assertInferenceDeadlineOpen(request.inference);
      const result = await executeChild<typeof ollamaInferenceWorkflow>('ollamaInferenceWorkflow', {
        workflowId: `ollama-inference/${request.requestId}`,
        taskQueue: OLLAMA_INFERENCE_TASK_QUEUE,
        args: [request.inference],
        ...(remainingMs !== undefined ? { workflowExecutionTimeout: remainingMs } : {}),
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
 * One replay-safe model reasoning request for a role-specific brain queue.
 *
 * This is intentionally separate from the legacy artifact interaction below:
 * callers own any plan/observe/assess loop, while each provider request remains
 * visible as its own child Workflow and local Ollama remains globally serialized.
 */
export async function modelReasoningWorkflow(
  inference: OllamaInferenceRequest,
): Promise<OllamaInferenceResult> {
  const execution = workflowInfo();
  const responses = new Map<string, OllamaInferenceLaneResponse>();

  setHandler(ollamaInferenceCompleted, (response) => {
    responses.set(response.requestId, response);
  });

  try {
    assertInferenceDeadlineOpen(inference);
    const policy = await policyActivities.resolveInferencePolicy(inference.role);
    assertInferenceDeadlineOpen(inference);
    const boundInference: BoundInferenceRequest = {
      ...inference,
      provider: policy.provider,
      model: policy.model,
    };

    if (!policy.serialize) {
      const remainingMs = assertInferenceDeadlineOpen(inference);
      return await executeChild<typeof openRouterInferenceWorkflow>('openRouterInferenceWorkflow', {
        workflowId: `openrouter-inference/${execution.runId}/1-${inference.purpose}-r${inference.round}`,
        taskQueue: OPENROUTER_INFERENCE_TASK_QUEUE,
        args: [boundInference],
        ...(remainingMs !== undefined ? { workflowExecutionTimeout: remainingMs } : {}),
      });
    }

    const requestId = `${execution.runId}:1`;
    const request: OllamaInferenceLaneRequest = {
      requestId,
      replyWorkflowId: execution.workflowId,
      replyWorkflowRunId: execution.runId,
      inference: boundInference,
    };

    await getExternalWorkflowHandle(OLLAMA_INFERENCE_LANE_WORKFLOW_ID)
      .signal(submitOllamaInference, request);
    const remainingMs = assertInferenceDeadlineOpen(inference);
    let received = true;
    if (remainingMs === undefined) await condition(() => responses.has(requestId));
    else received = await condition(() => responses.has(requestId), remainingMs);
    if (!received) {
      throw ApplicationFailure.nonRetryable(
        'Inference deadline elapsed while waiting in the Ollama queue.',
        'InferenceDeadlineExceeded',
      );
    }
    const response = responses.get(requestId);
    responses.delete(requestId);
    if (!response) {
      throw ApplicationFailure.nonRetryable(
        `Ollama inference response ${requestId} was lost.`,
        'OllamaInferenceLost',
      );
    }
    if (!response.ok) {
      throw ApplicationFailure.nonRetryable(response.error, 'OllamaInferenceFailed');
    }
    return response.result;
  } catch (error) {
    if (error instanceof ApplicationFailure) throw error;
    throw ApplicationFailure.nonRetryable(
      formatInferenceFailure(error),
      'ModelReasoningFailed',
    );
  }
}

/**
 * One high-level artifact-model operation. Generation, review and revision
 * each perform exactly one routed inference; finalization is deterministic and
 * only validates/parses a previously recorded candidate.
 */
export async function agentModelActionWorkflow(
  request: AgentModelActionRequest,
): Promise<AgentModelActionResult> {
  try {
    if (request.action === 'finalize_candidate') {
      return {
        action: request.action,
        draft: finalizeAgentModelCandidate(request),
      };
    }

    const inferenceRequest = buildAgentModelActionRequest(request);
    if (!inferenceRequest) {
      throw ApplicationFailure.nonRetryable(
        `No inference request was built for ${request.action}.`,
        'AgentModelActionInvalid',
      );
    }
    const inference = await modelReasoningWorkflow(inferenceRequest);
    return completeAgentModelAction(request.action, inferenceRequest, inference);
  } catch (error) {
    if (error instanceof ApplicationFailure) throw error;
    throw ApplicationFailure.nonRetryable(
      formatInferenceFailure(error),
      'AgentModelActionFailed',
    );
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
  const responses = new Map<string, OllamaInferenceLaneResponse>();
  let requestSequence = 0;

  setHandler(ollamaInferenceCompleted, (response) => {
    responses.set(response.requestId, response);
  });

  try {
    return await executeModelInteraction(input, async (inference) => {
      const policy = await policyActivities.resolveInferencePolicy(inference.role);
      const boundInference: BoundInferenceRequest = {
        ...inference,
        provider: policy.provider,
        model: policy.model,
      };
      if (!policy.serialize) {
        requestSequence += 1;
        const remainingMs = assertInferenceDeadlineOpen(inference);
        return await executeChild<typeof openRouterInferenceWorkflow>('openRouterInferenceWorkflow', {
          workflowId: `openrouter-inference/${execution.runId}/${requestSequence}-${inference.purpose}-r${inference.round}`,
          taskQueue: OPENROUTER_INFERENCE_TASK_QUEUE,
          args: [boundInference],
          ...(remainingMs !== undefined ? { workflowExecutionTimeout: remainingMs } : {}),
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
      const remainingMs = assertInferenceDeadlineOpen(inference);
      if (remainingMs === undefined) await condition(() => responses.has(requestId));
      else if (!await condition(() => responses.has(requestId), remainingMs)) {
        throw ApplicationFailure.nonRetryable(
          'Inference deadline elapsed while waiting in the Ollama queue.',
          'InferenceDeadlineExceeded',
        );
      }
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
