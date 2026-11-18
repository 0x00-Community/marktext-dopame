import { failure } from './transport'

/** The development mode exists only in the approval development desktop; it is not a release mode. */
export type DocumentsServiceMode = 'proposal-preview' | 'development-approval-host'

export interface DocumentsService {
  status(): Promise<{ available: boolean; reason?: string; mode: DocumentsServiceMode; approvalHost?: 'unclaimed' | 'claimed' | 'contested' }>
  describe(auth: string): Promise<unknown>
  invoke(auth: string, request: unknown): Promise<unknown>
  getTask(auth: string, taskId: string): Promise<unknown>
  cancelTask(auth: string, taskId: string): Promise<unknown>
  listEvents(auth: string, cursor?: string, limit?: number): Promise<unknown>
  requestPairing(input: { name: string }): Promise<unknown>
  claimPairing(pairingId: string, claimSecret: string): Promise<unknown>
}

export interface AgentTool {
  name: string
  capability?: string
  description: string
  inputSchema: Record<string, unknown>
  execute(input: unknown): Promise<unknown>
}

export interface OpenAIFunctionTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

const CAPABILITY_DESCRIPTIONS: Record<string, string> = {
  'documents.list': 'List authorized collaborative documents and inbox drafts in the workspace.',
  'documents.read': 'Read a revision-bound Markdown snapshot (or UTF-16 range) of an authorized document.',
  'documents.outline': 'Read the heading outline and block offsets of an authorized document revision.',
  'documents.blocks': 'Read the indexed Markdown blocks (blockId, type, start, end, markdown) of an authorized document revision.',
  'documents.createDraft': 'Deliver an independent Markdown draft to the author inbox without overwriting existing documents.',
  'proposals.create': 'Submit a block-level diff Proposal bound to a specific document revision for author review.',
  'proposals.get': 'Read the details, diff and audit state of a submitted Proposal.',
  'proposals.list': 'List Proposals associated with an authorized document.',
  'proposals.verify': 'Dedicated read-only Auditor capability: verify a draft or Proposal as verified, flagged_drift or quarantined_injection.',
  'tasks.updateProgress': 'Report 4D task progress (currentActivity, completionRate, activeIssues) or a throttled structured inquiry.',
  'artifacts.export': 'Export a fixed revision of an authorized document as an immutable artifact.',
  'artifacts.read': 'Read a byte chunk of an authorized or handed-off immutable artifact.',
  'artifacts.materializeToManagedDir': 'Atomically materialize a verified artifact into the service managed_workspace/ directory without opening a window.',
  'handoffs.create': 'Create a purpose-scoped handoff of a fixed artifact to another paired principal.',
  'handoffs.get': 'Query the status and receipt of an artifact handoff.',
  'handoffs.acknowledge': 'Submit an acceptance or failure receipt for a received artifact handoff.',
  'writing.generate': 'Invoke the system model gateway on an approved UTF-16 selection range to polish, continue or summarize.',
}

function validateTaskIdInput(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 1 || typeof (input as { taskId?: unknown }).taskId !== 'string'
    || !(input as { taskId: string }).taskId || (input as { taskId: string }).taskId.length > 256) {
    throw failure('INVALID_ARGUMENT', 'Expected a taskId.')
  }
  return (input as { taskId: string }).taskId
}

/** Credentials stay in the trusted transport closure; model inputs contain only document requests. */
export function createAgentClient(service: DocumentsService, credential: string) {
  if (!credential || credential.length > 4096) throw failure('UNAUTHENTICATED', 'A paired credential is required.')

  function taskTools(): AgentTool[] {
    return [{
      name: 'marktext_documents_get_task',
      description: 'Query the durable result of an authorized document task.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['taskId'],
        properties: { taskId: { type: 'string', minLength: 1, maxLength: 256 } }
      },
      execute: input => {
        try {
          return service.getTask(credential, validateTaskIdInput(input))
        } catch (err) {
          return Promise.reject(err)
        }
      }
    }, {
      name: 'marktext_documents_cancel_task',
      description: 'Request cancellation of an in-flight durable document task.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['taskId'],
        properties: { taskId: { type: 'string', minLength: 1, maxLength: 256 } }
      },
      execute: input => {
        try {
          return service.cancelTask(credential, validateTaskIdInput(input))
        } catch (err) {
          return Promise.reject(err)
        }
      }
    }]
  }

  function lowLevelTools(requestSchema: Record<string, unknown>): AgentTool[] {
    return [{
      name: 'marktext_documents_invoke',
      description: 'Read an authorized snapshot or submit a draft, proposal or artifact task. This tool cannot approve or save documents.',
      inputSchema: requestSchema,
      execute: request => service.invoke(credential, request)
    }, taskTools()[0]]
  }

  async function discoverTools(): Promise<AgentTool[]> {
    const catalog = await service.describe(credential) as {
      capabilities?: Array<{ id: string; available?: boolean; inputSchema?: Record<string, unknown> }>
    }
    const capabilities = Array.isArray(catalog?.capabilities) ? catalog.capabilities : []
    const discovered: AgentTool[] = []
    for (const cap of capabilities) {
      if (!cap || typeof cap.id !== 'string' || cap.available === false) continue
      const toolName = cap.id.replace(/\./g, '_')
      const schema = (cap.inputSchema && typeof cap.inputSchema === 'object')
        ? cap.inputSchema
        : { type: 'object', additionalProperties: false }
      discovered.push({
        name: toolName,
        capability: cap.id,
        description: CAPABILITY_DESCRIPTIONS[cap.id] ?? `Invoke authorized capability ${cap.id}.`,
        inputSchema: schema,
        execute: (input: unknown) => {
          if (!input || typeof input !== 'object' || Array.isArray(input)) {
            return Promise.reject(failure('INVALID_ARGUMENT', `Expected an object input for ${cap.id}.`))
          }
          const rec = input as Record<string, unknown>
          const requestId = typeof rec.requestId === 'string' && rec.requestId.length > 0
            ? rec.requestId
            : crypto.randomUUID()
          const envelopeExtras: Record<string, unknown> = {}
          for (const key of ['workflowId', 'deadlineAt', 'parentTaskId', 'idempotencyKey'] as const) {
            if (typeof rec[key] === 'string' && rec[key].length > 0) {
              envelopeExtras[key] = rec[key]
            }
          }
          const cleanInput = { ...rec }
          delete cleanInput.requestId
          delete cleanInput.workflowId
          delete cleanInput.deadlineAt
          delete cleanInput.parentTaskId
          delete cleanInput.idempotencyKey
          return service.invoke(credential, {
            protocol: 'marktext-documents/1',
            requestId,
            capabilityVersion: 1,
            capability: cap.id,
            ...envelopeExtras,
            input: cleanInput,
          })
        },
      })
    }
    return [...discovered, ...taskTools()]
  }

  async function openAITools(): Promise<OpenAIFunctionTool[]> {
    const list = await discoverTools()
    return list.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }))
  }

  async function callTool(name: string, args: unknown): Promise<unknown> {
    if (name === 'marktext_documents_invoke') {
      return service.invoke(credential, args)
    }
    for (const t of taskTools()) {
      if (t.name === name) return t.execute(args)
    }
    const list = await discoverTools()
    const normalized = name.replace(/\./g, '_')
    const target = list.find(t => t.name === normalized || t.capability === name)
    if (!target) {
      throw failure('PERMISSION_DENIED', `Tool "${name}" is not available or not authorized for this credential.`)
    }
    return target.execute(args)
  }

  async function waitForTask(
    taskId: string,
    options: { pollMs?: number; timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    const pollMs = options.pollMs ?? 15
    const deadline = Date.now() + (options.timeoutMs ?? 10_000)
    while (Date.now() <= deadline) {
      const task = await service.getTask(credential, taskId) as Record<string, unknown>
      if (['succeeded', 'failed', 'cancelled', 'awaiting_user'].includes(String(task.state))) {
        return task
      }
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
    throw failure('RESULT_NOT_READY', `Task ${taskId} did not settle within timeout.`, true)
  }

  return {
    describe: () => service.describe(credential),
    invoke: (request: unknown) => service.invoke(credential, request),
    getTask: (taskId: string) => service.getTask(credential, taskId),
    cancelTask: (taskId: string) => service.cancelTask(credential, taskId),
    listEvents: (cursor?: string, limit?: number) => service.listEvents(credential, cursor, limit),
    tools: (requestSchema: Record<string, unknown>): AgentTool[] => lowLevelTools(requestSchema),
    discoverTools,
    openAITools,
    callTool,
    waitForTask,
    registration: {
      available: false,
      reason: 'A production system Agent tool registrar and protected approval scope have not been verified.'
    }
  }
}
