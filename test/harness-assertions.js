(async () => {
  const wait = (ms = 90) => new Promise((r) => requestAnimationFrame(() => setTimeout(r, ms)))
  await wait(300)
  const out = { applied: window.__applied, error: window.__error || null }
  const paths = (selector) => [...document.querySelectorAll(selector)].map((el) => el.dataset.ipPath)
  out.chips = paths('.dsh-ip-chip')
  out.figures = paths('.dsh-ip-figure')
  out.styleOk = !!document.querySelector('style[data-plugin="dsh-local-image-preview"]')
  out.chipImg = document.querySelector('.dsh-ip-chip img')?.getAttribute('src') || null
  out.cardRegistration = (window.__registrations || []).map((r) => r.name + ':' + r.key)

  // Hover preview: dispatch pointerenter on the first chip, wait past the 220ms timer.
  const chip = document.querySelector('.dsh-ip-chip')
  const hover = document.querySelector('.dsh-ip-hover')
  if (chip) {
    chip.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }))
    await wait(400)
    out.hover = {
      display: hover ? getComputedStyle(hover).display : null,
      src: hover?.querySelector('img')?.getAttribute('src') || null,
      loaded: (() => { const i = hover?.querySelector('img'); return i ? [i.naturalWidth, i.naturalHeight] : null })(),
    }
    chip.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }))
    await wait(60)
    out.hoverAfterLeave = hover ? getComputedStyle(hover).display : null
  }

  // Viewer from a figure, then close with Escape.
  const figure = document.querySelector('.dsh-ip-figure')
  if (figure) {
    figure.click()
    await wait(500)
    const img = document.querySelector('.dsh-ipv-image')
    out.viewer = {
      open: getComputedStyle(document.querySelector('.dsh-ipv-root')).display,
      natural: img ? [img.naturalWidth, img.naturalHeight] : null,
      transform: img ? img.style.transform : null,
      buttons: [...document.querySelectorAll('.dsh-ipv-btn')].map((b) => b.textContent),
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wait(120)
    out.viewerClosed = getComputedStyle(document.querySelector('.dsh-ipv-root')).display
  }

  // Streaming: the same text node keeps growing; decorations must not duplicate.
  const p = document.getElementById('stream')
  const box = p.parentElement
  p.textContent = '正在生成 C:\\Users\\18373\\Documents\\pg1.png'
  await wait()
  const afterOne = box.querySelectorAll('.dsh-ip-chip').length
  p.textContent = p.textContent + ' 还有 C:\\Users\\18373\\Documents\\pg2.png'
  await wait()
  const afterTwo = box.querySelectorAll('.dsh-ip-chip').length
  // Simulate React writing into the same node (characterData) instead of replacing children.
  const textNode = p.firstChild
  textNode.nodeValue = textNode.nodeValue + ' 再加 C:\\Users\\18373\\Documents\\pg3.png'
  await wait()
  const afterCharData = box.querySelectorAll('.dsh-ip-chip').length
  textNode.nodeValue = textNode.nodeValue.replace(' 再加 C:\\Users\\18373\\Documents\\pg3.png', '')
  await wait()
  const afterShrink = box.querySelectorAll('.dsh-ip-chip').length
  out.streaming = { afterOne, afterTwo, afterCharData, afterShrink, pathTextIntact: p.textContent.includes('pg1.png') }

  window.__result = out
  return 'ok'
})()
