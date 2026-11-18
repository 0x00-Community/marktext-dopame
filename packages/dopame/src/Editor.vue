<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Muya, zhCN, InlineFormatToolbar, ParagraphFrontButton, ParagraphFrontMenu,
  ParagraphQuickInsertMenu, TableChessboard, TableColumnToolbar, TableDragBar,
  TableRowColumMenu, CodeBlockLanguageSelector, LinkTools } from '@muyajs/core'
import CodeMirror from 'codemirror'
import 'codemirror/lib/codemirror.css'
import 'codemirror/mode/gfm/gfm'
import 'codemirror/addon/search/searchcursor'
import { shortcutHint } from './shortcuts'
import { editorText, outline } from './document'
import { createEditorPortTracker } from './editor/editorPort'
import { loadDocumentImage, type Resource } from './files'
import { attachNativeSelection } from './nativeSelection'
import { DEFAULT_PREFERENCES, type EditorPreferences } from './preferences'

const props = defineProps<{
  text: string
  resource: Resource | null
  mode: 'edit' | 'source' | 'read'
  active: boolean
  blocked?: boolean
  preferences?: EditorPreferences
}>()
const emit = defineEmits<{ change: [text: string]; outline: [items: { lvl: number; content: string; slug: string }[]] }>()
const richHost = ref<HTMLElement>()
const sourceHost = ref<HTMLElement>()
let muya: Muya
let source: CodeMirror.Editor
let syncing = false
let richText = ''
let sourceText = ''
let searchText = ''
const portTracker = createEditorPortTracker()
let detachSelection: (() => void) | undefined

function isInputBusy() {
  return portTracker.isInputBusy()
}

function compositionStart() {
  portTracker.onCompositionStart()
}

function compositionEnd() {
  portTracker.onCompositionEnd()
}

function getPortState() {
  return portTracker.getState()
}

function acknowledgeCommit(revision: string, seq?: number) {
  portTracker.onCommitted(revision, seq)
}

async function flushCompletedInput() {
  await portTracker.waitForCompositionSettle()
  flush()
}

function protectInput(event: Event) {
  if (!props.blocked) return
  event.preventDefault()
  event.stopImmediatePropagation()
}

function syncReadOnly() {
  if (!muya || !source) return
  muya.setReadOnly(props.mode === 'read' || !!props.blocked)
  source.setOption('readOnly', props.blocked ? 'nocursor' : false)
}

for (const plugin of [InlineFormatToolbar, ParagraphFrontButton, ParagraphFrontMenu,
  ParagraphQuickInsertMenu, TableChessboard, TableColumnToolbar, TableDragBar,
  TableRowColumMenu, CodeBlockLanguageSelector, LinkTools]) {
  if (!Muya.plugins.some(item => item.plugin === plugin)) Muya.use(plugin, { keyboardShortcuts: false, getShortcut: shortcutHint })
}

function publish() {
  if (syncing) return
  const text = props.mode === 'source' ? source.getValue() : muya.getMarkdown()
  if (props.mode === 'source') sourceText = text
  else richText = text
  portTracker.onLocalEdit()
  emit('change', text)
  emit('outline', muya.getTOC())
}

async function syncMode() {
  if (!muya) return
  syncing = true
  const text = editorText(props.text)
  if (props.mode === 'source') {
    if (sourceText !== text) {
      source.operation(() => source.replaceRange(text, { line: 0, ch: 0 },
        { line: source.lastLine(), ch: source.getLine(source.lastLine()).length }, '+mode'))
      sourceText = text
    }
  } else {
    muya.setReadOnly(false)
    if (richText !== text) {
      muya.replaceContent(text)
      richText = text
    }
    muya.setReadOnly(props.mode === 'read' || !!props.blocked)
    muya.domNode.setAttribute('aria-label', props.mode === 'read' ? 'Markdown 阅读预览' : 'Markdown 编辑器')
    emit('outline', muya.getTOC())
  }
  syncing = false
  await nextTick()
  syncReadOnly()
  if (props.mode === 'source') { source.refresh(); if (props.active && !props.blocked) source.focus() }
}

function flush() {
  if (muya && props.mode === 'edit') muya.flush()
}

function undo() {
  if (props.blocked || isInputBusy()) return
  if (props.mode === 'source') { source.undo(); source.focus() }
  else if (props.mode === 'edit') { muya.flush(); muya.undo(); muya.focus() }
}

function redo() {
  if (props.blocked || isInputBusy()) return
  if (props.mode === 'source') { source.redo(); source.focus() }
  else if (props.mode === 'edit') { muya.redo(); muya.focus() }
}

function command(action: string) {
  if (props.mode !== 'edit' || props.blocked || isInputBusy()) return
  muya.flush()
  if (action.startsWith('format:')) muya.format(action.slice(7))
  else if (action.startsWith('paragraph:')) muya.updateParagraph(action.slice(10))
  muya.focus()
  const selection = muya.getSelectionState()
  const node = document.getSelection()?.focusNode
  const element = node?.nodeType === Node.ELEMENT_NODE ? node as Element : node?.parentElement
  element?.closest<HTMLElement>('[contenteditable="true"]')?.focus({ preventScroll: true })
  if (selection) muya.setSelection(selection)
}

function find(text: string, backwards = false) {
  if (props.blocked) return
  searchText = text
  if (props.mode !== 'source') {
    muya.search(text, { isRegexp: false })
    if (text) muya.find(backwards ? 'previous' : 'next')
    return
  }
  if (!text) return
  let cursor = source.getSearchCursor(text, source.getCursor(backwards ? 'from' : 'to'))
  if (!cursor.find(backwards)) {
    cursor = source.getSearchCursor(text, backwards
      ? { line: source.lastLine(), ch: source.getLine(source.lastLine()).length }
      : { line: 0, ch: 0 })
    if (!cursor.find(backwards)) return
  }
  source.setSelection(cursor.from(), cursor.to())
  source.scrollIntoView({ from: cursor.from(), to: cursor.to() })
}

function replace(text: string, all: boolean) {
  if (!searchText || props.mode === 'read' || props.blocked || isInputBusy()) return
  if (props.mode !== 'source') {
    muya.replace(text, { isSingle: !all, isRegexp: false })
    return
  }
  source.operation(() => {
    if (all) {
      const cursor = source.getSearchCursor(searchText, { line: 0, ch: 0 })
      while (cursor.findNext()) cursor.replace(text)
    } else if (source.getSelection() === searchText) source.replaceSelection(text)
  })
}

/**
 * Shows text committed elsewhere (an accepted proposal, an undo) as one undo step of its own, without
 * reporting it back as an edit: the caller already holds that text.
 */
function applyExternal(text: string) {
  const next = editorText(text)
  syncing = true
  try {
    if (props.mode === 'source') {
      if (source.getValue() !== next) {
        source.operation(() => source.replaceRange(next, { line: 0, ch: 0 },
          { line: source.lastLine(), ch: source.getLine(source.lastLine()).length }, 'collab'))
      }
      sourceText = next
    } else {
      muya.replaceContent(next)
      richText = next
      emit('outline', muya.getTOC())
    }
  } finally { syncing = false }
}

function reveal(slug: string, index: number) {
  if (props.blocked) return
  if (props.mode === 'source') {
    const heading = outline(source.getValue())[index]
    if (!heading) return
    source.focus()
    source.setCursor({ line: heading.line, ch: 0 })
    source.scrollIntoView(source.getCursor(), 80)
  } else {
    const heading = Array.from(richHost.value!.querySelectorAll('[id]')).find(node => node.id === slug)
    heading?.scrollIntoView({ block: 'center' })
  }
}

function insertSnippet(snippet: string) {
  if (props.mode === 'read' || props.blocked || isInputBusy()) return
  flush()
  if (props.mode === 'source' && source) {
    source.operation(() => {
      source.replaceSelection(snippet)
    })
    source.focus()
    return
  }
  const current = muya ? muya.getMarkdown() : editorText(props.text)
  const separator = current.length && !current.endsWith('\n') ? '\n\n' : current.endsWith('\n\n') ? '' : current.length ? '\n' : ''
  const next = `${current}${separator}${snippet}\n`
  muya.replaceContent(next)
  richText = next
  portTracker.onLocalEdit()
  emit('change', next)
  emit('outline', muya.getTOC())
}

function findNthIndexOf(haystack: string, needle: string, n: number): number {
  let idx = -1
  for (let i = 0; i <= n; i++) {
    idx = haystack.indexOf(needle, idx + 1)
    if (idx < 0) return -1
  }
  return idx
}

function getSelectedRange(): { start: number; end: number; excerpt: string } {
  flush()
  const full = props.mode === 'source' && source ? source.getValue() : (muya ? muya.getMarkdown() : editorText(props.text))
  if (props.mode === 'source' && source) {
    const from = source.indexFromPos(source.getCursor('from'))
    const to = source.indexFromPos(source.getCursor('to'))
    if (to >= from) {
      return { start: from, end: to, excerpt: full.slice(from, to) }
    }
  } else if (typeof window !== 'undefined') {
    const sel = window.getSelection()
    const domSelected = sel?.toString()?.trim()
    if (domSelected) {
      let precedingOccurrences = 0
      if (richHost.value && sel?.rangeCount) {
        const range = sel.getRangeAt(0)
        const preRange = document.createRange()
        preRange.selectNodeContents(richHost.value)
        try {
          preRange.setEnd(range.startContainer, range.startOffset)
          const preText = preRange.toString()
          let pos = -1
          while ((pos = preText.indexOf(domSelected, pos + 1)) >= 0) precedingOccurrences++
        } catch { /* selection outside richHost */ }
      }
      const nthIdx = findNthIndexOf(full, domSelected, precedingOccurrences)
      const idx = nthIdx >= 0 ? nthIdx : full.indexOf(domSelected)
      if (idx >= 0) return { start: idx, end: idx + domSelected.length, excerpt: domSelected }
    }
  }
  return { start: 0, end: full.length, excerpt: full }
}

function applyPreferences() {
  const prefs = props.preferences ?? DEFAULT_PREFERENCES
  if (richHost.value) {
    richHost.value.style.fontSize = `${prefs.fontSize}px`
    richHost.value.style.lineHeight = String(prefs.lineHeight)
  }
  if (source) {
    source.setOption('lineNumbers', prefs.lineNumbers)
  }
}

onMounted(() => {
  const prefs = props.preferences ?? DEFAULT_PREFERENCES
  richText = sourceText = editorText(props.text)
  const container = document.createElement('div')
  richHost.value!.appendChild(container)
  muya = new Muya(container, { markdown: richText, fontSize: prefs.fontSize, lineHeight: prefs.lineHeight,
    loadImage: src => loadDocumentImage(props.resource, src),
    spellcheckEnabled: false, disableHtml: true, autoPairMarkdownSyntax: prefs.autoPairMarkdownSyntax })
  muya.locale(zhCN)
  muya.init({ focus: false })
  detachSelection = attachNativeSelection(muya)
  muya.domNode.setAttribute('aria-label', 'Markdown 编辑器')
  source = CodeMirror(sourceHost.value!, { value: sourceText, mode: 'gfm', lineNumbers: prefs.lineNumbers,
    lineWrapping: true, tabSize: 2, indentUnit: 2, inputStyle: 'textarea',
    extraKeys: { 'Ctrl-S': () => {}, 'Cmd-S': () => {} } })
  source.getInputField().setAttribute('aria-label', 'Markdown 源码')
  muya.on('json-change', publish)
  source.on('change', publish)
  applyPreferences()
  emit('outline', muya.getTOC())
  void syncMode()
})
watch(() => props.mode, syncMode)
watch(() => props.blocked, syncReadOnly, { flush: 'sync' })
watch(() => props.preferences, applyPreferences, { deep: true })
watch(() => props.resource, () => muya?.invalidateImageCache())
watch(() => props.active, async active => {
  if (!active) return
  await nextTick()
  if (props.mode === 'source') { source.refresh(); if (props.active && !props.blocked) source.focus() }
})
onBeforeUnmount(() => { detachSelection?.(); muya?.destroy() })
defineExpose({ flush, flushCompletedInput, getPortState, acknowledgeCommit, insertSnippet, getSelectedRange, undo, redo, command, find, replace, reveal, isInputBusy, applyExternal })
</script>

<template>
  <section class="editor-panel" :aria-busy="blocked || undefined"
    @compositionstart.capture="compositionStart" @compositionend.capture="compositionEnd"
    @beforeinput.capture="protectInput"
    @paste.capture="protectInput" @cut.capture="protectInput" @drop.capture="protectInput">
    <div v-show="mode !== 'source'" ref="richHost" class="rich-editor" />
    <div v-show="mode === 'source'" ref="sourceHost" class="source-editor" />
  </section>
</template>
