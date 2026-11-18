import test from 'node:test'
import assert from 'node:assert/strict'
import { createEditorPortTracker } from '../src/editor/editorPort.ts'
import { resolveWindowSession } from '../src/session.ts'

test('EditorPort keeps input busy across compositionend until final input settles', async () => {
  const tracker = createEditorPortTracker('0')
  assert.equal(tracker.isInputBusy(), false)
  assert.deepEqual(tracker.getState(), {
    composing: false,
    pendingInput: false,
    localOpSeq: 0,
    acknowledgedRevision: '0',
  })

  tracker.onCompositionStart()
  assert.equal(tracker.isInputBusy(), true)
  assert.equal(tracker.getState().composing, true)
  assert.equal(tracker.getState().pendingInput, true)

  // Immediately after compositionend, post-composition final input is still settling
  let releaseScheduled = () => {}
  tracker.onCompositionEnd(cb => { releaseScheduled = cb })
  assert.equal(tracker.getState().composing, false)
  assert.equal(tracker.isInputBusy(), true)
  assert.equal(tracker.getState().pendingInput, true)

  let settled = false
  const waiting = tracker.waitForCompositionSettle().then(() => { settled = true })
  // Final IME input arrives before settle callback completes
  const seq = tracker.onLocalEdit()
  assert.equal(seq, 1)
  assert.equal(settled, false)

  releaseScheduled()
  await waiting
  assert.equal(settled, true)
  assert.equal(tracker.isInputBusy(), false)
  // Unacknowledged edit keeps pendingInput=true until service acknowledges commit
  assert.equal(tracker.getState().pendingInput, true)

  tracker.onCommitted('1', 1)
  assert.deepEqual(tracker.getState(), {
    composing: false,
    pendingInput: false,
    localOpSeq: 1,
    acknowledgedRevision: '1',
  })
})

test('resolveWindowSession isolates per-window session paths and preserves stable windowSessionId', () => {
  const storeA = new Map()
  const storageA = {
    getItem: key => storeA.get(key) ?? null,
    setItem: (key, val) => storeA.set(key, val),
  }
  const storeB = new Map()
  const storageB = {
    getItem: key => storeB.get(key) ?? null,
    setItem: (key, val) => storeB.set(key, val),
  }

  const firstA = resolveWindowSession(storageA)
  const reloadA = resolveWindowSession(storageA)
  const firstB = resolveWindowSession(storageB)

  assert.equal(firstA.windowSessionId, reloadA.windowSessionId)
  assert.notEqual(firstA.windowSessionId, firstB.windowSessionId)
  assert.notEqual(firstA.sessionPath, firstB.sessionPath)
  assert.equal(firstA.legacySessionPath, '.marktext/session.json')
})
