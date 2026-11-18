// TEST FIXTURE ONLY. This worker stands in for the trusted approval host so native UI tests can
// obtain credentials. It is never bundled into a package: the production worker has no approval port.
import { resolve } from 'node:path'
import { Coordinator } from '../../src/coordinator'
import type { ApprovalPort } from '../../src/auth'
import { PUBLIC_METHODS } from '../../src/transport'
import { dispatchPublic, serve } from '../../src/workerLoop'

const workspaceId = 'fixture-workspace'
const author = 'fixture-author'
const approvalPort: ApprovalPort = {
  verify: (ticket, binding) => ({ ticketId: ticket, principalId: author, binding,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), policyVersion: 'test-fixture' })
}
const coordinator = new Coordinator(resolve(process.argv[2]), { approvalPort })
const session = coordinator.connectAuthor(crypto.randomUUID(), workspaceId).credential

const agentActions = ['document:read', 'document:create', 'proposal:create', 'proposal:read', 'task:read', 'task:report_progress', 'artifact:export', 'artifact:read', 'artifact:share', 'artifact:materialize']
const auditorActions = ['audit:review', 'document:read', 'proposal:read', 'task:read', 'task:report_progress']

/** A name ending in "#receipt-only" pairs with task access alone; "#auditor" pairs with read-only audit actions. */
function approve(pairingId: string, name: string) {
  const limited = name.endsWith('#receipt-only')
  const isAuditor = name.endsWith('#auditor')
  coordinator.approvePairing(session, {
    requestId: crypto.randomUUID(), ticket: crypto.randomUUID(), pairingId,
    grants: [{ scope: { workspaceId }, delegationDepth: (limited || isAuditor) ? 0 : 1, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      actions: limited ? ['task:read'] : isAuditor ? auditorActions : agentActions }]
  })
}

/** Commits an author edit, the only way a pending proposal becomes stale. */
function authorEdit(docId: string) {
  const listed = coordinator.invoke(session, { protocol: 'marktext-documents/1', requestId: crypto.randomUUID(), capabilityVersion: 1,
    capability: 'documents.list', input: { workspaceId } }) as { documents: Array<{ document: { docId: string; workspaceId: string; documentEpoch: string; revision: string } }> }
  const document = listed.documents.find(item => item.document.docId === docId)?.document
  if (!document) throw Object.assign(new Error('Unknown fixture document.'), { code: 'INVALID_ARGUMENT', retryable: false })
  const lease = coordinator.acquireWriter(session, { requestId: crypto.randomUUID(), ticket: crypto.randomUUID(), document, windowSessionId: crypto.randomUUID() })
  coordinator.commitDocument(session, { requestId: crypto.randomUUID(), ticket: crypto.randomUUID(), document, markdown: 'Author edit by fixture control.\n', localOpSeq: 1,
    windowSessionId: lease.windowSessionId, writerFence: lease.writerFence, serviceEpoch: lease.serviceEpoch })
  return { state: 'edited' }
}

serve(coordinator, PUBLIC_METHODS, request => {
  if (request.method === 'requestPairing') {
    const input = request.args[0] as { name?: unknown }
    // Tests have no author window; this reserved name stands in for one author commit.
    if (typeof input?.name === 'string' && input.name.startsWith('fixture-control:edit:')) return authorEdit(input.name.slice('fixture-control:edit:'.length))
    const pairing = dispatchPublic(coordinator, request) as { pairingId: string }
    approve(pairing.pairingId, input.name as string)
    return pairing
  }
  return dispatchPublic(coordinator, request)
})
