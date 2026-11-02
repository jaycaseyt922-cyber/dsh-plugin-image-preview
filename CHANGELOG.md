# Changelog

Notable changes to `dsh-plugin-image-preview`. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[SemVer](https://semver.org/) (pre-1.0: a minor bump may change behaviour).

## [0.4.0] - 未发布（0.3.0 之后的第一个对外版本）

The viewer became a workbench: box a region and hand it to the model, annotate the
picture, compare two pictures, and pull the conversation's own pictures back up —
everything in source-image pixels, and every export leaves through the same paste.

Internal milestones (never published, never numbered as releases):
`v0.4.0-internal.1` region selection, `.2` annotator, `.3` A/B comparison,
`.4` per-conversation picture index. The published line stays continuous:
`0.3.0` → `0.4.0`.

### Added

**Region selection and hand-off**
- Viewer: 「选区」 (`S`) — drag a box over the picture, move it, resize it from any
  corner; `Esc` cancels the box before it closes the viewer, and `←/→` will not page
  away a drawn selection.
- 「看图」 hands the cropped PNG and the chosen instruction to the composer with one
  synthetic paste (the same intake as Ctrl+V) and closes the viewer on success;
  failure falls back to the clipboard with a one-line explanation.
- Instruction templates (describe / OCR / compare) kept in one copy table, plus a
  provenance line (`来源：<path>（原图裁切 x,y,w,h）`) for follow-up questions.
- `GET /image-preview/capabilities`: which `vision_*` tools the host exposes, used
  only for the 「看图」 tooltip. Fenced and cached like the other routes.

**Annotator**
- 「标注」 (`A`): rectangle, ellipse, arrow, pen and text, plus a crop region, six
  colours and three stroke widths (which also size the text).
- Undo/redo over `{ marks, crop }` (50 steps), delete the selected mark, clear all;
  `Ctrl+Z` / `Ctrl+Shift+Z` / `Delete`.
- Three exits: `Enter` sends the annotated PNG with the instruction, `Ctrl+C` copies
  it, `Ctrl+S` asks the host to write it and shows the path it used.
- `POST /image-preview/save` on the host half: raw PNG bytes (never base64), 32 MB
  cap, magic-number check, and a host-generated name inside `%TEMP%\image-preview`.
  The client's own name is ignored, so a path can never be traversed.
- A "discard the marks?" question before closing or paging away from unsaved work:
  keep editing / copy then leave / discard (`Esc`). Marks stay drawn after leaving
  the tool bar; only closing or paging asks.
- Export format preference (`格式 PNG/JPG`): JPEG uses quality 0.85 and a white matte
  (transparency would otherwise turn black); the sent file name and the saved
  extension follow the container. `POST /image-preview/save` now accepts
  PNG/JPEG/WebP and derives the extension from the bytes, not from the caller.

**Comparison**
- A/B comparison in the viewer (`对比`, `D`): side-by-side, overlay with a draggable
  split line, and a pixel diff that paints changed pixels red and reports the count
  (`差异像素 N 个`), at up to 1400 px on the long edge.
- In diff mode: 「发送差异」 hands the diff PNG to the composer, 「保存差异」 writes it
  through the host save route.

**Preferences and language**
- 偏好设置 (`⚙`): default colour and stroke width, the default comparison mode, and
  three switches — close the viewer after a successful send, attach the provenance
  line, and auto-submit the draft after the paste. Stored per machine in
  `localStorage` (`dsh-image-preview:prefs`), never written to the profile; 恢复默认
  resets every value. Harness covers the panel, a persisted toggle and the close.
- Copy follows the host's `<html lang>` (`zh*` → Chinese, anything else → English),
  with `navigator.language` as the fallback; `COPY.zh` / `COPY.en` hold every string,
  including the viewer bar and the preferences panel. `?lang=en` on the harness page
  exercises the English table.

**Conversation picture index**
- `preview_image({ recent: true })`: list the pictures this conversation has already
  shown, newest first (with the usual `limit`, max 24). The list is per Agent — one
  Agent is one conversation — so two conversations never see each other's pictures;
  a call without an Agent keeps one process-wide list. Only pictures that really
  resolved are remembered, and an empty conversation answers
  `这个会话还没有显示过图片` instead of an empty card.

**Verification**
- Harness covers the selection geometry, the annotator end to end, the comparison
  (panel, both sides, overlay drag, diff label, diff send, Escape) and the style,
  hover and streaming surfaces.
- Probe assertions cover selection, annotate → save → send, and comparison in a real
  host; host smoke covers the capability and save routes, `recent` ordering/limits/
  isolation, and the fences.

### Changed
- The viewer's keyboard hook answers only keys inside the overlay (`document` /
  `body` included while it is open), so a paste into the composer cannot be
  cancelled by the viewer's Enter/Esc handling.
- One canvas serves both the quick selection and the annotator: same transform,
  same frame as the picture, canvas reallocated only when the viewport changes.
- `Ctrl+C` copies the selected crop while a box exists, the whole picture otherwise.
- A fresh open always starts with no marks; switching pictures with unsaved marks
  asks first instead of silently dropping them.
- The viewer bar gained `选区`, `标注` and `对比`; `对比` is disabled when the set holds
  fewer than two pictures.
- Panning and drawing coalesce into one repaint per frame (`requestAnimationFrame`
  plus a 34 ms fallback for a hidden window) instead of one per pointer event, the
  picture's transform is only rewritten when it actually changed, and the stage
  rectangle is cached (invalidated on open, resize and tool-bar changes) so a move no
  longer forces a synchronous layout. Measured in the harness: 120 pointer moves now
  cost 0.7 ms and **0** `getBoundingClientRect` calls, down from one layout read and a
  full canvas repaint per event.
- The comparison panes reuse the viewer's already-decoded object URL when they show
  the current picture, so opening a comparison fetches two pictures instead of four.
- The guidance mentions `recent: true` as the way to bring earlier pictures back.

### Fixed
- The viewer could be covered by a host float: the browser tool's watch pill
  (`z-index: 2147483000`, fixed bottom-right) sat above the overlay and hid part of
  the action bar. The overlay now uses the maximum z-index, and the harness proves
  it with a stand-in pill and a hit test.
- `test/harness-assertions.js` checked a stale style-tag name and looked for the
  hover panel before it was created; both made green runs look red.
- The harness `wait` helper routed through `requestAnimationFrame`, which never fires
  in a hidden tab: the whole assertion run hung instead of failing. It is a plain
  timer now.
- Probe assertions read a file through PowerShell's argument quoting, which truncates
  at the first double quote (a 5.9 KB file arrived as 139 bytes). `cdp.mjs` grew
  `eval-file`, and the README documents it.

## [0.3.0] - 2026-10-31


The release that made the three surfaces behave under real use: streamed answers,
re-renders, missing files, and the desktop shell's custom scheme.

### Added
- `test/probe-assertions.js`: client-half assertions that run inside the real
  renderer through the probe (`tools/probe.ps1`).
- `tools/window-sampler.ps1`: proves the probe never shows a window on screen.
- Probe `-Supervise`: the probe stops itself (and purges its home) after
  `-ExitAfter` seconds without a CDP client, with `-MaxMinutes` as a hard cap.
- `output.presentationMeta`, so the card paints the pictures a call *produced*
  (`dir:` calls used to render an empty card).

### Changed
- Image transport: `POST /image-preview/read` answers raw bytes
  (`createReadStream`) for `accept: application/octet-stream`. The page reads a
  `Blob` and uses `blob:` object URLs; base64+JSON stays as the fallback for an
  older host. One picture is fetched once per (path, refresh), at most 3 at a
  time, with a 32-entry cache and a 16 MB retain cap.
- `-Stop` purges the probe home (it holds a copy of `.credentials.yaml`).
- Text is pinned to LF by `.gitattributes`; the stale packed tarball is gone.
- `files` ships `test/`, so `npm test` works from an installed package.

### Fixed
- A block could turn blank after a re-render: an adopted picture was owned by the
  new text node while the old node's state still removed it when pruned.
- `data-ip-hide-path` could outlive the picture, leaving a paragraph invisible.
- A hidden/minimized window stops `requestAnimationFrame`, which left streamed
  text undecorated until the window came back; a 250 ms timer now backs it up.
- A missing image walked the whole fallback chain silently; a 404 from the read
  route is now definitive, and the failure label shows the host's reason.
- Evicting a cached blob could revoke a URL an on-screen `<img>` still used.
- `dir:` scanning blocked the host event loop with synchronous `stat` calls.
- `ftyp`-based AVIF detection accepted HEIC/MP4 renamed to `.avif`; the brand is
  now checked.
- Hover panel and focus rings were hard-coded dark; they use theme tokens now.
- Two overlay roots could survive a second module evaluation; the newest
  instance owns the page.

### Security
- `/image-preview/diag` and `/client-report` answered before the
  `connection.requestRejection` fence. Both are fenced now; an unauthenticated
  `diag` reports liveness and per-stage mounts only, never a path or the request
  ring. Routes that read files fail closed (503) when the fence is unavailable.

### Docs
- New "依赖与占用" section: runtime dependencies (none), host capability table,
  disk/memory/CPU bounds, route table with auth, context cost, and how to
  measure each one.
- The probe section is now a contract: never on screen, never left running, with
  the measured timing facts (30 s startup, 30–45 s connection reap, and the fact
  that a minimized window produces no frames at all).

## [0.2.0] - earlier

Bare paths in prose became thumbnails, a path alone on its line became an inline
preview, the `preview_image` card and the full-screen viewer landed. Not
changelogged at the time.

## [0.1.0] - earlier

First working version: host route, tool, text decoration.

