import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearRecentFiles,
  DEFAULT_PREFERENCES,
  formatImageMarkdown,
  loadPreferences,
  loadRecentFiles,
  normalizePreferences,
  recordRecentFile,
  sanitizeAssetFileName,
  savePreferences,
} from '../src/preferences.ts'

function createMemoryStorage() {
  const map = new Map()
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null
    },
    setItem(key, value) {
      map.set(key, String(value))
    },
    removeItem(key) {
      map.delete(key)
    },
  }
}

test('normalizePreferences clamps font size, line height, and watchExternalSeconds safely', () => {
  const normalized = normalizePreferences({
    fontSize: 99,
    lineHeight: 0.5,
    autoPairMarkdownSyntax: false,
    lineNumbers: false,
    watchExternalSeconds: 15,
  })
  assert.deepEqual(normalized, {
    fontSize: 28,
    lineHeight: 1.2,
    autoPairMarkdownSyntax: false,
    lineNumbers: false,
    watchExternalSeconds: 15,
  })
  assert.deepEqual(normalizePreferences(null), DEFAULT_PREFERENCES)
})

test('loadPreferences and savePreferences round-trip through storage', () => {
  const storage = createMemoryStorage()
  assert.deepEqual(loadPreferences(storage), DEFAULT_PREFERENCES)
  const saved = savePreferences({
    ...DEFAULT_PREFERENCES,
    fontSize: 18,
    watchExternalSeconds: 5,
  }, storage)
  assert.equal(saved.fontSize, 18)
  assert.deepEqual(loadPreferences(storage), saved)
})

test('recordRecentFile deduplicates, bounds list length, and clearRecentFiles resets storage', () => {
  const storage = createMemoryStorage()
  let list = recordRecentFile([], { root: 'private', rootLabel: '我的笔记', path: 'notes/a.md', name: 'a.md', openedAt: '2026-04-17T00:00:00.000Z' }, storage)
  list = recordRecentFile(list, { root: 'private', rootLabel: '我的笔记', path: 'notes/b.md', name: 'b.md', openedAt: '2026-04-17T00:01:00.000Z' }, storage)
  list = recordRecentFile(list, { root: 'private', rootLabel: '我的笔记', path: 'notes/a.md', name: 'a.md', openedAt: '2026-04-17T00:02:00.000Z' }, storage)
  assert.equal(list.length, 2)
  assert.equal(list[0].path, 'notes/a.md')
  assert.equal(loadRecentFiles(storage).length, 2)
  clearRecentFiles(storage)
  assert.deepEqual(loadRecentFiles(storage), [])
})

test('sanitizeAssetFileName and formatImageMarkdown produce safe Markdown image syntax', () => {
  assert.equal(sanitizeAssetFileName('dir/My:Screen*Shot'), 'My_Screen_Shot.png')
  assert.equal(formatImageMarkdown('diagram_[1].png', 'assets/diagram 1.png'), '![diagram_1](assets/diagram%201.png)')
})
