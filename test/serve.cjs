// 自测台静态服务器：把插件目录当站点，并模拟宿主的 /api/file?path= 路由，
// 这样 client.js 里生成的图片 URL 在自测台里也能真的加载出图。
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const root = process.cwd()

const MEDIA = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
}

/** Serve one image file with a sniffed-enough content type. */
function serveImage(res, target) {
  fs.readFile(target, (error, data) => {
    if (error) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found: ' + target)
      return
    }
    const media = MEDIA[path.extname(target).slice(1).toLowerCase()] || 'application/octet-stream'
    res.writeHead(200, { 'content-type': media, 'cache-control': 'no-store' })
    res.end(data)
  })
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  // The plugin's POST route: the path rides in the JSON body, bytes come back base64.
  if (url.pathname.endsWith('/image-preview/read') && req.method === 'POST') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 65536) req.destroy()
    })
    req.on('end', () => {
      let payload = {}
      try {
        payload = JSON.parse(body)
      } catch {
        payload = {}
      }
      const target = typeof payload.path === 'string' ? payload.path : ''
      fs.readFile(target, (error, data) => {
        if (error) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, asked: target, reason: '文件不存在' }))
          return
        }
        const media = MEDIA[path.extname(target).slice(1).toLowerCase()] || 'application/octet-stream'
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, asked: target, mediaType: media, bytes: data.length, base64: data.toString('base64') }))
      })
    })
    return
  }
  // The plugin's own route, transported in the path segment (base64url).
  if (url.pathname.startsWith('/image-preview/blob/')) {
    const segment = url.pathname.slice('/image-preview/blob/'.length)
    let target = ''
    try {
      target = Buffer.from(segment, 'base64url').toString('utf8')
    } catch {
      target = ''
    }
    if (target === '') {
      res.writeHead(400, { 'content-type': 'text/plain' })
      res.end('bad segment')
      return
    }
    serveImage(res, target)
    return
  }
  if (url.pathname.endsWith('/api/file')) {
    serveImage(res, url.searchParams.get('path') || '')
    return
  }
  const name = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'test/harness.html'
  const file = path.join(root, name)
  fs.readFile(file, (error, data) => {
    if (error) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found: ' + name)
      return
    }
    const type = file.endsWith('.js') ? 'text/javascript' : 'text/html'
    res.writeHead(200, { 'content-type': type + '; charset=utf-8' })
    res.end(data)
  })
})

server.listen(8765, '127.0.0.1', () => console.log('harness on http://127.0.0.1:8765/test/harness.html'))
