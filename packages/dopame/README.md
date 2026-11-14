# MarkText for Dopame

A Dopame application shell around MarkText's Muya editor and CodeMirror source mode.

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
- Create notes and folders in the selected location; rename files/folders and delete files or empty folders. Renaming a folder updates open document paths. Save or close affected dirty documents before renaming or deleting them.
- Open, create, save and Save As Markdown files using acde roots and standard file pickers.
- UTF-8 text with BOM and LF/CRLF preservation, revision-checked writes for acde roots, dirty indicators, draft recovery, search/replace, undo/redo, and light/dark themes.
- File associations and system menus.

## Runtime integration

`nativeSelection.ts` handles acdert 0.0.9's missing pointer selection and horizontal caret movement using DOM ranges and Muya's selection API. Empty paragraphs use the real content span rather than the generated placeholder text. The independent `test/fixtures/contenteditable` package reproduces the runtime behavior without Vue or Muya.

`npm run typecheck` generates Muya declarations before checking the application. Unit tests cover source outline positions, text preservation and file paths. Native tests cover actual input, mode changes, outline navigation, folder operations, repeated saves and deletion/overwrite protection. CodeMirror's textarea is an input buffer; source assertions read its document rather than treating that buffer as the full Markdown text.

## Deliberately not included yet

The original renderer's Electron shell integration has not been migrated wholesale. Preferences, recent-file history, image insertion and file watching need follow-up. Desktop services, multi-agent task protocol, grants and immutable artifact handoff from the design document are not implemented. File-picker handles only expose best-effort modification-time/size conflict checks; acde-root saves use SDK versions. Local acde validation is not the required competition Dopame server deployment.

Large MarkText UI chunks trigger the default acde bundle-size warning. The editor dependencies remain bundled locally; app pages cannot import JavaScript modules from a CDN.
