// 探针的 CDP 驱动：连到探针实例的页面，执行 JS 或截图。
//
//   node tools/cdp.mjs eval "document.baseURI"        # 在页面里求值，打印结果
//   node tools/cdp.mjs shot <out.png>                 # 整页截图
//   node tools/cdp.mjs pages                          # 列出 target
//
// 只依赖 Node 内置的 fetch / WebSocket（Node >= 22），不需要 Playwright。
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const port = Number(process.env.PROBE_CDP_PORT ?? 9333)
const command = process.argv[2]
const argument = process.argv[3]

// 探针窗口平时最小化在隐藏桌面上（不渲染、不花 CPU，也看不见）。
// 截图需要真实帧，所以 shot 前后各调一次 probe.ps1：-Arm 还原、-Idle 收起。
const probeScript = fileURLToPath(new URL('./probe.ps1', import.meta.url))

function probeWindow(flag) {
  if (process.platform !== 'win32') return
  try {
    spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', probeScript, flag], {
      stdio: 'ignore',
      timeout: 20000,
    })
  } catch {}
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const url = `http://127.0.0.1:${port}/json/list`

async function targets() {
  const response = await fetch(url)
  if (!response.ok) throw new Error('CDP list failed: HTTP ' + response.status)
  return response.json()
}

async function pickPage() {
  const list = await targets()
  const pages = list.filter((target) => target.type === 'page')
  return pages.find((target) => target.url.startsWith('dsh-app://app/')) ?? pages[0]
}

function connect(target) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl)
    socket.addEventListener('open', () => resolve(socket), { once: true })
    socket.addEventListener('error', (event) => reject(new Error('ws error: ' + String(event?.message ?? 'unknown'))), { once: true })
  })
}

async function send(socket, method, params) {
  const id = send.next++
  const reply = new Promise((resolve, reject) => {
    const onMessage = (event) => {
      let payload
      try {
        payload = JSON.parse(event.data)
      } catch {
        return
      }
      if (payload.id !== id) return
      socket.removeEventListener('message', onMessage)
      if (payload.error) reject(new Error(payload.error.message + ' (' + payload.error.code + ')'))
      else resolve(payload.result)
    }
    socket.addEventListener('message', onMessage)
    setTimeout(() => {
      socket.removeEventListener('message', onMessage)
      reject(new Error('CDP timeout for ' + method))
    }, 20000)
  })
  socket.send(JSON.stringify({ id, method, params }))
  return reply
}
send.next = 1

function writeFile(path, data) {
  return import('node:fs').then((fs) => fs.writeFileSync(path, data))
}

const page = await pickPage()
if (page === undefined) {
  console.error('no page target')
  process.exit(2)
}

if (command === 'pages') {
  const list = await targets()
  for (const target of list) console.log(`${target.type}\t${target.title}\t${target.url}`)
  process.exit(0)
}

const socket = await connect(page)

if (command === 'eval') {
  const result = await send(socket, 'Runtime.evaluate', {
    expression: argument,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (result.exceptionDetails) {
    console.error('exception: ' + (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text))
    process.exit(3)
  }
  const value = result.result?.value
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
} else if (command === 'shot') {
  probeWindow('-Arm')
  await sleep(700)
  let result
  try {
    result = await send(socket, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  } catch (error) {
    // 最小化的窗口不产帧：截图会一直等到超时，而不是给一张黑图。探针必须在隐藏桌面上
    // 被还原（-Arm）才有帧可截；这里把话说明白，省得下一个人只看到 "CDP timeout"。
    throw new Error(
      'Page.captureScreenshot 失败（' +
        String(error?.message ?? error) +
        '）。若探针窗口是最小化状态，先 `probe.ps1 -Arm` 还原；`probe.ps1 -Status` 会显示 iconic=True/False。',
    )
  }
  await writeFile(argument ?? 'probe.png', Buffer.from(result.data, 'base64'))
  console.log('saved ' + (argument ?? 'probe.png'))
  probeWindow('-Idle')
} else {
  console.error('usage: cdp.mjs eval "<js>" | shot <out.png> | pages')
  process.exit(1)
}

socket.close()
