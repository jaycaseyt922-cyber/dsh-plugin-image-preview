# Changelog

Notable changes to `dsh-plugin-image-preview`. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow
[SemVer](https://semver.org/) (pre-1.0: a minor bump may change behaviour).

## [0.4.0] - 2026-11-02

A picture is now something you can hand to the model: box a region in the viewer,
and the crop plus one instruction land in the composer in a single paste.

### Added
- Viewer: 「选区」 (`S`) — drag a box over the picture, move it, resize it from any
  corner; `Esc` cancels the box before it closes the viewer, and `←/→` will not page
  away a drawn selection.
- 「看图」 hands the cropped PNG and the chosen instruction to the composer with one
  synthetic paste (the same intake as Ctrl+V) and closes the viewer on success;
  failure falls back to the clipboard with a one-line explanation.
- Instruction templates (describe / OCR / compare) kept in one `COPY.zh` table, plus
  a provenance line (`来源：<path>（原图裁切 x,y,w,h）`) for follow-up questions.
- `GET /image-preview/capabilities`: which `vision_*` tools the host exposes, used
  only for the 「看图」 tooltip. Fenced and cached like the other routes.
- `test/harness-assertions.js`: selection geometry, the aria label, and the whole
  paste hand-off into a stand-in Lexical editor.

### Changed
- The viewer's keyboard hook answers only keys inside the overlay (`document` /
  `body` included while it is open), so a paste into the composer cannot be
  cancelled by the viewer's Enter/Esc handling.
- The selection layer repaints in the same frame as the picture transform, and its
  canvas is reallocated only when the viewport changes.
- `Ctrl+C` copies the selected crop while a box exists, the whole picture otherwise.
- Host smoke now covers the capability route, including its fence.

### Fixed
- `test/harness-assertions.js` checked a stale style-tag name and looked for the
  hover panel before it was created; both made green runs look red.

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
