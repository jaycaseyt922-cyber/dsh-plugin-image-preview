// Host-half smoke test: mount index.js against a fake ctx, then exercise the
// preview_image tool, the read route and the markdown-repair path on files it
// creates itself. Portable: no local absolute paths.
// Run with: node test/host-smoke.mjs
import { EventEmitter } from 'node:events'
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

rejectAs = 401
const refused = request('/image-preview/file?path=' + encodeURIComponent(fixture.png))
results.route401 = refused.status
rejectAs = undefined

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
if (failures.length > 0) {
  console.error('FAILED: ' + failures.join(', '))
  process.exit(1)
}
