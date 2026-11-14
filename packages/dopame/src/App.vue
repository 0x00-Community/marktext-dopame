<script setup lang="ts">
import { computed, markRaw, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { window as appWindow } from 'acde:window'
import Editor from './Editor.vue'
import { fs, openFiles, readResource, saveAs, saveResource, type OpenedFile } from './files'
import { createDocument, isDirty, outline, updateDocument, type DocumentTab } from './document'

type EditorView = InstanceType<typeof Editor>
type Heading = { lvl: number; content: string; slug: string }
const tabs = reactive<DocumentTab[]>([])
const activeId = ref('')
const active = computed(() => tabs.find(tab => tab.id === activeId.value))
const editors = new Map<string, EditorView>()
const outlines = reactive<Record<string, Heading[]>>({})
const headings = computed(() => active.value?.mode === 'source'
  ? outline(active.value.text) : outlines[activeId.value] ?? [])
const error = ref('')
const status = ref('就绪')
const dark = ref(localStorage.getItem('theme') === 'dark')
const searchOpen = ref(false)
const search = ref('')
const replacement = ref('')
const roots = ref<Awaited<ReturnType<typeof fs.roots>>>([])
const root = ref('private')
const folder = ref('')
const entries = ref<{ name: string; kind: string }[]>([])
const truncated = ref(false)
const closing = ref<DocumentTab[] | null>(null)
let closeAction: (() => void) | null = null
let draftTimer: ReturnType<typeof setTimeout>
let draftQueue = Promise.resolve()

function report(reason: unknown) {
  if (reason instanceof Error && reason.name === 'AbortError') return
  error.value = reason instanceof Error ? reason.message : String(reason)
}

async function run(action: () => unknown | Promise<unknown>) {
  error.value = ''
  try { await action() } catch (reason) { report(reason) }
}

function remember() {
  clearTimeout(draftTimer)
  draftTimer = setTimeout(() => void persist(), 400)
}

function persist() {
  clearTimeout(draftTimer)
  const snapshot = JSON.stringify({ version: 1, activeId: activeId.value,
    tabs: tabs.map(tab => ({ ...tab, saving: false,
      resource: tab.resource?.kind === 'root' ? tab.resource : null,
      savedText: tab.resource?.kind === 'handle' ? null : tab.savedText })) })
  draftQueue = draftQueue.then(async () => {
    await fs.writeFile('private', '.marktext/session.json', snapshot, { mkdirs: true })
  }).catch(report)
  return draftQueue
}

function attach(name: string, text = '', resource: OpenedFile['resource'] | null = null) {
  editors.get(activeId.value)?.flush()
  const tab = createDocument(name, text, resource ? markRaw(resource) : null)
  tabs.push(tab)
  activeId.value = tab.id
  remember()
  return tab
}

async function addFile(file: OpenedFile) {
  for (const tab of tabs) {
    const current = tab.resource
    if (current?.kind === 'root' && file.resource.kind === 'root'
      && current.root === file.resource.root && current.path === file.resource.path) {
      select(tab.id)
      return
    }
    if (current?.kind === 'handle' && file.resource.kind === 'handle'
      && await current.handle.isSameEntry(file.resource.handle)) {
      select(tab.id)
      return
    }
  }
  attach(file.name, file.text, file.resource)
}

function select(id: string) {
  editors.get(activeId.value)?.flush()
  activeId.value = id
  remember()
}

function change(tab: DocumentTab, text: string) {
  updateDocument(tab, text)
  remember()
}

function setMode(mode: DocumentTab['mode']) {
  if (!active.value) return
  editors.get(activeId.value)?.flush()
  active.value.mode = mode
  remember()
}

async function open() {
  for (const file of await openFiles()) await addFile(file)
}

async function save(tab = active.value, copy = false) {
  if (!tab || tab.saving) return
  editors.get(tab.id)?.flush()
  const snapshot = tab.text
  tab.saving = true
  try {
    if (copy || !tab.resource) {
      const saved = await saveAs(tab.name, snapshot)
      tab.name = saved.name
      tab.resource = markRaw(saved.resource)
    } else tab.resource = markRaw(await saveResource(tab.resource, snapshot))
    tab.savedText = snapshot
    status.value = `已保存 ${tab.name}`
    await persist()
    await refreshFolder()
  } finally { tab.saving = false }
}

async function newNote() {
  const name = `笔记-${Date.now()}.md`
  await fs.writeFile('private', `notes/${name}`, '', { create: 'new', mkdirs: true })
  await addFile(await readResource({ kind: 'root', root: 'private', path: `notes/${name}` }))
  root.value = 'private'
  folder.value = 'notes'
  await refreshFolder()
}

async function refreshFolder() {
  const listing = await fs.list(root.value, folder.value, false)
  entries.value = listing.entries.filter(item => item.kind === 'directory' || /\.(md|markdown|txt)$/i.test(item.name))
    .sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name))
  truncated.value = listing.truncated
}

async function enter(entry: { name: string; kind: string }) {
  const path = [folder.value, entry.name].filter(Boolean).join('/')
  if (entry.kind === 'directory') {
    folder.value = path
    await refreshFolder()
  } else await addFile(await readResource({ kind: 'root', root: root.value, path }))
}

async function pickFolder() {
  const picker = window as unknown as Window & { showDirectoryPicker(options: { mode: string }): Promise<FileSystemDirectoryHandle> }
  await picker.showDirectoryPicker({ mode: 'readwrite' })
  roots.value = await fs.roots()
  status.value = '文件夹已授权，请在位置列表中选择'
}

function removeTab(id: string) {
  const index = tabs.findIndex(tab => tab.id === id)
  tabs.splice(index, 1)
  editors.delete(id)
  delete outlines[id]
  if (!tabs.length) attach('未命名.md')
  else if (activeId.value === id) activeId.value = tabs[Math.min(index, tabs.length - 1)].id
  remember()
}

function requestClose(tab: DocumentTab) {
  editors.get(tab.id)?.flush()
  if (!isDirty(tab)) { removeTab(tab.id); return }
  closing.value = [tab]
  closeAction = () => removeTab(tab.id)
}

function finishClose() {
  const action = closeAction
  closing.value = null
  closeAction = null
  action?.()
}

async function saveAndClose() {
  const documents = closing.value
  if (!documents) return
  for (const tab of documents) await save(tab)
  if (documents.some(isDirty)) return
  finishClose()
}

async function checkExternal() {
  const tab = active.value
  if (!tab?.resource || tab.saving) return
  const latest = await readResource(tab.resource)
  if (latest.text === tab.savedText) return
  if (isDirty(tab)) {
    error.value = `${tab.name} 已在外部修改，本地编辑已保留；请另存为，或先复制内容后重新打开。`
    return
  }
  const index = tabs.indexOf(tab)
  const refreshed = createDocument(latest.name, latest.text, markRaw(latest.resource))
  refreshed.mode = tab.mode
  tabs.splice(index, 1, refreshed)
  activeId.value = refreshed.id
  editors.delete(tab.id)
  remember()
}

function find(backwards = false) {
  editors.get(activeId.value)?.find(search.value, backwards)
}

watch(dark, value => {
  document.documentElement.dataset.theme = value ? 'dark' : 'light'
  document.documentElement.style.colorScheme = value ? 'dark' : 'light'
  localStorage.setItem('theme', value ? 'dark' : 'light')
}, { immediate: true })
watch(() => [active.value?.name, active.value?.text, active.value?.savedText], () => {
  document.title = `${active.value && isDirty(active.value) ? '● ' : ''}${active.value?.name ?? 'MarkText'} — MarkText · Dopame`
})
watch(search, () => find())

onMounted(async () => {
  try {
    const { text } = await fs.readText('private', '.marktext/session.json')
    const session = JSON.parse(text)
    if (session.version !== 1 || !Array.isArray(session.tabs)) throw new Error('无法读取草稿格式，原记录未覆盖')
    for (const tab of session.tabs) tabs.push({ ...tab, saving: false })
    activeId.value = tabs.some(tab => tab.id === session.activeId) ? session.activeId : tabs[0]?.id ?? ''
    if (tabs.length) status.value = '已恢复上次会话；外部单文件请另存为以重新授权'
  } catch (reason) {
    if ((reason as { code?: string }).code !== 'ENOENT') report(reason)
  }
  if (!tabs.length) attach('未命名.md')
  await run(async () => {
    roots.value = await fs.roots()
    await refreshFolder()
  })
  appWindow.on('request', request => {
    if (request.kind !== 'open-file') return
    void run(async () => {
      const handle = (request as { handle: FileSystemFileHandle }).handle
      const file = await handle.getFile()
      await addFile(await readResource({ kind: 'handle', handle, modifiedMs: file.lastModified, size: file.size }))
    })
  })
  appWindow.on('activate', () => void run(checkExternal))
  appWindow.on('beforeclose', () => {
    for (const editor of editors.values()) editor.flush()
    const dirty = tabs.filter(isDirty)
    if (!dirty.length) { void persist(); return true }
    closing.value = dirty
    closeAction = () => { void persist().then(() => appWindow.close()) }
    return false
  })
  appWindow.setMenus([{ id: 'file', label: '文件', items: [
    { id: 'new', label: '新建', onSelect: () => { attach('未命名.md') } },
    { id: 'open', label: '打开…', onSelect: () => void run(open) },
    { id: 'save', label: '保存', onSelect: () => void run(() => save()) },
    { id: 'save-as', label: '另存为…', onSelect: () => void run(() => save(active.value, true)) },
  ] }])
  document.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.isComposing) return
    const key = event.key.toLowerCase()
    if (!['s', 'o', 'n', 'f'].includes(key)) return
    event.preventDefault()
    if (key === 's') void run(() => save(active.value, event.shiftKey))
    if (key === 'o') void run(open)
    if (key === 'n') attach('未命名.md')
    if (key === 'f') {
      searchOpen.value = true
      void nextTick(() => document.querySelector<HTMLInputElement>('#find-text')?.focus())
    }
  })
})
</script>

<template>
  <main class="app-shell">
    <header class="toolbar" aria-label="文档工具栏">
      <strong class="brand">MarkText <span>Dopame</span></strong>
      <button @click="attach('未命名.md')" title="Ctrl+N">新建</button>
      <button @click="run(open)" title="Ctrl+O">打开</button>
      <button :disabled="active?.saving" @click="run(() => save())" title="Ctrl+S">保存</button>
      <button @click="run(() => save(active, true))">另存为</button>
      <span class="divider" />
      <button :disabled="active?.mode === 'read'" @mousedown.prevent @click="editors.get(activeId)?.undo()">撤销</button>
      <button :disabled="active?.mode === 'read'" @mousedown.prevent @click="editors.get(activeId)?.redo()">重做</button>
      <button @click="searchOpen = !searchOpen">查找替换</button>
      <span class="spacer" />
      <div class="modes" aria-label="编辑模式">
        <button :aria-pressed="active?.mode === 'edit'" @click="setMode('edit')">编辑</button>
        <button :aria-pressed="active?.mode === 'source'" @click="setMode('source')">源码</button>
        <button :aria-pressed="active?.mode === 'read'" @click="setMode('read')">阅读</button>
      </div>
      <button @click="dark = !dark" aria-label="切换主题">{{ dark ? '浅色' : '深色' }}</button>
    </header>
    <div v-if="error" role="alert" class="error-banner"><span>{{ error }}</span><button @click="error = ''">关闭提示</button></div>
    <section class="workspace">
      <aside class="sidebar" aria-label="文件与大纲">
        <div class="section-heading">文件 <button @click="run(pickFolder)">添加文件夹</button></div>
        <select v-model="root" aria-label="文件位置" @change="folder = ''; run(refreshFolder)">
          <option v-for="item in roots" :key="item.id" :value="item.id">{{ item.id === 'private' ? '我的笔记' : item.label }} · {{ item.id.slice(-6) }}</option>
        </select>
        <div class="folder-actions"><button @click="run(newNote)">新建笔记</button><button @click="run(refreshFolder)">刷新</button></div>
        <button v-if="folder" class="parent-folder" @click="folder = folder.split('/').slice(0, -1).join('/'); run(refreshFolder)">← {{ folder }}</button>
        <nav class="files" aria-label="文件列表">
          <button v-for="entry in entries" :key="entry.name" @click="run(() => enter(entry))"><span>{{ entry.kind === 'directory' ? '▸' : '≡' }}</span>{{ entry.name }}</button>
          <p v-if="!entries.length" class="hint">此处没有 Markdown 文件</p>
          <p v-if="truncated" class="hint">目录内容过多，列表已截断</p>
        </nav>
        <div class="section-heading outline-title">文档大纲</div>
        <nav class="outline" aria-label="文档大纲">
          <button v-for="(item, index) in headings" :key="index" :style="{ paddingLeft: `${12 + (item.lvl - 1) * 12}px` }" @click="editors.get(activeId)?.reveal(item.slug, index)">{{ item.content }}</button>
          <p v-if="!headings.length" class="hint">标题会显示在这里</p>
        </nav>
      </aside>
      <section class="documents">
        <nav class="tabs" role="tablist" aria-label="打开的文档">
          <div v-for="tab in tabs" :key="tab.id" class="tab" :class="{ selected: tab.id === activeId }">
            <button role="tab" :aria-selected="tab.id === activeId" @click="select(tab.id)">{{ isDirty(tab) ? '● ' : '' }}{{ tab.name }}</button>
            <button :aria-label="`关闭 ${tab.name}`" @click="requestClose(tab)">×</button>
          </div>
        </nav>
        <div v-if="searchOpen" class="search-bar" aria-label="查找替换">
          <input id="find-text" v-model="search" aria-label="查找文本" placeholder="查找" @keydown.enter="find()">
          <button @click="find(true)">上一个</button><button @click="find()">下一个</button>
          <input v-model="replacement" aria-label="替换文本" placeholder="替换为">
          <button :disabled="active?.mode === 'read'" @click="editors.get(activeId)?.replace(replacement, false)">替换</button>
          <button :disabled="active?.mode === 'read'" @click="editors.get(activeId)?.replace(replacement, true)">全部替换</button>
          <button @click="searchOpen = false; search = ''">收起</button>
        </div>
        <Editor v-for="tab in tabs" v-show="tab.id === activeId" :key="tab.id"
          :ref="view => { if (view) editors.set(tab.id, view as EditorView) }"
          :text="tab.text" :mode="tab.mode" :active="tab.id === activeId"
          @change="text => change(tab, text)" @outline="items => outlines[tab.id] = items" />
      </section>
    </section>
    <footer role="status"><span>{{ status }}</span><span v-if="active">{{ active.saving ? '保存中…' : isDirty(active) ? '未保存' : '已保存' }} · {{ active.text.length }} 字符 · UTF-8{{ active.bom ? ' BOM' : '' }} · {{ active.eol === '\r\n' ? 'CRLF' : 'LF' }}</span></footer>
    <div v-if="closing" class="dialog-backdrop">
      <section role="dialog" aria-modal="true" aria-labelledby="close-title" class="dialog">
        <h2 id="close-title">保存未完成的修改？</h2><p>{{ closing.map(tab => tab.name).join('、') }}</p>
        <p class="hint">草稿保存在应用中；原文件只在保存成功后更新。</p>
        <div class="dialog-actions"><button @click="closing = null; closeAction = null">取消</button><button @click="finishClose">不保存并关闭</button><button class="primary" @click="run(saveAndClose)">保存并关闭</button></div>
      </section>
    </div>
  </main>
</template>
