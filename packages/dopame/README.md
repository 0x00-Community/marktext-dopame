# MarkText for Dopame

A Dopame application shell using MarkText's Muya editor and CodeMirror source mode.

- Upstream: https://github.com/marktext/marktext
- Pinned commit: `18fdc1eddc7d36d9b205180d058982f71f4f6373` (v0.23.0)
- License: MIT; see the upstream `LICENSE` and `NOTICE.txt`.
- Local changes: `packages/dopame/` is a Vite/Vue entry with acde file, window, picker, and MIME integration. It does not import Electron APIs.

## Development

Install workspace dependencies from the repository root:

```sh
npx pnpm@10.33.4 install
```

Run commands from `packages/dopame`:

```sh
acde doctor
npm run typecheck
npm test
acde check
acde build
acde dev
acde test
```

`acde dev` runs the app in the local acdert runtime and reloads on edits. Use `acde inspect`, `acde act`, `acde shot`, and `acde console --level errors` to verify the actual Dopame page.

## Included

- Muya WYSIWYG editor, Markdown source editor, and read-only preview.
- Multiple tabs, file navigation and outline.
- Create notes and folders, rename and delete in the current location; picking an external folder opens it immediately. Unsaved documents block destructive file operations.
- Open, create, save and Save As Markdown files using acde roots and standard file pickers.
- UTF-8 text with BOM and LF/CRLF preservation, revision-checked writes for acde roots, dirty indicators, draft recovery, search/replace, undo/redo, and light/dark themes.
- Export Copy writes the current text to a newly chosen file without changing the document's save target or dirty state.
- Files that are not UTF-8 are refused with an explanation instead of being decoded lossily; a save that meets an external change keeps both the external file and the local edit.
- Tabs that share a name expose their location in the accessible name.
- Preferences modal dialog (font size, line height, Markdown auto-pairing, source line numbers, optional external file polling interval), recent-file history in the sidebar, and local image-file picker insertion (`assets/` copy + Markdown snippet insertion).
- File associations and system menus.

## Native input

`nativeSelection.ts` adapts acdert 0.0.9 pointer selection and horizontal caret movement. A DOM overlay paints the real collapsed selection because this runtime does not visibly paint the contenteditable caret in the tested editor. It follows the selection geometry, hides outside the focused editor and in read mode, and is removed when the editor is destroyed. Other runtime versions use their native behavior.

Native tests cover rich input, visible caret, undo/redo, source outline navigation, file operations and a system-picked external folder. Source assertions read CodeMirror's document, not its textarea input buffer. Run `acde test --workers 1 --trace` to retain interaction screenshots.

## Keyboard and document recovery

The host dispatches Ctrl and Cmd explicitly rather than relying on the runtime's reported Linux platform. Both editors support Z / Shift+Z / Y for undo / redo. E and Alt+S toggle source mode; Alt+R toggles reading. Inline code uses the backtick key (also Ctrl+Cmd+C), so E cannot accidentally format while switching modes. Shift+H/M/I/R apply highlight, inline math, image markup and clear formatting; Shift+E is retained as a math alias. Digits 1–6 convert headings and 0 restores a paragraph. Quick-insert block shortcuts are displayed by the menu from the host's mapping. N/T create tabs, W closes the active tab, Ctrl/Cmd+Tab and Shift+Tab cycle tabs. N intentionally remains new-tab rather than opening a second OS window.

Unrecognized or unreadable draft sessions are preserved; automatic session writes remain paused for that launch. Explicit document saves remain available. Newly chosen Save As paths are created through the authorized writable handle.

Relative images resolve inside the document's authorized root, including sibling directories within that root. File-picker documents need their containing folder authorized through Add Folder; individual-file access does not authorize sibling images. Within a launch, the selected directory handle resolves picker files to sidebar identities. acdert 0.0.9 does not preserve usable directory handles through IndexedDB; after reload, use Add Folder again before mixing these two opening routes. Image display URLs do not replace Markdown destinations.

## Deliberately not included yet

The original renderer's Electron shell integration has not been migrated wholesale. File-picker handles only expose best-effort modification-time/size conflict checks; acde-root saves use SDK versions. Local acde validation is not the required competition Dopame server deployment.

Large MarkText UI chunks trigger the default acde bundle-size warning. The editor dependencies remain bundled locally; app pages cannot import JavaScript modules from a CDN.
