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
- File associations and system menus.

## Native input

`nativeSelection.ts` adapts acdert 0.0.9 pointer selection and horizontal caret movement. A DOM overlay paints the real collapsed selection because this runtime does not visibly paint the contenteditable caret in the tested editor. It follows the selection geometry, hides outside the focused editor and in read mode, and is removed when the editor is destroyed. Other runtime versions use their native behavior.

Native tests cover rich input, visible caret, undo/redo, source outline navigation, file operations and a system-picked external folder. Source assertions read CodeMirror's document, not its textarea input buffer. Run `acde test --workers 1 --trace` to retain interaction screenshots.

## Deliberately not included yet

The original renderer's Electron shell integration has not been migrated wholesale. Preferences, recent-file history, image insertion and file watching need follow-up. Desktop services, multi-agent task protocol, grants and immutable artifact handoff from the design document are not implemented. File-picker handles only expose best-effort modification-time/size conflict checks; acde-root saves use SDK versions. Local acde validation is not the required competition Dopame server deployment.

Large MarkText UI chunks trigger the default acde bundle-size warning. The editor dependencies remain bundled locally; app pages cannot import JavaScript modules from a CDN.
