<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Muya, zhCN, InlineFormatToolbar, ParagraphFrontButton, ParagraphFrontMenu,
  ParagraphQuickInsertMenu, TableChessboard, TableColumnToolbar, TableDragBar,
  TableRowColumMenu, CodeBlockLanguageSelector, LinkTools } from '@muyajs/core'
import CodeMirror from 'codemirror'
import 'codemirror/lib/codemirror.css'
import 'codemirror/mode/gfm/gfm'
import 'codemirror/addon/search/searchcursor'
import { editorText, outline } from './document'
import { attachNativeSelection } from './nativeSelection'

const props = defineProps<{ text: string; mode: 'edit' | 'source' | 'read'; active: boolean }>()
const emit = defineEmits<{ change: [text: string]; outline: [items: { lvl: number; content: string; slug: string }[]] }>()
const richHost = ref<HTMLElement>()
const sourceHost = ref<HTMLElement>()
let muya: Muya
let source: CodeMirror.Editor
let syncing = false
let richText = ''
let sourceText = ''
let searchText = ''
let detachSelection: (() => void) | undefined

for (const plugin of [InlineFormatToolbar, ParagraphFrontButton, ParagraphFrontMenu,
  ParagraphQuickInsertMenu, TableChessboard, TableColumnToolbar, TableDragBar,
  TableRowColumMenu, CodeBlockLanguageSelector, LinkTools]) {
  if (!Muya.plugins.some(item => item.plugin === plugin)) Muya.use(plugin)
}

function publish() {
  if (syncing) return
  const text = props.mode === 'source' ? source.getValue() : muya.getMarkdown()
  if (props.mode === 'source') sourceText = text
  else richText = text
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
    muya.setReadOnly(props.mode === 'read')
    muya.domNode.setAttribute('aria-label', props.mode === 'read' ? 'Markdown 阅读预览' : 'Markdown 编辑器')
    emit('outline', muya.getTOC())
  }
  syncing = false
  await nextTick()
  if (props.mode === 'source') source.refresh()
}

function flush() {
  if (muya && props.mode === 'edit') muya.flush()
}

function undo() {
  if (props.mode === 'source') source.undo()
  else if (props.mode === 'edit') muya.undo()
}

function redo() {
  if (props.mode === 'source') source.redo()
  else if (props.mode === 'edit') muya.redo()
}

function find(text: string, backwards = false) {
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
  if (!searchText || props.mode === 'read') return
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

function reveal(slug: string, index: number) {
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

onMounted(() => {
  richText = sourceText = editorText(props.text)
  const container = document.createElement('div')
  richHost.value!.appendChild(container)
  muya = new Muya(container, { markdown: richText, fontSize: 17, lineHeight: 1.75,
    spellcheckEnabled: false, disableHtml: true, autoPairMarkdownSyntax: true })
  muya.locale(zhCN)
  muya.init({ focus: false })
  detachSelection = attachNativeSelection(muya.domNode)
  muya.domNode.setAttribute('aria-label', 'Markdown 编辑器')
  source = CodeMirror(sourceHost.value!, { value: sourceText, mode: 'gfm', lineNumbers: true,
    lineWrapping: true, tabSize: 2, indentUnit: 2, inputStyle: 'textarea',
    extraKeys: { 'Ctrl-S': () => {}, 'Cmd-S': () => {} } })
  source.getInputField().setAttribute('aria-label', 'Markdown 源码')
  muya.on('json-change', publish)
  source.on('change', publish)
  emit('outline', muya.getTOC())
  void syncMode()
})
watch(() => props.mode, syncMode)
watch(() => props.active, async active => {
  if (!active) return
  await nextTick()
  if (props.mode === 'source') source.refresh()
})
onBeforeUnmount(() => { detachSelection?.(); muya?.destroy() })
defineExpose({ flush, undo, redo, find, replace, reveal })
</script>

<template>
  <section class="editor-panel">
    <div v-show="mode !== 'source'" ref="richHost" class="rich-editor" />
    <div v-show="mode === 'source'" ref="sourceHost" class="source-editor" />
  </section>
</template>
