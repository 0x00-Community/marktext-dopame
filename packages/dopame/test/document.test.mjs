import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDocument, editorText, isDirty, outline, updateDocument } from '../src/document.ts'

test('outline records source lines and excludes fenced headings', () => {
  const text = '```md\n# fake\n```\n\n# real\n\n~~~\n## also fake\n~~~\n## next'
  assert.deepEqual(outline(text).map(({ content, line }) => ({ content, line })), [
    { content: 'real', line: 4 }, { content: 'next', line: 9 },
  ])
})

test('BOM and CRLF do not shift outline positions', () => {
  assert.deepEqual(outline('\uFEFF# First\r\n\r\n## Second').map(item => item.line), [0, 2])
  assert.equal(editorText('\uFEFF# First\r\n'), '# First\n')
})

test('editing preserves BOM and line endings and increments revision once', () => {
  const tab = createDocument('note.md', '\uFEFF# First\r\n', { kind: 'root', root: 'private', path: 'note.md', version: '1' })
  assert.equal(isDirty(tab), false)
  updateDocument(tab, '# First\n')
  assert.equal(tab.revision, 0)
  updateDocument(tab, '# Second\n')
  assert.equal(tab.text, '\uFEFF# Second\r\n')
  assert.equal(tab.revision, 1)
  assert.equal(isDirty(tab), true)
})

test('completion of an earlier save does not clear newer input', () => {
  const tab = createDocument('note.md', '# Before')
  const snapshot = tab.text
  updateDocument(tab, '# After')
  tab.savedText = snapshot
  assert.equal(isDirty(tab), true)
  assert.equal(tab.text, '# After')
})
