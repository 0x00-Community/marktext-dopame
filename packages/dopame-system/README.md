# MarkText document service

This package implements the `marktext-documents/1` desktop service, a separate Bun/SQLite state process, a credential-injecting Agent client, and standard build inputs for the standalone editor and collaboration preview.

The collaboration preview has no author editing, external save, approval, grant-management or ticket-minting RPC. Production Agent registration and a trusted approval host are not connected. Pairings therefore remain pending; the preview cannot approve them. This is the proposal-assisted preview fallback, not an accepted system Agent collaboration release.

## Build and run

Install the workspace using the repository's lockfile, then run from the repository root:

```sh
pnpm --filter marktext-dopame-system typecheck
pnpm --filter marktext-dopame-system test
pnpm --filter marktext-dopame-system build
pnpm --filter marktext-dopame-system test:e2e
pnpm --filter marktext-dopame-system test:preview
pnpm --filter marktext-dopame-system test:preview-data
pnpm --filter marktext-dopame-system test:approval-host
```

`build` bundles the state process as JavaScript, generates these ordinary acde input projects, and runs `acde check` and `acde build` on each:

- `.acde/inputs/standalone`: the existing editor, without a service dependency.
- `.acde/inputs/collab-editor`: the editor with the author's collaboration module; it needs `approval-desktop`.
- `.acde/inputs/collaboration`: the caller-side debugging panel (`marktext-agent-preview`) that stands in for an Agent, with no file-system or file-picker capability, `multiple:false` and `marktext-review` navigation requests.
- `.acde/inputs/desktop`: the development desktop providing `marktextdocs` exactly as a target desktop would. Nothing in it can approve a pairing.
- `.acde/inputs/approval-desktop`: the same desktop plus a **development approval host**. It has its own ID (`marktext-collaboration-approval-dev`), its own state worker entry and a `release.json` marked `notForProduction`. It is never a release candidate.

Each input's `.acde/` subdirectory is its loadable package. Generated files are ignored; edit the source config, service, worker or build script instead. The standalone and collaboration editions of the editor share the application ID `marktext-dopame` and are alternative installations; the debugging panel has its own ID, `marktext-agent-preview`. The build records the Git commit, uncommitted-state flag, SDK, protocol and disabled release capabilities in the desktop package's `desktop/release.json`.

The desktop package also carries `protocol.schema.json`, `capabilities.schema.json` and `capability-results.schema.json`; `describe` returns the same input and result schemas for the capabilities a caller holds.

The build also verifies the final manifests, disabled approval/multiwindow metadata and absence of development symlinks, native dependencies or SQLite state in all five packages. Run `pnpm --filter marktext-dopame-system test:package` to repeat this artifact check after a build.

All five packages include verbatim copies of the repository's `LICENSE` and `packages/desktop/build/THIRD-PARTY-LICENSES.txt`, under their original filenames. There is no `NOTICE.txt` in this checkout. The third-party declaration is the existing upstream list, not a new dependency license audit.

Use an absolute Bun executable path verified on the deployment machine:

```sh
MARKTEXT_BUN=/absolute/path/to/bun acde dev \
  packages/dopame-system/.acde/inputs/collaboration \
  --desktop packages/dopame-system/.acde/inputs/desktop
```

The standalone editor remains independently runnable with `acde dev packages/dopame`. A missing or invalid `MARKTEXT_BUN`, unsafe storage, failed ownership lock or dead worker makes the document service unavailable; it does not grant a weaker storage mode. The editor's collaboration sidebar and the caller debugging panel display this unavailable state. Setting the runtime location does not enable approvals or grant permissions.

## Collaboration edition, day to day

```sh
pnpm --filter marktext-dopame-system dev:collab
```

This builds the inputs and starts the collaboration edition of the editor in the approval desktop. The desktop has no visible content: it hosts the document service (only a desktop can offer a service to other apps), opens the editor full screen, shows an "打开 MarkText" button only when no MarkText window is open, and briefly shows arriving notifications as dismissible cards. Everything else happens in the editor's collaboration module.

## Development approval host

`approval-desktop` lets a developer complete pairings and exercise author-side review locally. The controls live in the editor, not on the desktop page: the collaboration edition (`.acde/inputs/collab-editor`, the same code as the standalone editor plus `CollaborationModule.vue` and `marktext-review` routing) exposes 31 author host commands (`pairings.list/approve/reject`, `principals.list/revoke`, `grants.revoke`, `inbox.list/read`, `documents.open/adopt/commit/windowState/saveBegin/saveFinish/pendingSaves/saved/recoveryDrafts`, `writer.status/takeover/release`, `proposals.list/get/accept/reject/undo`, `tasks.list/resolveInquiry`, and `writing.status/start/task/cancel`). The author approves a request with one of six presets, optional block/retry/audit constraints and lifetimes, rejects it, revokes a caller or grant, resolves batched task inquiries, runs built-in AI writing tasks (`writing.start/task/cancel` when a system model gateway is configured), or opens a verified inbox draft either as a bound collaborative document or as an independent copy. Only the 12 caller actions (`document:read`, `document:create`, `proposal:create`, `proposal:read`, `task:read`, `task:report_progress`, `audit:review`, `artifact:export`, `artifact:read`, `artifact:share`, `artifact:materialize`, `writing:generate`) can be granted; approving, committing, saving, writer management and grant management cannot, and `audit:review` cannot be combined with write/export actions. Local tabs can also join collaboration (`documents.adopt`), sync edits by revision (`documents.commit`), inspect or take over the writer lease with automatic read-only follower snapshot refresh (`writer.status/takeover`), and accept, reject or undo verified proposals in the editor (`proposals.accept/reject/undo`) with typing held via `reviewGate` and `EditorPort` post-composition settling. Saving an existing collaborative file uses two-phase `documents.saveBegin` and `documents.saveFinish` around `FilePort` (or `documents.saved` for newly picked Save As targets). An unresponsive service delays the save by at most 3 seconds, after which the file is saved unrecorded. The standalone editor needs no service; it keeps only the inert module slot of the shared shell, with no service or approval call.

An app that lists a desktop service receives every namespace of that service, and a service cannot identify its caller, so the host methods cannot be hidden from apps. After each start the service hands a host token to the first claimant, and every host command must carry it. A second claim, by anyone, disables the host for all callers until the desktop service restarts. The editor window checks `status()` before claiming, claims once when it loads, and keeps the token in memory only. The claim state (`unclaimed`, `claimed`, `contested`) is public through `status()`, and the editor's collaboration module warns the developer if the host was already claimed before the editor opened.

Residual risk: nothing guarantees that the author's editor claims first. An app that claims earlier holds every collaboration power the author has in this development workspace—approving pairings and grants, joining documents and writing them as the author, accepting, rejecting and undoing proposals, and recording saves—until the editor loads and its own claim disables the host; grants or edits made in that interval are not rolled back automatically, and the collaboration module warns the developer to restart the desktop and inspect paired callers and documents. The window is open for as long as the editor has not been started, and any listed app can also disable the host with a single claim, which stops approvals, proposal decisions and collaborative syncing until the desktop restarts. Such an app does not get file-system access, and it cannot grant author-only powers to callers. This is why the development host must not be used with real data. Reloading or reopening the editor while the service runs also disables the host.

This is **not** protected human approval. It cannot tell a person from software able to operate the editor window, and the capability catalog reports the approval mode as `development-desktop-host`. The standard `desktop` input, `src/worker.ts` and the public method list are unchanged; package verification fails if any approval-host code appears in the standard desktop or in the agent-side app.

Run it with:

```sh
MARKTEXT_BUN=/absolute/path/to/bun acde dev \
  packages/dopame-system/.acde/inputs/collab-editor \
  --desktop packages/dopame-system/.acde/inputs/approval-desktop
```

## Service boundary

`marktextdocs` exposes `status`, `describe`, `invoke`, `getTask`, `cancelTask`, `listEvents`, `requestPairing` and `claimPairing`. `status` reports availability and the mode; in the approval desktop it also reports the approval host's claim state (`unclaimed`, `claimed`, `contested`). Every document operation carries a separate opaque authentication parameter; the Coordinator validates the current principal and resource grants. Request bodies cannot select the authenticated actor.

The service starts one fixed worker file under its package, using the service's private state directory as the working directory. Only whitelisted JSONL business methods cross this boundary. There are no SQL, arbitrary-path, shell or author-command forwarding methods. JSONL frames, pending calls and timeouts are bounded; timeouts require querying the durable request/task outcome before retrying a side effect. Worker diagnostics do not log request bodies or credentials.

`createAgentClient(transport, credential)` keeps the credential in a trusted closure. Its tool schemas contain only document requests and task references. The client supplies an adapter interface and tool definitions, while explicitly reporting production registration unavailable. Credentials must be stored by a trusted host adapter, never in model arguments, URLs, command lines, localStorage or document text.

The state process uses Bun's built-in SQLite driver and the Coordinator's synchronous transactions. Only that process owns the database connection and lifetime exclusive lock. No native `.node` dependency is distributed. A supported target Bun runtime and durable locking filesystem are deployment requirements; the development machine does not establish target compatibility.

## Verification and release boundaries

Process tests cover whitelisted RPC, unauthorized callers, ownership exclusion and restart persistence. The native test runner creates isolated acde homes, verifies service queries after the last app window closes, restarts the desktop against the same isolated state, and verifies missing-runtime failure. Test-only setup is outside the production worker and packaged inputs.

`test:preview-data` swaps the state worker for `test/fixtures/approving-worker.ts`, which approves every pairing, so the preview can be exercised with real documents, proposals, handoffs and notifications in the local runtime. The fixture is built only into `.acde/data-fixture-desktop`, a separate loadable test desktop with its own ID (`marktext-collaboration-test-fixture`) and a `release.json` marked `notForRelease`. It never enters `.acde/inputs`, package verification rejects a state worker carrying fixture markers, and its results are not evidence of human approval. Do not install that directory on a real desktop.

The preview submits notifications through the standard `Notification` API for newly arrived drafts, pending proposals, finished exports and failed tasks only. They carry a task-type title and a routing tag, never document text, paths or credentials. The development desktop lists them and reopens the app with a `marktext-review` request that only locates the target. The capability catalog keeps notifications marked unavailable until a target desktop is verified.

Target desktop service registration, actual production Agent identities/tool restrictions and protected approval remain target platform release checks. Real notification display/click routing and downstream file-handle receipts remain target desktop checks. No external model gateway is guessed or contacted unless explicitly configured; no multiwindow editing is enabled in production manifests. Task state and fixed artifacts remain authoritative even when these optional integrations are unavailable.
