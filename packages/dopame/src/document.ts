import type { Resource } from './files'
import { Lexer } from 'marked'

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
  let line = 0
  return Lexer.lex(editorText(text)).flatMap(token => {
    const start = line
    line += (token.raw.match(/\n/g) ?? []).length
    return token.type === 'heading'
      ? [{ lvl: token.depth, content: token.text, slug: '', line: start }] : []
  })
}
