// Host-half smoke test: mount index.js against a fake ctx, then exercise the
// preview_image tool, the read route and the markdown-repair path on files it
// creates itself. Portable: no local absolute paths.
// Run with: node test/host-smoke.mjs
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { apply } from '../index.js'
import { makeFixture } from './fixtures.mjs'

const fixture = makeFixture()
const sections = []
const tools = []
const routes = []
let rejectAs = undefined
const ctx = {
  effect(setup) {
    const dispose = typeof setup === 'function' ? setup() : undefined
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  get(name) {
    if (name === 'connection') return { requestRejection: () => rejectAs }
    return undefined
  },
  tools: {
    register(definition) {
      tools.push(definition)
      return () => {}
    },
  },
  systemPrompt: {
    section(definition) {
      sections.push(definition)
      return () => {}
    },
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
}

apply(ctx)

const tool = tools[0]
const results = {}
results.registered = tools.map((entry) => entry.name)
results.guidanceSection = sections[0]?.name
results.route = routes.map((entry) => entry.kind + ' ' + entry.path)

results.onePng = await tool.execute({ paths: [fixture.png] })
results.rendered = tool.output.render({}, results.onePng)

results.missing = await tool.execute({ paths: [fixture.png + '.nope.png'] })
results.missingText = tool.output.render({}, results.missing)[0].text

results.wrongExtension = await tool.execute({ paths: [fixture.notImage] })
results.wrongExtensionText = tool.output.render({}, results.wrongExtension)[0].text

results.dir = await tool.execute({ dir: fixture.dir, limit: 3 })
results.dirCount = results.dir.images.length

// --- the routes, driven with fake requests -----------------------------------
const handler = routes.find((entry) => entry.path === '/image-preview')?.handler

const request = (url, method = 'GET', body) => {
  const chunks = []
  const response = {
    status: 0,
    headers: {},
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    end(body) {
      if (body !== undefined) chunks.push(Buffer.from(body))
      this.body = Buffer.concat(chunks)
    },
  }
  const req = new EventEmitter()
  req.url = url
  req.method = method
  handler(req, response)
  if (method === 'POST') {
    if (body !== undefined) req.emit('data', Buffer.from(body))
    req.emit('end')
  }
  return response
}

const served = request('/image-preview/file?path=' + encodeURIComponent(fixture.png))
results.route200 = { status: served.status, type: served.headers['content-type'], bytes: served.body?.length }

// The byte answer is a stream, so it needs a writable response and one await.
const requestStream = (url, method, body, headers) =>
  new Promise((resolve) => {
    const chunks = []
    const response = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk))
        callback()
      },
    })
    response.status = 0
    response.headers = {}
    response.writeHead = (status, extra) => {
      response.status = status
      response.headers = extra ?? {}
    }
    response.on('finish', () => resolve({ status: response.status, headers: response.headers, body: Buffer.concat(chunks) }))
    const fake = new EventEmitter()
    fake.url = url
    fake.method = method
    fake.headers = headers ?? {}
    handler(fake, response)
    if (body !== undefined) fake.emit('data', Buffer.from(body))
    fake.emit('end')
  })

const binary = await requestStream('/image-preview/read', 'POST', JSON.stringify({ path: fixture.png }), {
  accept: 'application/octet-stream',
})
results.routePostBinary = {
  status: binary.status,
  type: binary.headers['content-type'],
  bytes: binary.body.length,
  pngMagic: binary.body.subarray(0, 4).toString('hex') === '89504e47',
  cached: binary.headers['cache-control'],
}

const segment = Buffer.from(fixture.png, 'utf8').toString('base64url')
const servedSegment = request('/image-preview/blob/' + segment)
results.routeBlob200 = { status: servedSegment.status, type: servedSegment.headers['content-type'], bytes: servedSegment.body?.length }

const posted = request('/image-preview/read', 'POST', JSON.stringify({ path: fixture.png }))
const postedBody = JSON.parse(String(posted.body))
results.routePost = {
  status: posted.status,
  ok: postedBody.ok,
  asked: postedBody.asked === fixture.png,
  bytes: postedBody.bytes,
  base64Length: typeof postedBody.base64 === 'string' ? postedBody.base64.length : 0,
}

const postMissing = request('/image-preview/read', 'POST', JSON.stringify({ path: fixture.png + '.nope.png' }))
results.routePostMissing = { status: postMissing.status }

const missingImage = request('/image-preview/file?path=' + encodeURIComponent(fixture.png + '.nope.png'))
results.route404 = { status: missingImage.status, body: String(missingImage.body) }

const notImage = request('/image-preview/file?path=' + encodeURIComponent(fixture.notImage))
results.routeRejected = { status: notImage.status, body: String(notImage.body) }

const wrongMethod = request('/image-preview/file?path=x', 'POST')
results.route405 = wrongMethod.status
const unknown = request('/image-preview/other')
results.routeUnknown = unknown.status

const diag = request('/image-preview/diag?path=' + encodeURIComponent(fixture.png))
results.diag = { status: diag.status, ok: JSON.parse(String(diag.body)).ok }

// A path whose separator was eaten by Markdown must still resolve.
const repaired = request('/image-preview/diag?path=' + encodeURIComponent(fixture.mangled))
const repairedBody = JSON.parse(String(repaired.body))
results.repair = { status: repaired.status, ok: repairedBody.ok, target: repairedBody.target === fixture.subPng }

// --- containers that share a magic number must not share an answer -----------
// HEIC and MP4 also start with an ISO-BMFF `ftyp` box; only the brand says AVIF.
const brandOf = (major, compatible) => {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(24, 0)
  return Buffer.concat([head, Buffer.from('ftyp' + major + '\0\0\0\0' + compatible, 'binary')])
}
const heicFile = join(fixture.dir, 'renamed.avif')
writeFileSync(heicFile, brandOf('heic', 'mif1'))
const heifFile = join(fixture.dir, 'branded.avif')
writeFileSync(heifFile, brandOf('mif1', 'avif'))
results.avifHeic = await tool.execute({ paths: [heicFile] })
results.avifCompatible = await tool.execute({ paths: [heifFile] })

// --- the card needs the produced pictures, not the requested paths -----------
results.meta = tool.output.presentationMeta({}, results.onePng)
results.metaEmpty = tool.output.presentationMeta({}, { images: [], skipped: [] })

// --- duplicates and the per-call cap are reported, not silently dropped ------
results.duplicate = await tool.execute({ paths: [fixture.png, fixture.png] })
const many = []
for (let index = 0; index < 26; index += 1) many.push(join(fixture.dir, 'p' + index + '.png'))
results.overLimit = await tool.execute({ paths: many })

// --- a relative path has no Session to resolve against in the route ----------
results.relative = await tool.execute({ path: 'relative.png' })
results.relativeDiag = request('/image-preview/diag?path=' + encodeURIComponent('relative.png'))

rejectAs = 401
const refused = request('/image-preview/file?path=' + encodeURIComponent(fixture.png))
results.route401 = refused.status
// Before the fix these two answered before the fence: diag named arbitrary files
// and replayed every requested path, while client-report was a write.
const diagRefused = request('/image-preview/diag?path=' + encodeURIComponent(fixture.png))
const diagRefusedBody = JSON.parse(String(diagRefused.body))
results.diagUntrusted = {
  status: diagRefused.status,
  trusted: diagRefusedBody.trusted,
  leaksAsked: 'asked' in diagRefusedBody || 'target' in diagRefusedBody || 'recent' in diagRefusedBody,
}
const reportRefused = request('/image-preview/client-report', 'POST', JSON.stringify({ stage: 'smoke' }))
results.reportRefused = reportRefused.status
rejectAs = undefined
const reportTrusted = request('/image-preview/client-report', 'POST', JSON.stringify({ stage: 'smoke-trusted' }))
results.reportTrusted = reportTrusted.status

fixture.dispose()
console.log(JSON.stringify(results, null, 2))

const failures = []
if (results.route200?.status !== 200) failures.push('route200')
if (results.routeBlob200?.status !== 200) failures.push('routeBlob200')
if (results.routePost?.status !== 200 || results.routePost.ok !== true) failures.push('routePost')
if (results.route404?.status !== 404) failures.push('route404')
if (results.route405 !== 405) failures.push('route405')
if (results.route401 !== 401) failures.push('route401')
if (results.repair?.ok !== true || results.repair.target !== true) failures.push('repair')
if (results.dirCount < 1) failures.push('dirCount')
if (results.meta?.images?.length !== 1) failures.push('presentationMeta')
if (results.metaEmpty?.images?.length !== 0) failures.push('presentationMetaEmpty')
// A HEIC renamed to .avif must not be accepted as an AVIF.
if (results.avifHeic?.images?.length !== 0) failures.push('avifRenameAccepted')
// A real AVIF whose major brand is the generic 'mif1' still is one.
if (results.avifCompatible?.images?.length !== 1) failures.push('avifCompatibleRejected')
if (results.duplicate?.images?.length !== 1) failures.push('duplicate')
const overLimitSkipped = results.overLimit?.skipped?.filter((entry) => entry.reason.includes('上限')) ?? []
if (overLimitSkipped.length !== 2) failures.push('overLimitNotReported')
if (!(results.relative?.skipped?.[0]?.reason ?? '').includes('绝对路径')) failures.push('relativePathTool')
if (JSON.parse(String(results.relativeDiag?.body ?? '{}'))?.ok !== false) failures.push('relativePathRoute')
if (results.diagUntrusted?.status !== 200) failures.push('diagUntrusted')
if (results.diagUntrusted?.trusted !== false || results.diagUntrusted?.leaksAsked !== false) failures.push('diagLeak')
if (results.reportRefused !== 401) failures.push('reportFence')
if (results.reportTrusted !== 204) failures.push('reportTrusted')
// The binary answer is the transport the page uses now.
if (results.routePostBinary?.status !== 200) failures.push('postBinary')
if (results.routePostBinary?.type !== 'image/png') failures.push('postBinaryType')
if (results.routePostBinary?.pngMagic !== true) failures.push('postBinaryBytes')
if (results.routePostBinary?.cached !== 'private, no-store') failures.push('postBinaryCache')
if (failures.length > 0) {
  console.error('FAILED: ' + failures.join(', '))
  process.exit(1)
}
