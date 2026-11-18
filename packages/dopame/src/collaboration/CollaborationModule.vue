<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { ApprovalHostService } from '../../../dopame-system/services/marktextdocs-approval-host'
import type { DocumentRef, TextChange } from '../domain/collaboration'
import type { EditorLocalState } from '../editor/editorPort'
import type { Resource } from '../files'
import { distinctNames, formatTime, proposalFacts, shortId, sourceLinks } from './viewModel'

// The author's side of collaboration, shown inside the editor. Approvals made here come from the
// development approval host: they are not protected human approval.
interface OpenDocument { id: string; name: string; text: string; saving: boolean; collab?: DocumentRef }
interface PreparedSave { document: DocumentRef; saveId?: string; resourceKey?: string; target?: 'root' | 'handle' }
const props = defineProps<{
  service: ApprovalHostService
  documents: OpenDocument[]
  activeId: string
  windowSessionId?: string
  isBusy: () => boolean
  flush: (tabId: string) => void
  flushAsync?: (tabId: string) => Promise<void>
  portState?: (tabId: string) => EditorLocalState | undefined
  acknowledgeCommit?: (tabId: string, rev: string, seq?: number) => void
  selectedRange?: (tabId: string) => { start: number; end: number; excerpt: string } | undefined
}>()
const emit = defineEmits<{
  'open-draft': [draft: { title: string; markdown: string; document?: DocumentRef }]
  bound: [change: { tabId: string; document?: DocumentRef; reason?: string }]
  apply: [change: { tabId: string; markdown: string; document: DocumentRef }]
  gate: [held: boolean]
  pending: [count: number]
  'lease-readonly': [readonly: boolean]
}>()

interface Pairing { pairingId: string; name: string; expiresAt: string }
interface Grant {
  grantId: string
  actions: string[]
  expiresAt: string
  active: boolean
  delegationDepth: number
  delegated: boolean
  scope: { workflowId?: string; allowedBlockIds?: string[]; maxAuditRetries?: number; requireAudit?: boolean }
}
interface Caller { principalId: string; name: string; active: boolean; grants: Grant[] }
interface AuditInfo {
  status: 'pending_audit' | 'verified' | 'flagged_drift' | 'quarantined_injection'
  completionRate?: number
  missingCriteria?: string[]
  correctionHint?: string
  injectionEvidence?: string[]
}
interface InquiryOption { optionId: string; label: string }
interface TaskItem {
  taskId: string
  principalName: string
  capability: string
  workflowId: string | null
  state: string
  updatedAt: string
  progress?: {
    currentActivity: string
    completionRate?: number
    activeIssues?: string[]
    inquiry?: { category: string; summary: string; options: InquiryOption[] }
    inquiryResolution?: { optionId: string; resolvedAt: string }
    updatedAt: string
  }
  error?: { code: string; message: string }
}
interface WriterLeaseView {
  document?: DocumentRef
  hasActiveLease: boolean
  ownerSessionId: string | null
  ownedByCaller: boolean
  writerFence: string
  hasPendingInput: boolean
}
interface WritingStatusView {
  available: boolean
  reason?: string
  models: string[]
}
interface WritingTaskResult {
  kind: 'proposal' | 'summary'
  purpose: 'polish' | 'continue' | 'summarize'
  modelId: string
  proposalId?: string
  summary?: string
  generatedText: string
}
interface WritingTaskView {
  taskId: string
  state: string
  progress?: { currentActivity: string; completionRate?: number }
  result?: WritingTaskResult
  error?: { code: string; message: string }
}
interface RecoveryDraftItem {
  recoveryDraftId: string
  base: DocumentRef
  markdown: string
  reason: string
  createdAt: string
}
interface PendingSaveItem {
  saveId: string
  state: string
  document: DocumentRef
}
type Item = Record<string, unknown>

const presets: Record<string, { label: string; actions: string[]; allowHandoff?: boolean }> = {
  review: { label: '审阅：读取文档并提交建议', actions: ['document:read', 'proposal:create', 'proposal:read', 'task:read'] },
  research: { label: '研究：投递独立草稿', actions: ['document:create', 'task:read'] },
  auditor: { label: '专职审查：只审不改（核验草稿与建议）', actions: ['audit:review', 'document:read', 'proposal:read', 'task:read', 'task:report_progress'] },
  harness: { label: 'Harness 调度：进度汇报与受管沙箱落盘', actions: ['document:read', 'document:create', 'proposal:create', 'proposal:read', 'task:read', 'task:report_progress', 'artifact:export', 'artifact:materialize'] },
  deliver: { label: '交付：读取、导出并交接产物', actions: ['document:read', 'artifact:export', 'artifact:read', 'artifact:share', 'task:read'], allowHandoff: true },
  receive: { label: '下游接收：仅任务与交接回执', actions: ['task:read'] },
}
const lifetimes = [['30', '30 分钟'], ['60', '1 小时'], ['240', '4 小时'], ['720', '12 小时']]
const actionNames: Record<string, string> = {
  'document:read': '读取文档', 'document:create': '创建草稿', 'proposal:create': '提交建议', 'proposal:read': '查看建议',
  'task:read': '查询任务', 'task:report_progress': '汇报进度', 'audit:review': '专职审查',
  'artifact:export': '导出产物', 'artifact:read': '读取产物', 'artifact:share': '交接产物', 'artifact:materialize': '受管落盘',
  'writing:generate': 'AI 辅助生成',
}
const auditLabels: Record<string, string> = {
  pending_audit: '待审查',
  verified: '审查通过',
  flagged_drift: '偏离待纠偏',
  quarantined_injection: '提示词注入已隔离',
}
const taskCapabilityNames: Record<string, string> = {
  'documents.createDraft': '创建草稿',
  'proposals.create': '提交建议',
  'proposals.verify': '专职审查',
  'artifacts.export': '导出产物',
  'artifacts.materializeToManagedDir': '受管沙箱落盘',
  'handoffs.create': '发起交接',
  'handoffs.acknowledge': '交接回执',
  'writing.generate': 'AI 写作生成',
}

const status = ref('正在连接协作服务…')
const error = ref('')
const busy = ref(false)
const disabled = ref(false)
const workspace = ref('')
const pairings = shallowRef<Pairing[]>([])
const callers = shallowRef<Caller[]>([])
const drafts = shallowRef<Item[]>([])
const workspaceTasks = shallowRef<TaskItem[]>([])
const writerStatus = shallowRef<WriterLeaseView>()
const recoveryDrafts = shallowRef<RecoveryDraftItem[]>([])
const pendingSaves = shallowRef<PendingSaveItem[]>([])
const silentInquiryCount = ref(0)
const writingStatus = ref<WritingStatusView>({ available: false, models: [], reason: '正在查询系统模型状态…' })
const writingPurpose = ref<'polish' | 'continue' | 'summarize'>('polish')
const writingModel = ref('')
const writingInstruction = ref('')
const writingScopePreview = ref<{ start: number; end: number; excerpt: string } | null>(null)
const writingTask = shallowRef<WritingTaskView>()
const writingBusy = computed(() => Boolean(writingTask.value && ['queued', 'running', 'committing'].includes(writingTask.value.state)))
const choices = ref<Record<string, { scope: string; minutes: string; allowedBlocks: string; maxRetries: string; requireAudit: boolean }>>({})
const draftNames = computed(() => distinctNames(drafts.value.map(draft => ({
  name: String(draft.title), hint: `${formatTime(draft.createdAt)} · ${shortId((draft.document as Item).docId)}`,
}))))
const active = computed(() => props.documents.find(document => document.id === props.activeId))
const proposals = shallowRef<Item[]>([])
const selected = shallowRef<Item>()
const selectedFacts = computed(() => selected.value ? proposalFacts(selected.value) : undefined)
const selectedChanges = computed(() => ((selected.value?.diff as Item | undefined)?.changes ?? []) as TextChange[])
const selectedAudit = computed(() => selected.value?.audit as AuditInfo | undefined)
const proposalNames = computed(() => distinctNames(proposals.value.map(item => ({
  name: String(item.reason), hint: `${formatTime(item.createdAt)} · ${shortId(item.proposalId)}`,
}))))
const syncing = ref(false)
const notice = ref('')
const savedRevisions = ref<Record<string, string>>({})
const handles = new WeakMap<object, string>()
const undone = ref<Set<string>>(new Set())
const syncPaused = ref('')
const transient = new Set(['RESULT_NOT_READY', 'RATE_LIMITED', 'RESOURCE_UNAVAILABLE'])
const SAVE_RECORD_WAIT_MS = 3000
const attempted = new Map<string, string>()
const committed = new Map<string, string>()
const windowPendingReported = new Set<string>()
const commits = ref(0)
const unsynced = computed(() => commits.value >= 0 && !!active.value?.collab && committed.get(active.value.collab.docId) !== active.value.text)
const stateLabels: Record<string, string> = { pending_review: '待审阅', stale: '已过期', applied: '已应用', rejected: '已拒绝', withdrawn: '已撤回' }
const taskStateLabels: Record<string, string> = {
  queued: '排队中', running: '执行中', committing: '提交中', awaiting_user: '等待确认',
  succeeded: '已完成', failed: '失败', cancelled: '已取消', recovering: '恢复核对中',
}

/** Group awaiting_user tasks by workflowKey so multiple blocked questions appear as one merged card per workflow. */
const mergedInquiries = computed(() => {
  const groups = new Map<string, { workflowKey: string; items: TaskItem[] }>()
  for (const task of workspaceTasks.value) {
    if (task.state !== 'awaiting_user' || !task.progress?.inquiry) continue
    const key = task.workflowId ?? '默认工作流'
    const existing = groups.get(key)
    if (existing) existing.items.push(task)
    else groups.set(key, { workflowKey: key, items: [task] })
  }
  return [...groups.values()]
})

let timer: ReturnType<typeof setInterval> | undefined
let syncTimer: ReturnType<typeof setInterval> | undefined

function plain(document: DocumentRef): DocumentRef {
  return { workspaceId: document.workspaceId, docId: document.docId, documentEpoch: document.documentEpoch, revision: document.revision }
}
function sessionArg() {
  return props.windowSessionId ? { windowSessionId: props.windowSessionId } : {}
}
function label(name: string, id: string) { return `${name}（${shortId(id)}）` }
function choice(pairingId: string) {
  return choices.value[pairingId] ??= { scope: '', minutes: '60', allowedBlocks: '', maxRetries: '', requireAudit: false }
}
function auditOf(item: Item): AuditInfo | undefined {
  return item.audit && typeof item.audit === 'object' ? item.audit as AuditInfo : undefined
}
function isDraftBlocked(draft: Item): boolean {
  const audit = auditOf(draft)
  return !!audit && audit.status !== 'verified'
}
function isDraftQuarantined(draft: Item): boolean {
  return auditOf(draft)?.status === 'quarantined_injection'
}
function isProposalAuditBlocked(proposal: Item): boolean {
  const audit = auditOf(proposal)
  return !!audit && audit.status !== 'verified'
}
function describe(grant: Grant) {
  const actions = grant.actions.map(action => actionNames[action] ?? action).join('、')
  const state = grant.active ? `有效至 ${formatTime(grant.expiresAt)}` : '已失效'
  const origin = grant.delegated ? ' · 由交接产生' : grant.delegationDepth ? ' · 可交接' : ''
  const blocks = grant.scope.allowedBlockIds?.length ? ` · 限定 ${grant.scope.allowedBlockIds.length} 个块` : ''
  const retries = grant.scope.maxAuditRetries !== undefined ? ` · 重试上限 ${grant.scope.maxAuditRetries}` : ''
  const mustAudit = grant.scope.requireAudit ? ' · 强制审查' : ''
  return `${actions} · ${state}${grant.scope.workflowId ? ` · 工作流 ${grant.scope.workflowId}` : ''}${blocks}${retries}${mustAudit}${origin}`
}
function message(reason: unknown) {
  const value = reason as { code?: string; message?: string }
  return `${value?.code ? `${value.code} · ` : ''}${value?.message ?? '操作未完成。'}`
}

let claim: Promise<string> | undefined
const preempted = ref(false)
async function claimHost() {
  const state = await props.service.status().catch(() => undefined)
  if (state?.approvalHost && state.approvalHost !== 'unclaimed') preempted.value = true
  return (await props.service.attachApprovalHost()).hostToken
}
async function command(name: string, input?: unknown) {
  if (disabled.value) throw Object.assign(new Error('The approval host is disabled.'), { code: 'PERMISSION_DENIED' })
  claim ??= claimHost()
  return props.service.approvalHost(await claim, name, input) as Promise<Item>
}

let writes: Promise<unknown> = Promise.resolve()
function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const result = writes.then(operation)
  writes = result.catch(() => undefined)
  return result
}

function documentText(tabId: string) {
  return props.documents.find(item => item.id === tabId)?.text
}

async function commitText(tabId: string, text: string): Promise<DocumentRef> {
  const reference = props.documents.find(item => item.id === tabId)?.collab
  if (!reference) throw Object.assign(new Error('此标签已不是协作文档。'), { code: 'RESOURCE_UNAVAILABLE' })
  const port = props.portState?.(tabId)
  if (committed.get(reference.docId) === text) {
    if (windowPendingReported.has(reference.docId) || port?.pendingInput) {
      await command('documents.windowState', {
        document: plain(reference),
        pendingInput: false,
        ...sessionArg(),
        ...(port ? { localOpSeq: port.localOpSeq } : {}),
      }).catch(() => undefined)
      windowPendingReported.delete(reference.docId)
      props.acknowledgeCommit?.(tabId, reference.revision, port?.localOpSeq)
    }
    return plain(reference)
  }
  attempted.set(reference.docId, text)
  const result = await command('documents.commit', {
    document: plain(reference),
    markdown: text,
    ...sessionArg(),
    ...(port ? { localOpSeq: port.localOpSeq } : {}),
  })
  const document = result.document as DocumentRef
  committed.set(reference.docId, text)
  windowPendingReported.delete(reference.docId)
  props.acknowledgeCommit?.(tabId, document.revision, port?.localOpSeq)
  commits.value++
  emit('bound', { tabId, document })
  return plain(document)
}

function apply(tabId: string, markdown: string, document: DocumentRef) {
  emit('apply', { tabId, markdown, document })
  const text = documentText(tabId)
  if (text !== undefined) committed.set(document.docId, text)
  props.acknowledgeCommit?.(tabId, document.revision)
  commits.value++
}

async function refresh() {
  if (disabled.value) return
  try {
    const pending = await command('pairings.list')
    const paired = await command('principals.list')
    const inbox = await command('inbox.list')
    const taskData = await command('tasks.list')
    workspace.value = String(pending.workspaceId)
    pairings.value = pending.pairings as Pairing[]
    callers.value = paired.principals as Caller[]
    drafts.value = inbox.drafts as Item[]
    const nextTasks = (taskData.tasks ?? []) as TaskItem[]
    const awaitingCount = nextTasks.filter(t => t.state === 'awaiting_user').length
    const activePort = active.value ? props.portState?.(active.value.id) : undefined
    const inputOrGateBusy = props.isBusy() || Boolean(activePort?.pendingInput)
    // Input gate protection: while author is typing, composing, or in review gate, keep silent badge instead of showing inquiry cards.
    if (inputOrGateBusy && awaitingCount > 0) silentInquiryCount.value = awaitingCount
    else silentInquiryCount.value = 0
    workspaceTasks.value = nextTasks
    status.value = `协作服务已连接 · 开发用批准宿主 · 工作区 ${workspace.value}`
    emit('pending', pairings.value.length)
    const wStatus = await command('writing.status').catch(() => undefined) as WritingStatusView | undefined
    if (wStatus && typeof wStatus.available === 'boolean') {
      writingStatus.value = wStatus
      if (wStatus.models.length && !wStatus.models.includes(writingModel.value)) {
        writingModel.value = wStatus.models[0]
      }
    }
    const document = active.value?.collab
    if (document) {
      const docRef = plain(document)
      proposals.value = (await command('proposals.list', { document: docRef })).proposals as Item[]
      writerStatus.value = await command('writer.status', { document: docRef, ...sessionArg() }) as unknown as WriterLeaseView
      emit('lease-readonly', Boolean(writerStatus.value?.hasActiveLease && !writerStatus.value?.ownedByCaller))
      if (writerStatus.value?.document?.revision && writerStatus.value.document.revision !== document.revision
        && (!writerStatus.value.ownedByCaller || !unsynced.value) && active.value) {
        const latest = await command('documents.open', { docId: document.docId }).catch(() => undefined)
        if (latest && latest.document && active.value?.collab?.docId === document.docId) {
          apply(active.value.id, String(latest.markdown ?? ''), latest.document as DocumentRef)
        }
      }
      recoveryDrafts.value = ((await command('documents.recoveryDrafts', { document: docRef })).drafts ?? []) as RecoveryDraftItem[]
      pendingSaves.value = ((await command('documents.pendingSaves', { document: docRef })).pendingSaves ?? []) as PendingSaveItem[]
    } else {
      proposals.value = []
      writerStatus.value = undefined
      emit('lease-readonly', false)
      recoveryDrafts.value = []
      pendingSaves.value = []
    }
    const current = selected.value && proposals.value.find(item => item.proposalId === selected.value?.proposalId)
    if (!current) selected.value = undefined
    else if (current.state !== selected.value?.state || JSON.stringify(current.audit) !== JSON.stringify(selected.value?.audit)) {
      selected.value = { ...selected.value, state: current.state, appliedRevision: current.appliedRevision, audit: current.audit }
    }
  } catch (reason) {
    const code = (reason as { code?: string }).code
    if (code === 'PERMISSION_DENIED') {
      disabled.value = true
      pairings.value = []
      callers.value = []
      drafts.value = []
      workspaceTasks.value = []
      emit('pending', 0)
      status.value = preempted.value
        ? '警告：在编辑器打开之前，已有其他应用领取了批准宿主，它可能已以你的身份执行过协作操作。批准宿主现已停用。请重启桌面，并在重新打开后检查已配对的调用方和协作文档。'
        : '批准宿主已停用：有其他调用方争用了宿主，或本窗口在服务运行期间被重新加载，或协作服务已重启。本窗口不会再处理任何协作操作。请重启桌面，并检查已配对的调用方中是否有并非由你批准的条目。'
    } else {
      status.value = '协作服务暂不可用；配对请求保持待处理，单机编辑不受影响。'
      if (code !== 'RESOURCE_UNAVAILABLE') error.value = message(reason)
    }
  }
}

async function act(name: string, input: unknown) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await command(name, input) } catch (reason) { error.value = message(reason) }
  finally { busy.value = false }
  await refresh()
}

function approve(pairing: Pairing) {
  const currentChoice = choice(pairing.pairingId)
  const preset = presets[currentChoice.scope]
  if (!preset) return
  const allowedBlockIds = currentChoice.allowedBlocks.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
  const parsedRetries = currentChoice.maxRetries.trim() ? Number(currentChoice.maxRetries.trim()) : undefined
  return act('pairings.approve', {
    pairingId: pairing.pairingId,
    grants: [{
      actions: preset.actions,
      expiresInMinutes: Number(currentChoice.minutes),
      ...(preset.allowHandoff ? { allowHandoff: true } : {}),
      ...(allowedBlockIds.length ? { allowedBlockIds } : {}),
      ...(parsedRetries !== undefined ? { maxAuditRetries: parsedRetries } : {}),
      ...(currentChoice.requireAudit ? { requireAudit: true } : {}),
    }],
  })
}

async function resolveInquiry(taskId: string, optionId: string) {
  await act('tasks.resolveInquiry', { taskId, optionId })
}

async function takeoverLease() {
  const document = active.value?.collab
  if (!document || busy.value) return
  await act('writer.takeover', { document: plain(document), ...sessionArg() })
}

function previewWritingScope() {
  const doc = active.value
  if (!doc) {
    writingScopePreview.value = null
    return
  }
  const range = props.selectedRange?.(doc.id)
  if (range && (range.end > range.start || writingPurpose.value === 'continue')) {
    const start = Math.max(0, Math.min(doc.text.length, range.start))
    const end = Math.max(start, Math.min(doc.text.length, range.end))
    const excerpt = start === end
      ? doc.text.slice(Math.max(0, start - 120), Math.min(doc.text.length, start + 120))
      : doc.text.slice(start, end)
    writingScopePreview.value = { start, end, excerpt }
  } else {
    writingScopePreview.value = { start: 0, end: doc.text.length, excerpt: doc.text }
  }
}

async function startWritingTask() {
  const doc = active.value
  if (!doc?.collab || busy.value || writingBusy.value || !writingStatus.value.available) return
  if (props.isBusy()) {
    error.value = '请先完成当前输入或关闭对话框，再发起 AI 写作生成。'
    return
  }
  busy.value = true
  error.value = ''
  notice.value = ''
  try {
    if (props.flushAsync) await props.flushAsync(doc.id)
    else props.flush(doc.id)
    const reference = await exclusive(() => commitText(doc.id, documentText(doc.id) ?? doc.text))
    previewWritingScope()
    const scope = writingScopePreview.value ?? { start: 0, end: doc.text.length, excerpt: doc.text }
    if (writingPurpose.value === 'polish' && scope.start === scope.end) {
      scope.start = 0
      scope.end = (documentText(doc.id) ?? doc.text).length
    }
    const modelId = writingModel.value || writingStatus.value.models[0] || 'local-adapter'
    const started = await command('writing.start', {
      purpose: writingPurpose.value,
      document: plain(reference),
      range: { start: scope.start, end: scope.end },
      modelId,
      ...(writingInstruction.value.trim() ? { instruction: writingInstruction.value.trim() } : {}),
    }) as unknown as WritingTaskView
    writingTask.value = started
    void pollWritingTask(started.taskId)
  } catch (reason) {
    error.value = message(reason)
  } finally {
    busy.value = false
  }
}

async function pollWritingTask(taskId: string) {
  while (writingTask.value?.taskId === taskId) {
    await new Promise(resolve => setTimeout(resolve, 120))
    if (disabled.value || writingTask.value?.taskId !== taskId) break
    try {
      const current = await command('writing.task', { taskId }) as unknown as WritingTaskView
      writingTask.value = current
      if (['succeeded', 'failed', 'cancelled'].includes(current.state)) {
        await refresh()
        if (current.state === 'succeeded' && current.result?.kind === 'proposal' && current.result.proposalId) {
          notice.value = `AI 写作已生成建议（${shortId(current.result.proposalId)}），请审阅差异后决定是否接受。`
          await showProposal({ proposalId: current.result.proposalId })
        } else if (current.state === 'succeeded' && current.result?.kind === 'summary') {
          notice.value = 'AI 总结已生成（见下方只读摘要卡片，未修改文档正文）。'
        } else if (current.state === 'failed' && current.error) {
          error.value = `${current.error.code} · ${current.error.message}`
        }
        break
      }
    } catch {
      break
    }
  }
}

async function cancelWritingTask() {
  const current = writingTask.value
  if (!current || !['queued', 'running', 'committing'].includes(current.state)) return
  try {
    const cancelled = await command('writing.cancel', { taskId: current.taskId }) as unknown as WritingTaskView
    writingTask.value = cancelled
    notice.value = '已取消当前 AI 生成任务；部分输出已丢弃，未写入文档或建议。'
    await refresh()
  } catch (reason) {
    error.value = message(reason)
  }
}

function recoverDraft(item: RecoveryDraftItem) {
  const name = active.value?.name ?? '恢复草稿'
  emit('open-draft', { title: `${name}-恢复副本`, markdown: item.markdown })
}

async function dismissPendingSave(item: PendingSaveItem) {
  if (busy.value) return
  await act('documents.saveFinish', {
    document: plain(item.document),
    saveId: item.saveId,
    outcome: 'cancelled',
    ...sessionArg(),
  })
}

async function openDraft(draft: Item, collaborative: boolean) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const docId = String((draft.document as Item).docId)
    if (collaborative) {
      const result = await command('documents.open', { docId })
      const document = result.document as DocumentRef
      committed.set(document.docId, String(result.markdown ?? ''))
      commits.value++
      emit('open-draft', { title: String(draft.title), markdown: String(result.markdown ?? ''), document })
    } else {
      const result = await command('inbox.read', { docId })
      emit('open-draft', { title: String(draft.title), markdown: String(result.markdown ?? '') })
    }
  } catch (reason) { error.value = message(reason) }
  finally { busy.value = false }
  await refresh()
}

async function adopt() {
  const document = active.value
  if (!document || document.collab || busy.value || props.isBusy()) return
  busy.value = true
  error.value = ''
  try {
    const text = document.text
    const result = await command('documents.adopt', { title: document.name, markdown: text })
    committed.set((result.document as DocumentRef).docId, text)
    commits.value++
    emit('bound', { tabId: document.id, document: result.document as DocumentRef })
  } catch (reason) { error.value = message(reason) }
  finally { busy.value = false }
  await refresh()
}

async function synchronize() {
  if (syncing.value || busy.value || disabled.value) return
  if (props.isBusy()) {
    // Report pendingInput to service so `documents.read` accurately exposes `hasUnacknowledgedInput: true`.
    const currentDoc = active.value
    const port = currentDoc ? props.portState?.(currentDoc.id) : undefined
    if (currentDoc?.collab && port?.pendingInput) {
      windowPendingReported.add(currentDoc.collab.docId)
      void command('documents.windowState', {
        document: plain(currentDoc.collab),
        pendingInput: true,
        localOpSeq: port.localOpSeq,
        ...sessionArg(),
      }).catch(() => undefined)
    }
    return
  }
  syncing.value = true
  try {
    for (const document of props.documents) {
      const reference = document.collab
      if (!reference || document.saving) continue
      if (active.value?.id === document.id && writerStatus.value?.hasActiveLease && !writerStatus.value?.ownedByCaller) continue
      if (committed.get(reference.docId) === document.text) {
        if (windowPendingReported.has(reference.docId)) {
          const port = props.portState?.(document.id)
          await exclusive(() => command('documents.windowState', {
            document: plain(reference),
            pendingInput: false,
            ...sessionArg(),
            ...(port ? { localOpSeq: port.localOpSeq } : {}),
          })).catch(() => undefined)
          windowPendingReported.delete(reference.docId)
          props.acknowledgeCommit?.(document.id, reference.revision, port?.localOpSeq)
        }
        continue
      }
      try {
        await exclusive(() => commitText(document.id, document.text))
        syncPaused.value = ''
      } catch (reason) {
        const code = String((reason as { code?: string }).code)
        if (code === 'RESOURCE_UNAVAILABLE' && !(await props.service.status().then(state => state.available, () => false))) {
          syncPaused.value = '协作服务已停止，同步暂停；重启桌面后恢复。本地编辑不受影响。'
          continue
        }
        if (transient.has(code)) {
          syncPaused.value = `同步暂停，稍后自动重试（${message(reason)}）。`
          continue
        }
        if (code === 'REVISION_CONFLICT' && await reconcile(document.id, reference)) continue
        committed.delete(reference.docId)
        commits.value++
        emit('bound', { tabId: document.id, reason: `「${document.name}」已停止与协作服务同步（${message(reason)}）。本地内容已保留，可另存为或导出副本。` })
      }
    }
  } finally { syncing.value = false }
}

async function reconcile(tabId: string, reference: DocumentRef) {
  try {
    const current = await exclusive(() => command('documents.open', { docId: reference.docId }))
    const held = normalize(String(current.markdown))
    const match = [attempted.get(reference.docId), documentText(tabId)].find(text => text !== undefined && normalize(text) === held)
    if (match === undefined) return false
    committed.set(reference.docId, match)
    commits.value++
    emit('bound', { tabId, document: current.document as DocumentRef })
    syncPaused.value = ''
    return true
  } catch { return false }
}
function normalize(text: string) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

type Decision = 'accept' | 'reject' | 'undo'

async function decide(decision: Decision) {
  const document = active.value
  const proposal = selected.value
  if (!document?.collab || !proposal || busy.value) return
  if (props.isBusy()) {
    error.value = '请先完成当前输入或关闭对话框，再处理建议。'
    return
  }
  if (document.saving) {
    error.value = '文件正在保存，请等保存完成后再处理建议。'
    return
  }
  if ((proposal.base as Item | undefined)?.docId !== document.collab.docId) {
    selected.value = undefined
    return
  }
  busy.value = true
  error.value = ''
  notice.value = ''
  let reverseProposal: string | undefined
  emit('gate', true)
  try {
    await exclusive(async () => {
      if (props.flushAsync) await props.flushAsync(document.id)
      else props.flush(document.id)
      const reference = await commitText(document.id, documentText(document.id) ?? document.text)
      const target = { document: reference, proposalId: String(proposal.proposalId), ...sessionArg() }
      if (decision === 'reject') {
        await command('proposals.reject', { document: reference, proposalId: String(proposal.proposalId), proposalDigest: String(proposal.proposalDigest) })
        notice.value = '已拒绝这条建议；文档没有改变。'
      } else if (decision === 'accept') {
        const result = await command('proposals.accept', { ...target, proposalDigest: String(proposal.proposalDigest) })
        const accepted = result.document as DocumentRef
        apply(document.id, String(result.markdown), accepted)
        notice.value = `已接受这条建议，文档更新为协作版本 ${accepted.revision}。这不等于保存到文件；可用“撤销本次接受”还原。`
      } else {
        const result = await command('proposals.undo', target)
        if (result.state === 'undone') {
          apply(document.id, String(result.markdown), result.document as DocumentRef)
          undone.value = new Set([...undone.value, String(proposal.proposalId)])
          notice.value = '已撤销这次接受，文档还原到接受之前的内容。'
        } else {
          reverseProposal = String(result.proposalId)
          notice.value = '接受之后文档又有修改。为了不覆盖这些修改，已生成一条反向建议，请审阅后决定是否接受。'
        }
      }
    })
  } catch (reason) {
    const code = (reason as { code?: string }).code
    const text = String((reason as { message?: string }).message ?? '')
    if (decision === 'undo' && /already been undone/.test(text)) {
      undone.value = new Set([...undone.value, String(proposal.proposalId)])
      error.value = '这次接受已经撤销过了。'
    } else if (decision === 'undo' && code === 'REVISION_CONFLICT' && (reason as { details?: { comparison?: unknown } }).details?.comparison) {
      error.value = '无法自动撤销：之后的修改与这次接受改动的位置重叠。文档未改变，请对照差异手动处理。'
    } else if (decision === 'undo' && code === 'REVISION_CONFLICT') {
      error.value = '撤销没有执行：文档的版本刚刚发生了变化。请稍候再试。'
    } else if (code === 'AUDIT_NOT_PASSED') {
      error.value = '这条建议或文档尚未通过专职审查（或包含已隔离的注入标记），服务端拒绝应用。'
    } else if (code === 'REVISION_CONFLICT') {
      error.value = '文档在这条建议提交之后已有修改（包括你刚完成的输入），这条建议已过期，没有被应用。'
    } else error.value = message(reason)
  } finally {
    emit('gate', false)
    busy.value = false
  }
  await refresh()
  if (reverseProposal) await showProposal({ proposalId: reverseProposal })
}

function resourceKey(resource: Resource) {
  if (resource.kind === 'root') return `root:${resource.root}:${resource.path}`
  let key = handles.get(resource.handle)
  if (!key) {
    key = `handle:${crypto.randomUUID()}`
    handles.set(resource.handle, key)
  }
  return key
}

/**
 * Commits the exact text about to be written, and when a target resource already exists, registers
 * a durable `save_outbox` intent (`documents.saveBegin`) BEFORE the file write starts.
 */
async function beforeSave(tabId: string, text: string, resource: Resource | null): Promise<PreparedSave | undefined> {
  if (disabled.value || !props.documents.find(item => item.id === tabId)?.collab) return undefined
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<undefined>(resolve => { timeoutId = setTimeout(() => resolve(undefined), SAVE_RECORD_WAIT_MS) })
  try {
    const prepared = await Promise.race([
      exclusive(async (): Promise<PreparedSave> => {
        const reference = await commitText(tabId, text)
        if (!resource) return { document: reference }
        const key = resourceKey(resource)
        const begun = await command('documents.saveBegin', {
          document: plain(reference),
          target: resource.kind,
          resourceKey: key,
          ...(resource.kind === 'root' && resource.version ? { resourceVersion: resource.version } : {}),
          ...sessionArg(),
        })
        return { document: reference, saveId: String(begun.saveId), resourceKey: key, target: resource.kind }
      }),
      timedOut,
    ])
    if (!prepared) error.value = '协作服务没有及时响应；文件照常保存，这次保存不会记录到协作服务。'
    return prepared
  } catch (reason) {
    error.value = `文件照常保存，但协作服务没能同步这次的内容（${message(reason)}）。`
    return undefined
  } finally { clearTimeout(timeoutId) }
}

async function afterSave(
  _tabId: string,
  prepared: PreparedSave,
  outcome: { status: 'saved' | 'conflict' | 'unknown' | 'reauthorize' | 'cancelled'; text?: string; resource?: Resource },
) {
  if (disabled.value) return
  try {
    let result: Item
    if (prepared.saveId) {
      result = await exclusive(() => command('documents.saveFinish', {
        document: plain(prepared.document),
        saveId: prepared.saveId,
        outcome: outcome.status,
        ...(outcome.text !== undefined ? { observedRawText: outcome.text } : {}),
        ...(outcome.resource?.kind === 'root' && outcome.resource.version ? { resourceVersion: outcome.resource.version } : {}),
        ...sessionArg(),
      }))
    } else if (outcome.status === 'saved' && outcome.resource && outcome.text !== undefined) {
      result = await exclusive(() => command('documents.saved', {
        document: plain(prepared.document),
        text: outcome.text,
        target: outcome.resource!.kind,
        resourceKey: resourceKey(outcome.resource!),
        ...sessionArg(),
      }))
    } else {
      return
    }
    if (result.saved) savedRevisions.value = { ...savedRevisions.value, [prepared.document.docId]: prepared.document.revision }
    else if (outcome.status === 'saved') {
      error.value = `文件已保存，但协作服务没有确认文件对应的版本（${String(result.code ?? '未知原因')}）。`
    }
  } catch (reason) {
    if (outcome.status === 'saved') error.value = `文件已保存，但协作服务没能记录这次保存（${message(reason)}）。`
  }
}

function onWindowRequest(request: Record<string, unknown>): boolean {
  if (request.kind !== 'marktext-review') return false
  const ref = (val: unknown) => typeof val === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(val) ? val : undefined
  const proposalId = ref(request.proposalId)
  const taskId = ref(request.taskId)
  if (proposalId) {
    notice.value = `已从通知定位到建议 ${shortId(proposalId)}（未自动应用）。`
    void showProposal({ proposalId })
  } else if (taskId) {
    notice.value = `已从通知定位到任务 ${shortId(taskId)}。`
    void refresh()
  } else if (request.section === 'inbox') {
    notice.value = '已从通知定位到 Agent 收件箱。'
    void refresh()
  }
  return true
}

defineExpose({ beforeSave, afterSave, onWindowRequest })

async function showProposal(proposal: Item) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { selected.value = await command('proposals.get', { proposalId: String(proposal.proposalId) }) } catch (reason) { error.value = message(reason) }
  finally { busy.value = false }
}

watch(() => props.activeId, () => {
  selected.value = undefined
  proposals.value = []
  notice.value = ''
  void refresh()
})

onMounted(() => {
  void refresh()
  timer = setInterval(() => { void refresh() }, 3000)
  syncTimer = setInterval(() => { void synchronize() }, 1000)
})
onBeforeUnmount(() => { clearInterval(timer); clearInterval(syncTimer) })
</script>

<template>
  <aside
    class="collaboration-module"
    aria-label="协作"
    :aria-busy="busy"
  >
    <h2>协作</h2>
    <p
      class="module-status"
      aria-label="协作状态"
    >
      {{ status }}
    </p>
    <p class="module-warning">
      在这里点击“批准”即视为文档作者的批准。这是开发用批准宿主，无法证明操作者是真人，不构成可信人工批准。
    </p>
    <p
      v-if="silentInquiryCount"
      role="status"
      class="module-notice"
    >
      输入保护生效中：有 {{ silentInquiryCount }} 项任务问询已静默挂起，不抢占当前输入焦点。
    </p>
    <p
      v-if="notice"
      role="status"
      aria-label="协作操作结果"
      class="module-notice"
    >
      {{ notice }}
    </p>
    <p
      v-if="error"
      role="alert"
      class="module-error"
    >
      {{ error }} <button @click="error = ''">
        关闭协作提示
      </button>
    </p>

    <section aria-labelledby="module-document">
      <h3 id="module-document">
        当前文档
      </h3>
      <template v-if="active?.collab">
        <p aria-label="同步状态">
          {{ active.name }} · 协作版本 {{ active.collab.revision }} · {{ unsynced ? (syncing ? '正在同步…' : '有未同步的修改') : '已同步' }}
        </p>
        <div
          v-if="writerStatus"
          class="lease-bar"
          role="status"
          aria-label="多窗口写入权状态"
        >
          <small>
            写入权：{{ !writerStatus.hasActiveLease ? '空闲（编辑时自动获取）'
              : writerStatus.ownedByCaller ? `当前窗口持有（Fence ${writerStatus.writerFence}）`
                : `其他窗口持有（Fence ${writerStatus.writerFence}${writerStatus.hasPendingInput ? ' · 对方正在输入' : ''}）` }}
          </small>
          <button
            v-if="writerStatus.hasActiveLease && !writerStatus.ownedByCaller"
            :disabled="busy || writerStatus.hasPendingInput"
            aria-label="接管写入权"
            @click="takeoverLease"
          >
            接管写入权
          </button>
        </div>
        <p
          v-if="syncPaused"
          class="hint"
        >
          {{ syncPaused }}
        </p>
        <p
          class="hint"
          aria-label="文件保存状态"
        >
          {{ savedRevisions[active.collab.docId] === undefined ? '本次打开后尚未记录保存到文件。'
            : savedRevisions[active.collab.docId] === active.collab.revision ? '文件中是当前协作版本。'
              : `文件中是协作版本 ${savedRevisions[active.collab.docId]}，之后的修改尚未保存。` }}
        </p>
        <div
          v-if="pendingSaves.length"
          class="module-warning"
          role="status"
        >
          <p>
            有 {{ pendingSaves.length }} 条外部保存记录处于待核对恢复状态（{{ pendingSaves[0].state }}），未自动重复覆盖文件。
          </p>
          <div class="module-actions">
            <button
              v-for="saveItem in pendingSaves"
              :key="saveItem.saveId"
              :disabled="busy"
              :aria-label="`核销待核对保存记录：${shortId(saveItem.saveId)}`"
              @click="dismissPendingSave(saveItem)"
            >
              已核对外部文件（解除保存挂起 {{ shortId(saveItem.saveId) }}）
            </button>
          </div>
        </div>
        <div
          v-if="recoveryDrafts.length"
          class="recovery-box"
          aria-label="未同步恢复草稿"
        >
          <small>存在 {{ recoveryDrafts.length }} 份因租约变更或冲突保留的恢复草稿：</small>
          <div
            v-for="item in recoveryDrafts"
            :key="item.recoveryDraftId"
            class="module-actions"
          >
            <button
              :disabled="busy"
              :aria-label="`打开恢复草稿：${formatTime(item.createdAt)}`"
              @click="recoverDraft(item)"
            >
              打开恢复副本（基于版本 {{ item.base.revision }} · {{ item.reason }}）
            </button>
          </div>
        </div>
        <p class="hint">
          修改会自动提交到协作服务；这不等于保存到文件。作者修改后，基于旧版本的建议会过期。
        </p>
        <p
          v-if="!proposals.length"
          class="hint"
        >
          这份文档还没有建议。
        </p>
        <ul v-else>
          <li
            v-for="(proposal, index) in proposals"
            :key="String(proposal.proposalId)"
          >
            <strong>{{ proposalNames[index] }}</strong>
            <small>{{ stateLabels[String(proposal.state)] ?? proposal.state }} · 来自 {{ proposal.authorName }} · 基于版本 {{ (proposal.base as Item).revision }} · {{ proposal.operationCount }} 处修改{{ auditOf(proposal) ? ` · ${auditLabels[auditOf(proposal)!.status] ?? auditOf(proposal)!.status}` : '' }}</small>
            <div class="module-actions">
              <button
                :disabled="busy"
                :aria-label="`查看建议：${proposalNames[index]}`"
                @click="showProposal(proposal)"
              >
                查看建议
              </button>
            </div>
          </li>
        </ul>
        <section
          v-if="selected && selectedFacts"
          class="proposal-detail"
          :aria-label="`建议差异：${selected.reason}`"
        >
          <h4>{{ selected.reason }}</h4>
          <small>{{ stateLabels[String(selected.state)] ?? selected.state }} · 来源 {{ selectedFacts.author }} · 基于版本 {{ selectedFacts.baseRevision }} · {{ selectedFacts.created }}</small>
          <p
            v-if="selectedAudit"
            role="status"
            :class="selectedAudit.status === 'verified' ? 'hint' : 'module-warning'"
          >
            审查状态：{{ auditLabels[selectedAudit.status] ?? selectedAudit.status }}
            <template v-if="selectedAudit.completionRate !== undefined">
              · 完成度 {{ selectedAudit.completionRate }}%
            </template>
            <template v-if="selectedAudit.correctionHint">
              · 纠偏提示：{{ selectedAudit.correctionHint }}
            </template>
            <template v-if="selectedAudit.injectionEvidence?.length">
              · 拦截特征：{{ selectedAudit.injectionEvidence.join(', ') }}
            </template>
          </p>
          <p
            v-if="selectedFacts.stale"
            role="note"
            class="module-warning"
          >
            文档在此建议提交后已更新，差异仅供对照。请调用方基于当前版本重新生成建议。
          </p>
          <p class="hint">
            引用：<template v-if="!selectedFacts.sources.length">
              未提供
            </template>
            <template
              v-for="source in selectedFacts.sources"
              :key="source.uri"
            >
              {{ source.label }} <code>{{ source.uri }}</code>；
            </template>
            （由调用方提供，未经验证）
          </p>
          <div
            v-for="(change, index) in selectedChanges"
            :key="index"
            class="module-diff"
          >
            <p class="hint">
              原文
            </p><pre>{{ change.before || '（空）' }}</pre>
            <p class="hint">
              建议
            </p><pre>{{ change.text || '（删除）' }}</pre>
          </div>
          <p class="hint">
            接受会把建议作为一次修改写入当前文档（可撤销），不会自动保存到文件。
          </p>
          <div class="module-actions">
            <button
              :disabled="busy || selected.state !== 'pending_review' || isProposalAuditBlocked(selected)"
              :aria-label="`接受建议：${selected.reason}`"
              @click="decide('accept')"
            >
              接受建议
            </button>
            <button
              :disabled="busy || !['pending_review', 'stale'].includes(String(selected.state))"
              :aria-label="`拒绝建议：${selected.reason}`"
              @click="decide('reject')"
            >
              拒绝建议
            </button>
            <button
              :disabled="busy || selected.state !== 'applied' || undone.has(String(selected.proposalId))"
              :aria-label="`撤销本次接受：${selected.reason}`"
              @click="decide('undo')"
            >
              撤销本次接受
            </button>
            <button
              :disabled="busy"
              @click="selected = undefined"
            >
              收起建议
            </button>
          </div>
        </section>
      </template>
      <template v-else-if="active">
        <p class="hint">
          「{{ active.name }}」是本地文档，调用方看不到它。加入协作后，获授权的调用方可以读取它并提交建议。
        </p>
        <button
          :disabled="busy || disabled"
          :aria-label="`加入协作：${active.name}`"
          @click="adopt"
        >
          加入协作
        </button>
      </template>
    </section>

    <section
      v-if="mergedInquiries.length || workspaceTasks.length"
      aria-labelledby="module-tasks"
    >
      <h3 id="module-tasks">
        任务进度与合并问询
      </h3>
      <template v-if="!silentInquiryCount">
        <div
          v-for="group in mergedInquiries"
          :key="group.workflowKey"
          class="inquiry-card"
          role="region"
          :aria-label="`合并问询：${group.workflowKey}`"
        >
          <strong>工作流问询（{{ group.workflowKey }} · 共 {{ group.items.length }} 项待决策）</strong>
          <small>同一工作流 180 秒冷却窗口内的阻塞问询已自动合并展示：</small>
          <div
            v-for="item in group.items"
            :key="item.taskId"
            class="inquiry-item"
          >
            <p>{{ item.principalName }}：{{ item.progress?.inquiry?.summary }}</p>
            <div class="module-actions">
              <button
                v-for="opt in item.progress?.inquiry?.options ?? []"
                :key="opt.optionId"
                :disabled="busy"
                :aria-label="`选择问询选项：${opt.label}`"
                @click="resolveInquiry(item.taskId, opt.optionId)"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>
        </div>
      </template>
      <ul v-if="workspaceTasks.length">
        <li
          v-for="task in workspaceTasks.slice(0, 8)"
          :key="task.taskId"
        >
          <strong>{{ taskCapabilityNames[task.capability] ?? task.capability }} · {{ taskStateLabels[task.state] ?? task.state }}</strong>
          <small>{{ task.principalName }} · 更新于 {{ formatTime(task.updatedAt) }}</small>
          <small v-if="task.progress">
            动作：{{ task.progress.currentActivity }}{{ task.progress.completionRate !== undefined ? ` · 完成度 ${task.progress.completionRate}%` : '' }}
          </small>
          <small v-if="task.progress?.activeIssues?.length">
            问题：{{ task.progress.activeIssues.join('；') }}
          </small>
        </li>
      </ul>
    </section>

    <section aria-labelledby="module-pairings">
      <h3 id="module-pairings">
        待处理的配对请求
      </h3>
      <p class="hint">
        名称由调用方自报，未经验证。权限不包含批准建议、提交正文、保存文件或管理授权。
      </p>
      <p
        v-if="!pairings.length"
        class="hint"
      >
        没有待处理的配对请求。
      </p>
      <ul v-else>
        <li
          v-for="pairing in pairings"
          :key="pairing.pairingId"
        >
          <strong>{{ label(pairing.name, pairing.pairingId) }}</strong>
          <small>请求于 {{ formatTime(pairing.expiresAt) }} 过期</small>
          <select
            v-model="choice(pairing.pairingId).scope"
            :disabled="busy"
            :aria-label="`授权范围：${label(pairing.name, pairing.pairingId)}`"
          >
            <option
              value=""
              disabled
            >
              请选择授权范围
            </option>
            <option
              v-for="(preset, key) in presets"
              :key="key"
              :value="key"
            >
              {{ preset.label }}
            </option>
          </select>
          <select
            v-model="choice(pairing.pairingId).minutes"
            :disabled="busy"
            :aria-label="`有效期：${label(pairing.name, pairing.pairingId)}`"
          >
            <option
              v-for="[minutes, text] in lifetimes"
              :key="minutes"
              :value="minutes"
            >
              {{ text }}
            </option>
          </select>
          <details class="grant-constraints">
            <summary>高级边界约束（块范围 / 审查门禁）</summary>
            <input
              v-model="choice(pairing.pairingId).allowedBlocks"
              :disabled="busy"
              placeholder="允许修改的 blockId（逗号分隔，可选）"
              :aria-label="`块范围约束：${label(pairing.name, pairing.pairingId)}`"
            >
            <input
              v-model="choice(pairing.pairingId).maxRetries"
              type="number"
              min="1"
              max="10"
              :disabled="busy"
              placeholder="最大审查纠偏重试次数（默认 2）"
              :aria-label="`最大重试次数：${label(pairing.name, pairing.pairingId)}`"
            >
            <label class="inline-check">
              <input
                v-model="choice(pairing.pairingId).requireAudit"
                type="checkbox"
                :disabled="busy"
              >
              强制经专职审查通过后才可接受/转正
            </label>
          </details>
          <div class="module-actions">
            <button
              :disabled="busy || !choice(pairing.pairingId).scope"
              :title="choice(pairing.pairingId).scope ? undefined : '先选择授权范围'"
              :aria-label="`批准配对：${label(pairing.name, pairing.pairingId)}`"
              @click="approve(pairing)"
            >
              批准配对
            </button>
            <button
              :disabled="busy"
              :aria-label="`拒绝配对：${label(pairing.name, pairing.pairingId)}`"
              @click="act('pairings.reject', { pairingId: pairing.pairingId })"
            >
              拒绝配对
            </button>
          </div>
        </li>
      </ul>
    </section>

    <section aria-labelledby="module-inbox">
      <h3 id="module-inbox">
        Agent 收件箱
      </h3>
      <p
        v-if="!drafts.length"
        class="hint"
      >
        还没有 Agent 投递的草稿。
      </p>
      <ul v-else>
        <li
          v-for="(draft, index) in drafts"
          :key="String((draft.document as Item).docId)"
        >
          <strong>{{ draftNames[index] }}</strong>
          <small>来自 {{ draft.creatorName }} · {{ formatTime(draft.createdAt) }} · 引用 {{ sourceLinks(draft.sources).length }} 条{{ auditOf(draft) ? ` · ${auditLabels[auditOf(draft)!.status] ?? auditOf(draft)!.status}` : '' }}</small>
          <p
            v-if="isDraftQuarantined(draft)"
            class="module-warning"
          >
            检测到提示词注入或越权特征（{{ auditOf(draft)?.injectionEvidence?.join(', ') }}），已隔离留痕并阻断打开。
          </p>
          <div class="module-actions">
            <button
              :disabled="busy || isDraftBlocked(draft)"
              :aria-label="`作为协作文档打开：${draftNames[index]}`"
              @click="openDraft(draft, true)"
            >
              作为协作文档打开
            </button>
            <button
              :disabled="busy || isDraftBlocked(draft)"
              :aria-label="`打开草稿副本：${draftNames[index]}`"
              @click="openDraft(draft, false)"
            >
              打开副本
            </button>
          </div>
        </li>
      </ul>
      <p class="hint">
        作为协作文档打开后，你的修改会同步回这份草稿；打开副本则与它无关，原草稿不变。
      </p>
    </section>

    <section aria-labelledby="module-callers">
      <h3 id="module-callers">
        已配对的调用方
      </h3>
      <p
        v-if="!callers.length"
        class="hint"
      >
        还没有已配对的调用方。
      </p>
      <ul v-else>
        <li
          v-for="caller in callers"
          :key="caller.principalId"
        >
          <strong>{{ label(caller.name, caller.principalId) }}</strong>
          <small>{{ caller.active ? '有效' : '已撤销' }}</small>
          <ul class="grants">
            <li
              v-for="grant in caller.grants"
              :key="grant.grantId"
            >
              {{ describe(grant) }}
            </li>
          </ul>
          <div class="module-actions">
            <button
              :disabled="busy || !caller.active"
              :aria-label="`撤销调用方：${label(caller.name, caller.principalId)}`"
              @click="act('principals.revoke', { principalId: caller.principalId })"
            >
              撤销调用方
            </button>
          </div>
        </li>
      </ul>
    </section>

    <section aria-labelledby="module-ai-writing">
      <h3 id="module-ai-writing">
        内置 AI 写作（选区润色 / 续写 / 总结）
      </h3>
      <p
        class="hint"
        aria-label="系统模型状态"
      >
        {{ writingStatus.available
          ? `系统模型已就绪（可用模型：${writingStatus.models.join('、')}）`
          : (writingStatus.reason ?? '系统模型网关契约（SP-04）尚未在目标平台验证确认，选区润色/续写/总结入口保持禁用；外部 Agent 可自行生成后提交 Proposal 审阅。') }}
      </p>
      <div class="writing-box">
        <label class="hint" for="writing-purpose">写作任务类型</label>
        <select
          id="writing-purpose"
          v-model="writingPurpose"
          :disabled="busy || writingBusy"
          aria-label="AI 写作任务类型"
        >
          <option value="polish">
            选区润色（生成审阅建议 Proposal）
          </option>
          <option value="continue">
            光标/选区续写（生成审阅建议 Proposal）
          </option>
          <option value="summarize">
            选区/文档总结（生成只读摘要，不改原文）
          </option>
        </select>
        <label class="hint" for="writing-model">目标模型</label>
        <select
          id="writing-model"
          v-model="writingModel"
          :disabled="busy || writingBusy || !writingStatus.models.length"
          aria-label="AI 写作模型"
        >
          <option
            v-if="!writingStatus.models.length"
            value=""
          >
            未配置系统模型（SP-04 待验证）
          </option>
          <option
            v-for="m in writingStatus.models"
            :key="m"
            :value="m"
          >
            {{ m }}
          </option>
        </select>
        <input
          v-model="writingInstruction"
          type="text"
          class="writing-input"
          :disabled="busy || writingBusy"
          placeholder="补充指令（可选，例如：语气更简洁）"
          aria-label="AI 写作补充指令"
        >
        <div class="module-actions">
          <button
            :disabled="busy || writingBusy || !active"
            aria-label="预览发送给模型的选区范围"
            @click="previewWritingScope"
          >
            预览发送范围
          </button>
          <button
            :disabled="busy || writingBusy || !writingStatus.available || !active?.collab"
            aria-label="发起 AI 写作生成"
            @click="startWritingTask"
          >
            {{ writingBusy ? '生成中…' : '发起 AI 生成' }}
          </button>
          <button
            v-if="writingBusy"
            aria-label="停止 AI 写作生成"
            @click="cancelWritingTask"
          >
            停止生成
          </button>
        </div>
        <div
          v-if="writingScopePreview"
          class="scope-preview"
          aria-label="AI 发送内容预览"
        >
          <small>
            将发送给模型 {{ writingModel || '（未配置）' }} 的范围：UTF-16 [{{ writingScopePreview.start }}, {{ writingScopePreview.end }}]（共 {{ writingScopePreview.end - writingScopePreview.start }} 字符）
          </small>
          <pre>{{ writingScopePreview.excerpt || '（当前光标位置 / 空选区）' }}</pre>
        </div>
        <div
          v-if="writingTask"
          class="scope-preview"
          role="status"
          aria-label="AI 写作生成进度"
        >
          <small>
            任务 {{ shortId(writingTask.taskId) }} · {{ taskStateLabels[writingTask.state] ?? writingTask.state }}
            <template v-if="writingTask.progress?.completionRate !== undefined">
              · {{ writingTask.progress.completionRate }}%
            </template>
          </small>
          <pre v-if="writingTask.result?.summary">{{ writingTask.result.summary }}</pre>
          <pre v-else-if="writingTask.progress?.currentActivity">{{ writingTask.progress.currentActivity }}</pre>
        </div>
      </div>
    </section>

    <section aria-labelledby="module-boundaries">
      <h3 id="module-boundaries">
        受管沙箱与系统 AI 边界
      </h3>
      <p class="hint">
        受管沙箱落盘：Harness 仅可将已通过审查的固定产物原子物化至服务私有状态下的 <code>managed_workspace/</code> 目录，绝不覆写用户源文档。
      </p>
    </section>
  </aside>
</template>

<style scoped>
.collaboration-module { width: 320px; flex-shrink: 0; overflow: auto; padding: 14px 14px 40px; background: var(--panel); border-left: 1px solid var(--line); }
h2 { margin: 0 0 8px; font-size: 15px; } h3 { margin: 18px 0 6px; font-size: 13px; }
p { margin: 6px 0; line-height: 1.6; }
.module-status { color: var(--muted); font-size: 12px; }
strong { font-size: 13px; }
.module-warning { padding: 8px 10px; border-left: 2px solid #b3541e; background: var(--surface); font-size: 12px; }
.module-error { color: #a32835; overflow-wrap: anywhere; }
.module-notice { overflow-wrap: anywhere; }
.lease-bar, .recovery-box, .inquiry-card, .writing-box { margin: 6px 0; padding: 8px; background: var(--surface); border: 1px solid var(--line); border-radius: 4px; }
.writing-input { display: block; width: 100%; margin: 6px 0; }
.scope-preview { margin-top: 8px; padding-top: 6px; border-top: 1px dashed var(--line); }
.inquiry-item { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--line); }
.grant-constraints { margin: 6px 0; font-size: 12px; color: var(--muted); }
.grant-constraints input[type="text"], .grant-constraints input:not([type="checkbox"]) { display: block; width: 100%; margin: 4px 0; }
.inline-check { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
ul { list-style: none; margin: 0; padding: 0; }
ul > li { padding: 10px 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
.grants > li { padding: 2px 0; border: 0; font-size: 12px; color: var(--muted); }
small { display: block; margin: 2px 0 6px; font-size: 12px; color: var(--muted); }
select { display: block; width: 100%; margin: 6px 0; }
.module-actions { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
button { border: 1px solid var(--line); }
h4 { margin: 10px 0 2px; font-size: 13px; }
.proposal-detail { padding: 8px 0; }
pre { margin: 2px 0 8px; padding: 8px; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--surface); border: 1px solid var(--line); border-radius: 4px; font-family: ui-monospace, monospace; font-size: 12px; max-height: 180px; overflow: auto; }
@media (max-width: 900px) { .collaboration-module { width: 260px; } }
</style>
