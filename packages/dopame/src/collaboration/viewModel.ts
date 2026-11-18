type Item = Record<string, unknown>

/**
 * Adds a hint only where visible names collide, so a role/name lookup resolves to one control.
 * Names that still collide take their own key, which does not change when a sibling goes away.
 */
export function distinctNames(items: Array<{ name: string; hint: string; key?: string }>): string[] {
  const count = (values: string[]) => values.reduce((counts, value) => counts.set(value, (counts.get(value) ?? 0) + 1), new Map<string, number>())
  const names = count(items.map(item => item.name))
  const hinted = count(items.map(item => `${item.name}（${item.hint}）`))
  return items.map(item => {
    if (names.get(item.name) === 1) return item.name
    const label = `${item.name}（${item.hint}）`
    return hinted.get(label) === 1 || !item.key ? label : `${item.name}（${item.hint} · ${item.key}）`
  })
}

/** Event pages may repeat after a reconnect; the first delivery of an id wins. */
export function mergeEvents<T extends Item>(existing: T[], incoming: T[]): T[] {
  const merged = new Map<unknown, T>()
  for (const event of [...existing, ...incoming]) {
    const id = event.eventId ?? event.id
    if (!merged.has(id)) merged.set(id, event)
  }
  return [...merged.values()]
}

export function shortId(id: unknown) {
  return String(id ?? '').slice(0, 8)
}

export function formatTime(value: unknown) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isFinite(time)) return '时间未知'
  return new Date(time).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
}

export interface SourceLink { uri: string; label: string }

/** Sources are caller-supplied references; they are shown as text and never dereferenced. */
export function sourceLinks(value: unknown): SourceLink[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const source = item as Item | null
    if (!source || typeof source.uri !== 'string') return []
    return [{ uri: source.uri, label: typeof source.label === 'string' && source.label ? source.label : source.uri }]
  })
}

/** One URI per line, optionally followed by a label; blank lines are ignored. */
export function parseSources(text: string): Array<{ uri: string; label?: string }> {
  return text.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const separator = line.search(/\s/)
    if (separator < 0) return { uri: line }
    return { uri: line.slice(0, separator), label: line.slice(separator).trim() }
  })
}

export function proposalFacts(proposal: Item) {
  const base = (proposal.base ?? {}) as Item
  const operations = Array.isArray(proposal.operations) ? proposal.operations.length
    : typeof proposal.operationCount === 'number' ? proposal.operationCount : undefined
  return {
    author: `${typeof proposal.authorName === 'string' && proposal.authorName ? proposal.authorName : '未命名调用方'}（${shortId(proposal.authorPrincipalId)}）`,
    baseRevision: String(base.revision ?? '未知'),
    created: formatTime(proposal.createdAt),
    operations: operations === undefined ? '未知' : String(operations),
    workflow: typeof proposal.workflowId === 'string' && proposal.workflowId ? proposal.workflowId : '无',
    sources: sourceLinks(proposal.sources),
    stale: proposal.state === 'stale',
    appliedRevision: typeof proposal.appliedRevision === 'string' ? proposal.appliedRevision : undefined,
  }
}
