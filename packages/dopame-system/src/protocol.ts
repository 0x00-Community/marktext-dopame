import Ajv from 'ajv'
import { limits, ProtocolError, byteLength } from '../../dopame/src/domain/collaboration'

export interface AuditMetadata {
  status: 'pending_audit' | 'verified' | 'flagged_drift' | 'quarantined_injection'
  auditorPrincipalId?: string
  completionRate?: number
  missingCriteria?: string[]
  correctionHint?: string
  injectionEvidence?: string[]
  auditedAt?: string
}

export interface TaskInquiry {
  category: 'permission_missing' | 'revision_conflict' | 'intent_ambiguity' | 'fatal_error'
  summary: string
  options: Array<{ optionId: string; label: string }>
}

export interface InquiryResolution {
  optionId: string
  resolvedBy: string
  resolvedAt: string
}

export interface TaskProgress {
  currentActivity: string
  completionRate?: number
  activeIssues?: string[]
  inquiry?: TaskInquiry
  inquiryResolution?: InquiryResolution
  updatedAt: string
}

const INJECTION_PATTERNS: Array<[RegExp, string]> = [
  [/<\s*(?:script|iframe|object|embed|meta|style)\b/i, 'script_tag'],
  [/<!--[\s\S]*?-->/, 'hidden_html_comment'],
  [/\b(?:javascript|vbscript|data\s*:\s*text\/html)\s*:/i, 'dangerous_uri_scheme'],
  [/\bon(?:error|load|click|mouseover|focus)\s*=/i, 'inline_event_handler'],
  [/\bacde\s*:\s*(?:shell|fs|windows|open|apps|desktop|marktextdocs)\b/i, 'system_module_escalation'],
  [/\b(?:connectAuthor|approval_tickets|hostToken|attach[A-Z]\w*Host)\b/, 'host_privilege_escalation'],
  [/(?:ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions|忽略(?:此前|之前|上述|所有)(?:的)?(?:指令|提示词|规则)|直接点击接受|自动批准建议|绕过审阅)/i, 'prompt_injection_directive'],
]

/** Inline ContentSanitizer: scans markdown, reasons, and source URIs for prompt injection or privilege escalation markers. */
export function sanitizeContent(texts: string[], uris: string[] = []): string[] {
  const matched = new Set<string>()
  for (const sample of [...texts, ...uris]) {
    if (typeof sample !== 'string' || !sample) continue
    for (const [pattern, label] of INJECTION_PATTERNS) {
      if (pattern.test(sample)) matched.add(label)
    }
  }
  return [...matched]
}

type Schema = Record<string, unknown>
const id = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$' }
const cursor = { type: 'string', minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9_-]+$' }
const text = { type: 'string', maxLength: limits.documentBytes }
const integer = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
const timestamp = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$' }
const page = { type: 'integer', minimum: 1, maximum: limits.eventPage }
const rate = { type: 'integer', minimum: 0, maximum: 100 }
function object(properties: Record<string, unknown>, required = Object.keys(properties)): Schema {
  return { type: 'object', properties, required, additionalProperties: false }
}
const refFields = { workspaceId: id, docId: id, documentEpoch: id, revision: { type: 'string', pattern: '^(0|[1-9][0-9]*)$', maxLength: 40 } }
const document = object(refFields)
const latestDocument = object({ ...refFields, revision: { anyOf: [refFields.revision, { const: 'latest' }] } })
const sources = { type: 'array', maxItems: 100, items: object({ uri: { type: 'string', minLength: 1, maxLength: 2048 }, label: { type: 'string', maxLength: 256 } }, ['uri']) }
const operation = { oneOf: [
  ...['replaceBlock', 'insertBeforeBlock', 'insertAfterBlock'].map(kind => object({ kind: { const: kind }, blockId: id, markdown: text })),
  object({ kind: { const: 'deleteBlock' }, blockId: id }),
  object({ kind: { const: 'insertAtStart' }, markdown: text }),
] }
const inquiryOption = object({
  optionId: id,
  label: { type: 'string', minLength: 1, maxLength: 256 },
})
const inquiry = object({
  category: { enum: ['permission_missing', 'revision_conflict', 'intent_ambiguity', 'fatal_error'] },
  summary: { type: 'string', minLength: 1, maxLength: 1024 },
  options: { type: 'array', minItems: 1, maxItems: 8, items: inquiryOption },
})

export const capabilitySchemas: Record<string, Schema> = {
  'documents.list': object({ workspaceId: id, cursor, limit: page, inbox: { type: 'boolean' } }, ['workspaceId']),
  'documents.read': object({ document: latestDocument, range: object({ start: integer, end: integer }) }, ['document']),
  'documents.outline': object({ document }),
  'documents.blocks': object({ document, cursor, limit: page }, ['document']),
  'documents.createDraft': object({ workspaceId: id, title: { type: 'string', minLength: 1, maxLength: 256 }, markdown: text, sources }, ['workspaceId', 'title', 'markdown']),
  'proposals.create': object({ base: document, operations: { type: 'array', minItems: 1, maxItems: limits.operations, items: operation }, reason: { type: 'string', minLength: 1, maxLength: 4096 }, sources }, ['base', 'operations', 'reason']),
  'proposals.get': object({ proposalId: id }),
  'proposals.list': object({ document }),
  'proposals.verify': object({
    targetKind: { enum: ['draft', 'proposal'] },
    targetId: id,
    outcome: { enum: ['verified', 'flagged_drift', 'quarantined_injection'] },
    completionRate: rate,
    missingCriteria: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 512 } },
    correctionHint: { type: 'string', minLength: 1, maxLength: 2048 },
    injectionEvidence: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 512 } },
  }, ['targetKind', 'targetId', 'outcome']),
  'tasks.updateProgress': object({
    taskId: id,
    currentActivity: { type: 'string', minLength: 1, maxLength: 512 },
    completionRate: rate,
    activeIssues: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 512 } },
    inquiry,
  }, ['taskId', 'currentActivity']),
  'artifacts.export': object({ document, format: { const: 'markdown' } }),
  'artifacts.read': object({ artifactId: id, offset: integer, length: { type: 'integer', minimum: 1, maximum: limits.artifactReadBytes }, handoffId: id }, ['artifactId', 'offset', 'length']),
  'artifacts.materializeToManagedDir': object({
    artifactId: id,
    relativePath: { type: 'string', minLength: 1, maxLength: 256 },
  }),
  'handoffs.create': object({ artifactId: id, recipientPrincipalId: id, purpose: { type: 'string', minLength: 1, maxLength: 256 }, expiresAt: timestamp }),
  'handoffs.get': object({ handoffId: id }),
  'handoffs.acknowledge': object({ handoffId: id, status: { enum: ['accepted', 'failed'] }, artifactDigest: { type: 'string', minLength: 1, maxLength: 128 } }),
  'writing.generate': object({
    purpose: { enum: ['polish', 'continue', 'summarize'] },
    document,
    range: object({ start: integer, end: integer }),
    modelId: id,
    instruction: { type: 'string', minLength: 1, maxLength: 1024 },
  }, ['purpose', 'document', 'range', 'modelId']),
}

/** Published result shapes list the guaranteed fields; additive fields remain compatible. */
function shape(properties: Record<string, unknown>, required = Object.keys(properties)): Schema {
  return { type: 'object', properties, required, additionalProperties: true }
}
const string = { type: 'string' }
const optionalString = { type: ['string', 'null'] }
const boolean = { type: 'boolean' }
const auditShape = shape({
  status: { enum: ['pending_audit', 'verified', 'flagged_drift', 'quarantined_injection'] },
}, ['status'])
const provenance = { title: string, creatorPrincipalId: string, creatorName: string, workflowId: optionalString,
  sources: { type: 'array' }, inbox: boolean, createdAt: optionalString, updatedAt: string }
const proposalSummary = { proposalId: string, base: document, authorPrincipalId: string, authorName: string,
  workflowId: optionalString, reason: string, sources: { type: 'array' }, proposalDigest: string,
  state: { enum: ['pending_review', 'stale', 'applied', 'rejected', 'withdrawn'] }, appliedRevision: optionalString, createdAt: string }
const change = shape({ start: integer, end: integer, text: string, before: string })
const artifact = { artifactId: string, document, mime: string, byteLength: integer, suggestedFileName: string,
  digest: string, sources: { type: 'array' }, createdAt: string }
const handoff = shape({ handoffId: string, artifactId: string, senderPrincipalId: string, recipientPrincipalId: string,
  purpose: string, expiresAt: string, state: { enum: ['awaiting_receipt', 'accepted', 'failed'] }, receipt: { type: ['object', 'null'] } })

export const taskReceiptSchema = shape({ taskId: string, requestId: string,
  state: { enum: ['queued', 'running', 'awaiting_user', 'committing', 'succeeded', 'failed', 'cancelled', 'recovering'] }, acceptedAt: string })

/** Read capabilities return these directly; mutations return a task receipt whose final result has this shape. */
export const capabilityResultSchemas: Record<string, Schema> = {
  'documents.list': shape({ documents: { type: 'array', items: shape({ document, savedRevision: optionalString, ...provenance }) }, cursor: string }, ['documents']),
  'documents.read': shape({ document, markdown: string, range: shape({ start: integer, end: integer }), savedRevision: optionalString,
    saved: boolean, freshness: shape({ committed: boolean, hasUnacknowledgedInput: boolean }), ...provenance }),
  'documents.outline': shape({ document, outline: { type: 'array', items: shape({ blockId: string, level: integer, text: string, start: integer, end: integer, line: integer }) } }),
  'documents.blocks': shape({ document, blocks: { type: 'array', items: shape({ blockId: string, type: string, start: integer, end: integer, markdown: string }) }, cursor: string }, ['document', 'blocks']),
  'documents.createDraft': shape({ document, inbox: boolean }),
  'proposals.create': shape({ proposalId: string, base: document, proposalDigest: string, state: { const: 'pending_review' } }),
  'proposals.get': shape({ ...proposalSummary, operations: { type: 'array' },
    diff: shape({ before: string, after: string, changes: { type: 'array', items: change } }) }),
  'proposals.list': shape({ document, proposals: { type: 'array', items: shape({ ...proposalSummary, operationCount: integer }) }, truncated: boolean }),
  'proposals.verify': shape({
    targetKind: { enum: ['draft', 'proposal'] },
    targetId: string,
    audit: auditShape,
    circuitBroken: boolean,
  }),
  'tasks.updateProgress': shape({
    taskId: string,
    state: string,
    progress: shape({ currentActivity: string, updatedAt: string }),
    cooldownActive: boolean,
    batched: boolean,
  }),
  'artifacts.export': shape(artifact),
  'artifacts.read': shape({ ...artifact, offset: integer, length: integer, bytes: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 255 } }, eof: boolean }, ['artifactId', 'document', 'mime', 'byteLength', 'suggestedFileName', 'digest', 'sources', 'createdAt', 'offset', 'bytes', 'eof']),
  'artifacts.materializeToManagedDir': shape({
    artifactId: string,
    relativePath: string,
    byteLength: integer,
    digest: string,
    materializedAt: string,
  }),
  'handoffs.create': handoff,
  'handoffs.get': handoff,
  'handoffs.acknowledge': handoff,
  'writing.generate': shape({
    kind: { enum: ['proposal', 'summary'] },
    base: document,
    range: shape({ start: integer, end: integer }),
    modelId: string,
  }),
}

export const protocolSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'urn:marktext:documents:1',
  ...object({
    protocol: { const: 'marktext-documents/1' },
    requestId: id,
    capability: { enum: Object.keys(capabilitySchemas) },
    capabilityVersion: { const: 1 },
    input: { type: 'object' },
    deadlineAt: timestamp,
    workflowId: id,
    parentTaskId: id,
  }, ['protocol', 'requestId', 'capability', 'capabilityVersion', 'input']),
  allOf: Object.entries(capabilitySchemas).map(([capability, schema]) => ({
    if: { properties: { capability: { const: capability } } },
    then: { properties: { input: schema } },
  })),
}

export interface RequestEnvelope {
  protocol: 'marktext-documents/1'
  requestId: string
  capability: string
  capabilityVersion: 1
  input: Record<string, unknown>
  deadlineAt?: string
  workflowId?: string
  parentTaskId?: string
}

const validate = new Ajv({ strict: true, strictRequired: false, allErrors: false }).compile(protocolSchema)

export function validateRequest(value: unknown): RequestEnvelope {
  let serialized: string | undefined
  try { serialized = JSON.stringify(value) } catch { throw new ProtocolError('INVALID_ARGUMENT', 'Request must be JSON data.') }
  if (!serialized) throw new ProtocolError('INVALID_ARGUMENT', 'Request must be a JSON object.')
  if (byteLength(serialized) > limits.requestBytes) throw new ProtocolError('PAYLOAD_TOO_LARGE', 'Request exceeds the published byte limit.')
  const candidate = value as Record<string, unknown> | null
  if (candidate && (candidate.protocol !== 'marktext-documents/1' || candidate.capabilityVersion !== 1)) {
    throw new ProtocolError('UNSUPPORTED_VERSION', 'Only marktext-documents/1 capability version 1 is supported.')
  }
  if (!validate(value)) throw new ProtocolError('INVALID_ARGUMENT', 'Request does not match the published JSON schema.')
  const request = value as RequestEnvelope
  if (request.deadlineAt && !Number.isFinite(Date.parse(request.deadlineAt))) throw new ProtocolError('INVALID_ARGUMENT', 'Invalid request deadline.')
  return request
}
