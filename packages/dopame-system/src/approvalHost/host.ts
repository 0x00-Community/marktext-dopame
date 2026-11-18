import { randomUUID } from 'node:crypto'
import { ProtocolError, type DocumentRef } from '../../../dopame/src/domain/collaboration'
import { digest, hostApprovalBinding, type ResourceScope } from '../auth'
import type { Coordinator } from '../coordinator'
import type { AuditMetadata } from '../protocol'
import type { DevelopmentApprovalPort } from './port'

export const HOST_COMMANDS = [
  'pairings.list', 'pairings.approve', 'pairings.reject',
  'principals.list', 'principals.revoke', 'grants.revoke',
  'inbox.list', 'inbox.read',
  'documents.open', 'documents.adopt', 'documents.commit', 'documents.windowState',
  'documents.saveBegin', 'documents.saveFinish', 'documents.pendingSaves', 'documents.saved',
  'documents.recoveryDrafts',
  'writer.status', 'writer.takeover', 'writer.release',
  'proposals.list', 'proposals.get', 'proposals.accept', 'proposals.reject', 'proposals.undo',
  'tasks.list', 'tasks.resolveInquiry',
  'writing.status', 'writing.start', 'writing.task', 'writing.cancel',
] as const
export type HostCommand = typeof HOST_COMMANDS[number]

/** Author-only actions (approve, commit, save, manage grants/writers) can never be granted to a paired caller. */
export const GRANTABLE_ACTIONS = [
  'document:read', 'document:create', 'proposal:create', 'proposal:read',
  'task:read', 'task:report_progress', 'audit:review',
  'artifact:export', 'artifact:read', 'artifact:share', 'artifact:materialize',
  'writing:generate',
] as const

const SESSION_MS = 24 * 60 * 60_000
const MAX_GRANT_MINUTES = 12 * 60
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/

function invalid(message: string): never { throw new ProtocolError('INVALID_ARGUMENT', message) }
function record(value: unknown, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected a command input object.')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !keys.includes(key))) invalid('Unknown approval host input field.')
  return input
}
function id(value: unknown) {
  if (typeof value !== 'string' || !identifier.test(value)) invalid('Invalid identifier.')
  return value
}

/** Turns one explicit action in the author's editor into one approved author command. */
export function createApprovalHost(coordinator: Coordinator, port: DevelopmentApprovalPort, options: { workspaceId: string; now?: () => number }) {
  const { workspaceId } = options
  const now = options.now ?? Date.now
  const scope: ResourceScope = { workspaceId }
  let session: { credential: string; expiresAt: string } | undefined

  // Grants cannot outlive the author session that issues them, so it is renewed well before that bound.
  function credential() {
    if (!session || Date.parse(session.expiresAt) - now() < (MAX_GRANT_MINUTES + 60) * 60_000) {
      const binding = { action: 'author:connect', workspaceId, targetId: workspaceId, digest: digest({ workspaceId }), sideEffects: ['author-session'] }
      session = coordinator.connectAuthor(port.mint(binding, SESSION_MS), workspaceId)
    }
    return session.credential
  }
  function approved<T extends object>(command: string, input: T, target: ResourceScope = scope, action = 'grant:manage') {
    const value = { requestId: randomUUID(), ...input }
    const { binding } = hostApprovalBinding(command, value, target, action)
    return { ...value, ticket: port.mint(binding) }
  }

  // The author's editor is the single writer. Leases are short, so one is renewed or re-acquired
  // before each write; a lease lost to anyone else surfaces as LEASE_LOST or a revision conflict.
  const defaultWindowSessionId: string = randomUUID()
  const leases = new Map<string, { windowSessionId: string; writerFence: string; serviceEpoch: string }>()
  let localOpSeq = 0
  function sessionKey(docId: string, windowSessionId: string) {
    return `${windowSessionId}:${docId}`
  }
  function resolveSessionId(value: unknown): string {
    return value === undefined ? defaultWindowSessionId : id(value)
  }
  function reference(value: unknown): DocumentRef {
    const input = record(value, ['workspaceId', 'docId', 'documentEpoch', 'revision'])
    if (input.workspaceId !== workspaceId || typeof input.revision !== 'string' || !/^(0|[1-9][0-9]*)$/.test(input.revision)) invalid('Invalid document reference.')
    return { workspaceId, docId: id(input.docId), documentEpoch: id(input.documentEpoch), revision: input.revision }
  }
  function writer(document: DocumentRef, windowSessionId: string = defaultWindowSessionId) {
    const target = { workspaceId, docId: document.docId }
    const key = sessionKey(document.docId, windowSessionId)
    const held = leases.get(key)
    if (held) {
      try {
        coordinator.renewWriter(credential(), { document, ...held })
        return { ...held }
      } catch { leases.delete(key) }
    }
    const lease = coordinator.acquireWriter(credential(), approved('writer:acquire', { document, windowSessionId }, target, 'writer:manage'))
    const token = { windowSessionId, writerFence: lease.writerFence, serviceEpoch: lease.serviceEpoch }
    leases.set(key, token)
    return { ...token }
  }
  function digestOf(value: unknown) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) invalid('Invalid proposal digest.')
    return value
  }
  // One binding per document and save target, so repeated saves to one file reuse it.
  const bindings = new Map<string, { key: string; bindingId: string }>()
  function ensureBinding(document: DocumentRef, lease: { windowSessionId: string; writerFence: string; serviceEpoch: string }, kind: 'root' | 'handle', resourceKey: string, resourceVersion?: string) {
    const target = { workspaceId, docId: document.docId }
    const cached = bindings.get(document.docId)
    if (cached && cached.key === resourceKey) return cached.bindingId
    const bound = coordinator.bindResource(credential(), approved('resource:bind', {
      document,
      ...lease,
      binding: {
        kind,
        ...(resourceVersion !== undefined ? { resourceVersion } : {}),
        consistency: kind === 'root' ? 'conditional-write' : 'best-effort',
        needsReauthorization: false,
      },
    }, target, 'document:save'))
    bindings.set(document.docId, { key: resourceKey, bindingId: bound.bindingId })
    return bound.bindingId
  }
  function entry(docId: string) {
    const listed = read('documents.list', { workspaceId, limit: 200 }) as { documents: Array<{ document: DocumentRef; title: string; inbox: boolean; audit?: AuditMetadata }> }
    const found = listed.documents.find(item => item.document.docId === docId)
    if (!found) invalid('This document is not in the workspace.')
    return found
  }

  function read(capability: string, input: unknown) {
    // The module polls every few seconds; these reads must not accumulate idempotency records.
    return coordinator.invoke(credential(), { protocol: 'marktext-documents/1', requestId: randomUUID(), capabilityVersion: 1, capability, input }, { ephemeral: true })
  }

  return {
    workspaceId,
    command(name: unknown, value: unknown): unknown {
      if (!HOST_COMMANDS.includes(name as HostCommand)) invalid('Unsupported approval host command.')
      switch (name as HostCommand) {
        case 'pairings.list':
          record(value ?? {}, [])
          return { workspaceId, pairings: coordinator.listPairings(credential(), workspaceId) }
        case 'inbox.list': {
          record(value ?? {}, [])
          const listed = read('documents.list', { workspaceId, inbox: true, limit: 200 }) as { documents: unknown[] }
          return { workspaceId, drafts: listed.documents }
        }
        case 'inbox.read': {
          // The author reads its own workspace; unverified or quarantined drafts are blocked from opening.
          const input = record(value, ['docId'])
          const docId = id(input.docId)
          const listed = read('documents.list', { workspaceId, inbox: true, limit: 200 }) as { documents: Array<{ document: { docId: string }; audit?: AuditMetadata }> }
          const found = listed.documents.find(item => item.document.docId === docId)
          if (!found) invalid('This draft is not in the inbox.')
          if (found.audit && found.audit.status !== 'verified') {
            throw new ProtocolError('AUDIT_NOT_PASSED', 'This draft has not passed audit verification or is quarantined.', false, { audit: found.audit })
          }
          return read('documents.read', { document: found.document })
        }
        case 'documents.open': {
          // Binds the editor to the canonical document; unverified or quarantined drafts cannot be promoted.
          const input = record(value, ['docId'])
          const found = entry(id(input.docId))
          if (found.audit && found.audit.status !== 'verified') {
            throw new ProtocolError('AUDIT_NOT_PASSED', 'This document has not passed audit verification or is quarantined.', false, { audit: found.audit })
          }
          const current = read('documents.read', { document: found.document }) as { markdown: string; saved: boolean }
          return {
            document: found.document,
            title: found.title,
            inbox: found.inbox,
            markdown: current.markdown,
            saved: current.saved,
            ...(found.audit ? { audit: found.audit } : {}),
          }
        }
        case 'documents.adopt': {
          const input = record(value, ['title', 'markdown'])
          if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 240 || typeof input.markdown !== 'string') invalid('A title and Markdown text are required.')
          const imported = coordinator.importDocument(credential(), approved('document:import',
            { workspaceId, title: input.title, rawText: input.markdown }, scope, 'document:commit'))
          return { document: imported.snapshot.document, title: input.title, inbox: false, markdown: imported.snapshot.markdown, saved: false }
        }
        case 'documents.commit': {
          const input = record(value, ['document', 'markdown', 'windowSessionId', 'localOpSeq'])
          const document = reference(input.document)
          if (typeof input.markdown !== 'string') invalid('Markdown text is required.')
          const windowSessionId = resolveSessionId(input.windowSessionId)
          const seq = input.localOpSeq === undefined ? ++localOpSeq : input.localOpSeq
          if (!Number.isSafeInteger(seq) || (seq as number) < 0) invalid('Invalid local operation sequence.')
          const target = { workspaceId, docId: document.docId }
          const committed = coordinator.commitDocument(credential(), approved('document:commit',
            { document, ...writer(document, windowSessionId), markdown: input.markdown, localOpSeq: seq as number }, target, 'document:commit'))
          return { document: committed.snapshot.document, localOpSeq: committed.localOpSeq }
        }
        case 'documents.windowState': {
          const input = record(value, ['document', 'pendingInput', 'localOpSeq', 'windowSessionId'])
          const document = reference(input.document)
          if (typeof input.pendingInput !== 'boolean') invalid('pendingInput boolean is required.')
          const seq = input.localOpSeq === undefined ? ++localOpSeq : input.localOpSeq
          if (!Number.isSafeInteger(seq) || (seq as number) < 0) invalid('Invalid local operation sequence.')
          const windowSessionId = resolveSessionId(input.windowSessionId)
          return coordinator.updateWindowState(credential(), {
            document,
            ...writer(document, windowSessionId),
            localOpSeq: seq as number,
            pendingInput: input.pendingInput,
          })
        }
        case 'writer.status': {
          const input = record(value, ['document', 'windowSessionId'])
          const document = reference(input.document)
          const windowSessionId = resolveSessionId(input.windowSessionId)
          return coordinator.getWriterStatus(credential(), document, windowSessionId)
        }
        case 'writer.takeover': {
          const input = record(value, ['document', 'windowSessionId'])
          const document = reference(input.document)
          const windowSessionId = resolveSessionId(input.windowSessionId)
          const target = { workspaceId, docId: document.docId }
          const acquired = coordinator.takeoverWriter(credential(), approved('writer:takeover', { document, windowSessionId }, target, 'writer:manage'))
          leases.set(sessionKey(document.docId, windowSessionId), {
            windowSessionId,
            writerFence: acquired.writerFence,
            serviceEpoch: acquired.serviceEpoch,
          })
          return acquired
        }
        case 'writer.release': {
          const input = record(value, ['document', 'windowSessionId'])
          const document = reference(input.document)
          const windowSessionId = resolveSessionId(input.windowSessionId)
          const key = sessionKey(document.docId, windowSessionId)
          const held = leases.get(key)
          if (!held) return { released: true }
          const released = coordinator.releaseWriter(credential(), { document, ...held })
          leases.delete(key)
          return released
        }
        case 'documents.recoveryDrafts': {
          const input = record(value, ['document'])
          return { drafts: coordinator.getRecoveryDrafts(credential(), reference(input.document)) }
        }
        case 'proposals.accept': {
          // Accepting is one transaction against the exact revision and proposal content the author reviewed.
          const input = record(value, ['document', 'proposalId', 'proposalDigest', 'windowSessionId'])
          const document = reference(input.document)
          const windowSessionId = resolveSessionId(input.windowSessionId)
          const target = { workspaceId, docId: document.docId }
          const accepted = coordinator.acceptProposal(credential(), approved('proposal:accept', { document, ...writer(document, windowSessionId),
            proposalId: id(input.proposalId), proposalDigest: digestOf(input.proposalDigest) }, target, 'proposal:approve'))
          return { transactionId: accepted.transactionId, document: accepted.snapshot.document, markdown: accepted.snapshot.markdown }
        }
        case 'proposals.reject': {
          const input = record(value, ['document', 'proposalId', 'proposalDigest'])
          const document = reference(input.document)
          return coordinator.rejectProposal(credential(), approved('proposal:reject', { document,
            proposalId: id(input.proposalId), proposalDigest: digestOf(input.proposalDigest) }, { workspaceId, docId: document.docId }, 'proposal:approve'))
        }
        case 'proposals.undo': {
          // Undoes only that acceptance. If the author has edited since, the service proposes the reverse instead.
          const input = record(value, ['document', 'proposalId', 'windowSessionId'])
          const document = reference(input.document)
          const windowSessionId = resolveSessionId(input.windowSessionId)
          const transactionId = coordinator.undoTransaction(credential(), document, id(input.proposalId))
          const undone = coordinator.undoProposal(credential(), approved('proposal:undo', { document, ...writer(document, windowSessionId), transactionId },
            { workspaceId, docId: document.docId }, 'proposal:approve'))
          if ('snapshot' in undone && undone.snapshot) return { state: 'undone', document: undone.snapshot.document, markdown: undone.snapshot.markdown }
          return { state: 'reverse_proposal', proposalId: undone.reverseProposal.proposalId, document: undone.document }
        }
        case 'documents.saveBegin': {
          const input = record(value, ['document', 'target', 'resourceKey', 'resourceVersion', 'windowSessionId'])
          const document = reference(input.document)
          if (input.target !== 'root' && input.target !== 'handle') invalid('Invalid save target.')
          if (typeof input.resourceKey !== 'string' || !input.resourceKey || input.resourceKey.length > 512) invalid('Invalid save target.')
          if (input.resourceVersion !== undefined && typeof input.resourceVersion !== 'string') invalid('Invalid resource version.')
          const windowSessionId = resolveSessionId(input.windowSessionId)
          const lease = writer(document, windowSessionId)
          const bindingId = ensureBinding(document, lease, input.target, input.resourceKey, input.resourceVersion)
          const target = { workspaceId, docId: document.docId }
          const begun = coordinator.beginSave(credential(), approved('save:begin', { document, ...lease, bindingId }, target, 'document:save'))
          return { saveId: begun.saveId, taskId: begun.taskId, document: begun.document }
        }
        case 'documents.saveFinish': {
          const input = record(value, ['document', 'saveId', 'outcome', 'observedRawText', 'resourceVersion', 'inPlace', 'windowSessionId'])
          const document = reference(input.document)
          const saveId = id(input.saveId)
          if (!['saved', 'conflict', 'unknown', 'reauthorize', 'cancelled'].includes(String(input.outcome))) invalid('Invalid save outcome.')
          if (input.observedRawText !== undefined && typeof input.observedRawText !== 'string') invalid('Invalid observed save text.')
          if (input.resourceVersion !== undefined && typeof input.resourceVersion !== 'string') invalid('Invalid resource version.')
          if (input.inPlace !== undefined && typeof input.inPlace !== 'boolean') invalid('Invalid inPlace flag.')
          const windowSessionId = resolveSessionId(input.windowSessionId)
          const lease = writer(document, windowSessionId)
          const target = { workspaceId, docId: document.docId }
          const finished = coordinator.finishSave(credential(), approved('save:finish', {
            document,
            ...lease,
            saveId,
            outcome: input.outcome as 'saved' | 'conflict' | 'unknown' | 'reauthorize' | 'cancelled',
            ...(input.observedRawText !== undefined ? { observedRawText: input.observedRawText } : {}),
            ...(input.resourceVersion !== undefined ? { resourceVersion: input.resourceVersion } : {}),
            ...(input.inPlace !== undefined ? { inPlace: input.inPlace } : {}),
          }, target, 'document:save')) as { saved: boolean; state: string; document: DocumentRef; code?: string }
          return { saved: finished.saved, state: finished.state, document: finished.document, ...(finished.code ? { code: finished.code } : {}) }
        }
        case 'documents.pendingSaves': {
          const input = record(value, ['document'])
          return { pendingSaves: coordinator.getPendingSaves(credential(), reference(input.document)) }
        }
        case 'documents.saved': {
          // Compatibility helper: records both save intent and completion in sequence.
          const input = record(value, ['document', 'text', 'target', 'resourceKey', 'windowSessionId'])
          const document = reference(input.document)
          if (typeof input.text !== 'string') invalid('The saved text is required.')
          if (input.target !== 'root' && input.target !== 'handle') invalid('Invalid save target.')
          if (typeof input.resourceKey !== 'string' || !input.resourceKey || input.resourceKey.length > 512) invalid('Invalid save target.')
          const windowSessionId = resolveSessionId(input.windowSessionId)
          const target = { workspaceId, docId: document.docId }
          const lease = writer(document, windowSessionId)
          const bindingId = ensureBinding(document, lease, input.target, input.resourceKey)
          const begun = coordinator.beginSave(credential(), approved('save:begin', { document, ...lease, bindingId }, target, 'document:save'))
          const finished = coordinator.finishSave(credential(), approved('save:finish', { document, ...lease, saveId: begun.saveId,
            outcome: 'saved', observedRawText: input.text }, target, 'document:save')) as { saved: boolean; document: DocumentRef; code?: string }
          return { saved: finished.saved, document: finished.document, ...(finished.code ? { code: finished.code } : {}) }
        }
        case 'proposals.list': {
          const input = record(value, ['document'])
          return read('proposals.list', { document: reference(input.document) })
        }
        case 'proposals.get': {
          const input = record(value, ['proposalId'])
          return read('proposals.get', { proposalId: id(input.proposalId) })
        }
        case 'tasks.list': {
          record(value ?? {}, [])
          return { workspaceId, tasks: coordinator.listWorkspaceTasks(credential(), workspaceId) }
        }
        case 'tasks.resolveInquiry': {
          const input = record(value, ['taskId', 'optionId'])
          return coordinator.resolveTaskInquiry(credential(), approved('task:resolveInquiry', {
            workspaceId,
            taskId: id(input.taskId),
            optionId: id(input.optionId),
          }))
        }
        case 'writing.status': {
          record(value ?? {}, [])
          const desc = coordinator.describe(credential()) as {
            integrations?: { writingGenerate?: { available: boolean; reason?: string; models?: string[] } }
          }
          const wg = desc.integrations?.writingGenerate
          return {
            available: Boolean(wg?.available),
            ...(wg?.reason ? { reason: wg.reason } : {}),
            models: Array.isArray(wg?.models) ? wg.models : [],
          }
        }
        case 'writing.start': {
          const input = record(value, ['purpose', 'document', 'range', 'modelId', 'instruction'])
          if (!['polish', 'continue', 'summarize'].includes(String(input.purpose))) invalid('Invalid writing purpose.')
          const document = reference(input.document)
          const rangeObj = record(input.range, ['start', 'end'])
          if (!Number.isSafeInteger(rangeObj.start) || !Number.isSafeInteger(rangeObj.end)) invalid('Invalid source range.')
          const modelId = id(input.modelId)
          if (input.instruction !== undefined && (typeof input.instruction !== 'string' || !input.instruction.trim() || input.instruction.length > 1024)) {
            invalid('Invalid generation instruction.')
          }
          return coordinator.invoke(credential(), {
            protocol: 'marktext-documents/1',
            requestId: randomUUID(),
            capabilityVersion: 1,
            capability: 'writing.generate',
            input: {
              purpose: input.purpose,
              document,
              range: { start: rangeObj.start, end: rangeObj.end },
              modelId,
              ...(input.instruction ? { instruction: input.instruction.trim() } : {}),
            },
          })
        }
        case 'writing.task': {
          const input = record(value, ['taskId'])
          return coordinator.getTask(credential(), id(input.taskId))
        }
        case 'writing.cancel': {
          const input = record(value, ['taskId'])
          return coordinator.cancelTask(credential(), id(input.taskId))
        }
        case 'principals.list':
          record(value ?? {}, [])
          return { workspaceId, principals: coordinator.listPrincipals(credential(), workspaceId) }
        case 'pairings.reject': {
          const input = record(value, ['pairingId'])
          return coordinator.rejectPairing(credential(), approved('pairing:reject', { pairingId: id(input.pairingId), workspaceId }))
        }
        case 'principals.revoke': {
          const input = record(value, ['principalId'])
          return coordinator.revokePrincipal(credential(), approved('principal:revoke', { principalId: id(input.principalId), workspaceId }))
        }
        case 'grants.revoke': {
          const input = record(value, ['grantId'])
          return coordinator.revokeGrant(credential(), approved('grant:revoke', { grantId: id(input.grantId), workspaceId }))
        }
        case 'pairings.approve': {
          const input = record(value, ['pairingId', 'grants'])
          if (!Array.isArray(input.grants) || !input.grants.length || input.grants.length > 8) invalid('Between one and eight grants are required.')
          const session = credential()
          const grants = input.grants.map(item => {
            const grant = record(item, ['actions', 'workflowId', 'docId', 'expiresInMinutes', 'allowHandoff', 'allowedBlockIds', 'maxAuditRetries', 'requireAudit'])
            const actions = grant.actions
            if (!Array.isArray(actions) || !actions.length || new Set(actions).size !== actions.length
              || actions.some(action => !GRANTABLE_ACTIONS.includes(action as typeof GRANTABLE_ACTIONS[number]))) invalid('A grant may only list distinct caller actions.')
            const minutes = grant.expiresInMinutes
            if (!Number.isSafeInteger(minutes) || (minutes as number) < 1 || (minutes as number) > MAX_GRANT_MINUTES) invalid('Invalid grant lifetime.')
            if (grant.allowHandoff !== undefined && typeof grant.allowHandoff !== 'boolean') invalid('Invalid handoff permission.')
            if (grant.requireAudit !== undefined && typeof grant.requireAudit !== 'boolean') invalid('Invalid requireAudit flag.')
            if (grant.allowedBlockIds !== undefined) {
              if (!Array.isArray(grant.allowedBlockIds) || !grant.allowedBlockIds.length || grant.allowedBlockIds.length > 64) {
                invalid('allowedBlockIds must contain between 1 and 64 block identifiers.')
              }
              for (const blockId of grant.allowedBlockIds) id(blockId)
            }
            if (grant.maxAuditRetries !== undefined && (!Number.isSafeInteger(grant.maxAuditRetries) || (grant.maxAuditRetries as number) < 1 || (grant.maxAuditRetries as number) > 10)) {
              invalid('maxAuditRetries must be an integer between 1 and 10.')
            }
            return {
              scope: {
                workspaceId,
                ...(grant.workflowId === undefined ? {} : { workflowId: id(grant.workflowId) }),
                ...(grant.docId === undefined ? {} : { docId: id(grant.docId) }),
                ...(grant.allowedBlockIds === undefined ? {} : { allowedBlockIds: grant.allowedBlockIds as string[] }),
                ...(grant.maxAuditRetries === undefined ? {} : { maxAuditRetries: grant.maxAuditRetries as number }),
                ...(grant.requireAudit === undefined ? {} : { requireAudit: grant.requireAudit }),
              },
              actions: actions as string[],
              expiresAt: new Date(now() + (minutes as number) * 60_000).toISOString(),
              // Delegation is what lets a caller hand an artifact to another caller.
              delegationDepth: grant.allowHandoff === true && actions.includes('artifact:share') ? 1 : 0,
            }
          })
          return coordinator.approvePairing(session, approved('pairing:approve', { pairingId: id(input.pairingId), grants }))
        }
      }
    },
  }
}
