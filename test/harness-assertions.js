(async () => {
  const wait = (ms = 90) => new Promise((r) => requestAnimationFrame(() => setTimeout(r, ms)))
  await wait(300)
  const out = { applied: window.__applied, error: window.__error || null }
  const paths = (selector) => [...document.querySelectorAll(selector)].map((el) => el.dataset.ipPath)
  out.chips = paths('.dsh-ip-chip')
  out.figures = paths('.dsh-ip-figure')
  // The injected style tag names the package, not the old `dsh-local-image-preview` alias.
  out.styleOk = !!document.querySelector('style[data-plugin="dsh-plugin-image-preview"]')
  out.chipImg = document.querySelector('.dsh-ip-chip img')?.getAttribute('src') || null
  // The stylesheet is what makes a chip a chip: an unstyled <img> still loads.
  out.chipImgWidth = Math.round(document.querySelector('.dsh-ip-chip img')?.getBoundingClientRect().width || 0)
  out.cardRegistration = (window.__registrations || []).map((r) => r.name + ':' + r.key)

  // Hover preview: dispatch pointerenter on the first chip, wait past the 220ms timer.
  // The panel is created lazily, so it must be queried AFTER the event, not before.
  const chip = document.querySelector('.dsh-ip-chip')
  if (chip) {
    chip.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }))
    await wait(400)
    const hover = document.querySelector('.dsh-ip-hover')
    const hoverImg = hover === null ? null : hover.querySelector('img')
    out.hover = {
      display: hover === null ? null : getComputedStyle(hover).display,
      src: hoverImg === null ? null : hoverImg.getAttribute('src'),
      loaded: hoverImg === null ? null : [hoverImg.naturalWidth, hoverImg.naturalHeight],
    }
    chip.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }))
    await wait(80)
    out.hoverAfterLeave = hover === null ? null : getComputedStyle(hover).display
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

  // Selection + composer hand-off (0.4). A stand-in composer takes the paste the
  // way the real Lexical editor does: cancel it, show the file name in `alt`.
  const fakeEditor = document.createElement('div')
  fakeEditor.setAttribute('data-lexical-editor', 'true')
  fakeEditor.contentEditable = 'true'
  fakeEditor.style.cssText = 'position:fixed;left:8px;bottom:8px;width:220px;height:32px;border:1px solid #ccc'
  let pasted = null
  fakeEditor.addEventListener('paste', (event) => {
    event.preventDefault()
    const file = event.clipboardData === null ? null : event.clipboardData.files[0]
    pasted = {
      name: file === undefined || file === null ? '' : file.name,
      type: file === undefined || file === null ? '' : file.type,
      text: event.clipboardData === null ? '' : event.clipboardData.getData('text/plain'),
    }
    const tile = document.createElement('img')
    tile.alt = pasted.name
    tile.dataset.testTile = '1'
    document.body.append(tile)
  })
  document.body.append(fakeEditor)

  const firstFigure = document.querySelector('.dsh-ip-figure')
  if (firstFigure) {
    firstFigure.click()
    await wait(600)
    const selectButton = [...document.querySelectorAll('.dsh-ipv-btn')].find((b) => b.textContent === '选区')
    out.select = { button: selectButton !== undefined }
    if (selectButton !== undefined) {
      selectButton.click()
      await wait(100)
      const layer = document.querySelector('.dsh-ipv-ink')
      const stageBox = document.querySelector('.dsh-ipv-stage').getBoundingClientRect()
      const fire = (type, x, y) => layer.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
        pointerId: 7,
      }))
      fire('pointerdown', stageBox.left + 120, stageBox.top + 110)
      fire('pointermove', stageBox.left + 320, stageBox.top + 250)
      fire('pointerup', stageBox.left + 320, stageBox.top + 250)
      await wait(80)
      out.selection = {
        inkbar: getComputedStyle(document.querySelector('.dsh-ipv-inkbar')).display,
        label: layer.getAttribute('aria-label'),
        canvas: [layer.width, layer.height],
        selectPressed: selectButton.getAttribute('aria-pressed'),
      }
      // Enter on the overlay must cut the box, paste it into the composer and close.
      document.querySelector('.dsh-ipv-root').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      await wait(800)
      out.sent = {
        pasted,
        viewer: getComputedStyle(document.querySelector('.dsh-ipv-root')).display,
        tile: document.querySelector('img[data-test-tile="1"]') !== null,
      }
    }
  }
  for (const node of document.querySelectorAll('img[data-test-tile="1"]')) node.remove()
  fakeEditor.remove()

  window.__result = out
  return 'ok'
})()
