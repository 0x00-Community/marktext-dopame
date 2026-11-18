// DEVELOPMENT APPROVAL HOST. Registered only by the approval development desktop.
import type { ServiceFactory } from '@dopame/acde-api'
import type { DocumentsService } from '../src/agentClient'
import { failure } from '../src/transport'
import { documentsApi, WorkerBridge } from './marktextdocs'

export interface ApprovalHostService extends DocumentsService {
  attachApprovalHost(): Promise<{ hostToken: string; policy: string }>
  approvalHost(hostToken: string, command: string, input?: unknown): Promise<unknown>
}

const factory: ServiceFactory = ctx => {
  const bridge = new WorkerBridge(ctx, 'approval-host-worker.js', 'development-approval-host')
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const hostToken = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  let attached = false
  let contested = false
  const refused = () => failure('PERMISSION_DENIED', contested
    ? 'Two callers claimed the approval host; it is disabled until the desktop service restarts.'
    : 'The approval host is attached to the author\'s editor window only.')
  // An app that lists this service receives these methods too, and a service cannot identify its
  // caller. The token therefore goes to the first claimant, and a second claim proves that two parties
  // want the host: it is then disabled for everyone until the service restarts. The author's editor
  // claims when it opens, so an app that claimed earlier is shut out, and exposed, at that moment.
  // Until then nothing stops it: the claim state is public so the desktop page can show it.
  // Grants issued in that interval remain and must be reviewed.
  const api: ApprovalHostService = {
    ...documentsApi(bridge),
    status: async() => ({ ...bridge.status(), approvalHost: contested ? 'contested' : attached ? 'claimed' : 'unclaimed' }),
    async attachApprovalHost() {
      if (attached) {
        contested = true
        throw refused()
      }
      attached = true
      return { hostToken, policy: 'development-desktop-host/1' }
    },
    async approvalHost(token, command, input) {
      if (contested || !attached || typeof token !== 'string' || token !== hostToken) throw refused()
      return bridge.call('approvalHost', input === undefined ? [command] : [command, input])
    }
  }
  return { api: { marktextdocs: api }, close: () => bridge.close() }
}

export default factory
