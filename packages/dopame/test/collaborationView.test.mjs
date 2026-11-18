import test from 'node:test'
import assert from 'node:assert/strict'
import { distinctNames, formatTime, mergeEvents, parseSources, proposalFacts, sourceLinks } from '../src/collaboration/viewModel.ts'
import { createNotificationPort, noticeFor, parseReviewTag, reviewTag } from '../src/platform/notificationPort.ts'

test('colliding names gain a hint, then a stable key, and unique names stay unchanged', () => {
  assert.deepEqual(distinctNames([
    { name: 'draft.md', hint: 'a1' },
    { name: 'notes.md', hint: 'b2' },
    { name: 'draft.md', hint: 'c3', key: 'k1' },
    { name: 'draft.md', hint: 'c3', key: 'k2' }
  ]), ['draft.md（a1）', 'notes.md', 'draft.md（c3 · k1）', 'draft.md（c3 · k2）'])
  const before = distinctNames([{ name: 'x', hint: 'h', key: 'k1' }, { name: 'x', hint: 'h', key: 'k2' }, { name: 'x', hint: 'h', key: 'k3' }])
  const afterClosingFirst = distinctNames([{ name: 'x', hint: 'h', key: 'k2' }, { name: 'x', hint: 'h', key: 'k3' }])
  assert.deepEqual(afterClosingFirst, before.slice(1))
})

test('repeated and reconnected event pages keep one entry per event in arrival order', () => {
  const first = [{ eventId: 'e1', type: 'task.queued' }, { eventId: 'e2', type: 'task.succeeded' }]
  const replay = [{ eventId: 'e2', type: 'task.succeeded' }, { eventId: 'e3', type: 'proposal.created' }, { eventId: 'e3', type: 'proposal.created' }]
  assert.deepEqual(mergeEvents(first, replay).map(event => event.eventId), ['e1', 'e2', 'e3'])
  assert.equal(mergeEvents(first, replay)[1], first[1])
})

test('sources are parsed and displayed as plain references', () => {
  assert.deepEqual(parseSources('urn:test:paper 论文\n\n  https://example.test/a  \n'), [
    { uri: 'urn:test:paper', label: '论文' }, { uri: 'https://example.test/a' },
  ])
  assert.deepEqual(sourceLinks([{ uri: 'urn:a', label: 'A' }, { uri: 'urn:b' }, { label: 'missing uri' }, null]), [
    { uri: 'urn:a', label: 'A' }, { uri: 'urn:b', label: 'urn:b' },
  ])
  assert.deepEqual(sourceLinks('urn:a'), [])
})

test('proposal facts expose identity, base, time, size, workflow and staleness', () => {
  const facts = proposalFacts({
    authorPrincipalId: '0123456789abcdef',
    authorName: '审阅 Agent',
    base: { revision: '12' },
    createdAt: '2026-11-16T08:00:00.000Z',
    operations: [{}, {}],
    workflowId: 'relay',
    state: 'stale',
    sources: [{ uri: 'urn:test:source' }],
  })
  assert.deepEqual(facts, {
    author: '审阅 Agent（01234567）',
    baseRevision: '12',
    created: '2026-11-16 08:00:00 UTC',
    operations: '2',
    workflow: 'relay',
    sources: [{ uri: 'urn:test:source', label: 'urn:test:source' }],
    stale: true,
    appliedRevision: undefined,
  })
  assert.equal(proposalFacts({ operationCount: 3 }).operations, '3')
  assert.equal(formatTime('not a date'), '时间未知')
})

test('only reviewable outcomes notify and routing tags carry references, never content', () => {
  assert.equal(noticeFor({ type: 'task.queued', data: { taskId: 't1' } }), null)
  assert.equal(noticeFor({ type: 'task.succeeded', data: { taskId: 't1' } }), null)
  assert.equal(noticeFor({ type: 'document.created', data: { inbox: false } }), null)
  assert.deepEqual(noticeFor({ type: 'document.created', data: { inbox: true } }), { kind: 'draft', target: { section: 'inbox' } })
  assert.deepEqual(noticeFor({ type: 'proposal.created', data: { proposalId: 'p-1' } }), { kind: 'proposal', target: { section: 'proposal', id: 'p-1' } })
  assert.deepEqual(noticeFor({ type: 'task.failed', data: { taskId: '../../etc/passwd' } }), { kind: 'failure', target: { section: 'task', id: undefined } })
  assert.deepEqual(noticeFor({ type: 'task.inquiry', data: { taskId: 't-inq-1' } }), { kind: 'inquiry', target: { section: 'task', id: 't-inq-1' } })
  assert.equal(reviewTag({ section: 'proposal', id: 'p-1' }), 'marktext-review:proposal:p-1')
  assert.deepEqual(parseReviewTag('marktext-review:proposal:p-1'), { section: 'proposal', id: 'p-1' })
  assert.deepEqual(parseReviewTag('marktext-review:inbox'), { section: 'inbox' })
  for (const tag of ['marktext-review:approve:p-1', 'marktext-review:proposal:has space', 'other:proposal:p-1', 7]) {
    assert.equal(parseReviewTag(tag), null)
  }
})

function host (permission) {
  const shown = []
  const Host = class {
    static permission = permission
    static requested = 0
    static async requestPermission () { Host.requested++; Host.permission = 'granted'; return 'granted' }
    constructor (title, options) { this.title = title; this.options = options; this.onclick = null; shown.push(this) }
  }
  return { Host, shown }
}

test('history is not replayed, duplicates are merged and a click only locates the target', () => {
  const { Host, shown } = host('granted')
  const activated = []
  const port = createNotificationPort({ host: Host, onActivate: target => activated.push(target), now: () => new Date('2026-11-16T08:00:00Z') })
  port.baseline([{ eventId: 'old', type: 'proposal.created', data: { proposalId: 'p-old' } }])
  assert.deepEqual(port.deliver([{ eventId: 'old', type: 'proposal.created', data: { proposalId: 'p-old' } }]), [])
  const delivered = port.deliver([
    { eventId: 'e1', type: 'proposal.created', data: { proposalId: 'p-1' } },
    { eventId: 'e2', type: 'task.succeeded', data: { taskId: 't-1' } },
    { eventId: 'e3', type: 'document.created', data: { inbox: true, document: { docId: 'd-1' } } },
    { eventId: 'e4', type: 'document.created', data: { inbox: true, document: { docId: 'd-2' } } },
    { eventId: 'e1', type: 'proposal.created', data: { proposalId: 'p-1' } },
  ])
  assert.deepEqual(delivered.map(record => [record.kind, record.count, record.state, record.title]), [
    ['proposal', 1, 'submitted', '有一条文档建议等待审阅'], ['draft', 2, 'submitted', '2 份新草稿已到达 Agent 收件箱'],
  ])
  assert.deepEqual(shown.map(notification => notification.options), [{ tag: 'marktext-review:proposal:p-1' }, { tag: 'marktext-review:inbox' }])
  assert.equal(JSON.stringify(shown.map(notification => [notification.title, notification.options])).includes('d-1'), false)
  assert.deepEqual(port.deliver([{ eventId: 'e3', type: 'document.created', data: {} }]), [])
  shown[0].onclick()
  assert.deepEqual(activated, [{ section: 'proposal', id: 'p-1' }])
  assert.equal(port.records().length, 2)
})

test('a missing, undecided or failing channel records the outcome and never prompts on delivery', async () => {
  const event = id => ({ eventId: id, type: 'task.failed', data: { taskId: 't-1' } })
  const absent = createNotificationPort({ onActivate () {} })
  assert.equal(absent.availability(), 'unsupported')
  assert.equal(absent.deliver([event('a')])[0].state, 'unsupported')
  assert.equal(await absent.enable(), 'unsupported')

  const { Host, shown } = host('default')
  const undecided = createNotificationPort({ host: Host, onActivate () {} })
  assert.equal(undecided.deliver([event('b')])[0].state, 'not-enabled')
  assert.equal(Host.requested, 0)
  assert.equal(shown.length, 0)
  assert.equal(await undecided.enable(), 'granted')
  assert.equal(Host.requested, 1)
  assert.equal(undecided.deliver([event('c')])[0].state, 'submitted')

  const Throwing = class { static permission = 'granted'; constructor () { throw new Error('channel closed') } }
  assert.equal(createNotificationPort({ host: Throwing, onActivate () {} }).deliver([event('d')])[0].state, 'failed')

  const bounded = createNotificationPort({ onActivate () {}, limit: 2 })
  for (const id of ['x', 'y', 'z']) bounded.deliver([event(id)])
  assert.deepEqual(bounded.records().map(record => record.key), ['z', 'y'])
})

test('inquiry notifications respect 180s cooldown and silent suppression while typing', () => {
  const { Host, shown } = host('granted')
  let clock = new Date('2026-11-16T08:00:00Z').getTime()
  let busy = false
  const port = createNotificationPort({
    host: Host,
    onActivate () {},
    now: () => new Date(clock),
    isInputBusy: () => busy,
  })
  const first = port.deliver([{ eventId: 'inq-1', type: 'task.inquiry', data: { taskId: 't-1', workflowKey: 'wf-1', category: 'intent_ambiguity' } }])
  assert.equal(first[0].state, 'submitted')
  assert.equal(shown.length, 1)

  // Within 180s window -> suppressed-cooldown
  clock += 30_000
  const second = port.deliver([{ eventId: 'inq-2', type: 'task.inquiry', data: { taskId: 't-1', workflowKey: 'wf-1', category: 'intent_ambiguity' } }])
  assert.equal(second[0].state, 'suppressed-cooldown')
  assert.equal(shown.length, 1)

  // After 180s window, but user is actively typing -> suppressed-input-busy
  clock += 180_000
  busy = true
  const third = port.deliver([{ eventId: 'inq-3', type: 'task.inquiry', data: { taskId: 't-1', workflowKey: 'wf-1', category: 'intent_ambiguity' } }])
  assert.equal(third[0].state, 'suppressed-input-busy')
  assert.equal(shown.length, 1)

  // Fatal error still notifies even when input is busy
  const fourth = port.deliver([{ eventId: 'inq-4', type: 'task.inquiry', data: { taskId: 't-1', workflowKey: 'wf-1', category: 'fatal_error' } }])
  assert.equal(fourth[0].state, 'submitted')
  assert.equal(shown.length, 2)
})
