import type { Resource } from './files'

export interface DocumentTab {
  id: string
  name: string
  text: string
  savedText: string | null
  resource: Resource | null
  mode: 'edit' | 'source' | 'read'
  revision: number
  saving: boolean
  bom: boolean
  eol: '\n' | '\r\n'
}

export function createDocument(name: string, text = '', resource: Resource | null = null): DocumentTab {
  return { id: crypto.randomUUID(), name, text, savedText: resource ? text : null,
    resource, mode: 'edit', revision: 0, saving: false, bom: text.startsWith('\uFEFF'),
    eol: text.includes('\r\n') ? '\r\n' : '\n' }
}

export function editorText(text: string) {
  return text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
}

export function updateDocument(tab: DocumentTab, markdown: string) {
  const text = (tab.bom ? '\uFEFF' : '') + editorText(markdown).replace(/\n/g, tab.eol)
  if (text === tab.text) return
  tab.text = text
  tab.revision++
}

export function isDirty(tab: DocumentTab) {
  return tab.savedText !== tab.text
}

export function outline(text: string) {
  let fence = ''
  return editorText(text).split('\n').flatMap((line, index) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (marker) {
      if (!fence) fence = marker[1][0]
      else if (fence === marker[1][0]) fence = ''
      return []
    }
    if (fence) return []
    const heading = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?$/)
    return heading ? [{ lvl: heading[1].length, content: heading[2], slug: '', line: index }] : []
  })
}
