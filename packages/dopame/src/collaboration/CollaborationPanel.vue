<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { window as appWindow } from 'acde:window'
import { createAgentClient, type DocumentsService } from '../../../dopame-system/src/agentClient'
import type { DocumentRef, MarkdownBlock, TextChange } from '../domain/collaboration'
import { createNotificationPort, type NoticeTarget, type NotificationHost, type NotificationRecord } from '../platform/notificationPort'
import { distinctNames, formatTime, mergeEvents, parseSources, proposalFacts, shortId, sourceLinks } from './viewModel'

const props = defineProps<{ service: DocumentsService }>()
type Item = Record<string, unknown>
function record(value: unknown): Item {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Item : {}
}
function records(value: unknown) { return Array.isArray(value) ? value.map(record) : [] }
const sections = ['Agent 收件箱', '建议面板', '任务中心', '连接与授权']
const section = ref('连接与授权')
const status = ref('正在连接文档服务…')
const error = ref('')
const busy = ref(false)
const available = ref(false)
// Present only in the approval development desktop; it approves pairings, not proposals.
const developmentHost = ref(false)
const name = ref('')
const workspaceId = ref('')
const pairing = shallowRef<Item>()
const client = shallowRef<ReturnType<typeof createAgentClient>>()
const description = shallowRef<Item>({})
const capabilities = computed(() => records(description.value.capabilities))
const documents = shallowRef<Item[]>([])
const documentCursor = ref<string>()
const snapshot = shallowRef<{ document: DocumentRef; title: string; markdown: string; blocks: MarkdownBlock[]; pendingInput: boolean; saved?: boolean; provenance: Item }>()
const proposals = shallowRef<Item[]>([])
const selectedProposal = shallowRef<Item>()
const tasks = shallowRef<Item[]>([])
const events = shallowRef<Item[]>([])
const eventCursor = ref<string>()
const draftTitle = ref('')
const draftText = ref('')
const draftSources = ref('')
const inboxOnly = ref(true)
const blockId = ref('')
const replacement = ref('')
const reason = ref('')
const proposalSources = ref('')
const artifactId = ref('')
const recipient = ref('')
const purpose = ref('')
const handoffId = ref('')
const handoffStatus = shallowRef<Item>()
const received = shallowRef<{ text: string; digest: string; fileName: string; byteLength: number }>()
const managedRelativePath = ref('')
const verifyOutcome = ref<'verified' | 'flagged_drift' | 'quarantined_injection'>('verified')
const verifyRate = ref(100)
const verifyHint = ref('')
const progressTaskId = ref('')
const progressActivity = ref('')
const progressRate = ref(50)
const inquirySummary = ref('')
const inquiryOptionsText = ref('confirm 确认继续\ncancel 暂缓')
const notices = shallowRef<NotificationRecord[]>([])
const notifications = createNotificationPort({
  host: (globalThis as { Notification?: NotificationHost }).Notification,
  onActivate: target => locate(target),
  isInputBusy: () => {
    const activeEl = typeof document !== 'undefined' ? document.activeElement : null
    return activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement
  },
})
const notificationState = ref(notifications.availability())
let eventsPrimed = false
let pollTimer: ReturnType<typeof setInterval> | undefined
let polling = false
const documentNames = computed(() => distinctNames(documents.value.map(item => ({
  name: String(item.title), hint: `${formatTime(item.createdAt)} · ${shortId(record(item.document).docId)}`,
}))))
const proposalNames = computed(() => distinctNames(proposals.value.map(item => ({
  name: String(item.reason), hint: `${formatTime(item.createdAt)} · ${shortId(item.proposalId)}`,
}))))
const selectedFacts = computed(() => selectedProposal.value ? proposalFacts(selectedProposal.value) : undefined)
const taskNames: Record<string, string> = {
  'documents.createDraft': '创建草稿',
  'proposals.create': '提交建议',
  'proposals.verify': '专职审查裁决',
  'artifacts.export': '导出固定版本',
  'artifacts.materializeToManagedDir': '受管沙箱落盘',
  'handoffs.create': '发起交接',
  'handoffs.acknowledge': '交接回执',
  'writing.generate': 'AI 辅助生成',
}
function taskName(task: Item) {
  return `${taskNames[String(task.capability)] ?? '文档任务'} ${shortId(task.taskId)}`
}
const noticeStates: Record<NotificationRecord['state'], string> = {
  submitted: '已提交到通知通道',
  'suppressed-input-busy': '输入中静默挂起',
  'suppressed-cooldown': '冷却窗口内已合并',
  'not-enabled': '系统通知未启用',
  unsupported: '此环境没有通知通道',
  failed: '提交通知失败',
}
const proposalChanges = computed(() => {
  const diff = selectedProposal.value?.diff
  return (Array.isArray(diff) ? diff : records(record(diff).changes)) as TextChange[]
})
function can(capability: string) {
  return !!client.value && capabilities.value.some(item => item.id === capability && item.available !== false)
}
function stateLabel(value: unknown) {
  const labels: Record<string, string> = { queued: '排队中', running: '执行中', committing: '提交中', succeeded: '已完成', failed: '失败',
    cancelled: '已取消', recovering: '恢复核对中', awaiting_user: '等待用户', pending_review: '待审阅', applied: '已应用',
    rejected: '已拒绝', stale: '已过期', withdrawn: '已撤回', awaiting_receipt: '等待接收方回执', accepted: '接收方已接受' }
  return labels[String(value)] ?? String(value)
}
function message(reason: unknown) {
  const value = reason as { code?: string; message?: string }
  return `${value?.code ? `${value.code} · ` : ''}${value?.message ?? '操作未完成，请刷新后重试。'}`
}
async function run(action: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await action() } catch (reason) { error.value = message(reason) }
  finally { busy.value = false }
}
async function invoke(capability: string, input: Item) {
  if (!client.value) throw new Error('请先完成系统配对。')
  return client.value.invoke({ protocol: 'marktext-documents/1', requestId: crypto.randomUUID(), capabilityVersion: 1, capability, input })
}
async function checkService() {
  const result = await props.service.status()
  available.value = result.available
  developmentHost.value = result.mode === 'development-approval-host'
  status.value = !result.available ? result.reason ?? '协作服务不可用'
    : developmentHost.value ? '服务已连接 · 开发用批准宿主' : '服务已连接 · 辅助预览'
}
async function pair() {
  pairing.value = record(await props.service.requestPairing({ name: name.value.trim() }))
  status.value = developmentHost.value ? '配对请求已登记。请在 MarkText 协作版的“协作”模块中批准，然后查询配对批准。'
    : '配对请求已登记。批准宿主尚未接通，请求保持待处理。'
}
async function claim() {
  if (!pairing.value) return
  const result = record(await props.service.claimPairing(String(pairing.value.pairingId), String(pairing.value.claimSecret)))
  if (typeof result.credential !== 'string') {
    status.value = developmentHost.value ? '配对尚未批准；请在 MarkText 协作版的“协作”模块中处理。' : '批准宿主尚未接通；本次配对保持待处理。'
    return
  }
  client.value = createAgentClient(props.service, result.credential)
  pairing.value = undefined
  description.value = record(await client.value.describe())
  const grants = records(description.value.grants)
  workspaceId.value = String(record(grants[0]?.scope).workspaceId ?? '')
  status.value = '已配对 · 仅访问当前授权范围'
  // Everything already recorded is history; only later events may notify.
  for (let page = 0, count = await refreshEvents(); count === 100 && page < 20; page++) count = await refreshEvents(true)
  eventsPrimed = true
  pollTimer = setInterval(() => void poll(), 5000)
}
async function refreshPermissions() {
  if (!client.value) return
  description.value = record(await client.value.describe())
}
async function refreshDocuments(more = false) {
  const result = record(await invoke('documents.list', { workspaceId: workspaceId.value, limit: 100,
    ...(inboxOnly.value ? { inbox: true } : {}),
    ...(more && documentCursor.value ? { cursor: documentCursor.value } : {}) }))
  documents.value = more ? [...documents.value, ...records(result.documents)] : records(result.documents)
  documentCursor.value = typeof result.cursor === 'string' ? result.cursor : undefined
}
async function openDocument(item: Item) {
  const document = record(item.document) as unknown as DocumentRef
  const result = record(await invoke('documents.read', { document }))
  const indexed = can('documents.blocks') ? record(await invoke('documents.blocks', { document, limit: 100 })) : {}
  snapshot.value = { document, title: String(item.title), markdown: String(result.markdown ?? ''), blocks: records(indexed.blocks) as unknown as MarkdownBlock[],
    saved: typeof result.saved === 'boolean' ? result.saved : undefined, provenance: result,
    pendingInput: record(result.freshness).hasUnacknowledgedInput !== false }
  blockId.value = snapshot.value.blocks[0]?.blockId ?? ''
  const suggested = can('proposals.list') ? record(await invoke('proposals.list', { document })) : {}
  proposals.value = records(suggested.proposals)
  selectedProposal.value = undefined
}
async function openProposal(item: Item) {
  selectedProposal.value = record(await invoke('proposals.get', { proposalId: String(item.proposalId) }))
  section.value = '建议面板'
}
async function track(result: unknown) {
  const receipt = record(result)
  if (typeof receipt.taskId !== 'string' || !client.value) return
  progressTaskId.value = receipt.taskId
  const task = record(await client.value.getTask(receipt.taskId))
  tasks.value = [task, ...tasks.value.filter(item => item.taskId !== task.taskId)]
  section.value = '任务中心'
}
async function createDraft() {
  const sources = parseSources(draftSources.value)
  await track(await invoke('documents.createDraft', { workspaceId: workspaceId.value, title: draftTitle.value, markdown: draftText.value,
    ...(sources.length ? { sources } : {}) }))
}
async function propose() {
  const document = snapshot.value?.document
  if (!document) return
  await track(await invoke('proposals.create', {
    base: document, operations: [{ kind: 'replaceBlock', blockId: blockId.value, markdown: replacement.value }], reason: reason.value,
    ...(parseSources(proposalSources.value).length ? { sources: parseSources(proposalSources.value) } : {}),
  }))
}
async function refreshTask(item: Item) {
  if (!client.value) return
  const task = record(await client.value.getTask(String(item.taskId)))
  tasks.value = tasks.value.map(old => old.taskId === item.taskId ? task : old)
  const result = record(task.result)
  if (typeof result.artifactId === 'string') artifactId.value = result.artifactId
  if (typeof result.handoffId === 'string') handoffId.value = result.handoffId
}
async function cancelTask(item: Item) {
  if (!client.value) return
  await client.value.cancelTask(String(item.taskId))
  await refreshTask(item)
}
async function refreshEvents(more = false) {
  if (!client.value) return 0
  const result = record(await client.value.listEvents(more ? eventCursor.value : undefined, 100))
  const incoming = records(result.events)
  events.value = mergeEvents(more ? events.value : [], incoming)
  eventCursor.value = typeof result.cursor === 'string' ? result.cursor : undefined
  if (eventsPrimed) {
    notifications.deliver(incoming)
    notices.value = notifications.records()
  } else notifications.baseline(incoming)
  const ids = new Set(incoming.map(event => record(event.data).taskId).filter(id => typeof id === 'string'))
  for (const id of ids) {
    const task = record(await client.value.getTask(id as string))
    tasks.value = [task, ...tasks.value.filter(item => item.taskId !== task.taskId)]
  }
  return incoming.length
}
async function poll() {
  if (!client.value || busy.value || polling) return
  polling = true
  try { await refreshEvents(true) } catch (reason) {
    // A lost or expired stream needs an explicit refresh; silent retries would hide it.
    clearInterval(pollTimer)
    pollTimer = undefined
    error.value = `事件自动刷新已停止：${message(reason)}`
  } finally { polling = false }
}
async function refreshAll() {
  await refreshEvents()
  if (!pollTimer) pollTimer = setInterval(() => void poll(), 5000)
}
async function enableNotifications() {
  notificationState.value = await notifications.enable()
}
/** Opening a target only shows it; nothing is applied, approved or saved from a notification. */
function locate(target: NoticeTarget) {
  if (target.section === 'proposal' && target.id) void run(() => openProposal({ proposalId: target.id }))
  else if (target.section === 'task' && target.id) {
    section.value = '任务中心'
    void run(async () => { if (client.value) await track({ taskId: target.id }) })
  } else section.value = target.section === 'inbox' ? 'Agent 收件箱' : target.section === 'proposal' ? '建议面板' : '任务中心'
}
async function share() {
  await track(await invoke('handoffs.create', {
    artifactId: artifactId.value, recipientPrincipalId: recipient.value, purpose: purpose.value,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  }))
}
async function queryHandoff() {
  handoffStatus.value = record(await invoke('handoffs.get', { handoffId: handoffId.value }))
}
async function readHandoffArtifact() {
  const handoff = record(await invoke('handoffs.get', { handoffId: handoffId.value }))
  handoffStatus.value = handoff
  const bytes: number[] = []
  let page: Item
  do {
    page = record(await invoke('artifacts.read', { artifactId: String(handoff.artifactId), handoffId: handoffId.value, offset: bytes.length, length: 65536 }))
    for (const byte of Array.isArray(page.bytes) ? page.bytes as number[] : []) bytes.push(byte)
  } while (page.eof !== true && Array.isArray(page.bytes) && page.bytes.length)
  received.value = { text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(new Uint8Array(bytes)), digest: String(page.digest),
    fileName: String(page.suggestedFileName), byteLength: bytes.length }
}
async function acknowledgeHandoff(status: 'accepted' | 'failed') {
  if (!received.value) return
  await track(await invoke('handoffs.acknowledge', { handoffId: handoffId.value, status, artifactDigest: received.value.digest }))
}
async function verifyTarget(targetKind: 'draft' | 'proposal', targetId: string) {
  await track(await invoke('proposals.verify', {
    targetKind,
    targetId,
    outcome: verifyOutcome.value,
    completionRate: Number(verifyRate.value),
    ...(verifyHint.value.trim() ? { correctionHint: verifyHint.value.trim() } : {}),
  }))
}
async function reportTaskProgress() {
  const options = inquirySummary.value.trim()
    ? inquiryOptionsText.value.split('\n').map(line => line.trim()).filter(Boolean).map((line, idx) => {
      const sep = line.search(/\s/)
      return sep < 0 ? { optionId: `opt-${idx + 1}`, label: line } : { optionId: line.slice(0, sep), label: line.slice(sep).trim() }
    })
    : []
  await invoke('tasks.updateProgress', {
    taskId: progressTaskId.value.trim(),
    currentActivity: progressActivity.value.trim(),
    completionRate: Number(progressRate.value),
    ...(inquirySummary.value.trim() && options.length ? {
      inquiry: { category: 'intent_ambiguity', summary: inquirySummary.value.trim(), options },
    } : {}),
  })
  await refreshTask({ taskId: progressTaskId.value.trim() })
}
async function materializeArtifact() {
  await track(await invoke('artifacts.materializeToManagedDir', {
    artifactId: artifactId.value.trim(),
    relativePath: managedRelativePath.value.trim(),
  }))
}
watch(blockId, id => { replacement.value = snapshot.value?.blocks?.find(block => block.blockId === id)?.markdown ?? '' })
watch([workspaceId, inboxOnly], () => { documents.value = []; documentCursor.value = undefined; snapshot.value = undefined; proposals.value = []; selectedProposal.value = undefined })
watch(handoffId, () => { received.value = undefined; handoffStatus.value = undefined })
onMounted(() => {
  document.title = 'Agent 协作 — MarkText · Dopame'
  void run(checkService)
  appWindow.on('request', request => {
    if (request.kind !== 'marktext-review') return
    const input = record(request)
    const reference = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : undefined
    const proposalId = reference(input.proposalId)
    const taskId = reference(input.taskId)
    if (proposalId) locate({ section: 'proposal', id: proposalId })
    else if (taskId) locate({ section: 'task', id: taskId })
    else if (input.section === 'inbox' || input.section === 'proposal' || input.section === 'task') locate({ section: input.section })
  })
})
onBeforeUnmount(() => clearInterval(pollTimer))
</script>

<template>
  <main
    class="collaboration-shell"
    :aria-busy="busy"
  >
    <header class="collaboration-header">
      <strong>MarkText <span>Dopame</span></strong>
      <span role="status">{{ status }}</span>
      <button
        :disabled="busy"
        @click="run(checkService)"
      >
        刷新服务状态
      </button>
    </header>
    <div class="collaboration-body">
      <nav aria-label="Agent 协作导航">
        <button
          v-for="item in sections"
          :key="item"
          :aria-current="section === item ? 'page' : undefined"
          @click="section = item"
        >
          {{ item }}
        </button>
        <p>已授权快照与建议</p>
      </nav>
      <section
        class="collaboration-content"
        :aria-label="section"
      >
        <h1>{{ section }}</h1>
        <p
          v-if="error"
          role="alert"
          class="collaboration-error"
        >
          {{ error }}
        </p>
        <p class="preview-note">
          <template v-if="developmentHost">
            这是调用方（Agent）一侧的调试面板。配对、授权以及建议的接受、拒绝、撤销都由作者在 MarkText 协作版的“协作”模块中处理（开发用批准宿主，不构成可信人工批准）；本面板只能提交建议，不能审阅。
          </template>
          <template v-else>
            建议仅供预览。受保护的人工批准通道尚未接通，接受、撤销和外部保存暂不可用。
          </template>
        </p>

        <template v-if="section === '连接与授权'">
          <section
            aria-labelledby="connection-title"
            class="collaboration-section"
          >
            <h2 id="connection-title">
              连接调用身份
            </h2>
            <p>研究与审阅分别配对。权限由系统中的用户批准，名称不代表已验证的系统身份。</p>
            <form
              v-if="!client"
              @submit.prevent="run(pair)"
            >
              <label for="principal-name">调用方名称</label>
              <input
                id="principal-name"
                v-model="name"
                maxlength="120"
                autocomplete="off"
                required
              >
              <button
                type="submit"
                :disabled="!available || busy || !!pairing"
              >
                申请配对
              </button>
            </form>
            <template v-if="pairing">
              <p>配对请求：<code>{{ pairing.pairingId }}</code></p>
              <button
                :disabled="busy"
                @click="run(claim)"
              >
                查询配对批准
              </button>
            </template>
            <template v-if="client">
              <p>连接已建立。凭据仅在当前连接中使用，关闭窗口后需重新连接。</p>
              <p>调用身份 ID：<code aria-label="调用身份 ID">{{ description.principalId }}</code>（交接产物时提供给发送方）</p>
            </template>
          </section>
          <section
            aria-labelledby="grants-title"
            class="collaboration-section"
          >
            <h2 id="grants-title">
              当前权限
            </h2>
            <p v-if="!capabilities.length">
              尚无可用权限。批准配对后才能查看能力和文档。
            </p>
            <ul v-else>
              <li
                v-for="capability in capabilities"
                :key="String(capability.id)"
              >
                {{ capability.id }} · {{ capability.available === false ? '不可用' : '已授权' }}
              </li>
            </ul>
            <button
              :disabled="!client || busy"
              @click="run(refreshPermissions)"
            >
              刷新当前权限
            </button>
            <p>{{ developmentHost ? '权限在 MarkText 协作版的“协作”模块中授予和撤销，当前客户端不能自行扩大权限。' : '受保护的授权管理通道尚未接通，当前客户端不能自行扩大权限。' }}</p>
          </section>
          <section
            class="collaboration-section"
            aria-label="系统能力状态"
          >
            <h2>系统能力</h2>
            <p>内置 AI：系统模型契约待验证。多窗口：保持单写窗口。</p>
            <p>系统通知与文件句柄交接尚未通过目标桌面验证，结果仍可在任务中心查询。</p>
            <p>
              通知通道：{{ { unsupported: '此环境不提供', granted: '已启用', denied: '已被拒绝', default: '尚未启用' }[notificationState] }}。通知只含任务类型，不含正文、路径或凭据；点击只定位，不会应用建议或保存。
            </p>
            <button
              :disabled="busy || notificationState !== 'default'"
              @click="run(enableNotifications)"
            >
              启用系统通知
            </button>
          </section>
        </template>

        <template v-else-if="section === 'Agent 收件箱'">
          <form
            class="workspace-filter"
            @submit.prevent="run(refreshDocuments)"
          >
            <label for="workspace-id">工作区</label>
            <input
              id="workspace-id"
              v-model="workspaceId"
              :disabled="busy"
              maxlength="128"
              required
            >
            <label class="inline-option"><input
              v-model="inboxOnly"
              type="checkbox"
              :disabled="busy"
            > 只看 Agent 投递的草稿</label>
            <button
              type="submit"
              :disabled="!can('documents.list') || busy"
            >
              读取已授权文档
            </button>
          </form>
          <div class="document-columns">
            <section
              aria-label="已授权草稿"
              class="collaboration-section"
            >
              <h2>草稿</h2>
              <ul
                v-if="documents.length"
                class="document-list"
              >
                <li
                  v-for="(item, index) in documents"
                  :key="String(record(item.document).docId)"
                >
                  <button
                    :disabled="busy"
                    :aria-label="`读取草稿：${documentNames[index]}`"
                    @click="run(() => openDocument(item))"
                  >
                    {{ documentNames[index] }}<small>版本 {{ record(item.document).revision }} · {{ item.inbox ? 'Agent 投递' : '作者文档' }} · 创建者 {{ item.creatorName }}</small>
                    <small>创建于 {{ formatTime(item.createdAt) }}{{ item.workflowId ? ` · 工作流 ${item.workflowId}` : '' }} · 引用 {{ sourceLinks(item.sources).length }} 条</small>
                  </button>
                </li>
              </ul>
              <p v-else>
                当前没有已读取的授权草稿。
              </p>
              <button
                v-if="documentCursor"
                :disabled="busy"
                @click="run(() => refreshDocuments(true))"
              >
                读取下一页草稿
              </button>
            </section>
            <section
              class="collaboration-section"
              aria-label="固定版本预览"
            >
              <h2>{{ snapshot?.title ?? '固定版本预览' }}</h2>
              <template v-if="snapshot">
                <p>版本 {{ snapshot.document.revision }} · 服务已提交快照{{ snapshot.pendingInput ? ' · 窗口可能仍有未同步输入' : '' }}</p>
                <p>{{ snapshot.saved === true ? '外部文件已保存此版本' : snapshot.saved === false ? '私有草稿 · 此版本尚未保存到外部文件' : '外部保存状态未知' }}</p>
                <dl
                  class="facts"
                  aria-label="草稿来源"
                >
                  <dt>创建者</dt><dd>{{ snapshot.provenance.creatorName }}（{{ shortId(snapshot.provenance.creatorPrincipalId) }}）</dd>
                  <dt>创建时间</dt><dd>{{ formatTime(snapshot.provenance.createdAt) }}</dd>
                  <dt>工作流</dt><dd>{{ snapshot.provenance.workflowId || '无' }}</dd>
                  <dt>引用</dt><dd>
                    <ul v-if="sourceLinks(snapshot.provenance.sources).length">
                      <li
                        v-for="source in sourceLinks(snapshot.provenance.sources)"
                        :key="source.uri"
                      >
                        {{ source.label }} <code>{{ source.uri }}</code>
                      </li>
                    </ul><template v-else>
                      未提供
                    </template>
                  </dd>
                </dl>
                <p>引用由调用方提供，未经验证。</p>
                <p v-if="snapshot.provenance.audit">
                  审查状态：<code>{{ record(snapshot.provenance.audit).status }}</code>
                </p>
                <pre>{{ snapshot.markdown }}</pre>
                <button
                  :disabled="!can('artifacts.export') || busy"
                  @click="run(async () => track(await invoke('artifacts.export', { document: snapshot!.document, format: 'markdown' })))"
                >
                  导出此固定版本
                </button>
                <form
                  v-if="can('proposals.verify')"
                  class="collaboration-section"
                  @submit.prevent="run(() => verifyTarget('draft', snapshot!.document.docId))"
                >
                  <h3>专职审查草稿（只审不改）</h3>
                  <label for="verify-draft-outcome">审查结论</label>
                  <select
                    id="verify-draft-outcome"
                    v-model="verifyOutcome"
                  >
                    <option value="verified">
                      verified（审查通过）
                    </option>
                    <option value="flagged_drift">
                      flagged_drift（路线偏离，退回纠偏）
                    </option>
                    <option value="quarantined_injection">
                      quarantined_injection（提示词注入隔离）
                    </option>
                  </select>
                  <label for="verify-draft-rate">完成度（0-100）</label>
                  <input
                    id="verify-draft-rate"
                    v-model.number="verifyRate"
                    type="number"
                    min="0"
                    max="100"
                  >
                  <label for="verify-draft-hint">纠偏意见（可选）</label>
                  <input
                    id="verify-draft-hint"
                    v-model="verifyHint"
                    maxlength="2048"
                  >
                  <button
                    type="submit"
                    :disabled="busy"
                  >
                    提交草稿审查裁决
                  </button>
                </form>
              </template>
              <p v-else>
                选择一份草稿查看内容，读取不会修改文档。
              </p>
            </section>
          </div>
          <form
            v-if="can('documents.createDraft')"
            class="collaboration-section"
            @submit.prevent="run(createDraft)"
          >
            <h2>投递独立草稿</h2>
            <label for="draft-title">草稿标题</label><input
              id="draft-title"
              v-model="draftTitle"
              maxlength="256"
              required
            >
            <label for="draft-markdown">Markdown 内容</label><textarea
              id="draft-markdown"
              v-model="draftText"
              rows="6"
            />
            <label for="draft-sources">引用来源（每行一个 URI，可在空格后写标签）</label><textarea
              id="draft-sources"
              v-model="draftSources"
              rows="3"
            />
            <button
              type="submit"
              :disabled="busy || !workspaceId"
            >
              创建独立草稿
            </button>
          </form>
        </template>

        <template v-else-if="section === '建议面板'">
          <section
            aria-label="建议列表"
            class="collaboration-section"
          >
            <h2>文档建议</h2>
            <ul v-if="proposals.length">
              <li
                v-for="(proposal, index) in proposals"
                :key="String(proposal.proposalId)"
              >
                <button
                  :disabled="busy"
                  :aria-label="`审阅建议：${proposalNames[index]}`"
                  @click="run(() => openProposal(proposal))"
                >
                  {{ proposalNames[index] }} · {{ stateLabel(proposal.state) }}
                  <small>来源 {{ proposal.authorName }} · 基础版本 {{ record(proposal.base).revision }} · {{ proposal.operationCount }} 处修改 · {{ formatTime(proposal.createdAt) }}</small>
                </button>
              </li>
            </ul>
            <p v-else>
              先在收件箱读取文档，查看该文档的建议。
            </p>
          </section>
          <section
            v-if="selectedProposal"
            aria-label="建议差异"
            class="collaboration-section"
          >
            <h2>{{ selectedProposal.reason }}</h2>
            <dl
              v-if="selectedFacts"
              class="facts"
              aria-label="建议信息"
            >
              <dt>状态</dt><dd>
                {{ stateLabel(selectedProposal.state) }}{{ selectedFacts.appliedRevision ? ` · 应用后版本 ${selectedFacts.appliedRevision}` : '' }}
              </dd>
              <dt>来源身份</dt><dd>{{ selectedFacts.author }}</dd>
              <dt>基础版本</dt><dd>{{ selectedFacts.baseRevision }}</dd>
              <dt>创建时间</dt><dd>{{ selectedFacts.created }}</dd>
              <dt>涉及修改</dt><dd>{{ selectedFacts.operations }} 处</dd>
              <dt>关联工作流</dt><dd>{{ selectedFacts.workflow }}</dd>
              <dt>引用</dt><dd>
                <ul v-if="selectedFacts.sources.length">
                  <li
                    v-for="source in selectedFacts.sources"
                    :key="source.uri"
                  >
                    {{ source.label }} <code>{{ source.uri }}</code>
                  </li>
                </ul><template v-else>
                  未提供
                </template>
              </dd>
            </dl>
            <p>来源身份是配对时登记的名称，不是模型自述；引用由调用方提供，未经验证。</p>
            <p
              v-if="selectedFacts?.stale"
              role="alert"
            >
              文档在此建议提交后已更新，原始差异仅供对照。请调用方读取当前版本后重新生成建议，过期建议不会被自动套用。
            </p>
            <div
              v-for="(change, index) in proposalChanges"
              :key="index"
              class="diff-pair"
            >
              <section aria-label="原文">
                <h3>原文</h3><pre>{{ change.before }}</pre>
              </section>
              <section aria-label="建议">
                <h3>建议</h3><pre>{{ change.text }}</pre>
              </section>
            </div>
            <button
              disabled
              :aria-label="`接受建议：${selectedProposal.reason}`"
              aria-describedby="approval-unavailable"
            >
              接受建议
            </button>
            <button
              disabled
              :aria-label="`拒绝建议：${selectedProposal.reason}`"
              aria-describedby="approval-unavailable"
            >
              拒绝建议
            </button>
            <button
              disabled
              :aria-label="`撤销本次接受：${selectedProposal.reason}`"
              aria-describedby="approval-unavailable"
            >
              撤销本次接受
            </button>
            <p id="approval-unavailable">
              需要受保护的人工批准通道。
            </p>
            <form
              v-if="can('proposals.verify')"
              class="collaboration-section"
              @submit.prevent="run(() => verifyTarget('proposal', String(selectedProposal!.proposalId)))"
            >
              <h3>专职审查建议（只审不改）</h3>
              <label for="verify-prop-outcome">审查结论</label>
              <select
                id="verify-prop-outcome"
                v-model="verifyOutcome"
              >
                <option value="verified">
                  verified（审查通过）
                </option>
                <option value="flagged_drift">
                  flagged_drift（路线偏离，退回纠偏）
                </option>
                <option value="quarantined_injection">
                  quarantined_injection（提示词注入隔离）
                </option>
              </select>
              <label for="verify-prop-rate">完成度（0-100）</label>
              <input
                id="verify-prop-rate"
                v-model.number="verifyRate"
                type="number"
                min="0"
                max="100"
              >
              <label for="verify-prop-hint">纠偏意见（可选）</label>
              <input
                id="verify-prop-hint"
                v-model="verifyHint"
                maxlength="2048"
              >
              <button
                type="submit"
                :disabled="busy"
              >
                提交建议审查裁决
              </button>
            </form>
          </section>
          <form
            v-if="snapshot && can('proposals.create')"
            class="collaboration-section"
            @submit.prevent="run(propose)"
          >
            <h2>提交块修改建议</h2>
            <p>基础版本 {{ snapshot.document.revision }}。原文保持不变，段落分隔按替换内容原样提交。</p>
            <label for="proposal-block">目标块</label><select
              id="proposal-block"
              v-model="blockId"
            >
              <option
                v-for="block in snapshot.blocks"
                :key="block.blockId"
                :value="block.blockId"
              >
                {{ block.type }} · {{ block.markdown.slice(0, 50) }}
              </option>
            </select>
            <label for="proposal-text">建议内容</label><textarea
              id="proposal-text"
              v-model="replacement"
              rows="6"
            />
            <label for="proposal-reason">建议理由</label><input
              id="proposal-reason"
              v-model="reason"
              maxlength="4096"
              required
            >
            <label for="proposal-sources">引用来源（每行一个 URI，可在空格后写标签）</label><textarea
              id="proposal-sources"
              v-model="proposalSources"
              rows="2"
            />
            <button
              type="submit"
              :disabled="busy || !blockId"
            >
              提交建议
            </button>
          </form>
        </template>

        <template v-else>
          <button
            :disabled="!client || busy"
            @click="run(refreshAll)"
          >
            刷新任务与事件
          </button>
          <section
            aria-label="持久任务"
            class="collaboration-section"
          >
            <h2>任务</h2>
            <p v-if="!tasks.length">
              当前没有可见任务。任务结果以服务记录为准。
            </p>
            <ul
              v-else
              class="task-list"
            >
              <li
                v-for="task in tasks"
                :key="String(task.taskId)"
              >
                <strong>{{ taskName(task) }}</strong> <span role="status">{{ stateLabel(task.state) }}</span><code>{{ task.taskId }}</code>
                <small>更新于 {{ formatTime(task.updatedAt) }}{{ task.cancelRequested ? ' · 已请求取消' : '' }}</small>
                <small v-if="task.progress">
                  当前动作：{{ record(task.progress).currentActivity }}{{ record(task.progress).completionRate !== undefined ? ` · 完成度 ${record(task.progress).completionRate}%` : '' }}
                  <template v-if="record(task.progress).inquiryResolution">
                    · 作者已选择选项：{{ record(record(task.progress).inquiryResolution).optionId }}
                  </template>
                </small>
                <p
                  v-if="task.error"
                  role="alert"
                >
                  {{ record(task.error).code }} · {{ record(task.error).message }}
                </p>
                <pre v-if="task.result">{{ JSON.stringify(task.result, null, 2) }}</pre>
                <button
                  :disabled="busy"
                  :aria-label="`查询任务：${taskName(task)}`"
                  @click="run(() => refreshTask(task))"
                >
                  查询结果
                </button>
                <button
                  :disabled="busy || task.cancellable !== true"
                  :aria-label="`取消任务：${taskName(task)}`"
                  @click="run(() => cancelTask(task))"
                >
                  取消任务
                </button>
              </li>
            </ul>
          </section>
          <form
            v-if="can('tasks.updateProgress')"
            class="collaboration-section"
            @submit.prevent="run(reportTaskProgress)"
          >
            <h2>汇报四维进度与阻塞问询</h2>
            <label for="progress-task-id">任务 ID</label><input
              id="progress-task-id"
              v-model="progressTaskId"
              required
            >
            <label for="progress-activity">当前动作</label><input
              id="progress-activity"
              v-model="progressActivity"
              maxlength="512"
              required
            >
            <label for="progress-rate">完成度（0-100）</label><input
              id="progress-rate"
              v-model.number="progressRate"
              type="number"
              min="0"
              max="100"
            >
            <label for="inquiry-summary">阻塞问询摘要（可选，留空表示正常推进或恢复执行）</label><input
              id="inquiry-summary"
              v-model="inquirySummary"
              maxlength="1024"
            >
            <label for="inquiry-options">候选选项（每行 `optionId 选项说明`）</label><textarea
              id="inquiry-options"
              v-model="inquiryOptionsText"
              rows="2"
            />
            <button
              type="submit"
              :disabled="busy"
            >
              更新任务进度
            </button>
          </form>
          <form
            v-if="can('artifacts.materializeToManagedDir')"
            class="collaboration-section"
            @submit.prevent="run(materializeArtifact)"
          >
            <h2>受管沙箱目录无窗落盘</h2>
            <p>仅将已审查通过的固定产物原子写入受管沙箱目录（<code>managed_workspace/</code>），绝不覆写用户源文档。</p>
            <label for="materialize-artifact-id">产物 ID</label><input
              id="materialize-artifact-id"
              v-model="artifactId"
              required
            >
            <label for="materialize-rel-path">受管沙箱相对路径（.md / .txt）</label><input
              id="materialize-rel-path"
              v-model="managedRelativePath"
              placeholder="deliverables/output.md"
              required
            >
            <button
              type="submit"
              :disabled="busy"
            >
              原子落盘至受管目录
            </button>
          </form>
          <form
            v-if="can('handoffs.create')"
            class="collaboration-section"
            @submit.prevent="run(share)"
          >
            <h2>交接固定产物</h2>
            <label for="artifact-id">产物 ID</label><input
              id="artifact-id"
              v-model="artifactId"
              required
            >
            <label for="recipient-id">已授权接收方 ID</label><input
              id="recipient-id"
              v-model="recipient"
              required
            >
            <label for="handoff-purpose">用途</label><input
              id="handoff-purpose"
              v-model="purpose"
              maxlength="256"
              required
            >
            <p>授权期限为 15 分钟；接收方返回业务回执后才标记已接受。</p>
            <button
              type="submit"
              :disabled="busy"
            >
              发起服务交接
            </button>
          </form>
          <form
            v-if="can('handoffs.get')"
            class="collaboration-section"
            @submit.prevent="run(queryHandoff)"
          >
            <h2>交接回执</h2>
            <label for="handoff-id">交接 ID</label><input
              id="handoff-id"
              v-model="handoffId"
              required
            >
            <button
              type="submit"
              :disabled="busy"
            >
              查询交接结果
            </button>
            <p
              v-if="handoffStatus"
              role="status"
            >
              {{ stateLabel(handoffStatus.state) }} · {{ handoffStatus.purpose }}
            </p>
          </form>
          <section
            v-if="can('artifacts.read')"
            aria-label="接收交接产物"
            class="collaboration-section"
          >
            <h2>接收交接产物</h2>
            <p>使用上方的交接 ID 按授权分块读取固定产物。确认接收后发送方才会看到业务回执。</p>
            <button
              :disabled="busy || !handoffId"
              @click="run(readHandoffArtifact)"
            >
              读取交接产物
            </button>
            <template v-if="received">
              <p>
                {{ received.fileName }} · {{ received.byteLength }} 字节 · 摘要 <code>{{ received.digest }}</code>
              </p>
              <pre aria-label="交接产物内容">{{ received.text.length > 4000 ? `${received.text.slice(0, 4000)}\n…（仅显示前 4000 个字符）` : received.text }}</pre>
              <button
                :disabled="busy || !can('handoffs.acknowledge')"
                :aria-label="`确认接收：${received.fileName}`"
                @click="run(() => acknowledgeHandoff('accepted'))"
              >
                确认接收
              </button>
              <button
                :disabled="busy || !can('handoffs.acknowledge')"
                :aria-label="`报告接收失败：${received.fileName}`"
                @click="run(() => acknowledgeHandoff('failed'))"
              >
                报告接收失败
              </button>
            </template>
          </section>
          <section
            aria-label="通知记录"
            class="collaboration-section"
          >
            <h2>通知记录</h2>
            <p>通知不是结果账本；即使通知未显示，结果仍以上方任务记录为准。</p>
            <ul v-if="notices.length">
              <li
                v-for="notice in notices"
                :key="notice.key"
              >
                {{ notice.title }} · {{ noticeStates[notice.state] }} · {{ formatTime(notice.at) }}
                <button
                  :disabled="busy"
                  :aria-label="`定位通知：${notice.title}`"
                  @click="locate(notice.target)"
                >
                  定位
                </button>
              </li>
            </ul><p v-else>
              连接后新到达的草稿、待审建议、导出完成和任务失败会记录在这里。
            </p>
          </section>
          <section
            aria-label="持久事件"
            class="collaboration-section"
          >
            <h2>事件</h2><ul>
              <li
                v-for="event in events"
                :key="String(event.eventId ?? event.id)"
              >
                {{ event.type }} · {{ formatTime(event.createdAt) }}
              </li>
            </ul><p v-if="!events.length">
              当前没有可见事件。
            </p>
            <button
              v-if="eventCursor"
              :disabled="busy"
              @click="run(() => refreshEvents(true))"
            >
              读取后续事件
            </button>
          </section>
        </template>
      </section>
    </div>
  </main>
</template>

<style scoped>
.collaboration-shell { height: 100vh; display: flex; flex-direction: column; --muted: #606975; }
.collaboration-header { display: flex; align-items: center; gap: 24px; padding: 14px 22px; border-bottom: 1px solid var(--line); }
.collaboration-header strong { font-size: 16px; white-space: nowrap; }
.collaboration-header strong span { color: var(--muted); font-weight: 400; font-size: 12px; margin-left: 6px; }
.collaboration-header [role='status'] { flex: 1; color: var(--muted); }
.collaboration-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 224px minmax(0, 1fr); }
.collaboration-body > nav { background: var(--panel); border-right: 1px solid var(--line); padding: 20px 12px; }
.collaboration-body > nav button { display: block; width: 100%; text-align: left; margin-bottom: 4px; }
.collaboration-body > nav button[aria-current='page'] { background: var(--line); font-weight: 600; }
.collaboration-body > nav p { padding: 20px 10px; font-size: 12px; color: var(--muted); }
.collaboration-content { min-width: 0; overflow: auto; padding: 24px 32px; }
h1 { margin: 0 0 16px; font-size: 24px; font-weight: 600; }
h2 { font-size: 16px; margin: 0 0 12px; } h3 { font-size: 13px; margin: 0 0 8px; }
p { color: var(--muted); line-height: 1.7; } ul { padding-left: 20px; line-height: 1.8; }
.preview-note { padding: 12px 16px; background: var(--panel); border-left: 2px solid var(--accent); }
.collaboration-section { padding: 20px 0; border-bottom: 1px solid var(--line); }
.collaboration-error { color: #a32835; }
form label { display: block; margin: 14px 0 8px; font-weight: 500; }
form input, form select, form textarea { display: block; width: 100%; max-width: 660px; margin-bottom: 12px; }
textarea { font: inherit; color: inherit; padding: 10px; background: var(--surface); border: 1px solid var(--line); border-radius: 5px; resize: vertical; }
button { border: 1px solid var(--line); min-height: 34px; }
button:disabled { color: var(--muted); background: var(--panel); opacity: 1; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, monospace; line-height: 1.7; padding: 14px; background: var(--panel); max-height: 420px; overflow: auto; }
code { overflow-wrap: anywhere; font-family: ui-monospace, monospace; }
.document-columns { display: grid; grid-template-columns: minmax(180px, 1fr) minmax(0, 2fr); gap: 24px; }
.document-list { list-style: none; padding: 0; } .document-list button { width: 100%; text-align: left; margin-bottom: 8px; }
small { display: block; font-size: 12px; color: var(--muted); margin-top: 6px; }
.diff-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.task-list { list-style: none; padding: 0; } .task-list > li { padding: 16px 0; border-bottom: 1px solid var(--line); }
.task-list code { display: block; margin: 8px 0; font-size: 12px; }
.collaboration-section li > button { text-align: left; }
.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 16px; margin: 12px 0; }
.facts dt { color: var(--muted); } .facts dd { margin: 0; overflow-wrap: anywhere; } .facts ul { margin: 0; }
.inline-option { display: flex; align-items: center; gap: 8px; font-weight: 400; }
form .inline-option input { display: inline; width: auto; margin: 0; }
@media (max-width: 800px) {
  .collaboration-body { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); }
  .collaboration-body > nav { display: flex; overflow-x: auto; padding: 8px; border-right: 0; border-bottom: 1px solid var(--line); }
  .collaboration-body > nav button { white-space: nowrap; width: auto; margin: 0 4px 0 0; }
  .collaboration-body > nav p { display: none; }
  .collaboration-content { padding: 20px; } .document-columns, .diff-pair { grid-template-columns: 1fr; }
  .collaboration-header { flex-wrap: wrap; gap: 10px; padding: 12px 20px; }
}
</style>
