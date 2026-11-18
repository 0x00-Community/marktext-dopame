import { apps } from 'acde:apps'
import { desktop } from 'acde:desktop'
import { windows } from 'acde:windows'

// The desktop stays out of sight: it opens MarkText on start and fills the screen with it. It shows
// a way back only when no MarkText window is open, and arriving notifications as dismissible cards.
const EDITOR = 'marktext-dopame'
const PANEL = 'marktext-agent-preview'

function element<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector)
  if (!found) throw new Error('The desktop entry is incomplete.')
  return found
}

function showLauncher() {
  const open = windows.list().some(window => window.appId === EDITOR || window.appId === PANEL)
  element('#launcher').hidden = open
}

/** The editor edition when it is installed, otherwise the caller-side debugging panel. */
async function openMarkText() {
  const error = element('#open-error')
  try {
    const opened = await apps.open(EDITOR).catch(() => apps.open(PANEL))
    error.hidden = true
    // Not every runtime can change window state; the editor then keeps its default size.
    await windows.requestState?.(opened.window, 'filled').catch(() => undefined)
  } catch {
    error.hidden = false
    error.textContent = '这个桌面没有加载 MarkText；请用 dev:collab 启动。'
  }
  showLauncher()
}

element<HTMLButtonElement>('#open').onclick = () => { void openMarkText() }
windows.on('open', showLauncher)
windows.on('close', showLauncher)
void openMarkText()

/** A notification carries only a routing tag; the app re-checks authorization when it opens the target. */
function reviewRequest(tag: string) {
  const match = /^marktext-review:(inbox|proposal|task)(?::([A-Za-z0-9_.:-]{1,128}))?$/.exec(tag)
  if (!match) return null
  const [, section, id] = match
  return { kind: 'marktext-review' as const, section,
    ...(id && section === 'proposal' ? { proposalId: id } : {}), ...(id && section === 'task' ? { taskId: id } : {}) }
}

function dismiss(item: HTMLElement) {
  item.remove()
  element('#notice-area').hidden = !element('#notifications').children.length
}

desktop.on('notification', notice => {
  const app = notice.app
  const request = app === EDITOR || app === PANEL ? reviewRequest(notice.tag) : null
  if (!request || !app) return
  const list = element<HTMLUListElement>('#notifications')
  const item = document.createElement('li')
  const title = document.createElement('div')
  title.textContent = notice.title
  const review = document.createElement('button')
  review.type = 'button'
  review.textContent = '打开审阅'
  review.setAttribute('aria-label', `打开审阅：${notice.title}`)
  review.onclick = () => {
    dismiss(item)
    void apps.open(app, request).catch(() => {
      element('#open-error').hidden = false
      element('#open-error').textContent = '无法打开 MarkText；任务结果仍保存在任务中心。'
      element('#launcher').hidden = false
    })
  }
  const close = document.createElement('button')
  close.type = 'button'
  close.textContent = '关闭'
  close.setAttribute('aria-label', `关闭通知：${notice.title}`)
  close.onclick = () => dismiss(item)
  item.append(title, review, close)
  list.prepend(item)
  while (list.children.length > 5) list.lastElementChild?.remove()
  element('#notice-area').hidden = false
})
