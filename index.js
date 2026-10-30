/**
 * Host half of the local image preview plugin.
 *
 * Two surfaces:
 *
 * - `preview_image` validates local image files (existence, container by magic
 *   bytes, size cap) and answers with their paths. It deliberately returns no
 *   image blocks: the pictures are for the person reading the conversation, so a
 *   preview costs the model no tokens at all.
 * - A read-only image route (`/image-preview/file?path=…`) serves those bytes to
 *   the page. It exists because the browser half must not depend on any single
 *   deployment detail of the host's own file route: this one is gated by the
 *   composition's Host/Origin and browser-session trust check, answers only the
 *   six bitmap containers, and sniffs the bytes instead of trusting the name.
 *
 * The guidance tells the model how to make a figure appear where it belongs:
 * an absolute path in prose grows a thumbnail, a path on its own line becomes a
 * preview, and a Markdown image (`![](<absolute path>)`) is rendered inline by
 * the official chat.
 *
 * @module dsh-plugin-image-preview
 */

import { closeSync, openSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/** Stable cordis plugin name. */
export const name = 'image-preview'
/** Host services this plugin uses: tools, the guidance section, and the image route. */
export const inject = ['tools', 'systemPrompt', 'webServer']

/** The route prefix this plugin owns; nothing else may claim it. */
const ROUTE = '/image-preview'
/** How many images one call may show. */
const MAX_IMAGES = 24
/** Refuse a single file above this size; a preview is not a transfer. */
const MAX_BYTES = 64 * 1024 * 1024
/** How many leading bytes the container sniff reads. */
const SNIFF_BYTES = 16

/** The containers this preview accepts, keyed by extension, value is what the bytes must say. */
const MEDIA_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
}

const GUIDANCE = [
  '本机装有自研插件 dsh-plugin-image-preview（会话内图片预览）：',
  '· 默认做法：把图片路径写进**正文**（优先正斜杠，如 C:/Users/me/fig1.png）。正文不会被工具行折叠，路径会直接渲染成缩略图或整块预览，用户一定能看到。',
  '· preview_image 卡片是补充手段（想放在工具区里时用）；注意工具行在 compact 显示模式下会被折进“已完成…”，用户要先展开才能看到卡片。',
  '· 只认盘符绝对路径（C:\\… 或 C:/…）与 png/jpg/jpeg/webp/gif/bmp/avif；file:///、UNC（\\\\server\\…）、带 ? 的路径不会被识别。',
  '· 写路径时优先用正斜杠：Markdown 会把反斜杠当转义符，`\\_`、`\\(`、`\\)` 这类组合会把反斜杠吃掉（本机实测 `Documents\\_dsh_tmp` 渲染成 `Documents_dsh_tmp`）。插件会尝试修复，但别指望它总能猜对。',
].join('\n')

/**
 * Identify an image container from its leading bytes.
 * @param {Uint8Array} bytes - the file's first bytes.
 * @returns {string | null} the media type, or null for anything else.
 */
function sniff(bytes) {
  if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.length >= 6 && bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 56) return 'image/gif'
  if (bytes.length >= 12 && bytes[0] === 82 && bytes[1] === 73 && bytes[2] === 70 && bytes[3] === 70
    && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return 'image/webp'
  if (bytes.length >= 2 && bytes[0] === 66 && bytes[1] === 77) return 'image/bmp'
  if (bytes.length >= 12 && bytes[4] === 102 && bytes[5] === 116 && bytes[6] === 121 && bytes[7] === 112) return 'image/avif'
  return null
}

/**
 * Read the leading bytes of one file.
 * @param {string} file - an absolute path.
 * @returns {Buffer} up to SNIFF_BYTES bytes, empty when the file cannot be read.
 */
function head(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const buffer = Buffer.alloc(SNIFF_BYTES)
    const read = readSync(fd, buffer, 0, SNIFF_BYTES, 0)
    return buffer.subarray(0, read)
  } catch {
    return Buffer.alloc(0)
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* the descriptor is already gone */
      }
    }
  }
}

/**
 * Markdown escapes a backslash before punctuation, so a Windows path written as
 * `Documents\_dsh_tmp\x.png` reaches the page as `Documents_dsh_tmp\x.png` — the
 * separator is gone and the file really is "missing". Rebuild the plausible
 * spellings the renderer could have eaten so the picture still shows.
 * @param {string} target - the normalized path that did not resolve.
 * @returns {string[]} alternative spellings, most likely first.
 */
function repairCandidates(target) {
  const marks = []
  for (let index = 1; index < target.length; index += 1) {
    const char = target[index]
    if (!'_()[]'.includes(char)) continue
    if (target[index - 1] === '\\') continue
    marks.push(index)
  }
  if (marks.length === 0) return []
  const broken = []
  const insertAt = (positions) => {
    let out = ''
    let cursor = 0
    for (const position of positions) {
      out += target.slice(cursor, position) + '\\'
      cursor = position
    }
    return out + target.slice(cursor)
  }
  for (const position of marks) broken.push(insertAt([position]))
  if (marks.length > 1) broken.push(insertAt(marks))
  return broken
}

/**
 * Validate one candidate path.
 * @param {string} raw - the path as the model wrote it.
 * @param {string | undefined} cwd - the Session working directory for a relative path.
 * @returns {{ ok: true, path: string, mediaType: string, bytes: number } | { ok: false, path: string, reason: string }}
 */
function inspect(raw, cwd) {
  const asked = String(raw ?? '').trim()
  if (asked === '') return { ok: false, path: '', reason: '路径是空的' }
  const target = path.isAbsolute(asked) ? path.normalize(asked) : path.resolve(cwd ?? process.cwd(), asked)
  const extension = path.extname(target).slice(1).toLowerCase()
  const declared = MEDIA_TYPES[extension]
  if (declared === undefined) {
    return { ok: false, path: target, reason: `不是可预览的图片扩展名（${extension === '' ? '无扩展名' : '.' + extension}）` }
  }
  let resolved = target
  let info
  try {
    info = statSync(resolved)
  } catch {
    // The renderer may have eaten a backslash; try the repaired spellings.
    for (const candidate of repairCandidates(target)) {
      try {
        const repaired = statSync(candidate)
        if (repaired.isFile() !== true) continue
        resolved = candidate
        info = repaired
        break
      } catch {
        /* this repair is not the answer either */
      }
    }
    if (info === undefined) return { ok: false, path: target, reason: '文件不存在' }
  }
  if (info.isFile() !== true) return { ok: false, path: resolved, reason: '不是普通文件' }
  if (info.size <= 0) return { ok: false, path: resolved, reason: '文件是空的' }
  if (info.size > MAX_BYTES) {
    return { ok: false, path: resolved, reason: `文件太大（${(info.size / 1024 / 1024).toFixed(1)} MB，上限 ${MAX_BYTES / 1024 / 1024} MB）` }
  }
  const mediaType = sniff(head(resolved))
  if (mediaType === null) return { ok: false, path: resolved, reason: '文件头不是 PNG/JPEG/WebP/GIF/BMP/AVIF' }
  if (mediaType !== declared) {
    return { ok: false, path: resolved, reason: `扩展名声明 ${declared}，内容其实是 ${mediaType}；改成与实际格式一致的扩展名再试` }
  }
  return { ok: true, path: resolved, mediaType, bytes: info.size }
}

/**
 * The newest images in one directory.
 * @param {string} dir - an absolute directory.
 * @param {number} limit - how many to keep.
 * @returns {string[]} absolute paths, newest first.
 */
function newestIn(dir, limit) {
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const found = []
  for (const entry of names) {
    const extension = path.extname(entry).slice(1).toLowerCase()
    if (MEDIA_TYPES[extension] === undefined) continue
    const target = path.join(dir, entry)
    try {
      const info = statSync(target)
      if (info.isFile() === true) found.push({ target, mtime: info.mtimeMs })
    } catch {
      /* it went away mid-listing */
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((entry) => entry.target)
}

/** Text blocks only: the card paints the pictures, the model reads the envelope. */
function text(value) {
  return [{ type: 'text', text: String(value) }]
}

/** Format one byte count for a label. */
function human(bytes) {
  if (!(bytes > 0)) return '0 B'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    images: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          mediaType: { type: 'string' },
          bytes: { type: 'integer' },
        },
      },
    },
    skipped: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          reason: { type: 'string' },
        },
      },
    },
    caption: { type: 'string' },
    error: { type: 'string' },
  },
}

/** The tool schema and executor, closing over the plugin context for the Session cwd. */
function createTool(ctx) {
  /** Resolve the Session working directory when the host can provide it. */
  const sessionCwd = async (exec) => {
    const service = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined
    if (service === undefined || typeof service.ensure !== 'function' || exec?.agent === undefined) return undefined
    try {
      return await service.ensure(exec.agent, exec.signal)
    } catch {
      return undefined
    }
  }

  return {
    name: 'preview_image',
    description:
      'Show local image files in the conversation as a clickable thumbnail card for the user. Pass absolute paths (paths array, or path for one file); dir + limit instead shows the newest images in one directory. The pictures are not added to the model context and cost no tokens. Accepts PNG/JPEG/WebP/GIF/BMP/AVIF files.',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of the images to show, in order.' },
        path: { type: 'string', description: 'One absolute image path (shorthand for a single-item paths).' },
        dir: { type: 'string', description: 'Absolute directory to scan instead of listing paths; the newest images win.' },
        limit: { type: 'integer', description: 'How many newest images to take from dir (default 12, max 24).' },
        caption: { type: 'string', description: 'Optional one-line caption shown above the thumbnails.' },
      },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => {
        if (value.error) return text('error: ' + value.error)
        if (value.images.length === 0) {
          const reasons = value.skipped.slice(0, 6).map((entry) => `  ${entry.path || '(空)'}：${entry.reason}`)
          return text(['没有可显示的图片。', ...reasons].join('\n'))
        }
        const lines = [`已在会话里显示 ${value.images.length} 张图片（点缩略图可放大）。`]
        if (value.caption) lines.push(value.caption)
        for (const image of value.images) lines.push(`  ${image.path} · ${image.mediaType} · ${human(image.bytes)}`)
        for (const entry of value.skipped.slice(0, 6)) lines.push(`  跳过 ${entry.path || '(空)'}：${entry.reason}`)
        return text(lines.join('\n'))
      },
    },
    timeoutMs: 30000,
    /**
     * Validate what the model asked for and answer with the paths the card paints.
     * @param {object} args - the tool arguments.
     * @param {object} [exec] - the execution context (agent, signal).
     * @returns {Promise<object>} the tool result.
     */
    async execute(args, exec) {
      const asked = Array.isArray(args?.paths) ? args.paths.slice(0) : []
      if (typeof args?.path === 'string' && args.path.trim() !== '') asked.push(args.path)
      const limit = Math.max(1, Math.min(MAX_IMAGES, Number(args?.limit) || 12))
      if (typeof args?.dir === 'string' && args.dir.trim() !== '') {
        const dir = path.isAbsolute(args.dir) ? path.normalize(args.dir) : path.resolve(args.dir)
        for (const found of newestIn(dir, limit)) asked.push(found)
      }
      if (asked.length === 0) return { images: [], skipped: [], caption: '', error: '需要 paths / path / dir 之一' }
      const cwd = await sessionCwd(exec)
      const images = []
      const skipped = []
      for (const raw of asked.slice(0, MAX_IMAGES)) {
        const result = inspect(raw, cwd)
        if (result.ok === true) images.push({ path: result.path, mediaType: result.mediaType, bytes: result.bytes })
        else skipped.push({ path: result.path, reason: result.reason })
      }
      return { images, skipped, caption: typeof args?.caption === 'string' ? args.caption.trim().slice(0, 200) : '' }
    },
  }
}

/**
 * Read one query value from a request URL.
 * @param {string} url - the request URL.
 * @param {string} name - the parameter to read.
 * @returns {string} the decoded value, or the empty string when absent.
 */
function queryOf(url, name) {
  const queryAt = url.indexOf('?')
  if (queryAt === -1) return ''
  for (const pair of url.slice(queryAt + 1).split('&')) {
    const at = pair.indexOf('=')
    if (at === -1) continue
    if (pair.slice(0, at) !== name) continue
    try {
      return decodeURIComponent(pair.slice(at + 1).replace(/\+/g, ' '))
    } catch {
      return ''
    }
  }
  return ''
}

/**
 * Decode one base64url path segment back to a filesystem path.
 * @param {string} segment - the URL path segment.
 * @returns {string} the decoded path, or the empty string when it is not decodable.
 */
function decodeSegment(segment) {
  try {
    return Buffer.from(decodeURIComponent(segment), 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

/**
 * Answer a short plain-text response.
 * @param {import('node:http').ServerResponse} res - the response to own.
 * @param {number} status - the HTTP status.
 * @param {string} message - the body.
 */
function sendText(res, status, message) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end(message)
}

/**
 * Answer one JSON response.
 * @param {import('node:http').ServerResponse} res - the response to own.
 * @param {number} status - the HTTP status.
 * @param {object} body - a JSON-safe body.
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Publish the read-only image route.
 *
 * The page asks for one absolute path; this half answers those bytes only when
 * the request passes the composition's trust check, the path names a supported
 * bitmap, the bytes really are that bitmap and the file is within the size cap.
 * The response is `no-store` so a rewritten figure is one refresh away.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 */
function registerImageRoute(ctx) {
  /** The last handful of requests this route saw, for the self-report. */
  const recent = []

  /** Remember one request so `diag` can report what actually arrived. */
  const remember = (entry) => {
    recent.push(entry)
    if (recent.length > 20) recent.shift()
    return entry
  }

  /** Run the Host/Origin and browser-session fence; true when the request must stop. */
  const refuse = (req, res) => {
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    if (connection === undefined || typeof connection.requestRejection !== 'function') {
      sendText(res, 503, 'no connection service')
      return true
    }
    const rejection = connection.requestRejection(req)
    if (rejection === undefined) return false
    sendText(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden')
    return true
  }

  /**
   * Serve `POST /image-preview/read` with `{ "path": "C:\\…" }`.
   *
   * The path travels in the request body, never in a URL: a custom-scheme proxy
   * may re-encode a query or a path segment, and a re-encoded Windows path is
   * indistinguishable from a missing file. The answer carries the bytes as
   * base64 so one JSON response is all the page needs.
   */
  const serveRead = (req, res) => {
    const entry = remember({ at: Date.now(), method: req.method, pathname: ROUTE + '/read', hasQuery: false })
    if (req.method !== 'POST') {
      entry.status = 405
      res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' })
      res.end('POST only')
      return
    }
    if (refuse(req, res) === true) {
      entry.status = 401
      return
    }
    const chunks = []
    let size = 0
    let tooBig = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 16384) {
        tooBig = true
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      entry.bodyBytes = size
      if (tooBig === true) {
        entry.status = 413
        sendJson(res, 413, { ok: false, reason: '请求体太大' })
        return
      }
      let payload
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch {
        entry.status = 400
        sendJson(res, 400, { ok: false, reason: '请求体不是 JSON' })
        return
      }
      const asked = typeof payload?.path === 'string' ? payload.path : ''
      entry.asked = asked
      const result = inspect(asked, undefined)
      if (result.ok !== true) {
        entry.status = 404
        sendJson(res, 404, { ok: false, asked, reason: result.reason })
        return
      }
      try {
        const bytes = readFileSync(result.path)
        entry.status = 200
        sendJson(res, 200, {
          ok: true,
          asked,
          mediaType: result.mediaType,
          bytes: bytes.length,
          base64: bytes.toString('base64'),
        })
      } catch (error) {
        entry.status = 500
        sendJson(res, 500, { ok: false, asked, reason: String((error instanceof Error ? error.message : error) || 'read failed') })
      }
    })
    req.on('error', () => {
      /* the client went away; nothing left to answer */
    })
  }

  /**
   * Serve `POST /image-preview/client-report`: the browser half's own mount
   * report, recorded next to the image requests so `diag` can explain a card
   * that never appeared.
   */
  const serveReport = (req, res) => {
    const entry = remember({ at: Date.now(), method: req.method, pathname: ROUTE + '/client-report', hasQuery: false })
    if (req.method !== 'POST') {
      entry.status = 405
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size <= 8192) chunks.push(chunk)
    })
    req.on('end', () => {
      entry.bodyBytes = size
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        entry.stage = typeof payload.stage === 'string' ? payload.stage : ''
        entry.error = typeof payload.error === 'string' ? payload.error : ''
        if (typeof payload.base === 'string') entry.base = payload.base
        if (typeof payload.hasSlots === 'boolean') entry.hasSlots = payload.hasSlots
        entry.detail = JSON.stringify(payload).slice(0, 400)
      } catch {
        entry.error = 'report body is not JSON'
      }
      entry.status = 204
      res.writeHead(204, { 'cache-control': 'no-store' })
      res.end()
    })
    req.on('error', () => {
      /* the client went away; nothing left to answer */
    })
  }

  /** Serve `GET|HEAD /image-preview/blob/<base64url path>` and `/image-preview/file?path=…`. */
  const handler = (req, res) => {
    const url = typeof req.url === 'string' ? req.url : ''
    const pathname = url.split('?')[0]
    const encodedAt = pathname.startsWith(ROUTE + '/blob/') ? pathname.slice((ROUTE + '/blob/').length) : ''
    const isQueryRoute = pathname === ROUTE + '/file'
    const isDiag = pathname === ROUTE + '/diag'
    const isRead = pathname === ROUTE + '/read'
    const isReport = pathname === ROUTE + '/client-report'
    if (!isQueryRoute && encodedAt === '' && !isDiag && !isRead && !isReport) {
      sendText(res, 404, 'unknown route')
      return
    }
    if (isRead === true) {
      serveRead(req, res)
      return
    }
    if (isReport === true) {
      serveReport(req, res)
      return
    }
    const entry = remember({ at: Date.now(), method: req.method, pathname, hasQuery: url.includes('?') })
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      entry.status = 405
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
      res.end('GET or HEAD only')
      return
    }
    if (isDiag === true) {
      // Read-only self-report: what this process sees for one path, no bytes.
      const asked = queryOf(url, 'path')
      const result = inspect(asked, undefined)
      const report = {
        asked,
        target: result.path,
        ok: result.ok,
        reason: result.ok === true ? '' : result.reason,
        mediaType: result.ok === true ? result.mediaType : '',
        bytes: result.ok === true ? result.bytes : 0,
        base: ROUTE,
        platform: process.platform,
        recent,
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(report))
      return
    }
    if (refuse(req, res) === true) {
      entry.status = 401
      return
    }
    const asked = encodedAt !== '' ? decodeSegment(encodedAt) : queryOf(url, 'path')
    const result = inspect(asked, undefined)
    if (result.ok !== true) {
      sendText(res, 404, result.reason)
      return
    }
    try {
      const bytes = readFileSync(result.path)
      res.writeHead(200, {
        'content-type': result.mediaType,
        'content-length': String(bytes.length),
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      res.end(bytes)
    } catch (error) {
      sendText(res, 500, String((error instanceof Error ? error.message : error) || 'read failed'))
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }), 'image-preview: image route')
}

/**
 * Mount the tool, the guidance and the image route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 */
export function apply(ctx) {
  const tool = createTool(ctx)
  ctx.effect(() => ctx.tools.register(tool), 'image-preview: preview_image')
  ctx.effect(
    () => ctx.systemPrompt.section({ name: 'plugin:image-preview', order: 164, text: GUIDANCE }),
    'image-preview: guidance',
  )
  // The route is an optimization over the host's own file route: a port that
  // refuses the prefix must not take the tool down with it.
  try {
    registerImageRoute(ctx)
  } catch (error) {
    const message = String((error instanceof Error ? error.message : error) || 'unknown')
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn('image-preview: 图片路由未注册：' + message)
  }
}
