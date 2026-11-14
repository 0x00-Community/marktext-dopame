import type { Muya } from '@muyajs/core'

// acdert 0.0.9 focuses contenteditable on pointer input without establishing a Range.
export function attachNativeSelection(muya: Muya): () => void {
  if (!navigator.userAgent.includes('acdert/0.0.9')) return () => {}

  const root = muya.domNode
  const doc = root.ownerDocument
  let anchor: { node: Node; offset: number } | null = null

  function atPoint(event: MouseEvent): Range | null {
    const target = event.target as Element
    const content = target.closest<HTMLElement>('.mu-content')
    if (!content || !root.contains(content) || !content.isContentEditable) return null
    if (target.closest('[contenteditable="false"]')) return null

    // Empty-hint pseudo text is not a DOM endpoint; use the empty span itself.
    if (!content.textContent) {
      const range = doc.createRange()
      range.selectNodeContents(content)
      range.collapse(true)
      return range
    }
    const range = doc.caretRangeFromPoint(event.clientX, event.clientY)
    return range && content.contains(range.startContainer) ? range : null
  }

  function down(event: MouseEvent) {
    if (event.button !== 0) return
    const range = atPoint(event)
    const selection = doc.getSelection()
    if (!range || !selection) return
    if (event.shiftKey && selection.anchorNode && root.contains(selection.anchorNode)) {
      selection.extend(range.startContainer, range.startOffset)
    } else {
      selection.removeAllRanges()
      selection.addRange(range)
    }
    anchor = { node: selection.anchorNode!, offset: selection.anchorOffset }
  }

  function move(event: MouseEvent) {
    if (!anchor || !(event.buttons & 1)) return
    const range = atPoint(event)
    if (!range) return
    doc.getSelection()!.setBaseAndExtent(anchor.node, anchor.offset, range.startContainer, range.startOffset)
  }

  function keydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const selection = muya.getSelection()
    if (!selection || !selection.isSelectionInSameBlock) return
    const { anchor, focus } = selection
    const backwards = event.key === 'ArrowLeft'
    let offset: number
    if (!event.shiftKey && !selection.isCollapsed) {
      offset = backwards ? Math.min(anchor.offset, focus.offset) : Math.max(anchor.offset, focus.offset)
    } else {
      const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(focus.block.text)
      const boundaries = [0, ...Array.from(segments, item => item.index + item.segment.length)]
      offset = backwards
        ? boundaries.filter(value => value < focus.offset).at(-1) ?? focus.offset
        : boundaries.find(value => value > focus.offset) ?? focus.offset
    }
    if (selection.isCollapsed && offset === focus.offset) return
    const next = { ...focus, offset }
    muya.editor.selection.setSelection(event.shiftKey ? anchor : next, next)
    event.preventDefault()
  }

  function up() { anchor = null }
  root.addEventListener('mousedown', down, true)
  root.addEventListener('keydown', keydown)
  doc.addEventListener('mousemove', move)
  doc.addEventListener('mouseup', up)
  return () => {
    root.removeEventListener('mousedown', down, true)
    root.removeEventListener('keydown', keydown)
    doc.removeEventListener('mousemove', move)
    doc.removeEventListener('mouseup', up)
  }
}
