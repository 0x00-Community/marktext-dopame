import type { Database, SQLValue } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { applyOperations, applyTextChanges, assertRange, assertText, createSnapshot,
  limits, nextRevision, ProtocolError, serializeMarkdown,
  type BlockOperation, type DocumentRef, type DocumentSnapshot, type EditQuota, type TextChange } from '../../dopame/src/domain/collaboration'
import { suggestReverseOperations } from '../../dopame/src/domain/reverseProposal'
import { canonical, digest, hostApprovalBinding, opaqueSecret, type ApprovalBinding, type ApprovalPort, type GrantInput, type ResourceScope } from './auth'
import { openStore } from './store'
import type { ApprovedGenerationInput, SystemModelPort, WritingPurpose } from './modelPort'
import { validateRequest, protocolSchema, capabilitySchemas, capabilityResultSchemas, taskReceiptSchema,
  sanitizeContent, type AuditMetadata, type InquiryResolution, type TaskInquiry, type TaskProgress, type RequestEnvelope } from './protocol'

interface Principal { id: string; name: string; kind: string; active: number; generation: number }
interface Credential { hash: string; principal_id: string; expires_at: string; generation: number }
interface GrantRow { id: string; principal_id: string; scope: string; actions: string; expires_at: string; revoked: number; delegation_depth: number; parent_id: string | null }
interface DocumentRow { id: string; workspace_id: string; epoch: string; revision: string; title: string; creator_id: string; workflow_id: string | null; saved_revision: string | null; binding_id: string | null; fence: string; sources: string; updated_at: string; created_at: string; inbox: number; audit: string | null }
interface ProposalRow { id: string; doc_id: string; epoch: string; base_revision: string; author_id: string; workflow_id: string | null; operations: string; reason: string; sources: string; digest: string; state: string; applied_revision: string | null; diff: string; created_at: string; audit: string | null }
interface TaskRow { id: string; principal_id: string; credential_hash: string; request_id: string; request: string; scope: string; action: string; state: string; cancel_requested: number; result: string | null; error: string | null; created_at: string; updated_at: string; progress: string | null }
interface ArtifactRow { id: string; doc_id: string; epoch: string; revision: string; data: Uint8Array; digest: string; filename: string; creator_id: string; created_at: string }
interface HandoffRow { id: string; artifact_id: string; sender_id: string; recipient_id: string; purpose: string; expires_at: string; grant_id: string; state: string; receipt: string | null; created_at: string }
interface LeaseRow { doc_id: string; owner_session: string; fence: string; service_epoch: string; expires_at: string }
interface IdempotencyRow { digest: string; task_id: string | null; result: string | null }
interface SaveRow { id: string; task_id: string; doc_id: string; epoch: string; revision: string; binding_id: string; state: string; before_digest: string | null; after_digest: string; result: string | null }

export interface WriterToken { windowSessionId: string; writerFence: string; serviceEpoch: string }
export interface AuthorInput { requestId: string; ticket: string }
export interface ResourceBindingInput {
  bindingId?: string
  kind: 'root' | 'handle'
  alias?: string
  resourceVersion?: string
  consistency: 'conditional-write' | 'best-effort'
  needsReauthorization: boolean
}
export interface CoordinatorOptions { approvalPort?: ApprovalPort; modelPort?: SystemModelPort; now?: () => number }

const actions: Record<string, string> = {
  'documents.list': 'document:read', 'documents.read': 'document:read',
  'documents.outline': 'document:read', 'documents.blocks': 'document:read',
  'documents.createDraft': 'document:create', 'proposals.create': 'proposal:create',
  'proposals.get': 'proposal:read', 'proposals.list': 'proposal:read',
  'proposals.verify': 'audit:review',
  'tasks.updateProgress': 'task:report_progress',
  'artifacts.export': 'artifact:export', 'artifacts.read': 'artifact:read',
  'artifacts.materializeToManagedDir': 'artifact:materialize',
  'handoffs.create': 'artifact:share', 'handoffs.get': 'artifact:read',
  'handoffs.acknowledge': 'artifact:read',
  'writing.generate': 'writing:generate',
}
const mutations = new Set([
  'documents.createDraft',
  'proposals.create',
  'proposals.verify',
  'artifacts.export',
  'artifacts.materializeToManagedDir',
  'handoffs.create',
  'handoffs.acknowledge',
  'writing.generate',
])
const AUDITOR_ALLOWED_ACTIONS = new Set(['audit:review', 'document:read', 'proposal:read', 'task:read', 'task:report_progress'])
const authorActions = [...new Set([...Object.values(actions), 'task:read', 'grant:manage',
  'document:commit', 'proposal:approve', 'document:save', 'writer:manage'])]
const finalStates = new Set(['succeeded', 'failed', 'cancelled'])
const INQUIRY_COOLDOWN_MS = 180_000

function parse<T>(text: string): T { return JSON.parse(text) as T }
function object(value: unknown) { return value as Record<string, unknown> }
function invalid(message = 'Invalid arguments.'): never { throw new ProtocolError('INVALID_ARGUMENT', message) }
function denied(): never { throw new ProtocolError('PERMISSION_DENIED', 'This resource is not authorized.') }
function sourceStrings(sources: unknown): string[] {
  if (!Array.isArray(sources)) return []
  return sources.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const entry = item as { uri?: unknown; label?: unknown }
    return [
      ...(typeof entry.uri === 'string' ? [entry.uri] : []),
      ...(typeof entry.label === 'string' ? [entry.label] : []),
    ]
  })
}

/** The only owner of canonical drafts, credentials, proposals, durable tasks and commit decisions. */
export class Coordinator {
  private readonly stateDir: string
  private readonly db: Database
  private readonly clock: () => number
  private readonly approvalPort?: ApprovalPort
  private readonly modelPort?: SystemModelPort
  private readonly serviceEpoch = randomUUID()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly abortControllers = new Map<string, AbortController>()
  private closed = false

  constructor(stateDir: string, options: CoordinatorOptions = {}) {
    this.stateDir = resolve(stateDir)
    this.clock = options.now ?? Date.now
    this.approvalPort = options.approvalPort
    this.modelPort = options.modelPort
    this.db = openStore(this.stateDir)
    this.atomic(() => {
      this.run('DELETE FROM writer_leases')
      for (const binding of this.rows<{ id: string; data: string }>('SELECT id,data FROM resource_bindings')) {
        const metadata = parse<ResourceBindingInput>(binding.data)
        if (metadata.kind === 'handle') this.run('UPDATE resource_bindings SET data=? WHERE id=?',
          canonical({ ...metadata, needsReauthorization: true }), binding.id)
      }
      this.run("UPDATE save_outbox SET state='recovering' WHERE state NOT IN ('succeeded','failed')")
      this.run("UPDATE tasks SET state='recovering',updated_at=? WHERE state NOT IN ('succeeded','failed','cancelled')", this.now())
    })
    for (const task of this.rows<TaskRow>('SELECT * FROM tasks WHERE state=?', 'recovering')) {
      const request = parse<{ capability: string }>(task.request)
      if (request.capability.startsWith('author.')) continue
      this.run("UPDATE tasks SET state='queued' WHERE id=?", task.id)
      this.defer(() => this.startTask(task.id))
    }
  }

  private now() { return new Date(this.clock()).toISOString() }
  private expiry(milliseconds: number) { return new Date(this.clock() + milliseconds).toISOString() }
  private row<T>(sql: string, ...bindings: SQLValue[]) { return this.db.query<T>(sql).get(...bindings) ?? undefined }
  private rows<T>(sql: string, ...bindings: SQLValue[]) { return this.db.query<T>(sql).all(...bindings) }
  private run(sql: string, ...bindings: SQLValue[]) { this.db.query(sql).run(...bindings) }
  private atomic<T>(operation: () => T): T {
    if (this.closed) throw new ProtocolError('RESOURCE_UNAVAILABLE', 'The collaboration service is closed.', true)
    return this.db.transaction(operation)()
  }
  private defer(operation: () => void) {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (!this.closed) operation()
    }, 0)
    this.timers.add(timer)
  }

  private authenticateHash(hash: string) {
    const credential = this.row<Credential>('SELECT * FROM credential_records WHERE hash=?', hash)
    const principal = credential && this.row<Principal>('SELECT * FROM principals WHERE id=?', credential.principal_id)
    if (!principal || !credential || !principal.active || credential.expires_at <= this.now()
      || credential.generation !== principal.generation) {
      throw new ProtocolError('UNAUTHENTICATED', 'Pairing or renewed authentication is required.')
    }
    return principal
  }
  private authenticate(auth: string) {
    if (typeof auth !== 'string' || auth.length < 16 || auth.length > 256) {
      throw new ProtocolError('UNAUTHENTICATED', 'Pairing or renewed authentication is required.')
    }
    return this.authenticateHash(digest(auth))
  }
  private grantActive(grant: GrantRow, seen = new Set<string>()): boolean {
    if (grant.revoked || grant.expires_at <= this.now() || seen.has(grant.id)) return false
    if (!grant.parent_id) return true
    seen.add(grant.id)
    const parent = this.row<GrantRow>('SELECT * FROM grants WHERE id=?', grant.parent_id)
    return !!parent && this.grantActive(parent, seen)
  }
  private matchingGrant(principal: Principal, action: string, scope: ResourceScope): GrantRow | undefined {
    return this.matchingGrants(principal, action, scope)[0]
  }
  private matchingGrants(principal: Principal, action: string, scope: ResourceScope): GrantRow[] {
    return this.rows<GrantRow>('SELECT * FROM grants WHERE principal_id=?', principal.id).filter(grant => {
      if (!this.grantActive(grant) || !parse<string[]>(grant.actions).includes(action)) return false
      const allowed = parse<ResourceScope>(grant.scope)
      return allowed.workspaceId === scope.workspaceId && ['docId', 'artifactId', 'workflowId', 'purpose']
        .every(key => allowed[key as keyof ResourceScope] === undefined
          || allowed[key as keyof ResourceScope] === scope[key as keyof ResourceScope])
    })
  }
  private authorize(principal: Principal, action: string, scope: ResourceScope) {
    const grant = this.matchingGrant(principal, action, scope)
    if (!grant) denied()
    return grant
  }
  private author(auth: string, action: string, scope: ResourceScope) {
    const principal = this.authenticate(auth)
    if (principal.kind !== 'author') denied()
    this.authorize(principal, action, scope)
    return principal
  }
  private credential(principal: Principal, expiresAt: string) {
    const credential = opaqueSecret()
    this.run('INSERT INTO credential_records VALUES(?,?,?,?)', digest(credential), principal.id, expiresAt, principal.generation)
    return { credential, principalId: principal.id, expiresAt }
  }
  private approval(ticket: string, binding: ApprovalBinding, principalId?: string) {
    const evidence = typeof ticket === 'string' && this.approvalPort?.verify(ticket, binding)
    if (!evidence || typeof evidence.expiresAt !== 'string' || !Number.isFinite(Date.parse(evidence.expiresAt))
      || Date.parse(evidence.expiresAt) <= this.clock() || typeof evidence.policyVersion !== 'string' || !evidence.policyVersion
      || typeof evidence.ticketId !== 'string' || !evidence.ticketId || typeof evidence.principalId !== 'string'
      || !evidence.principalId || canonical(evidence.binding) !== canonical(binding)
      || (principalId !== undefined && evidence.principalId !== principalId)) {
      throw new ProtocolError('APPROVAL_INVALID', 'A valid protected host approval is required.')
    }
    const consumed = this.row('SELECT id FROM approval_tickets WHERE id=?', evidence.ticketId)
    if (consumed) throw new ProtocolError('APPROVAL_INVALID', 'This approval has already been consumed.')
    return { ...evidence, expiresAt: new Date(evidence.expiresAt).toISOString() }
  }
  private consumeApproval(ticket: string, binding: ApprovalBinding, principalId: string) {
    const evidence = this.approval(ticket, binding, principalId)
    this.run('INSERT INTO approval_tickets VALUES(?,?,?,?,?)', evidence.ticketId, evidence.principalId,
      canonical(binding), evidence.policyVersion, this.now())
    return evidence
  }

  requestPairing(input: { name: string }) {
    if (!input || Object.keys(input).some(key => key !== 'name') || typeof input.name !== 'string'
      || !input.name.trim() || input.name.length > 120) invalid('A caller name is required.')
    return this.atomic(() => {
      const pending = this.row<{ count: number }>("SELECT COUNT(*) AS count FROM pairings WHERE state='pending' AND expires_at>?", this.now())!
      if (pending.count >= 200) throw new ProtocolError('RATE_LIMITED', 'Too many pending pairings.', true)
      const pairingId = randomUUID()
      const claimSecret = opaqueSecret()
      const expiresAt = this.expiry(10 * 60_000)
      this.run('INSERT INTO pairings VALUES(?,?,?,?,?,NULL)', pairingId, input.name.trim(), digest(claimSecret), expiresAt, 'pending')
      return { pairingId, claimSecret, expiresAt, state: 'pending' as const }
    })
  }

  claimPairing(pairingId: string, claimSecret: string) {
    if (typeof pairingId !== 'string' || pairingId.length > 128 || typeof claimSecret !== 'string'
      || claimSecret.length > 256) throw new ProtocolError('UNAUTHENTICATED', 'The pairing claim is invalid or expired.')
    return this.atomic(() => {
      const pairing = this.row<{ claim_hash: string; expires_at: string; state: string; principal_id: string | null }>('SELECT * FROM pairings WHERE id=?', pairingId)
      if (!pairing || typeof claimSecret !== 'string' || pairing.claim_hash !== digest(claimSecret)
        || pairing.expires_at <= this.now() || pairing.state === 'claimed') {
        throw new ProtocolError('UNAUTHENTICATED', 'The pairing claim is invalid or expired.')
      }
      if (pairing.state !== 'approved' || !pairing.principal_id) return { state: 'pending' as const }
      const principal = this.row<Principal>('SELECT * FROM principals WHERE id=?', pairing.principal_id)!
      if (!principal.active) throw new ProtocolError('UNAUTHENTICATED', 'The pairing has been revoked.')
      const grantExpiry = this.rows<GrantRow>('SELECT * FROM grants WHERE principal_id=?', principal.id)
        .filter(grant => this.grantActive(grant)).map(grant => grant.expires_at).sort().at(-1)
      if (!grantExpiry) denied()
      const expiresAt = [this.expiry(60 * 60_000), grantExpiry].sort()[0]
      const result = this.credential(principal, expiresAt)
      this.run("UPDATE pairings SET state='claimed',claim_hash='' WHERE id=?", pairingId)
      const grants = this.visibleGrants(principal)
      return { state: 'paired' as const, ...result, grants, workspaceIds: [...new Set(grants.map(grant => grant.scope.workspaceId))] }
    })
  }

  describe(auth: string) {
    const principal = this.authenticate(auth)
    const availableActions = new Set(this.rows<GrantRow>('SELECT * FROM grants WHERE principal_id=?', principal.id)
      .filter(grant => this.grantActive(grant)).flatMap(grant => parse<string[]>(grant.actions)))
    const modelStatus = this.modelPort?.availabilitySync?.() ?? (this.modelPort
      ? { available: true }
      : { available: false, reason: 'The system model contract has not been verified.' })
    return { protocol: 'marktext-documents/1', schemaVersion: 1, principalId: principal.id, protocolSchema,
      grants: this.visibleGrants(principal),
      limits, approval: { available: !!this.approvalPort, mode: this.approvalPort ? this.approvalPort.mode ?? 'protected-host' : 'manual-preview' },
      capabilities: Object.entries(actions).filter(([id, action]) => availableActions.has(action)
        || (id === 'handoffs.get' && availableActions.has('artifact:share')))
        .map(([id, action]) => ({ id, version: 1,
          available: id === 'writing.generate' ? modelStatus.available : true,
          ...(id === 'writing.generate' && !modelStatus.available && modelStatus.reason ? { reason: modelStatus.reason } : {}),
          requiredAction: id === 'handoffs.get' ? 'artifact:read (recipient) / artifact:share (sender)' : action,
          inputSchema: capabilitySchemas[id],
          // A mutation's invoke returns only the receipt; its result is read from the durable task.
          ...(mutations.has(id) ? { mode: 'task', outputSchema: taskReceiptSchema, resultSchema: capabilityResultSchemas[id] }
            : { mode: 'read', outputSchema: capabilityResultSchemas[id] }) })),
      integrations: {
        notifications: { available: false, reason: 'Target notification delivery and click routing are not verified.' },
        systemFileHandoff: { available: false, reason: 'Target file-handle delivery is not verified.' },
        multipleWindows: { available: false, reason: 'SP-05 is not verified; one writer window is retained.' },
        writingGenerate: {
          available: modelStatus.available,
          ...(modelStatus.reason ? { reason: modelStatus.reason } : {}),
          ...(modelStatus.models ? { models: modelStatus.models } : {}),
        },
      } }
  }
  private visibleGrants(principal: Principal) {
    return this.rows<GrantRow>('SELECT * FROM grants WHERE principal_id=?', principal.id)
      .filter(grant => this.grantActive(grant)).map(grant => ({ grantId: grant.id, scope: parse<ResourceScope>(grant.scope),
        actions: parse<string[]>(grant.actions), expiresAt: grant.expires_at, delegationDepth: grant.delegation_depth }))
  }

  private documentScope(document: DocumentRow): ResourceScope {
    return { workspaceId: document.workspace_id, docId: document.id,
      ...(document.workflow_id ? { workflowId: document.workflow_id } : {}) }
  }
  private documentRef(document: DocumentRow): DocumentRef {
    return { workspaceId: document.workspace_id, docId: document.id, documentEpoch: document.epoch, revision: document.revision }
  }
  private requireDocument(principal: Principal, ref: DocumentRef, action: string) {
    const requestedScope = { workspaceId: ref.workspaceId, docId: ref.docId }
    const document = this.row<DocumentRow>('SELECT * FROM documents WHERE id=?', ref.docId)
    if (!document || document.workspace_id !== ref.workspaceId) {
      this.authorize(principal, action, requestedScope)
      denied()
    }
    this.authorize(principal, action, this.documentScope(document))
    if (document.epoch !== ref.documentEpoch) throw new ProtocolError('STALE_BLOCK_REF', 'The document identity has been rebuilt.')
    return document
  }
  private snapshot(document: DocumentRow, revision = document.revision) {
    const stored = this.row<{ data: string }>('SELECT data FROM snapshots WHERE doc_id=? AND epoch=? AND revision=?', document.id, document.epoch, revision)
    if (!stored) throw new ProtocolError('REVISION_CONFLICT', 'This authorized snapshot is unavailable.')
    return parse<DocumentSnapshot>(stored.data)
  }
  private current(principal: Principal, document: DocumentRow, expected: string) {
    if (document.revision !== expected) {
      const details = this.matchingGrant(principal, 'document:read', this.documentScope(document))
        ? { current: this.documentRef(document) } : undefined
      throw new ProtocolError('REVISION_CONFLICT', 'The document has changed; review a new proposal.', false, details)
    }
  }
  private artifact(principal: Principal, artifactId: string, action: string, purpose?: string) {
    const artifact = this.row<ArtifactRow>('SELECT * FROM artifacts WHERE id=?', artifactId)
    if (!artifact) denied()
    const document = this.row<DocumentRow>('SELECT * FROM documents WHERE id=?', artifact.doc_id)!
    const scope = { ...this.documentScope(document), artifactId, ...(purpose ? { purpose } : {}) }
    this.authorize(principal, action, scope)
    return { artifact, document, scope }
  }
  private hasActiveAuditorForScope(scope: ResourceScope): boolean {
    return this.rows<GrantRow>('SELECT * FROM grants WHERE revoked=0').some(grant => {
      if (!this.grantActive(grant)) return false
      const owner = this.row<Principal>('SELECT * FROM principals WHERE id=?', grant.principal_id)
      if (!owner || !owner.active || owner.kind !== 'agent') return false
      if (!parse<string[]>(grant.actions).includes('audit:review')) return false
      const auditorScope = parse<ResourceScope>(grant.scope)
      return auditorScope.workspaceId === scope.workspaceId
        && (!auditorScope.docId || auditorScope.docId === scope.docId)
        && (!auditorScope.workflowId || auditorScope.workflowId === scope.workflowId)
    })
  }
  private assertVerifiedAudit(rawAudit: string | null, label: string, scope?: ResourceScope, authorId?: string) {
    if (!rawAudit) {
      if (scope && authorId) {
        const author = this.row<Principal>('SELECT * FROM principals WHERE id=?', authorId)
        if (author?.kind === 'agent' && this.hasActiveAuditorForScope(scope)) {
          throw new ProtocolError('AUDIT_NOT_PASSED', `This ${label} has not passed audit verification.`, false, { audit: { status: 'pending_audit' } })
        }
      }
      return
    }
    const audit = parse<AuditMetadata>(rawAudit)
    if (audit.status !== 'verified') {
      throw new ProtocolError('AUDIT_NOT_PASSED', `This ${label} has not passed audit verification or is quarantined.`, false, { audit })
    }
  }
  private assertQuarantineReadable(principal: Principal, rawAudit: string | null, scope: ResourceScope, label: string) {
    if (!rawAudit || principal.kind === 'author') return
    const audit = parse<AuditMetadata>(rawAudit)
    if (audit.status === 'quarantined_injection' && !this.matchingGrant(principal, 'audit:review', scope)) {
      throw new ProtocolError('AUDIT_NOT_PASSED', `This ${label} is quarantined due to prompt injection markers and cannot be read by non-auditor agents.`, false, { audit })
    }
  }
  private requiresAuditForScope(principal: Principal, action: string, scope: ResourceScope): boolean {
    const grants = this.matchingGrants(principal, action, scope)
    if (grants.some(grant => parse<ResourceScope>(grant.scope).requireAudit === true)) return true
    return this.hasActiveAuditorForScope(scope)
  }
  private effectiveMaxRetries(grants: GrantRow[]): number {
    const limits = grants
      .map(grant => parse<ResourceScope>(grant.scope).maxAuditRetries)
      .filter((value): value is number => typeof value === 'number')
    return limits.length ? Math.min(...limits) : 2
  }
  private countFlaggedAttempts(authorId: string, workspaceId: string, docId?: string, workflowId?: string | null): number {
    const proposals = docId
      ? this.rows<{ audit: string | null }>('SELECT audit FROM proposals WHERE author_id=? AND doc_id=?', authorId, docId)
      : this.rows<{ audit: string | null }>(
        'SELECT p.audit FROM proposals p JOIN documents d ON d.id=p.doc_id WHERE p.author_id=? AND d.workspace_id=?',
        authorId,
        workspaceId,
      )
    const drafts = workflowId
      ? this.rows<{ audit: string | null }>('SELECT audit FROM documents WHERE creator_id=? AND workspace_id=? AND workflow_id=?', authorId, workspaceId, workflowId)
      : this.rows<{ audit: string | null }>('SELECT audit FROM documents WHERE creator_id=? AND workspace_id=? AND inbox=1', authorId, workspaceId)
    let count = 0
    for (const row of [...proposals, ...drafts]) {
      if (!row.audit) continue
      const status = parse<AuditMetadata>(row.audit).status
      if (status === 'flagged_drift' || status === 'quarantined_injection') count++
    }
    return count
  }
  private checkDraftGrantConstraints(principal: Principal, workspaceId: string, workflowId?: string) {
    if (principal.kind !== 'agent') return
    const scope: ResourceScope = { workspaceId, ...(workflowId ? { workflowId } : {}) }
    const grants = this.matchingGrants(principal, 'document:create', scope)
    if (!grants.length) denied()
    const maxRetries = this.effectiveMaxRetries(grants)
    const flagged = this.countFlaggedAttempts(principal.id, workspaceId, undefined, workflowId)
    if (flagged >= maxRetries) {
      throw new ProtocolError('GRANT_SCOPE_EXCEEDED', 'Maximum audit retry count exceeded; awaiting user intervention.')
    }
  }
  private checkProposalGrantConstraints(principal: Principal, document: DocumentRow, operations: BlockOperation[], workflowId?: string) {
    const scope = { ...this.documentScope(document), ...(workflowId ? { workflowId } : {}) }
    const grants = this.matchingGrants(principal, 'proposal:create', scope)
    if (!grants.length) denied()
    const parsedScopes = grants.map(grant => parse<ResourceScope>(grant.scope))
    const hasUnrestrictedBlockGrant = parsedScopes.some(s => !s.allowedBlockIds || s.allowedBlockIds.length === 0)
    if (!hasUnrestrictedBlockGrant) {
      const allowed = new Set(parsedScopes.flatMap(s => s.allowedBlockIds ?? []))
      for (const op of operations) {
        if (op.kind === 'insertAtStart' || !allowed.has(op.blockId)) {
          throw new ProtocolError('GRANT_SCOPE_EXCEEDED', 'Operation targets a block outside the authorized allowedBlockIds.')
        }
      }
    }
    if (principal.kind === 'agent') {
      const maxRetries = this.effectiveMaxRetries(grants)
      const flagged = this.countFlaggedAttempts(principal.id, document.workspace_id, document.id, workflowId ?? document.workflow_id)
      if (flagged >= maxRetries) {
        throw new ProtocolError('GRANT_SCOPE_EXCEEDED', 'Maximum audit retry count exceeded; awaiting user intervention.')
      }
    }
  }

  private requestAuthorization(principal: Principal, request: RequestEnvelope): { scope: ResourceScope; action: string } {
    const input = object(request.input)
    const action = actions[request.capability]
    if (!action) throw new ProtocolError('UNSUPPORTED_VERSION', 'This capability is not supported.')
    let scope: ResourceScope
    if (request.capability === 'documents.createDraft' || request.capability === 'documents.list') {
      scope = { workspaceId: input.workspaceId as string, ...(request.workflowId ? { workflowId: request.workflowId } : {}) }
      if (request.capability === 'documents.list') {
        const visibleScope = this.rows<GrantRow>('SELECT * FROM grants WHERE principal_id=?', principal.id).some(grant => {
          const allowed = parse<ResourceScope>(grant.scope)
          return this.grantActive(grant) && parse<string[]>(grant.actions).includes(action)
            && allowed.workspaceId === scope.workspaceId
            && (!scope.workflowId || !allowed.workflowId || allowed.workflowId === scope.workflowId)
        })
        if (!visibleScope) denied()
        return { scope, action }
      }
      this.authorize(principal, action, scope)
    } else if (request.capability === 'proposals.verify') {
      const targetKind = input.targetKind as 'draft' | 'proposal'
      const targetId = input.targetId as string
      if (targetKind === 'draft') {
        const document = this.row<DocumentRow>('SELECT * FROM documents WHERE id=?', targetId)
        if (!document) denied()
        scope = this.documentScope(document)
      } else {
        const proposal = this.row<ProposalRow>('SELECT * FROM proposals WHERE id=?', targetId)
        if (!proposal) denied()
        const document = this.row<DocumentRow>('SELECT * FROM documents WHERE id=?', proposal.doc_id)!
        scope = this.documentScope(document)
      }
      this.authorize(principal, action, scope)
    } else if (request.capability === 'tasks.updateProgress') {
      const task = this.row<TaskRow>('SELECT * FROM tasks WHERE id=?', input.taskId as string)
      if (!task || task.principal_id !== principal.id) denied()
      scope = parse<ResourceScope>(task.scope)
      this.authorize(principal, action, scope)
    } else if (input.document || input.base) {
      const ref = (input.document ?? input.base) as DocumentRef
      const document = this.requireDocument(principal, ref, action)
      scope = this.documentScope(document)
    } else if (request.capability === 'proposals.get') {
      const proposal = this.row<ProposalRow>('SELECT * FROM proposals WHERE id=?', input.proposalId as string)
      if (!proposal) denied()
      const document = this.row<DocumentRow>('SELECT * FROM documents WHERE id=?', proposal.doc_id)!
      scope = this.documentScope(document)
      this.authorize(principal, action, scope)
    } else if (request.capability.startsWith('handoffs.') && input.handoffId) {
      const handoff = this.requireHandoff(principal, input.handoffId as string)
      const document = this.row<DocumentRow>('SELECT * FROM documents WHERE id=(SELECT doc_id FROM artifacts WHERE id=?)', handoff.artifact_id)!
      scope = { ...this.documentScope(document), artifactId: handoff.artifact_id, purpose: handoff.purpose }
      if (request.capability === 'handoffs.acknowledge' && handoff.recipient_id !== principal.id) denied()
    } else {
      const handoffId = input.handoffId as string | undefined
      const handoff = handoffId ? this.requireHandoff(principal, handoffId) : undefined
      if (handoff && (handoff.recipient_id !== principal.id || handoff.artifact_id !== input.artifactId)) denied()
      const purpose = handoff?.purpose ?? (request.capability === 'handoffs.create' ? input.purpose as string : undefined)
      const artifact = this.artifact(principal, input.artifactId as string, action, purpose)
      scope = artifact.scope
    }
    return { scope, action }
  }

  /** `ephemeral` reads are for a trusted host that polls: they are authorized as usual but leave no record. */
  invoke(auth: string, value: unknown, options: { ephemeral?: boolean } = {}) {
    const principal = this.authenticate(auth)
    const request = validateRequest(value)
    if (request.parentTaskId) this.requireTask(principal, request.parentTaskId)
    const authorization = this.requestAuthorization(principal, request)
    const requestDigest = digest(request)
    if (!mutations.has(request.capability)) {
      return this.atomic(() => {
        this.authenticate(auth)
        this.requestAuthorization(principal, request)
        if (options.ephemeral) return this.readRequest(principal, request)
        const old = this.row<IdempotencyRow>('SELECT * FROM idempotency_records WHERE principal_id=? AND request_id=?', principal.id, request.requestId)
        if (old) {
          if (old.digest !== requestDigest || !old.result) throw new ProtocolError('IDEMPOTENCY_MISMATCH', 'This requestId belongs to different arguments.')
          return this.replayRead(principal, request, parse<unknown>(old.result))
        }
        const result = this.readRequest(principal, request)
        this.run('INSERT INTO idempotency_records VALUES(?,?,?,NULL,?)', principal.id, request.requestId, requestDigest, canonical(result))
        return result
      })
    }
    const receipt = this.atomic(() => {
      this.authenticate(auth)
      this.requestAuthorization(principal, request)
      const old = this.row<IdempotencyRow>('SELECT * FROM idempotency_records WHERE principal_id=? AND request_id=?', principal.id, request.requestId)
      if (old) {
        if (old.digest !== requestDigest) throw new ProtocolError('IDEMPOTENCY_MISMATCH', 'This requestId belongs to different arguments.')
        const task = this.requireTask(principal, old.task_id!)
        return this.receipt(task)
      }
      const queued = this.row<{ count: number }>("SELECT COUNT(*) AS count FROM tasks WHERE principal_id=? AND state NOT IN ('succeeded','failed','cancelled')", principal.id)!
      if (queued.count >= 128) throw new ProtocolError('RATE_LIMITED', 'Too many pending tasks.', true)
      const taskId = randomUUID()
      const now = this.now()
      this.run('INSERT INTO tasks(id,principal_id,credential_hash,request_id,request,scope,action,state,cancel_requested,result,error,created_at,updated_at,progress) VALUES(?,?,?,?,?,?,?,?,0,NULL,NULL,?,?,NULL)', taskId, principal.id, digest(auth), request.requestId,
        canonical(request), canonical(authorization.scope), authorization.action, 'queued', now, now)
      this.run('INSERT INTO idempotency_records VALUES(?,?,?,?,NULL)', principal.id, request.requestId, requestDigest, taskId)
      this.event(principal.id, authorization.scope, 'task:read', 'task.queued', { taskId })
      return { taskId, requestId: request.requestId, state: 'queued', acceptedAt: now }
    })
    this.defer(() => this.startTask(receipt.taskId))
    return receipt
  }

  private replayRead(principal: Principal, request: RequestEnvelope, value: unknown) {
    if (request.capability !== 'documents.list') return value
    const prior = value as { documents: Array<{ document: DocumentRef }>; cursor?: string }
    const documents = prior.documents.filter(item => {
      const document = this.row<DocumentRow>('SELECT * FROM documents WHERE id=?', item.document.docId)
      return !!document && document.workspace_id === item.document.workspaceId && document.epoch === item.document.documentEpoch
        && !!this.matchingGrant(principal, 'document:read', this.documentScope(document))
    })
    // List pagination is renewed with a new request, because its authorization set may have changed.
    return { documents }
  }

  private receipt(task: TaskRow) {
    return { taskId: task.id, requestId: task.request_id, state: task.state, acceptedAt: task.created_at }
  }
  private requireTask(principal: Principal, taskId: string) {
    const task = this.row<TaskRow>('SELECT * FROM tasks WHERE id=?', taskId)
    if (!task || task.principal_id !== principal.id) denied()
    const scope = parse<ResourceScope>(task.scope)
    this.authorize(principal, 'task:read', scope)
    this.authorize(principal, task.action, scope)
    return task
  }
  getTask(auth: string, taskId: string) {
    const principal = this.authenticate(auth)
    const task = this.requireTask(principal, taskId)
    const error = task.error ? parse<{ code: string; message: string; retryable: boolean; details?: unknown }>(task.error) : undefined
    if (error?.details && !this.matchingGrant(principal, 'document:read', parse<ResourceScope>(task.scope))) delete error.details
    const capability = parse<{ capability: string }>(task.request).capability
    const progress = task.progress ? parse<TaskProgress>(task.progress) : undefined
    return { ...this.receipt(task), capability, cancelRequested: !!task.cancel_requested,
      cancellable: capability !== 'author.save' && ['queued', 'running', 'awaiting_user'].includes(task.state), updatedAt: task.updated_at,
      ...(progress ? { progress } : {}),
      ...(task.result ? { result: parse<unknown>(task.result) } : {}),
      ...(error ? { error } : {}) }
  }
  cancelTask(auth: string, taskId: string) {
    return this.atomic(() => {
      const principal = this.authenticate(auth)
      const task = this.requireTask(principal, taskId)
      const capability = parse<{ capability: string }>(task.request).capability
      if (task.state === 'succeeded' || task.state === 'committing' || capability === 'author.save') {
        throw new ProtocolError('TOO_LATE', 'The task has passed its cancellation point.')
      }
      if (task.state === 'failed' || task.state === 'cancelled') return this.getTask(auth, taskId)
      this.abortControllers.get(taskId)?.abort()
      this.abortControllers.delete(taskId)
      this.run("UPDATE tasks SET cancel_requested=1,state='cancelled',updated_at=? WHERE id=?", this.now(), taskId)
      this.event(principal.id, parse<ResourceScope>(task.scope), 'task:read', 'task.cancelled', { taskId })
      return this.getTask(auth, taskId)
    })
  }
  private startTask(taskId: string) {
    const started = this.atomic(() => {
      const task = this.row<TaskRow>('SELECT * FROM tasks WHERE id=?', taskId)
      if (!task || task.state !== 'queued') return undefined
      const capability = parse<{ capability: string }>(task.request).capability
      this.run("UPDATE tasks SET state='running',updated_at=? WHERE id=?", this.now(), taskId)
      return capability
    })
    if (!started) return
    if (started === 'writing.generate') void this.executeWritingTask(taskId)
    else this.defer(() => this.commitTask(taskId))
  }
  private async executeWritingTask(taskId: string) {
    this.abortControllers.get(taskId)?.abort()
    const controller = new AbortController()
    this.abortControllers.set(taskId, controller)
    try {
      const prepared = this.atomic(() => {
        const task = this.row<TaskRow>('SELECT * FROM tasks WHERE id=?', taskId)
        if (!task || task.state !== 'running' || task.cancel_requested) return undefined
        const principal = this.authenticateHash(task.credential_hash)
        const request = validateRequest(parse<unknown>(task.request))
        if (request.deadlineAt && Date.parse(request.deadlineAt) <= this.clock()) {
          throw new ProtocolError('DEADLINE_EXCEEDED', 'The task deadline elapsed before generation started.')
        }
        this.requestAuthorization(principal, request)
        const input = object(request.input)
        const ref = input.document as DocumentRef
        const document = this.requireDocument(principal, ref, 'writing:generate')
        const snapshot = this.snapshot(document, ref.revision)
        const range = input.range as { start: number; end: number }
        assertRange(snapshot.markdown, range.start, range.end)
        const generationInput: ApprovedGenerationInput = {
          generationId: randomUUID(),
          purpose: input.purpose as WritingPurpose,
          document: snapshot.document,
          range: { start: range.start, end: range.end },
          excerpt: snapshot.markdown.slice(range.start, range.end),
          modelId: input.modelId as string,
          ...(typeof input.instruction === 'string' ? { instruction: input.instruction } : {}),
        }
        return { principalId: principal.id, request, generationInput }
      })
      if (!prepared) return
      if (!this.modelPort) {
        throw new ProtocolError('MODEL_UNAVAILABLE', 'The system model contract (SP-04) has not been verified.')
      }
      const status = await this.modelPort.availability()
      if (!status.available) {
        throw new ProtocolError('MODEL_UNAVAILABLE', status.reason ?? 'The configured system model gateway is unavailable.')
      }
      if (status.models && status.models.length > 0 && !status.models.includes(prepared.generationInput.modelId)) {
        throw new ProtocolError('INVALID_ARGUMENT', 'The requested model is not in the approved system model catalog.')
      }
      let generated = ''
      for await (const event of this.modelPort.generate(prepared.generationInput, controller.signal)) {
        if (this.closed || controller.signal.aborted) return
        if (event.type === 'delta') {
          generated += event.text
          this.atomic(() => {
            const current = this.row<TaskRow>('SELECT state,cancel_requested FROM tasks WHERE id=?', taskId)
            if (!current || current.state !== 'running' || current.cancel_requested) {
              controller.abort()
              return
            }
            const now = this.now()
            const progress: TaskProgress = {
              currentActivity: `Generating ${prepared.generationInput.purpose} (${generated.length} chars)`,
              updatedAt: now,
            }
            this.run('UPDATE tasks SET progress=?,updated_at=? WHERE id=?', canonical(progress), now, taskId)
          })
        } else if (event.type === 'done') {
          generated = event.text
        }
      }
      if (this.closed || controller.signal.aborted) return
      this.atomic(() => {
        const task = this.row<TaskRow>('SELECT * FROM tasks WHERE id=?', taskId)
        if (!task || task.state !== 'running' || task.cancel_requested) return
        const principal = this.authenticateHash(task.credential_hash)
        const request = prepared.request
        if (request.deadlineAt && Date.parse(request.deadlineAt) <= this.clock()) {
          throw new ProtocolError('DEADLINE_EXCEEDED', 'The task deadline elapsed before commit.')
        }
        this.requestAuthorization(principal, request)
        const flags = sanitizeContent([generated])
        if (flags.length > 0) {
          throw new ProtocolError('AUDIT_NOT_PASSED', 'Generated model output triggered prompt injection or privilege escalation quarantine.', false, { injectionEvidence: flags })
        }
        const { generationInput } = prepared
        const document = this.requireDocument(principal, generationInput.document, 'writing:generate')
        const snapshot = this.snapshot(document, generationInput.document.revision)
        this.run("UPDATE tasks SET state='committing',updated_at=? WHERE id=?", this.now(), taskId)
        let result: unknown
        if (generationInput.purpose === 'summarize') {
          result = {
            kind: 'summary',
            summary: generated,
            base: snapshot.document,
            range: generationInput.range,
            modelId: generationInput.modelId,
          }
        } else {
          this.current(principal, document, generationInput.document.revision)
          this.authorize(principal, 'proposal:create', this.documentScope(document))
          let operations: BlockOperation[]
          if (!snapshot.blocks.length) {
            operations = [{ kind: 'insertAtStart', markdown: generated }]
          } else if (generationInput.purpose === 'continue') {
            const anchor = snapshot.blocks.find(b => generationInput.range.end <= b.end) ?? snapshot.blocks[snapshot.blocks.length - 1]
            operations = [{ kind: 'insertAfterBlock', blockId: anchor.blockId, markdown: generated.startsWith('\n') ? generated : `\n${generated}` }]
          } else {
            const overlapping = snapshot.blocks.filter(b => b.end > generationInput.range.start && b.start < Math.max(generationInput.range.end, generationInput.range.start + 1))
            if (!overlapping.length) {
              operations = [{ kind: 'replaceBlock', blockId: snapshot.blocks[0].blockId, markdown: generated }]
            } else {
              const first = overlapping[0]
              const last = overlapping[overlapping.length - 1]
              const prefix = generationInput.range.start > first.start ? snapshot.markdown.slice(first.start, generationInput.range.start) : ''
              const suffix = generationInput.range.end < last.end ? snapshot.markdown.slice(generationInput.range.end, last.end) : ''
              operations = [
                { kind: 'replaceBlock', blockId: first.blockId, markdown: `${prefix}${generated}${suffix}` },
                ...overlapping.slice(1).map(b => ({ kind: 'deleteBlock' as const, blockId: b.blockId })),
              ]
            }
          }
          this.checkProposalGrantConstraints(principal, document, operations, request.workflowId)
          const created = this.createProposal(
            principal,
            snapshot,
            operations,
            `AI ${generationInput.purpose} (${generationInput.modelId})`,
            [{ uri: `urn:marktext:ai:${generationInput.modelId}`, label: `Approved range ${generationInput.range.start}-${generationInput.range.end}` }],
            request.workflowId,
          )
          result = {
            kind: 'proposal',
            proposalId: created.proposalId,
            proposalDigest: created.proposalDigest,
            state: created.state,
            base: snapshot.document,
            range: generationInput.range,
            modelId: generationInput.modelId,
            ...(created.audit ? { audit: created.audit } : {}),
          }
        }
        this.run("UPDATE tasks SET state='succeeded',result=?,updated_at=? WHERE id=?", canonical(result), this.now(), taskId)
        this.run('UPDATE idempotency_records SET result=? WHERE principal_id=? AND request_id=?', canonical(result), principal.id, request.requestId)
        this.event(principal.id, parse<ResourceScope>(task.scope), 'task:read', 'task.succeeded', { taskId })
      })
    } catch (error) {
      if (this.closed || controller.signal.aborted) return
      this.atomic(() => {
        const task = this.row<TaskRow>('SELECT * FROM tasks WHERE id=?', taskId)
        if (!task || finalStates.has(task.state) || task.cancel_requested) return
        const failure = error instanceof ProtocolError ? error : new ProtocolError('MODEL_ERROR', 'Model generation failed without modifying the document.')
        this.run("UPDATE tasks SET state='failed',error=?,updated_at=? WHERE id=?", canonical({
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
          ...(failure.details ? { details: failure.details } : {}),
        }), this.now(), taskId)
        this.event(task.principal_id, parse<ResourceScope>(task.scope), 'task:read', 'task.failed', { taskId, code: failure.code })
      })
    } finally {
      this.abortControllers.delete(taskId)
    }
  }
  private commitTask(taskId: string) {
    try {
      this.atomic(() => {
        const task = this.row<TaskRow>('SELECT * FROM tasks WHERE id=?', taskId)
        if (!task || task.state !== 'running' || task.cancel_requested) return
        const principal = this.authenticateHash(task.credential_hash)
        const request = validateRequest(parse<unknown>(task.request))
        if (request.deadlineAt && Date.parse(request.deadlineAt) <= this.clock()) throw new ProtocolError('DEADLINE_EXCEEDED', 'The task deadline elapsed before commit.')
        this.requestAuthorization(principal, request)
        this.run("UPDATE tasks SET state='committing',updated_at=? WHERE id=?", this.now(), taskId)
        const result = this.mutateRequest(principal, request)
        this.run("UPDATE tasks SET state='succeeded',result=?,updated_at=? WHERE id=?", canonical(result), this.now(), taskId)
        this.run('UPDATE idempotency_records SET result=? WHERE principal_id=? AND request_id=?', canonical(result), principal.id, request.requestId)
        this.event(principal.id, parse<ResourceScope>(task.scope), 'task:read', 'task.succeeded', { taskId })
      })
    } catch (error) {
      this.atomic(() => {
        const task = this.row<TaskRow>('SELECT * FROM tasks WHERE id=?', taskId)
        if (!task || finalStates.has(task.state)) return
        const failure = error instanceof ProtocolError ? error : new ProtocolError('RECOVERY_REQUIRED', 'The task could not be committed.')
        this.run("UPDATE tasks SET state='failed',error=?,updated_at=? WHERE id=?", canonical({ code: failure.code, message: failure.message,
          retryable: failure.retryable, ...(failure.details ? { details: failure.details } : {}) }), this.now(), taskId)
        this.event(task.principal_id, parse<ResourceScope>(task.scope), 'task:read', 'task.failed', { taskId, code: failure.code })
      })
    }
  }

  private readRequest(principal: Principal, request: RequestEnvelope): unknown {
    const input = object(request.input)
    switch (request.capability) {
      case 'documents.list': {
        const all = this.rows<DocumentRow>('SELECT * FROM documents WHERE workspace_id=? ORDER BY id', input.workspaceId as string)
          .filter(document => (!request.workflowId || document.workflow_id === request.workflowId)
            && (input.inbox === undefined || !!document.inbox === input.inbox)
            && !!this.matchingGrant(principal, 'document:read', this.documentScope(document)))
        const context = canonical({ workspaceId: input.workspaceId, workflowId: request.workflowId, inbox: input.inbox })
        const position = this.pagePosition(principal, 'documents', context, input.cursor as string | undefined)
        const limit = input.limit as number | undefined ?? 50
        const documents = all.slice(position, position + limit).map(document => ({ document: this.documentRef(document),
          savedRevision: document.saved_revision, ...this.provenance(document) }))
        return { documents, ...(position + limit < all.length ? { cursor: this.pageCursor(principal, 'documents', context, position + limit) } : {}) }
      }
      case 'documents.read':
      case 'documents.outline':
      case 'documents.blocks': {
        const ref = input.document as DocumentRef
        const document = this.requireDocument(principal, ref, 'document:read')
        this.assertQuarantineReadable(principal, document.audit, this.documentScope(document), 'document')
        const snapshot = this.snapshot(document, ref.revision === 'latest' ? document.revision : ref.revision)
        if (request.capability === 'documents.outline') return { document: snapshot.document, outline: snapshot.outline }
        if (request.capability === 'documents.blocks') {
          const context = canonical(snapshot.document)
          const position = this.pagePosition(principal, 'blocks', context, input.cursor as string | undefined)
          const limit = input.limit as number | undefined ?? 50
          return { document: snapshot.document, blocks: snapshot.blocks.slice(position, position + limit),
            ...(position + limit < snapshot.blocks.length ? { cursor: this.pageCursor(principal, 'blocks', context, position + limit) } : {}) }
        }
        const range = input.range as { start: number; end: number } | undefined
        const start = range?.start ?? 0
        const end = range?.end ?? snapshot.markdown.length
        assertRange(snapshot.markdown, start, end)
        const sessions = this.rows<{ data: string }>('SELECT data FROM window_sessions WHERE doc_id=?', document.id)
        return { document: snapshot.document, markdown: snapshot.markdown.slice(start, end), range: { start, end },
          ...this.provenance(document),
          savedRevision: document.saved_revision, saved: document.saved_revision === snapshot.document.revision,
          freshness: { committed: true, hasUnacknowledgedInput: sessions.some(session => !!parse<{ pendingInput?: boolean }>(session.data).pendingInput) } }
      }
      case 'proposals.get': {
        const proposal = this.row<ProposalRow>('SELECT * FROM proposals WHERE id=?', input.proposalId as string)!
        const document = this.row<DocumentRow>('SELECT * FROM documents WHERE id=?', proposal.doc_id)!
        this.assertQuarantineReadable(principal, proposal.audit, this.documentScope(document), 'proposal')
        return this.proposalView(proposal)
      }
      case 'proposals.list': {
        const document = this.requireDocument(principal, input.document as DocumentRef, 'proposal:read')
        const proposals = this.rows<ProposalRow>('SELECT * FROM proposals WHERE doc_id=? ORDER BY created_at DESC,id LIMIT 201', document.id)
        return { document: this.documentRef(document), proposals: proposals.slice(0, 200).map(proposal => {
          const view = this.proposalView(proposal)
          const { operations, diff: _diff, ...summary } = view
          return { ...summary, operationCount: (operations as BlockOperation[]).length }
        }), truncated: proposals.length > 200 }
      }
      case 'tasks.updateProgress': {
        const task = this.row<TaskRow>('SELECT * FROM tasks WHERE id=?', input.taskId as string)
        if (!task || task.principal_id !== principal.id) denied()
        const scope = parse<ResourceScope>(task.scope)
        this.authorize(principal, 'task:report_progress', scope)
        if (task.cancel_requested || finalStates.has(task.state)) {
          throw new ProtocolError('TOO_LATE', 'Cannot update progress or open an inquiry on a finalized or cancelled task.')
        }
        const now = this.now()
        const priorProgress = task.progress ? parse<TaskProgress>(task.progress) : undefined
        const inquiry = input.inquiry as TaskInquiry | undefined
        const progress: TaskProgress = {
          currentActivity: input.currentActivity as string,
          ...(input.completionRate !== undefined ? { completionRate: input.completionRate as number } : {}),
          ...(input.activeIssues !== undefined ? { activeIssues: input.activeIssues as string[] } : {}),
          ...(inquiry ? { inquiry } : {}),
          ...(!inquiry && priorProgress?.inquiryResolution ? { inquiryResolution: priorProgress.inquiryResolution } : {}),
          updatedAt: now,
        }
        let nextState = task.state
        let cooldownActive = false
        let batched = false
        let shouldResume = false
        if (inquiry) {
          if (!finalStates.has(task.state)) nextState = 'awaiting_user'
          const workflowKey = request.workflowId ?? scope.workflowId ?? scope.docId ?? scope.workspaceId
          const windowStart = new Date(this.clock() - INQUIRY_COOLDOWN_MS).toISOString()
          const recentInquiries = this.rows<{ data: string; created_at: string }>(
            "SELECT data,created_at FROM events WHERE type='task.inquiry' AND created_at>?",
            windowStart,
          ).filter(event => parse<{ workflowKey?: string }>(event.data).workflowKey === workflowKey)
          const unresolvedInWorkflow = this.rows<TaskRow>(
            "SELECT id,scope,request FROM tasks WHERE state='awaiting_user' AND id!=?",
            task.id,
          ).some(other => {
            const otherScope = parse<ResourceScope>(other.scope)
            const otherReq = parse<{ workflowId?: string }>(other.request)
            const otherKey = otherReq.workflowId ?? otherScope.workflowId ?? otherScope.docId ?? otherScope.workspaceId
            return otherKey === workflowKey
          })
          if ((recentInquiries.length > 0 || unresolvedInWorkflow) && inquiry.category !== 'fatal_error') {
            cooldownActive = true
            batched = true
          } else {
            this.event(principal.id, scope, 'task:read', 'task.inquiry', {
              taskId: task.id,
              workflowKey,
              category: inquiry.category,
              summary: inquiry.summary,
              options: inquiry.options,
            })
          }
        } else if (task.state === 'awaiting_user') {
          nextState = 'running'
          shouldResume = true
        }
        this.run('UPDATE tasks SET state=?,progress=?,updated_at=? WHERE id=?', nextState, canonical(progress), now, task.id)
        if (shouldResume) {
          const capability = parse<{ capability: string }>(task.request).capability
          if (capability === 'writing.generate') void this.executeWritingTask(task.id)
          else this.defer(() => this.commitTask(task.id))
        }
        return { taskId: task.id, state: nextState, progress, cooldownActive, batched }
      }
      case 'artifacts.read': {
        const handoff = input.handoffId ? this.requireHandoff(principal, input.handoffId as string) : undefined
        const { artifact, document } = this.artifact(principal, input.artifactId as string, 'artifact:read', handoff?.purpose)
        const offset = input.offset as number
        const length = input.length as number
        if (length > limits.artifactReadBytes || offset > artifact.data.byteLength) invalid('Invalid artifact byte range.')
        return { ...this.artifactView(artifact, document), offset,
          bytes: Array.from(artifact.data.slice(offset, offset + length)), eof: offset + length >= artifact.data.byteLength }
      }
      case 'handoffs.get': return this.handoffView(this.requireHandoff(principal, input.handoffId as string))
      default: throw new ProtocolError('UNSUPPORTED_VERSION', 'This read capability is not supported.')
    }
  }
  /** Provenance is fixed at creation; later commits change only updatedAt. */
  private provenance(document: DocumentRow) {
    const creator = this.row<Principal>('SELECT * FROM principals WHERE id=?', document.creator_id)!
    const audit = document.audit ? parse<AuditMetadata>(document.audit) : undefined
    return { title: document.title, creatorPrincipalId: document.creator_id, creatorName: creator.name,
      workflowId: document.workflow_id, sources: parse<unknown>(document.sources), inbox: !!document.inbox,
      createdAt: document.created_at || null, updatedAt: document.updated_at,
      ...(audit ? { audit } : {}) }
  }
  private proposalView(proposal: ProposalRow) {
    const document = this.row<DocumentRow>('SELECT * FROM documents WHERE id=?', proposal.doc_id)!
    const author = this.row<Principal>('SELECT * FROM principals WHERE id=?', proposal.author_id)!
    const audit = proposal.audit ? parse<AuditMetadata>(proposal.audit) : undefined
    return { proposalId: proposal.id, base: { ...this.documentRef(document), documentEpoch: proposal.epoch, revision: proposal.base_revision },
      authorPrincipalId: proposal.author_id, authorName: author.name, workflowId: proposal.workflow_id,
      operations: parse<unknown>(proposal.operations), reason: proposal.reason, sources: parse<unknown>(proposal.sources),
      proposalDigest: proposal.digest, state: proposal.state, appliedRevision: proposal.applied_revision,
      diff: parse<unknown>(proposal.diff), createdAt: proposal.created_at,
      ...(audit ? { audit } : {}) }
  }
  private artifactView(artifact: ArtifactRow, document: DocumentRow) {
    return { artifactId: artifact.id, document: { ...this.documentRef(document), documentEpoch: artifact.epoch, revision: artifact.revision },
      mime: 'text/markdown;charset=utf-8', byteLength: artifact.data.byteLength,
      suggestedFileName: artifact.filename, digest: artifact.digest, sources: parse<unknown>(document.sources), createdAt: artifact.created_at }
  }
  private requireHandoff(principal: Principal, handoffId: string) {
    const handoff = this.row<HandoffRow>('SELECT * FROM handoffs WHERE id=?', handoffId)
    if (!handoff || (handoff.sender_id !== principal.id && handoff.recipient_id !== principal.id)) denied()
    const grant = this.row<GrantRow>('SELECT * FROM grants WHERE id=?', handoff.grant_id)!
    if (handoff.expires_at <= this.now() || !this.grantActive(grant)) denied()
    const action = handoff.sender_id === principal.id ? 'artifact:share' : 'artifact:read'
    this.artifact(principal, handoff.artifact_id, action, handoff.purpose)
    return handoff
  }
  private handoffView(handoff: HandoffRow) {
    return { handoffId: handoff.id, artifactId: handoff.artifact_id, senderPrincipalId: handoff.sender_id,
      recipientPrincipalId: handoff.recipient_id, purpose: handoff.purpose, expiresAt: handoff.expires_at,
      state: handoff.state, receipt: handoff.receipt ? parse<unknown>(handoff.receipt) : null }
  }

  private mutateRequest(principal: Principal, request: RequestEnvelope): unknown {
    const input = object(request.input)
    switch (request.capability) {
      case 'documents.createDraft': {
        this.checkDraftGrantConstraints(principal, input.workspaceId as string, request.workflowId)
        const snapshot = this.createDocument(principal, input.workspaceId as string, input.title as string, input.markdown as string,
          request.workflowId, input.sources, true)
        const stored = this.row<DocumentRow>('SELECT * FROM documents WHERE id=?', snapshot.document.docId)!
        const audit = stored.audit ? parse<AuditMetadata>(stored.audit) : undefined
        return { document: snapshot.document, inbox: true, ...(audit ? { audit } : {}) }
      }
      case 'proposals.create': {
        const base = input.base as DocumentRef
        const document = this.requireDocument(principal, base, 'proposal:create')
        this.current(principal, document, base.revision)
        const operations = input.operations as BlockOperation[]
        this.checkProposalGrantConstraints(principal, document, operations, request.workflowId)
        return this.createProposal(principal, this.snapshot(document, base.revision), operations,
          input.reason as string, input.sources, request.workflowId)
      }
      case 'proposals.verify': {
        const targetKind = input.targetKind as 'draft' | 'proposal'
        const targetId = input.targetId as string
        const outcome = input.outcome as 'verified' | 'flagged_drift' | 'quarantined_injection'
        const now = this.now()
        let document: DocumentRow
        let authorId: string
        let workflowId: string | null
        let existingAudit: AuditMetadata | undefined
        if (targetKind === 'draft') {
          const found = this.row<DocumentRow>('SELECT * FROM documents WHERE id=?', targetId)
          if (!found) denied()
          document = found
          authorId = found.creator_id
          workflowId = found.workflow_id
          existingAudit = found.audit ? parse<AuditMetadata>(found.audit) : undefined
        } else {
          const proposal = this.row<ProposalRow>('SELECT * FROM proposals WHERE id=?', targetId)
          if (!proposal) denied()
          document = this.row<DocumentRow>('SELECT * FROM documents WHERE id=?', proposal.doc_id)!
          authorId = proposal.author_id
          workflowId = proposal.workflow_id ?? document.workflow_id
          existingAudit = proposal.audit ? parse<AuditMetadata>(proposal.audit) : undefined
        }
        const scope = this.documentScope(document)
        this.authorize(principal, 'audit:review', scope)
        if (existingAudit?.status === 'quarantined_injection' && outcome !== 'quarantined_injection') {
          throw new ProtocolError('AUDIT_NOT_PASSED', 'Static injection quarantine cannot be downgraded or cleared by an auditor.', false, { audit: existingAudit })
        }
        const injectionEvidence = (input.injectionEvidence as string[] | undefined) ?? existingAudit?.injectionEvidence
        const audit: AuditMetadata = {
          status: outcome,
          auditorPrincipalId: principal.id,
          auditedAt: now,
          ...(input.completionRate !== undefined ? { completionRate: input.completionRate as number } : {}),
          ...(input.missingCriteria !== undefined ? { missingCriteria: input.missingCriteria as string[] } : {}),
          ...(input.correctionHint !== undefined ? { correctionHint: input.correctionHint as string } : {}),
          ...(injectionEvidence && injectionEvidence.length ? { injectionEvidence } : {}),
        }
        if (targetKind === 'draft') {
          this.run('UPDATE documents SET audit=?,updated_at=? WHERE id=?', canonical(audit), now, targetId)
        } else {
          this.run('UPDATE proposals SET audit=? WHERE id=?', canonical(audit), targetId)
        }
        let circuitBroken = false
        if (outcome === 'flagged_drift' || outcome === 'quarantined_injection') {
          const author = this.row<Principal>('SELECT * FROM principals WHERE id=?', authorId)
          const authorGrants = author
            ? this.rows<GrantRow>('SELECT * FROM grants WHERE principal_id=? AND revoked=0', author.id).filter(grant => this.grantActive(grant))
            : []
          const maxRetries = this.effectiveMaxRetries(authorGrants)
          const flaggedCount = this.countFlaggedAttempts(authorId, document.workspace_id, document.id, workflowId)
          if (flaggedCount >= maxRetries || outcome === 'quarantined_injection') {
            circuitBroken = true
            this.run(
              "UPDATE tasks SET state='awaiting_user',updated_at=? WHERE principal_id=? AND state IN ('queued','running')",
              now,
              authorId,
            )
          }
        }
        this.event(principal.id, scope, 'proposal:read', 'audit.verdict', { targetKind, targetId, outcome, circuitBroken })
        return { targetKind, targetId, audit, circuitBroken }
      }
      case 'artifacts.export': {
        const ref = input.document as DocumentRef
        const document = this.requireDocument(principal, ref, 'artifact:export')
        this.assertVerifiedAudit(document.audit, 'document', this.documentScope(document), document.creator_id)
        const snapshot = this.snapshot(document, ref.revision)
        const bytes = new TextEncoder().encode(snapshot.rawText)
        const artifactId = randomUUID()
        const filename = [...document.title].map(character => character.charCodeAt(0) < 32 || character === '/' || character === '\\' ? '_' : character)
          .join('').replace(/\.(md|markdown|txt)$/i, '') + '.md'
        const contentDigest = digest(snapshot.rawText)
        this.run('INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?)', artifactId, document.id, document.epoch, ref.revision,
          bytes, contentDigest, filename, principal.id, this.now())
        this.event(principal.id, this.documentScope(document), 'artifact:export', 'artifact.exported', { artifactId, document: ref })
        return this.artifactView(this.row<ArtifactRow>('SELECT * FROM artifacts WHERE id=?', artifactId)!, document)
      }
      case 'artifacts.materializeToManagedDir': {
        const { artifact, document, scope } = this.artifact(principal, input.artifactId as string, 'artifact:materialize')
        this.assertVerifiedAudit(document.audit, 'document', scope, document.creator_id)
        const relativePath = input.relativePath as string
        if (
          !relativePath
          || relativePath.includes('\0')
          || relativePath.startsWith('/')
          || relativePath.startsWith('\\')
          || /^[A-Za-z]:/.test(relativePath)
          || !/\.(md|markdown|txt)$/i.test(relativePath)
        ) {
          throw new ProtocolError('MANAGED_PATH_VIOLATION', 'Target path must be a relative Markdown or text file inside the managed sandbox directory.')
        }
        const segments = relativePath.split(/[\\/]/)
        if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
          throw new ProtocolError('MANAGED_PATH_VIOLATION', 'Target path cannot contain parent directory traversal segments.')
        }
        const realStateDir = realpathSync(this.stateDir)
        const managedRoot = join(realStateDir, 'managed_workspace')
        if (existsSync(managedRoot)) {
          if (lstatSync(managedRoot).isSymbolicLink()) {
            throw new ProtocolError('MANAGED_PATH_VIOLATION', 'Symbolic links are forbidden for the managed sandbox root.')
          }
        } else {
          mkdirSync(managedRoot, { recursive: true, mode: 0o700 })
        }
        const realManagedRoot = realpathSync(managedRoot)
        if (realManagedRoot !== managedRoot || !realManagedRoot.startsWith(realStateDir + sep)) {
          throw new ProtocolError('MANAGED_PATH_VIOLATION', 'Managed sandbox root escapes the service state directory.')
        }
        const targetPath = resolve(realManagedRoot, ...segments)
        if (!targetPath.startsWith(realManagedRoot + sep)) {
          throw new ProtocolError('MANAGED_PATH_VIOLATION', 'Target path escapes the managed sandbox directory.')
        }
        let currentDir = realManagedRoot
        for (const segment of segments.slice(0, -1)) {
          currentDir = join(currentDir, segment)
          if (existsSync(currentDir)) {
            if (lstatSync(currentDir).isSymbolicLink()) {
              throw new ProtocolError('MANAGED_PATH_VIOLATION', 'Symbolic links are forbidden inside the managed sandbox directory.')
            }
          } else {
            mkdirSync(currentDir, { mode: 0o700 })
          }
        }
        if (existsSync(targetPath) && lstatSync(targetPath).isSymbolicLink()) {
          throw new ProtocolError('MANAGED_PATH_VIOLATION', 'Cannot overwrite a symbolic link in the managed sandbox directory.')
        }
        const tmpPath = join(dirname(targetPath), `.tmp-${randomUUID()}`)
        const fd = openSync(tmpPath, 'w', 0o600)
        try {
          writeFileSync(fd, artifact.data)
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        try {
          renameSync(tmpPath, targetPath)
        } catch (error) {
          try { unlinkSync(tmpPath) } catch { /* ignore cleanup error */ }
          throw error
        }
        const materializedAt = this.now()
        this.event(principal.id, scope, 'artifact:materialize', 'artifact.materialized', {
          artifactId: artifact.id,
          relativePath: segments.join('/'),
          byteLength: artifact.data.byteLength,
          digest: artifact.digest,
        })
        return {
          artifactId: artifact.id,
          relativePath: segments.join('/'),
          byteLength: artifact.data.byteLength,
          digest: artifact.digest,
          materializedAt,
        }
      }
      case 'handoffs.create': {
        const { artifact, scope } = this.artifact(principal, input.artifactId as string, 'artifact:share', input.purpose as string)
        const grant = this.authorize(principal, 'artifact:share', scope)
        const expiresAt = new Date(input.expiresAt as string).toISOString()
        if (grant.delegation_depth < 1 || expiresAt > grant.expires_at || expiresAt <= this.now()) denied()
        const recipient = this.row<Principal>('SELECT * FROM principals WHERE id=? AND active=1', input.recipientPrincipalId as string)
        if (!recipient) denied()
        const recipientActions = new Set(this.rows<GrantRow>('SELECT * FROM grants WHERE principal_id=?', recipient.id)
          .filter(g => this.grantActive(g)).flatMap(g => parse<string[]>(g.actions)))
        if (recipientActions.has('audit:review') && !AUDITOR_ALLOWED_ACTIONS.has('artifact:read')) {
          denied()
        }
        const handoffId = randomUUID()
        const childGrantId = this.insertGrant({ principalId: recipient.id, scope: { ...scope, purpose: input.purpose as string },
          actions: ['artifact:read'], expiresAt, delegationDepth: grant.delegation_depth - 1 }, grant.id)
        this.run('INSERT INTO handoffs VALUES(?,?,?,?,?,?,?,?,NULL,?)', handoffId, artifact.id, principal.id, recipient.id,
          input.purpose as string, expiresAt, childGrantId, 'awaiting_receipt', this.now())
        this.event(recipient.id, { ...scope, purpose: input.purpose as string }, 'artifact:read', 'handoff.created', { handoffId, artifactId: artifact.id })
        return this.handoffView(this.row<HandoffRow>('SELECT * FROM handoffs WHERE id=?', handoffId)!)
      }
      case 'handoffs.acknowledge': {
        const handoff = this.requireHandoff(principal, input.handoffId as string)
        if (handoff.recipient_id !== principal.id) denied()
        const artifact = this.row<ArtifactRow>('SELECT * FROM artifacts WHERE id=?', handoff.artifact_id)!
        if (input.artifactDigest !== artifact.digest) invalid('The receipt digest does not match the delivered artifact.')
        const receipt = { status: input.status, artifactDigest: artifact.digest, recipientPrincipalId: principal.id, receivedAt: this.now() }
        if (handoff.receipt) {
          const prior = parse<{ status: string; artifactDigest: string }>(handoff.receipt)
          if (prior.status !== input.status || prior.artifactDigest !== input.artifactDigest) {
            throw new ProtocolError('IDEMPOTENCY_MISMATCH', 'This handoff already has a different receipt.')
          }
          return this.handoffView(handoff)
        }
        this.run('UPDATE handoffs SET state=?,receipt=? WHERE id=?', input.status as string, canonical(receipt), handoff.id)
        return this.handoffView(this.row<HandoffRow>('SELECT * FROM handoffs WHERE id=?', handoff.id)!)
      }
      default: throw new ProtocolError('UNSUPPORTED_VERSION', 'This mutation capability is not supported.')
    }
  }

  private createDocument(principal: Principal, workspaceId: string, title: string, rawText: string, workflowId?: string, sources: unknown = [], inbox = false) {
    const ref: DocumentRef = { workspaceId, docId: randomUUID(), documentEpoch: randomUUID(), revision: '0' }
    const snapshot = createSnapshot(ref, rawText)
    const createdAt = this.now()
    let audit: AuditMetadata | undefined
    if (inbox) {
      const flags = sanitizeContent([title, rawText], sourceStrings(sources))
      const scope: ResourceScope = { workspaceId, ...(workflowId ? { workflowId } : {}) }
      if (flags.length > 0) {
        audit = { status: 'quarantined_injection', injectionEvidence: flags, auditedAt: createdAt }
      } else if (principal.kind === 'agent' && this.requiresAuditForScope(principal, 'document:create', scope)) {
        audit = { status: 'pending_audit' }
      }
    }
    this.run('INSERT INTO documents(id,workspace_id,epoch,revision,title,creator_id,workflow_id,saved_revision,binding_id,fence,sources,updated_at,created_at,inbox,audit) VALUES(?,?,?,?,?,?,?,NULL,NULL,?,?,?,?,?,?)', ref.docId, workspaceId, ref.documentEpoch, ref.revision,
      title, principal.id, workflowId ?? null, '0', canonical(sources), createdAt, createdAt, inbox ? 1 : 0, audit ? canonical(audit) : null)
    this.storeSnapshot(snapshot)
    if (audit?.status !== 'quarantined_injection') {
      this.event(principal.id, { workspaceId, docId: ref.docId, ...(workflowId ? { workflowId } : {}) }, 'document:read', 'document.created', { document: ref, inbox })
    } else {
      this.event(principal.id, { workspaceId, docId: ref.docId, ...(workflowId ? { workflowId } : {}) }, 'document:read', 'document.quarantined', { document: ref, injectionEvidence: audit.injectionEvidence })
    }
    return snapshot
  }
  private storeSnapshot(snapshot: DocumentSnapshot) {
    this.run('INSERT INTO snapshots VALUES(?,?,?,?)', snapshot.document.docId, snapshot.document.documentEpoch,
      snapshot.document.revision, canonical(snapshot))
  }
  private createProposal(principal: Principal, snapshot: DocumentSnapshot, operations: BlockOperation[], reason: string, sources: unknown = [], workflowId?: string, quota: EditQuota = 'proposal') {
    const applied = applyOperations(snapshot, operations, quota)
    const proposalId = randomUUID()
    const content = { base: snapshot.document, operations, authorPrincipalId: principal.id, reason, sources, workflowId }
    const proposalDigest = digest(content)
    const diff = { before: snapshot.markdown, after: applied.markdown, changes: applied.changes }
    const createdAt = this.now()
    const document = this.row<DocumentRow>('SELECT * FROM documents WHERE id=?', snapshot.document.docId)!
    const scope = { ...this.documentScope(document), ...(workflowId ? { workflowId } : {}) }
    let audit: AuditMetadata | undefined
    if (quota === 'proposal') {
      const flags = sanitizeContent([reason, ...operations.map(op => 'markdown' in op ? op.markdown : '')], sourceStrings(sources))
      if (flags.length > 0) {
        audit = { status: 'quarantined_injection', injectionEvidence: flags, auditedAt: createdAt }
      } else if (principal.kind === 'agent' && this.requiresAuditForScope(principal, 'proposal:create', scope)) {
        audit = { status: 'pending_audit' }
      }
    }
    this.run('INSERT INTO proposals(id,doc_id,epoch,base_revision,author_id,workflow_id,operations,reason,sources,digest,state,applied_revision,diff,created_at,audit) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)', proposalId, snapshot.document.docId,
      snapshot.document.documentEpoch, snapshot.document.revision, principal.id, workflowId ?? null, canonical(operations), reason,
      canonical(sources), proposalDigest, 'pending_review', canonical(diff), createdAt, audit ? canonical(audit) : null)
    if (audit?.status !== 'quarantined_injection') {
      this.event(principal.id, this.documentScope(document), 'proposal:read', 'proposal.created', { proposalId, base: snapshot.document })
    } else {
      this.event(principal.id, this.documentScope(document), 'proposal:read', 'proposal.quarantined', { proposalId, base: snapshot.document, injectionEvidence: audit.injectionEvidence })
    }
    return { proposalId, base: snapshot.document, proposalDigest, state: 'pending_review', ...(audit ? { audit } : {}) }
  }
  private event(principalId: string | null, scope: ResourceScope, action: string, type: string, data: unknown) {
    this.run('INSERT INTO events(id,principal_id,scope,action,type,data,created_at) VALUES(?,?,?,?,?,?,?)', randomUUID(),
      principalId, canonical(scope), action, type, canonical(data), this.now())
  }
  listEvents(auth: string, cursor?: string, limit: number = limits.eventPage) {
    const principal = this.authenticate(auth)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > limits.eventPage) invalid('Invalid event page size.')
    let position = 0
    if (cursor !== undefined) {
      const stored = this.row<{ principal_id: string; sequence: number; expires_at: string }>('SELECT * FROM event_cursors WHERE hash=?', digest(cursor))
      if (!stored || stored.principal_id !== principal.id || stored.expires_at <= this.now()) {
        throw new ProtocolError('EVENTS_EXPIRED', 'Read a new snapshot and restart the event stream.')
      }
      position = stored.sequence
    }
    const events: unknown[] = []
    let scanned = 0
    for (;;) {
      const batch = this.rows<{ sequence: number; id: string; principal_id: string | null; scope: string; action: string; type: string; data: string; created_at: string }>('SELECT * FROM events WHERE sequence>? ORDER BY sequence LIMIT 512', position)
      for (const event of batch) {
        position = event.sequence
        scanned++
        const ownsTask = !event.type.startsWith('task.') || event.principal_id === principal.id
        if (ownsTask && this.matchingGrant(principal, event.action, parse<ResourceScope>(event.scope))) {
          events.push({ eventId: event.id, type: event.type, data: parse<unknown>(event.data), createdAt: event.created_at })
        }
        if (events.length === limit) break
      }
      if (batch.length < 512 || events.length === limit || scanned >= 4096) break
    }
    const nextCursor = opaqueSecret()
    this.run('INSERT INTO event_cursors VALUES(?,?,?,?)', digest(nextCursor), principal.id, position, this.expiry(24 * 60 * 60_000))
    return { events, cursor: nextCursor }
  }
  private pagePosition(principal: Principal, kind: string, context: string, cursor?: string) {
    if (cursor === undefined) return 0
    const stored = this.row<{ principal_id: string; kind: string; context: string; position: number; expires_at: string }>('SELECT * FROM page_cursors WHERE hash=?', digest(cursor))
    if (!stored || stored.principal_id !== principal.id || stored.kind !== kind || stored.context !== context || stored.expires_at <= this.now()) {
      throw new ProtocolError('EVENTS_EXPIRED', 'This page cursor is invalid or expired.')
    }
    return stored.position
  }
  private pageCursor(principal: Principal, kind: string, context: string, position: number) {
    const cursor = opaqueSecret()
    this.run('INSERT INTO page_cursors VALUES(?,?,?,?,?,?)', digest(cursor), principal.id, kind, context, position, this.expiry(60 * 60_000))
    return cursor
  }

  close() {
    if (this.closed) return
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    for (const controller of this.abortControllers.values()) controller.abort()
    this.abortControllers.clear()
    this.closed = true
    this.db.close()
  }

  listWorkspaceTasks(auth: string, workspaceId: string) {
    this.author(auth, 'task:read', { workspaceId })
    return this.rows<TaskRow>('SELECT * FROM tasks ORDER BY updated_at DESC,id LIMIT 100').flatMap(task => {
      const scope = parse<ResourceScope>(task.scope)
      if (scope.workspaceId !== workspaceId) return []
      const req = parse<{ capability: string; workflowId?: string }>(task.request)
      if (req.capability.startsWith('author.')) return []
      const owner = this.row<Principal>('SELECT * FROM principals WHERE id=?', task.principal_id)
      const progress = task.progress ? parse<TaskProgress>(task.progress) : undefined
      const error = task.error ? parse<{ code: string; message: string; retryable: boolean }>(task.error) : undefined
      return [{
        taskId: task.id,
        requestId: task.request_id,
        principalId: task.principal_id,
        principalName: owner?.name ?? task.principal_id,
        capability: req.capability,
        workflowId: req.workflowId ?? scope.workflowId ?? null,
        docId: scope.docId ?? null,
        state: task.state,
        cancelRequested: !!task.cancel_requested,
        createdAt: task.created_at,
        updatedAt: task.updated_at,
        ...(progress ? { progress } : {}),
        ...(error ? { error } : {}),
      }]
    })
  }

  resolveTaskInquiry(auth: string, input: AuthorInput & { workspaceId: string; taskId: string; optionId: string }) {
    let resumeCapability: string | undefined
    const resolved = this.hostCommand(auth, 'task:resolveInquiry', input, { workspaceId: input.workspaceId }, 'grant:manage', principal => {
      const task = this.row<TaskRow>('SELECT * FROM tasks WHERE id=?', input.taskId)
      if (!task) denied()
      const scope = parse<ResourceScope>(task.scope)
      if (scope.workspaceId !== input.workspaceId) denied()
      if (task.state !== 'awaiting_user' || task.cancel_requested) {
        throw new ProtocolError('REVISION_CONFLICT', 'This task is no longer awaiting a user decision.')
      }
      const prior = task.progress ? parse<TaskProgress>(task.progress) : undefined
      if (prior?.inquiry && !prior.inquiry.options.some(opt => opt.optionId === input.optionId)) {
        invalid('The selected inquiry option does not belong to this task.')
      }
      const now = this.now()
      const resolution: InquiryResolution = {
        optionId: input.optionId,
        resolvedBy: principal.id,
        resolvedAt: now,
      }
      const nextProgress: TaskProgress = {
        currentActivity: prior?.currentActivity ?? 'User decision received; resuming task',
        ...(prior?.completionRate !== undefined ? { completionRate: prior.completionRate } : {}),
        ...(prior?.activeIssues ? { activeIssues: prior.activeIssues } : {}),
        ...(prior?.inquiry ? { inquiry: prior.inquiry } : {}),
        inquiryResolution: resolution,
        updatedAt: now,
      }
      this.run("UPDATE tasks SET state='running',progress=?,updated_at=? WHERE id=?", canonical(nextProgress), now, task.id)
      this.event(task.principal_id, scope, 'task:read', 'task.inquiry_resolved', {
        taskId: task.id,
        optionId: input.optionId,
        resolvedAt: now,
      })
      resumeCapability = parse<{ capability: string }>(task.request).capability
      return { taskId: task.id, state: 'running' as const, inquiryResolution: resolution }
    })
    if (resumeCapability === 'writing.generate') void this.executeWritingTask(input.taskId)
    else if (resumeCapability) this.defer(() => this.commitTask(input.taskId))
    return resolved
  }

  // Protected host commands are deliberately absent from the worker's public method allowlist.
  connectAuthor(ticket: string, workspaceId: string) {
    if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 128) invalid()
    return this.atomic(() => {
      const binding: ApprovalBinding = { action: 'author:connect', workspaceId, targetId: workspaceId,
        digest: digest({ workspaceId }), sideEffects: ['author-session'] }
      const evidence = this.approval(ticket, binding)
      const existing = this.row<Principal>('SELECT * FROM principals WHERE id=?', evidence.principalId)
      if (existing && existing.kind !== 'author') denied()
      if (!existing) this.run('INSERT INTO principals(id,name,kind) VALUES(?,?,?)', evidence.principalId, 'Document author', 'author')
      const principal = this.row<Principal>('SELECT * FROM principals WHERE id=?', evidence.principalId)!
      if (!principal.active) denied()
      this.consumeApproval(ticket, binding, principal.id)
      this.insertGrant({ principalId: principal.id, scope: { workspaceId }, actions: authorActions,
        expiresAt: evidence.expiresAt, delegationDepth: 1 })
      return this.credential(principal, evidence.expiresAt)
    })
  }

  private insertGrant(input: GrantInput, parentId: string | null = null) {
    const grantId = randomUUID()
    this.run('INSERT INTO grants VALUES(?,?,?,?,?,0,0,?,?)', grantId, input.principalId, canonical(input.scope),
      canonical([...new Set(input.actions)]), new Date(input.expiresAt).toISOString(), input.delegationDepth ?? 0, parentId)
    return grantId
  }

  approvePairing(auth: string, input: AuthorInput & { pairingId: string; grants: Omit<GrantInput, 'principalId'>[] }) {
    return this.hostCommand(auth, 'pairing:approve', input, { workspaceId: input.grants[0]?.scope.workspaceId ?? '' }, 'grant:manage', () => {
      const pairing = this.row<{ id: string; name: string; state: string; expires_at: string }>('SELECT * FROM pairings WHERE id=?', input.pairingId)
      if (!pairing || pairing.state !== 'pending' || pairing.expires_at <= this.now() || !input.grants.length) invalid('This pairing cannot be approved.')
      const principalId = randomUUID()
      this.run('INSERT INTO principals(id,name,kind) VALUES(?,?,?)', principalId, pairing.name, 'agent')
      const owner = this.authenticate(auth)
      const grantIds = input.grants.map(grant => {
        this.checkGrantInput(owner, { ...grant, principalId })
        return this.insertGrant({ ...grant, principalId })
      })
      // The caller polls for the decision; it gets a fresh window to claim from the moment of approval.
      this.run("UPDATE pairings SET state='approved',principal_id=?,expires_at=? WHERE id=?", principalId, this.expiry(10 * 60_000), pairing.id)
      return { principalId, grantIds }
    })
  }

  /** Names are caller-supplied and unverified; the host shows them as text only. */
  listPairings(auth: string, workspaceId: string) {
    this.author(auth, 'grant:manage', { workspaceId })
    return this.rows<{ id: string; name: string; expires_at: string }>(
      "SELECT id,name,expires_at FROM pairings WHERE state='pending' AND expires_at>? ORDER BY expires_at,id", this.now())
      .map(pairing => ({ pairingId: pairing.id, name: pairing.name, expiresAt: pairing.expires_at }))
  }

  rejectPairing(auth: string, input: AuthorInput & { pairingId: string; workspaceId: string }) {
    return this.hostCommand(auth, 'pairing:reject', input, { workspaceId: input.workspaceId }, 'grant:manage', () => {
      const pairing = this.row<{ id: string; state: string }>('SELECT id,state FROM pairings WHERE id=?', input.pairingId)
      if (!pairing || pairing.state !== 'pending') invalid('This pairing cannot be rejected.')
      this.run("UPDATE pairings SET state='rejected',claim_hash='' WHERE id=?", pairing.id)
      return { pairingId: pairing.id, state: 'rejected' }
    })
  }

  listPrincipals(auth: string, workspaceId: string) {
    this.author(auth, 'grant:manage', { workspaceId })
    return this.rows<Principal>("SELECT * FROM principals WHERE kind='agent' ORDER BY name,id").flatMap(principal => {
      const grants = this.rows<GrantRow>('SELECT * FROM grants WHERE principal_id=? ORDER BY expires_at,id', principal.id)
        .filter(grant => parse<ResourceScope>(grant.scope).workspaceId === workspaceId)
        .map(grant => ({ grantId: grant.id, scope: parse<ResourceScope>(grant.scope), actions: parse<string[]>(grant.actions),
          expiresAt: grant.expires_at, active: this.grantActive(grant), delegationDepth: grant.delegation_depth, delegated: !!grant.parent_id }))
      return grants.length ? [{ principalId: principal.id, name: principal.name, active: !!principal.active, grants }] : []
    })
  }

  private checkGrantInput(owner: Principal, input: GrantInput) {
    if (!input.scope?.workspaceId || !input.actions.length || typeof input.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= this.clock()
      || !Number.isSafeInteger(input.delegationDepth ?? 0) || (input.delegationDepth ?? 0) < 0) invalid('Invalid grant.')
    if (input.scope.allowedBlockIds !== undefined && (!Array.isArray(input.scope.allowedBlockIds)
      || !input.scope.allowedBlockIds.length || input.scope.allowedBlockIds.some(id => typeof id !== 'string' || !id))) {
      invalid('Invalid allowedBlockIds constraint.')
    }
    if (input.scope.maxAuditRetries !== undefined && (!Number.isSafeInteger(input.scope.maxAuditRetries)
      || input.scope.maxAuditRetries < 1 || input.scope.maxAuditRetries > 10)) {
      invalid('Invalid maxAuditRetries constraint.')
    }
    this.authorize(owner, 'grant:manage', input.scope)
    const existingActions = new Set(this.rows<GrantRow>('SELECT * FROM grants WHERE principal_id=?', input.principalId)
      .filter(grant => this.grantActive(grant)).flatMap(grant => parse<string[]>(grant.actions)))
    const combinedActions = new Set([...existingActions, ...input.actions])
    if (combinedActions.has('audit:review')) {
      for (const action of combinedActions) {
        if (!AUDITOR_ALLOWED_ACTIONS.has(action)) denied()
      }
    }
    for (const action of input.actions) {
      if (!authorActions.includes(action) || ['grant:manage', 'document:commit', 'proposal:approve', 'document:save', 'writer:manage'].includes(action)) denied()
      // An owner may hold overlapping grants (a renewed session); any one of them may cover the new grant.
      const covered = this.matchingGrants(owner, action, input.scope).some(upper =>
        Date.parse(input.expiresAt) <= Date.parse(upper.expires_at) && (input.delegationDepth ?? 0) <= upper.delegation_depth)
      if (!covered) denied()
    }
  }

  setGrant(auth: string, input: AuthorInput & GrantInput) {
    return this.hostCommand(auth, 'grant:create', input, input.scope, 'grant:manage', () => {
      this.checkGrantInput(this.authenticate(auth), input)
      const principal = this.row<Principal>('SELECT * FROM principals WHERE id=? AND active=1', input.principalId)
      if (!principal) denied()
      return { grantId: this.insertGrant(input) }
    })
  }

  revokeGrant(auth: string, input: AuthorInput & { grantId: string; workspaceId: string }) {
    return this.hostCommand(auth, 'grant:revoke', input, { workspaceId: input.workspaceId }, 'grant:manage', () => {
      const grant = this.row<GrantRow>('SELECT * FROM grants WHERE id=?', input.grantId)
      if (!grant || parse<ResourceScope>(grant.scope).workspaceId !== input.workspaceId) denied()
      this.run('UPDATE grants SET revoked=1,generation=generation+1 WHERE id=?', input.grantId)
      return { revoked: true, grantId: input.grantId }
    })
  }

  revokePrincipal(auth: string, input: AuthorInput & { principalId: string; workspaceId: string }) {
    return this.hostCommand(auth, 'principal:revoke', input, { workspaceId: input.workspaceId }, 'grant:manage', owner => {
      const principal = this.row<Principal>('SELECT * FROM principals WHERE id=?', input.principalId)
      if (!principal || principal.kind !== 'agent') denied()
      for (const grant of this.rows<GrantRow>('SELECT * FROM grants WHERE principal_id=?', principal.id)) {
        this.authorize(owner, 'grant:manage', parse<ResourceScope>(grant.scope))
      }
      this.run('UPDATE principals SET active=0,generation=generation+1 WHERE id=?', principal.id)
      this.run('UPDATE grants SET revoked=1,generation=generation+1 WHERE principal_id=?', principal.id)
      return { revoked: true, principalId: principal.id }
    })
  }

  importDocument(auth: string, input: AuthorInput & { workspaceId: string; title: string; rawText: string; binding?: ResourceBindingInput }) {
    return this.hostCommand(auth, 'document:import', input, { workspaceId: input.workspaceId }, 'document:commit', principal => {
      if (input.binding?.alias) {
        const existing = this.row<{ doc_id: string }>('SELECT doc_id FROM resource_bindings WHERE workspace_id=? AND alias=?', input.workspaceId, input.binding.alias)
        if (existing) {
          const document = this.row<DocumentRow>('SELECT * FROM documents WHERE id=?', existing.doc_id)!
          this.authorize(principal, 'document:read', this.documentScope(document))
          return { snapshot: this.snapshot(document), reused: true }
        }
      }
      if (!input.title || input.title.length > 240) invalid('A document title is required.')
      const snapshot = this.createDocument(principal, input.workspaceId, input.title, input.rawText)
      if (input.binding) {
        const bindingId = this.storeBinding(snapshot.document, input.binding)
        this.run('UPDATE documents SET binding_id=?,saved_revision=? WHERE id=?', bindingId, snapshot.document.revision, snapshot.document.docId)
      }
      return { snapshot, reused: false }
    })
  }

  private storeBinding(ref: DocumentRef, binding: ResourceBindingInput, ownerSession?: string) {
    if (!['root', 'handle'].includes(binding.kind)
      || binding.consistency !== (binding.kind === 'root' ? 'conditional-write' : 'best-effort')
      || typeof binding.needsReauthorization !== 'boolean') invalid('Invalid resource binding metadata.')
    let bindingId = binding.bindingId ?? randomUUID()
    if (binding.alias) {
      const alias = this.row<{ id: string; doc_id: string }>('SELECT id,doc_id FROM resource_bindings WHERE workspace_id=? AND alias=?', ref.workspaceId, binding.alias)
      if (alias && alias.doc_id !== ref.docId) throw new ProtocolError('REVISION_CONFLICT', 'This resource is already bound to another canonical document.')
      if (alias && !binding.bindingId) bindingId = alias.id
    }
    const existing = this.row<{ doc_id: string }>('SELECT * FROM resource_bindings WHERE id=?', bindingId)
    if (existing && existing.doc_id !== ref.docId) denied()
    const metadata = { bindingId, kind: binding.kind, consistency: binding.consistency,
      resourceVersion: binding.resourceVersion, needsReauthorization: binding.needsReauthorization,
      ...(binding.kind === 'handle' ? { ownerSession, needsReauthorization: binding.needsReauthorization || !ownerSession } : {}) }
    this.run('INSERT INTO resource_bindings VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET alias=excluded.alias,data=excluded.data',
      bindingId, ref.docId, ref.workspaceId, binding.alias ?? null, canonical(metadata))
    return bindingId
  }

  bindResource(auth: string, input: AuthorInput & WriterToken & { document: DocumentRef; binding: ResourceBindingInput }) {
    return this.hostCommand(auth, 'resource:bind', input, { workspaceId: input.document.workspaceId, docId: input.document.docId }, 'document:save', principal => {
      const document = this.requireDocument(principal, input.document, 'document:save')
      this.current(principal, document, input.document.revision)
      this.checkLease(principal, document, input)
      const bindingId = this.storeBinding(input.document, input.binding, input.windowSessionId)
      this.run('UPDATE documents SET binding_id=?,saved_revision=CASE WHEN binding_id=? THEN saved_revision ELSE NULL END WHERE id=?', bindingId, bindingId, document.id)
      return { bindingId, document: this.documentRef(document) }
    })
  }

  getWriterStatus(auth: string, document: DocumentRef, windowSessionId?: string) {
    const principal = this.author(auth, 'document:read', { workspaceId: document.workspaceId, docId: document.docId })
    const stored = this.requireDocument(principal, document, 'document:read')
    const lease = this.row<LeaseRow>('SELECT * FROM writer_leases WHERE doc_id=?', stored.id)
    const active = !!lease && lease.service_epoch === this.serviceEpoch && lease.expires_at > this.now()
    const ownerSession = active ? lease!.owner_session : null
    const sessionRow = ownerSession ? this.row<{ data: string }>('SELECT data FROM window_sessions WHERE id=?', ownerSession) : undefined
    const hasPendingInput = sessionRow ? !!parse<{ pendingInput?: boolean }>(sessionRow.data).pendingInput : false
    return {
      document: this.documentRef(stored),
      hasActiveLease: active,
      ownerSessionId: ownerSession,
      ownedByCaller: !!windowSessionId && ownerSession === windowSessionId,
      writerFence: active ? lease!.fence : stored.fence,
      expiresAt: active ? lease!.expires_at : null,
      hasPendingInput,
    }
  }

  takeoverWriter(auth: string, input: AuthorInput & { document: DocumentRef; windowSessionId: string }) {
    return this.hostCommand(auth, 'writer:takeover', input, { workspaceId: input.document.workspaceId, docId: input.document.docId }, 'writer:manage', principal => {
      if (!input.windowSessionId || input.windowSessionId.length > 128) invalid('A window session is required.')
      const document = this.requireDocument(principal, input.document, 'writer:manage')
      this.current(principal, document, input.document.revision)
      const session = this.row<{ principal_id: string; doc_id: string }>('SELECT * FROM window_sessions WHERE id=?', input.windowSessionId)
      if (session && (session.principal_id !== principal.id || session.doc_id !== document.id)) denied()
      const old = this.row<LeaseRow>('SELECT * FROM writer_leases WHERE doc_id=?', document.id)
      if (old && old.service_epoch === this.serviceEpoch && old.expires_at > this.now() && old.owner_session !== input.windowSessionId) {
        const oldSession = this.row<{ data: string }>('SELECT data FROM window_sessions WHERE id=?', old.owner_session)
        if (oldSession && parse<{ pendingInput?: boolean }>(oldSession.data).pendingInput) {
          throw new ProtocolError('EDITOR_BUSY', 'The active writer window still has unsynchronized input; wait for synchronization or lease expiry before taking over.')
        }
      }
      const fence = old && old.owner_session === input.windowSessionId && old.service_epoch === this.serviceEpoch && old.expires_at > this.now()
        ? old.fence
        : nextRevision(document.fence)
      const expiresAt = this.expiry(10_000)
      this.run('UPDATE documents SET fence=? WHERE id=?', fence, document.id)
      this.run('INSERT INTO writer_leases VALUES(?,?,?,?,?) ON CONFLICT(doc_id) DO UPDATE SET owner_session=excluded.owner_session,fence=excluded.fence,service_epoch=excluded.service_epoch,expires_at=excluded.expires_at', document.id, input.windowSessionId, fence, this.serviceEpoch, expiresAt)
      this.run('INSERT INTO window_sessions VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING', input.windowSessionId, principal.id, document.id,
        canonical({ pendingInput: false, localOpSeq: 0, acknowledgedRevision: document.revision }))
      this.event(principal.id, this.documentScope(document), 'document:read', 'writer.taken_over', {
        document: this.documentRef(document),
        writerFence: fence,
      })
      return {
        windowSessionId: input.windowSessionId,
        writerFence: fence,
        serviceEpoch: this.serviceEpoch,
        expiresAt,
        document: this.documentRef(document),
      }
    })
  }

  acquireWriter(auth: string, input: AuthorInput & { document: DocumentRef; windowSessionId: string }) {
    return this.hostCommand(auth, 'writer:acquire', input, { workspaceId: input.document.workspaceId, docId: input.document.docId }, 'writer:manage', principal => {
      if (!input.windowSessionId || input.windowSessionId.length > 128) invalid('A window session is required.')
      const document = this.requireDocument(principal, input.document, 'writer:manage')
      this.current(principal, document, input.document.revision)
      const old = this.row<LeaseRow>('SELECT * FROM writer_leases WHERE doc_id=?', document.id)
      const session = this.row<{ principal_id: string; doc_id: string }>('SELECT * FROM window_sessions WHERE id=?', input.windowSessionId)
      if (session && (session.principal_id !== principal.id || session.doc_id !== document.id)) denied()
      if (old && old.expires_at > this.now() && old.owner_session !== input.windowSessionId) {
        throw new ProtocolError('WRITER_BUSY', 'Another window still owns the writer lease.', true)
      }
      const fence = old && old.expires_at > this.now() ? old.fence : nextRevision(document.fence)
      const expiresAt = this.expiry(10_000)
      this.run('UPDATE documents SET fence=? WHERE id=?', fence, document.id)
      this.run('INSERT INTO writer_leases VALUES(?,?,?,?,?) ON CONFLICT(doc_id) DO UPDATE SET owner_session=excluded.owner_session,fence=excluded.fence,service_epoch=excluded.service_epoch,expires_at=excluded.expires_at', document.id, input.windowSessionId, fence, this.serviceEpoch, expiresAt)
      this.run('INSERT INTO window_sessions VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING', input.windowSessionId, principal.id, document.id,
        canonical({ pendingInput: false, localOpSeq: 0, acknowledgedRevision: document.revision }))
      return { windowSessionId: input.windowSessionId, writerFence: fence, serviceEpoch: this.serviceEpoch,
        expiresAt, document: this.documentRef(document) }
    })
  }

  private checkLease(principal: Principal, document: DocumentRow, token: WriterToken) {
    const lease = this.row<LeaseRow>('SELECT * FROM writer_leases WHERE doc_id=?', document.id)
    const session = this.row<{ principal_id: string }>('SELECT principal_id FROM window_sessions WHERE id=?', token.windowSessionId)
    if (!lease || !session || session.principal_id !== principal.id || lease.owner_session !== token.windowSessionId
      || lease.fence !== token.writerFence || lease.service_epoch !== token.serviceEpoch
      || lease.service_epoch !== this.serviceEpoch || lease.expires_at <= this.now()) {
      throw new ProtocolError('LEASE_LOST', 'This window must synchronize and acquire a new writer lease.')
    }
    return lease
  }

  renewWriter(auth: string, input: WriterToken & { document: DocumentRef }) {
    return this.atomic(() => {
      const principal = this.author(auth, 'writer:manage', { workspaceId: input.document.workspaceId, docId: input.document.docId })
      const document = this.requireDocument(principal, input.document, 'writer:manage')
      this.checkLease(principal, document, input)
      const expiresAt = this.expiry(10_000)
      this.run('UPDATE writer_leases SET expires_at=? WHERE doc_id=?', expiresAt, document.id)
      return { ...input, expiresAt }
    })
  }

  updateWindowState(auth: string, input: WriterToken & { document: DocumentRef; localOpSeq: number; pendingInput: boolean }) {
    return this.atomic(() => {
      const principal = this.author(auth, 'writer:manage', { workspaceId: input.document.workspaceId, docId: input.document.docId })
      const document = this.requireDocument(principal, input.document, 'writer:manage')
      this.checkLease(principal, document, input)
      if (!Number.isSafeInteger(input.localOpSeq) || input.localOpSeq < 0 || typeof input.pendingInput !== 'boolean') invalid()
      const old = this.row<{ data: string }>('SELECT data FROM window_sessions WHERE id=?', input.windowSessionId)!
      const state = parse<{ localOpSeq: number }>(old.data)
      if (input.localOpSeq < state.localOpSeq) return parse<unknown>(old.data)
      const data = { localOpSeq: input.localOpSeq, pendingInput: input.pendingInput, acknowledgedRevision: input.document.revision }
      this.run('UPDATE window_sessions SET data=? WHERE id=?', canonical(data), input.windowSessionId)
      return data
    })
  }

  releaseWriter(auth: string, input: WriterToken & { document: DocumentRef }) {
    return this.atomic(() => {
      const principal = this.author(auth, 'writer:manage', { workspaceId: input.document.workspaceId, docId: input.document.docId })
      const document = this.requireDocument(principal, input.document, 'writer:manage')
      this.checkLease(principal, document, input)
      const state = this.row<{ data: string }>('SELECT data FROM window_sessions WHERE id=?', input.windowSessionId)!
      if (parse<{ pendingInput: boolean }>(state.data).pendingInput) throw new ProtocolError('EDITOR_BUSY', 'Flush or preserve pending input before releasing this window.')
      this.run('DELETE FROM writer_leases WHERE doc_id=?', document.id)
      return { released: true }
    })
  }

  preserveRecoveryDraft(auth: string, input: { document: DocumentRef; markdown: string; reason: string }) {
    return this.atomic(() => {
      const principal = this.author(auth, 'document:commit', { workspaceId: input.document.workspaceId, docId: input.document.docId })
      const document = this.row<DocumentRow>('SELECT * FROM documents WHERE id=? AND workspace_id=?', input.document.docId, input.document.workspaceId)
      if (!document) denied()
      assertText(input.markdown)
      const recoveryDraftId = randomUUID()
      this.run('INSERT INTO recovery_drafts VALUES(?,?,?,?,?,?,?)', recoveryDraftId, principal.id, document.id,
        canonical(input.document), input.markdown, input.reason.slice(0, 240), this.now())
      return { recoveryDraftId, base: input.document }
    })
  }

  getRecoveryDrafts(auth: string, document: DocumentRef) {
    const principal = this.author(auth, 'document:read', { workspaceId: document.workspaceId, docId: document.docId })
    this.requireDocument(principal, document, 'document:read')
    return this.rows<{ id: string; base: string; markdown: string; reason: string; created_at: string }>('SELECT * FROM recovery_drafts WHERE principal_id=? AND doc_id=? ORDER BY created_at', principal.id, document.docId)
      .map(draft => ({ recoveryDraftId: draft.id, base: parse<DocumentRef>(draft.base), markdown: draft.markdown, reason: draft.reason, createdAt: draft.created_at }))
  }

  private commitSnapshot(document: DocumentRow, rawText: string) {
    const ref = { ...this.documentRef(document), revision: nextRevision(document.revision) }
    const snapshot = createSnapshot(ref, rawText)
    this.storeSnapshot(snapshot)
    this.run('UPDATE documents SET revision=?,updated_at=? WHERE id=?', ref.revision, this.now(), document.id)
    this.run("UPDATE proposals SET state='stale' WHERE doc_id=? AND state='pending_review'", document.id)
    this.event(null, this.documentScope(document), 'document:read', 'document.committed', { document: ref })
    return snapshot
  }

  commitDocument(auth: string, input: AuthorInput & WriterToken & { document: DocumentRef; markdown: string; localOpSeq: number }) {
    try {
      return this.hostCommand(auth, 'document:commit', input, { workspaceId: input.document.workspaceId, docId: input.document.docId }, 'document:commit', principal => {
        const document = this.requireDocument(principal, input.document, 'document:commit')
        this.assertVerifiedAudit(document.audit, 'document', this.documentScope(document), document.creator_id)
        this.checkLease(principal, document, input)
        this.current(principal, document, input.document.revision)
        if (!Number.isSafeInteger(input.localOpSeq) || input.localOpSeq < 0) invalid()
        const before = this.snapshot(document)
        const rawText = serializeMarkdown(before.rawText, input.markdown)
        const snapshot = rawText === before.rawText ? before : this.commitSnapshot(document, rawText)
        this.run('UPDATE window_sessions SET data=? WHERE id=?', canonical({ localOpSeq: input.localOpSeq,
          acknowledgedRevision: snapshot.document.revision, pendingInput: false }), input.windowSessionId)
        return { transactionId: randomUUID(), snapshot, localOpSeq: input.localOpSeq }
      })
    } catch (error) {
      if (error instanceof ProtocolError && ['LEASE_LOST', 'REVISION_CONFLICT'].includes(error.code)) {
        const recovery = this.preserveRecoveryDraft(auth, { document: input.document, markdown: input.markdown, reason: error.code })
        throw new ProtocolError(error.code, error.message, error.retryable, { ...error.details, ...recovery })
      }
      throw error
    }
  }

  acceptProposal(auth: string, input: AuthorInput & WriterToken & { document: DocumentRef; proposalId: string; proposalDigest: string }) {
    return this.hostCommand(auth, 'proposal:accept', input, { workspaceId: input.document.workspaceId, docId: input.document.docId }, 'proposal:approve', principal => {
      const document = this.requireDocument(principal, input.document, 'proposal:approve')
      this.checkLease(principal, document, input)
      this.current(principal, document, input.document.revision)
      const session = this.row<{ data: string }>('SELECT data FROM window_sessions WHERE id=?', input.windowSessionId)!
      if (parse<{ pendingInput: boolean }>(session.data).pendingInput) throw new ProtocolError('EDITOR_BUSY', 'Completed input must be acknowledged before accepting a proposal.')
      const proposal = this.row<ProposalRow>('SELECT * FROM proposals WHERE id=?', input.proposalId)
      if (!proposal || proposal.doc_id !== document.id || proposal.epoch !== document.epoch) denied()
      if (proposal.digest !== input.proposalDigest) throw new ProtocolError('APPROVAL_INVALID', 'The approved proposal content does not match.')
      if (proposal.state !== 'pending_review' || proposal.base_revision !== document.revision) {
        throw new ProtocolError('REVISION_CONFLICT', 'This proposal needs a new review against the current document.')
      }
      const docScope = this.documentScope(document)
      this.assertVerifiedAudit(document.audit, 'document', docScope, document.creator_id)
      this.assertVerifiedAudit(proposal.audit, 'proposal', { ...docScope, ...(proposal.workflow_id ? { workflowId: proposal.workflow_id } : {}) }, proposal.author_id)
      const source = this.row<Principal>('SELECT * FROM principals WHERE id=? AND active=1', proposal.author_id)
      if (!source) denied()
      this.authorize(source, 'proposal:create', this.documentScope(document))
      const before = this.snapshot(document)
      const recovery = this.row('SELECT undo_id FROM reverse_proposals WHERE proposal_id=?', proposal.id)
      const applied = applyOperations(before, parse<BlockOperation[]>(proposal.operations), recovery ? 'recovery' : 'proposal')
      const snapshot = this.commitSnapshot(document, applied.rawText)
      const inverse: TextChange[] = []
      let offsetDelta = 0
      for (const change of [...applied.changes].sort((left, right) => left.start - right.start || left.end - right.end)) {
        const start = change.start + offsetDelta
        const previous = inverse[inverse.length - 1]
        // Adjacent deletions collapse to one insertion point in the committed snapshot.
        if (change.text.length === 0 && previous && previous.start === start && previous.end === start) {
          previous.text += change.before
        } else {
          inverse.push({ start, end: start + change.text.length, text: change.before, before: change.text })
        }
        offsetDelta += change.text.length - (change.end - change.start)
      }
      const transactionId = randomUUID()
      this.run("UPDATE proposals SET state='applied',applied_revision=? WHERE id=?", snapshot.document.revision, proposal.id)
      this.run('UPDATE undo_records SET undone=1 WHERE id=(SELECT undo_id FROM reverse_proposals WHERE proposal_id=?)', proposal.id)
      this.run('INSERT INTO undo_records VALUES(?,?,?,?,?,?,0)', transactionId, document.id, canonical(before.document),
        canonical(snapshot.document), canonical(inverse), proposal.id)
      this.run('UPDATE window_sessions SET data=? WHERE id=?', canonical({ pendingInput: false,
        acknowledgedRevision: snapshot.document.revision, localOpSeq: parse<{ localOpSeq: number }>(session.data).localOpSeq }), input.windowSessionId)
      this.event(null, this.documentScope(document), 'proposal:read', 'proposal.applied', { proposalId: proposal.id, transactionId, document: snapshot.document })
      return { transactionId, proposalId: proposal.id, snapshot }
    })
  }

  rejectProposal(auth: string, input: AuthorInput & { document: DocumentRef; proposalId: string; proposalDigest: string }) {
    return this.hostCommand(auth, 'proposal:reject', input, { workspaceId: input.document.workspaceId, docId: input.document.docId }, 'proposal:approve', principal => {
      const document = this.requireDocument(principal, input.document, 'proposal:approve')
      this.current(principal, document, input.document.revision)
      const proposal = this.row<ProposalRow>('SELECT * FROM proposals WHERE id=?', input.proposalId)
      if (!proposal || proposal.doc_id !== document.id) denied()
      if (proposal.digest !== input.proposalDigest) throw new ProtocolError('APPROVAL_INVALID', 'The proposal changed.')
      if (!['pending_review', 'stale'].includes(proposal.state)) throw new ProtocolError('REVISION_CONFLICT', 'The proposal is already final.')
      this.run("UPDATE proposals SET state='rejected' WHERE id=?", proposal.id)
      this.event(null, this.documentScope(document), 'proposal:read', 'proposal.rejected', { proposalId: proposal.id })
      return { proposalId: proposal.id, state: 'rejected' }
    })
  }

  undoProposal(auth: string, input: AuthorInput & WriterToken & { document: DocumentRef; transactionId: string }) {
    return this.hostCommand(auth, 'proposal:undo', input, { workspaceId: input.document.workspaceId, docId: input.document.docId }, 'proposal:approve', principal => {
      const document = this.requireDocument(principal, input.document, 'proposal:approve')
      this.checkLease(principal, document, input)
      this.current(principal, document, input.document.revision)
      const session = this.row<{ data: string }>('SELECT data FROM window_sessions WHERE id=?', input.windowSessionId)!
      if (parse<{ pendingInput: boolean }>(session.data).pendingInput) throw new ProtocolError('EDITOR_BUSY', 'Completed input must be acknowledged before undoing a proposal.')
      const undo = this.row<{ doc_id: string; before_ref: string; after_ref: string; inverse_changes: string; proposal_id: string; undone: number }>('SELECT * FROM undo_records WHERE id=?', input.transactionId)
      if (!undo || undo.doc_id !== document.id) denied()
      const beforeRef = parse<DocumentRef>(undo.before_ref)
      const afterRef = parse<DocumentRef>(undo.after_ref)
      if (undo.undone || afterRef.documentEpoch !== document.epoch) {
        throw new ProtocolError('REVISION_CONFLICT', 'Later edits are preserved. Compare the prior proposal before creating a new reverse proposal.', false,
          { current: this.documentRef(document), comparison: { before: beforeRef, after: afterRef } })
      }
      const current = this.snapshot(document)
      if (afterRef.revision !== document.revision) {
        const existing = this.row<{ proposal_id: string }>('SELECT proposal_id FROM reverse_proposals WHERE undo_id=?', input.transactionId)
        if (existing) {
          const proposal = this.row<ProposalRow>('SELECT * FROM proposals WHERE id=?', existing.proposal_id)!
          if (proposal.state === 'pending_review' && proposal.base_revision === document.revision) {
            return { state: 'pending_review', reverseProposal: this.proposalView(proposal), document: current.document }
          }
          // An earlier reverse proposal went stale or was declined; the next one compares against the current text.
        }
        try {
          const after = this.snapshot(document, afterRef.revision)
          const operations = suggestReverseOperations(after, current, parse<TextChange[]>(undo.inverse_changes))
          const suggestion = this.createProposal(principal, current, operations, 'Reverse the earlier proposal while retaining later independent edits.',
            [{ uri: `urn:marktext:proposal:${undo.proposal_id}` }], document.workflow_id ?? undefined, 'recovery')
          this.run('INSERT INTO reverse_proposals VALUES(?,?) ON CONFLICT(undo_id) DO UPDATE SET proposal_id=excluded.proposal_id',
            input.transactionId, suggestion.proposalId)
          return { state: 'pending_review', reverseProposal: suggestion, document: current.document }
        } catch (error) {
          if (error instanceof ProtocolError && error.code === 'REVISION_CONFLICT') {
            throw new ProtocolError(error.code, error.message, false,
              { current: current.document, comparison: { before: beforeRef, after: afterRef } })
          }
          throw error
        }
      }
      const markdown = applyTextChanges(current.markdown, parse<TextChange[]>(undo.inverse_changes), 'recovery')
      const before = this.snapshot(document, beforeRef.revision)
      if (markdown !== before.markdown) throw new ProtocolError('RECOVERY_REQUIRED', 'The undo source does not match its recorded transaction.')
      const snapshot = this.commitSnapshot(document, before.rawText)
      this.run('UPDATE undo_records SET undone=1 WHERE id=?', input.transactionId)
      this.event(null, this.documentScope(document), 'proposal:read', 'proposal.undone', { transactionId: input.transactionId, document: snapshot.document })
      return { transactionId: randomUUID(), undoneTransactionId: input.transactionId, snapshot }
    })
  }

  /** The author's handle on the latest acceptance of a proposal that has not been undone. */
  undoTransaction(auth: string, document: DocumentRef, proposalId: string) {
    const principal = this.author(auth, 'proposal:approve', { workspaceId: document.workspaceId, docId: document.docId })
    this.requireDocument(principal, document, 'proposal:approve')
    const undo = this.row<{ id: string }>('SELECT id FROM undo_records WHERE doc_id=? AND proposal_id=? AND undone=0 ORDER BY rowid DESC LIMIT 1',
      document.docId, proposalId)
    if (!undo) throw new ProtocolError('REVISION_CONFLICT', 'This acceptance has already been undone, or the proposal was never accepted.')
    return undo.id
  }

  beginSave(auth: string, input: AuthorInput & WriterToken & { document: DocumentRef; bindingId: string; unattended?: boolean }) {
    return this.hostCommand(auth, 'save:begin', input, { workspaceId: input.document.workspaceId, docId: input.document.docId }, 'document:save', principal => {
      const document = this.requireDocument(principal, input.document, 'document:save')
      this.current(principal, document, input.document.revision)
      this.checkLease(principal, document, input)
      const stored = this.row<{ doc_id: string; data: string }>('SELECT * FROM resource_bindings WHERE id=?', input.bindingId)
      if (!stored || stored.doc_id !== document.id || document.binding_id !== input.bindingId) denied()
      const binding = parse<ResourceBindingInput & { ownerSession?: string }>(stored.data)
      if (binding.needsReauthorization) throw new ProtocolError('RESOURCE_UNAVAILABLE', 'The save target needs authorization from a live window.')
      if (binding.kind === 'handle' && (input.unattended || binding.ownerSession !== input.windowSessionId)) {
        throw new ProtocolError('RESOURCE_UNAVAILABLE', 'Best-effort file handles require the owning, active author window.')
      }
      const snapshot = this.snapshot(document)
      const activeSave = this.row('SELECT id FROM save_outbox WHERE binding_id=? AND state NOT IN (?,?)', input.bindingId, 'succeeded', 'failed')
      if (activeSave) throw new ProtocolError('WRITER_BUSY', 'Reconcile the previous external save before writing this binding again.')
      const before = document.saved_revision !== null ? this.snapshot(document, document.saved_revision) : undefined
      const saveId = randomUUID()
      const taskId = randomUUID()
      this.run('INSERT INTO tasks(id,principal_id,credential_hash,request_id,request,scope,action,state,cancel_requested,result,error,created_at,updated_at,progress) VALUES(?,?,?,?,?,?,?,?,0,NULL,NULL,?,?,NULL)', saveId, principal.id, digest(auth), `${input.requestId}:file`,
        canonical({ capability: 'author.save', document: snapshot.document }), canonical(this.documentScope(document)), 'document:save', 'committing', this.now(), this.now())
      this.run('UPDATE tasks SET id=? WHERE id=?', taskId, saveId)
      this.run('INSERT INTO save_outbox VALUES(?,?,?,?,?,?,?,?,?,NULL)', saveId, taskId, document.id, document.epoch,
        document.revision, input.bindingId, 'awaiting_file_port', before ? digest(before.rawText) : null, digest(snapshot.rawText))
      return { saveId, taskId, document: snapshot.document, binding, rawText: snapshot.rawText }
    })
  }

  finishSave(auth: string, input: AuthorInput & WriterToken & { document: DocumentRef; saveId: string; observedRawText?: string; resourceVersion?: string; inPlace?: boolean; outcome: 'saved' | 'conflict' | 'unknown' | 'reauthorize' | 'cancelled' }) {
    return this.hostCommand(auth, 'save:finish', input, { workspaceId: input.document.workspaceId, docId: input.document.docId }, 'document:save', principal => {
      const document = this.requireDocument(principal, input.document, 'document:save')
      this.checkLease(principal, document, input)
      const save = this.row<SaveRow>('SELECT * FROM save_outbox WHERE id=?', input.saveId)
      if (!save || save.doc_id !== document.id || save.epoch !== input.document.documentEpoch) denied()
      if (save.state === 'succeeded' || save.state === 'failed') return parse<unknown>(save.result!)
      const observed = input.observedRawText === undefined ? undefined : digest(input.observedRawText)
      const succeeded = input.outcome === 'saved' && observed === save.after_digest
      const code = succeeded ? undefined : input.outcome === 'cancelled' ? 'SAVE_CANCELLED'
        : input.outcome === 'reauthorize' ? 'RESOURCE_UNAVAILABLE'
          : input.outcome === 'conflict' || (observed !== undefined && observed !== save.before_digest && observed !== save.after_digest)
            ? 'SAVE_CONFLICT' : 'SAVE_OUTCOME_UNKNOWN'
      const state = succeeded ? 'succeeded' : (code === 'SAVE_CONFLICT' || code === 'SAVE_CANCELLED') ? 'failed' : 'recovering'
      const taskState = code === 'SAVE_CANCELLED' ? 'cancelled' : state
      const result = { saveId: save.id, taskId: save.task_id, state, saved: succeeded,
        document: { ...this.documentRef(document), revision: save.revision }, inPlace: !!input.inPlace,
        consistency: input.inPlace ? 'in-place' : 'file-port-reported', ...(code ? { code } : {}) }
      this.run('UPDATE save_outbox SET state=?,result=? WHERE id=?', state, canonical(result), save.id)
      this.run('UPDATE tasks SET state=?,result=?,error=?,updated_at=? WHERE id=?', taskState, succeeded ? canonical(result) : null,
        code && code !== 'SAVE_CANCELLED' ? canonical({ code, message: 'The external save needs verification or renewed authorization.', retryable: false }) : null,
        this.now(), save.task_id)
      if (succeeded) {
        if (document.binding_id === save.binding_id) this.run('UPDATE documents SET saved_revision=? WHERE id=?', save.revision, document.id)
        const stored = this.row<{ data: string }>('SELECT data FROM resource_bindings WHERE id=?', save.binding_id)!
        const binding = parse<ResourceBindingInput>(stored.data)
        this.run('UPDATE resource_bindings SET data=? WHERE id=?', canonical({ ...binding, resourceVersion: input.resourceVersion,
          needsReauthorization: false }), save.binding_id)
      }
      this.event(principal.id, this.documentScope(document), 'document:save', 'save.completed', { saveId: save.id, taskId: save.task_id, state })
      return result
    })
  }

  getPendingSaves(auth: string, document: DocumentRef) {
    const principal = this.author(auth, 'document:save', { workspaceId: document.workspaceId, docId: document.docId })
    this.requireDocument(principal, document, 'document:save')
    return this.rows<SaveRow>("SELECT * FROM save_outbox WHERE doc_id=? AND state NOT IN ('succeeded','failed')", document.docId)
      .map(save => ({ saveId: save.id, taskId: save.task_id, document: { ...document, revision: save.revision }, bindingId: save.binding_id, state: save.state }))
  }

  private hostCommand<T>(auth: string, command: string, input: AuthorInput, scope: ResourceScope, action: string, operation: (principal: Principal) => T): T {
    if (!input.requestId || typeof input.requestId !== 'string') invalid('A requestId is required.')
    const { binding, payloadDigest } = hostApprovalBinding(command, input as unknown as Record<string, unknown>, scope, action)
    return this.atomic(() => {
      const principal = this.author(auth, action, scope)
      const old = this.row<IdempotencyRow>('SELECT * FROM idempotency_records WHERE principal_id=? AND request_id=?', principal.id, input.requestId)
      if (old) {
        if (old.digest !== payloadDigest || !old.result) throw new ProtocolError('IDEMPOTENCY_MISMATCH', 'This requestId belongs to another command.')
        return parse<T>(old.result)
      }
      this.consumeApproval(input.ticket, binding, principal.id)
      const result = operation(principal)
      const taskId = randomUUID()
      this.run('INSERT INTO tasks(id,principal_id,credential_hash,request_id,request,scope,action,state,cancel_requested,result,error,created_at,updated_at,progress) VALUES(?,?,?,?,?,?,?,?,0,?,NULL,?,?,NULL)', taskId, principal.id, digest(auth), input.requestId,
        canonical({ capability: `author.${command}` }), canonical(scope), action, 'succeeded', canonical(result), this.now(), this.now())
      this.run('INSERT INTO idempotency_records VALUES(?,?,?,?,?)', principal.id, input.requestId, payloadDigest, taskId, canonical(result))
      this.event(principal.id, scope, action, `author.${command}`, { taskId })
      return result
    })
  }
}
