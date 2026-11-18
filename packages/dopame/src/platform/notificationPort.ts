export type NoticeKind = 'draft' | 'proposal' | 'export' | 'failure' | 'inquiry'
export interface NoticeTarget { section: 'inbox' | 'proposal' | 'task'; id?: string }
export interface NotificationRecord {
  key: string
  kind: NoticeKind
  title: string
  count: number
  target: NoticeTarget
  /** `submitted` means handed to the notification channel; display and clicks belong to the desktop. */
  state: 'submitted' | 'suppressed-input-busy' | 'suppressed-cooldown' | 'not-enabled' | 'unsupported' | 'failed'
  at: string
}

interface NotificationLike { onclick: ((event: unknown) => void) | null }
export interface NotificationHost {
  permission: string
  requestPermission?(): Promise<string>
  new (title: string, options?: { tag?: string }): NotificationLike
}

type ServiceEvent = Record<string, unknown>
const reference = /^[A-Za-z0-9_.:-]{1,128}$/
const titles: Record<NoticeKind, [single: string, many: (count: number) => string]> = {
  draft: ['新草稿已到达 Agent 收件箱', count => `${count} 份新草稿已到达 Agent 收件箱`],
  proposal: ['有一条文档建议等待审阅', count => `${count} 条文档建议等待审阅`],
  export: ['固定版本导出已完成', count => `${count} 个固定版本导出已完成`],
  failure: ['一个文档任务失败', count => `${count} 个文档任务失败`],
  inquiry: ['一个任务正在等待您的确认', count => `${count} 个任务正在等待您的确认`],
}

function identifier(value: unknown) {
  return typeof value === 'string' && reference.test(value) ? value : undefined
}

/** Only committed, reviewable outcomes notify; titles never carry document text, paths or credentials. */
export function noticeFor(event: ServiceEvent): { kind: NoticeKind; target: NoticeTarget } | null {
  const data = (event.data ?? {}) as Record<string, unknown>
  switch (event.type) {
    // The author's own imported files also emit this event; only Agent drafts reach the inbox.
    case 'document.created': return data.inbox === true ? { kind: 'draft', target: { section: 'inbox' } } : null
    case 'proposal.created': return { kind: 'proposal', target: { section: 'proposal', id: identifier(data.proposalId) } }
    case 'artifact.exported': return { kind: 'export', target: { section: 'task' } }
    case 'task.failed': return { kind: 'failure', target: { section: 'task', id: identifier(data.taskId) } }
    case 'task.inquiry': return { kind: 'inquiry', target: { section: 'task', id: identifier(data.taskId) } }
    default: return null
  }
}

/** The tag is the only routing data a desktop receives with a notification. */
export function reviewTag(target: NoticeTarget) {
  return `marktext-review:${target.section}${target.id ? `:${target.id}` : ''}`
}

export function parseReviewTag(tag: unknown): NoticeTarget | null {
  if (typeof tag !== 'string') return null
  const match = /^marktext-review:(inbox|proposal|task)(?::([A-Za-z0-9_.:-]{1,128}))?$/.exec(tag)
  return match ? { section: match[1] as NoticeTarget['section'], ...(match[2] ? { id: match[2] } : {}) } : null
}

export function createNotificationPort(options: {
  host?: NotificationHost
  onActivate(target: NoticeTarget): void
  now?: () => Date
  limit?: number
  isInputBusy?: () => boolean
  inquiryCooldownMs?: number
}) {
  const { host, onActivate, isInputBusy } = options
  const now = options.now ?? (() => new Date())
  const limit = options.limit ?? 50
  const inquiryCooldownMs = options.inquiryCooldownMs ?? 180_000
  const seen = new Set<string>()
  const inquiryLastAt = new Map<string, number>()
  let records: NotificationRecord[] = []

  function fresh(events: ServiceEvent[]) {
    return events.filter(event => {
      const id = typeof event.eventId === 'string' ? event.eventId : undefined
      if (!id || seen.has(id)) return false
      seen.add(id)
      return true
    })
  }

  return {
    records: () => records,
    availability(): 'unsupported' | 'granted' | 'denied' | 'default' {
      if (!host) return 'unsupported'
      return host.permission === 'granted' || host.permission === 'denied' ? host.permission : 'default'
    },
    /** Asking is a user action; delivery never prompts by itself. */
    async enable() {
      if (!host) return 'unsupported' as const
      if (host.permission === 'default' && host.requestPermission) await host.requestPermission()
      return this.availability()
    },
    /** Events that predate this connection are history, not news. */
    baseline(events: ServiceEvent[]) { fresh(events) },
    deliver(events: ServiceEvent[]) {
      const currentTime = now().getTime()
      const groups = new Map<NoticeKind, { key: string; count: number; target: NoticeTarget; cooldownSuppressed?: boolean; fatal?: boolean }>()
      for (const event of fresh(events)) {
        const notice = noticeFor(event)
        if (!notice) continue
        const data = (event.data ?? {}) as Record<string, unknown>
        let cooldownSuppressed = false
        const fatal = notice.kind === 'failure' || data.category === 'fatal_error'
        if (notice.kind === 'inquiry' && !fatal && inquiryCooldownMs > 0) {
          const workflowKey = typeof data.workflowKey === 'string' && data.workflowKey ? data.workflowKey : 'default'
          const lastAt = inquiryLastAt.get(workflowKey)
          if (lastAt !== undefined && currentTime - lastAt < inquiryCooldownMs) {
            cooldownSuppressed = true
          } else {
            inquiryLastAt.set(workflowKey, currentTime)
          }
        }
        const group = groups.get(notice.kind)
        // Several outcomes of one kind become one notification that opens their list.
        if (group) {
          groups.set(notice.kind, {
            key: event.eventId as string,
            count: group.count + 1,
            target: { section: notice.target.section },
            cooldownSuppressed: Boolean(group.cooldownSuppressed && cooldownSuppressed),
            fatal: Boolean(group.fatal || fatal),
          })
        } else {
          groups.set(notice.kind, {
            key: event.eventId as string,
            count: 1,
            target: notice.target,
            cooldownSuppressed,
            fatal,
          })
        }
      }
      const delivered: NotificationRecord[] = []
      const busy = Boolean(isInputBusy?.())
      for (const [kind, group] of groups) {
        const title = group.count === 1 ? titles[kind][0] : titles[kind][1](group.count)
        let state: NotificationRecord['state'] = 'unsupported'
        if (group.cooldownSuppressed) {
          state = 'suppressed-cooldown'
        } else if (busy && !group.fatal) {
          state = 'suppressed-input-busy'
        } else if (host) {
          if (host.permission !== 'granted') state = 'not-enabled'
          else {
            try {
              const notification = new host(title, { tag: reviewTag(group.target) })
              notification.onclick = () => onActivate(group.target)
              state = 'submitted'
            } catch { state = 'failed' }
          }
        }
        delivered.push({ key: group.key, kind, title, count: group.count, target: group.target, state, at: now().toISOString() })
      }
      records = [...[...delivered].reverse(), ...records].slice(0, limit)
      return delivered
    },
  }
}
