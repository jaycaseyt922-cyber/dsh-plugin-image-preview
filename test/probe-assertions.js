// 探针里的客户端断言：在**真实的** Harness 渲染进程里验证正文装饰的行为。
//
// 为什么不在 test/harness.html 里跑：那个自测台的假 React 没有 useEffect/useRef，
// 工具卡根本渲染不出来；而这里要验的是"真实会话 DOM 上的装饰器"。
//
// 用法（探针见 tools/probe.ps1 开头的两条硬约定）：
//   powershell -NoProfile -ExecutionPolicy Bypass -File tools\probe.ps1 -Start -Supervise -ExitAfter 120
//   node tools/cdp.mjs eval-file test\probe-assertions.js
// 不要用 `eval "$(Get-Content … -Raw)"`：PowerShell 在第一个双引号处把参数截断，
// 求值的只剩开头注释（实测 5.9 KB → 139 B，返回 undefined）。
//
// 断言：流式增长不重复、路径消失后原文恢复、反复重写不丢图、坏路径只失败一次且文案可读、好路径仍走 blob。
// 结果直接从 Runtime.evaluate 的返回值读，不写文件。
// 加固验证：流式增长、路径消失、反复重写、坏路径、好路径 —— 一次跑完。
(async () => {
  const good = 'C:/Users/18373/Documents/imgprev-demo.png'
  const bad = 'C:/Users/18373/Documents/_imgprev_test/fixtures/definitely-missing.png'
  const out = {}

  const make = (id, text) => {
    document.getElementById(id)?.remove()
    const host = document.createElement('div')
    host.id = id
    host.style.cssText =
      'position:fixed;left:60px;top:120px;z-index:99998;width:620px;background:#FBF7EF;color:#26241F;padding:10px 14px;border:1px solid #E2D9CA;border-radius:10px;font-size:14px;line-height:1.8'
    const p = document.createElement('p')
    p.style.margin = '0'
    p.textContent = text
    host.append(p)
    document.body.append(host)
    return { host, p }
  }

  // 1. 流式：同一文本节点逐次增长（模拟 token 流），不能重复出 chip
  const s = make('ip-h1', '正在生成 ' + good)
  await new Promise((r) => setTimeout(r, 1200))
  const counts = []
  for (let i = 0; i < 4; i += 1) {
    s.p.firstChild.nodeValue = s.p.firstChild.nodeValue + ' 追加' + i
    await new Promise((r) => setTimeout(r, 260))
    counts.push(s.host.querySelectorAll('.dsh-ip-chip').length)
  }
  out.streaming = { chipCounts: counts, stable: counts.every((n) => n === 1) }

  // 2. 路径从文本里消失 → chip 撤掉、被隐藏的原文恢复
  s.p.firstChild.nodeValue = '这句话里已经没有任何图片路径了'
  await new Promise((r) => setTimeout(r, 700))
  out.pathRemoved = {
    chipsLeft: s.host.querySelectorAll('.dsh-ip-chip').length,
    hideAttr: s.p.getAttribute('data-ip-hide-path'),
    fontSize: getComputedStyle(s.p).fontSize,
  }

  // 3. 反复整段重写（React 重渲染的样子）→ 不叠加
  const t = make('ip-h2', good)
  const seen = []
  for (let i = 0; i < 5; i += 1) {
    t.p.textContent = good
    await new Promise((r) => setTimeout(r, 320))
    seen.push({
      chips: t.host.querySelectorAll('.dsh-ip-chip').length,
      figures: t.host.querySelectorAll('.dsh-ip-figure').length,
      hide: t.p.getAttribute('data-ip-hide-path'),
    })
  }
  out.rerender = seen

  // 4. 坏路径：只该有一次取图失败，且失败文案可读
  const realWarn = console.warn.bind(console)
  let warnings = 0
  console.warn = (...args) => {
    if (String(args.join(' ')).includes('image-preview')) warnings += 1
    return realWarn(...args)
  }
  const b = make('ip-h3', '坏路径在这里 ' + bad + ' 结束')
  await new Promise((r) => setTimeout(r, 5000))
  console.warn = realWarn
  const badChip = b.host.querySelector('.dsh-ip-chip')
  out.badPath = {
    warnings,
    label: badChip?.querySelector('.dsh-ip-chip-failed')?.textContent ?? null,
    tooltipHasPath: Boolean(badChip?.title?.includes('definitely-missing.png')),
  }

  // 5. 好路径仍然正常（三种表面都在）
  const g = make('ip-h4', '好路径 ' + good + ' 结束')
  await new Promise((r) => setTimeout(r, 2500))
  const goodChip = g.host.querySelector('.dsh-ip-chip img')
  out.goodPath = {
    chipPixels: goodChip ? [goodChip.naturalWidth, goodChip.naturalHeight] : null,
    srcPrefix: goodChip ? goodChip.src.slice(0, 12) : null,
  }

  // 6. 0.4：选区 → 看图 → 真宿主 composer 里出现缩略图 + 指令文本
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const chip = g.host.querySelector('.dsh-ip-chip')
  if (chip === null || chip === undefined) {
    out.selection = { error: 'no chip to open' }
  } else {
    chip.click()
    await sleep(1200)
    const selectButton = [...document.querySelectorAll('.dsh-ipv-btn')].find((b2) => b2.textContent === '选区')
    if (selectButton === undefined) {
      out.selection = { error: 'no selection button' }
    } else {
      selectButton.click()
      await sleep(200)
      const layer = document.querySelector('.dsh-ipv-ink')
      const stageBox = document.querySelector('.dsh-ipv-stage').getBoundingClientRect()
      const fire = (type, x, y) => layer.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
        pointerId: 11,
      }))
      // A box in the middle of the picture, away from the edges.
      fire('pointerdown', stageBox.left + stageBox.width * 0.35, stageBox.top + stageBox.height * 0.35)
      fire('pointermove', stageBox.left + stageBox.width * 0.62, stageBox.top + stageBox.height * 0.6)
      fire('pointerup', stageBox.left + stageBox.width * 0.62, stageBox.top + stageBox.height * 0.6)
      await sleep(200)
      // Read the label before Enter: a successful send clears the selection (and
      // with it the canvas label), so a later read would only measure the teardown.
      const selectionLabel = layer.getAttribute('aria-label')
      const before = document.querySelectorAll('img[alt^="image-preview-"]').length
      document.querySelector('.dsh-ipv-root').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await sleep(1600)
      const tiles = [...document.querySelectorAll('img[alt^="image-preview-"]')]
      const editor = document.querySelector('[data-lexical-editor=true]')
      out.selection = {
        label: selectionLabel,
        viewerAfterEnter: getComputedStyle(document.querySelector('.dsh-ipv-root')).display,
        newTiles: tiles.length - before,
        tileAlt: tiles.length === 0 ? null : tiles[tiles.length - 1].alt,
        editorHasInstruction: editor === null ? null : (editor.innerText || '').includes('来源：'),
        editorHasSource: editor === null ? null : (editor.innerText || '').includes('原图裁切'),
      }
      // Leave the draft as we found it: drop the tile and the text we added.
      for (const tile of tiles) {
        const button = tile.closest('button')
        if (button !== null) button.click()
      }
      if (editor !== null) editor.textContent = ''
    }
  }

  // 7. 0.5：标注 → Ctrl+S 保存（走 host 路由）→ Enter 发送
  const chipForInk = g.host.querySelector('.dsh-ip-chip')
  if (chipForInk !== null && chipForInk !== undefined) {
    chipForInk.click()
    await sleep(1200)
    const annotateBtn = [...document.querySelectorAll('.dsh-ipv-btn')].find((b2) => b2.textContent === '标注')
    if (annotateBtn !== undefined) {
      annotateBtn.click()
      await sleep(150)
      const inkLayer = document.querySelector('.dsh-ipv-ink')
      const inkBox = document.querySelector('.dsh-ipv-stage').getBoundingClientRect()
      const paint = (type, x, y) => inkLayer.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
        pointerId: 31,
      }))
      const rectTool = [...document.querySelectorAll('.dsh-ipv-tool')].find((b2) => b2.dataset.tool === 'rect')
      if (rectTool !== undefined) rectTool.click()
      paint('pointerdown', inkBox.left + 120, inkBox.top + 100)
      paint('pointermove', inkBox.left + 300, inkBox.top + 200)
      paint('pointerup', inkBox.left + 300, inkBox.top + 200)
      await sleep(150)
      const labelAfterDraw = inkLayer.getAttribute('aria-label')

      document.querySelector('.dsh-ipv-root').dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))
      await sleep(1600)
      const toast = document.querySelector('.dsh-ipv-status')
      const toastText = toast === null ? '' : toast.textContent
      const savedPath = toastText.startsWith('已保存：') ? toastText.slice(4) : ''

      const tilesBefore = document.querySelectorAll('img[alt^=image-preview-]').length
      document.querySelector('.dsh-ipv-root').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await sleep(1800)
      const tilesAfter = [...document.querySelectorAll('img[alt^=image-preview-]')]
      const editor = document.querySelector('[data-lexical-editor=true]')
      out.annotate = {
        labelAfterDraw,
        toastText,
        savedPath,
        newTiles: tilesAfter.length - tilesBefore,
        editorHasInstruction: editor === null ? null : (editor.innerText || '').includes('看这张图'),
        viewerAfterSend: getComputedStyle(document.querySelector('.dsh-ipv-root')).display,
      }
      for (const tile of tilesAfter) {
        const button = tile.closest('button')
        if (button !== null) button.click()
      }
      if (editor !== null) editor.textContent = ''
    }
  }

  for (const id of ['ip-h1', 'ip-h2', 'ip-h3', 'ip-h4']) document.getElementById(id)?.remove()
  return out
})()

