// 探针里的客户端断言：在**真实的** Harness 渲染进程里验证正文装饰的行为。
//
// 为什么不在 test/harness.html 里跑：那个自测台的假 React 没有 useEffect/useRef，
// 工具卡根本渲染不出来；而这里要验的是"真实会话 DOM 上的装饰器"。
//
// 用法（探针见 tools/probe.ps1 开头的两条硬约定）：
//   powershell -NoProfile -ExecutionPolicy Bypass -File tools\probe.ps1 -Start -Supervise -ExitAfter 120
//   node tools/cdp.mjs eval "$(Get-Content test\probe-assertions.js -Raw)"     # 或在 CDP 里注入本文件
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

  for (const id of ['ip-h1', 'ip-h2', 'ip-h3', 'ip-h4']) document.getElementById(id)?.remove()
  return out
})()

