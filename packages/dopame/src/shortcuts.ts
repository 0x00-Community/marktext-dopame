export function shortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string | null {
  const { ctrlKey, metaKey, altKey, shiftKey } = event
  if (!ctrlKey && !metaKey) return null
  const key = event.key.toLowerCase()
  if (ctrlKey && metaKey) return key === 'c' && !altKey && !shiftKey ? 'format:inline_code' : null
  if (altKey) {
    if (shiftKey) return null
    if (key === 's') return 'source'
    if (key === 'r') return 'read'
    if (/^[1-6]$/.test(key)) return `paragraph:heading ${key}`
    const blocks: Record<string, string> = { m: 'mathblock', j: 'html', c: 'pre', q: 'blockquote', o: 'ol-order', u: 'ul-bullet', x: 'ul-task', y: 'front-matter', '-': 'hr' }
    return blocks[key] ? `paragraph:${blocks[key]}` : null
  }
  if (key === 'z') return shiftKey ? 'redo' : 'undo'
  if (key === 's') return shiftKey ? 'saveAs' : 'save'
  if (key === 'tab') return shiftKey ? 'previousTab' : 'nextTab'
  if (shiftKey) {
    const formats: Record<string, string> = { h: 'mark', e: 'inline_math', m: 'inline_math', i: 'image', r: 'clear' }
    if (formats[key]) return `format:${formats[key]}`
    const blocks: Record<string, string> = { t: 'table', k: 'pre', q: 'blockquote', x: 'ul-task', l: 'loose-list-item', '0': 'paragraph' }
    return blocks[key] ? `paragraph:${blocks[key]}` : null
  }
  if (/^[0-6]$/.test(key)) return key === '0' ? 'paragraph:paragraph' : `paragraph:heading ${key}`
  const commands: Record<string, string> = { n: 'new', t: 'new', o: 'open', f: 'find', w: 'close', e: 'source', y: 'redo' }
  if (commands[key]) return commands[key]
  const formats: Record<string, string> = { b: 'strong', i: 'em', u: 'u', d: 'del', l: 'link', '`': 'inline_code' }
  return formats[key] ? `format:${formats[key]}` : null
}


export function shortcutHint(action: string): string {
  const hints: Record<string, string> = {
    strong: 'Ctrl/Cmd+B', em: 'Ctrl/Cmd+I', u: 'Ctrl/Cmd+U', del: 'Ctrl/Cmd+D',
    inline_code: 'Ctrl/Cmd+`', inline_math: 'Ctrl/Cmd+Shift+M', link: 'Ctrl/Cmd+L',
    image: 'Ctrl/Cmd+Shift+I', mark: 'Ctrl/Cmd+Shift+H', clear: 'Ctrl/Cmd+Shift+R',
    paragraph: 'Ctrl/Cmd+0', 'thematic-break': 'Ctrl/Cmd+Alt+-', frontmatter: 'Ctrl/Cmd+Alt+Y',
    table: 'Ctrl/Cmd+Shift+T', 'math-block': 'Ctrl/Cmd+Alt+M', 'html-block': 'Ctrl/Cmd+Alt+J',
    'code-block': 'Ctrl/Cmd+Alt+C', 'block-quote': 'Ctrl/Cmd+Alt+Q',
    'order-list': 'Ctrl/Cmd+Alt+O', 'bullet-list': 'Ctrl/Cmd+Alt+U', 'task-list': 'Ctrl/Cmd+Alt+X'
  }
  const heading = action.match(/^atx-heading ([1-6])$/)
  return heading ? `Ctrl/Cmd+${heading[1]}` : hints[action] ?? ''
}
