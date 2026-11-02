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
    // A host float like the browser tool's watch pill: fixed at bottom-right at
    // z-index 2147483000. The viewer must cover it, not the other way round.
    const pill = document.createElement('div')
    pill.id = 'fake-watch-pill'
    pill.style.cssText = 'position:fixed;right:16px;bottom:16px;width:140px;height:34px;z-index:2147483000;background:#d9534f'
    document.body.append(pill)

    firstFigure.click()
    await wait(600)
    const rootBox = document.querySelector('.dsh-ipv-root')
    const pillBox = pill.getBoundingClientRect()
    const hit = document.elementFromPoint(pillBox.left + pillBox.width / 2, pillBox.top + pillBox.height / 2)
    out.zOrder = {
      viewerZ: getComputedStyle(rootBox).zIndex,
      pillCoversViewer: hit === pill,
      viewerOnTop: hit !== null && hit.closest('.dsh-ipv-root') !== null,
    }
    pill.remove()
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

  // 0.5 annotator: draw, undo/redo, crop, then send the annotated picture.
  if (firstFigure) {
    pasted = null
    const annotateComposer = document.createElement('div')
    annotateComposer.setAttribute('data-lexical-editor', 'true')
    annotateComposer.contentEditable = 'true'
    annotateComposer.style.cssText = 'position:fixed;left:8px;bottom:52px;width:220px;height:32px;border:1px solid #ccc'
    annotateComposer.addEventListener('paste', (event) => {
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
    document.body.append(annotateComposer)

    firstFigure.click()
    await wait(500)
    const annotateButton = [...document.querySelectorAll('.dsh-ipv-btn')].find((b) => b.textContent === '标注')
    out.annotate = { button: annotateButton !== undefined }
    if (annotateButton !== undefined) {
      annotateButton.click()
      await wait(120)
      const annotateBar = document.querySelector('.dsh-ipv-inkbar-annotate')
      const toolIds = [...document.querySelectorAll('.dsh-ipv-tool')].map((b) => b.dataset.tool)
      const inkLayer = document.querySelector('.dsh-ipv-ink')
      const stageBox2 = document.querySelector('.dsh-ipv-stage').getBoundingClientRect()
      const draw = (type, x, y) => inkLayer.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
        pointerId: 21,
      }))
      const pickTool = (id) => {
        const target = [...document.querySelectorAll('.dsh-ipv-tool')].find((b) => b.dataset.tool === id)
        if (target !== undefined) target.click()
      }
      const press = (key, extra = {}) => document.querySelector('.dsh-ipv-root').dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, ...extra }),
      )

      pickTool('rect')
      draw('pointerdown', stageBox2.left + 100, stageBox2.top + 100)
      draw('pointermove', stageBox2.left + 260, stageBox2.top + 220)
      draw('pointerup', stageBox2.left + 260, stageBox2.top + 220)
      await wait(100)
      const afterDraw = inkLayer.getAttribute('aria-label')
      press('z', { ctrlKey: true })
      await wait(80)
      const afterUndo = inkLayer.getAttribute('aria-label')
      press('z', { ctrlKey: true, shiftKey: true })
      await wait(80)
      const afterRedo = inkLayer.getAttribute('aria-label')
      pickTool('crop')
      draw('pointerdown', stageBox2.left + 140, stageBox2.top + 140)
      draw('pointermove', stageBox2.left + 300, stageBox2.top + 240)
      draw('pointerup', stageBox2.left + 300, stageBox2.top + 240)
      await wait(100)
      const afterCrop = inkLayer.getAttribute('aria-label')

      // Text tool: the inline editor takes the keystrokes, Escape closes the viewer's
      // question instead of the viewer, and "discard" is the only way out with marks.
      pickTool('text')
      draw('pointerdown', stageBox2.left + 200, stageBox2.top + 200)
      await wait(80)
      const textBox = document.querySelector('.dsh-ipv-textedit')
      const textEditorOpened = textBox !== null
      if (textBox !== null) {
        textBox.textContent = '这里有问题'
        textBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      }
      await wait(100)
      const afterText = inkLayer.getAttribute('aria-label')

      out.annotateDraft = {
        bar: getComputedStyle(annotateBar).display,
        tools: toolIds,
        afterDraw,
        afterUndo,
        afterRedo,
        afterCrop,
        textEditorOpened,
        afterText,
      }
      press('Enter')
      await wait(900)
      out.annotateSend = {
        pasted,
        viewer: getComputedStyle(document.querySelector('.dsh-ipv-root')).display,
        tile: document.querySelector('img[data-test-tile="1"]') !== null,
      }

      // Reopen with marks on screen: the first Escape leaves the tool bar, the
      // second asks, and the third discards (the dialog's own "放弃（Esc）").
      firstFigure.click()
      await wait(400)
      const secondAnnotate = [...document.querySelectorAll('.dsh-ipv-btn')].find((b) => b.textContent === '标注')
      secondAnnotate.click()
      await wait(100)
      pickTool('ellipse')
      draw('pointerdown', stageBox2.left + 120, stageBox2.top + 120)
      draw('pointermove', stageBox2.left + 240, stageBox2.top + 220)
      draw('pointerup', stageBox2.left + 240, stageBox2.top + 220)
      await wait(100)
      const beforeLeaving = inkLayer.getAttribute('aria-label')
      press('Escape')
      await wait(100)
      const leftBar = getComputedStyle(document.querySelector('.dsh-ipv-inkbar-annotate')).display
      const stillDrawn = inkLayer.getAttribute('aria-label')
      press('Escape')
      await wait(120)
      const dirtyShown = document.querySelector('.dsh-ipv-dirty') !== null
      const dirtyButtons = [...document.querySelectorAll('.dsh-ipv-dirty .dsh-ipv-inkbtn')].map((b) => b.textContent)
      press('Escape')
      await wait(150)
      out.annotateDirty = {
        beforeLeaving,
        leftBar,
        stillDrawn,
        dirtyShown,
        dirtyButtons,
        dialogGone: document.querySelector('.dsh-ipv-dirty') === null,
        viewerAfterDrop: getComputedStyle(document.querySelector('.dsh-ipv-root')).display,
      }
    }
    for (const node of document.querySelectorAll('img[data-test-tile="1"]')) node.remove()
    annotateComposer.remove()
  }

  // 0.6: A/B comparison with a pixel diff.
  if (firstFigure) {
    firstFigure.click()
    await wait(500)
    const compareButton = [...document.querySelectorAll('.dsh-ipv-tools .dsh-ipv-btn')].find((b) => b.textContent === '对比')
    out.compare = { button: compareButton !== undefined && compareButton.disabled === false }
    if (compareButton !== undefined) {
      compareButton.click()
      await wait(1800)
      const comparePanel = document.querySelector('.dsh-ipv-compare')
      const compareImgs = [...document.querySelectorAll('.dsh-ipv-compare-pane img')]
      out.compare.panel = comparePanel !== null
      out.compare.imgs = compareImgs.length
      out.compare.loaded = compareImgs.length === 2 && compareImgs.every((i) => i.naturalWidth > 0)
      const diffButton = [...document.querySelectorAll('.dsh-ipv-compare .dsh-ipv-inkbtn')].find((b) => b.textContent === '差异')
      if (diffButton !== undefined) {
        diffButton.click()
        await wait(700)
        const diffCanvas = document.querySelector('.dsh-ipv-compare-pane canvas')
        out.compare.diff = diffCanvas === null
          ? null
          : { size: [diffCanvas.width, diffCanvas.height], label: diffCanvas.getAttribute('aria-label') }
      }
      const swapButton = [...document.querySelectorAll('.dsh-ipv-compare .dsh-ipv-inkbtn')].find((b) => b.textContent === '交换')
      const beforeSwap = document.querySelector('.dsh-ipv-compare-name').textContent
      if (swapButton !== undefined) {
        swapButton.click()
        await wait(700)
        out.compare.swapped = document.querySelector('.dsh-ipv-compare-name').textContent !== beforeSwap
      }
      document.querySelector('.dsh-ipv-root').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await wait(150)
      out.compare.closedByEsc = document.querySelector('.dsh-ipv-compare') === null
      out.compare.viewerAfterEsc = getComputedStyle(document.querySelector('.dsh-ipv-root')).display
    }
  }

  window.__result = out
  return 'ok'
})()
