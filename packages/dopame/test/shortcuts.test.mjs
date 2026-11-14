import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shortcut } from '../src/shortcuts.ts'

const key = (value, modifiers = {}) => shortcut({ key: value, ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, ...modifiers })
test('mode modifiers never invoke save and shifted uppercase format keys resolve', () => {
  assert.equal(key('s', { altKey: true }), 'source')
  assert.equal(key('S', { altKey: true, shiftKey: true }), null)
  assert.equal(key('S', { shiftKey: true }), 'saveAs')
  assert.equal(key('H', { shiftKey: true }), 'format:mark')
  assert.equal(key('Z', { shiftKey: true, ctrlKey: false, metaKey: true }), 'redo')
  assert.equal(key('e'), 'source')
})

test('block commands preserve the quick-insert keyboard vocabulary', () => {
  for (const [letter, command] of Object.entries({ m: 'mathblock', j: 'html', c: 'pre', q: 'blockquote', o: 'ol-order', u: 'ul-bullet', x: 'ul-task', y: 'front-matter', '-': 'hr' })) {
    assert.equal(key(letter, { altKey: true }), `paragraph:${command}`)
    assert.equal(key(letter, { altKey: true, ctrlKey: false, metaKey: true }), `paragraph:${command}`)
  }
})
