/**
 * Browser half of the local image preview plugin.
 *
 * Two surfaces, one full-screen viewer:
 *
 * - The `preview_image` tool card: an expanded thumbnail grid instead of the
 *   generic tool row, so a figure the model chose to show lands in the
 *   conversation as a picture, not as a path.
 * - Inline path links: an image path written in plain text (assistant prose,
 *   tool output) is rewritten in place into a small clickable image button.
 *   The official chat already renders Markdown images (`![](...)`) and file
 *   links; this closes the remaining gap, the bare absolute path.
 *
 * The viewer is a plain-DOM overlay on `document.body` (not React): zoom at the
 * cursor, drag to pan, fit/1:1, arrow keys across the images of one message and
 * a manual refresh that busts the host's `no-store` cache.
 *
 * Images come from this plugin's own host route first (`POST /image-preview/read`
 * with the path in the JSON body, answered as raw bytes into a `Blob`), then from
 * the host's `/api/file?path=…`, so nothing has to be re-served and no extra auth
 * is involved.
 *
 * @module dsh-plugin-image-preview/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-image-preview',
  factory: (require) => {
    const React = require('react')
    const module = { exports: {} }
    const exports = module.exports

    /** Extensions the viewer and the in-text linkifier understand. */
    const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp|gif|bmp|avif)$/i
    /**
     * One absolute local image path inside a run of text. Only drive-letter
     * paths are matched: a relative path cannot be resolved from the DOM, and
     * matching prose that merely ends in `.png` would turn sentences into
     * buttons. CJK punctuation ends the path, so "C:\a\b.png，" keeps the comma.
     */
    const PATH_RE =
      /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\n\r<>"'|?*，。；、：！？（）【】《》]*?\.(?:png|jpe?g|webp|gif|bmp|avif)(?![A-Za-z0-9])/gi
    /** Never linkify inside these: they are interactive, literal or already images. */
    const SKIP_TAGS = new Set([
      'A', 'BUTTON', 'CODE', 'PRE', 'IMG', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO',
      'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME',
    ])
    /** Blocks whose whole text is one path: render the picture itself, not a chip. */
    const STANDALONE_TAGS = new Set(['P', 'LI', 'DIV', 'TD', 'DD', 'BLOCKQUOTE', 'FIGCAPTION'])
    /** How many pictures one text node may grow, so a log dump cannot flood the page. */
    const CHIPS_PER_NODE = 12
    /** A Windows path longer than this is treated as a mistake, not a file. */
    const MAX_PATH_LENGTH = 260
    /** Zoom bounds for the viewer. */
    const MIN_SCALE = 0.05
    const MAX_SCALE = 16

    const CSS = `
.dsh-ip-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 34px;
  margin: 0 2px;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 18%, transparent));
  border-radius: 5px;
  background:
    repeating-conic-gradient(color-mix(in srgb, currentColor 6%, transparent) 0% 25%, transparent 0% 50%) 0 0 / 12px 12px,
    transparent;
  color: inherit;
  vertical-align: middle;
  cursor: zoom-in;
}
.dsh-ip-chip:hover {
  border-color: var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 45%, transparent));
}
.dsh-ip-chip:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, currentColor);
  outline-offset: 1px;
}
.dsh-ip-chip img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.dsh-ip-chip-failed {
  padding: 2px;
  font-size: 10px;
  line-height: 1.2;
  text-align: center;
  opacity: 0.7;
  word-break: break-all;
}
.dsh-ip-figure {
  display: block;
  margin: 6px 0 4px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: zoom-in;
}
.dsh-ip-figure:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, currentColor);
  outline-offset: 2px;
}
.dsh-ip-figure img {
  display: block;
  max-width: min(560px, 100%);
  max-height: 320px;
  border: 1px solid var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 16%, transparent));
  border-radius: 6px;
  background:
    repeating-conic-gradient(color-mix(in srgb, currentColor 6%, transparent) 0% 25%, transparent 0% 50%) 0 0 / 16px 16px,
    transparent;
}
.dsh-ip-figure-cap {
  display: block;
  margin-top: 3px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, inherit);
  opacity: 0.85;
  font-variant-numeric: tabular-nums;
}
/* 整块只剩图片路径时，把原始路径那行藏起来：图已经说明一切。
   只改样式、不切文本节点，所以 React 拥有的文本节点保持完整，路径仍可选中复制。 */
[data-ip-hide-path="1"] {
  font-size: 0;
  line-height: 0;
}
[data-ip-hide-path="1"] > br {
  display: none;
}
.dsh-ip-hover {
  position: fixed;
  z-index: 8000;
  display: none;
  max-width: 360px;
  padding: 5px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.18));
  border-radius: 8px;
  background: var(--dsw-alias-bg-overlay, rgba(16, 18, 24, 0.92));
  box-shadow: 0 12px 32px color-mix(in srgb, var(--dsw-alias-label-primary, #000) 22%, transparent);
  pointer-events: none;
}
.dsh-ip-hover img {
  display: block;
  max-width: 340px;
  max-height: 280px;
  border-radius: 5px;
}
.dsh-ip-hover-cap {
  padding: 3px 3px 0;
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 11px;
  opacity: 0.9;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-ip-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 12px;
}
.dsh-ip-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  opacity: 0.72;
}
.dsh-ip-card-title {
  font-weight: 600;
}
.dsh-ip-card-count {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.dsh-ip-card-caption {
  font-size: 13px;
  opacity: 0.85;
  white-space: pre-wrap;
}
.dsh-ip-card-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.dsh-ip-thumb {
  position: relative;
  display: block;
  width: 148px;
  height: 112px;
  padding: 0;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
  border-radius: 6px;
  background:
    repeating-conic-gradient(color-mix(in srgb, currentColor 6%, transparent) 0% 25%, transparent 0% 50%) 0 0 / 16px 16px,
    transparent;
  cursor: zoom-in;
}
.dsh-ip-thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.dsh-ip-thumb:hover {
  border-color: color-mix(in srgb, currentColor 40%, transparent);
}
.dsh-ip-thumb-failed {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px;
  font-size: 11px;
  line-height: 1.4;
  text-align: center;
  opacity: 0.7;
  word-break: break-all;
}
.dsh-ip-card-empty {
  font-size: 12px;
  opacity: 0.7;
}
.dsh-ipv-root {
  position: fixed;
  inset: 0;
  z-index: 9000;
  display: flex;
  flex-direction: column;
  padding-top: var(--dsh-frame-overlay-top, 0px);
  background: rgba(12, 14, 20, 0.86);
  color: #f4f5f7;
  font-family: inherit;
  -webkit-app-region: no-drag;
}
.dsh-ipv-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
}
.dsh-ipv-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  opacity: 0.85;
}
.dsh-ipv-meta {
  flex: none;
  font-size: 12px;
  opacity: 0.6;
  font-variant-numeric: tabular-nums;
}
.dsh-ipv-tools {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
.dsh-ipv-btn {
  min-width: 30px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dsh-ipv-btn:hover {
  background: rgba(255, 255, 255, 0.14);
}
.dsh-ipv-btn[disabled] {
  opacity: 0.35;
  cursor: default;
}
.dsh-ipv-stage {
  position: relative;
  flex: 1;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
}
.dsh-ipv-stage[data-dragging="1"] {
  cursor: grabbing;
}
.dsh-ipv-image {
  position: absolute;
  top: 50%;
  left: 50%;
  max-width: none;
  max-height: none;
  image-rendering: auto;
  transform-origin: center center;
  user-select: none;
  -webkit-user-drag: none;
}
.dsh-ipv-image[data-pixel="1"] {
  image-rendering: pixelated;
}
.dsh-ipv-message {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  font-size: 13px;
  line-height: 1.6;
  text-align: center;
  opacity: 0.8;
  pointer-events: none;
}
.dsh-ipv-hint {
  padding: 6px 12px 10px;
  font-size: 11px;
  opacity: 0.5;
}
`

    // ------------------------------ small helpers ------------------------------

    /**
     * Encode one path into a URL path segment (base64url).
     *
     * The path travels in the pathname rather than a query parameter: a custom
     * scheme proxy may hand the pathname through untouched while the query
     * string is the fragile part.
     * @param {string} value - the absolute local path.
     * @returns {string} the segment, or the empty string when it cannot encode.
     */
    function encodeSegment(value) {
      try {
        const bytes = new TextEncoder().encode(value)
        let binary = ''
        for (const byte of bytes) binary += String.fromCharCode(byte)
        return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
      } catch {
        return ''
      }
    }

    /**
     * Every URL worth trying for one local image, best guess first.
     *
     * This plugin's own read-only route serves the bytes first — once as a path
     * segment (immune to query loss) and once as `?path=…` for older builds — and
     * the official `api/file` follows. Every route is tried against
     * `document.baseURI`, the page URL, the origin and the desktop `dsh-app://`
     * scheme, and for both spellings of a Windows path.
     * @param {string} file - an absolute local path.
     * @param {number} [bust] - a cache-busting stamp for the manual refresh.
     * @returns {string[]} candidate URLs, de-duplicated.
     */
    function imageSourceCandidates(file, bust) {
      if (typeof file !== 'string' || file === '') return []
      if (/^[/\\]{2}/.test(file)) return []
      if (/[\u0000-\u001f\u007f]/u.test(file)) return []
      if (!/^[A-Za-z]:[\\/]/u.test(file)) return []
      const suffix = bust ? '&v=' + bust : ''
      const segment = encodeSegment(file)
      const urls = []
      const push = (value) => {
        if (typeof value === 'string' && value !== '' && !urls.includes(value)) urls.push(value)
      }
      const bases = () => {
        const list = []
        try {
          list.push(new URL('.', document.baseURI).href)
        } catch {
          /* an unusable base */
        }
        try {
          list.push(new URL('.', window.location.href).href)
        } catch {
          /* an unusable page URL */
        }
        try {
          const origin = window.location.origin
          if (typeof origin === 'string' && origin !== 'null' && /^https?:/u.test(origin)) list.push(origin + '/')
        } catch {
          /* no usable origin */
        }
        list.push('dsh-app://app/')
        return list
      }
      const addRoute = (route) => {
        for (const base of bases()) {
          try {
            push(new URL(route, base).href)
          } catch {
            /* this base cannot express the route */
          }
        }
      }
      if (segment !== '') addRoute('image-preview/blob/' + segment)
      for (const spelling of [file, file.replace(/\\/gu, '/')]) {
        addRoute('image-preview/file?path=' + encodeURIComponent(spelling) + suffix)
        addRoute('api/file?path=' + encodeURIComponent(spelling) + suffix)
      }
      return urls
    }

    /**
     * Fetch one image and hand back an object URL.
     *
     * A `<img>` that fails while `fetch` succeeds (a rejected image request, a
     * stale element, a scheme quirk) still ends up on screen this way, and a
     * failed fetch carries the HTTP status that explains the failure.
     */
    const blobUrls = new Map()
    /** Bound the URL-fallback cache too: it holds whole pictures as object URLs. */
    const BLOB_URL_LIMIT = 32

    /** How many URL fallbacks one picture may try before it gives up. */
    const FALLBACK_LIMIT = 12

    /**
     * Resolve one URL to a blob URL, caching successes and forgetting failures.
     * @param {string} url - the image URL.
     * @returns {Promise<string>} a blob URL.
     */
    function toBlobUrl(url) {
      const cached = blobUrls.get(url)
      if (cached !== undefined) return cached
      const task = fetch(url, { credentials: 'same-origin' }).then(async (response) => {
        if (response.ok !== true) {
          let detail = ''
          try {
            detail = (await response.text()).trim().replace(/\s+/gu, ' ').slice(0, 140)
          } catch {
            /* the body is not readable */
          }
          throw new Error('HTTP ' + response.status + (detail === '' ? '' : ' · ' + detail))
        }
        const blob = await response.blob()
        if (blob.size === 0) throw new Error('空响应')
        return URL.createObjectURL(blob)
      })
      task.catch(() => blobUrls.delete(url))
      blobUrls.set(url, task)
      if (blobUrls.size > BLOB_URL_LIMIT) {
        const oldest = blobUrls.keys().next()
        if (oldest.done !== true) {
          releaseEntry(blobUrls.get(oldest.value))
          blobUrls.delete(oldest.value)
        }
      }
      return task
    }

    /** Drop every URL-fallback blob (plugin unload). */
    function releaseBlobUrls() {
      for (const task of blobUrls.values()) releaseEntry(task)
      blobUrls.clear()
    }

    /**
     * Ask the host for one file's bytes over a POST body.
     *
     * The path never enters the URL here: whatever the desktop shell does to a
     * URL, the JSON body is untouched, so this is the transport that survives a
     * re-encoding proxy. The answer is read as raw bytes into a `Blob`, so the
     * page never holds a base64 copy of the picture: an `<img>` points at the
     * object URL, and the bytes leave memory with the URL.
     * @param {string} file - the absolute local path.
     * @returns {Promise<{ url: string, asked: string, bytes: number }>} a blob URL.
     */
    async function readOnce(file) {
      const url = new URL('image-preview/read', document.baseURI).href
      const abort = typeof AbortController === 'function' ? new AbortController() : null
      // The timer covers the whole exchange, body included: a header-only
      // timeout used to leave the body free to hang for minutes.
      const timer = abort === null ? null : setTimeout(() => abort.abort(), 20000)
      let response
      let blob
      try {
        response = await fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/octet-stream' },
          body: JSON.stringify({ path: file }),
          signal: abort === null ? undefined : abort.signal,
        })
        if (response.ok !== true) {
          // A refused read is answered as JSON: keep the host's own reason, not the
          // raw envelope (the chip only has room for a few characters).
          let detail = ''
          try {
            const body = (await response.text()).trim()
            let reason = ''
            try {
              const parsed = JSON.parse(body)
              if (parsed !== null && typeof parsed?.reason === 'string') reason = parsed.reason
            } catch {
              /* not JSON: fall back to the body itself */
            }
            detail = (reason === '' ? body : reason).replace(/\s+/gu, ' ').slice(0, 160)
          } catch {
            /* the body is not readable */
          }
          throw new Error('HTTP ' + response.status + (detail === '' ? '' : ' · ' + detail))
        }
        const mediaType = response.headers.get('content-type') ?? ''
        if (mediaType.includes('application/json')) {
          // An older host answers base64 whatever was asked for.
          const payload = await response.json()
          if (payload?.ok !== true || typeof payload.base64 !== 'string') {
            throw new Error('宿主返回的图片数据不完整')
          }
          const binary = atob(payload.base64)
          const bytes = new Uint8Array(binary.length)
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
          blob = new Blob([bytes], { type: typeof payload.mediaType === 'string' ? payload.mediaType : 'image/png' })
        } else {
          blob = await response.blob()
        }
        if (blob.size === 0) throw new Error('空响应')
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('HTTP ')) throw error
        const message = String((error instanceof Error ? error.message : error) || '未知原因')
        throw new Error('POST 请求失败：' + message)
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
      return { url: URL.createObjectURL(blob), asked: file, bytes: blob.size }
    }

    /** How many byte reads may be in flight at once, so a gallery cannot spike the renderer. */
    const READ_CONCURRENCY = 3
    let activeReads = 0
    const readQueue = []

    /**
     * Run one read once fewer than READ_CONCURRENCY others are running.
     * @param {() => Promise<unknown>} run - the read to admit.
     * @returns {Promise<unknown>} its result.
     */
    function withReadSlot(run) {
      return new Promise((resolve, reject) => {
        const start = () => {
          activeReads += 1
          run()
            .then(resolve, reject)
            .finally(() => {
              activeReads -= 1
              const next = readQueue.shift()
              if (next !== undefined) next()
            })
        }
        if (activeReads < READ_CONCURRENCY) start()
        else readQueue.push(start)
      })
    }

    /** Release one cached blob URL when its entry leaves the cache. */
    function releaseEntry(task) {
      Promise.resolve(task)
        .then((value) => {
          const url = typeof value?.url === 'string' ? value.url : ''
          if (url.startsWith('blob:') !== true) return
          // A picture that is on screen right now still points at this object URL:
          // revoking it blanks the image on the next re-layout. Let it die with the
          // page instead.
          if (document.querySelector('img[src="' + cssEscape(url) + '"]') !== null) return
          URL.revokeObjectURL(url)
        })
        .catch(() => {})
    }

    /**
     * The bytes of one file, shared between every surface that shows it.
     *
     * A path is usually shown more than once — the chip in the prose, the figure
     * under it, the card's thumbnail, the hover preview, the viewer — and each
     * surface used to POST the same file again, so one picture could cost five
     * transfers of its own bytes. The key carries the viewer's refresh stamp, so
     * "刷新" still reads the file again.
     */
    const readCache = new Map()
    const READ_CACHE_LIMIT = 32
    /** Pictures above this size are shown but not retained: a cache is not a hoard. */
    const READ_RETAIN_LIMIT = 16 * 1024 * 1024

    /**
     * Resolve one file's bytes through the host, once per (path, refresh).
     * @param {string} file - the absolute local path.
     * @param {number} [bust] - the viewer's refresh stamp.
     * @returns {Promise<{ url: string, asked: string, bytes: number }>} a blob URL.
     */
    function readViaHost(file, bust) {
      const key = file + '\u0000' + (bust === undefined || bust === 0 ? '' : String(bust))
      const cached = readCache.get(key)
      if (cached !== undefined) return cached
      const task = withReadSlot(() => readOnce(file))
      readCache.set(key, task)
      if (readCache.size > READ_CACHE_LIMIT) {
        const oldest = readCache.keys().next()
        if (oldest.done !== true) {
          releaseEntry(readCache.get(oldest.value))
          readCache.delete(oldest.value)
        }
      }
      // A 30 MB scan is worth showing and not worth pinning in the renderer for
      // the rest of the session; the entry still answers its own callers.
      task.then((value) => {
        if ((Number(value?.bytes) || 0) > READ_RETAIN_LIMIT && readCache.get(key) === task) {
          releaseEntry(task)
          readCache.delete(key)
        }
      }, () => readCache.delete(key))
      return task
    }

    /** Drop every cached blob (plugin unload, or a page that is going away). */
    function releaseReadCache() {
      for (const task of readCache.values()) releaseEntry(task)
      readCache.clear()
    }

    /**
     * Every source for one file: the host's POST answer first, then URL routes.
     * @param {string} file - the absolute local path.
     * @param {number} [bust] - a cache-busting stamp.
     * @returns {Promise<{ list: string[], postError: string }>} candidate sources and the POST failure, when there was one.
     */
    async function sourcesFor(file, bust) {
      const list = []
      let postError = ''
      try {
        const read = await readViaHost(file, bust)
        if (typeof read.url === 'string' && read.url !== '') list.push(read.url)
      } catch (error) {
        // Kept per call: one failing picture must not describe another one's failure.
        postError = String((error instanceof Error ? error.message : error) || '未知原因')
        console.warn('[image-preview] POST 取图失败：' + postError)
      }
      // A 404 from the host's own read route is a verdict about the file itself
      // (gone, not a bitmap, wrong extension), and every other route runs the same
      // check — trying twenty of them only buys twenty more failing requests. A
      // trust or transport failure is different: that can differ per route.
      const settled = postError.startsWith('HTTP 404')
      const fallbacks = imageSourceCandidates(file, bust)
      for (const url of settled === true ? [] : fallbacks.slice(0, FALLBACK_LIMIT)) list.push(url)
      return { list, postError }
    }

    /**
     * Point an `<img>` at a local image, walking every source and falling back
     * to a fetched blob when a direct URL request dies.
     * @param {HTMLImageElement} image - the element to fill.
     * @param {string} file - the absolute local path.
     * @param {(reason: string) => void} onFail - called when nothing worked.
     * @param {number} [bust] - a cache-busting stamp.
     */
    async function attachImage(image, file, onFail, bust) {
      let urls = []
      let postError = ''
      try {
        const sources = await sourcesFor(file, bust)
        urls = sources.list
        postError = sources.postError
      } catch {
        urls = imageSourceCandidates(file, bust)
      }
      let cursor = 0
      let reason = ''
      const next = () => {
        const url = urls[cursor]
        cursor += 1
        if (url === undefined) {
          onFail(reason === '' ? postError || '没有可用的取图地址' : reason)
          return
        }
        // A blob URL and a data URL are already one picture in memory: nothing
        // left to fetch, so a failure here is a decode failure.
        if (url.startsWith('data:') === true || url.startsWith('blob:') === true) {
          image.onerror = () => {
            reason = '宿主返回的字节解不成图片'
            next()
          }
          image.src = url
          return
        }
        image.onerror = () => {
          toBlobUrl(url).then(
            (blobUrl) => {
              image.onerror = next
              image.src = blobUrl
            },
            (error) => {
              reason = String((error instanceof Error ? error.message : error) || '未知原因')
              console.warn('[image-preview] 图片请求失败：' + url + ' → ' + reason)
              next()
            },
          )
        }
        image.src = url
      }
      next()
    }

    /** The last path segment, for labels. */
    function baseName(file) {
      const parts = String(file).split(/[\\/]/)
      return parts[parts.length - 1] || String(file)
    }

    /** Cancel handles for elements that are still waiting to enter the viewport. */
    const waiting = new WeakMap()

    /**
     * Run one loader once its element is near the viewport, so a long transcript
     * does not fetch every thumbnail up front.
     * @param {Element} element - the element to watch.
     * @param {() => void} run - the loader.
     * @returns {() => void} a cancel handle; call it when the element goes away
     * before it was ever visible, otherwise the observer holds it forever.
     */
    function whenVisible(element, run) {
      if (typeof IntersectionObserver !== 'function') {
        run()
        return () => {}
      }
      let fired = false
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting !== true) continue
          fired = true
          observer.disconnect()
          waiting.delete(element)
          run()
          return
        }
      }, { rootMargin: '300px' })
      observer.observe(element)
      const stop = () => {
        if (fired) return
        fired = true
        observer.disconnect()
        waiting.delete(element)
      }
      waiting.set(element, stop)
      return stop
    }

    /** Stop waiting on one element that is being taken out of the document. */
    function dropWaiting(element) {
      const stop = waiting.get(element)
      if (stop !== undefined) stop()
    }

    /** Keep the first occurrence of every path, in order. */    function unique(list) {
      const seen = new Set()
      const out = []
      for (const item of list) {
        if (typeof item !== 'string') continue
        const trimmed = item.trim()
        if (trimmed === '' || seen.has(trimmed)) continue
        seen.add(trimmed)
        out.push(trimmed)
      }
      return out
    }

    // ------------------------------ the viewer ------------------------------

    /**
     * Build the full-screen viewer once, lazily, and keep it as a singleton.
     * The DOM is created on first open and reused afterwards; `destroy` takes it
     * out again when the plugin unloads.
     */
    function createViewer() {
      let root = null
      let stage = null
      let image = null
      let nameLabel = null
      let metaLabel = null
      let zoomLabel = null
      let message = null
      let prevButton = null
      let nextButton = null
      let paths = []
      let index = 0
      let scale = 1
      let offsetX = 0
      let offsetY = 0
      let natural = { width: 0, height: 0 }
      let drag = null
      let bust = 0
      let keyHandler = null
      let candidates = []
      let cursor = 0
      let lastError = ''
      let lastUrl = ''
      let tried = []
      let loadToken = 0
      let showToken = 0
      /** This picture's POST failure, not whichever one finished last. */
      let postFailure = ''
      /** The element to give the keyboard back to when the overlay closes. */
      let returnFocus = null

      /** Clamp the scale to the viewer's bounds. */
      const clamp = (value) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))

      /** Paint the current transform and the readouts. */
      function paint() {
        if (image === null) return
        image.style.transform =
          'translate(-50%, -50%) translate(' + offsetX.toFixed(1) + 'px, ' + offsetY.toFixed(1) + 'px) scale(' + scale.toFixed(4) + ')'
        image.dataset.pixel = scale >= 3 ? '1' : '0'
        if (zoomLabel !== null) zoomLabel.textContent = Math.round(scale * 100) + '%'
      }

      /** Fit the picture inside the stage, centred. */
      function fit() {
        if (image === null || natural.width <= 0 || natural.height <= 0) return
        const box = stage.getBoundingClientRect()
        const room = { width: Math.max(80, box.width - 32), height: Math.max(80, box.height - 32) }
        scale = clamp(Math.min(room.width / natural.width, room.height / natural.height, 1))
        offsetX = 0
        offsetY = 0
        paint()
      }

      /** Show the picture at one image pixel per screen pixel, centred. */
      function actual() {
        scale = 1
        offsetX = 0
        offsetY = 0
        paint()
      }

      /** Run once the current picture is decoded and on screen. */
      function onLoaded() {
        if (image === null) return
        if (!(image.naturalWidth > 0 && image.naturalHeight > 0)) {
          lastError = '图片解出 0 尺寸（可能不是有效图片）'
          cursor += 1
          attempt()
          return
        }
        natural = { width: image.naturalWidth, height: image.naturalHeight }
        metaLabel.textContent =
          natural.width + ' × ' + natural.height + (paths.length > 1 ? ' · ' + (index + 1) + ' / ' + paths.length : '')
        fit()
      }

      /** Give up on the current picture and say precisely why. */
      function failed() {
        if (image === null || message === null) return
        const stamp = showToken
        image.style.display = 'none'
        const recent = tried.slice(-3).join('\n')
        message.textContent =
          '打不开这张图片：' + (paths[index] || '') +
          (lastError === '' ? '' : '\n' + lastError) +
          (postFailure === '' ? '' : '\nPOST：' + postFailure) +
          (lastUrl === '' ? '' : '\n' + lastUrl) +
          (recent === '' ? '' : '\n试过：\n' + recent) +
          '\nbase=' + document.baseURI
        // Ask the host what it sees for this path; the answer names the side at fault.
        // The answer arrives later, so it must not land on a picture the reader has
        // already paged away from.
        const file = paths[index]
        if (file !== undefined) diagLine(file).then((line) => {
          if (message !== null && stamp === showToken) message.textContent += '\n' + line
        })
      }

      /**
       * Ask the host's self-report route what it can see for one path.
       * @param {string} file - the absolute local path.
       * @returns {Promise<string>} one short line for the overlay.
       */
      async function diagLine(file) {
        try {
          const url = new URL('image-preview/diag?path=' + encodeURIComponent(file), document.baseURI).href
          const response = await fetch(url, { credentials: 'same-origin' })
          if (response.ok !== true) return 'diag HTTP ' + response.status
          const report = await response.json()
          return 'diag ok=' + String(report.ok) + ' reason=' + (report.reason || '-') + ' bytes=' + String(report.bytes || 0)
        } catch (error) {
          return 'diag 失败：' + String((error instanceof Error ? error.message : error) || '未知原因')
        }
      }

      /** Try the next candidate URL for the current picture. */
      function attempt() {
        if (image === null) return
        const url = candidates[cursor]
        if (url === undefined) {
          failed()
          return
        }
        const token = ++loadToken
        image.style.display = ''
        image.alt = baseName(paths[index] || '')
        image.onload = () => {
          if (token === loadToken) onLoaded()
        }
        image.onerror = () => {
          if (token !== loadToken) return
          // A blob or data source is already one picture in memory: there is
          // nothing left to fetch, so this is a decode failure.
          if (url.startsWith('blob:') === true || url.startsWith('data:') === true) {
            lastError = '取到了字节但解不成图片'
            tried.push('内存字节 → ' + lastError)
            cursor += 1
            attempt()
            return
          }
          // Some image requests die where a plain fetch succeeds: read the bytes
          // ourselves, and keep the HTTP status as the explanation when that fails.
          toBlobUrl(url).then(
            (blobUrl) => {
              if (token !== loadToken) return
              image.onerror = () => {
                if (token !== loadToken) return
                lastError = '取到了字节但解不成图片'
                tried.push(url + ' → ' + lastError)
                cursor += 1
                attempt()
              }
              image.src = blobUrl
            },
            (error) => {
              if (token !== loadToken) return
              lastError = String((error instanceof Error ? error.message : error) || '未知原因')
              console.warn('[image-preview] 图片请求失败：' + url + ' → ' + lastError)
              tried.push(url + ' → ' + lastError)
              cursor += 1
              attempt()
            },
          )
        }
        image.src = url
        lastUrl = url
        // A cached source does not fire `load` again; fit it here instead.
        if (image.complete === true && image.naturalWidth > 0) onLoaded()
      }

      /** Point the viewer at one path of the current list. */
      async function show(at) {
        if (paths.length === 0) return
        const stamp = ++showToken
        index = Math.max(0, Math.min(paths.length - 1, at))
        const file = paths[index]
        message.textContent = ''
        nameLabel.textContent = baseName(file)
        nameLabel.title = file
        metaLabel.textContent = paths.length > 1 ? index + 1 + ' / ' + paths.length : ''
        prevButton.disabled = index <= 0
        nextButton.disabled = index >= paths.length - 1
        natural = { width: 0, height: 0 }
        scale = 1
        offsetX = 0
        offsetY = 0
        paint()
        candidates = []
        cursor = 0
        lastError = ''
        lastUrl = ''
        tried = []
        postFailure = ''
        const sources = await sourcesFor(file, bust)
        if (stamp !== showToken) return
        postFailure = sources.postError
        candidates = sources.list
        if (candidates.length === 0) {
          image.style.display = 'none'
          message.textContent = '这个路径不能直接预览：' + file
          return
        }
        attempt()
      }

      /**
       * Copy the picture on screen to the clipboard as PNG.
       *
       * The bytes come from the host route (same origin, so the canvas is not
       * tainted); JPEG/WebP sources are re-encoded through a canvas because the
       * clipboard's image item only accepts PNG here.
       */
      async function copyImage() {
        const file = paths[index]
        if (file === undefined || image === null) return
        try {
          const width = image.naturalWidth || natural.width
          const height = image.naturalHeight || natural.height
          if (!(width > 0 && height > 0)) throw new Error('图片还没加载完')
          const canvas = document.createElement('canvas')
          canvas.width = width
          canvas.height = height
          const context = canvas.getContext('2d')
          if (context === null) throw new Error('画布不可用')
          context.drawImage(image, 0, 0, width, height)
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
          if (blob === null) throw new Error('转成 PNG 失败')
          const clipboard = navigator.clipboard
          if (clipboard === undefined || typeof clipboard.write !== 'function') throw new Error('这个环境不支持写图片到剪贴板')
          await clipboard.write([new ClipboardItem({ 'image/png': blob })])
          flash('已复制 ' + width + ' × ' + height + ' 的 PNG 到剪贴板')
        } catch (error) {
          const reason = String((error instanceof Error ? error.message : error) || '未知原因')
          let copiedPath = false
          try {
            if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
              await navigator.clipboard.writeText(file)
              copiedPath = true
            }
          } catch {
            /* the path fallback is best effort */
          }
          flash(copiedPath ? '没能复制图片（' + reason + '），已改为复制路径' : '复制失败：' + reason)
        }
      }

      /** Show one line of feedback over the picture for a moment. */
      function flash(line) {
        if (message === null) return
        message.textContent = line
        setTimeout(() => {
          if (message !== null && message.textContent === line) message.textContent = ''
        }, 2200)
      }

      /** Open one image, with the sibling images of its message for ←/→. */
      function open(list, at) {
        ensure()
        paths = unique(list)
        if (paths.length === 0) return
        bust = 0
        natural = { width: 0, height: 0 }
        if (!root.isConnected) document.body.appendChild(root)
        // Remember where the keyboard came from, and never stack two hooks on one
        // overlay (a second open would make every arrow key step twice).
        if (keyHandler !== null) {
          document.removeEventListener('keydown', keyHandler, true)
        } else {
          returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
        }
        root.style.display = 'flex'
        keyHandler = (event) => {
          if ((event.ctrlKey === true || event.metaKey === true) && (event.key === 'c' || event.key === 'C')) {
            event.preventDefault()
            event.stopPropagation()
            copyImage().catch(() => {})
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close()
            return
          }
          if (event.key === 'ArrowLeft' && index > 0) {
            event.preventDefault()
            event.stopPropagation()
            show(index - 1)
            return
          }
          if (event.key === 'ArrowRight' && index < paths.length - 1) {
            event.preventDefault()
            event.stopPropagation()
            show(index + 1)
            return
          }
          if (event.key === '0' || event.key === 'f') {
            event.preventDefault()
            event.stopPropagation()
            fit()
            return
          }
          if (event.key === '1') {
            event.preventDefault()
            event.stopPropagation()
            actual()
            return
          }
          if (event.key === '+' || event.key === '=') {
            event.preventDefault()
            event.stopPropagation()
            zoomAt(1.25, stage.getBoundingClientRect().width / 2, stage.getBoundingClientRect().height / 2)
            return
          }
          if (event.key === '-') {
            event.preventDefault()
            event.stopPropagation()
            zoomAt(0.8, stage.getBoundingClientRect().width / 2, stage.getBoundingClientRect().height / 2)
          }
        }
        document.addEventListener('keydown', keyHandler, true)
        root.focus()
        show(at)
      }

      /** Close the overlay, drop the keyboard hook and give the focus back. */
      function close() {
        if (root === null) return
        root.style.display = 'none'
        if (keyHandler !== null) {
          document.removeEventListener('keydown', keyHandler, true)
          keyHandler = null
        }
        if (image !== null) {
          image.onerror = null
          image.onload = null
          image.removeAttribute('src')
        }
        // The overlay took the focus; a keyboard reader must land back on the
        // thumbnail they opened it from, not at the top of the document.
        const target = returnFocus
        returnFocus = null
        if (target !== null && target.isConnected === true && typeof target.focus === 'function') {
          target.focus({ preventScroll: true })
        }
      }

      /** Zoom around a stage point, keeping the pixel under it in place. */
      function zoomAt(factor, stageX, stageY) {
        if (image === null || natural.width <= 0) return
        const box = stage.getBoundingClientRect()
        const centerX = box.width / 2
        const centerY = box.height / 2
        const next = clamp(scale * factor)
        if (next === scale) return
        const qx = (stageX - centerX - offsetX) / scale
        const qy = (stageY - centerY - offsetY) / scale
        offsetX = stageX - centerX - next * qx
        offsetY = stageY - centerY - next * qy
        scale = next
        paint()
      }

      /** Create the overlay DOM on first use. */
      function ensure() {
        if (root !== null) return
        // Same reason as the hover float: never leave two viewers in one document.
        for (const stray of document.querySelectorAll('.dsh-ipv-root')) stray.remove()
        root = document.createElement('div')
        root.className = 'dsh-ipv-root'
        root.tabIndex = -1
        root.dataset.ipViewer = '1'
        // A full-screen overlay is a modal dialog for assistive technology: say so,
        // or a screen reader keeps reading the conversation underneath it.
        root.setAttribute('role', 'dialog')
        root.setAttribute('aria-modal', 'true')
        root.setAttribute('aria-label', '图片查看器')
        // Mark it as ours too: an absolute path inside a failure message must not
        // be decorated by this very plugin (that put a thumbnail inside the
        // viewer's own error text and cost one extra read per failure).
        root.dataset.ipOwn = '1'
        root.style.display = 'none'
        root.addEventListener('pointerdown', (event) => event.stopPropagation())
        root.addEventListener('click', (event) => event.stopPropagation())

        const bar = document.createElement('div')
        bar.className = 'dsh-ipv-bar'
        nameLabel = document.createElement('span')
        nameLabel.className = 'dsh-ipv-name'
        metaLabel = document.createElement('span')
        metaLabel.className = 'dsh-ipv-meta'
        const tools = document.createElement('div')
        tools.className = 'dsh-ipv-tools'

        const button = (label, title, onClick) => {
          const element = document.createElement('button')
          element.type = 'button'
          element.className = 'dsh-ipv-btn'
          element.textContent = label
          element.title = title
          // `‹` and `›` are the accessible name otherwise, which reads as nothing.
          element.setAttribute('aria-label', title)
          element.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            onClick()
          })
          tools.appendChild(element)
          return element
        }

        prevButton = button('‹', '上一张（←）', () => show(index - 1))
        nextButton = button('›', '下一张（→）', () => show(index + 1))
        button('−', '缩小（-）', () => {
          const box = stage.getBoundingClientRect()
          zoomAt(0.8, box.width / 2, box.height / 2)
        })
        zoomLabel = document.createElement('span')
        zoomLabel.className = 'dsh-ipv-btn'
        zoomLabel.style.display = 'inline-flex'
        zoomLabel.style.alignItems = 'center'
        zoomLabel.style.justifyContent = 'center'
        zoomLabel.style.cursor = 'default'
        zoomLabel.textContent = '100%'
        tools.appendChild(zoomLabel)
        button('+', '放大（+）', () => {
          const box = stage.getBoundingClientRect()
          zoomAt(1.25, box.width / 2, box.height / 2)
        })
        button('适应', '适应窗口（0 / 双击）', fit)
        button('1:1', '原始像素（1）', actual)
        button('复制', '把这张图复制到剪贴板（Ctrl+C）', () => {
          copyImage().catch(() => {})
        })
        button('刷新', '重新读取文件（覆盖写过的图也能更新）', () => {
          bust = Date.now()
          show(index)
        })
        button('关闭', '关闭（Esc）', close)

        const stageElement = document.createElement('div')
        stageElement.className = 'dsh-ipv-stage'
        const picture = document.createElement('img')
        picture.className = 'dsh-ipv-image'
        picture.decoding = 'async'
        picture.alt = ''
        const messageElement = document.createElement('div')
        messageElement.className = 'dsh-ipv-message'
        // Failure explanations and the copy/reload confirmations are announced.
        messageElement.setAttribute('role', 'status')
        messageElement.setAttribute('aria-live', 'polite')
        stageElement.append(picture, messageElement)
        stage = stageElement
        image = picture
        message = messageElement

        stageElement.addEventListener('dblclick', (event) => {
          event.preventDefault()
          if (scale >= 1.99 || scale <= 1.01) actual()
          else fit()
        })
        stageElement.addEventListener('pointerdown', (event) => {
          if (event.button !== 0 || scale <= 0) return
          drag = { x: event.clientX, y: event.clientY, left: offsetX, top: offsetY }
          stageElement.dataset.dragging = '1'
          stageElement.setPointerCapture(event.pointerId)
        })
        stageElement.addEventListener('pointermove', (event) => {
          if (drag === null) return
          offsetX = drag.left + (event.clientX - drag.x)
          offsetY = drag.top + (event.clientY - drag.y)
          paint()
        })
        const endDrag = (event) => {
          if (drag === null) return
          drag = null
          stageElement.dataset.dragging = '0'
          try {
            stageElement.releasePointerCapture(event.pointerId)
          } catch {
            /* the pointer is already gone */
          }
        }
        stageElement.addEventListener('pointerup', endDrag)
        stageElement.addEventListener('pointercancel', endDrag)
        stageElement.addEventListener(
          'wheel',
          (event) => {
            event.preventDefault()
            const box = stageElement.getBoundingClientRect()
            if (event.ctrlKey === true || event.metaKey === true) {
              zoomAt(Math.exp(-event.deltaY * 0.0025), event.clientX - box.left, event.clientY - box.top)
              return
            }
            zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX - box.left, event.clientY - box.top)
          },
          { passive: false },
        )

        const hint = document.createElement('div')
        hint.className = 'dsh-ipv-hint'
        hint.textContent = '滚轮缩放 · 拖动平移 · 双击切换适应/1:1 · ←/→ 换图 · Esc 关闭'

        bar.append(nameLabel, metaLabel, tools)
        root.append(bar, stageElement, hint)
        root.addEventListener('pointerdown', (event) => {
          if (event.target === root) close()
        })
        document.body.appendChild(root)
      }

      /** Take the overlay out of the page on unload. */
      function destroy() {
        close()
        if (root !== null) root.remove()
        root = null
      }

      return { open, close, destroy }
    }

    const viewer = createViewer()

    // --------------------------- in-text image links ---------------------------

    /** Per-text-node decoration state, so a re-render never duplicates a chip. */
    const decorations = new WeakMap()
    /**
     * Which state currently owns each inserted element.
     *
     * A re-render replaces the text node while its picture survives; the new node
     * adopts that picture, but the old node's state still lists it. Without this
     * index, pruning the old node removed the adopted picture — leaving a block
     * whose path text was hidden with no picture in it.
     */
    const owners = new WeakMap()

    /**
     * Decorate one text node with thumbnails for the image paths it mentions.
     *
     * The text itself is never split or replaced: React still owns that node and
     * keeps writing streamed text into it, so the decoration is purely additive.
     * A path on its own line becomes a full-width thumbnail; a path inside prose
     * gets a small thumbnail chip after the run.
     * @param {Text} node - a live text node.
     */
    function decorate(node) {
      const data = node.nodeValue
      if (typeof data !== 'string' || data.length < 6) {
        dropDecorations(node)
        return
      }
      PATH_RE.lastIndex = 0
      const found = []
      for (let match = PATH_RE.exec(data); match !== null; match = PATH_RE.exec(data)) {
        if (match[0].length > MAX_PATH_LENGTH) continue
        found.push(match[0])
        if (found.length >= CHIPS_PER_NODE) break
      }
      const wanted = unique(found)
      if (wanted.length === 0) {
        dropDecorations(node)
        return
      }
      const state = decorations.get(node) ?? { items: new Map(), anchor: node }
      // A path that scrolled out of the text (a re-render shortened the run) loses its picture.
      for (const [file, element] of Array.from(state.items)) {
        if (wanted.includes(file)) continue
        if ((owners.get(element) ?? state) === state) {
          dropWaiting(element)
          element.remove()
        }
        state.items.delete(file)
      }
      let anchor = state.anchor !== null && state.anchor.isConnected ? state.anchor : node
      for (const file of wanted) {
        if (state.items.has(file)) continue
        // A React re-render can replace the text node while the old picture
        // survives in the same block; adopt it instead of stacking a second one.
        const parent = anchor.parentNode
        if (parent === null) break
        const adopted = parent.querySelector('[data-ip-path="' + cssEscape(file) + '"]')
        if (adopted !== null) {
          anchor = adopted
          state.items.set(file, adopted)
          owners.set(adopted, state)
          continue
        }
        const element = standalonePath(node, file) ? figureFor(file) : chipFor(file)
        if (element === null) continue
        parent.insertBefore(element, anchor.nextSibling)
        anchor = element
        state.items.set(file, element)
        owners.set(element, state)
      }
      state.anchor = anchor
      if (state.items.size === 0) decorations.delete(node)
      else decorations.set(node, state)
      updatePathVisibility(node.parentElement)
    }

    /** Remove every decoration this plugin added for one text node. */
    function dropDecorations(node) {
      const state = decorations.get(node)
      if (state !== undefined) {
        for (const element of state.items.values()) {
          // A picture adopted by another (newer) text node belongs to that node now:
          // removing it here is what left a hidden block with no picture in it.
          if ((owners.get(element) ?? state) !== state) continue
          dropWaiting(element)
          element.remove()
        }
        decorations.delete(node)
      }
      // Always re-evaluate the block: a path that left the text must also drop the
      // `data-ip-hide-path` that was hiding the raw path line, or a paragraph whose
      // picture went away stays invisible for good.
      updatePathVisibility(node.parentElement)
    }

    /**
     * Whether the text run is just this one path, so it deserves a real
     * thumbnail instead of a chip.
     * @param {Text} node - the text node holding the path.
     * @param {string} file - the matched path.
     * @returns {boolean} true when the path stands alone in its block.
     */
    function standalonePath(node, file) {
      const parent = node.parentElement
      if (parent === null || !STANDALONE_TAGS.has(parent.tagName)) return false
      const run = String(node.nodeValue).replace(/\s+/gu, '').replace(/[。，、；：！？.）】」》]+$/gu, '')
      if (run !== file.replace(/\s+/gu, '')) return false
      for (const child of parent.childNodes) {
        if (child === node) continue
        if (child.nodeType === 3 && child.nodeValue.trim() !== '') return false
        if (child.nodeType !== 1) continue
        if (child.tagName === 'BR') continue
        if (child.dataset !== undefined && child.dataset.ipOwn !== undefined) continue
        return false
      }
      return true
    }

    /** Whether this text node lives somewhere the decorator must not touch. */
    function skipNode(node) {
      let element = node.parentElement
      while (element !== null) {
        if (SKIP_TAGS.has(element.tagName)) return true
        if (element.isContentEditable === true) return true
        if (element.dataset !== undefined && element.dataset.ipOwn !== undefined) return true
        if (element.tagName === 'ASIDE') return true
        element = element.parentElement
      }
      return false
    }

    /** Open the viewer at one file, with the images of the same message around it. */
    function openFrom(element, file) {
      const scope = scopePaths(element)
      const at = scope.indexOf(file)
      viewer.open(scope.length > 1 ? scope : [file], at < 0 ? 0 : at)
    }

    /** Build the small inline thumbnail that follows a path inside prose. */
    function chipFor(file) {
      if (imageSourceCandidates(file).length === 0) return null
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'dsh-ip-chip'
      chip.dataset.ipOwn = '1'
      chip.dataset.ipPath = file
      chip.title = '预览图片：' + file
      chip.setAttribute('aria-label', '预览图片 ' + file)
      const img = document.createElement('img')
      img.loading = 'lazy'
      img.decoding = 'async'
      img.alt = ''
      chip.appendChild(img)
      whenVisible(chip, () => {
        attachImage(img, file, (reason) => {
          // The chip is 46×34: show the reason, keep the full path in the tooltip.
          chip.title = '打不开：' + file + '\n' + reason
          chip.replaceChildren(failedLabel(reason))
        })
      })
      chip.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        openFrom(chip, file)
      })
      hover.attach(chip, file)
      return chip
    }

    /** Build the thumbnail that replaces a path standing on its own line. */
    function figureFor(file) {
      if (imageSourceCandidates(file).length === 0) return null
      const figure = document.createElement('button')
      figure.type = 'button'
      figure.className = 'dsh-ip-figure'
      figure.dataset.ipOwn = '1'
      figure.dataset.ipPath = file
      figure.title = '点开查看原图：' + file
      const img = document.createElement('img')
      img.loading = 'lazy'
      img.decoding = 'async'
      img.alt = baseName(file)
      const caption = document.createElement('span')
      caption.className = 'dsh-ip-figure-cap'
      caption.textContent = baseName(file)
      img.addEventListener('load', () => {
        caption.textContent = baseName(file) + ' · ' + img.naturalWidth + ' × ' + img.naturalHeight
      })
      figure.append(img, caption)
      whenVisible(figure, () => {
        attachImage(img, file, (reason) => {
          figure.title = '打不开：' + file + '\n' + reason
          figure.replaceChildren(failedLabel(baseName(file) + '：' + reason, 60))
        })
      })
      figure.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        openFrom(figure, file)
      })
      return figure
    }

    /**
     * A small "this one will not open" label.
     * @param {string} text - what to show.
     * @param {number} [limit] - how many characters fit.
     * @returns {HTMLSpanElement} the label.
     */
    function failedLabel(text, limit = 24) {
      const span = document.createElement('span')
      span.className = 'dsh-ip-chip-failed'
      span.textContent = '打不开 ' + String(text).slice(0, limit)
      return span
    }

    /**
     * Whether a block holds nothing but image paths and punctuation.
     *
     * Such a block is now a picture, so its raw path line is noise: the reader
     * gains nothing from `C:/Users/…/fig.png` above the figure it already sees.
     * @param {Element | null} parent - the block that holds the text.
     * @returns {boolean} true when nothing but paths, punctuation and whitespace remain.
     */
    function blockIsOnlyPaths(parent) {
      if (parent === null) return false
      for (const child of parent.childNodes) {
        if (child.nodeType === 3) {
          const rest = String(child.nodeValue)
            .replace(PATH_RE, '')
            .replace(/[\s。，、；：！？·—…,.!?;:）】」》〉"'"]/gu, '')
          if (rest !== '') return false
          continue
        }
        if (child.nodeType !== 1) continue
        if (child.tagName === 'BR') continue
        // Our own chip/figure/caption does not count as leftover text.
        if (child.dataset !== undefined && child.dataset.ipOwn !== undefined) continue
        return false
      }
      return true
    }

    /**
     * Hide a block's raw path text once every path in it is drawn, and restore it
     * when the pictures go away.
     *
     * This only sets an attribute on the block: the text node React owns is never
     * split or rewritten, so the path stays selectable and copyable, and a
     * re-render cannot leave a dangling reference behind.
     * @param {Element | null} parent - the block that holds decorated text.
     */
    function updatePathVisibility(parent) {
      if (parent === null || parent.dataset === undefined || parent.dataset === null) return
      const drawn = parent.querySelector('[data-ip-path]') !== null
      if (drawn === true && blockIsOnlyPaths(parent) === true) parent.dataset.ipHidePath = '1'
      else if (parent.dataset.ipHidePath !== undefined) delete parent.dataset.ipHidePath
    }

    /** Escape one value for an attribute selector without depending on CSS.escape. */
    function cssEscape(value) {
      return String(value).replace(/[\\"]/gu, '\\$&')
    }

    /**
     * Every other image path in the same message, so ←/→ walks one message.
     * @param {Element} element - the clicked thumbnail.
     * @returns {string[]} absolute paths, in document order.
     */
    function scopePaths(element) {
      let scope = element
      while (scope !== null && scope !== document.body) {
        if (scope.hasAttribute?.('data-chat-anchor-key') || scope.hasAttribute?.('data-chat-flow-key')) break
        scope = scope.parentElement
      }
      const root = scope === null || scope === document.body ? document.body : scope
      const found = Array.from(root.querySelectorAll('[data-ip-path]')).map((chip) => chip.dataset.ipPath)
      return unique(found)
    }

    /**
     * One floating preview shared by every chip: hover a thumbnail and the full
     * picture appears next to it, no click needed.
     */
    function createHover() {
      let root = null
      let image = null
      let caption = null
      let timer = null
      let file = null
      let anchor = null
      let shownUrl = null

      /** Build the floating box on first use. */
      function ensure() {
        if (root !== null) return
        // A second evaluation of this bundle can leave its float behind, and then
        // one pointer would be answered by two overlays (the stale one hiding the
        // live one). The newest instance owns the page.
        for (const stray of document.querySelectorAll('.dsh-ip-hover')) stray.remove()
        root = document.createElement('div')
        root.className = 'dsh-ip-hover'
        root.dataset.ipOwn = '1'
        image = document.createElement('img')
        image.alt = ''
        caption = document.createElement('div')
        caption.className = 'dsh-ip-hover-cap'
        root.append(image, caption)
        document.body.appendChild(root)
        image.addEventListener('load', place)
        document.addEventListener('scroll', hide, true)
        window.addEventListener('resize', hide)
      }

      /** Put the box under (or above) the hovered chip, inside the viewport. */
      function place() {
        if (root === null || anchor === null || anchor.isConnected !== true) return
        const rect = anchor.getBoundingClientRect()
        const box = root.getBoundingClientRect()
        const gap = 8
        let top = rect.bottom + gap
        if (top + box.height > window.innerHeight - 8) top = Math.max(8, rect.top - gap - box.height)
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8))
        root.style.left = Math.round(left) + 'px'
        root.style.top = Math.round(top) + 'px'
      }

      /** Reveal the floating preview for the chip that armed it. */
      function show() {
        if (file === null || anchor === null || anchor.isConnected !== true) return
        if (imageSourceCandidates(file).length === 0) return
        ensure()
        if (shownUrl !== file) {
          shownUrl = file
          image.style.display = ''
          attachImage(image, file, (reason) => {
            image.style.display = 'none'
            caption.textContent = '打不开这张图（' + reason + '）'
            place()
          })
        }
        caption.textContent = baseName(file)
        root.style.display = 'block'
        place()
      }

      /** Hide the floating preview and cancel a pending timer. */
      function hide() {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        if (root !== null) root.style.display = 'none'
      }

      /** Watch one chip for hover. */
      function attach(element, path) {
        element.addEventListener('pointerenter', () => {
          file = path
          anchor = element
          if (timer !== null) clearTimeout(timer)
          timer = setTimeout(() => {
            timer = null
            show()
          }, 220)
        })
        element.addEventListener('pointerleave', hide)
        element.addEventListener('pointerdown', hide)
        element.addEventListener('focus', () => {
          file = path
          anchor = element
          show()
        })
        element.addEventListener('blur', hide)
      }

      /** Take the floating box out of the page on unload. */
      function destroy() {
        hide()
        document.removeEventListener('scroll', hide, true)
        window.removeEventListener('resize', hide)
        if (root !== null) root.remove()
        root = null
      }

      return { attach, destroy }
    }

    const hover = createHover()

    /**
     * Watch the page for rendered text and decorate the image paths in it.
     * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context for disposal.
     */
    function watchText(ctx) {
      const pending = new Set()
      let scheduled = false
      let stopped = false

      const flush = () => {
        scheduled = false
        if (stopped) return
        const batch = Array.from(pending)
        pending.clear()
        for (const node of batch) {
          try {
            if (node.isConnected !== true || node.parentNode === null) continue
            if (skipNode(node)) continue
            decorate(node)
          } catch {
            /* one unreadable node must not stop the pass */
          }
        }
      }

      const schedule = () => {
        if (scheduled || stopped) return
        scheduled = true
        if (typeof requestAnimationFrame !== 'function') {
          setTimeout(flush, 30)
          return
        }
        // A hidden or minimized window stops requestAnimationFrame outright, and then
        // a transcript that streamed in the background stays undecorated until the
        // window comes back. The timer is the safety net: whichever fires first wins
        // and `flush` is idempotent.
        let timer = null
        const frame = requestAnimationFrame(() => {
          if (timer !== null) clearTimeout(timer)
          flush()
        })
        timer = setTimeout(() => {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
          flush()
        }, 250)
      }

      const collect = (node) => {
        if (node.nodeType === 3) {
          pending.add(node)
          return
        }
        if (node.nodeType !== 1) return
        const element = node
        if (SKIP_TAGS.has(element.tagName)) return
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
          pending.add(text)
          if (pending.size > 800) break
        }
      }

      /** Forget the decorations of a text node the page took out of the document. */
      const prune = (node) => {
        if (node.nodeType === 3) {
          dropDecorations(node)
          return
        }
        if (node.nodeType !== 1) return
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
        for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) dropDecorations(text)
      }

      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'characterData') {
            if (record.target.nodeType === 3) pending.add(record.target)
            continue
          }
          for (const added of record.addedNodes) collect(added)
          for (const removed of record.removedNodes) prune(removed)
        }
        if (pending.size > 0) schedule()
      })
      observer.observe(document.body, { subtree: true, childList: true, characterData: true })
      // A sweep for text the mutation stream missed (a virtualized row that
      // arrived without an observable insertion, a host re-render that reused
      // nodes): the decoration is idempotent, so re-scanning is safe.
      //
      // It is a whole-document walk, so it only runs while somebody can see the
      // window, and rarely: the observer already covers streaming text, and a
      // background window has no reason to burn a walk every few seconds.
      const sweep = setInterval(() => {
        if (stopped || document.visibilityState === 'hidden') return
        try {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
          let count = 0
          for (let text = walker.nextNode(); text !== null && count < 1500; text = walker.nextNode()) {
            count += 1
            if (text.nodeValue === null || text.nodeValue.length < 6) continue
            if (text.nodeValue.search(PATH_RE) < 0) continue
            pending.add(text)
          }
          if (pending.size > 0) schedule()
        } catch {
          /* an unreadable document simply gets no sweep */
        }
      }, 15000)
      if (typeof sweep.unref === 'function') sweep.unref()
      // Coming back to the window is the moment a missed row becomes visible, so
      // one sweep right then is worth more than the idle timer.
      const onVisible = () => {
        if (document.visibilityState !== 'visible' || stopped) return
        try {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
          let count = 0
          for (let text = walker.nextNode(); text !== null && count < 1500; text = walker.nextNode()) {
            count += 1
            if (text.nodeValue === null || text.nodeValue.length < 6) continue
            if (text.nodeValue.search(PATH_RE) < 0) continue
            pending.add(text)
          }
          if (pending.size > 0) schedule()
        } catch {
          /* nothing to sweep */
        }
      }
      document.addEventListener('visibilitychange', onVisible)
      ctx.effect(() => () => {
        stopped = true
        clearInterval(sweep)
        document.removeEventListener('visibilitychange', onVisible)
        observer.disconnect()
        pending.clear()
      })

      // First pass over what is already on screen.
      try {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        let seen = 0
        for (let text = walker.nextNode(); text !== null && seen < 3000; text = walker.nextNode()) {
          seen += 1
          pending.add(text)
        }
        if (pending.size > 0) schedule()
      } catch {
        /* an unreadable document simply gets no first pass */
      }
    }

    // ------------------------------ the tool card ------------------------------

    /**
     * Unwrap one argument carrier into plain arguments.
     *
     * `block.args` is a plain object on a settled call, but a still-streaming call
     * hands over a `PartialArguments` reader (`chunks` / `object` / `sealed`)
     * whose own fields look nothing like the tool's arguments. Treating the
     * reader as arguments is why the card said "准备中…" until the very end and
     * why a mount report could read `k=chunks.object.sealed`.
     * @param {unknown} value - one candidate argument carrier.
     * @returns {object | null} the parsed arguments, or null when there are none.
     */
    function plainArgs(value) {
      if (value === null || typeof value !== 'object') return null
      if (Array.isArray(value.chunks) || typeof value.sealed === 'boolean') {
        const parsed = value.object
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
        return parsed
      }
      return value
    }

    /**
     * The `preview_image` arguments, tolerant of every lifecycle stage.
     * @param {object | undefined} call - the phase payload the tool slot passes.
     * @returns {object} the arguments seen so far, or an empty object.
     */
    function toolArgs(call) {
      if (call === undefined || call === null || call.block === undefined || call.block === null) return {}
      const block = call.block
      // The Tool view props have changed shape across host versions: read every
      // place the arguments may sit and keep the first one that carries a path.
      const found = []
      if (block.call !== undefined && block.call !== null && block.call.args !== undefined && block.call.args !== null) {
        const args = plainArgs(block.call.args)
        if (args !== null) found.push(args)
      }
      if (block.args !== undefined && block.args !== null) {
        const args = plainArgs(block.args)
        if (args !== null) found.push(args)
      }
      for (const raw of [block.argsRaw, block.call?.argsRaw]) {
        if (typeof raw !== 'string' || raw.trim() === '') continue
        try {
          const parsed = JSON.parse(raw)
          if (parsed !== null && typeof parsed === 'object') found.push(parsed)
        } catch {
          /* a partially streamed argument object is not parseable yet */
        }
      }
      for (const candidate of found) {
        if (Array.isArray(candidate.paths) || typeof candidate.path === 'string') return candidate
      }
      return found[0] ?? {}
    }

    /** The image paths one call asked for, or the ones its settled result names. */
    function toolPaths(call) {
      // A `dir` call never names its pictures in the arguments: the host expands the
      // directory and records the answer as result metadata. Prefer that, so the
      // card paints what the call produced instead of "没有可显示的图片。" on a
      // call that plainly did produce pictures.
      const meta = call?.block?.meta
      if (meta !== null && typeof meta === 'object' && Array.isArray(meta.images)) {
        const stated = []
        for (const entry of meta.images) {
          const file = typeof entry === 'string' ? entry : entry !== null && typeof entry === 'object' && typeof entry.path === 'string' ? entry.path : ''
          if (file !== '') stated.push(file)
        }
        if (stated.length > 0) return unique(stated).slice(0, 24)
      }
      const args = toolArgs(call)
      const list = []
      if (Array.isArray(args.paths)) list.push(...args.paths)
      if (typeof args.path === 'string') list.push(args.path)
      return unique(list).slice(0, 24)
    }

    /** One thumbnail, walking the candidate routes before it gives up. */
    function Thumbnail({ file, onOpen }) {
      const [phase, setPhase] = React.useState('loading')
      const [reason, setReason] = React.useState('')
      const holder = React.useRef(null)
      React.useEffect(() => {
        const node = holder.current
        if (node === null) return () => {}
        setPhase('loading')
        setReason('')
        // A card can hold 24 pictures: fetching them all on mount is what turned
        // one gallery into 24 simultaneous reads. Fetch a thumbnail when it is
        // about to be seen, and cancel the wait when the card unmounts first.
        let cancelled = false
        const stop = whenVisible(node, () => {
          if (cancelled) return
          node.onload = () => setPhase('ok')
          attachImage(node, file, (why) => {
            setReason(why)
            setPhase('failed')
          })
        })
        return () => {
          cancelled = true
          stop()
          node.onerror = null
          node.onload = null
        }
      }, [file])
      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-ip-thumb',
          title: '点开查看：' + file,
          onClick: () => onOpen(),
        },
        phase === 'failed'
          ? React.createElement('span', { className: 'dsh-ip-thumb-failed' }, '打不开\n' + baseName(file) + '\n' + reason)
          : React.createElement('img', {
              ref: holder,
              alt: baseName(file),
              loading: 'lazy',
              decoding: 'async',
              style: phase === 'loading' ? { opacity: 0.25 } : undefined,
            }),
      )
    }
    /**
     * The tool slot hands the phase payload either as `call` or split across
     * `phase` and `block`, depending on how the call tree dispatches it.
     * @param {object} props - the Tool-owned view props.
     * @returns {{ phase: string, block: object } | undefined} the phase payload.
     */
    function phaseOf(props) {
      if (props.call !== undefined && props.call !== null) return props.call
      if (typeof props.phase === 'string' && props.block !== undefined && props.block !== null) {
        return { phase: props.phase, block: props.block }
      }
      return undefined
    }

    /**
     * Whole-call view of `preview_image`: an expanded grid of the figures the
     * model chose to show, never a collapsed path.
     * @param {object} props - the Tool-owned view props.
     */
    function PreviewImageCard(props) {
      const call = phaseOf(props)
      const paths = React.useMemo(() => toolPaths(call), [call])
      const caption = React.useMemo(() => {
        const args = toolArgs(call)
        return typeof args.caption === 'string' ? args.caption : ''
      }, [call])
      React.useEffect(() => {
        // One line to the host's recorder per mounted card: which props shape the
        // slot handed over and how many paths came out of it. Encoded into the
        // stage string so even an older host records it verbatim.
        const block = props.block ?? call?.block
        report(
          'card-render n=' + paths.length +
            ' p=' + String(props.phase ?? call?.phase ?? '') +
            ' b=' + (block ? 1 : 0) +
            ' c=' + (block && block.call ? 1 : 0) +
            ' k=' + Object.keys(toolArgs(call)).join('.'),
        )
      }, [])
      const open = React.useCallback(
        (at) => {
          viewer.open(paths, at)
        },
        [paths],
      )
      const settled = call?.phase === 'result'
      const failed = settled === true && call.block?.isError === true
      return React.createElement(
        'div',
        { className: 'dsh-ip-card', 'data-ip-card': '1' },
        React.createElement(
          'div',
          { className: 'dsh-ip-card-head' },
          svgIconNode(13),
          React.createElement('span', { className: 'dsh-ip-card-title' }, '预览图片'),
          React.createElement('span', { className: 'dsh-ip-card-count' }, paths.length > 0 ? paths.length + ' 张' : '准备中…'),
        ),
        caption !== '' ? React.createElement('div', { className: 'dsh-ip-card-caption' }, caption) : null,
        failed
          ? React.createElement('div', { className: 'dsh-ip-card-empty' }, '这次预览失败了，展开详情看原因。')
          : null,
        paths.length === 0 && settled === true
          ? React.createElement('div', { className: 'dsh-ip-card-empty' }, '没有可显示的图片。')
          : null,
        paths.length > 0
          ? React.createElement(
              'div',
              { className: 'dsh-ip-card-grid' },
              paths.map((file, at) =>
                React.createElement(Thumbnail, { key: file + ':' + at, file, onOpen: () => open(at) }),
              ),
            )
          : null,
      )
    }

    /** The card head icon as a React element (the DOM helper builds a plain node). */
    function svgIconNode(size) {
      return React.createElement(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        React.createElement('rect', { x: 1.8, y: 2.6, width: 12.4, height: 10.8, rx: 1.6 }),
        React.createElement('circle', { cx: 5.6, cy: 6.2, r: 1.1 }),
        React.createElement('path', { d: 'M3.2 12.2 6.9 8.6l2.6 2.6 1.7-1.5 2.3 2.5' }),
      )
    }

    // ------------------------------ plugin wiring ------------------------------

    /** Services this browser half needs. */
    const inject = ['slots']

    /**
     * Wire the plugin into the page.
     * @param {import('@deepseek-ai/cordis').Context} ctx - the browser plugin context.
     */
    /**
     * Tell the host how this half mounted. The host records it next to the image
     * requests, so one `diag` read says whether the card registered and why not.
     * @param {string} stage - the mount step that finished or failed.
     * @param {unknown} [error] - the failure, when that step failed.
     * @param {object} [extra] - any extra facts worth reporting.
     */
    function report(stage, error, extra) {
      try {
        const url = new URL('image-preview/client-report', document.baseURI).href
        fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            stage,
            error: error === undefined ? '' : String((error instanceof Error ? error.stack || error.message : error) || '').slice(0, 600),
            ...extra,
          }),
        }).catch(() => {})
      } catch {
        /* a report that cannot be sent is not worth failing over */
      }
    }

    /**
     * Wire the plugin into the page.
     *
     * Each surface is mounted on its own so one failure cannot take the others
     * down, and each outcome is reported to the host for diagnosis.
     * @param {import('@deepseek-ai/cordis').Context} ctx - the browser plugin context.
     */
    function apply(ctx) {
      try {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-plugin-image-preview'
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => {
          style.remove()
        })
        report('style', undefined, { base: document.baseURI })
      } catch (error) {
        report('style-failed', error)
      }

      try {
        ctx.effect(() => () => viewer.destroy())
        ctx.effect(() => () => hover.destroy())
        // Every cached picture is an object URL: letting the plugin unload without
        // revoking them would leak the whole conversation's images.
        ctx.effect(() => () => {
          releaseReadCache()
          releaseBlobUrls()
        })
      } catch (error) {
        report('effects-failed', error)
      }

      try {
        // The keyed tool slot dispatches by the wire tool name. Register the plain
        // name first and the namespaced spellings as a hedge: an extra key that no
        // call ever uses costs nothing, a missing one costs the whole card.
        const keys = ['preview_image', 'image-preview.preview_image', 'dsh-plugin-image-preview.preview_image']
        ctx.slots.inject('tool.call.toolview', () => {
          const disposers = keys.map((key) =>
            ctx.slots.register({ name: 'tool.call.toolview', key, priority: -1 }, PreviewImageCard),
          )
          return () => {
            for (const dispose of disposers) {
              if (typeof dispose === 'function') dispose()
            }
          }
        })
        report('slots-registered', undefined, { keys: keys.join(',') })
      } catch (error) {
        report('slots-failed', error, { hasSlots: Boolean(ctx.slots) })
      }

      try {
        watchText(ctx)
        report('text-watch')
      } catch (error) {
        report('text-watch-failed', error)
      }
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
