// DEVELOPMENT APPROVAL HOST. This state process is built only into the approval development desktop.
// The production entry is ../worker.ts, which has no approval port and no host method.
import { resolve } from 'node:path'
import { Coordinator } from '../coordinator'
import { createEnvModelPort } from '../modelPort'
import { PUBLIC_METHODS, transportError } from '../transport'
import { dispatchPublic, serve } from '../workerLoop'
import { createApprovalHost } from './host'
import { DevelopmentApprovalPort } from './port'

export const HOST_METHOD = 'approvalHost'
const WORKSPACE = 'local-workspace'

const state = process.argv[2]
if (!state || process.argv.length !== 3) {
  process.stderr.write('Document state directory is required.\n')
  process.exit(1)
}

const port = new DevelopmentApprovalPort('development-desktop-author')
let coordinator: Coordinator
try {
  coordinator = new Coordinator(resolve(state), { approvalPort: port, modelPort: createEnvModelPort(process.env) })
} catch (error) {
  process.stdout.write(JSON.stringify({ type: 'unavailable', error: transportError(error) }) + '\n')
  process.exit(1)
}
const host = createApprovalHost(coordinator, port, { workspaceId: WORKSPACE })

serve(coordinator, [...PUBLIC_METHODS, HOST_METHOD], request => {
  if (request.method !== HOST_METHOD) return dispatchPublic(coordinator, request)
  // Only the desktop service, which checks the host token, can reach this pipe.
  if (request.args.length < 1 || request.args.length > 2) throw Object.assign(new Error('Invalid approval host arguments.'), { code: 'INVALID_ARGUMENT', retryable: false })
  return host.command(request.args[0], request.args[1])
})
