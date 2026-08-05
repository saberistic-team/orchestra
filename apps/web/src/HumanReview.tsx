import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  agentRoleDefinitions,
  type AgentRole,
  type IterationReview,
  type ProjectArtifact,
  type ProjectDetail,
  type ProjectIteration,
  type ProjectMedia,
} from '@orchestra/contracts';
import { formatTimestamp, roleLabel } from './human-loop.js';
import './human-review.css';

interface HumanReviewWorkspaceProps {
  detail: ProjectDetail;
  preview: string | null;
  onReload: () => Promise<void>;
}

interface IterationEvidenceGroup {
  iteration: ProjectIteration;
  producers: Array<{ role: AgentRole; artifacts: ProjectArtifact[] }>;
  artifactCount: number;
  videos: ProjectMedia[];
}

type ReviewDecision = 'approved' | 'changes_requested';
type FeedbackMap<Key extends string> = Partial<Record<Key, string>>;

export function HumanReviewWorkspace({ detail, preview, onReload }: HumanReviewWorkspaceProps) {
  const [artifactFeedback, setArtifactFeedback] = useState<FeedbackMap<string>>(() => persistedArtifactFeedback(detail));
  const [openArtifact, setOpenArtifact] = useState<ProjectArtifact>();
  const [returnFocus, setReturnFocus] = useState<HTMLElement | null>(null);
  const evidenceGroups = buildEvidenceGroups(detail);
  const currentIterationId = detail.iterations.find((iteration) => iteration.number === detail.project.currentIteration)?.id;

  useEffect(() => {
    const persisted = persistedArtifactFeedback(detail);
    setArtifactFeedback((current) => ({ ...persisted, ...current }));
  }, [detail.artifactFeedback]);

  return <>
    <IterationEvidence
      groups={evidenceGroups}
      currentIteration={detail.project.currentIteration}
      artifactFeedback={artifactFeedback}
      onOpenArtifact={(artifact, trigger) => { setOpenArtifact(artifact); setReturnFocus(trigger); }}
    />

    <IterationDecision
      detail={detail}
      preview={preview}
      artifactFeedback={artifactFeedback}
      onReload={onReload}
    />

    {openArtifact ? <ArtifactDialog
      key={openArtifact.id}
      artifact={openArtifact}
      iterationNumber={detail.iterations.find((iteration) => iteration.id === openArtifact.iterationId)?.number}
      feedback={artifactFeedback[openArtifact.id] ?? ''}
      onFeedback={(value) => setArtifactFeedback((current) => ({ ...current, [openArtifact.id]: value }))}
      onClose={() => setOpenArtifact(undefined)}
      returnFocus={returnFocus}
      projectId={detail.project.id}
      submitWithReview={openArtifact.iterationId === currentIterationId}
      onSaved={onReload}
    /> : null}
  </>;
}

function IterationEvidence({
  groups,
  currentIteration,
  artifactFeedback,
  onOpenArtifact,
}: {
  groups: IterationEvidenceGroup[];
  currentIteration: number;
  artifactFeedback: FeedbackMap<string>;
  onOpenArtifact: (artifact: ProjectArtifact, trigger: HTMLElement) => void;
}) {
  const id = useId();
  return <section className="review-evidence" aria-labelledby={`${id}-title`}>
    <div className="review-section-heading"><div><p className="eyebrow">Review package</p><h2 id={`${id}-title`}>Evidence by iteration</h2></div><p>Open an artifact for a full-size reading view and leave feedback tied to that exact version.</p></div>
    <div className="review-evidence__groups">{groups.map(({ iteration, producers, artifactCount, videos }) => <section className="iteration-evidence" key={iteration.id} aria-labelledby={`${id}-iteration-${iteration.number}`}>
      <div className="iteration-evidence__heading">
        <div><span>{iteration.number === currentIteration ? 'Current review' : 'Previous iteration'}</span><h3 id={`${id}-iteration-${iteration.number}`}>Iteration {iteration.number} review evidence</h3><p>{iteration.objective}</p></div>
        <span className={`iteration-evidence__status iteration-evidence__status--${iteration.status}`}>{iteration.status.replaceAll('_', ' ')}</span>
      </div>

      <div className="iteration-evidence__section">
        <div className="iteration-evidence__label"><h4>Artifacts by agent</h4><span>{artifactCount}</span></div>
        {producers.length > 0 ? <div className="artifact-producer-list">{producers.map(({ role, artifacts }) => <details className="artifact-producer" key={role}>
          <summary>
            <span className="artifact-producer__identity"><i aria-hidden="true">{agentRoleDefinitions.find((definition) => definition.role === role)?.icon ?? '•'}</i><span><strong>{roleLabel(role)}</strong><small>{artifacts.length} {artifacts.length === 1 ? 'artifact' : 'artifacts'}</small></span></span>
            <span className="artifact-producer__preview">{artifacts.slice(0, 2).map((artifact) => artifact.name).join(' · ')}{artifacts.length > 2 ? ` · +${artifacts.length - 2}` : ''}</span>
            <b aria-hidden="true">⌄</b>
          </summary>
          <div className="artifact-compact-grid">{artifacts.map((artifact) => <button type="button" className="artifact-compact" key={artifact.id} onClick={(event) => onOpenArtifact(artifact, event.currentTarget)} aria-label={`Open ${artifact.name}, version ${artifact.version}`}>
            <span className="artifact-compact__top"><i aria-hidden="true">{artifactIcon(artifact)}</i><span>{humanizeMimeType(artifact.mimeType)}</span></span>
            <strong>{artifact.name}</strong>
            <span className="artifact-compact__meta"><span>v{artifact.version}</span><span>{artifact.status.replaceAll('_', ' ')}</span></span>
            <span className="artifact-compact__action">Open full artifact <b aria-hidden="true">↗</b></span>
            {artifactFeedback[artifact.id]?.trim() ? <em>Feedback added ✓</em> : null}
          </button>)}</div>
        </details>)}</div> : <p className="iteration-evidence__empty">No artifacts were attached to this iteration.</p>}
      </div>

      <div className="iteration-evidence__section iteration-evidence__section--journeys">
        <div className="iteration-evidence__label"><h4>Journey recordings</h4><span>{videos.length}</span></div>
        {videos.length > 0 ? <div className="journey-grid">{videos.map((video) => <article className="journey-card" key={video.id}>
          <div className="journey-card__media"><video controls preload="metadata" src={video.url} /><span><i aria-hidden="true">▶</i> Review evidence</span></div>
          <div><strong>{video.title}</strong><span>Recorded {formatTimestamp(video.createdAt)}</span></div>
        </article>)}</div> : <p className="iteration-evidence__empty">No journey recording was attached to this iteration.</p>}
      </div>
    </section>)}</div>
  </section>;
}

function IterationDecision({ detail, preview, artifactFeedback, onReload }: { detail: ProjectDetail; preview: string | null; artifactFeedback: FeedbackMap<string>; onReload: () => Promise<void> }) {
  const id = useId();
  const [decision, setDecision] = useState<ReviewDecision>();
  const [overallDirection, setOverallDirection] = useState('');
  const [agentFeedback, setAgentFeedback] = useState<FeedbackMap<AgentRole>>({});
  const [submitState, setSubmitState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [retryState, setRetryState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [previewTried, setPreviewTried] = useState(false);
  const [expiryVersion, refreshExpiry] = useState(0);
  const checkpoint = detail.reviewCheckpoint;

  useEffect(() => {
    setIdempotencyKey(crypto.randomUUID());
    setSubmitState('idle');
    setPreviewTried(false);
  }, [checkpoint?.reviewToken]);

  useEffect(() => {
    if (!checkpoint?.previewExpiresAt) return undefined;
    const delay = Date.parse(checkpoint.previewExpiresAt) - Date.now();
    if (!Number.isFinite(delay) || delay <= 0) {
      setPreviewTried(false);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setPreviewTried(false);
      refreshExpiry((value) => value + 1);
    }, Math.min(delay + 1, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [checkpoint?.previewExpiresAt, expiryVersion]);

  if (detail.project.status !== 'awaiting_approval') return <section className="iteration-decision iteration-decision--waiting">
    <span aria-hidden="true">◇</span><div><p className="eyebrow">Decision checkpoint</p><h2>{detail.project.status === 'blocked' ? 'The preview or evidence needs attention.' : 'The next review will open when the evidence is ready.'}</h2><p>{detail.project.status === 'blocked' ? 'Read the latest event, fix or comment on the blocking issue, then retry this step. Approval stays closed until a healthy deployment is ready.' : 'You can still inspect prior artifacts and leave agent comments from the living organism.'}</p>{detail.project.status === 'blocked' ? <><button className="iteration-decision__retry" type="button" disabled={retryState === 'sending' || retryState === 'sent'} onClick={async () => {
      setRetryState('sending');
      try {
        const response = await fetch(`/api/projects/${detail.project.id}/resume`, { method: 'POST' });
        if (!response.ok) throw new Error();
        setRetryState('sent');
        await onReload();
      } catch { setRetryState('error'); }
    }}>{retryState === 'sending' ? 'Retrying…' : retryState === 'sent' ? 'Retry requested ✓' : 'Retry blocked step →'}</button>{retryState === 'error' ? <small role="alert">The retry could not be requested. Your comments are still saved.</small> : null}</> : null}</div>
  </section>;

  async function submitReview(event: FormEvent) {
    event.preventDefault();
    if (!decision || !checkpoint) return;
    const triedAt = new Date();
    if (decision === 'approved' && (
      !approvalReady
      || !checkpoint.previewExpiresAt
      || triedAt.getTime() > Date.parse(checkpoint.previewExpiresAt)
    )) {
      setPreviewTried(false);
      setSubmitState('error');
      return;
    }
    setSubmitState('sending');
    const agentNotes = agentRoleDefinitions.map(({ role }) => ({ role, feedback: (agentFeedback[role] ?? '').trim() }));
    const currentIterationId = detail.iterations.find((iteration) => iteration.number === detail.project.currentIteration)?.id;
    const currentArtifactIds = new Set(detail.artifacts.filter((artifact) => artifact.iterationId === currentIterationId).map((artifact) => artifact.id));
    const artifactNotes = entries(artifactFeedback)
      .filter(([artifactId]) => currentArtifactIds.has(artifactId))
      .map(([artifactId, feedback]) => ({ artifactId, feedback: feedback.trim() }));
    const legacyFeedback = buildLegacyFeedback(overallDirection, agentNotes, artifactNotes, decision);
    const review = {
      decision,
      feedback: legacyFeedback,
      overallDirection: overallDirection.trim(),
      agentFeedback: agentNotes,
      artifactFeedback: artifactNotes,
      ...(previewTried && checkpoint.previewRevision && checkpoint.previewImageDigest && !previewExpired ? {
        previewAttestation: {
          revision: checkpoint.previewRevision,
          imageDigest: checkpoint.previewImageDigest,
          triedAt: triedAt.toISOString(),
        },
      } : {}),
    } satisfies IterationReview;
    const payload = {
      iterationId: checkpoint.iterationId,
      reviewToken: checkpoint.reviewToken,
      idempotencyKey,
      review,
    };
    try {
      const response = await fetch(`/api/projects/${detail.project.id}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error();
      setSubmitState('sent');
      await onReload();
    } catch {
      setSubmitState('error');
    }
  }

  const artifactCount = detail.artifacts.filter((artifact) => detail.iterations.find((iteration) => iteration.number === detail.project.currentIteration)?.id === artifact.iterationId).length;
  const videoCount = detail.media.filter((media) => media.kind === 'user_flow_video' && detail.iterations.find((iteration) => iteration.number === detail.project.currentIteration)?.id === media.iterationId).length;
  const currentIterationId = detail.iterations.find((iteration) => iteration.number === detail.project.currentIteration)?.id;
  const currentArtifactIds = new Set(detail.artifacts.filter((artifact) => artifact.iterationId === currentIterationId).map((artifact) => artifact.id));
  const artifactNoteCount = entries(artifactFeedback).filter(([artifactId]) => currentArtifactIds.has(artifactId)).length;
  const currentPreviews = detail.media.filter((media) => media.kind === 'preview' && media.iterationId === currentIterationId);
  const currentPreview = checkpoint?.previewRevision && checkpoint.previewImageDigest
    ? currentPreviews
      .filter((media) => media.sourceRevision === checkpoint.previewRevision && media.imageDigest === checkpoint.previewImageDigest)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0]
    : !checkpoint?.previewRevision && !checkpoint?.previewImageDigest
      ? [...currentPreviews].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0]
      : undefined;
  const previewRevision = currentPreview?.sourceRevision;
  const previewImageDigest = currentPreview?.imageDigest;
  const previewExpired = Boolean(
    checkpoint?.previewExpiresAt
      && Date.now() >= Date.parse(checkpoint.previewExpiresAt),
  );
  const previewEvidenceMatchesCheckpoint = Boolean(
    checkpoint?.previewRevision
      && checkpoint.previewImageDigest
      && checkpoint.previewExpiresAt
      && previewRevision === checkpoint.previewRevision
      && previewImageDigest === checkpoint.previewImageDigest
      && currentPreview?.expiresAt === checkpoint.previewExpiresAt,
  );
  const approvalReady = Boolean(
    preview
      && checkpoint
      && previewEvidenceMatchesCheckpoint
      && currentPreview?.url === preview
      && !previewExpired
      && previewTried,
  );

  return <section className="iteration-decision" aria-labelledby={`${id}-title`}>
    <div className="iteration-decision__heading"><div><p className="eyebrow">Your decision</p><h2 id={`${id}-title`}>Review iteration {detail.project.currentIteration}</h2><p>Try the deployed result, add any precise notes, then choose whether the organism may continue.</p></div><span>Human authority required</span></div>

    <form onSubmit={submitReview}>
      <section className="preview-check" aria-labelledby={`${id}-preview-title`}>
        <div className="preview-check__copy"><span>01 · Try it first</span><h3 id={`${id}-preview-title`}>Launch the deployed preview before deciding.</h3><p>Walk through the important journey and compare it with the recordings and artifacts above.</p>{previewRevision && previewImageDigest ? <small className={previewExpired ? 'is-expired' : ''}>Local Docker revision <code>{previewRevision.slice(0, 12)}</code> · image <code>{previewImageDigest.slice(7, 19)}</code>{checkpoint?.previewExpiresAt ? ` · ${previewExpired ? 'expired' : 'available until'} ${formatTimestamp(checkpoint.previewExpiresAt)}` : ''}</small> : null}</div>
        {preview && !previewExpired ? <a className="preview-check__launch" href={preview} target="_blank" rel="noreferrer"><span aria-hidden="true">▶</span><strong>Launch deployed preview</strong><small>Opens this exact revision and image ↗</small></a> : <button className="preview-check__launch is-disabled" type="button" disabled><span aria-hidden="true">○</span><strong>{previewExpired ? 'Preview expired' : 'Preview not deployed yet'}</strong><small>{previewExpired ? 'Retry the preview step to create fresh evidence.' : 'Approval stays unavailable until it is healthy.'}</small></button>}
        <label className={`preview-check__attestation${previewTried ? ' is-confirmed' : ''}`}><input type="checkbox" checked={previewTried} disabled={!preview || !previewEvidenceMatchesCheckpoint || previewExpired} onChange={(event) => { setPreviewTried(event.target.checked); setSubmitState('idle'); }} /><span aria-hidden="true">{previewTried ? '✓' : '○'}</span><strong>I opened and tried this deployed revision.</strong><small>{previewExpired ? 'This deployment expired. A fresh preview is required for approval.' : 'This binds an approval to the revision and immutable image shown above.'}</small></label>
        <div className="preview-check__evidence"><span><strong>{artifactCount}</strong> artifacts</span><span><strong>{videoCount}</strong> journey recordings</span><span><strong>{artifactNoteCount}</strong> artifact notes</span></div>
      </section>

      <section className="review-direction" aria-labelledby={`${id}-direction-title`}>
        <div className="review-form-title"><span>02</span><div><h3 id={`${id}-direction-title`}>Overall direction</h3><p>Say what should stay true in the next move. Empty is allowed.</p></div></div>
        <label htmlFor={`${id}-overall-direction`}>Direction for the whole team <span>optional</span></label>
        <textarea id={`${id}-overall-direction`} rows={5} maxLength={3_000} value={overallDirection} onChange={(event) => { setOverallDirection(event.target.value); setSubmitState('idle'); }} placeholder="What worked, what should change, and what matters most next?" />
        <small>{overallDirection.length}/3,000</small>
      </section>

      <section className="review-agent-feedback" aria-labelledby={`${id}-agent-feedback-title`}>
        <div className="review-form-title"><span>03</span><div><h3 id={`${id}-agent-feedback-title`}>Notes by agent</h3><p>Open only the roles you want to guide. Every field may be left empty.</p></div></div>
        <div className="review-agent-feedback__grid">{agentRoleDefinitions.map((definition) => {
          const feedback = agentFeedback[definition.role] ?? '';
          return <details className={`review-agent-note${feedback.trim() ? ' has-feedback' : ''}`} key={definition.role}>
            <summary><span><i aria-hidden="true">{definition.icon}</i><strong>{definition.label}</strong></span><span>{feedback.trim() ? 'Note added ✓' : 'Optional'} <b aria-hidden="true">＋</b></span></summary>
            <label htmlFor={`${id}-feedback-${definition.role}`}>Feedback for {definition.label}</label>
            <textarea id={`${id}-feedback-${definition.role}`} rows={4} maxLength={1_000} value={feedback} onChange={(event) => { setAgentFeedback((current) => ({ ...current, [definition.role]: event.target.value })); setSubmitState('idle'); }} placeholder={`A precise note for ${definition.label}…`} />
          </details>;
        })}</div>
      </section>

      <fieldset className="review-decision-choice">
        <legend><span>04</span><div><strong>Make the iteration decision</strong><small>Approval continues the delivery loop. Changes return your notes to the accountable roles.</small></div></legend>
        <div>
          <label className={`review-choice review-choice--approve${decision === 'approved' ? ' is-selected' : ''}`}>
            <input type="radio" name="review-decision" value="approved" checked={decision === 'approved'} disabled={!approvalReady} onChange={() => { setDecision('approved'); setSubmitState('idle'); }} />
            <span aria-hidden="true">✓</span><strong>Approve iteration</strong><small>Accept this evidence, merge the iteration pull request into main, and continue.</small>
          </label>
          <label className={`review-choice review-choice--changes${decision === 'changes_requested' ? ' is-selected' : ''}`}>
            <input type="radio" name="review-decision" value="changes_requested" checked={decision === 'changes_requested'} onChange={() => { setDecision('changes_requested'); setSubmitState('idle'); }} />
            <span aria-hidden="true">↶</span><strong>Request changes</strong><small>Return the iteration with your overall, agent, and artifact feedback.</small>
          </label>
        </div>
      </fieldset>

      <div className="review-submit">
        <p>{!checkpoint ? 'The exact iteration review checkpoint is still being prepared. Your notes remain editable.' : decision ? (decision === 'approved' ? 'Approval merges the iteration pull request into main, then allows the organism to continue.' : 'This sends every non-empty note back for remediation without merging.') : 'Choose a decision to continue.'}</p>
        <button type="submit" disabled={!decision || !checkpoint || (decision === 'approved' && !approvalReady) || submitState === 'sending' || submitState === 'sent'}>{submitState === 'sending' ? 'Recording decision…' : submitState === 'sent' ? 'Decision recorded ✓' : decision === 'changes_requested' ? 'Send change request →' : 'Approve, merge & continue →'}</button>
      </div>
      {submitState === 'sent' ? <p className="review-submit__notice" role="status">Your decision and feedback were accepted.</p> : null}
      {submitState === 'error' ? <p className="review-submit__notice review-submit__notice--error" role="alert">We could not record the decision. Your notes are still here.</p> : null}
    </form>
  </section>;
}

function ArtifactDialog({ artifact, iterationNumber, feedback, onFeedback, onClose, returnFocus, projectId, submitWithReview, onSaved }: { artifact: ProjectArtifact; iterationNumber?: number; feedback: string; onFeedback: (value: string) => void; onClose: () => void; returnFocus: HTMLElement | null; projectId: string; submitWithReview: boolean; onSaved: () => Promise<void> }) {
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const closeHandler = useRef(onClose);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  closeHandler.current = onClose;
  const tokenCount = artifact.modelInvocations?.reduce((sum, invocation) => sum + (invocation.usage?.totalTokens ?? 0), 0) ?? 0;
  const recordedCost = artifact.modelInvocations?.reduce((sum, invocation) => sum + (invocation.usage?.cost ?? 0), 0) ?? 0;

  async function saveHistoricalFeedback() {
    setSaveState('saving');
    try {
      const response = await fetch(`/api/projects/${projectId}/artifacts/${artifact.id}/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feedback: feedback.trim() }),
      });
      if (!response.ok) throw new Error();
      setSaveState('saved');
      await onSaved();
    } catch {
      setSaveState('error');
    }
  }

  useEffect(() => {
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeHandler.current(); return; }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])');
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = priorOverflow;
      returnFocus?.focus();
    };
  }, [returnFocus]);

  return <div className="artifact-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="artifact-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} ref={dialogRef}>
      <div className="artifact-dialog__heading">
        <div><p className="eyebrow">{iterationNumber ? `Iteration ${iterationNumber}` : 'Iteration artifact'} · {roleLabel(artifact.producedBy)}</p><h2 id={`${id}-title`}>{artifact.name}</h2><p id={`${id}-description`}>Version {artifact.version} · {artifact.status.replaceAll('_', ' ')} · {humanizeMimeType(artifact.mimeType)}</p>{artifact.model ? <p className="agent-model">{artifact.modelProvider ?? 'legacy provider'} · {artifact.model}{tokenCount > 0 ? ` · ${tokenCount.toLocaleString()} tokens` : ''}{recordedCost > 0 ? ` · $${recordedCost.toFixed(4)}` : ''}</p> : null}</div>
        <button type="button" ref={closeRef} onClick={onClose} aria-label={`Close ${artifact.name}`}><span aria-hidden="true">×</span></button>
      </div>
      <div className="artifact-dialog__layout">
        <div className="artifact-dialog__content"><ArtifactContent artifact={artifact} /></div>
        <section className="artifact-dialog__feedback" aria-labelledby={`${id}-feedback-title`}>
          <div><span aria-hidden="true">✎</span><h3 id={`${id}-feedback-title`}>Artifact feedback</h3></div>
          <p>{submitWithReview ? `This note stays attached to version ${artifact.version} and is submitted with your iteration decision.` : `This is evidence from an earlier iteration. Save the note directly to version ${artifact.version} so the agents can consider it without changing the current review.`}</p>
          <label htmlFor={`${id}-artifact-feedback`}>Your note <span>optional</span></label>
          <textarea id={`${id}-artifact-feedback`} rows={9} maxLength={1_000} value={feedback} onChange={(event) => { onFeedback(event.target.value); setSaveState('idle'); }} placeholder="What is correct, unclear, missing, or should change in this artifact?" />
          <small>{feedback.length}/1,000 · {submitWithReview ? 'saved in this review' : saveState === 'saved' ? 'saved to this artifact' : 'not saved yet'}</small>
          {!submitWithReview ? <>
            <button className="artifact-dialog__save" type="button" disabled={saveState === 'saving'} onClick={() => void saveHistoricalFeedback()}>{saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Feedback saved ✓' : 'Save feedback to artifact →'}</button>
            {saveState === 'error' ? <p className="artifact-dialog__save-error" role="alert">We could not save this note. It is still here for you to retry.</p> : null}
          </> : null}
          {artifact.repositoryUrl ? <a href={artifact.repositoryUrl} target="_blank" rel="noreferrer">Open source in repository ↗</a> : null}
        </section>
      </div>
    </div>
  </div>;
}

function ArtifactContent({ artifact }: { artifact: ProjectArtifact }) {
  if (artifact.mimeType === 'text/markdown') return <div className="artifact-viewer markdown-viewer"><ReactMarkdown remarkPlugins={[remarkGfm]}>{artifact.content}</ReactMarkdown></div>;
  if (artifact.mimeType === 'image/svg+xml') return <div className="artifact-viewer image-viewer"><img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(artifact.content)}`} alt={artifact.name} /></div>;
  let code = artifact.content;
  if (artifact.mimeType === 'application/json') { try { code = JSON.stringify(JSON.parse(code), null, 2); } catch { /* preserve malformed source for review */ } }
  return <div className="artifact-viewer code-viewer"><pre><code>{code}</code></pre></div>;
}

function buildEvidenceGroups(detail: ProjectDetail): IterationEvidenceGroup[] {
  return [...detail.iterations]
    .sort((left, right) => right.number - left.number)
    .map((iteration) => {
      const artifacts = detail.artifacts
        .filter((artifact) => artifact.iterationId === iteration.id)
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
      const byProducer = new Map<AgentRole, ProjectArtifact[]>();
      for (const artifact of artifacts) {
        const group = byProducer.get(artifact.producedBy) ?? [];
        group.push(artifact);
        byProducer.set(artifact.producedBy, group);
      }
      return {
        iteration,
        producers: [...byProducer].map(([role, producerArtifacts]) => ({ role, artifacts: producerArtifacts })),
        artifactCount: artifacts.length,
        videos: detail.media.filter((media) => media.kind === 'user_flow_video' && media.iterationId === iteration.id).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)),
      };
    })
    .filter((group) => group.iteration.number === detail.project.currentIteration || group.artifactCount > 0 || group.videos.length > 0);
}

function persistedArtifactFeedback(detail: ProjectDetail): FeedbackMap<string> {
  const latest = new Map<string, { feedback: string; createdAt: string }>();
  for (const entry of detail.artifactFeedback ?? []) {
    const current = latest.get(entry.artifactId);
    if (!current || entry.createdAt >= current.createdAt) latest.set(entry.artifactId, entry);
  }
  return Object.fromEntries([...latest].map(([artifactId, entry]) => [artifactId, entry.feedback]));
}

function buildLegacyFeedback(
  overallDirection: string,
  agentNotes: Array<{ role: string; feedback: string }>,
  artifactNotes: Array<{ artifactId: string; feedback: string }>,
  decision: ReviewDecision,
) {
  const sections = [
    overallDirection.trim() ? `Overall direction:\n${overallDirection.trim()}` : decision === 'approved' ? 'Approved in the project studio.' : 'Changes requested in the project studio.',
    ...agentNotes.filter((note) => note.feedback).map((note) => `${roleLabel(note.role as AgentRole)} feedback:\n${note.feedback}`),
    ...artifactNotes.map((note) => `Artifact ${note.artifactId} feedback:\n${note.feedback}`),
  ];
  return sections.join('\n\n').slice(0, 5_000);
}

function entries<Key extends string>(feedback: FeedbackMap<Key>): Array<[Key, string]> {
  return (Object.entries(feedback) as Array<[Key, string | undefined]>).filter((entry): entry is [Key, string] => Boolean(entry[1]?.trim()));
}

function artifactIcon(artifact: ProjectArtifact) {
  if (artifact.mimeType.startsWith('image/')) return '◇';
  if (artifact.mimeType === 'text/markdown') return '¶';
  if (artifact.mimeType.includes('json') || artifact.mimeType.includes('yaml')) return '{ }';
  return '≡';
}

function humanizeMimeType(mimeType: string) {
  if (mimeType === 'text/markdown') return 'Document';
  if (mimeType === 'image/svg+xml') return 'Diagram';
  if (mimeType === 'application/json') return 'JSON';
  if (mimeType.includes('yaml')) return 'YAML';
  if (mimeType.startsWith('text/')) return 'Text';
  return 'Artifact';
}
