import { describe, expect, it } from 'vitest';
import {
  defaultDynamicExecutionLimits,
  dynamicActionFingerprint,
  dynamicActionOperationKey,
  dynamicExecutionFindingSchema,
  dynamicExecutionTraceSchema,
  emptyDynamicExecutionUsage,
  isSafeDynamicRepositoryPath,
  scheduleDynamicActionWave,
  validateDynamicCapabilityRegistry,
  validateDynamicExecutionPlan,
  type DynamicCapabilityDescriptor,
  type DynamicExecutionPlan,
  type RegisteredDynamicCapability,
} from './dynamic-execution.js';

describe('dynamic execution findings', () => {
  const openFinding = {
    findingId: 'quality:1:review-1:0',
    candidateVersion: 1,
    category: 'traceability',
    severity: 'medium',
    ownerRole: 'requirements',
    disposition: 'remediate_current',
    summary: 'Cite the acceptance criterion that supports the claim.',
    evidenceRefs: ['order-1/round/2/action/review-1', 'review-request-1'],
    raisedByActionId: 'review-1',
    status: 'open',
  } as const;

  it('carries structured domain findings in the durable trace', () => {
    const trace = dynamicExecutionTraceSchema.parse({
      protocolVersion: '1',
      executionId: 'order-1',
      status: 'blocked',
      terminalReason: 'The revision budget was exhausted.',
      limits: defaultDynamicExecutionLimits,
      usage: emptyDynamicExecutionUsage,
      plans: [],
      observations: [],
      invocations: [{
        provider: 'openrouter',
        model: 'reviewer-model',
        purpose: 'quality_review',
        round: 1,
        requestId: 'review-request-1',
        usage: { promptTokens: 12, completionTokens: 4, reasoningTokens: 2, totalTokens: 16, cost: 0.001 },
      }],
      findings: [openFinding],
    });

    expect(trace.findings).toEqual([expect.objectContaining({
      category: 'traceability',
      severity: 'medium',
      ownerRole: 'requirements',
      disposition: 'remediate_current',
      evidenceRefs: expect.arrayContaining(['review-request-1']),
      status: 'open',
    })]);
    expect(trace.invocations).toEqual([expect.objectContaining({
      provider: 'openrouter',
      purpose: 'quality_review',
      requestId: 'review-request-1',
      usage: expect.objectContaining({ reasoningTokens: 2 }),
    })]);
  });

  it('rejects unrecognized model-invocation audit fields', () => {
    expect(dynamicExecutionTraceSchema.safeParse({
      protocolVersion: '1',
      executionId: 'order-1',
      status: 'blocked',
      terminalReason: 'The revision budget was exhausted.',
      limits: defaultDynamicExecutionLimits,
      usage: emptyDynamicExecutionUsage,
      plans: [],
      observations: [],
      invocations: [{
        model: 'reviewer-model',
        purpose: 'quality_review',
        round: 1,
        undocumented: true,
      }],
      findings: [],
    }).success).toBe(false);
  });

  it('requires deterministic resolution evidence for resolved findings', () => {
    expect(dynamicExecutionFindingSchema.safeParse({
      ...openFinding,
      status: 'resolved',
    }).success).toBe(false);
    expect(dynamicExecutionFindingSchema.parse({
      ...openFinding,
      status: 'resolved',
      evidenceRefs: [...openFinding.evidenceRefs, 'order-1/round/3/action/revise-1'],
      resolvedByActionId: 'revise-1',
      resolvedInCandidateVersion: 2,
    })).toMatchObject({ status: 'resolved', resolvedInCandidateVersion: 2 });
  });
});

function capability(
  name: string,
  effect: DynamicCapabilityDescriptor['effect'] = 'read_only',
  overrides: Partial<DynamicCapabilityDescriptor> = {},
): RegisteredDynamicCapability {
  return {
    descriptor: {
      protocolVersion: '1',
      name,
      version: '1.0',
      description: `Execute ${name}.`,
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object' },
      requiredAuthorityAction: name,
      effect,
      idempotency: effect === 'mutating'
        ? { mode: 'operation_key', conflictPolicy: 'reuse_result' }
        : { mode: 'intrinsic', conflictPolicy: 'reuse_result' },
      timeoutMs: 30_000,
      retryPolicy: { maximumAttempts: 2, initialBackoffMs: 100, maximumBackoffMs: 1_000 },
      dataClassifications: ['project'],
      maxResultBytes: 100_000,
      approval: 'never',
      pathArguments: [],
      ...overrides,
    },
    validateArguments: (arguments_) => Object.keys(arguments_).some((key) => key !== 'path')
      ? ['Only path is supported.']
      : [],
    validateResult: () => [],
  };
}

const registry = [
  capability('repository.read_file', 'read_only', { pathArguments: ['path'] }),
  capability('repository.search', 'read_only'),
  capability('repository.write_patch', 'mutating', {
    pathArguments: ['path'],
    mutationScopeArgument: 'path',
  }),
];

function plan(actions: DynamicExecutionPlan['actions']): DynamicExecutionPlan {
  return {
    protocolVersion: '1',
    goalAssessment: 'Repository evidence is still required.',
    contextVersion: 4,
    acknowledgedDecisionIds: ['decision-1'],
    actions,
    completionCheck: { type: 'continue', reason: 'Observe the results before deciding.' },
  };
}

function context(overrides: Partial<Parameters<typeof validateDynamicExecutionPlan>[2]> = {}) {
  return {
    limits: defaultDynamicExecutionLimits,
    totalActionsExecuted: 0,
    authorityActions: new Set(registry.map((entry) => entry.descriptor.requiredAuthorityAction)),
    mutationScopes: ['src'],
    requiredDecisionIds: ['decision-1'],
    contextVersion: 4,
    ...overrides,
  };
}

describe('dynamic capability and plan validation', () => {
  it('accepts a strict, bounded and authorized plan', () => {
    const candidate = plan([
      {
        id: 'read-manifest',
        activity: 'repository.read_file',
        activityVersion: '1.0',
        arguments: { path: 'src/index.ts' },
        dependsOn: [],
        reason: 'Inspect the current entry point.',
      },
      {
        id: 'apply-patch',
        activity: 'repository.write_patch',
        activityVersion: '1.0',
        arguments: { path: 'src/index.ts' },
        dependsOn: ['read-manifest'],
        reason: 'Apply the bounded change after inspecting the target.',
      },
    ]);

    expect(validateDynamicExecutionPlan(candidate, registry, context())).toEqual({
      ok: true,
      plan: candidate,
    });
  });

  it('rejects an invalid batch atomically across structure, authority, paths and dependencies', () => {
    const candidate = plan([
      {
        id: 'unsafe',
        activity: 'repository.write_patch',
        activityVersion: '2.0',
        arguments: { path: '../secrets.env' },
        dependsOn: ['missing'],
        reason: 'Attempt an invalid operation.',
      },
    ]) as DynamicExecutionPlan & { unexpected?: boolean };
    candidate.unexpected = true;
    const result = validateDynamicExecutionPlan(candidate, registry, context({
      authorityActions: new Set(),
    }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected validation failure.');
    // Strict parsing rejects the whole plan before any action can be selected.
    expect(result.issues.map((entry) => entry.code)).toContain('INVALID_PLAN');

    delete candidate.unexpected;
    const semantic = validateDynamicExecutionPlan(candidate, registry, context({ authorityActions: new Set() }));
    expect(semantic.ok).toBe(false);
    if (semantic.ok) throw new Error('Expected semantic validation failure.');
    expect(semantic.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'ACTIVITY_VERSION_MISMATCH',
      'UNKNOWN_DEPENDENCY',
    ]));
  });

  it('rejects ignored human decisions, out-of-scope mutations and unjustified repeated work', () => {
    const repeated = {
      id: 'write-again',
      activity: 'repository.write_patch',
      activityVersion: '1.0',
      arguments: { path: 'other/index.ts' },
      dependsOn: [],
      reason: 'Repeat it.',
    } as const;
    const result = validateDynamicExecutionPlan({
      ...plan([repeated]),
      acknowledgedDecisionIds: [],
    }, registry, context({
      previousActions: [{
        actionId: 'write-before',
        fingerprint: dynamicActionFingerprint(repeated),
        status: 'succeeded',
      }],
    }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected validation failure.');
    expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'HUMAN_DECISION_IGNORED',
      'MUTATION_OUT_OF_SCOPE',
      'REPEATED_ACTION',
    ]));
  });

  it('requires mutating capabilities to use durable operation keys', () => {
    const invalid = capability('repository.write_file', 'mutating', {
      idempotency: { mode: 'intrinsic', conflictPolicy: 'reuse_result' },
    });
    expect(validateDynamicCapabilityRegistry([invalid]).map((entry) => entry.code))
      .toContain('INVALID_CAPABILITY_REGISTRY');
  });

  it('rejects capabilities whose declared schemas have no executable validators', () => {
    const incomplete = {
      descriptor: capability('repository.inspect_history').descriptor,
    } as RegisteredDynamicCapability;
    const issues = validateDynamicCapabilityRegistry([incomplete]);
    expect(issues.map((entry) => entry.message)).toEqual(expect.arrayContaining([
      expect.stringContaining('strict input validator'),
      expect.stringContaining('strict output validator'),
    ]));
  });
});

describe('dynamic action scheduling', () => {
  it('runs dependency-ready reads in stable parallel waves and serializes mutations', () => {
    const candidate = plan([
      {
        id: 'read-a', activity: 'repository.read_file', activityVersion: '1.0',
        arguments: { path: 'src/a.ts' }, dependsOn: [], reason: 'Read A.',
      },
      {
        id: 'read-b', activity: 'repository.search', activityVersion: '1.0',
        arguments: {}, dependsOn: [], reason: 'Search B.',
      },
      {
        id: 'write', activity: 'repository.write_patch', activityVersion: '1.0',
        arguments: { path: 'src/a.ts' }, dependsOn: ['read-a'], reason: 'Write A.',
      },
    ]);

    expect(scheduleDynamicActionWave(candidate, registry, new Map(), 2).ready.map((action) => action.id))
      .toEqual(['read-a', 'read-b']);
    expect(scheduleDynamicActionWave(candidate, registry, new Map([
      ['read-a', 'succeeded'], ['read-b', 'succeeded'],
    ]), 2).ready.map((action) => action.id)).toEqual(['write']);
  });

  it('does not schedule work whose dependency failed', () => {
    const candidate = plan([
      {
        id: 'read', activity: 'repository.read_file', activityVersion: '1.0',
        arguments: { path: 'src/a.ts' }, dependsOn: [], reason: 'Read A.',
      },
      {
        id: 'write', activity: 'repository.write_patch', activityVersion: '1.0',
        arguments: { path: 'src/a.ts' }, dependsOn: ['read'], reason: 'Write A.',
      },
    ]);
    const scheduled = scheduleDynamicActionWave(candidate, registry, new Map([['read', 'failed']]), 2);
    expect(scheduled.ready).toEqual([]);
    expect(scheduled.blocked.map((action) => action.id)).toEqual(['write']);
  });

  it('derives stable replay-safe action identities', () => {
    const action = {
      id: 'read', activity: 'repository.read_file', activityVersion: '1.0',
      arguments: { path: 'src/a.ts' }, dependsOn: [], reason: 'Read A.',
    };
    expect(dynamicActionOperationKey('order-7', 2, action))
      .toBe('order-7/round/2/action/read/repository.read_file@1.0');
    expect(dynamicActionFingerprint(action)).toBe(dynamicActionFingerprint({
      ...action,
      arguments: { path: 'src/a.ts' },
    }));
  });
});

describe('repository path boundary', () => {
  it.each([
    '/absolute',
    '../escape',
    'src/../escape',
    'src\\windows',
    '.git/config',
    '.github/workflows/release.yml',
    '.forgejo/workflows/release.yml',
  ])('rejects %s', (path) => {
    expect(isSafeDynamicRepositoryPath(path)).toBe(false);
  });

  it('accepts a normal repository-relative path', () => {
    expect(isSafeDynamicRepositoryPath('apps/worker/src/runtime.ts')).toBe(true);
  });
});
