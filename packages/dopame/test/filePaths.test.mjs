import assert from 'node:assert/strict'
import { test } from 'node:test'
import { containsResource, entryPath, renamedResource } from '../src/filePaths.ts'

const resource = (root, path) => ({ kind: 'root', root, path, version: 'saved-version' })

test('rename updates a file or directory descendant without changing its version', () => {
  const file = resource('private', 'notes/topic.md')
  assert.deepEqual(renamedResource(file, 'private', 'notes/topic.md', 'notes/renamed.md'),
    resource('private', 'notes/renamed.md'))
  assert.deepEqual(renamedResource(file, 'private', 'notes', 'archive'),
    resource('private', 'archive/topic.md'))
  assert.equal(file.path, 'notes/topic.md')
  assert.deepEqual(renamedResource(resource('private', 'notes/deep/topic.md'), 'private', 'notes', 'archive'),
    resource('private', 'archive/deep/topic.md'))
})

test('path matching respects root and directory boundaries', () => {
  for (const file of [resource('other', 'notes/topic.md'), resource('private', 'notes-old/topic.md'),
    resource('private', 'notes.md'), { kind: 'handle', handle: {}, modifiedMs: 0, size: 0 }]) {
    assert.equal(containsResource(file, 'private', 'notes'), false)
    assert.equal(renamedResource(file, 'private', 'notes', 'archive'), file)
  }
  assert.equal(containsResource(null, 'private', 'notes'), false)
  assert.equal(containsResource(resource('private', 'notes'), 'private', 'notes'), true)
  assert.equal(containsResource(resource('private', 'notes/a.md'), 'private', 'notes'), true)
})

test('entry paths stay in the chosen folder and reject path inputs', () => {
  assert.equal(entryPath('', '笔记.md'), '笔记.md')
  assert.equal(entryPath('work/deep', '笔记.md'), 'work/deep/笔记.md')
  for (const name of ['', ' ', '.', '..', '../note.md', '/note.md', 'a/b', 'a\\b', 'a\0b']) {
    assert.throws(() => entryPath('work', name))
  }
})
