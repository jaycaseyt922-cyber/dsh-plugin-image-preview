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

import { closeSync, createReadStream, mkdirSync, openSync, readSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** Stable cordis plugin name. */
export const name = 'image-preview'
/** Host services this plugin uses: tools, the guidance section, and the image route. */
export const inject = ['tools', 'systemPrompt', 'webServer']

/** The route prefix this plugin owns; nothing else may claim it. */
const ROUTE = '/image-preview'
/** Where "save" writes annotated pictures: one temp directory the plugin owns. */
const SAVE_DIR = path.join(tmpdir(), 'image-preview')
/** One save may carry this many bytes; the browser half exports smaller than this. */
const MAX_SAVE_BYTES = 32 * 1024 * 1024
/** How many images one call may show. */
const MAX_IMAGES = 24
/** Refuse a single file above this size; a preview is not a transfer. */
const MAX_BYTES = 64 * 1024 * 1024
/** How many leading bytes the container sniff reads (an AVIF brand scan needs the ftyp box, not only its magic). */
const SNIFF_BYTES = 32

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
  // ISO-BMFF: HEIC, MP4 and AVIF all start with a `ftyp` box, so the magic alone
  // cannot tell them apart — the brand can. Accept only an AVIF major or
  // compatible brand, or a HEIC renamed to .avif would pass this check and then
  // fail to decode in the page.
  if (bytes.length >= 12 && bytes[4] === 102 && bytes[5] === 116 && bytes[6] === 121 && bytes[7] === 112) {
    const brand = (at) => {
      if (at + 4 > bytes.length) return ''
      return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])
    }
    if (brand(8) === 'avif' || brand(8) === 'avis') return 'image/avif'
    // Skip the 4-byte minor version that follows the major brand.
    for (let at = 16; at + 4 <= bytes.length; at += 4) {
      const compatible = brand(at)
      if (compatible === 'avif' || compatible === 'avis') return 'image/avif'
    }
    return null
  }
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
  // The image route has no Session, so it has no working directory to resolve
  // against: a relative path there would be read against whatever directory the
  // host process happens to have. Refuse it by name instead of letting the tool
  // succeed and the picture fail with a misleading "文件不存在".
  if (cwd === undefined && !path.isAbsolute(asked)) {
    return { ok: false, path: asked, reason: '只接受绝对路径（C:\\… 或 C:/…）' }
  }
  const target = path.isAbsolute(asked) ? path.normalize(asked) : path.resolve(cwd, asked)
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
 *
 * Every candidate needs its own `stat`, so this is asynchronous on purpose: a
 * folder with a few thousand scans would otherwise block the host's event loop
 * (and with it every session stream) for as long as the listing takes.
 * @param {string} dir - an absolute directory.
 * @param {number} limit - how many to keep.
 * @returns {Promise<string[]>} absolute paths, newest first.
 */
async function newestIn(dir, limit) {
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const found = []
  for (const entry of names) {
    const extension = path.extname(entry).slice(1).toLowerCase()
    if (MEDIA_TYPES[extension] === undefined) continue
    const target = path.join(dir, entry)
    try {
      const info = await stat(target)
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
      // The card has to paint the pictures the call *produced*, not the paths it
      // asked for: `dir` expands to files the arguments never mention. The
      // official result metadata is the channel for that (the `read` and
      // `read_image` cards read their own paths from it), and it survives a
      // reload because it is stored with the settled call.
      presentationMeta: (_args, value) => ({
        images: Array.isArray(value?.images) ? value.images : [],
        skipped: Array.isArray(value?.skipped) ? value.skipped.slice(0, 8) : [],
      }),
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
      const cwd = await sessionCwd(exec)
      const limit = Math.max(1, Math.min(MAX_IMAGES, Number(args?.limit) || 12))
      const skippedSeed = []
      if (typeof args?.dir === 'string' && args.dir.trim() !== '') {
        // The directory is resolved the same way a path is: against the Session
        // working directory, and refused when there is none to resolve against.
        const dir = path.isAbsolute(args.dir) ? path.normalize(args.dir) : cwd === undefined ? '' : path.resolve(cwd, args.dir)
        if (dir === '') skippedSeed.push({ path: args.dir, reason: '只接受绝对路径（C:\\… 或 C:/…）' })
        else for (const found of await newestIn(dir, limit)) asked.push(found)
      }
      if (asked.length === 0 && skippedSeed.length === 0) {
        return { images: [], skipped: [], caption: '', error: '需要 paths / path / dir 之一' }
      }
      // One picture asked for twice must cost one read and paint one thumbnail.
      const wanted = []
      const seen = new Set()
      for (const raw of asked) {
        const key = String(raw ?? '').trim()
        const finger = process.platform === 'win32' ? key.toLowerCase() : key
        if (finger !== '' && seen.has(finger)) continue
        if (finger !== '') seen.add(finger)
        wanted.push(raw)
      }
      const images = []
      const skipped = skippedSeed.slice(0)
      for (const raw of wanted.slice(0, MAX_IMAGES)) {
        const result = inspect(raw, cwd)
        if (result.ok === true) images.push({ path: result.path, mediaType: result.mediaType, bytes: result.bytes })
        else skipped.push({ path: result.path, reason: result.reason })
      }
      // Say which ones were dropped, rather than answering "shown 24" and hiding the rest.
      for (const raw of wanted.slice(MAX_IMAGES)) {
        skipped.push({ path: String(raw ?? '').trim(), reason: `超过单次 ${MAX_IMAGES} 张上限，未处理` })
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
  /**
   * The last report per mount stage, keyed by stage.
   *
   * `recent` rolls over after 20 requests — a conversation showing a dozen
   * pictures fills it with image reads alone, which used to evict exactly the
   * three mount reports the post-upgrade self-check looks for. Keeping one entry
   * per stage makes that check survive any amount of traffic.
   */
  const mounts = {}

  /**
   * Mount stages and their outcome only: names and `ok`, never a path or a
   * detail. This is the shape an untrusted `diag` may see.
   * @returns {Record<string, string>} one entry per stage.
   */
  const mountStages = () => {
    const out = {}
    for (const [stage, value] of Object.entries(mounts)) out[stage] = value.error === '' ? 'ok' : value.error
    return out
  }

  /** Remember one request so `diag` can report what actually arrived. */
  const remember = (entry) => {
    recent.push(entry)
    if (recent.length > 20) recent.shift()
    return entry
  }

  /**
   * Run the Host/Origin and browser-session fence; true when the request must stop.
   * @param {import('node:http').IncomingMessage} req - the request under test.
   * @param {import('node:http').ServerResponse} res - the response to answer on refusal.
   * @param {object} [entry] - the `recent` record to annotate with the real status.
   * @returns {boolean} true when the request was refused (and already answered).
   */
  /**
   * Ask the composition's trust check about one request, without answering it.
   * @param {import('node:http').IncomingMessage} req - the request under test.
   * @returns {401 | 403 | 503 | undefined} the refusal code, or undefined when trusted.
   */
  const fence = (req) => {
    const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
    if (connection === undefined || typeof connection.requestRejection !== 'function') return 503
    return connection.requestRejection(req)
  }

  /**
   * Run the Host/Origin and browser-session fence; true when the request must stop.
   * @param {import('node:http').IncomingMessage} req - the request under test.
   * @param {import('node:http').ServerResponse} res - the response to answer on refusal.
   * @param {object} [entry] - the `recent` record to annotate with the real status.
   * @returns {boolean} true when the request was refused (and already answered).
   */
  const refuse = (req, res, entry) => {
    const rejection = fence(req)
    if (rejection === undefined) return false
    answerRefusal(rejection, res, entry)
    return true
  }

  /**
   * Answer a request the fence refused.
   * @param {401 | 403 | 503} rejection - the code the fence chose.
   * @param {import('node:http').ServerResponse} res - the response to own.
   * @param {object} [entry] - the `recent` record to annotate with that code.
   */
  const answerRefusal = (rejection, res, entry) => {
    // Record the code the fence actually chose, so `diag` does not report a 401
    // for a request the fence refused with 403.
    if (entry !== undefined) entry.status = rejection
    if (rejection === 503) {
      sendText(res, 503, 'no connection service')
      return
    }
    sendText(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden')
  }

  /**
   * Serve `POST /image-preview/read` with `{ "path": "C:\\…" }`.
   *
   * The path travels in the request body, never in a URL: a custom-scheme proxy
   * may re-encode a query or a path segment, and a re-encoded Windows path is
   * indistinguishable from a missing file. The answer is the image bytes
   * themselves for a caller that asks for `application/octet-stream`, and a JSON
   * envelope carrying base64 for one that does not (an older page, a test, curl).
   */
  const serveRead = (req, res) => {
    const entry = remember({ at: Date.now(), method: req.method, pathname: ROUTE + '/read', hasQuery: false })
    if (req.method !== 'POST') {
      entry.status = 405
      res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' })
      res.end('POST only')
      return
    }
    if (refuse(req, res, entry) === true) return
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
        // The page asks for the bytes themselves (`accept: application/octet-stream`)
        // so nothing has to inflate them into base64 first: that costs a third more
        // memory on both sides and puts a multi-megabyte string in the DOM. The JSON
        // answer stays for an older page and for one that cannot stream.
        const wantsBinary = typeof req.headers?.accept === 'string' && req.headers.accept.includes('application/octet-stream')
        if (wantsBinary === true) {
          serveBinary(res, result)
          entry.status = 200
          entry.binary = true
          return
        }
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
   * Stream one validated image straight to the page.
   *
   * Streaming keeps the host's heap flat however large the picture is, and the
   * page can hand the response body to `Blob` instead of parsing base64. No
   * `content-length` is declared: the file may change size between the `stat`
   * that validated it and the read, and a wrong length would truncate the
   * picture silently. Nothing is cached, so a rewritten figure is one refresh
   * away.
   * @param {import('node:http').ServerResponse} res - the response to own.
   * @param {{ path: string, mediaType: string }} result - the validated file.
   */
  const serveBinary = (res, result) => {
    const stream = createReadStream(result.path)
    res.writeHead(200, {
      'content-type': result.mediaType,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
    })
    stream.on('error', () => {
      // A file that vanished mid-read can only be reported by cutting the body:
      // the head is already out.
      try {
        res.destroy()
      } catch {
        /* the socket is already gone */
      }
    })
    res.on('close', () => stream.destroy())
    stream.pipe(res)
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
    if (refuse(req, res, entry) === true) return
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
      // One slot per stage, so a mount report cannot be pushed out by traffic.
      if (entry.stage !== '') mounts[entry.stage] = { at: entry.at, error: entry.error, detail: entry.detail }
      res.writeHead(204, { 'cache-control': 'no-store' })
      res.end()
    })
    req.on('error', () => {
      /* the client went away; nothing left to answer */
    })
  }

  /** The last capability answer; the viewer asks on every open, so cache it. */
  let capabilityCache = null

  /**
   * Which vision tools this host currently exposes.
   *
   * A missing registry, a restricted view or an older host all read as "absent":
   * the browser half only uses this for a tooltip, so a false negative costs a
   * hint and a thrown error would cost the route.
   * @returns {{ describe: boolean, ocr: boolean, diff: boolean }} one flag per tool.
   */
  const visionTools = () => {
    let registry
    try {
      registry = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
    } catch {
      registry = undefined
    }
    // `ctx.get` is the service lookup a real composition uses; the property is the
    // direct accessor a test stub provides. Either way, absence means "no answer".
    if (registry === undefined || registry === null) registry = ctx.tools
    const visible = (name) => {
      try {
        return registry !== undefined && registry !== null
          && typeof registry.get === 'function'
          && registry.get(name) !== undefined
      } catch {
        return false
      }
    }
    return {
      describe: visible('vision_describe'),
      ocr: visible('vision_ocr'),
      diff: visible('vision_pixel_diff'),
    }
  }

  /**
   * Serve `GET /image-preview/capabilities`: read-only metadata, no paths, no bytes.
   *
   * The browser half cannot see the tool registry; without this route the viewer
   * cannot tell the reader that "看这块" will not reach a vision route.
   */
  const serveCapabilities = (req, res) => {
    const entry = remember({ at: Date.now(), method: req.method, pathname: ROUTE + '/capabilities', hasQuery: false })
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      entry.status = 405
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
      res.end('GET or HEAD only')
      return
    }
    if (refuse(req, res, entry) === true) return
    const now = Date.now()
    if (capabilityCache === null || now - capabilityCache.at > 5000) {
      capabilityCache = { at: now, value: visionTools() }
    }
    entry.status = 200
    if (req.method === 'HEAD') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end()
      return
    }
    sendJson(res, 200, { ok: true, vision: capabilityCache.value, base: ROUTE, at: now })
  }

  /**
   * Serve `POST /image-preview/save`: write one annotated PNG and answer its path.
   *
   * The browser half cannot write files, so this is the plugin's only writing
   * route. It takes the raw PNG bytes (never base64: one more copy of a 30 MB
   * string is exactly what 0.3.0 removed elsewhere), regenerates the file name
   * here (a client-supplied name is a path-traversal bug waiting to happen), and
   * refuses anything that is not a PNG by magic number.
   */
  const serveSave = (req, res) => {
    const entry = remember({ at: Date.now(), method: req.method, pathname: ROUTE + '/save', hasQuery: false })
    if (req.method !== 'POST') {
      entry.status = 405
      res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain; charset=utf-8' })
      res.end('POST only')
      return
    }
    if (refuse(req, res, entry) === true) return
    const chunks = []
    let size = 0
    let tooBig = false
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_SAVE_BYTES) {
        tooBig = true
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => {
      /* the client went away; nothing left to answer */
    })
    req.on('end', () => {
      entry.bodyBytes = size
      if (tooBig === true) {
        entry.status = 413
        sendJson(res, 413, { ok: false, error: '图片太大（上限 ' + Math.round(MAX_SAVE_BYTES / 1024 / 1024) + ' MB）' })
        return
      }
      const bytes = Buffer.concat(chunks)
      const isPng = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      if (isPng !== true) {
        entry.status = 415
        sendJson(res, 415, { ok: false, error: '只接受 PNG' })
        return
      }
      try {
        mkdirSync(SAVE_DIR, { recursive: true })
        const at = new Date()
        const pad = (value) => String(value).padStart(2, '0')
        const stamp = at.getFullYear() + pad(at.getMonth() + 1) + pad(at.getDate())
          + '-' + pad(at.getHours()) + pad(at.getMinutes()) + pad(at.getSeconds())
          + '-' + String(at.getMilliseconds()).padStart(3, '0')
        const target = path.join(SAVE_DIR, 'image-preview-' + stamp + '.png')
        writeFileSync(target, bytes)
        entry.status = 200
        sendJson(res, 200, { ok: true, path: target, bytes: bytes.length })
      } catch (error) {
        entry.status = 500
        sendJson(res, 500, { ok: false, error: String((error instanceof Error ? error.message : error) || 'write failed') })
      }
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
    const isCaps = pathname === ROUTE + '/capabilities'
    const isSave = pathname === ROUTE + '/save'
    if (!isQueryRoute && encodedAt === '' && !isDiag && !isRead && !isReport && !isCaps && !isSave) {
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
    if (isCaps === true) {
      serveCapabilities(req, res)
      return
    }
    if (isSave === true) {
      serveSave(req, res)
      return
    }
    const entry = remember({ at: Date.now(), method: req.method, pathname, hasQuery: url.includes('?') })
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      entry.status = 405
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
      res.end('GET or HEAD only')
      return
    }
    // Everything below is either a read of arbitrary files or a write. The fence
    // runs first. `diag` is the one exception, and only in what it *says*: an
    // untrusted caller still gets "the plugin is mounted", but never a word about
    // any file or about which paths other requests asked for.
    const rejection = fence(req)
    if (rejection !== undefined) {
      if (isDiag === true) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ base: ROUTE, platform: process.platform, trusted: false, mounts: mountStages() }))
        return
      }
      answerRefusal(rejection, res, entry)
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
        trusted: true,
        mounts,
        recent,
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(report))
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
