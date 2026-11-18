import type { DocumentRef } from '../domain/collaboration.ts'

export interface EditorLocalState {
  composing: boolean
  pendingInput: boolean
  localOpSeq: number
  acknowledgedRevision: string
}

export interface CommittedDocumentTransaction {
  document: DocumentRef
  markdown: string
}

/**
 * Application-level EditorPort contract.
 * Tracks IME composition, post-compositionend final input settling, and local operation sequence
 * so review gates and lease handoffs never drop in-flight typing.
 */
export interface EditorPort {
  getLocalState(): EditorLocalState
  flushCompletedInput(): Promise<void>
  beginReviewGate(): Promise<{ localOpSeq: number; release(): void }>
  applyCommittedTransaction(tx: CommittedDocumentTransaction): Promise<void>
}

export function createEditorPortTracker(initialRevision = '0') {
  let composing = false
  let postCompositionSettling = false
  let unacknowledgedEdit = false
  let localOpSeq = 0
  let acknowledgedRevision = initialRevision
  const settleWaiters: Array<() => void> = []

  function notifySettled() {
    if (composing || postCompositionSettling) return
    const waiters = settleWaiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  return {
    onCompositionStart() {
      composing = true
      postCompositionSettling = false
    },
    /**
     * After `compositionend`, browsers/acdert dispatch the final `input` event in the same or next task.
     * Keep `postCompositionSettling = true` across a macrotask turn so review gates wait for that final input.
     */
    onCompositionEnd(schedule: (cb: () => void) => void = cb => setTimeout(cb, 0)) {
      composing = false
      postCompositionSettling = true
      schedule(() => {
        postCompositionSettling = false
        notifySettled()
      })
    },
    onLocalEdit(): number {
      unacknowledgedEdit = true
      return ++localOpSeq
    },
    onCommitted(revision: string, seq = localOpSeq) {
      acknowledgedRevision = revision
      if (seq >= localOpSeq) unacknowledgedEdit = false
    },
    isInputBusy(): boolean {
      return composing || postCompositionSettling
    },
    getState(): EditorLocalState {
      return {
        composing,
        pendingInput: composing || postCompositionSettling || unacknowledgedEdit,
        localOpSeq,
        acknowledgedRevision,
      }
    },
    waitForCompositionSettle(): Promise<void> {
      if (!composing && !postCompositionSettling) return Promise.resolve()
      return new Promise<void>(resolve => { settleWaiters.push(resolve) })
    },
  }
}
