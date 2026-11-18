export interface EditorPreferences {
  fontSize: number
  lineHeight: number
  autoPairMarkdownSyntax: boolean
  lineNumbers: boolean
  watchExternalSeconds: 0 | 5 | 15 | 30
}

export interface RecentFileEntry {
  root: string
  rootLabel: string
  path: string
  name: string
  openedAt: string
}

const PREFS_KEY = 'marktext-preferences'
const RECENT_KEY = 'marktext-recent-files'
const MAX_RECENT_FILES = 12

export const DEFAULT_PREFERENCES: EditorPreferences = Object.freeze({
  fontSize: 17,
  lineHeight: 1.75,
  autoPairMarkdownSyntax: true,
  lineNumbers: true,
  watchExternalSeconds: 0,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizePreferences(input: unknown): EditorPreferences {
  if (!isRecord(input)) return { ...DEFAULT_PREFERENCES }
  const fontSize = typeof input.fontSize === 'number' && Number.isFinite(input.fontSize)
    ? Math.min(28, Math.max(12, Math.round(input.fontSize)))
    : DEFAULT_PREFERENCES.fontSize
  const lineHeight = typeof input.lineHeight === 'number' && Number.isFinite(input.lineHeight)
    ? Math.min(2.4, Math.max(1.2, Math.round(input.lineHeight * 100) / 100))
    : DEFAULT_PREFERENCES.lineHeight
  const autoPairMarkdownSyntax = typeof input.autoPairMarkdownSyntax === 'boolean'
    ? input.autoPairMarkdownSyntax
    : DEFAULT_PREFERENCES.autoPairMarkdownSyntax
  const lineNumbers = typeof input.lineNumbers === 'boolean'
    ? input.lineNumbers
    : DEFAULT_PREFERENCES.lineNumbers
  const watchExternalSeconds = [0, 5, 15, 30].includes(input.watchExternalSeconds as number)
    ? (input.watchExternalSeconds as 0 | 5 | 15 | 30)
    : DEFAULT_PREFERENCES.watchExternalSeconds
  return { fontSize, lineHeight, autoPairMarkdownSyntax, lineNumbers, watchExternalSeconds }
}

function defaultStorage(): Storage | undefined {
  return typeof localStorage !== 'undefined' ? localStorage : undefined
}

export function loadPreferences(storage: Pick<Storage, 'getItem'> | undefined = defaultStorage()): EditorPreferences {
  try {
    const raw = storage?.getItem(PREFS_KEY)
    if (!raw) return { ...DEFAULT_PREFERENCES }
    return normalizePreferences(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
}

export function savePreferences(
  prefs: EditorPreferences,
  storage: Pick<Storage, 'setItem'> | undefined = defaultStorage(),
): EditorPreferences {
  const normalized = normalizePreferences(prefs)
  try {
    storage?.setItem(PREFS_KEY, JSON.stringify(normalized))
  } catch { /* ignore storage quota errors */ }
  return normalized
}

export function loadRecentFiles(storage: Pick<Storage, 'getItem'> | undefined = defaultStorage()): RecentFileEntry[] {
  try {
    const raw = storage?.getItem(RECENT_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is RecentFileEntry =>
      isRecord(item)
      && typeof item.root === 'string' && item.root.length > 0
      && typeof item.rootLabel === 'string'
      && typeof item.path === 'string' && item.path.length > 0 && !/(^[/\\]|\\|\.\.)/.test(item.path)
      && typeof item.name === 'string' && item.name.length > 0
      && typeof item.openedAt === 'string',
    ).slice(0, MAX_RECENT_FILES)
  } catch {
    return []
  }
}

export function recordRecentFile(
  existing: RecentFileEntry[],
  entry: Omit<RecentFileEntry, 'openedAt'> & { openedAt?: string },
  storage: Pick<Storage, 'setItem'> | undefined = defaultStorage(),
): RecentFileEntry[] {
  if (!entry.root || !entry.path || /(^[/\\]|\\|\.\.)/.test(entry.path)) return existing
  const item: RecentFileEntry = {
    root: entry.root,
    rootLabel: entry.rootLabel || (entry.root === 'private' ? '我的笔记' : '已授权文件夹'),
    path: entry.path,
    name: entry.name,
    openedAt: entry.openedAt ?? new Date().toISOString(),
  }
  const key = `${item.root}:${item.path}`
  const next = [item, ...existing.filter(old => `${old.root}:${old.path}` !== key)].slice(0, MAX_RECENT_FILES)
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(next))
  } catch { /* ignore storage quota errors */ }
  return next
}

export function clearRecentFiles(storage: Pick<Storage, 'removeItem'> | undefined = defaultStorage()): RecentFileEntry[] {
  try {
    storage?.removeItem(RECENT_KEY)
  } catch { /* ignore */ }
  return []
}

const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|svg)$/i

export function isSupportedImageFileName(name: string): boolean {
  return IMAGE_EXTENSIONS.test(name.trim())
}

export function sanitizeAssetFileName(name: string): string {
  const base = name.trim().replace(/^.*[/\\]/, '')
  const cleaned = [...base].map(ch => (ch.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(ch) ? '_' : ch)).join('')
  return isSupportedImageFileName(cleaned) ? cleaned : `${cleaned || 'image'}.png`
}

export function formatImageMarkdown(altText: string, relativePath: string): string {
  const alt = altText.replace(/\.(?:png|jpe?g|gif|webp|svg)$/i, '').replace(/[[\]\r\n]/g, '').trim() || '图片'
  const encodedPath = relativePath.split('/').map(segment => encodeURIComponent(segment)).join('/')
  return `![${alt}](${encodedPath})`
}
