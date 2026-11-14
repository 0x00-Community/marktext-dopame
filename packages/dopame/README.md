# MarkText for Dopame

This package ports the MarkText editor UI and Muya editor engine to Dopame OS.

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
acde check
acde build
acde dev
acde test
```

`acde dev` runs the app in the local acdert runtime and reloads on edits. Use `acde inspect`, `acde act`, `acde shot`, and `acde console --level errors` to verify the actual Dopame page.

## Included

- Muya WYSIWYG editor, Markdown source editor, and read-only preview.
- Multiple tabs, file tree and outline.
- Open, create, save and Save As Markdown files using acde roots and standard file pickers.
- UTF-8 text with BOM and LF/CRLF preservation, revision-checked writes for acde roots, dirty indicators, draft recovery, search/replace, undo/redo, and light/dark themes.
- File associations and system menus.

## Deliberately not included yet

The original renderer's Electron shell integration has not been migrated wholesale. Preferences, recent-file history, image insertion and file watching need follow-up. Desktop services, multi-agent task protocol, grants and immutable artifact handoff from the design document are not implemented. File-picker handles only expose best-effort modification-time/size conflict checks; acde-root saves use SDK versions. Local acde validation is not the required competition Dopame server deployment.

Large MarkText UI chunks trigger the default acde bundle-size warning. The editor dependencies remain bundled locally; app pages cannot import JavaScript modules from a CDN.
