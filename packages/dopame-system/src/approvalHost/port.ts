import { randomUUID } from 'node:crypto'
import { canonical, opaqueSecret, type ApprovalBinding, type ApprovalEvidence, type ApprovalPort } from '../auth'

/**
 * DEVELOPMENT ONLY. Approves whatever the author's editor window submits. It cannot tell a person from
 * software driving that window, so its evidence is not the protected human approval SP-02 requires.
 */
export class DevelopmentApprovalPort implements ApprovalPort {
  readonly mode = 'development-desktop-host'
  private readonly principalId: string
  private readonly now: () => number
  private readonly minted = new Map<string, ApprovalEvidence>()

  constructor(principalId: string, now: () => number = Date.now) {
    this.principalId = principalId
    this.now = now
  }

  /** Tickets stay inside the state process and are bound to one exact command payload. */
  mint(binding: ApprovalBinding, lifetimeMs = 30_000) {
    for (const [ticket, evidence] of this.minted) {
      if (Date.parse(evidence.expiresAt) <= this.now()) this.minted.delete(ticket)
    }
    const ticket = opaqueSecret()
    this.minted.set(ticket, { ticketId: randomUUID(), principalId: this.principalId, binding,
      expiresAt: new Date(this.now() + lifetimeMs).toISOString(), policyVersion: 'development-desktop-host/1' })
    return ticket
  }

  verify(ticket: string, expected: ApprovalBinding) {
    const evidence = this.minted.get(ticket)
    return evidence && canonical(evidence.binding) === canonical(expected) ? evidence : null
  }
}
