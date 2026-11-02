/**
 * Browser half of the local image preview plugin.
 *
 * Two surfaces, one full-screen viewer:
 *
 * - The `preview_image` tool card: an expanded thumbnail grid instead of the
 *   generic tool row, so a figure the model chose to show lands in the
 *   conversation as a picture, not as a path.
 * - Inline path links: an image path written in plain text (assistant prose,
 *   tool output) is rewritten in place into a small clickable image button.
 *   The official chat already renders Markdown images (`![](...)`) and file
 *   links; this closes the remaining gap, the bare absolute path.
 *
 * The viewer is a plain-DOM overlay on `document.body` (not React): zoom at the
 * cursor, drag to pan, fit/1:1, arrow keys across the images of one message and
 * a manual refresh that busts the host's `no-store` cache.
 *
 * Images come from this plugin's own host route first (`POST /image-preview/read`
 * with the path in the JSON body, answered as raw bytes into a `Blob`), then from
 * the host's `/api/file?path=…`, so nothing has to be re-served and no extra auth
 * is involved.
 *
 * @module dsh-plugin-image-preview/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-image-preview',
  factory: (require) => {
    const React = require('react')
    const module = { exports: {} }
    const exports = module.exports

    /** Extensions the viewer and the in-text linkifier understand. */
    const IMAGE_EXTENSION = /\.(?:png|jpe?g|webp|gif|bmp|avif)$/i
    /**
     * One absolute local image path inside a run of text. Only drive-letter
     * paths are matched: a relative path cannot be resolved from the DOM, and
     * matching prose that merely ends in `.png` would turn sentences into
     * buttons. CJK punctuation ends the path, so "C:\a\b.png，" keeps the comma.
     */
    const PATH_RE =
      /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\n\r<>"'|?*，。；、：！？（）【】《》]*?\.(?:png|jpe?g|webp|gif|bmp|avif)(?![A-Za-z0-9])/gi
    /** Never linkify inside these: they are interactive, literal or already images. */
    const SKIP_TAGS = new Set([
      'A', 'BUTTON', 'CODE', 'PRE', 'IMG', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO',
      'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME',
    ])
    /** Blocks whose whole text is one path: render the picture itself, not a chip. */
    const STANDALONE_TAGS = new Set(['P', 'LI', 'DIV', 'TD', 'DD', 'BLOCKQUOTE', 'FIGCAPTION'])
    /** How many pictures one text node may grow, so a log dump cannot flood the page. */
    const CHIPS_PER_NODE = 12
    /** A Windows path longer than this is treated as a mistake, not a file. */
    const MAX_PATH_LENGTH = 260
    /** Zoom bounds for the viewer. */
    const MIN_SCALE = 0.05
    const MAX_SCALE = 16
    /** How close, in screen pixels, a press must land to grab a selection handle. */
    const GRAB_PX = 8
    /** The smallest useful selection, in source pixels: anything thinner is a slip. */
    const MIN_SELECTION = 8
    /** One crop may not exceed this many source pixels (40 MP is already ~30 MB as PNG). */
    const MAX_EXPORT_PIXELS = 40 * 1000 * 1000
    /** The composer's editor: a Lexical root, host-verified as the only one on the page. */
    const EDITOR_SELECTOR = '[data-lexical-editor="true"]'
    /** Sent pictures carry this name prefix, and the "did it land" check looks for it. */
    const ATTACHMENT_PREFIX = 'image-preview-'
    /** The instructions offered next to a selection, in bar order. */
    const TEMPLATES = ['describe', 'ocr', 'diff']
    /** Draw tools in bar order: move/select, cut the export region, then shapes. */
    const TOOLS = ['select', 'crop', 'rect', 'ellipse', 'arrow', 'pen', 'text']
    /** One-key shortcuts for the draw tools. */
    const TOOL_KEYS = { v: 'select', c: 'crop', r: 'rect', e: 'ellipse', a: 'arrow', p: 'pen', t: 'text' }
    /** The annotation palette. Red first: a callout is usually drawn in it. */
    const COLORS = ['#ff2d2d', '#ffb300', '#12b76a', '#2f6fed', '#111111', '#ffffff']
    /** Stroke widths in source pixels, so they survive any zoom. */
    const WIDTHS = [2, 4, 8]
    /** Text size per stroke width, in source pixels. */
    const TEXT_SIZES = [18, 26, 40]
    /** How many marks one picture may carry before the layer stops being cheap. */
    const MAX_MARKS = 200
    /** A pen stroke keeps at most this many points (decimated while drawing). */
    const MAX_PEN_POINTS = 500
    /** Undo depth: each entry is one `{ marks, crop }` snapshot. */
    const UNDO_LIMIT = 50
    /**
     * Every string the viewer adds, in one table.
     *
     * The plugin has no settings page yet, and 0.6 wires `ctx.locale` over this
     * object; until then Chinese is the only shipped language.
     */
    const COPY = {
      zh: {
        select: '选区',
        selectTitle: '框选一块（S）',
        toolbar: '选区操作',
        template: '指令',
        templates: { describe: '描述', ocr: '转文字', diff: '对比' },
        instructions: {
          describe: '看这张图：图里这块内容是什么？有没有明显的问题？',
          ocr: '把这张图里的文字抄出来，保留原有换行和标点。',
          diff: '和上一张图对比，指出有哪些不同（位置 + 变化）。',
        },
        source: '来源：{path}（原图裁切 {x},{y},{w},{h}）',
        look: '看图',
        copy: '复制',
        cancel: '取消',
        hintSelect: '拖动框选一块 · Enter 看图 · Ctrl+C 复制 · Esc 取消选区',
        hintView: '滚轮缩放 · 拖动平移 · 双击切换适应/1:1 · ←/→ 换图 · S 选区 · Esc 关闭',
        sent: '已发到输入框',
        copied: '已复制到剪贴板',
        fallback: '没找到输入框，已复制到剪贴板：Ctrl+V 即可发送',
        noCaps: '未检测到 vision-router（图片仍会进入对话）',
        tooBig: '选区太大（超过 40MP），请先框小一点',
        failed: '导出失败',
        pageFirst: '先取消选区再换图',
        noClipboard: '当前环境不能复制图片',
        annotate: '标注',
        annotateTitle: '标注这张图（A）',
        inkbar: '标注工具',
        toolNames: { select: '选择', crop: '裁剪', rect: '矩形', ellipse: '椭圆', arrow: '箭头', pen: '画笔', text: '文字' },
        toolTitles: {
          select: '选择 / 移动（V）',
          crop: '裁剪（C）',
          rect: '矩形（R）',
          ellipse: '椭圆（E）',
          arrow: '箭头（A）',
          pen: '画笔（P）',
          text: '文字（T）',
        },
        undo: '撤销',
        redo: '重做',
        remove: '删除',
        clear: '清空',
        send: '发送',
        save: '保存',
        hintInk: '拖动绘制 · V 选择移动 · Ctrl+Z 撤销 · Enter 发送 · Esc 关闭',
        compare: '对比',
        compareTitle: '和同一组里的另一张图对比（D）',
        compareSide: '并排',
        compareOverlay: '叠加',
        compareDiff: '差异',
        compareSwap: '交换',
        compareClose: '关闭对比',
        compareSendDiff: '发送差异',
        compareSaveDiff: '保存差异',
        compareDiffEmpty: '先算差异再发',
        compareOnlyOne: '这组里只有一张图，没得比',
        compareHint: '两张都加载好才能算差异',
        compareLoading: '加载中…',
        saved: '已保存：{path}',
        saveFailed: '保存失败：{reason}',
        dirtyTitle: '有未导出的标注',
        dirtyKeep: '继续编辑',
        dirtyCopy: '复制后离开',
        dirtyDrop: '放弃（Esc）',
        nothingToSend: '先画点东西或框一块',
        textPlaceholder: '标注文字…',
        format: '格式',
        formatPng: 'PNG',
        formatJpeg: 'JPG',
        formatTitle: '导出格式（PNG 无损 / JPG 体积小，写作/分享常用 JPG）',
        prefsTitle: '偏好设置',
        prefsColor: '默认颜色',
        prefsWidth: '默认线宽',
        prefsCompare: '对比默认',
        prefsCloseAfterSend: '发送后关闭查看器',
        prefsProvenance: '指令里附「来源」行',
        prefsAutoSend: '粘贴后自动发送（危险，默认关）',
        prefsReset: '恢复默认',
        prefsDone: '完成',
        prefsNote: '只存本机（localStorage），不写 profile。',
        viewerLabel: '图片查看器',
        prevTitle: '上一张（←）',
        nextTitle: '下一张（→）',
        zoomOutTitle: '缩小（-）',
        zoomInTitle: '放大（+）',
        fit: '适应',
        fitTitle: '适应窗口（0 / 双击）',
        actualTitle: '原始像素（1）',
        copyImage: '复制',
        copyImageTitle: '把这张图复制到剪贴板（Ctrl+C）',
        refresh: '刷新',
        refreshTitle: '重新读取文件（覆盖写过的图也能更新）',
        close: '关闭',
        closeTitle: '关闭（Esc）',
      },
      en: {
        select: 'Select',
        selectTitle: 'Box a region (S)',
        toolbar: 'Selection actions',
        template: 'Instruction',
        templates: { describe: 'Describe', ocr: 'Text', diff: 'Compare' },
        instructions: {
          describe: 'Look at this picture: what is in this region, and is anything obviously wrong?',
          ocr: 'Copy the text in this picture, keeping the original line breaks and punctuation.',
          diff: 'Compare this with the previous picture and point out what changed (where and how).',
        },
        source: 'Source: {path} (crop {x},{y},{w},{h} of the original)',
        look: 'Look',
        copy: 'Copy',
        cancel: 'Cancel',
        hintSelect: 'Drag to box a region · Enter to look · Ctrl+C to copy · Esc to cancel the box',
        hintView: 'Wheel zooms · drag pans · double-click fits or shows 1:1 · ←/→ pages · S selects · Esc closes',
        sent: 'Sent to the composer',
        copied: 'Copied to the clipboard',
        fallback: 'No composer found; copied to the clipboard — press Ctrl+V to send',
        noCaps: 'No vision router detected (the picture still reaches the conversation)',
        tooBig: 'Selection too large (over 40 MP); box a smaller region',
        failed: 'Export failed',
        pageFirst: 'Cancel the box before changing pictures',
        noClipboard: 'This environment cannot copy images',
        annotate: 'Annotate',
        annotateTitle: 'Annotate this picture (A)',
        inkbar: 'Annotation tools',
        toolNames: { select: 'Move', crop: 'Crop', rect: 'Rect', ellipse: 'Ellipse', arrow: 'Arrow', pen: 'Pen', text: 'Text' },
        toolTitles: {
          select: 'Move / select (V)',
          crop: 'Crop (C)',
          rect: 'Rectangle (R)',
          ellipse: 'Ellipse (E)',
          arrow: 'Arrow (A)',
          pen: 'Pen (P)',
          text: 'Text (T)',
        },
        undo: 'Undo',
        redo: 'Redo',
        remove: 'Delete',
        clear: 'Clear',
        send: 'Send',
        save: 'Save',
        hintInk: 'Drag to draw · V moves/selects · Ctrl+Z undoes · Enter sends · Esc closes',
        compare: 'Compare',
        compareTitle: 'Compare with another picture in this set (D)',
        compareSide: 'Side by side',
        compareOverlay: 'Overlay',
        compareDiff: 'Diff',
        compareSwap: 'Swap',
        compareClose: 'Close compare',
        compareSendDiff: 'Send diff',
        compareSaveDiff: 'Save diff',
        compareDiffEmpty: 'Compute the diff first',
        compareOnlyOne: 'Only one picture in this set — nothing to compare',
        compareHint: 'Both pictures must load before a diff',
        compareLoading: 'Loading…',
        saved: 'Saved: {path}',
        saveFailed: 'Save failed: {reason}',
        dirtyTitle: 'Unsaved annotations',
        dirtyKeep: 'Keep editing',
        dirtyCopy: 'Copy and leave',
        dirtyDrop: 'Discard (Esc)',
        nothingToSend: 'Draw or box something first',
        textPlaceholder: 'Annotation text…',
        format: 'Format',
        formatPng: 'PNG',
        formatJpeg: 'JPG',
        formatTitle: 'Export format (PNG is lossless; JPG is smaller)',
        prefsTitle: 'Preferences',
        prefsColor: 'Default colour',
        prefsWidth: 'Default width',
        prefsCompare: 'Default compare mode',
        prefsCloseAfterSend: 'Close the viewer after sending',
        prefsProvenance: 'Add the source line to the instruction',
        prefsAutoSend: 'Auto-send after paste (risky, off by default)',
        prefsReset: 'Reset',
        prefsDone: 'Done',
        prefsNote: 'Stored on this machine only (localStorage); never written to the profile.',
        viewerLabel: 'Image viewer',
        prevTitle: 'Previous (←)',
        nextTitle: 'Next (→)',
        zoomOutTitle: 'Zoom out (-)',
        zoomInTitle: 'Zoom in (+)',
        fit: 'Fit',
        fitTitle: 'Fit to window (0 / double-click)',
        actualTitle: 'Actual pixels (1)',
        copyImage: 'Copy',
        copyImageTitle: 'Copy this picture to the clipboard (Ctrl+C)',
        refresh: 'Refresh',
        refreshTitle: 'Re-read the file (picks up overwrites)',
        close: 'Close',
        closeTitle: 'Close (Esc)',
      },
    }
    /**
     * Follow the host's UI language, read from `<html lang>` (the locale service
     * keeps that attribute in sync). `navigator.language` is the fallback for a page
     * that never sets it; a reload picks up a language switch, because the copy is
     * baked into the DOM when each surface is built.
     * @returns {'zh' | 'en'} the dictionary to use.
     */
    function detectLang() {
      try {
        const tag = String(document.documentElement.getAttribute('lang') || navigator.language || 'zh').toLowerCase()
        return tag.startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'zh'
      }
    }
    /** The table the viewer reads, resolved once per page load. */
    const TEXT = COPY[detectLang()] ?? COPY.zh

    /** Where this machine keeps the viewer's own preferences (not the profile). */
    const PREFS_KEY = 'dsh-image-preview:prefs'
    /** Defaults; every key is optional on disk and merged over these. */
    const PREFS_DEFAULTS = {
      format: 'png',
      quality: 0.85,
      color: '#ff2d2d',
      width: 4,
      compareMode: 'side',
      closeAfterSend: true,
      provenance: true,
      autoSend: false,
    }

    /** Read the local preferences, merging whatever is on disk over the defaults. */
    function loadPrefs() {
      const out = { ...PREFS_DEFAULTS }
      try {
        const raw = localStorage.getItem(PREFS_KEY)
        if (raw === null) return out
        const parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return out
        if (parsed.format === 'png' || parsed.format === 'jpeg') out.format = parsed.format
        if (typeof parsed.quality === 'number' && parsed.quality >= 0.3 && parsed.quality <= 1) out.quality = parsed.quality
        if (typeof parsed.color === 'string' && /^#[0-9a-f]{6}$/iu.test(parsed.color)) out.color = parsed.color
        if (typeof parsed.width === 'number' && WIDTHS.includes(parsed.width)) out.width = parsed.width
        if (parsed.compareMode === 'side' || parsed.compareMode === 'overlay' || parsed.compareMode === 'diff') out.compareMode = parsed.compareMode
        for (const flag of ['closeAfterSend', 'provenance', 'autoSend']) {
          if (typeof parsed[flag] === 'boolean') out[flag] = parsed[flag]
        }
      } catch {
        /* no storage, or a corrupt value: defaults win */
      }
      return out
    }

    /** Persist the preferences; a private-mode failure must not break the viewer. */
    function savePrefs(next) {
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next))
      } catch {
        /* storage is a convenience, not a requirement */
      }
    }

    /** The live preferences (module scope: both the annotator and the picker read it). */
    let prefs = loadPrefs()

    const CSS = `
.dsh-ip-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 34px;
  margin: 0 2px;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 18%, transparent));
  border-radius: 5px;
  background:
    repeating-conic-gradient(color-mix(in srgb, currentColor 6%, transparent) 0% 25%, transparent 0% 50%) 0 0 / 12px 12px,
    transparent;
  color: inherit;
  vertical-align: middle;
  cursor: zoom-in;
}
.dsh-ip-chip:hover {
  border-color: var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 45%, transparent));
}
.dsh-ip-chip:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, currentColor);
  outline-offset: 1px;
}
.dsh-ip-chip img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.dsh-ip-chip-failed {
  padding: 2px;
  font-size: 10px;
  line-height: 1.2;
  text-align: center;
  opacity: 0.7;
  word-break: break-all;
}
.dsh-ip-figure {
  display: block;
  margin: 6px 0 4px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: zoom-in;
}
.dsh-ip-figure:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary, currentColor);
  outline-offset: 2px;
}
.dsh-ip-figure img {
  display: block;
  max-width: min(560px, 100%);
  max-height: 320px;
  border: 1px solid var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 16%, transparent));
  border-radius: 6px;
  background:
    repeating-conic-gradient(color-mix(in srgb, currentColor 6%, transparent) 0% 25%, transparent 0% 50%) 0 0 / 16px 16px,
    transparent;
}
.dsh-ip-figure-cap {
  display: block;
  margin-top: 3px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, inherit);
  opacity: 0.85;
  font-variant-numeric: tabular-nums;
}
/* 整块只剩图片路径时，把原始路径那行藏起来：图已经说明一切。
   只改样式、不切文本节点，所以 React 拥有的文本节点保持完整，路径仍可选中复制。 */
[data-ip-hide-path="1"] {
  font-size: 0;
  line-height: 0;
}
[data-ip-hide-path="1"] > br {
  display: none;
}
.dsh-ip-hover {
  position: fixed;
  z-index: 8000;
  display: none;
  max-width: 360px;
  padding: 5px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.18));
  border-radius: 8px;
  background: var(--dsw-alias-bg-overlay, rgba(16, 18, 24, 0.92));
  box-shadow: 0 12px 32px color-mix(in srgb, var(--dsw-alias-label-primary, #000) 22%, transparent);
  pointer-events: none;
}
.dsh-ip-hover img {
  display: block;
  max-width: 340px;
  max-height: 280px;
  border-radius: 5px;
}
.dsh-ip-hover-cap {
  padding: 3px 3px 0;
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 11px;
  opacity: 0.9;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dsh-ip-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 12px;
}
.dsh-ip-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  opacity: 0.72;
}
.dsh-ip-card-title {
  font-weight: 600;
}
.dsh-ip-card-count {
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.dsh-ip-card-caption {
  font-size: 13px;
  opacity: 0.85;
  white-space: pre-wrap;
}
.dsh-ip-card-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.dsh-ip-thumb {
  position: relative;
  display: block;
  width: 148px;
  height: 112px;
  padding: 0;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, currentColor 16%, transparent);
  border-radius: 6px;
  background:
    repeating-conic-gradient(color-mix(in srgb, currentColor 6%, transparent) 0% 25%, transparent 0% 50%) 0 0 / 16px 16px,
    transparent;
  cursor: zoom-in;
}
.dsh-ip-thumb img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.dsh-ip-thumb:hover {
  border-color: color-mix(in srgb, currentColor 40%, transparent);
}
.dsh-ip-thumb-failed {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px;
  font-size: 11px;
  line-height: 1.4;
  text-align: center;
  opacity: 0.7;
  word-break: break-all;
}
.dsh-ip-card-empty {
  font-size: 12px;
  opacity: 0.7;
}
.dsh-ipv-root {
  position: fixed;
  inset: 0;
  /* A full-screen viewer has to be above the host's in-page floats: the browser
     tool's watch pill sets z-index 2147483000 at bottom-right and used to cover
     the action bar. Nothing in the page can sit above the maximum. */
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
  padding-top: var(--dsh-frame-overlay-top, 0px);
  background: rgba(12, 14, 20, 0.86);
  color: #f4f5f7;
  font-family: inherit;
  -webkit-app-region: no-drag;
}
.dsh-ipv-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
}
.dsh-ipv-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  opacity: 0.85;
}
.dsh-ipv-meta {
  flex: none;
  font-size: 12px;
  opacity: 0.6;
  font-variant-numeric: tabular-nums;
}
.dsh-ipv-tools {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
.dsh-ipv-btn {
  min-width: 30px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dsh-ipv-btn:hover {
  background: rgba(255, 255, 255, 0.14);
}
.dsh-ipv-btn[disabled] {
  opacity: 0.35;
  cursor: default;
}
.dsh-ipv-stage {
  position: relative;
  flex: 1;
  overflow: hidden;
  cursor: grab;
  touch-action: none;
}
.dsh-ipv-stage[data-dragging="1"] {
  cursor: grabbing;
}
.dsh-ipv-image {
  position: absolute;
  top: 50%;
  left: 50%;
  max-width: none;
  max-height: none;
  image-rendering: auto;
  transform-origin: center center;
  user-select: none;
  -webkit-user-drag: none;
}
.dsh-ipv-image[data-pixel="1"] {
  image-rendering: pixelated;
}
.dsh-ipv-message {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  font-size: 13px;
  line-height: 1.6;
  text-align: center;
  opacity: 0.8;
  pointer-events: none;
}
.dsh-ipv-hint {
  padding: 6px 12px 10px;
  font-size: 11px;
  opacity: 0.5;
}
.dsh-ipv-ink {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  touch-action: none;
}
.dsh-ipv-stage[data-selecting="1"] {
  cursor: crosshair;
}
.dsh-ipv-inkbar {
  display: none;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 12px 8px;
  font-size: 12px;
}
.dsh-ipv-inklabel {
  margin-right: 2px;
  opacity: 0.6;
}
.dsh-ipv-tpl,
.dsh-ipv-inkbtn {
  height: 26px;
  padding: 0 10px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dsh-ipv-tpl:hover,
.dsh-ipv-inkbtn:hover {
  background: rgba(255, 255, 255, 0.14);
}
.dsh-ipv-tpl[aria-pressed="true"] {
  border-color: rgba(255, 255, 255, 0.34);
  background: rgba(255, 255, 255, 0.2);
}
.dsh-ipv-inkbtn-primary {
  border-color: transparent;
  background: var(--dsw-alias-brand-primary, #2f6fed);
  color: #fff;
  font-weight: 600;
}
.dsh-ipv-inkbtn-primary:hover {
  background: var(--dsw-alias-brand-primary, #2f6fed);
  filter: brightness(1.08);
}
.dsh-ipv-inkspacer {
  flex: 1;
}
.dsh-ipv-tool[aria-pressed="true"],
.dsh-ipv-width[aria-pressed="true"] {
  border-color: rgba(255, 255, 255, 0.34);
  background: rgba(255, 255, 255, 0.2);
}
.dsh-ipv-inkbar-annotate .dsh-ipv-inklabel {
  margin-left: 6px;
}
.dsh-ipv-swatch {
  width: 18px;
  height: 18px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.45);
  border-radius: 50%;
  cursor: pointer;
}
.dsh-ipv-swatch[aria-pressed="true"] {
  outline: 2px solid #fff;
  outline-offset: 1px;
}
.dsh-ipv-width {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  padding: 0;
}
.dsh-ipv-width::after {
  content: "";
  display: block;
  width: 14px;
  height: var(--w, 4px);
  border-radius: 999px;
  background: currentColor;
}
.dsh-ipv-textedit {
  position: absolute;
  z-index: 1;
  min-width: 40px;
  padding: 2px 4px;
  border: 1px dashed rgba(255, 255, 255, 0.7);
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.35);
  font-size: 16px;
  line-height: 1.2;
  white-space: pre-wrap;
  outline: none;
}
.dsh-ipv-textedit:empty::before {
  content: attr(data-placeholder);
  opacity: 0.55;
}
.dsh-ipv-dirty {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
}
.dsh-ipv-dirty-card {
  min-width: 260px;
  padding: 16px 18px;
  border-radius: 10px;
  background: rgba(24, 26, 32, 0.96);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}
.dsh-ipv-dirty-title {
  margin-bottom: 12px;
  font-size: 13px;
}
.dsh-ipv-dirty-row {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.dsh-ipv-prefs {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: none;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
}
.dsh-ipv-prefs-card {
  width: min(420px, calc(100% - 32px));
  padding: 16px 18px;
  border-radius: 10px;
  background: rgba(24, 26, 32, 0.97);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  font-size: 12px;
}
.dsh-ipv-prefs-title {
  margin-bottom: 10px;
  font-size: 13px;
  font-weight: 600;
}
.dsh-ipv-prefs-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
}
.dsh-ipv-prefs-label {
  min-width: 72px;
  opacity: 0.7;
}
.dsh-ipv-prefs-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.dsh-ipv-prefs-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.dsh-ipv-prefs-note {
  margin-top: 8px;
  font-size: 11px;
  opacity: 0.55;
}
.dsh-ipv-prefs-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
.dsh-ipv-compare {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  background: rgba(10, 12, 16, 0.95);
}
.dsh-ipv-compare-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  font-size: 12px;
}
.dsh-ipv-compare-name {
  max-width: 30%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.8;
}
.dsh-ipv-compare-select {
  max-width: 34%;
  padding: 2px 6px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.08);
  color: inherit;
  font: inherit;
  font-size: 12px;
}
.dsh-ipv-compare-body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.dsh-ipv-compare-pane {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  padding: 8px;
}
.dsh-ipv-compare-pane img,
.dsh-ipv-compare-pane canvas {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  background: #000;
}
.dsh-ipv-compare-hint {
  margin: auto;
  font-size: 12px;
  opacity: 0.7;
}
.dsh-ipv-compare-overlay {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #000;
}
.dsh-ipv-compare-overlay img {
  position: absolute;
  inset: 0;
  margin: auto;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.dsh-ipv-compare-split {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 2px;
  margin-left: -1px;
  background: #fff;
  cursor: ew-resize;
  touch-action: none;
}
.dsh-ipv-compare-split::after {
  content: "";
  position: absolute;
  top: 50%;
  left: 50%;
  width: 18px;
  height: 18px;
  margin: -9px 0 0 -9px;
  border-radius: 50%;
  background: #fff;
  opacity: 0.9;
}
.dsh-ipv-status {
  position: absolute;
  left: 50%;
  bottom: 48px;
  max-width: 70%;
  padding: 6px 12px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.72);
  color: #fff;
  font-size: 12px;
  opacity: 0;
  transition: opacity 120ms ease;
  pointer-events: none;
  transform: translateX(-50%);
}
.dsh-ipv-status[data-on="1"] {
  opacity: 1;
}
`

    // ------------------------------ small helpers ------------------------------

    /**
     * Encode one path into a URL path segment (base64url).
     *
     * The path travels in the pathname rather than a query parameter: a custom
     * scheme proxy may hand the pathname through untouched while the query
     * string is the fragile part.
     * @param {string} value - the absolute local path.
     * @returns {string} the segment, or the empty string when it cannot encode.
     */
    function encodeSegment(value) {
      try {
        const bytes = new TextEncoder().encode(value)
        let binary = ''
        for (const byte of bytes) binary += String.fromCharCode(byte)
        return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
      } catch {
        return ''
      }
    }

    /**
     * Every URL worth trying for one local image, best guess first.
     *
     * This plugin's own read-only route serves the bytes first — once as a path
     * segment (immune to query loss) and once as `?path=…` for older builds — and
     * the official `api/file` follows. Every route is tried against
     * `document.baseURI`, the page URL, the origin and the desktop `dsh-app://`
     * scheme, and for both spellings of a Windows path.
     * @param {string} file - an absolute local path.
     * @param {number} [bust] - a cache-busting stamp for the manual refresh.
     * @returns {string[]} candidate URLs, de-duplicated.
     */
    function imageSourceCandidates(file, bust) {
      if (typeof file !== 'string' || file === '') return []
      if (/^[/\\]{2}/.test(file)) return []
      if (/[\u0000-\u001f\u007f]/u.test(file)) return []
      if (!/^[A-Za-z]:[\\/]/u.test(file)) return []
      const suffix = bust ? '&v=' + bust : ''
      const segment = encodeSegment(file)
      const urls = []
      const push = (value) => {
        if (typeof value === 'string' && value !== '' && !urls.includes(value)) urls.push(value)
      }
      const bases = () => {
        const list = []
        try {
          list.push(new URL('.', document.baseURI).href)
        } catch {
          /* an unusable base */
        }
        try {
          list.push(new URL('.', window.location.href).href)
        } catch {
          /* an unusable page URL */
        }
        try {
          const origin = window.location.origin
          if (typeof origin === 'string' && origin !== 'null' && /^https?:/u.test(origin)) list.push(origin + '/')
        } catch {
          /* no usable origin */
        }
        list.push('dsh-app://app/')
        return list
      }
      const addRoute = (route) => {
        for (const base of bases()) {
          try {
            push(new URL(route, base).href)
          } catch {
            /* this base cannot express the route */
          }
        }
      }
      if (segment !== '') addRoute('image-preview/blob/' + segment)
      for (const spelling of [file, file.replace(/\\/gu, '/')]) {
        addRoute('image-preview/file?path=' + encodeURIComponent(spelling) + suffix)
        addRoute('api/file?path=' + encodeURIComponent(spelling) + suffix)
      }
      return urls
    }

    /**
     * Fetch one image and hand back an object URL.
     *
     * A `<img>` that fails while `fetch` succeeds (a rejected image request, a
     * stale element, a scheme quirk) still ends up on screen this way, and a
     * failed fetch carries the HTTP status that explains the failure.
     */
    const blobUrls = new Map()
    /** Bound the URL-fallback cache too: it holds whole pictures as object URLs. */
    const BLOB_URL_LIMIT = 32

    /** How many URL fallbacks one picture may try before it gives up. */
    const FALLBACK_LIMIT = 12

    /**
     * Resolve one URL to a blob URL, caching successes and forgetting failures.
     * @param {string} url - the image URL.
     * @returns {Promise<string>} a blob URL.
     */
    function toBlobUrl(url) {
      const cached = blobUrls.get(url)
      if (cached !== undefined) return cached
      const task = fetch(url, { credentials: 'same-origin' }).then(async (response) => {
        if (response.ok !== true) {
          let detail = ''
          try {
            detail = (await response.text()).trim().replace(/\s+/gu, ' ').slice(0, 140)
          } catch {
            /* the body is not readable */
          }
          throw new Error('HTTP ' + response.status + (detail === '' ? '' : ' · ' + detail))
        }
        const blob = await response.blob()
        if (blob.size === 0) throw new Error('空响应')
        return URL.createObjectURL(blob)
      })
      task.catch(() => blobUrls.delete(url))
      blobUrls.set(url, task)
      if (blobUrls.size > BLOB_URL_LIMIT) {
        const oldest = blobUrls.keys().next()
        if (oldest.done !== true) {
          releaseEntry(blobUrls.get(oldest.value))
          blobUrls.delete(oldest.value)
        }
      }
      return task
    }

    /** Drop every URL-fallback blob (plugin unload). */
    function releaseBlobUrls() {
      for (const task of blobUrls.values()) releaseEntry(task)
      blobUrls.clear()
    }

    /**
     * Ask the host for one file's bytes over a POST body.
     *
     * The path never enters the URL here: whatever the desktop shell does to a
     * URL, the JSON body is untouched, so this is the transport that survives a
     * re-encoding proxy. The answer is read as raw bytes into a `Blob`, so the
     * page never holds a base64 copy of the picture: an `<img>` points at the
     * object URL, and the bytes leave memory with the URL.
     * @param {string} file - the absolute local path.
     * @returns {Promise<{ url: string, asked: string, bytes: number }>} a blob URL.
     */
    async function readOnce(file) {
      const url = new URL('image-preview/read', document.baseURI).href
      const abort = typeof AbortController === 'function' ? new AbortController() : null
      // The timer covers the whole exchange, body included: a header-only
      // timeout used to leave the body free to hang for minutes.
      const timer = abort === null ? null : setTimeout(() => abort.abort(), 20000)
      let response
      let blob
      try {
        response = await fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', accept: 'application/octet-stream' },
          body: JSON.stringify({ path: file }),
          signal: abort === null ? undefined : abort.signal,
        })
        if (response.ok !== true) {
          // A refused read is answered as JSON: keep the host's own reason, not the
          // raw envelope (the chip only has room for a few characters).
          let detail = ''
          try {
            const body = (await response.text()).trim()
            let reason = ''
            try {
              const parsed = JSON.parse(body)
              if (parsed !== null && typeof parsed?.reason === 'string') reason = parsed.reason
            } catch {
              /* not JSON: fall back to the body itself */
            }
            detail = (reason === '' ? body : reason).replace(/\s+/gu, ' ').slice(0, 160)
          } catch {
            /* the body is not readable */
          }
          throw new Error('HTTP ' + response.status + (detail === '' ? '' : ' · ' + detail))
        }
        const mediaType = response.headers.get('content-type') ?? ''
        if (mediaType.includes('application/json')) {
          // An older host answers base64 whatever was asked for.
          const payload = await response.json()
          if (payload?.ok !== true || typeof payload.base64 !== 'string') {
            throw new Error('宿主返回的图片数据不完整')
          }
          const binary = atob(payload.base64)
          const bytes = new Uint8Array(binary.length)
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
          blob = new Blob([bytes], { type: typeof payload.mediaType === 'string' ? payload.mediaType : 'image/png' })
        } else {
          blob = await response.blob()
        }
        if (blob.size === 0) throw new Error('空响应')
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('HTTP ')) throw error
        const message = String((error instanceof Error ? error.message : error) || '未知原因')
        throw new Error('POST 请求失败：' + message)
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
      return { url: URL.createObjectURL(blob), asked: file, bytes: blob.size }
    }

    /** How many byte reads may be in flight at once, so a gallery cannot spike the renderer. */
    const READ_CONCURRENCY = 3
    let activeReads = 0
    const readQueue = []

    /**
     * Run one read once fewer than READ_CONCURRENCY others are running.
     * @param {() => Promise<unknown>} run - the read to admit.
     * @returns {Promise<unknown>} its result.
     */
    function withReadSlot(run) {
      return new Promise((resolve, reject) => {
        const start = () => {
          activeReads += 1
          run()
            .then(resolve, reject)
            .finally(() => {
              activeReads -= 1
              const next = readQueue.shift()
              if (next !== undefined) next()
            })
        }
        if (activeReads < READ_CONCURRENCY) start()
        else readQueue.push(start)
      })
    }

    /** Release one cached blob URL when its entry leaves the cache. */
    function releaseEntry(task) {
      Promise.resolve(task)
        .then((value) => {
          const url = typeof value?.url === 'string' ? value.url : ''
          if (url.startsWith('blob:') !== true) return
          // A picture that is on screen right now still points at this object URL:
          // revoking it blanks the image on the next re-layout. Let it die with the
          // page instead.
          if (document.querySelector('img[src="' + cssEscape(url) + '"]') !== null) return
          URL.revokeObjectURL(url)
        })
        .catch(() => {})
    }

    /**
     * The bytes of one file, shared between every surface that shows it.
     *
     * A path is usually shown more than once — the chip in the prose, the figure
     * under it, the card's thumbnail, the hover preview, the viewer — and each
     * surface used to POST the same file again, so one picture could cost five
     * transfers of its own bytes. The key carries the viewer's refresh stamp, so
     * "刷新" still reads the file again.
     */
    const readCache = new Map()
    const READ_CACHE_LIMIT = 32
    /** Pictures above this size are shown but not retained: a cache is not a hoard. */
    const READ_RETAIN_LIMIT = 16 * 1024 * 1024

    /**
     * Resolve one file's bytes through the host, once per (path, refresh).
     * @param {string} file - the absolute local path.
     * @param {number} [bust] - the viewer's refresh stamp.
     * @returns {Promise<{ url: string, asked: string, bytes: number }>} a blob URL.
     */
    function readViaHost(file, bust) {
      const key = file + '\u0000' + (bust === undefined || bust === 0 ? '' : String(bust))
      const cached = readCache.get(key)
      if (cached !== undefined) return cached
      const task = withReadSlot(() => readOnce(file))
      readCache.set(key, task)
      if (readCache.size > READ_CACHE_LIMIT) {
        const oldest = readCache.keys().next()
        if (oldest.done !== true) {
          releaseEntry(readCache.get(oldest.value))
          readCache.delete(oldest.value)
        }
      }
      // A 30 MB scan is worth showing and not worth pinning in the renderer for
      // the rest of the session; the entry still answers its own callers.
      task.then((value) => {
        if ((Number(value?.bytes) || 0) > READ_RETAIN_LIMIT && readCache.get(key) === task) {
          releaseEntry(task)
          readCache.delete(key)
        }
      }, () => readCache.delete(key))
      return task
    }

    /** Drop every cached blob (plugin unload, or a page that is going away). */
    function releaseReadCache() {
      for (const task of readCache.values()) releaseEntry(task)
      readCache.clear()
    }

    /**
     * Every source for one file: the host's POST answer first, then URL routes.
     * @param {string} file - the absolute local path.
     * @param {number} [bust] - a cache-busting stamp.
     * @returns {Promise<{ list: string[], postError: string }>} candidate sources and the POST failure, when there was one.
     */
    async function sourcesFor(file, bust) {
      const list = []
      let postError = ''
      try {
        const read = await readViaHost(file, bust)
        if (typeof read.url === 'string' && read.url !== '') list.push(read.url)
      } catch (error) {
        // Kept per call: one failing picture must not describe another one's failure.
        postError = String((error instanceof Error ? error.message : error) || '未知原因')
        console.warn('[image-preview] POST 取图失败：' + postError)
      }
      // A 404 from the host's own read route is a verdict about the file itself
      // (gone, not a bitmap, wrong extension), and every other route runs the same
      // check — trying twenty of them only buys twenty more failing requests. A
      // trust or transport failure is different: that can differ per route.
      const settled = postError.startsWith('HTTP 404')
      const fallbacks = imageSourceCandidates(file, bust)
      for (const url of settled === true ? [] : fallbacks.slice(0, FALLBACK_LIMIT)) list.push(url)
      return { list, postError }
    }

    /**
     * Point an `<img>` at a local image, walking every source and falling back
     * to a fetched blob when a direct URL request dies.
     * @param {HTMLImageElement} image - the element to fill.
     * @param {string} file - the absolute local path.
     * @param {(reason: string) => void} onFail - called when nothing worked.
     * @param {number} [bust] - a cache-busting stamp.
     */
    async function attachImage(image, file, onFail, bust) {
      let urls = []
      let postError = ''
      try {
        const sources = await sourcesFor(file, bust)
        urls = sources.list
        postError = sources.postError
      } catch {
        urls = imageSourceCandidates(file, bust)
      }
      let cursor = 0
      let reason = ''
      const next = () => {
        const url = urls[cursor]
        cursor += 1
        if (url === undefined) {
          onFail(reason === '' ? postError || '没有可用的取图地址' : reason)
          return
        }
        // A blob URL and a data URL are already one picture in memory: nothing
        // left to fetch, so a failure here is a decode failure.
        if (url.startsWith('data:') === true || url.startsWith('blob:') === true) {
          image.onerror = () => {
            reason = '宿主返回的字节解不成图片'
            next()
          }
          image.src = url
          return
        }
        image.onerror = () => {
          toBlobUrl(url).then(
            (blobUrl) => {
              image.onerror = next
              image.src = blobUrl
            },
            (error) => {
              reason = String((error instanceof Error ? error.message : error) || '未知原因')
              console.warn('[image-preview] 图片请求失败：' + url + ' → ' + reason)
              next()
            },
          )
        }
        image.src = url
      }
      next()
    }

    /** The last path segment, for labels. */
    function baseName(file) {
      const parts = String(file).split(/[\\/]/)
      return parts[parts.length - 1] || String(file)
    }

    /** Cancel handles for elements that are still waiting to enter the viewport. */
    const waiting = new WeakMap()

    /**
     * Run one loader once its element is near the viewport, so a long transcript
     * does not fetch every thumbnail up front.
     * @param {Element} element - the element to watch.
     * @param {() => void} run - the loader.
     * @returns {() => void} a cancel handle; call it when the element goes away
     * before it was ever visible, otherwise the observer holds it forever.
     */
    function whenVisible(element, run) {
      if (typeof IntersectionObserver !== 'function') {
        run()
        return () => {}
      }
      let fired = false
      const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting !== true) continue
          fired = true
          observer.disconnect()
          waiting.delete(element)
          run()
          return
        }
      }, { rootMargin: '300px' })
      observer.observe(element)
      const stop = () => {
        if (fired) return
        fired = true
        observer.disconnect()
        waiting.delete(element)
      }
      waiting.set(element, stop)
      return stop
    }

    /** Stop waiting on one element that is being taken out of the document. */
    function dropWaiting(element) {
      const stop = waiting.get(element)
      if (stop !== undefined) stop()
    }

    /** Keep the first occurrence of every path, in order. */    function unique(list) {
      const seen = new Set()
      const out = []
      for (const item of list) {
        if (typeof item !== 'string') continue
        const trimmed = item.trim()
        if (trimmed === '' || seen.has(trimmed)) continue
        seen.add(trimmed)
        out.push(trimmed)
      }
      return out
    }

    // --------------------------- composer bridge ---------------------------

    /**
     * The composer editor that last had focus.
     *
     * A viewer opened from a thumbnail has no spatial relation to the composer,
     * so "nearest ancestor" finds nothing; remembering the last editor a key press
     * or click landed in is what makes the second step of `findComposer` work.
     */
    let lastEditor = null

    /** Keep the last focused contenteditable, for `findComposer`. */
    function rememberEditor(event) {
      const target = event.target
      if (target instanceof HTMLElement && target.isContentEditable === true) lastEditor = target
    }

    /**
     * Find the composer a picture should be sent to.
     *
     * Nearest editor in the anchor's ancestors wins (a figure sits in the
     * conversation whose composer it belongs to), then the editor that last had
     * focus, then the last visible one in the document. Only visible, connected
     * editors count: an unmounted route keeps stale DOM around.
     * @param {Element | null} anchor - where the request came from.
     * @returns {HTMLElement | null} the editor root, or null when there is none.
     */
    function findComposer(anchor) {
      const usable = (node) => node instanceof HTMLElement && node.isContentEditable === true
        && node.isConnected === true && node.getClientRects().length > 0
      for (let node = anchor ?? null; node !== null; node = node.parentElement) {
        const found = typeof node.querySelector === 'function' ? node.querySelector(EDITOR_SELECTOR) : null
        if (usable(found)) return found
      }
      if (usable(lastEditor)) return lastEditor
      const all = Array.from(document.querySelectorAll(EDITOR_SELECTOR)).filter((node) => usable(node))
      return all.length === 0 ? null : all[all.length - 1]
    }

    /** A file name for one sent picture; the prefix doubles as the landing anchor. */
    function fileStamp(now, extension) {
      const at = new Date(now)
      const pad = (value) => String(value).padStart(2, '0')
      return ATTACHMENT_PREFIX + at.getFullYear() + pad(at.getMonth() + 1) + pad(at.getDate())
        + '-' + pad(at.getHours()) + pad(at.getMinutes()) + pad(at.getSeconds()) + (extension ?? '.png')
    }

    /**
     * Paint one annotation. Every coordinate is a source-image pixel, so the same
     * mark renders identically on the layer and in the exported PNG.
     * @param {CanvasRenderingContext2D} context - the target context.
     * @param {object} mark - one entry of the mark list.
     */
    function drawMark(context, mark) {
      if (mark === null || mark === undefined) return
      context.strokeStyle = mark.color
      context.fillStyle = mark.color
      context.lineWidth = mark.width
      context.lineCap = 'round'
      context.lineJoin = 'round'
      context.setLineDash(mark.dashed === true ? [mark.width * 4, mark.width * 3] : [])
      if (mark.type === 'rect') {
        context.strokeRect(Math.min(mark.x0, mark.x1), Math.min(mark.y0, mark.y1),
          Math.abs(mark.x1 - mark.x0), Math.abs(mark.y1 - mark.y0))
        return
      }
      if (mark.type === 'ellipse') {
        context.beginPath()
        context.ellipse((mark.x0 + mark.x1) / 2, (mark.y0 + mark.y1) / 2,
          Math.abs(mark.x1 - mark.x0) / 2, Math.abs(mark.y1 - mark.y0) / 2, 0, 0, Math.PI * 2)
        context.stroke()
        return
      }
      if (mark.type === 'arrow') {
        const dx = mark.x1 - mark.x0
        const dy = mark.y1 - mark.y0
        const length = Math.sqrt(dx * dx + dy * dy)
        if (length < 1) return
        const head = Math.min(length / 2, mark.width * 5)
        const angle = Math.atan2(dy, dx)
        context.beginPath()
        context.moveTo(mark.x0, mark.y0)
        context.lineTo(mark.x1 - Math.cos(angle) * head * 0.6, mark.y1 - Math.sin(angle) * head * 0.6)
        context.stroke()
        context.beginPath()
        context.moveTo(mark.x1, mark.y1)
        context.lineTo(mark.x1 - Math.cos(angle - 0.42) * head, mark.y1 - Math.sin(angle - 0.42) * head)
        context.lineTo(mark.x1 - Math.cos(angle + 0.42) * head, mark.y1 - Math.sin(angle + 0.42) * head)
        context.closePath()
        context.fill()
        return
      }
      if (mark.type === 'pen') {
        const points = mark.points ?? []
        if (points.length < 4) return
        context.beginPath()
        context.moveTo(points[0], points[1])
        for (let at = 2; at + 1 < points.length; at += 2) context.lineTo(points[at], points[at + 1])
        context.stroke()
        return
      }
      if (mark.type === 'text') {
        context.font = (mark.size ?? TEXT_SIZES[1]) + 'px system-ui, "Microsoft YaHei", "PingFang SC", sans-serif'
        context.textBaseline = 'top'
        context.shadowColor = 'rgba(0, 0, 0, 0.6)'
        context.shadowBlur = Math.max(2, (mark.size ?? TEXT_SIZES[1]) / 4)
        context.fillText(mark.text ?? '', mark.x0, mark.y0)
        context.shadowBlur = 0
        context.setLineDash([])
        return
      }
      context.setLineDash([])
    }

    /** Paint the whole mark list, then the stroke still being drawn. */
    function drawMarks(context, marks, draft) {
      for (const mark of marks) drawMark(context, mark)
      if (draft !== null && draft !== undefined) drawMark(context, draft)
    }

    /**
     * Dim everything outside the crop and draw its edge.
     * @param {CanvasRenderingContext2D} context - the annotation layer's context.
     * @param {{ x: number, y: number, w: number, h: number }} crop - the region, in source pixels.
     * @param {{ width: number, height: number }} naturalSize - the picture's source size.
     * @param {number} zoom - current scale, so the edge stays one screen pixel wide.
     */
    function paintCrop(context, crop, naturalSize, zoom) {
      const k = zoom > 0 ? zoom : 1
      context.save()
      context.setLineDash([])
      context.fillStyle = 'rgba(0, 0, 0, 0.55)'
      context.fillRect(0, 0, naturalSize.width, crop.y)
      context.fillRect(0, crop.y + crop.h, naturalSize.width, Math.max(0, naturalSize.height - crop.y - crop.h))
      context.fillRect(0, crop.y, crop.x, crop.h)
      context.fillRect(crop.x + crop.w, crop.y, Math.max(0, naturalSize.width - crop.x - crop.w), crop.h)
      context.strokeStyle = '#ffffff'
      context.lineWidth = 1.5 / k
      context.setLineDash([7 / k, 5 / k])
      context.strokeRect(crop.x, crop.y, crop.w, crop.h)
      context.restore()
    }

    /**
     * Cut the annotated region out of the picture as a PNG.
     *
     * Coordinates are source pixels, so the same crop lands on the same pixels
     * whatever the on-screen zoom. A plain canvas (not `OffscreenCanvas`) keeps
     * this working on every carrier the desktop ships.
     * @param {HTMLImageElement} picture - the loaded source picture.
     * @param {{ x: number, y: number, w: number, h: number } | null} crop - the region, or null for all of it.
     * @param {object[]} [marks] - annotations, in source pixels; empty for the region-only path.
     * @returns {Promise<Blob>} the PNG bytes.
     */
    /**
     * Cut the annotated region out of the picture.
     * @param {HTMLImageElement} picture - the loaded source picture.
     * @param {{ x: number, y: number, w: number, h: number } | null} crop - the region, or null for all of it.
     * @param {object[]} [marks] - annotations, in source pixels; empty for the region-only path.
     * @param {{ type?: 'png' | 'jpeg', quality?: number }} [options] - output format and JPEG quality.
     * @returns {Promise<Blob>} the encoded picture.
     */
    function exportPng(picture, crop, marks, options) {
      if (picture === null || picture.naturalWidth <= 0) return Promise.reject(new Error(TEXT.failed))
      const full = crop === null || crop === undefined
      const width = full ? picture.naturalWidth : Math.max(1, Math.round(crop.w))
      const height = full ? picture.naturalHeight : Math.max(1, Math.round(crop.h))
      const offsetX = full ? 0 : Math.round(crop.x)
      const offsetY = full ? 0 : Math.round(crop.y)
      const type = options?.type === 'jpeg' ? 'image/jpeg' : 'image/png'
      const quality = typeof options?.quality === 'number' ? options.quality : 0.85
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (context === null) return Promise.reject(new Error(TEXT.failed))
      // JPEG has no alpha: without a matte every transparent pixel turns black.
      if (type === 'image/jpeg') {
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, width, height)
      }
      context.drawImage(picture, offsetX, offsetY, width, height, 0, 0, width, height)
      context.translate(-offsetX, -offsetY)
      drawMarks(context, marks ?? [], null)
      return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
          if (blob === null) reject(new Error(TEXT.failed))
          else resolve(blob)
        }, type, quality)
      })
    }

    /**
     * Hand a PNG plus one instruction to the composer, the way a user's Ctrl+V does.
     *
     * The composer is a Lexical editor: its paste command takes the files and the
     * plain text out of the very same `clipboardData` (host-verified), so one
     * synthetic paste both attaches the picture and types the instruction.
     * @param {HTMLElement} editor - the composer's editor root.
     * @param {Blob} blob - the PNG.
     * @param {string} name - the file name the attachment shows (and reports back in `alt`).
     * @param {string} text - the instruction to type; empty leaves the draft untouched.
     * @returns {boolean} whether the composer claimed the event.
     */
    function pasteImageWithText(editor, blob, name, text) {
      if (typeof DataTransfer !== 'function' || typeof ClipboardEvent !== 'function' || typeof File !== 'function') {
        return false
      }
      const transfer = new DataTransfer()
      transfer.items.add(new File([blob], name, { type: blob.type === '' ? 'image/png' : blob.type }))
      if (text !== '') transfer.setData('text/plain', text)
      try {
        editor.focus({ preventScroll: true })
      } catch {
        /* focus is a courtesy: the paste command does not need it */
      }
      const event = new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
      editor.dispatchEvent(event)
      return event.defaultPrevented === true
    }

    /**
     * Whether a picture we just pasted is really in the draft.
     *
     * `preventDefault` alone is not proof: the editor cancels the event even when
     * its attachment intake refuses the file. The host puts the file name in the
     * thumbnail's `alt`, which is the one stable hook (class names are hashed).
     * @param {string} name - the file name handed to `pasteImageWithText`.
     * @param {number} before - how many of our tiles existed before the paste.
     * @returns {boolean} true when the attachment tile is in the document.
     */
    function attachmentLanded(name, before) {
      if (document.querySelector('img[alt="' + cssEscape(name) + '"]') !== null) return true
      let count = 0
      for (const node of document.querySelectorAll('img[alt]')) {
        if (String(node.alt).startsWith(ATTACHMENT_PREFIX)) count += 1
      }
      return count > before
    }

    /** How many of our own slides are already on the page (a baseline for one paste). */
    function attachmentCount() {
      let count = 0
      for (const node of document.querySelectorAll('img[alt]')) {
        if (String(node.alt).startsWith(ATTACHMENT_PREFIX)) count += 1
      }
      return count
    }

    /** Write one PNG to the clipboard, reporting the reason when the carrier says no. */
    async function copyToClipboard(blob) {
      const clip = navigator.clipboard
      if (clip === undefined || typeof clip.write !== 'function' || typeof ClipboardItem !== 'function') {
        throw new Error(TEXT.noClipboard)
      }
      await clip.write([new ClipboardItem({ 'image/png': blob })])
    }

    /** The last capability answer, so ten viewers in one minute ask the host once. */
    let capabilityCache = { at: 0, value: null }

    /**
     * Ask the host which vision tools it currently exposes.
     *
     * The browser half cannot see the tool registry; this route is the only way
     * to say whether "看这块" will reach a vision route. A missing or failed
     * route answers `null` = unknown, which only changes the tooltip.
     * @returns {Promise<{describe?: boolean, ocr?: boolean, diff?: boolean} | null>} the answer.
     */
    async function visionCapabilities() {
      const now = Date.now()
      if (capabilityCache.value !== null && now - capabilityCache.at < 5000) return capabilityCache.value
      try {
        const url = new URL('image-preview/capabilities', document.baseURI).href
        const response = await fetch(url, { credentials: 'same-origin' })
        if (response.ok !== true) {
          capabilityCache = { at: now, value: null }
          return null
        }
        const report = await response.json()
        const vision = report !== null && typeof report.vision === 'object' && report.vision !== null ? report.vision : null
        capabilityCache = { at: now, value: vision }
        return vision
      } catch {
        capabilityCache = { at: now, value: null }
        return null
      }
    }

    // ------------------------------ the viewer ------------------------------

    /**
     * Build the full-screen viewer once, lazily, and keep it as a singleton.
     * The DOM is created on first open and reused afterwards; `destroy` takes it
     * out again when the plugin unloads.
     */
    function createViewer() {
      let root = null
      let stage = null
      let image = null
      let nameLabel = null
      let metaLabel = null
      let zoomLabel = null
      let message = null
      let prevButton = null
      let nextButton = null
      let paths = []
      let index = 0
      let scale = 1
      let offsetX = 0
      let offsetY = 0
      let natural = { width: 0, height: 0 }
      let drag = null
      let bust = 0
      let keyHandler = null
      let candidates = []
      let cursor = 0
      let lastError = ''
      let lastUrl = ''
      let tried = []
      let loadToken = 0
      let showToken = 0
      /** This picture's POST failure, not whichever one finished last. */
      let postFailure = ''
      /** The element to give the keyboard back to when the overlay closes. */
      let returnFocus = null
      /** The selection layer painted above the picture. */
      let ink = null
      /** The instruction bar under the stage, and the buttons it owns. */
      let inkbar = null
      let selectButton = null
      let templateButtons = []
      let lookButton = null
      /** The one-line hint under the stage, and the toast above it. */
      let hintLabel = null
      let statusLabel = null
      let statusTimer = 0
      /** The box the reader dragged, in source pixels; null when there is none. */
      let selection = null
      /** Whether the viewer is in selection mode (canvas takes pointer events). */
      let selecting = false
      /** The instruction the next send carries. */
      let template = 'describe'
      /** The drag in flight: `{ mode, anchor?, start?, box? }` in source pixels. */
      let inkDrag = null
      /** The window resize listener, installed while the overlay is open. */
      let resizeHandler = null
      /** Annotations, in source pixels; `crop` narrows what an export keeps. */
      let marks = []
      let crop = null
      /** The selected mark index, or -1. */
      let activeMark = -1
      /** Current draw tool, colour and stroke width. */
      let tool = 'select'
      let strokeColor = COLORS[0]
      let strokeWidth = WIDTHS[1]
      /** Undo/redo snapshots of `{ marks, crop }`. */
      let undoStack = []
      let redoStack = []
      /** Whether annotation mode is on (the tool bar is up). */
      let inking = false
      /** The stroke being drawn, and the hit it was started from. */
      let draft = null
      let inkStart = null
      /** The inline text editor while a text mark is typed. */
      let textEditor = null
      let textEditorOrigin = null
      /** The annotation bar and everything in it. */
      let inkbarAnnotate = null
      let annotateButton = null
      let toolButtons = []
      let colorButtons = []
      let widthButtons = []
      let undoButton = null
      let redoButton = null
      let dirtyDialog = null
      /** A/B comparison: the overlay, its two panes, and which paths it shows. */
      let comparing = false
      let compareEl = null
      let compareA = -1
      let compareB = -1
      let compareMode = 'side'
      let compareImgA = null
      let compareImgB = null
      let compareCanvas = null
      let compareTitleEl = null
      let comparePickerEl = null
      let compareButton = null
      let compareChanged = 0
      /** Overlay mode: the two layered pictures, the split line, and its state. */
      let comparePanes = null
      let compareOverlayA = null
      let compareOverlayB = null
      let compareSplitEl = null
      let compareSplit = 0.5
      let compareSplitDrag = false
      let compareDiffActions = []
      let compareDiffReady = false
      /** The preferences panel and its launcher. */
      let prefsPanel = null
      let prefsButton = null

      /** Clamp the scale to the viewer's bounds. */
      const clamp = (value) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))

      /**
       * The stage rectangle, cached until something actually reflows it.
       *
       * Reading it inside `paint()` right after writing the picture's transform
       * forced a synchronous layout on every pointer move. The cache is dropped when
       * the bars appear/disappear, on resize, and on open — the only things that
       * change the stage's box.
       */
      let stageBox = null
      let stageBoxDirty = true
      /** Mark the cached stage box stale. */
      function markStageDirty() {
        stageBoxDirty = true
      }
      /** Read (and cache) the stage rectangle. */
      function stageRect() {
        if (stageBoxDirty === true || stageBox === null) {
          stageBox = stage === null ? { left: 0, top: 0, width: 0, height: 0 } : stage.getBoundingClientRect()
          stageBoxDirty = false
        }
        return stageBox
      }

      /** One pending frame, so a 240 Hz mouse cannot repaint four times a frame. */
      let paintFrame = 0
      let paintTimer = 0
      /** Coalesce a repaint into the next frame, with a timer fallback for hidden windows. */
      function schedulePaint() {
        if (paintFrame !== 0 || paintTimer !== 0) return
        const run = () => {
          if (paintFrame !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(paintFrame)
          paintFrame = 0
          if (paintTimer !== 0) {
            clearTimeout(paintTimer)
            paintTimer = 0
          }
          paint()
        }
        if (typeof requestAnimationFrame === 'function') paintFrame = requestAnimationFrame(run)
        paintTimer = setTimeout(run, 34)
      }

      /** Paint the current transform and the readouts. */
      function paint() {
        if (image === null) return
        // Read layout BEFORE writing the transform, so the two never interleave.
        stageRect()
        const transform =
          'translate(-50%, -50%) translate(' + offsetX.toFixed(1) + 'px, ' + offsetY.toFixed(1) + 'px) scale(' + scale.toFixed(4) + ')'
        if (image.style.transform !== transform) image.style.transform = transform
        const pixel = scale >= 3 ? '1' : '0'
        if (image.dataset.pixel !== pixel) image.dataset.pixel = pixel
        if (zoomLabel !== null) {
          const percent = Math.round(scale * 100) + '%'
          if (zoomLabel.textContent !== percent) zoomLabel.textContent = percent
        }
        // Same frame as the picture: a selection painted a frame later visibly
        // slides against the image during a fast pan.
        inkPaint()
      }

      /** Fit the picture inside the stage, centred. */
      function fit() {
        if (image === null || natural.width <= 0 || natural.height <= 0) return
        const box = stageRect()
        const room = { width: Math.max(80, box.width - 32), height: Math.max(80, box.height - 32) }
        scale = clamp(Math.min(room.width / natural.width, room.height / natural.height, 1))
        offsetX = 0
        offsetY = 0
        paint()
      }

      /** Show the picture at one image pixel per screen pixel, centred. */
      function actual() {
        scale = 1
        offsetX = 0
        offsetY = 0
        paint()
      }

      /** Run once the current picture is decoded and on screen. */
      function onLoaded() {
        if (image === null) return
        if (!(image.naturalWidth > 0 && image.naturalHeight > 0)) {
          lastError = '图片解出 0 尺寸（可能不是有效图片）'
          cursor += 1
          attempt()
          return
        }
        natural = { width: image.naturalWidth, height: image.naturalHeight }
        metaLabel.textContent =
          natural.width + ' × ' + natural.height + (paths.length > 1 ? ' · ' + (index + 1) + ' / ' + paths.length : '')
        fit()
      }

      /** Give up on the current picture and say precisely why. */
      function failed() {
        if (image === null || message === null) return
        const stamp = showToken
        image.style.display = 'none'
        const recent = tried.slice(-3).join('\n')
        message.textContent =
          '打不开这张图片：' + (paths[index] || '') +
          (lastError === '' ? '' : '\n' + lastError) +
          (postFailure === '' ? '' : '\nPOST：' + postFailure) +
          (lastUrl === '' ? '' : '\n' + lastUrl) +
          (recent === '' ? '' : '\n试过：\n' + recent) +
          '\nbase=' + document.baseURI
        // Ask the host what it sees for this path; the answer names the side at fault.
        // The answer arrives later, so it must not land on a picture the reader has
        // already paged away from.
        const file = paths[index]
        if (file !== undefined) diagLine(file).then((line) => {
          if (message !== null && stamp === showToken) message.textContent += '\n' + line
        })
      }

      /**
       * Ask the host's self-report route what it can see for one path.
       * @param {string} file - the absolute local path.
       * @returns {Promise<string>} one short line for the overlay.
       */
      async function diagLine(file) {
        try {
          const url = new URL('image-preview/diag?path=' + encodeURIComponent(file), document.baseURI).href
          const response = await fetch(url, { credentials: 'same-origin' })
          if (response.ok !== true) return 'diag HTTP ' + response.status
          const report = await response.json()
          return 'diag ok=' + String(report.ok) + ' reason=' + (report.reason || '-') + ' bytes=' + String(report.bytes || 0)
        } catch (error) {
          return 'diag 失败：' + String((error instanceof Error ? error.message : error) || '未知原因')
        }
      }

      /** Try the next candidate URL for the current picture. */
      function attempt() {
        if (image === null) return
        const url = candidates[cursor]
        if (url === undefined) {
          failed()
          return
        }
        const token = ++loadToken
        image.style.display = ''
        image.alt = baseName(paths[index] || '')
        image.onload = () => {
          if (token === loadToken) onLoaded()
        }
        image.onerror = () => {
          if (token !== loadToken) return
          // A blob or data source is already one picture in memory: there is
          // nothing left to fetch, so this is a decode failure.
          if (url.startsWith('blob:') === true || url.startsWith('data:') === true) {
            lastError = '取到了字节但解不成图片'
            tried.push('内存字节 → ' + lastError)
            cursor += 1
            attempt()
            return
          }
          // Some image requests die where a plain fetch succeeds: read the bytes
          // ourselves, and keep the HTTP status as the explanation when that fails.
          toBlobUrl(url).then(
            (blobUrl) => {
              if (token !== loadToken) return
              image.onerror = () => {
                if (token !== loadToken) return
                lastError = '取到了字节但解不成图片'
                tried.push(url + ' → ' + lastError)
                cursor += 1
                attempt()
              }
              image.src = blobUrl
            },
            (error) => {
              if (token !== loadToken) return
              lastError = String((error instanceof Error ? error.message : error) || '未知原因')
              console.warn('[image-preview] 图片请求失败：' + url + ' → ' + lastError)
              tried.push(url + ' → ' + lastError)
              cursor += 1
              attempt()
            },
          )
        }
        image.src = url
        lastUrl = url
        // A cached source does not fire `load` again; fit it here instead.
        if (image.complete === true && image.naturalWidth > 0) onLoaded()
      }

      /** Point the viewer at one path of the current list. */
      async function show(at) {
        if (paths.length === 0) return
        const stamp = ++showToken
        index = Math.max(0, Math.min(paths.length - 1, at))
        const file = paths[index]
        message.textContent = ''
        nameLabel.textContent = baseName(file)
        nameLabel.title = file
        metaLabel.textContent = paths.length > 1 ? index + 1 + ' / ' + paths.length : ''
        prevButton.disabled = index <= 0
        nextButton.disabled = index >= paths.length - 1
        natural = { width: 0, height: 0 }
        // The box was drawn on the previous picture: it means nothing here.
        selection = null
        inkDrag = null
        closeCompare()
        inkPaint()
        scale = 1
        offsetX = 0
        offsetY = 0
        paint()
        candidates = []
        cursor = 0
        lastError = ''
        lastUrl = ''
        tried = []
        postFailure = ''
        const sources = await sourcesFor(file, bust)
        if (stamp !== showToken) return
        postFailure = sources.postError
        candidates = sources.list
        if (candidates.length === 0) {
          image.style.display = 'none'
          message.textContent = '这个路径不能直接预览：' + file
          return
        }
        attempt()
      }

      /**
       * Copy the picture on screen to the clipboard as PNG.
       *
       * The bytes come from the host route (same origin, so the canvas is not
       * tainted); JPEG/WebP sources are re-encoded through a canvas because the
       * clipboard's image item only accepts PNG here.
       */
      async function copyImage() {
        const file = paths[index]
        if (file === undefined || image === null) return
        try {
          const width = image.naturalWidth || natural.width
          const height = image.naturalHeight || natural.height
          if (!(width > 0 && height > 0)) throw new Error('图片还没加载完')
          const canvas = document.createElement('canvas')
          canvas.width = width
          canvas.height = height
          const context = canvas.getContext('2d')
          if (context === null) throw new Error('画布不可用')
          context.drawImage(image, 0, 0, width, height)
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
          if (blob === null) throw new Error('转成 PNG 失败')
          const clipboard = navigator.clipboard
          if (clipboard === undefined || typeof clipboard.write !== 'function') throw new Error('这个环境不支持写图片到剪贴板')
          await clipboard.write([new ClipboardItem({ 'image/png': blob })])
          flash('已复制 ' + width + ' × ' + height + ' 的 PNG 到剪贴板')
        } catch (error) {
          const reason = String((error instanceof Error ? error.message : error) || '未知原因')
          let copiedPath = false
          try {
            if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
              await navigator.clipboard.writeText(file)
              copiedPath = true
            }
          } catch {
            /* the path fallback is best effort */
          }
          flash(copiedPath ? '没能复制图片（' + reason + '），已改为复制路径' : '复制失败：' + reason)
        }
      }

      /** Show one line of feedback over the picture for a moment. */
      function flash(line) {
        if (message === null) return
        message.textContent = line
        setTimeout(() => {
          if (message !== null && message.textContent === line) message.textContent = ''
        }, 2200)
      }

      /** Open one image, with the sibling images of its message for ←/→. */
      function open(list, at) {
        ensure()
        paths = unique(list)
        if (paths.length === 0) return
        bust = 0
        natural = { width: 0, height: 0 }
        // Preferences are per machine and per open: the annotator starts from them.
        setStrokeColor(COLORS.includes(prefs.color) ? prefs.color : COLORS[0])
        setStrokeWidth(WIDTHS.includes(prefs.width) ? prefs.width : WIDTHS[1])
        // A fresh open never inherits a box or annotations from the last one.
        resetInk()
        setSelecting(false)
        setInking(false)
        closeCompare()
        if (compareButton !== null) compareButton.disabled = paths.length < 2
        if (resizeHandler === null) {
          resizeHandler = () => {
          markStageDirty()
          paint()
        }
          window.addEventListener('resize', resizeHandler)
        }
        if (!root.isConnected) document.body.appendChild(root)
        // Remember where the keyboard came from, and never stack two hooks on one
        // overlay (a second open would make every arrow key step twice).
        if (keyHandler !== null) {
          document.removeEventListener('keydown', keyHandler, true)
        } else {
          returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
        }
        root.style.display = 'flex'
        markStageDirty()
        keyHandler = (event) => {
          // Only keys that land in the overlay are ours. Once a picture has been
          // pasted the focus is in the composer, and Enter there must send.
          // A key with no focused element arrives on `document`/`body`: while the
          // modal is up those still belong to it, or Escape would trap the reader.
          const target = event.target
          const inside = root !== null
            && (target === document || target === document.body || root.contains(target) === true)
          if (inside !== true) return
          const accel = event.ctrlKey === true || event.metaKey === true
          // Typing a callout: the editor owns every key except Escape.
          if (textEditor !== null) {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              cancelTextEditor()
            }
            return
          }
          // The "throw away marks?" question owns the keyboard while it is up:
          // Escape means discard, exactly like the button that says so.
          if (dirtyDialog !== null) {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              const drop = dirtyDialog.querySelector('[data-drop="1"]')
              if (drop !== null) drop.click()
            }
            return
          }
          if (accel === false && (event.key === 'a' || event.key === 'A')) {
            event.preventDefault()
            event.stopPropagation()
            toggleInking()
            return
          }
          // The comparison overlay is a layer inside the viewer: Escape leaves it
          // before it can close the viewer, and D flips between side-by-side and diff.
          if (comparing === true) {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              closeCompare()
              return
            }
            if (accel === false && (event.key === 'd' || event.key === 'D')) {
              event.preventDefault()
              event.stopPropagation()
              setCompareMode(compareMode === 'diff' ? 'side' : 'diff')
              return
            }
          }
          if (accel === false && (event.key === 'd' || event.key === 'D') && inking !== true) {
            event.preventDefault()
            event.stopPropagation()
            toggleCompare()
            return
          }
          if (inking === true) {
            const key = event.key.toLowerCase()
            if (accel === true && key === 'z') {
              event.preventDefault()
              event.stopPropagation()
              if (event.shiftKey === true) redo()
              else undo()
              return
            }
            if (accel === true && key === 'y') {
              event.preventDefault()
              event.stopPropagation()
              redo()
              return
            }
            if (accel === true && key === 's') {
              event.preventDefault()
              event.stopPropagation()
              saveAnnotated().catch(() => {})
              return
            }
            if (accel === true && key === 'c') {
              event.preventDefault()
              event.stopPropagation()
              copyAnnotated().catch(() => {})
              return
            }
            if (event.key === 'Delete' || event.key === 'Backspace') {
              event.preventDefault()
              event.stopPropagation()
              deleteActive()
              return
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              event.stopPropagation()
              sendAnnotated().catch(() => {})
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              setInking(false)
              return
            }
            if (accel === false && TOOL_KEYS[key] !== undefined) {
              event.preventDefault()
              event.stopPropagation()
              setTool(TOOL_KEYS[key])
              return
            }
          }
          if (accel === true && (event.key === 'c' || event.key === 'C')) {
            event.preventDefault()
            event.stopPropagation()
            if (selecting === true && selection !== null) copySelection().catch(() => {})
            else copyImage().catch(() => {})
            return
          }
          if (accel === false && (event.key === 's' || event.key === 'S')) {
            event.preventDefault()
            event.stopPropagation()
            toggleSelecting()
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            if (selection !== null) setSelecting(false)
            else close()
            return
          }
          if (event.key === 'Enter' && selecting === true) {
            event.preventDefault()
            event.stopPropagation()
            sendSelection().catch(() => {})
            return
          }
          if (event.key === 'ArrowLeft' && index > 0) {
            event.preventDefault()
            event.stopPropagation()
            pageTo(index - 1)
            return
          }
          if (event.key === 'ArrowRight' && index < paths.length - 1) {
            event.preventDefault()
            event.stopPropagation()
            show(index + 1)
            return
          }
          if (event.key === '0' || event.key === 'f') {
            event.preventDefault()
            event.stopPropagation()
            fit()
            return
          }
          if (event.key === '1') {
            event.preventDefault()
            event.stopPropagation()
            actual()
            return
          }
          if (event.key === '+' || event.key === '=') {
            event.preventDefault()
            event.stopPropagation()
            zoomAt(1.25, stage.getBoundingClientRect().width / 2, stage.getBoundingClientRect().height / 2)
            return
          }
          if (event.key === '-') {
            event.preventDefault()
            event.stopPropagation()
            zoomAt(0.8, stage.getBoundingClientRect().width / 2, stage.getBoundingClientRect().height / 2)
          }
        }
        document.addEventListener('keydown', keyHandler, true)
        root.focus()
        show(at)
      }

      /**
       * Close the overlay, drop the keyboard hook and give the focus back.
       * @param {boolean} [restoreFocus] - false when the composer just took the focus and must keep it.
       * @param {boolean} [force] - true to close even with unexported marks (after the question is answered).
       */
      function close(restoreFocus, force) {
        if (root === null) return
        if (force !== true && isDirty() === true) {
          guardDirty(() => close(restoreFocus, true))
          return
        }
        root.style.display = 'none'
        dismissDirtyDialog()
        closeCompare()
        setSelecting(false)
        setInking(false)
        if (resizeHandler !== null) {
          window.removeEventListener('resize', resizeHandler)
          resizeHandler = null
        }
        if (keyHandler !== null) {
          document.removeEventListener('keydown', keyHandler, true)
          keyHandler = null
        }
        if (image !== null) {
          image.onerror = null
          image.onload = null
          image.removeAttribute('src')
        }
        // A paste just moved the focus to the composer; pulling it back to the
        // thumbnail would take the caret away from the text that was sent with it.
        if (restoreFocus === false) {
          returnFocus = null
          return
        }
        // The overlay took the focus; a keyboard reader must land back on the
        // thumbnail they opened it from, not at the top of the document.
        const target = returnFocus
        returnFocus = null
        if (target !== null && target.isConnected === true && typeof target.focus === 'function') {
          target.focus({ preventScroll: true })
        }
      }

      /** Zoom around a stage point, keeping the pixel under it in place. */
      function zoomAt(factor, stageX, stageY) {
        if (image === null || natural.width <= 0) return
        const box = stageRect()
        const centerX = box.width / 2
        const centerY = box.height / 2
        const next = clamp(scale * factor)
        if (next === scale) return
        const qx = (stageX - centerX - offsetX) / scale
        const qy = (stageY - centerY - offsetY) / scale
        offsetX = stageX - centerX - next * qx
        offsetY = stageY - centerY - next * qy
        scale = next
        paint()
      }

      /** Show one line under the stage, replacing the standing hint. */
      function setHint(text) {
        if (hintLabel !== null) hintLabel.textContent = text
      }

      /** Say one short line in the toast; it fades after a moment. */
      function announce(text) {
        if (statusLabel === null) return
        statusLabel.textContent = text
        statusLabel.dataset.on = text === '' ? '0' : '1'
        if (statusTimer !== 0) clearTimeout(statusTimer)
        statusTimer = text === '' ? 0 : setTimeout(() => {
          statusTimer = 0
          if (statusLabel !== null) statusLabel.dataset.on = '0'
        }, 2600)
      }

      /** Turn region mode on or off; leaving it drops the box. */
      function setSelecting(next) {
        selecting = next
        if (selecting === true && inking === true) setInking(false)
        if (selecting === false) {
          selection = null
          inkDrag = null
        }
        if (selectButton !== null) selectButton.setAttribute('aria-pressed', selecting ? 'true' : 'false')
        if (inkbar !== null) inkbar.style.display = selecting ? 'flex' : 'none'
        markStageDirty()
        if (stage !== null) stage.dataset.selecting = selecting ? '1' : '0'
        if (ink !== null) ink.style.pointerEvents = (selecting === true || inking === true) ? 'auto' : 'none'
        setHint(selecting ? TEXT.hintSelect : TEXT.hintView)
        inkPaint()
      }

      /** The bar button / the `S` key: enter selection mode, or leave it. */
      function toggleSelecting() {
        setSelecting(selecting === false)
      }

      /** Pick the instruction the next send carries, and say which one is on. */
      function setTemplate(id) {
        if (TEMPLATES.includes(id) !== true) return
        template = id
        for (const element of templateButtons) {
          element.setAttribute('aria-pressed', element.dataset.template === id ? 'true' : 'false')
        }
      }

      /** Map one viewport point onto source-image pixels (may fall outside the picture). */
      function sourceAt(clientX, clientY) {
        const box = stageRect()
        return {
          x: (clientX - box.left - box.width / 2 - offsetX) / scale + natural.width / 2,
          y: (clientY - box.top - box.height / 2 - offsetY) / scale + natural.height / 2,
        }
      }

      /** The four selection corners in source pixels, clockwise from top-left. */
      function selectionCorners(box) {
        return [
          { x: box.x, y: box.y },
          { x: box.x + box.w, y: box.y },
          { x: box.x + box.w, y: box.y + box.h },
          { x: box.x, y: box.y + box.h },
        ]
      }

      /** Which corner handle one source-space point grabs, or -1. */
      function handleAt(point) {
        if (selection === null) return -1
        const tolerance = GRAB_PX / scale
        const corners = selectionCorners(selection)
        for (let at = 0; at < corners.length; at += 1) {
          if (Math.abs(point.x - corners[at].x) <= tolerance && Math.abs(point.y - corners[at].y) <= tolerance) return at
        }
        return -1
      }

      /** Whether one source-space point sits inside the current selection. */
      function insideSelection(point) {
        if (selection === null) return false
        return point.x >= selection.x && point.x <= selection.x + selection.w
          && point.y >= selection.y && point.y <= selection.y + selection.h
      }

      /** The clamped box two source-space corners describe, or null when it is too thin. */
      function boxOf(one, other) {
        const left = Math.max(0, Math.min(one.x, other.x))
        const top = Math.max(0, Math.min(one.y, other.y))
        const right = Math.min(natural.width, Math.max(one.x, other.x))
        const bottom = Math.min(natural.height, Math.max(one.y, other.y))
        if (right - left < MIN_SELECTION || bottom - top < MIN_SELECTION) return null
        return { x: left, y: top, w: right - left, h: bottom - top }
      }

      /** Move one selection by a source-space delta, keeping it inside the picture. */
      function moveBox(box, dx, dy) {
        return {
          x: Math.max(0, Math.min(natural.width - box.w, box.x + dx)),
          y: Math.max(0, Math.min(natural.height - box.h, box.y + dy)),
          w: box.w,
          h: box.h,
        }
      }

      /** Canvas pointerdown: region mode and annotation mode share one layer. */
      function inkDown(event) {
        if (selecting === true) {
          regionDown(event)
          return
        }
        if (inking === true) beginAnnotate(event)
      }

      /** Canvas pointermove for whichever mode owns the layer. */
      function inkMove(event) {
        if (selecting === true) regionMove(event)
        else if (inking === true) moveAnnotate(event)
      }

      /** Canvas pointerup/cancel for whichever mode owns the layer. */
      function inkUp(event) {
        if (selecting === true) regionUp(event)
        else if (inking === true) endAnnotate(event)
      }

      /** Start a region drag: a corner resizes from the opposite corner, the inside moves, anywhere else draws. */
      function regionDown(event) {
        if (selecting !== true) return
        event.preventDefault()
        event.stopPropagation()
        if (image === null || natural.width <= 0) return
        const point = sourceAt(event.clientX, event.clientY)
        const handle = handleAt(point)
        if (handle >= 0 && selection !== null) {
          inkDrag = { mode: 'resize', anchor: selectionCorners(selection)[(handle + 2) % 4] }
        } else if (insideSelection(point)) {
          inkDrag = { mode: 'move', start: point, box: { ...selection } }
        } else {
          inkDrag = { mode: 'new', anchor: point }
        }
        try {
          ink.setPointerCapture(event.pointerId)
        } catch {
          /* the pointer is already gone */
        }
      }

      /** Update the region drag and repaint the layer. */
      function regionMove(event) {
        if (inkDrag === null) return
        event.preventDefault()
        event.stopPropagation()
        const point = sourceAt(event.clientX, event.clientY)
        if (inkDrag.mode === 'move') {
          selection = moveBox(inkDrag.box, point.x - inkDrag.start.x, point.y - inkDrag.start.y)
        } else {
          selection = boxOf(inkDrag.anchor, point)
        }
        schedulePaint()
      }

      /** Finish a region drag, dropping a selection too thin to be meant. */
      function regionUp(event) {
        if (inkDrag === null) return
        event.stopPropagation()
        inkDrag = null
        try {
          ink.releasePointerCapture(event.pointerId)
        } catch {
          /* the pointer is already gone */
        }
        inkPaint()
      }

      // ------------------------------ annotation ------------------------------

      /** Whether the reader has drawn something that has not left the viewer yet. */
      function isDirty() {
        return marks.length > 0 || crop !== null
      }

      /** One undoable state: the mark list and the crop, deep enough to be safe. */
      function snapshot() {
        return {
          marks: marks.map((mark) => ({ ...mark, points: mark.points === undefined ? undefined : [...mark.points] })),
          crop: crop === null ? null : { ...crop },
        }
      }

      /** Put one snapshot back and repaint. */
      function restore(state) {
        marks = state.marks.map((mark) => ({ ...mark, points: mark.points === undefined ? undefined : [...mark.points] }))
        crop = state.crop === null ? null : { ...state.crop }
        if (activeMark >= marks.length) activeMark = marks.length - 1
        inkPaint()
      }

      /** Remember the state before one change; a new change drops the redo branch. */
      function pushUndo(state) {
        undoStack.push(state ?? snapshot())
        if (undoStack.length > UNDO_LIMIT) undoStack.shift()
        redoStack = []
        syncEditButtons()
      }

      /** Step back one change. */
      function undo() {
        if (undoStack.length === 0) return
        redoStack.push(snapshot())
        restore(undoStack.pop())
        syncEditButtons()
      }

      /** Step forward one undone change. */
      function redo() {
        if (redoStack.length === 0) return
        undoStack.push(snapshot())
        restore(redoStack.pop())
        syncEditButtons()
      }

      /** Grey out undo/redo when there is nothing to do. */
      function syncEditButtons() {
        if (undoButton !== null) undoButton.disabled = undoStack.length === 0
        if (redoButton !== null) redoButton.disabled = redoStack.length === 0
      }

      /** Delete the selected mark. */
      function deleteActive() {
        if (activeMark < 0 || activeMark >= marks.length) return
        pushUndo()
        marks.splice(activeMark, 1)
        activeMark = -1
        inkPaint()
      }

      /** Drop every mark and the crop, in one undoable step. */
      function clearMarks() {
        if (marks.length === 0 && crop === null) return
        pushUndo()
        marks = []
        crop = null
        activeMark = -1
        inkPaint()
      }

      /** Pick the tool; `select` moves things, `crop` draws the export region. */
      function setTool(id) {
        if (TOOLS.includes(id) !== true) return
        tool = id
        if (id !== 'crop') cancelTextEditor()
        for (const element of toolButtons) {
          element.setAttribute('aria-pressed', element.dataset.tool === id ? 'true' : 'false')
        }
        if (stage !== null) stage.dataset.tool = id
        inkPaint()
      }

      /** Pick the stroke colour. */
      function setStrokeColor(value) {
        if (COLORS.includes(value) !== true) return
        strokeColor = value
        for (const element of colorButtons) {
          element.setAttribute('aria-pressed', element.dataset.color === value ? 'true' : 'false')
        }
        if (textEditor !== null) textEditor.style.color = value
      }

      /** Pick the stroke width (which also sets the text size). */
      function setStrokeWidth(value) {
        if (WIDTHS.includes(value) !== true) return
        strokeWidth = value
        for (const element of widthButtons) {
          element.setAttribute('aria-pressed', String(element.dataset.width) === String(value) ? 'true' : 'false')
        }
      }

      /** The style a new mark takes. */
      function markStyle() {
        return { color: strokeColor, width: strokeWidth }
      }

      /** Axis-aligned bounds of one mark, in source pixels. */
      function markBounds(mark) {
        if (mark.type === 'pen') {
          const points = mark.points ?? []
          if (points.length < 2) return null
          let left = points[0]
          let top = points[1]
          let right = left
          let bottom = top
          for (let at = 2; at + 1 < points.length; at += 2) {
            left = Math.min(left, points[at])
            right = Math.max(right, points[at])
            top = Math.min(top, points[at + 1])
            bottom = Math.max(bottom, points[at + 1])
          }
          return { x0: left, y0: top, x1: right, y1: bottom }
        }
        if (mark.type === 'text') {
          const size = mark.size ?? TEXT_SIZES[1]
          return { x0: mark.x0, y0: mark.y0, x1: mark.x0 + size * Math.max(1, String(mark.text ?? '').length) * 0.62, y1: mark.y0 + size * 1.3 }
        }
        return { x0: Math.min(mark.x0, mark.x1), y0: Math.min(mark.y0, mark.y1), x1: Math.max(mark.x0, mark.x1), y1: Math.max(mark.y0, mark.y1) }
      }

      /** Distance from one point to a segment, used by the pen/arrow hit test. */
      function segmentDistance(point, ax, ay, bx, by) {
        const dx = bx - ax
        const dy = by - ay
        const length = dx * dx + dy * dy
        const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - ax) * dx + (point.y - ay) * dy) / length))
        const px = ax + t * dx - point.x
        const py = ay + t * dy - point.y
        return Math.sqrt(px * px + py * py)
      }

      /** Whether one source-space point hits a mark, within `tol` source pixels. */
      function hitsMark(mark, point, tol) {
        if (mark.type === 'pen') {
          const points = mark.points ?? []
          for (let at = 0; at + 3 < points.length; at += 2) {
            if (segmentDistance(point, points[at], points[at + 1], points[at + 2], points[at + 3]) <= tol) return true
          }
          return false
        }
        if (mark.type === 'arrow') return segmentDistance(point, mark.x0, mark.y0, mark.x1, mark.y1) <= tol
        const box = markBounds(mark)
        if (box === null) return false
        return point.x >= box.x0 - tol && point.x <= box.x1 + tol && point.y >= box.y0 - tol && point.y <= box.y1 + tol
      }

      /** The topmost mark under one point, or -1. */
      function hitMarkAt(point) {
        const tol = GRAB_PX / scale
        for (let at = marks.length - 1; at >= 0; at -= 1) {
          if (hitsMark(marks[at], point, tol)) return at
        }
        return -1
      }

      /** Start a draw/move gesture in annotation mode. */
      function beginAnnotate(event) {
        if (inking !== true || image === null || natural.width <= 0) return
        event.preventDefault()
        event.stopPropagation()
        const point = sourceAt(event.clientX, event.clientY)
        if (tool === 'text') {
          openTextEditor(point)
          return
        }
        inkStart = { point, before: snapshot() }
        if (tool === 'select') {
          const hit = hitMarkAt(point)
          if (hit >= 0) {
            activeMark = hit
            const mark = marks[hit]
            inkDrag = {
              mode: 'mark',
              index: hit,
              start: point,
              x0: mark.x0,
              y0: mark.y0,
              x1: mark.x1,
              y1: mark.y1,
              points: mark.type === 'pen' ? [...(mark.points ?? [])] : undefined,
            }
            inkPaint()
            return
          }
          const handle = handleAt(point)
          if (handle >= 0 && crop !== null) {
            inkDrag = { mode: 'crop-resize', anchor: selectionCorners(crop)[(handle + 2) % 4] }
            return
          }
          if (crop !== null && insideSelection(point)) {
            inkDrag = { mode: 'crop-move', start: point, box: { ...crop } }
            return
          }
          activeMark = -1
          inkPaint()
          return
        }
        if (tool === 'crop') {
          inkDrag = { mode: 'crop-new', anchor: point }
          return
        }
        // A shape: rect/ellipse/arrow keep two corners, pen keeps a flat point list.
        draft = tool === 'pen'
          ? { type: 'pen', ...markStyle(), points: [point.x, point.y] }
          : { type: tool, ...markStyle(), x0: point.x, y0: point.y, x1: point.x, y1: point.y }
        inkDrag = { mode: 'draft' }
      }

      /** Extend the gesture in flight. */
      function moveAnnotate(event) {
        if (inkDrag === null) return
        event.preventDefault()
        event.stopPropagation()
        const point = sourceAt(event.clientX, event.clientY)
        if (inkDrag.mode === 'draft') {
          if (draft === null) return
          if (draft.type === 'pen') {
            const points = draft.points
            const lastX = points[points.length - 2]
            const lastY = points[points.length - 1]
            if (Math.hypot(point.x - lastX, point.y - lastY) >= 2 && points.length < MAX_PEN_POINTS * 2) {
              points.push(point.x, point.y)
            }
          } else {
            draft.x1 = point.x
            draft.y1 = point.y
          }
        } else if (inkDrag.mode === 'mark') {
          const mark = marks[inkDrag.index]
          if (mark === undefined) return
          const dx = point.x - inkDrag.start.x
          const dy = point.y - inkDrag.start.y
          if (mark.type === 'pen') {
            const from = inkDrag.points ?? []
            for (let at = 0; at + 1 < from.length; at += 2) {
              mark.points[at] = from[at] + dx
              mark.points[at + 1] = from[at + 1] + dy
            }
          } else if (mark.type === 'text') {
            mark.x0 = inkDrag.x0 + dx
            mark.y0 = inkDrag.y0 + dy
          } else {
            mark.x0 = inkDrag.x0 + dx
            mark.y0 = inkDrag.y0 + dy
            mark.x1 = inkDrag.x1 + dx
            mark.y1 = inkDrag.y1 + dy
          }
        } else if (inkDrag.mode === 'crop-new' || inkDrag.mode === 'crop-resize') {
          crop = boxOf(inkDrag.anchor, point)
        } else if (inkDrag.mode === 'crop-move') {
          crop = moveBox(inkDrag.box, point.x - inkDrag.start.x, point.y - inkDrag.start.y)
        }
        schedulePaint()
      }

      /** A click without a drag is not a mark: require a visible size. */
      function markIsMeaningful(mark) {
        if (mark.type === 'pen') return (mark.points === undefined ? 0 : mark.points.length) >= 4
        if (mark.type === 'text') return String(mark.text ?? '').trim() !== ''
        return Math.abs(mark.x1 - mark.x0) >= 2 || Math.abs(mark.y1 - mark.y0) >= 2
      }

      /** Finish the gesture: commit a shape, keep a real move, or drop a slip. */
      function endAnnotate(event) {
        if (inkDrag === null) return
        event.stopPropagation()
        const before = inkStart === null ? null : inkStart.before
        const mode = inkDrag.mode
        inkDrag = null
        inkStart = null
        try {
          ink.releasePointerCapture(event.pointerId)
        } catch {
          /* the pointer is already gone */
        }
        if (mode === 'draft') {
          const done = draft
          draft = null
          if (done !== null && markIsMeaningful(done) === true) {
            pushUndo(before)
            if (marks.length < MAX_MARKS) marks.push(done)
            activeMark = marks.length - 1
          }
        } else if (mode !== 'crop-new' && mode !== 'crop-resize' && mode !== 'crop-move' && mode !== 'mark') {
          /* nothing to commit */
        } else if (before !== null) {
          pushUndo(before)
        }
        schedulePaint()
      }

      /** Paint the crop dim, the marks, the stroke in flight and the selection frame. */
      function inkPaint() {
        if (ink === null || image === null || natural.width <= 0) return
        const context = ink.getContext('2d')
        if (context === null) return
        const box = stageRect()
        const dpr = window.devicePixelRatio || 1
        const width = Math.max(1, Math.round(box.width * dpr))
        const height = Math.max(1, Math.round(box.height * dpr))
        // Reallocate only when the viewport changed: assigning width/height every
        // frame would clear the canvas and churn memory on every pointer move.
        if (ink.width !== width || ink.height !== height) {
          ink.width = width
          ink.height = height
        }
        context.setTransform(1, 0, 0, 1, 0, 0)
        context.clearRect(0, 0, ink.width, ink.height)
        const hasSelection = selecting === true && selection !== null
        const hasInk = marks.length > 0 || crop !== null || draft !== null || activeMark >= 0
        if (hasSelection === false && hasInk === false) {
          ink.setAttribute('aria-label', '')
          return
        }
        const k = dpr * scale
        context.setTransform(
          k,
          0,
          0,
          k,
          dpr * (box.width / 2 + offsetX - (natural.width / 2) * scale),
          dpr * (box.height / 2 + offsetY - (natural.height / 2) * scale),
        )
        if (hasSelection) drawSelection(context, selection, natural, scale)
        if (hasInk) {
          if (crop !== null) paintCrop(context, crop, natural, scale)
          drawMarks(context, marks, draft)
          if (activeMark >= 0 && marks[activeMark] !== undefined) drawMarkFrame(context, marks[activeMark], scale)
        }
        ink.setAttribute('aria-label', hasSelection
          ? '选区 ' + Math.round(selection.x) + ',' + Math.round(selection.y)
            + ' ' + Math.round(selection.w) + '×' + Math.round(selection.h) + '（源图像素）'
          : '标注 ' + marks.length + ' 个' + (crop === null ? '' : '，已裁剪'))
      }

      /** Outline the selected mark, so Delete has something to point at. */
      function drawMarkFrame(context, mark, zoom) {
        const frame = markBounds(mark)
        if (frame === null) return
        const k = zoom > 0 ? zoom : 1
        context.save()
        context.strokeStyle = '#5ab0ff'
        context.lineWidth = 1.5 / k
        context.setLineDash([5 / k, 4 / k])
        context.strokeRect(frame.x0 - 4 / k, frame.y0 - 4 / k, frame.x1 - frame.x0 + 8 / k, frame.y1 - frame.y0 + 8 / k)
        context.restore()
      }

      /** Paint the dimmed surround, the dashed edge and the four corner handles. */
      function drawSelection(context, box, naturalSize, zoom) {
        const k = zoom > 0 ? zoom : 1
        context.save()
        context.fillStyle = 'rgba(0, 0, 0, 0.55)'
        context.fillRect(0, 0, naturalSize.width, box.y)
        context.fillRect(0, box.y + box.h, naturalSize.width, Math.max(0, naturalSize.height - box.y - box.h))
        context.fillRect(0, box.y, box.x, box.h)
        context.fillRect(box.x + box.w, box.y, Math.max(0, naturalSize.width - box.x - box.w), box.h)
        context.strokeStyle = '#ffffff'
        context.lineWidth = 1.5 / k
        context.setLineDash([7 / k, 5 / k])
        context.strokeRect(box.x, box.y, box.w, box.h)
        context.setLineDash([])
        const size = 8 / k
        for (const corner of selectionCorners(box)) {
          context.fillStyle = '#ffffff'
          context.fillRect(corner.x - size / 2, corner.y - size / 2, size, size)
          context.strokeStyle = 'rgba(0, 0, 0, 0.55)'
          context.lineWidth = 1 / k
          context.strokeRect(corner.x - size / 2, corner.y - size / 2, size, size)
        }
        context.restore()
      }

      /** Move to another picture, asking first when a drawn state would be lost. */
      function pageTo(at) {
        if (at < 0 || at >= paths.length) return
        if (selecting === true && selection !== null) {
          announce(TEXT.pageFirst)
          return
        }
        if (isDirty() === true) {
          guardDirty(() => {
            resetInk()
            show(at)
          })
          return
        }
        show(at)
      }

      /** Cut the current selection out as a PNG. */
      function exportSelection() {
        if (selection === null) return Promise.reject(new Error(TEXT.failed))
        if (selection.w * selection.h > MAX_EXPORT_PIXELS) return Promise.reject(new Error(TEXT.tooBig))
        return exportPng(image, selection)
      }

      /** The instruction that travels with the next picture. */
      function instructionText() {
        const lines = [TEXT.instructions[template] ?? TEXT.instructions.describe]
        const file = paths[index] ?? ''
        // The region an export keeps: the annotator's crop, else the quick selection.
        const box = crop ?? (selecting === true ? selection : null)
        if (prefs.provenance !== false && file !== '' && box !== null) {
          lines.push(TEXT.source
            .replace('{path}', file)
            .replace('{x}', String(Math.round(box.x)))
            .replace('{y}', String(Math.round(box.y)))
            .replace('{w}', String(Math.round(box.w)))
            .replace('{h}', String(Math.round(box.h))))
        }
        return lines.join('\n')
      }

      /** Submit the draft when the reader asked for one-paste-and-send. */
      function maybeAutoSend(editor) {
        if (prefs.autoSend !== true) return
        try {
          editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        } catch {
          /* the composer owns its keys; a miss is not a viewer failure */
        }
      }

      /** Main exit: cut the selection, hand it to the composer, and get out of the way. */
      async function sendSelection() {
        if (selection === null) return
        try {
          const blob = await exportSelection()
          const name = fileStamp(Date.now())
          const before = attachmentCount()
          const editor = findComposer(root)
          if (editor === null) {
            await copyToClipboard(blob)
            announce(TEXT.fallback)
            return
          }
          const claimed = pasteImageWithText(editor, blob, name, instructionText())
          // The event being cancelled only says someone handled it; the tile shows
          // whether the intake actually took the file.
          await new Promise((resolve) => setTimeout(resolve, 320))
          if (claimed === true && attachmentLanded(name, before) === true) {
            announce(TEXT.sent)
            maybeAutoSend(editor)
            if (prefs.closeAfterSend !== false) close(false)
            return
          }
          await copyToClipboard(blob)
          announce(TEXT.fallback)
        } catch (error) {
          announce(String((error instanceof Error ? error.message : error) || TEXT.failed))
        }
      }

      /** Second exit: the same bytes to the clipboard. */
      async function copySelection() {
        if (selection === null) return
        try {
          await copyToClipboard(await exportSelection())
          announce(TEXT.copied)
        } catch (error) {
          announce(String((error instanceof Error ? error.message : error) || TEXT.failed))
        }
      }

      // --------------------------- annotation exits ---------------------------

      /** Start or stop annotating; the two region modes are exclusive. */
      function setInking(next) {
        inking = next
        if (inking === true) {
          setSelecting(false)
        } else {
          cancelTextEditor()
        }
        if (annotateButton !== null) annotateButton.setAttribute('aria-pressed', inking ? 'true' : 'false')
        if (inkbarAnnotate !== null) inkbarAnnotate.style.display = inking ? 'flex' : 'none'
        markStageDirty()
        if (stage !== null) stage.dataset.inking = inking ? '1' : '0'
        if (ink !== null) ink.style.pointerEvents = (inking === true || selecting === true) ? 'auto' : 'none'
        if (inking === true && stage !== null) stage.dataset.tool = tool
        setHint(inking ? TEXT.hintInk : TEXT.hintView)
        inkPaint()
      }

      /** The bar button / the `A` key. */
      function toggleInking() {
        setInking(inking === false)
      }

      /** The screen position of one source point, relative to the stage. */
      function stagePointOf(point) {
        const box = stage.getBoundingClientRect()
        return {
          x: box.width / 2 + offsetX + (point.x - natural.width / 2) * scale,
          y: box.height / 2 + offsetY + (point.y - natural.height / 2) * scale,
        }
      }

      /** Put the text editor on the picture at one source point. */
      function openTextEditor(point) {
        cancelTextEditor()
        if (textEditorOrigin !== null) return
        const editor = document.createElement('div')
        editor.className = 'dsh-ipv-textedit'
        editor.contentEditable = 'true'
        editor.setAttribute('role', 'textbox')
        editor.setAttribute('aria-label', TEXT.textPlaceholder)
        editor.dataset.placeholder = TEXT.textPlaceholder
        editor.style.color = strokeColor
        const spot = stagePointOf(point)
        editor.style.left = spot.x + 'px'
        editor.style.top = spot.y + 'px'
        stage.append(editor)
        textEditor = editor
        textEditorOrigin = point
        editor.addEventListener('keydown', (event) => {
          event.stopPropagation()
          // An IME owns Enter and Escape while it is composing.
          if (event.isComposing === true || event.keyCode === 229) return
          if (event.key === 'Escape') {
            event.preventDefault()
            cancelTextEditor()
            return
          }
          if (event.key === 'Enter' && event.shiftKey === false) {
            event.preventDefault()
            commitTextEditor()
          }
        })
        editor.addEventListener('blur', () => {
          if (textEditor === editor) commitTextEditor()
        })
        editor.focus()
      }

      /** Commit the text being typed into a mark. */
      function commitTextEditor() {
        const editor = textEditor
        if (editor === null) return
        const text = String(editor.textContent ?? '').trim()
        const at = textEditorOrigin
        textEditor = null
        textEditorOrigin = null
        editor.remove()
        if (at === null || text === '') {
          inkPaint()
          return
        }
        const size = TEXT_SIZES[Math.max(0, WIDTHS.indexOf(strokeWidth))] ?? TEXT_SIZES[1]
        pushUndo()
        if (marks.length < MAX_MARKS) {
          marks.push({ type: 'text', color: strokeColor, width: strokeWidth, x0: at.x, y0: at.y, size, text })
          activeMark = marks.length - 1
        }
        inkPaint()
      }

      /** Throw the half-typed text away. */
      function cancelTextEditor() {
        if (textEditor === null) return
        const editor = textEditor
        textEditor = null
        textEditorOrigin = null
        editor.remove()
        inkPaint()
      }

      /** Cut the annotated picture out (crop + marks). */
      function exportAnnotated() {
        const area = crop === null ? natural.width * natural.height : crop.w * crop.h
        if (area > MAX_EXPORT_PIXELS) return Promise.reject(new Error(TEXT.tooBig))
        return exportPng(image, crop, marks, { type: prefs.format, quality: prefs.quality })
      }

      /** Send the annotated picture with the chosen instruction. */
      async function sendAnnotated() {
        if (isDirty() === false) {
          announce(TEXT.nothingToSend)
          return
        }
        try {
          const blob = await exportAnnotated()
          const name = fileStamp(Date.now(), prefs.format === 'jpeg' ? '.jpg' : '.png')
          const before = attachmentCount()
          const editor = findComposer(root)
          if (editor === null) {
            await copyToClipboard(blob)
            announce(TEXT.fallback)
            return
          }
          const claimed = pasteImageWithText(editor, blob, name, instructionText())
          await new Promise((resolve) => setTimeout(resolve, 320))
          if (claimed === true && attachmentLanded(name, before) === true) {
            announce(TEXT.sent)
            maybeAutoSend(editor)
            resetInk()
            if (prefs.closeAfterSend !== false) close(false)
            return
          }
          await copyToClipboard(blob)
          announce(TEXT.fallback)
        } catch (error) {
          announce(String((error instanceof Error ? error.message : error) || TEXT.failed))
        }
      }

      /** The annotated picture to the clipboard. */
      async function copyAnnotated() {
        if (isDirty() === false) {
          announce(TEXT.nothingToSend)
          return
        }
        try {
          await copyToClipboard(await exportAnnotated())
          announce(TEXT.copied)
        } catch (error) {
          announce(String((error instanceof Error ? error.message : error) || TEXT.failed))
        }
      }

      /** Ask the host to write the PNG to its temp directory and say where. */
      /** Write one picture through the host's write route and say where it landed. */
      async function saveBlob(blob) {
        const response = await fetch(new URL('image-preview/save', document.baseURI).href, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': blob.type === '' ? 'image/png' : blob.type },
          body: blob,
        })
        const report = await response.json().catch(() => null)
        if (response.ok !== true || report === null || typeof report.path !== 'string') {
          const reason = report !== null && typeof report.error === 'string' ? report.error : 'HTTP ' + response.status
          throw new Error(reason)
        }
        announce(TEXT.saved.replace('{path}', report.path))
      }

      async function saveAnnotated() {
        if (isDirty() === false) {
          announce(TEXT.nothingToSend)
          return
        }
        try {
          await saveBlob(await exportAnnotated())
        } catch (error) {
          announce(TEXT.saveFailed.replace('{reason}', String((error instanceof Error ? error.message : error) || '?')))
        }
      }

      /** Drop the drawn state after it left the viewer. */
      function resetInk() {
        marks = []
        crop = null
        activeMark = -1
        draft = null
        inkDrag = null
        undoStack = []
        redoStack = []
        cancelTextEditor()
        syncEditButtons()
        inkPaint()
      }

      /** Run one action, asking first when marks would be lost. */
      function guardDirty(action) {
        if (isDirty() === false) {
          action()
          return
        }
        openDirtyDialog(action)
      }

      /** The "continue / copy / discard" question before marks are thrown away. */
      function openDirtyDialog(action) {
        if (dirtyDialog !== null) return
        const layer = document.createElement('div')
        layer.className = 'dsh-ipv-dirty'
        layer.setAttribute('role', 'dialog')
        layer.setAttribute('aria-modal', 'true')
        layer.setAttribute('aria-label', TEXT.dirtyTitle)
        const card = document.createElement('div')
        card.className = 'dsh-ipv-dirty-card'
        const title = document.createElement('div')
        title.className = 'dsh-ipv-dirty-title'
        title.textContent = TEXT.dirtyTitle
        const row = document.createElement('div')
        row.className = 'dsh-ipv-dirty-row'
        const closeWith = (then) => {
          if (dirtyDialog === null) return
          dirtyDialog.remove()
          dirtyDialog = null
          if (typeof then === 'function') then()
        }
        const make = (label, onClick, primary) => {
          const element = document.createElement('button')
          element.type = 'button'
          element.className = 'dsh-ipv-inkbtn' + (primary === true ? ' dsh-ipv-inkbtn-primary' : '')
          element.textContent = label
          element.setAttribute('aria-label', label)
          element.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            onClick()
          })
          return element
        }
        const keep = make(TEXT.dirtyKeep, () => closeWith())
        const copy = make(TEXT.dirtyCopy, () => {
          copyAnnotated().then(() => {
            marks = []
            crop = null
            syncEditButtons()
            closeWith(action)
          }).catch(() => {})
        })
        const drop = make(TEXT.dirtyDrop, () => {
          marks = []
          crop = null
          syncEditButtons()
          closeWith(action)
        })
        drop.dataset.drop = '1'
        row.append(keep, copy, drop)
        card.append(title, row)
        layer.append(card)
        ;(root ?? document.body).append(layer)
        dirtyDialog = layer
        keep.focus()
      }

      /** Close the question without acting (Escape). */
      function dismissDirtyDialog() {
        if (dirtyDialog === null) return
        dirtyDialog.remove()
        dirtyDialog = null
      }

      // ------------------------------ comparison ------------------------------

      /** Open or close the A/B comparison overlay. */
      function toggleCompare() {
        if (comparing === true) closeCompare()
        else openCompare()
      }

      /** Build the comparison overlay for this picture set. */
      function openCompare() {
        if (paths.length < 2) {
          announce(TEXT.compareOnlyOne)
          return
        }
        if (compareEl !== null) return
        comparing = true
        compareA = index
        compareB = index + 1 < paths.length ? index + 1 : index - 1
        compareMode = prefs.compareMode === 'overlay' || prefs.compareMode === 'diff' ? prefs.compareMode : 'side'
        compareChanged = 0
        compareEl = document.createElement('div')
        compareEl.className = 'dsh-ipv-compare'
        const bar = document.createElement('div')
        bar.className = 'dsh-ipv-compare-bar'
        compareTitleEl = document.createElement('span')
        compareTitleEl.className = 'dsh-ipv-compare-name'
        comparePickerEl = document.createElement('select')
        comparePickerEl.className = 'dsh-ipv-compare-select'
        comparePickerEl.setAttribute('aria-label', TEXT.compareTitle)
        comparePickerEl.addEventListener('change', () => {
          compareB = Number(comparePickerEl.value)
          loadCompare()
        })
        const button = (label, onClick) => {
          const element = document.createElement('button')
          element.type = 'button'
          element.className = 'dsh-ipv-inkbtn'
          element.textContent = label
          element.setAttribute('aria-label', label)
          element.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            onClick()
          })
          return element
        }
        bar.append(
          compareTitleEl,
          comparePickerEl,
          button(TEXT.compareSide, () => setCompareMode('side')),
          button(TEXT.compareOverlay, () => setCompareMode('overlay')),
          button(TEXT.compareDiff, () => setCompareMode('diff')),
          button(TEXT.compareSwap, swapCompare),
        )
        const diffSendButton = button(TEXT.compareSendDiff, () => {
          sendCompareDiff().catch(() => {})
        })
        const diffSaveButton = button(TEXT.compareSaveDiff, () => {
          saveCompareDiff().catch(() => {})
        })
        diffSendButton.dataset.action = 'send-diff'
        diffSaveButton.dataset.action = 'save-diff'
        diffSendButton.style.display = 'none'
        diffSaveButton.style.display = 'none'
        compareDiffActions = [diffSendButton, diffSaveButton]
        bar.append(diffSendButton, diffSaveButton, button(TEXT.compareClose, closeCompare))
        const body = document.createElement('div')
        body.className = 'dsh-ipv-compare-body'
        const paneOf = () => {
          const pane = document.createElement('div')
          pane.className = 'dsh-ipv-compare-pane'
          body.append(pane)
          return pane
        }
        const paneA = paneOf()
        const paneB = paneOf()
        const paneOverlay = paneOf()
        const paneDiff = paneOf()
        paneOverlay.style.display = 'none'
        paneDiff.style.display = 'none'
        compareImgA = document.createElement('img')
        compareImgB = document.createElement('img')
        compareCanvas = document.createElement('canvas')
        paneA.append(compareImgA)
        paneB.append(compareImgB)
        paneDiff.append(compareCanvas)

        // Overlay: A underneath, B on top clipped from the split rightwards.
        const overlayBox = document.createElement('div')
        overlayBox.className = 'dsh-ipv-compare-overlay'
        compareOverlayA = document.createElement('img')
        compareOverlayB = document.createElement('img')
        compareSplitEl = document.createElement('div')
        compareSplitEl.className = 'dsh-ipv-compare-split'
        compareSplitEl.setAttribute('role', 'separator')
        compareSplitEl.setAttribute('aria-label', 'A/B 分割线')
        overlayBox.append(compareOverlayA, compareOverlayB, compareSplitEl)
        paneOverlay.append(overlayBox)
        comparePanes = { sideA: paneA, sideB: paneB, overlay: paneOverlay, diff: paneDiff }

        /** Move the split to one viewport x. */
        const setSplit = (clientX) => {
          const rect = overlayBox.getBoundingClientRect()
          if (rect.width <= 0) return
          compareSplit = Math.max(0.02, Math.min(0.98, (clientX - rect.left) / rect.width))
          paintCompareSplit()
        }
        overlayBox.addEventListener('pointerdown', (event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.stopPropagation()
          compareSplitDrag = true
          setSplit(event.clientX)
          try {
            overlayBox.setPointerCapture(event.pointerId)
          } catch {
            /* the pointer is already gone */
          }
        })
        overlayBox.addEventListener('pointermove', (event) => {
          if (compareSplitDrag !== true) return
          event.preventDefault()
          setSplit(event.clientX)
        })
        const endSplitDrag = (event) => {
          compareSplitDrag = false
          try {
            overlayBox.releasePointerCapture(event.pointerId)
          } catch {
            /* the pointer is already gone */
          }
        }
        overlayBox.addEventListener('pointerup', endSplitDrag)
        overlayBox.addEventListener('pointercancel', endSplitDrag)

        compareEl.append(bar, body)
        stage.append(compareEl)
        fillComparePicker()
        paintCompareSplit()
        // Start in the mode the preferences ask for (side by default).
        setCompareMode(compareMode)
        loadCompare()
      }

      /** Paint the split line and clip B to the right of it. */
      function paintCompareSplit() {
        if (compareSplitEl === null) return
        const percent = (compareSplit * 100).toFixed(2) + '%'
        compareSplitEl.style.left = percent
        if (compareOverlayB !== null) compareOverlayB.style.clipPath = 'inset(0 0 0 ' + percent + ')'
      }

      /** Refresh the picker and the A label after a swap or a new picture set. */
      function fillComparePicker() {
        if (comparePickerEl === null) return
        while (comparePickerEl.firstChild !== null) comparePickerEl.removeChild(comparePickerEl.firstChild)
        for (let at = 0; at < paths.length; at += 1) {
          if (at === compareA) continue
          const option = document.createElement('option')
          option.value = String(at)
          option.textContent = 'B：' + baseName(paths[at])
          if (at === compareB) option.selected = true
          comparePickerEl.append(option)
        }
        if (compareTitleEl !== null) compareTitleEl.textContent = 'A：' + baseName(paths[compareA] ?? '')
      }

      /** Drop the comparison overlay. */
      function closeCompare() {
        if (compareEl !== null) compareEl.remove()
        compareEl = null
        comparing = false
        compareImgA = null
        compareImgB = null
        compareCanvas = null
        compareTitleEl = null
        comparePickerEl = null
        comparePanes = null
        compareOverlayA = null
        compareOverlayB = null
        compareSplitEl = null
        compareSplitDrag = false
        compareDiffActions = []
        compareDiffReady = false
      }

      /** Swap which picture is A and which is B. */
      function swapCompare() {
        if (compareEl === null) return
        const previous = compareA
        compareA = compareB
        compareB = previous
        fillComparePicker()
        paintCompareSplit()
        setCompareMode(compareMode)
        loadCompare()
      }

      /** Side-by-side, overlay or pixel diff. */
      function setCompareMode(mode) {
        if (mode !== 'side' && mode !== 'overlay' && mode !== 'diff') return
        compareMode = mode
        if (compareEl === null || comparePanes === null) return
        comparePanes.sideA.style.display = mode === 'side' ? 'flex' : 'none'
        comparePanes.sideB.style.display = mode === 'side' ? 'flex' : 'none'
        comparePanes.overlay.style.display = mode === 'overlay' ? 'flex' : 'none'
        comparePanes.diff.style.display = mode === 'diff' ? 'flex' : 'none'
        for (const element of compareDiffActions) element.style.display = mode === 'diff' ? '' : 'none'
        if (mode === 'diff') renderCompareDiff()
        if (mode === 'overlay') paintCompareSplit()
      }

      /** Load both sides from the same candidate chain the viewer uses. */
      async function loadCompare() {
        if (compareImgA === null || compareImgB === null) return
        compareChanged = 0
        compareDiffReady = false
        const nameA = baseName(paths[compareA] ?? '')
        const nameB = baseName(paths[compareB] ?? '')
        compareImgA.alt = nameA
        compareImgB.alt = nameB
        if (compareOverlayA !== null) compareOverlayA.alt = nameA
        if (compareOverlayB !== null) compareOverlayB.alt = nameB
        await assignCompareImage(compareImgA, compareA)
        await assignCompareImage(compareImgB, compareB)
        if (compareOverlayA !== null) await assignCompareImage(compareOverlayA, compareA)
        if (compareOverlayB !== null) await assignCompareImage(compareOverlayB, compareB)
        paintCompareSplit()
        if (compareMode === 'diff') renderCompareDiff()
      }

      /**
       * Point one comparison pane at a path.
       *
       * When the pane wants the picture already on screen, reuse the viewer's own
       * object URL instead of fetching and decoding the same bytes again.
       * @param {HTMLImageElement} target - the pane's image.
       * @param {number} at - the path index.
       * @returns {Promise<void>} resolves once the source is assigned.
       */
      async function assignCompareImage(target, at) {
        if (at === index && image !== null && image.currentSrc !== '') {
          target.removeAttribute('src')
          target.src = image.currentSrc
          return
        }
        await loadInto(target, paths[at] ?? '')
      }

      /** The diff canvas as a PNG blob; null while there is no computed diff. */
      function compareDiffBlob() {
        if (compareDiffReady !== true || compareCanvas === null) return Promise.resolve(null)
        return new Promise((resolve) => {
          compareCanvas.toBlob((blob) => resolve(blob), 'image/png')
        })
      }

      /** Send the diff picture with the current instruction. */
      async function sendCompareDiff() {
        try {
          const blob = await compareDiffBlob()
          if (blob === null) {
            announce(TEXT.compareDiffEmpty)
            return
          }
          const name = fileStamp(Date.now())
          const before = attachmentCount()
          const editor = findComposer(root)
          if (editor === null) {
            await copyToClipboard(blob)
            announce(TEXT.fallback)
            return
          }
          const claimed = pasteImageWithText(editor, blob, name, instructionText())
          await new Promise((resolve) => setTimeout(resolve, 320))
          announce(claimed === true && attachmentLanded(name, before) === true ? TEXT.sent : TEXT.fallback)
        } catch (error) {
          announce(String((error instanceof Error ? error.message : error) || TEXT.failed))
        }
      }

      /** Save the diff picture through the host's write route. */
      async function saveCompareDiff() {
        try {
          const blob = await compareDiffBlob()
          if (blob === null) {
            announce(TEXT.compareDiffEmpty)
            return
          }
          await saveBlob(blob)
        } catch (error) {
          announce(TEXT.saveFailed.replace('{reason}', String((error instanceof Error ? error.message : error) || '?')))
        }
      }

      /** Point one pane's image at a path, trying each candidate URL in turn. */
      async function loadInto(img, file) {
        img.removeAttribute('src')
        if (file === '') return
        let list = []
        try {
          list = (await sourcesFor(file, 0)).list
        } catch {
          list = []
        }
        if (list.length === 0) {
          announce(TEXT.failed)
          return
        }
        let cursor = 0
        img.onerror = () => {
          if (cursor >= list.length) {
            announce(TEXT.failed)
            return
          }
          img.src = list[cursor]
          cursor += 1
        }
        img.onload = () => {
          if (compareMode === 'diff') renderCompareDiff()
        }
        img.onerror()
      }

      /** Red where the two pictures differ by more than the threshold. */
      function renderCompareDiff() {
        if (compareCanvas === null || compareImgA === null || compareImgB === null) return
        if (compareImgA.naturalWidth === 0 || compareImgB.naturalWidth === 0) return
        const width = Math.min(1400, Math.max(1, compareImgA.naturalWidth))
        const height = Math.max(1, Math.round((width / compareImgA.naturalWidth) * compareImgA.naturalHeight))
        const canvasA = document.createElement('canvas')
        canvasA.width = width
        canvasA.height = height
        const canvasB = document.createElement('canvas')
        canvasB.width = width
        canvasB.height = height
        const ctxA = canvasA.getContext('2d')
        const ctxB = canvasB.getContext('2d')
        if (ctxA === null || ctxB === null) return
        ctxA.drawImage(compareImgA, 0, 0, width, height)
        ctxB.drawImage(compareImgB, 0, 0, width, height)
        let dataA
        let dataB
        try {
          dataA = ctxA.getImageData(0, 0, width, height)
          dataB = ctxB.getImageData(0, 0, width, height)
        } catch {
          announce(TEXT.failed)
          return
        }
        compareCanvas.width = width
        compareCanvas.height = height
        const out = compareCanvas.getContext('2d')
        if (out === null) return
        const diff = out.createImageData(width, height)
        let changed = 0
        for (let at = 0; at < dataA.data.length; at += 4) {
          const delta = Math.abs(dataA.data[at] - dataB.data[at])
            + Math.abs(dataA.data[at + 1] - dataB.data[at + 1])
            + Math.abs(dataA.data[at + 2] - dataB.data[at + 2])
          if (delta > 24) {
            changed += 1
            diff.data[at] = 255
            diff.data[at + 1] = 64
            diff.data[at + 2] = 64
            diff.data[at + 3] = 255
          } else {
            diff.data[at] = 26
            diff.data[at + 1] = 28
            diff.data[at + 2] = 32
            diff.data[at + 3] = 255
          }
        }
        out.putImageData(diff, 0, 0)
        compareChanged = changed
        compareDiffReady = true
        compareCanvas.title = '差异像素 ' + changed + ' 个（阈值 24）'
        compareCanvas.setAttribute('aria-label', '差异像素 ' + changed + ' 个')
      }

      // ------------------------------ preferences ------------------------------

      /** Open or close the per-machine preferences panel. */
      function togglePrefs() {
        if (prefsPanel === null) buildPrefsPanel()
        if (prefsPanel === null) return
        prefsPanel.style.display = prefsPanel.style.display === 'flex' ? 'none' : 'flex'
        if (prefsPanel.style.display === 'flex') syncPrefsPanel()
      }

      /** Rebuild every control from the live preferences. */
      function syncPrefsPanel() {
        if (prefsPanel === null) return
        for (const element of prefsPanel.querySelectorAll('[data-pref-color]')) {
          element.setAttribute('aria-pressed', element.dataset.prefColor === prefs.color ? 'true' : 'false')
        }
        for (const element of prefsPanel.querySelectorAll('[data-pref-width]')) {
          element.setAttribute('aria-pressed', String(element.dataset.prefWidth) === String(prefs.width) ? 'true' : 'false')
        }
        for (const element of prefsPanel.querySelectorAll('[data-pref-mode]')) {
          element.setAttribute('aria-pressed', element.dataset.prefMode === prefs.compareMode ? 'true' : 'false')
        }
        for (const element of prefsPanel.querySelectorAll('[data-pref-format]')) {
          element.setAttribute('aria-pressed', String(element.dataset.prefFormat === 'jpeg') === String(prefs.format === 'jpeg') ? 'true' : 'false')
        }
        for (const element of prefsPanel.querySelectorAll('[data-pref-flag]')) {
          element.checked = prefs[element.dataset.prefFlag] === true
        }
      }

      /** Persist and apply one preference change. */
      function setPref(key, value) {
        prefs = { ...prefs, [key]: value }
        savePrefs(prefs)
        if (key === 'color') setStrokeColor(prefs.color)
        if (key === 'width') setStrokeWidth(prefs.width)
        syncPrefsPanel()
      }

      /** Build the panel once, lazily. */
      function buildPrefsPanel() {
        if (root === null) return
        const layer = document.createElement('div')
        layer.className = 'dsh-ipv-prefs'
        layer.setAttribute('role', 'dialog')
        layer.setAttribute('aria-label', TEXT.prefsTitle)
        const card = document.createElement('div')
        card.className = 'dsh-ipv-prefs-card'
        const title = document.createElement('div')
        title.className = 'dsh-ipv-prefs-title'
        title.textContent = TEXT.prefsTitle
        const row = (label, controls) => {
          const line = document.createElement('div')
          line.className = 'dsh-ipv-prefs-row'
          const name = document.createElement('span')
          name.className = 'dsh-ipv-prefs-label'
          name.textContent = label
          const box = document.createElement('span')
          box.className = 'dsh-ipv-prefs-controls'
          box.append(...controls)
          line.append(name, box)
          card.append(line)
          return line
        }
        const chip = (className, label, hint, onClick) => {
          const element = document.createElement('button')
          element.type = 'button'
          element.className = className
          element.textContent = label
          element.title = hint
          element.setAttribute('aria-label', hint)
          element.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            onClick()
          })
          return element
        }
        row(TEXT.prefsColor, COLORS.map((value) => {
          const element = chip('dsh-ipv-swatch', '', value, () => setPref('color', value))
          element.dataset.prefColor = value
          element.style.background = value
          return element
        }))
        row(TEXT.prefsWidth, WIDTHS.map((value) => {
          const element = chip('dsh-ipv-width', String(value), String(value) + ' px', () => setPref('width', value))
          element.dataset.prefWidth = String(value)
          element.style.setProperty('--w', String(value))
          return element
        }))
        row(TEXT.prefsCompare, [['side', TEXT.compareSide], ['overlay', TEXT.compareOverlay], ['diff', TEXT.compareDiff]].map(([id, label]) => {
          const element = chip('dsh-ipv-inkbtn', label, label, () => setPref('compareMode', id))
          element.dataset.prefMode = id
          return element
        }))
        const flagRow = (key, label) => {
          const id = 'dsh-ipv-pref-' + key
          const input = document.createElement('input')
          input.type = 'checkbox'
          input.id = id
          input.dataset.prefFlag = key
          input.addEventListener('change', () => setPref(key, input.checked === true))
          const wrap = document.createElement('label')
          wrap.className = 'dsh-ipv-prefs-check'
          wrap.htmlFor = id
          wrap.append(input, document.createTextNode(label))
          row('', [wrap])
        }
        flagRow('closeAfterSend', TEXT.prefsCloseAfterSend)
        flagRow('provenance', TEXT.prefsProvenance)
        flagRow('autoSend', TEXT.prefsAutoSend)
        row(TEXT.format, [['png', 'PNG'], ['jpeg', 'JPG']].map(([id, label]) => {
          const element = chip('dsh-ipv-inkbtn', label, label, () => setPref('format', id))
          element.dataset.prefFormat = id
          return element
        }))
        const note = document.createElement('div')
        note.className = 'dsh-ipv-prefs-note'
        note.textContent = TEXT.prefsNote
        const footer = document.createElement('div')
        footer.className = 'dsh-ipv-prefs-footer'
        footer.append(
          chip('dsh-ipv-inkbtn', TEXT.prefsReset, TEXT.prefsReset, () => {
            prefs = { ...PREFS_DEFAULTS }
            savePrefs(prefs)
            setStrokeColor(prefs.color)
            setStrokeWidth(prefs.width)
            syncPrefsPanel()
          }),
          chip('dsh-ipv-inkbtn dsh-ipv-inkbtn-primary', TEXT.prefsDone, TEXT.prefsDone, () => {
            if (prefsPanel !== null) prefsPanel.style.display = 'none'
          }),
        )
        card.append(title, note, footer)
        layer.append(card)
        root.append(layer)
        prefsPanel = layer
        syncPrefsPanel()
      }

      /** Create the overlay DOM on first use. */
      function ensure() {
        if (root !== null) return
        // Same reason as the hover float: never leave two viewers in one document.
        for (const stray of document.querySelectorAll('.dsh-ipv-root')) stray.remove()
        root = document.createElement('div')
        root.className = 'dsh-ipv-root'
        root.tabIndex = -1
        root.dataset.ipViewer = '1'
        // A full-screen overlay is a modal dialog for assistive technology: say so,
        // or a screen reader keeps reading the conversation underneath it.
        root.setAttribute('role', 'dialog')
        root.setAttribute('aria-modal', 'true')
        root.setAttribute('aria-label', TEXT.viewerLabel)
        // Mark it as ours too: an absolute path inside a failure message must not
        // be decorated by this very plugin (that put a thumbnail inside the
        // viewer's own error text and cost one extra read per failure).
        root.dataset.ipOwn = '1'
        root.style.display = 'none'
        root.addEventListener('pointerdown', (event) => event.stopPropagation())
        root.addEventListener('click', (event) => event.stopPropagation())

        const bar = document.createElement('div')
        bar.className = 'dsh-ipv-bar'
        nameLabel = document.createElement('span')
        nameLabel.className = 'dsh-ipv-name'
        metaLabel = document.createElement('span')
        metaLabel.className = 'dsh-ipv-meta'
        const tools = document.createElement('div')
        tools.className = 'dsh-ipv-tools'

        const button = (label, title, onClick) => {
          const element = document.createElement('button')
          element.type = 'button'
          element.className = 'dsh-ipv-btn'
          element.textContent = label
          element.title = title
          // `‹` and `›` are the accessible name otherwise, which reads as nothing.
          element.setAttribute('aria-label', title)
          element.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            onClick()
          })
          tools.appendChild(element)
          return element
        }

        prevButton = button('‹', TEXT.prevTitle, () => {
          pageTo(index - 1)
        })
        nextButton = button('›', TEXT.nextTitle, () => {
          pageTo(index + 1)
        })
        button('−', TEXT.zoomOutTitle, () => {
          const box = stage.getBoundingClientRect()
          zoomAt(0.8, box.width / 2, box.height / 2)
        })
        zoomLabel = document.createElement('span')
        zoomLabel.className = 'dsh-ipv-btn'
        zoomLabel.style.display = 'inline-flex'
        zoomLabel.style.alignItems = 'center'
        zoomLabel.style.justifyContent = 'center'
        zoomLabel.style.cursor = 'default'
        zoomLabel.textContent = '100%'
        tools.appendChild(zoomLabel)
        button('+', TEXT.zoomInTitle, () => {
          const box = stage.getBoundingClientRect()
          zoomAt(1.25, box.width / 2, box.height / 2)
        })
        button(TEXT.fit, TEXT.fitTitle, fit)
        button('1:1', TEXT.actualTitle, actual)
        button(TEXT.copyImage, TEXT.copyImageTitle, () => {
          copyImage().catch(() => {})
        })
        button(TEXT.refresh, TEXT.refreshTitle, () => {
          bust = Date.now()
          show(index)
        })
        selectButton = button(TEXT.select, TEXT.selectTitle, toggleSelecting)
        selectButton.setAttribute('aria-pressed', 'false')
        annotateButton = button(TEXT.annotate, TEXT.annotateTitle, toggleInking)
        annotateButton.setAttribute('aria-pressed', 'false')
        compareButton = button(TEXT.compare, TEXT.compareTitle, toggleCompare)
        prefsButton = button('⚙', TEXT.prefsTitle, togglePrefs)
        button(TEXT.close, TEXT.closeTitle, () => close())

        const stageElement = document.createElement('div')
        stageElement.className = 'dsh-ipv-stage'
        const picture = document.createElement('img')
        picture.className = 'dsh-ipv-image'
        picture.decoding = 'async'
        picture.alt = ''
        const layer = document.createElement('canvas')
        layer.className = 'dsh-ipv-ink'
        // A canvas is opaque to a screen reader: name the thing it shows.
        layer.setAttribute('role', 'img')
        layer.setAttribute('aria-label', '')
        const messageElement = document.createElement('div')
        messageElement.className = 'dsh-ipv-message'
        // Failure explanations and the copy/reload confirmations are announced.
        messageElement.setAttribute('role', 'status')
        messageElement.setAttribute('aria-live', 'polite')
        stageElement.append(picture, layer, messageElement)
        stage = stageElement
        image = picture
        ink = layer
        message = messageElement

        stageElement.addEventListener('dblclick', (event) => {
          // While annotating, the double click belongs to the text tool.
          if (inking === true) return
          event.preventDefault()
          if (scale >= 1.99 || scale <= 1.01) actual()
          else fit()
        })
        stageElement.addEventListener('pointerdown', (event) => {
          if (event.button !== 0 || scale <= 0) return
          drag = { x: event.clientX, y: event.clientY, left: offsetX, top: offsetY }
          stageElement.dataset.dragging = '1'
          stageElement.setPointerCapture(event.pointerId)
        })
        stageElement.addEventListener('pointermove', (event) => {
          if (drag === null) return
          offsetX = drag.left + (event.clientX - drag.x)
          offsetY = drag.top + (event.clientY - drag.y)
          schedulePaint()
        })
        const endDrag = (event) => {
          if (drag === null) return
          drag = null
          stageElement.dataset.dragging = '0'
          try {
            stageElement.releasePointerCapture(event.pointerId)
          } catch {
            /* the pointer is already gone */
          }
        }
        stageElement.addEventListener('pointerup', endDrag)
        stageElement.addEventListener('pointercancel', endDrag)
        stageElement.addEventListener(
          'wheel',
          (event) => {
            event.preventDefault()
            const box = stageElement.getBoundingClientRect()
            if (event.ctrlKey === true || event.metaKey === true) {
              zoomAt(Math.exp(-event.deltaY * 0.0025), event.clientX - box.left, event.clientY - box.top)
              return
            }
            zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX - box.left, event.clientY - box.top)
          },
          { passive: false },
        )

        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
          layer.addEventListener(type, type === 'pointerdown' ? inkDown : type === 'pointermove' ? inkMove : inkUp)
        }
        // Selecting is a drag on the layer, never a pan of the stage under it, and
        // a double click there must not flip fit/1:1 beneath a half-drawn box.
        layer.addEventListener('dblclick', (event) => event.stopPropagation())

        const hintbar = document.createElement('div')
        hintbar.className = 'dsh-ipv-hint'
        hintbar.textContent = TEXT.hintView
        hintLabel = hintbar

        inkbar = document.createElement('div')
        inkbar.className = 'dsh-ipv-inkbar'
        inkbar.setAttribute('role', 'toolbar')
        inkbar.setAttribute('aria-label', TEXT.toolbar)
        const templateLabel = document.createElement('span')
        templateLabel.className = 'dsh-ipv-inklabel'
        templateLabel.textContent = TEXT.template
        inkbar.append(templateLabel)
        templateButtons = TEMPLATES.map((id) => {
          const element = document.createElement('button')
          element.type = 'button'
          element.className = 'dsh-ipv-tpl'
          element.dataset.template = id
          element.textContent = TEXT.templates[id]
          element.title = TEXT.templates[id]
          element.setAttribute('aria-label', TEXT.templates[id])
          element.setAttribute('aria-pressed', id === template ? 'true' : 'false')
          element.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            setTemplate(id)
          })
          inkbar.append(element)
          return element
        })
        const spacer = document.createElement('span')
        spacer.className = 'dsh-ipv-inkspacer'
        inkbar.append(spacer)
        const inkButton = (label, onClick, primary) => {
          const element = document.createElement('button')
          element.type = 'button'
          element.className = 'dsh-ipv-inkbtn' + (primary === true ? ' dsh-ipv-inkbtn-primary' : '')
          element.textContent = label
          element.setAttribute('aria-label', label)
          element.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
            onClick()
          })
          return element
        }
        lookButton = inkButton(TEXT.look, () => {
          sendSelection().catch(() => {})
        }, true)
        inkbar.append(
          lookButton,
          inkButton(TEXT.copy, () => {
            copySelection().catch(() => {})
          }),
          inkButton(TEXT.cancel, () => setSelecting(false)),
        )
        inkbar.style.display = 'none'

        inkbarAnnotate = document.createElement('div')
        inkbarAnnotate.className = 'dsh-ipv-inkbar dsh-ipv-inkbar-annotate'
        inkbarAnnotate.setAttribute('role', 'toolbar')
        inkbarAnnotate.setAttribute('aria-label', TEXT.inkbar)
        const section = (label) => {
          const element = document.createElement('span')
          element.className = 'dsh-ipv-inklabel'
          element.textContent = label
          inkbarAnnotate.append(element)
        }
        const chip = (className, label, title) => {
          const element = document.createElement('button')
          element.type = 'button'
          element.className = className
          element.textContent = label
          element.title = title
          element.setAttribute('aria-label', title)
          element.addEventListener('click', (event) => {
            event.preventDefault()
            event.stopPropagation()
          })
          inkbarAnnotate.append(element)
          return element
        }
        section('绘')
        toolButtons = TOOLS.map((id) => {
          const element = chip('dsh-ipv-inkbtn dsh-ipv-tool', TEXT.toolNames[id], TEXT.toolTitles[id])
          element.dataset.tool = id
          element.setAttribute('aria-pressed', id === tool ? 'true' : 'false')
          element.addEventListener('click', () => setTool(id))
          return element
        })
        section('色')
        colorButtons = COLORS.map((value) => {
          const element = chip('dsh-ipv-swatch', '', value)
          element.dataset.color = value
          element.style.background = value
          element.setAttribute('aria-pressed', value === strokeColor ? 'true' : 'false')
          element.addEventListener('click', () => setStrokeColor(value))
          return element
        })
        section('粗')
        widthButtons = WIDTHS.map((value) => {
          const element = chip('dsh-ipv-width', String(value), String(value) + ' px')
          element.dataset.width = String(value)
          element.setAttribute('aria-pressed', String(value) === String(strokeWidth) ? 'true' : 'false')
          element.style.setProperty('--w', String(value))
          element.addEventListener('click', () => setStrokeWidth(value))
          return element
        })
        undoButton = chip('dsh-ipv-inkbtn', TEXT.undo, TEXT.undo + '（Ctrl+Z）')
        undoButton.addEventListener('click', undo)
        redoButton = chip('dsh-ipv-inkbtn', TEXT.redo, TEXT.redo + '（Ctrl+Shift+Z）')
        redoButton.addEventListener('click', redo)
        const removeButton = chip('dsh-ipv-inkbtn', TEXT.remove, TEXT.remove + '（Delete）')
        removeButton.addEventListener('click', deleteActive)
        const clearButton = chip('dsh-ipv-inkbtn', TEXT.clear, TEXT.clear)
        clearButton.addEventListener('click', clearMarks)
        section(TEXT.template)
        for (const id of TEMPLATES) {
          const element = chip('dsh-ipv-tpl', TEXT.templates[id], TEXT.templates[id])
          element.dataset.template = id
          element.setAttribute('aria-pressed', id === template ? 'true' : 'false')
          element.addEventListener('click', () => setTemplate(id))
          templateButtons.push(element)
        }
        const annotateSpacer = document.createElement('span')
        annotateSpacer.className = 'dsh-ipv-inkspacer'
        inkbarAnnotate.append(annotateSpacer)
        const sendButton = chip('dsh-ipv-inkbtn dsh-ipv-inkbtn-primary', TEXT.send, TEXT.send + '（Enter）')
        sendButton.addEventListener('click', () => {
          sendAnnotated().catch(() => {})
        })
        const copyAnnotatedButton = chip('dsh-ipv-inkbtn', TEXT.copy, TEXT.copy + '（Ctrl+C）')
        copyAnnotatedButton.addEventListener('click', () => {
          copyAnnotated().catch(() => {})
        })
        const saveButton = chip('dsh-ipv-inkbtn', TEXT.save, TEXT.save + '（Ctrl+S）')
        saveButton.addEventListener('click', () => {
          saveAnnotated().catch(() => {})
        })
        const formatButton = chip(
          'dsh-ipv-inkbtn',
          TEXT.format + ' ' + (prefs.format === 'png' ? TEXT.formatPng : TEXT.formatJpeg),
          TEXT.formatTitle,
        )
        const paintFormatButton = () => {
          formatButton.textContent = TEXT.format + ' ' + (prefs.format === 'png' ? TEXT.formatPng : TEXT.formatJpeg)
        }
        formatButton.addEventListener('click', () => {
          prefs = { ...prefs, format: prefs.format === 'png' ? 'jpeg' : 'png' }
          savePrefs(prefs)
          paintFormatButton()
        })
        const closeButton = chip('dsh-ipv-inkbtn', TEXT.cancel, TEXT.cancel + '（Esc）')
        closeButton.addEventListener('click', () => setInking(false))
        inkbarAnnotate.style.display = 'none'
        syncEditButtons()

        statusLabel = document.createElement('div')
        statusLabel.className = 'dsh-ipv-status'
        statusLabel.setAttribute('role', 'status')
        statusLabel.setAttribute('aria-live', 'polite')
        statusLabel.dataset.on = '0'

        bar.append(nameLabel, metaLabel, tools)
        root.append(bar, stageElement, inkbar, inkbarAnnotate, hintbar, statusLabel)
        root.addEventListener('pointerdown', (event) => {
          if (event.target === root) close()
        })
        document.body.appendChild(root)
        markStageDirty()
      }

      /** Take the overlay out of the page on unload. */
      function destroy() {
        close(undefined, true)
        if (root !== null) root.remove()
        root = null
      }

      return { open, close, destroy }
    }

    const viewer = createViewer()

    // --------------------------- in-text image links ---------------------------

    /** Per-text-node decoration state, so a re-render never duplicates a chip. */
    const decorations = new WeakMap()
    /**
     * Which state currently owns each inserted element.
     *
     * A re-render replaces the text node while its picture survives; the new node
     * adopts that picture, but the old node's state still lists it. Without this
     * index, pruning the old node removed the adopted picture — leaving a block
     * whose path text was hidden with no picture in it.
     */
    const owners = new WeakMap()

    /**
     * Decorate one text node with thumbnails for the image paths it mentions.
     *
     * The text itself is never split or replaced: React still owns that node and
     * keeps writing streamed text into it, so the decoration is purely additive.
     * A path on its own line becomes a full-width thumbnail; a path inside prose
     * gets a small thumbnail chip after the run.
     * @param {Text} node - a live text node.
     */
    function decorate(node) {
      const data = node.nodeValue
      if (typeof data !== 'string' || data.length < 6) {
        dropDecorations(node)
        return
      }
      PATH_RE.lastIndex = 0
      const found = []
      for (let match = PATH_RE.exec(data); match !== null; match = PATH_RE.exec(data)) {
        if (match[0].length > MAX_PATH_LENGTH) continue
        found.push(match[0])
        if (found.length >= CHIPS_PER_NODE) break
      }
      const wanted = unique(found)
      if (wanted.length === 0) {
        dropDecorations(node)
        return
      }
      const state = decorations.get(node) ?? { items: new Map(), anchor: node }
      // A path that scrolled out of the text (a re-render shortened the run) loses its picture.
      for (const [file, element] of Array.from(state.items)) {
        if (wanted.includes(file)) continue
        if ((owners.get(element) ?? state) === state) {
          dropWaiting(element)
          element.remove()
        }
        state.items.delete(file)
      }
      let anchor = state.anchor !== null && state.anchor.isConnected ? state.anchor : node
      for (const file of wanted) {
        if (state.items.has(file)) continue
        // A React re-render can replace the text node while the old picture
        // survives in the same block; adopt it instead of stacking a second one.
        const parent = anchor.parentNode
        if (parent === null) break
        const adopted = parent.querySelector('[data-ip-path="' + cssEscape(file) + '"]')
        if (adopted !== null) {
          anchor = adopted
          state.items.set(file, adopted)
          owners.set(adopted, state)
          continue
        }
        const element = standalonePath(node, file) ? figureFor(file) : chipFor(file)
        if (element === null) continue
        parent.insertBefore(element, anchor.nextSibling)
        anchor = element
        state.items.set(file, element)
        owners.set(element, state)
      }
      state.anchor = anchor
      if (state.items.size === 0) decorations.delete(node)
      else decorations.set(node, state)
      updatePathVisibility(node.parentElement)
    }

    /** Remove every decoration this plugin added for one text node. */
    function dropDecorations(node) {
      const state = decorations.get(node)
      if (state !== undefined) {
        for (const element of state.items.values()) {
          // A picture adopted by another (newer) text node belongs to that node now:
          // removing it here is what left a hidden block with no picture in it.
          if ((owners.get(element) ?? state) !== state) continue
          dropWaiting(element)
          element.remove()
        }
        decorations.delete(node)
      }
      // Always re-evaluate the block: a path that left the text must also drop the
      // `data-ip-hide-path` that was hiding the raw path line, or a paragraph whose
      // picture went away stays invisible for good.
      updatePathVisibility(node.parentElement)
    }

    /**
     * Whether the text run is just this one path, so it deserves a real
     * thumbnail instead of a chip.
     * @param {Text} node - the text node holding the path.
     * @param {string} file - the matched path.
     * @returns {boolean} true when the path stands alone in its block.
     */
    function standalonePath(node, file) {
      const parent = node.parentElement
      if (parent === null || !STANDALONE_TAGS.has(parent.tagName)) return false
      const run = String(node.nodeValue).replace(/\s+/gu, '').replace(/[。，、；：！？.）】」》]+$/gu, '')
      if (run !== file.replace(/\s+/gu, '')) return false
      for (const child of parent.childNodes) {
        if (child === node) continue
        if (child.nodeType === 3 && child.nodeValue.trim() !== '') return false
        if (child.nodeType !== 1) continue
        if (child.tagName === 'BR') continue
        if (child.dataset !== undefined && child.dataset.ipOwn !== undefined) continue
        return false
      }
      return true
    }

    /** Whether this text node lives somewhere the decorator must not touch. */
    function skipNode(node) {
      let element = node.parentElement
      while (element !== null) {
        if (SKIP_TAGS.has(element.tagName)) return true
        if (element.isContentEditable === true) return true
        if (element.dataset !== undefined && element.dataset.ipOwn !== undefined) return true
        if (element.tagName === 'ASIDE') return true
        element = element.parentElement
      }
      return false
    }

    /** Open the viewer at one file, with the images of the same message around it. */
    function openFrom(element, file) {
      const scope = scopePaths(element)
      const at = scope.indexOf(file)
      viewer.open(scope.length > 1 ? scope : [file], at < 0 ? 0 : at)
    }

    /** Build the small inline thumbnail that follows a path inside prose. */
    function chipFor(file) {
      if (imageSourceCandidates(file).length === 0) return null
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'dsh-ip-chip'
      chip.dataset.ipOwn = '1'
      chip.dataset.ipPath = file
      chip.title = '预览图片：' + file
      chip.setAttribute('aria-label', '预览图片 ' + file)
      const img = document.createElement('img')
      img.loading = 'lazy'
      img.decoding = 'async'
      img.alt = ''
      chip.appendChild(img)
      whenVisible(chip, () => {
        attachImage(img, file, (reason) => {
          // The chip is 46×34: show the reason, keep the full path in the tooltip.
          chip.title = '打不开：' + file + '\n' + reason
          chip.replaceChildren(failedLabel(reason))
        })
      })
      chip.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        openFrom(chip, file)
      })
      hover.attach(chip, file)
      return chip
    }

    /** Build the thumbnail that replaces a path standing on its own line. */
    function figureFor(file) {
      if (imageSourceCandidates(file).length === 0) return null
      const figure = document.createElement('button')
      figure.type = 'button'
      figure.className = 'dsh-ip-figure'
      figure.dataset.ipOwn = '1'
      figure.dataset.ipPath = file
      figure.title = '点开查看原图：' + file
      const img = document.createElement('img')
      img.loading = 'lazy'
      img.decoding = 'async'
      img.alt = baseName(file)
      const caption = document.createElement('span')
      caption.className = 'dsh-ip-figure-cap'
      caption.textContent = baseName(file)
      img.addEventListener('load', () => {
        caption.textContent = baseName(file) + ' · ' + img.naturalWidth + ' × ' + img.naturalHeight
      })
      figure.append(img, caption)
      whenVisible(figure, () => {
        attachImage(img, file, (reason) => {
          figure.title = '打不开：' + file + '\n' + reason
          figure.replaceChildren(failedLabel(baseName(file) + '：' + reason, 60))
        })
      })
      figure.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        openFrom(figure, file)
      })
      return figure
    }

    /**
     * A small "this one will not open" label.
     * @param {string} text - what to show.
     * @param {number} [limit] - how many characters fit.
     * @returns {HTMLSpanElement} the label.
     */
    function failedLabel(text, limit = 24) {
      const span = document.createElement('span')
      span.className = 'dsh-ip-chip-failed'
      span.textContent = '打不开 ' + String(text).slice(0, limit)
      return span
    }

    /**
     * Whether a block holds nothing but image paths and punctuation.
     *
     * Such a block is now a picture, so its raw path line is noise: the reader
     * gains nothing from `C:/Users/…/fig.png` above the figure it already sees.
     * @param {Element | null} parent - the block that holds the text.
     * @returns {boolean} true when nothing but paths, punctuation and whitespace remain.
     */
    function blockIsOnlyPaths(parent) {
      if (parent === null) return false
      for (const child of parent.childNodes) {
        if (child.nodeType === 3) {
          const rest = String(child.nodeValue)
            .replace(PATH_RE, '')
            .replace(/[\s。，、；：！？·—…,.!?;:）】」》〉"'"]/gu, '')
          if (rest !== '') return false
          continue
        }
        if (child.nodeType !== 1) continue
        if (child.tagName === 'BR') continue
        // Our own chip/figure/caption does not count as leftover text.
        if (child.dataset !== undefined && child.dataset.ipOwn !== undefined) continue
        return false
      }
      return true
    }

    /**
     * Hide a block's raw path text once every path in it is drawn, and restore it
     * when the pictures go away.
     *
     * This only sets an attribute on the block: the text node React owns is never
     * split or rewritten, so the path stays selectable and copyable, and a
     * re-render cannot leave a dangling reference behind.
     * @param {Element | null} parent - the block that holds decorated text.
     */
    function updatePathVisibility(parent) {
      if (parent === null || parent.dataset === undefined || parent.dataset === null) return
      const drawn = parent.querySelector('[data-ip-path]') !== null
      if (drawn === true && blockIsOnlyPaths(parent) === true) parent.dataset.ipHidePath = '1'
      else if (parent.dataset.ipHidePath !== undefined) delete parent.dataset.ipHidePath
    }

    /** Escape one value for an attribute selector without depending on CSS.escape. */
    function cssEscape(value) {
      return String(value).replace(/[\\"]/gu, '\\$&')
    }

    /**
     * Every other image path in the same message, so ←/→ walks one message.
     * @param {Element} element - the clicked thumbnail.
     * @returns {string[]} absolute paths, in document order.
     */
    function scopePaths(element) {
      let scope = element
      while (scope !== null && scope !== document.body) {
        if (scope.hasAttribute?.('data-chat-anchor-key') || scope.hasAttribute?.('data-chat-flow-key')) break
        scope = scope.parentElement
      }
      const root = scope === null || scope === document.body ? document.body : scope
      const found = Array.from(root.querySelectorAll('[data-ip-path]')).map((chip) => chip.dataset.ipPath)
      return unique(found)
    }

    /**
     * One floating preview shared by every chip: hover a thumbnail and the full
     * picture appears next to it, no click needed.
     */
    function createHover() {
      let root = null
      let image = null
      let caption = null
      let timer = null
      let file = null
      let anchor = null
      let shownUrl = null

      /** Build the floating box on first use. */
      function ensure() {
        if (root !== null) return
        // A second evaluation of this bundle can leave its float behind, and then
        // one pointer would be answered by two overlays (the stale one hiding the
        // live one). The newest instance owns the page.
        for (const stray of document.querySelectorAll('.dsh-ip-hover')) stray.remove()
        root = document.createElement('div')
        root.className = 'dsh-ip-hover'
        root.dataset.ipOwn = '1'
        image = document.createElement('img')
        image.alt = ''
        caption = document.createElement('div')
        caption.className = 'dsh-ip-hover-cap'
        root.append(image, caption)
        document.body.appendChild(root)
        image.addEventListener('load', place)
        document.addEventListener('scroll', hide, true)
        window.addEventListener('resize', hide)
      }

      /** Put the box under (or above) the hovered chip, inside the viewport. */
      function place() {
        if (root === null || anchor === null || anchor.isConnected !== true) return
        const rect = anchor.getBoundingClientRect()
        const box = root.getBoundingClientRect()
        const gap = 8
        let top = rect.bottom + gap
        if (top + box.height > window.innerHeight - 8) top = Math.max(8, rect.top - gap - box.height)
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - box.width - 8))
        root.style.left = Math.round(left) + 'px'
        root.style.top = Math.round(top) + 'px'
      }

      /** Reveal the floating preview for the chip that armed it. */
      function show() {
        if (file === null || anchor === null || anchor.isConnected !== true) return
        if (imageSourceCandidates(file).length === 0) return
        ensure()
        if (shownUrl !== file) {
          shownUrl = file
          image.style.display = ''
          attachImage(image, file, (reason) => {
            image.style.display = 'none'
            caption.textContent = '打不开这张图（' + reason + '）'
            place()
          })
        }
        caption.textContent = baseName(file)
        root.style.display = 'block'
        place()
      }

      /** Hide the floating preview and cancel a pending timer. */
      function hide() {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        if (root !== null) root.style.display = 'none'
      }

      /** Watch one chip for hover. */
      function attach(element, path) {
        element.addEventListener('pointerenter', () => {
          file = path
          anchor = element
          if (timer !== null) clearTimeout(timer)
          timer = setTimeout(() => {
            timer = null
            show()
          }, 220)
        })
        element.addEventListener('pointerleave', hide)
        element.addEventListener('pointerdown', hide)
        element.addEventListener('focus', () => {
          file = path
          anchor = element
          show()
        })
        element.addEventListener('blur', hide)
      }

      /** Take the floating box out of the page on unload. */
      function destroy() {
        hide()
        document.removeEventListener('scroll', hide, true)
        window.removeEventListener('resize', hide)
        if (root !== null) root.remove()
        root = null
      }

      return { attach, destroy }
    }

    const hover = createHover()

    /**
     * Watch the page for rendered text and decorate the image paths in it.
     * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context for disposal.
     */
    function watchText(ctx) {
      const pending = new Set()
      let scheduled = false
      let stopped = false

      const flush = () => {
        scheduled = false
        if (stopped) return
        const batch = Array.from(pending)
        pending.clear()
        for (const node of batch) {
          try {
            if (node.isConnected !== true || node.parentNode === null) continue
            if (skipNode(node)) continue
            decorate(node)
          } catch {
            /* one unreadable node must not stop the pass */
          }
        }
      }

      const schedule = () => {
        if (scheduled || stopped) return
        scheduled = true
        if (typeof requestAnimationFrame !== 'function') {
          setTimeout(flush, 30)
          return
        }
        // A hidden or minimized window stops requestAnimationFrame outright, and then
        // a transcript that streamed in the background stays undecorated until the
        // window comes back. The timer is the safety net: whichever fires first wins
        // and `flush` is idempotent.
        let timer = null
        const frame = requestAnimationFrame(() => {
          if (timer !== null) clearTimeout(timer)
          flush()
        })
        timer = setTimeout(() => {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
          flush()
        }, 250)
      }

      const collect = (node) => {
        if (node.nodeType === 3) {
          pending.add(node)
          return
        }
        if (node.nodeType !== 1) return
        const element = node
        if (SKIP_TAGS.has(element.tagName)) return
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) {
          pending.add(text)
          if (pending.size > 800) break
        }
      }

      /** Forget the decorations of a text node the page took out of the document. */
      const prune = (node) => {
        if (node.nodeType === 3) {
          dropDecorations(node)
          return
        }
        if (node.nodeType !== 1) return
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
        for (let text = walker.nextNode(); text !== null; text = walker.nextNode()) dropDecorations(text)
      }

      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'characterData') {
            if (record.target.nodeType === 3) pending.add(record.target)
            continue
          }
          for (const added of record.addedNodes) collect(added)
          for (const removed of record.removedNodes) prune(removed)
        }
        if (pending.size > 0) schedule()
      })
      observer.observe(document.body, { subtree: true, childList: true, characterData: true })
      // A sweep for text the mutation stream missed (a virtualized row that
      // arrived without an observable insertion, a host re-render that reused
      // nodes): the decoration is idempotent, so re-scanning is safe.
      //
      // It is a whole-document walk, so it only runs while somebody can see the
      // window, and rarely: the observer already covers streaming text, and a
      // background window has no reason to burn a walk every few seconds.
      const sweep = setInterval(() => {
        if (stopped || document.visibilityState === 'hidden') return
        try {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
          let count = 0
          for (let text = walker.nextNode(); text !== null && count < 1500; text = walker.nextNode()) {
            count += 1
            if (text.nodeValue === null || text.nodeValue.length < 6) continue
            if (text.nodeValue.search(PATH_RE) < 0) continue
            pending.add(text)
          }
          if (pending.size > 0) schedule()
        } catch {
          /* an unreadable document simply gets no sweep */
        }
      }, 15000)
      if (typeof sweep.unref === 'function') sweep.unref()
      // Coming back to the window is the moment a missed row becomes visible, so
      // one sweep right then is worth more than the idle timer.
      const onVisible = () => {
        if (document.visibilityState !== 'visible' || stopped) return
        try {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
          let count = 0
          for (let text = walker.nextNode(); text !== null && count < 1500; text = walker.nextNode()) {
            count += 1
            if (text.nodeValue === null || text.nodeValue.length < 6) continue
            if (text.nodeValue.search(PATH_RE) < 0) continue
            pending.add(text)
          }
          if (pending.size > 0) schedule()
        } catch {
          /* nothing to sweep */
        }
      }
      document.addEventListener('visibilitychange', onVisible)
      ctx.effect(() => () => {
        stopped = true
        clearInterval(sweep)
        document.removeEventListener('visibilitychange', onVisible)
        observer.disconnect()
        pending.clear()
      })

      // First pass over what is already on screen.
      try {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        let seen = 0
        for (let text = walker.nextNode(); text !== null && seen < 3000; text = walker.nextNode()) {
          seen += 1
          pending.add(text)
        }
        if (pending.size > 0) schedule()
      } catch {
        /* an unreadable document simply gets no first pass */
      }
    }

    // ------------------------------ the tool card ------------------------------

    /**
     * Unwrap one argument carrier into plain arguments.
     *
     * `block.args` is a plain object on a settled call, but a still-streaming call
     * hands over a `PartialArguments` reader (`chunks` / `object` / `sealed`)
     * whose own fields look nothing like the tool's arguments. Treating the
     * reader as arguments is why the card said "准备中…" until the very end and
     * why a mount report could read `k=chunks.object.sealed`.
     * @param {unknown} value - one candidate argument carrier.
     * @returns {object | null} the parsed arguments, or null when there are none.
     */
    function plainArgs(value) {
      if (value === null || typeof value !== 'object') return null
      if (Array.isArray(value.chunks) || typeof value.sealed === 'boolean') {
        const parsed = value.object
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
        return parsed
      }
      return value
    }

    /**
     * The `preview_image` arguments, tolerant of every lifecycle stage.
     * @param {object | undefined} call - the phase payload the tool slot passes.
     * @returns {object} the arguments seen so far, or an empty object.
     */
    function toolArgs(call) {
      if (call === undefined || call === null || call.block === undefined || call.block === null) return {}
      const block = call.block
      // The Tool view props have changed shape across host versions: read every
      // place the arguments may sit and keep the first one that carries a path.
      const found = []
      if (block.call !== undefined && block.call !== null && block.call.args !== undefined && block.call.args !== null) {
        const args = plainArgs(block.call.args)
        if (args !== null) found.push(args)
      }
      if (block.args !== undefined && block.args !== null) {
        const args = plainArgs(block.args)
        if (args !== null) found.push(args)
      }
      for (const raw of [block.argsRaw, block.call?.argsRaw]) {
        if (typeof raw !== 'string' || raw.trim() === '') continue
        try {
          const parsed = JSON.parse(raw)
          if (parsed !== null && typeof parsed === 'object') found.push(parsed)
        } catch {
          /* a partially streamed argument object is not parseable yet */
        }
      }
      for (const candidate of found) {
        if (Array.isArray(candidate.paths) || typeof candidate.path === 'string') return candidate
      }
      return found[0] ?? {}
    }

    /** The image paths one call asked for, or the ones its settled result names. */
    function toolPaths(call) {
      // A `dir` call never names its pictures in the arguments: the host expands the
      // directory and records the answer as result metadata. Prefer that, so the
      // card paints what the call produced instead of "没有可显示的图片。" on a
      // call that plainly did produce pictures.
      const meta = call?.block?.meta
      if (meta !== null && typeof meta === 'object' && Array.isArray(meta.images)) {
        const stated = []
        for (const entry of meta.images) {
          const file = typeof entry === 'string' ? entry : entry !== null && typeof entry === 'object' && typeof entry.path === 'string' ? entry.path : ''
          if (file !== '') stated.push(file)
        }
        if (stated.length > 0) return unique(stated).slice(0, 24)
      }
      const args = toolArgs(call)
      const list = []
      if (Array.isArray(args.paths)) list.push(...args.paths)
      if (typeof args.path === 'string') list.push(args.path)
      return unique(list).slice(0, 24)
    }

    /** One thumbnail, walking the candidate routes before it gives up. */
    function Thumbnail({ file, onOpen }) {
      const [phase, setPhase] = React.useState('loading')
      const [reason, setReason] = React.useState('')
      const holder = React.useRef(null)
      React.useEffect(() => {
        const node = holder.current
        if (node === null) return () => {}
        setPhase('loading')
        setReason('')
        // A card can hold 24 pictures: fetching them all on mount is what turned
        // one gallery into 24 simultaneous reads. Fetch a thumbnail when it is
        // about to be seen, and cancel the wait when the card unmounts first.
        let cancelled = false
        const stop = whenVisible(node, () => {
          if (cancelled) return
          node.onload = () => setPhase('ok')
          attachImage(node, file, (why) => {
            setReason(why)
            setPhase('failed')
          })
        })
        return () => {
          cancelled = true
          stop()
          node.onerror = null
          node.onload = null
        }
      }, [file])
      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-ip-thumb',
          title: '点开查看：' + file,
          onClick: () => onOpen(),
        },
        phase === 'failed'
          ? React.createElement('span', { className: 'dsh-ip-thumb-failed' }, '打不开\n' + baseName(file) + '\n' + reason)
          : React.createElement('img', {
              ref: holder,
              alt: baseName(file),
              loading: 'lazy',
              decoding: 'async',
              style: phase === 'loading' ? { opacity: 0.25 } : undefined,
            }),
      )
    }
    /**
     * The tool slot hands the phase payload either as `call` or split across
     * `phase` and `block`, depending on how the call tree dispatches it.
     * @param {object} props - the Tool-owned view props.
     * @returns {{ phase: string, block: object } | undefined} the phase payload.
     */
    function phaseOf(props) {
      if (props.call !== undefined && props.call !== null) return props.call
      if (typeof props.phase === 'string' && props.block !== undefined && props.block !== null) {
        return { phase: props.phase, block: props.block }
      }
      return undefined
    }

    /**
     * Whole-call view of `preview_image`: an expanded grid of the figures the
     * model chose to show, never a collapsed path.
     * @param {object} props - the Tool-owned view props.
     */
    function PreviewImageCard(props) {
      const call = phaseOf(props)
      const paths = React.useMemo(() => toolPaths(call), [call])
      const caption = React.useMemo(() => {
        const args = toolArgs(call)
        return typeof args.caption === 'string' ? args.caption : ''
      }, [call])
      React.useEffect(() => {
        // One line to the host's recorder per mounted card: which props shape the
        // slot handed over and how many paths came out of it. Encoded into the
        // stage string so even an older host records it verbatim.
        const block = props.block ?? call?.block
        report(
          'card-render n=' + paths.length +
            ' p=' + String(props.phase ?? call?.phase ?? '') +
            ' b=' + (block ? 1 : 0) +
            ' c=' + (block && block.call ? 1 : 0) +
            ' k=' + Object.keys(toolArgs(call)).join('.'),
        )
      }, [])
      const open = React.useCallback(
        (at) => {
          viewer.open(paths, at)
        },
        [paths],
      )
      const settled = call?.phase === 'result'
      const failed = settled === true && call.block?.isError === true
      return React.createElement(
        'div',
        { className: 'dsh-ip-card', 'data-ip-card': '1' },
        React.createElement(
          'div',
          { className: 'dsh-ip-card-head' },
          svgIconNode(13),
          React.createElement('span', { className: 'dsh-ip-card-title' }, '预览图片'),
          React.createElement('span', { className: 'dsh-ip-card-count' }, paths.length > 0 ? paths.length + ' 张' : '准备中…'),
        ),
        caption !== '' ? React.createElement('div', { className: 'dsh-ip-card-caption' }, caption) : null,
        failed
          ? React.createElement('div', { className: 'dsh-ip-card-empty' }, '这次预览失败了，展开详情看原因。')
          : null,
        paths.length === 0 && settled === true
          ? React.createElement('div', { className: 'dsh-ip-card-empty' }, '没有可显示的图片。')
          : null,
        paths.length > 0
          ? React.createElement(
              'div',
              { className: 'dsh-ip-card-grid' },
              paths.map((file, at) =>
                React.createElement(Thumbnail, { key: file + ':' + at, file, onOpen: () => open(at) }),
              ),
            )
          : null,
      )
    }

    /** The card head icon as a React element (the DOM helper builds a plain node). */
    function svgIconNode(size) {
      return React.createElement(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        React.createElement('rect', { x: 1.8, y: 2.6, width: 12.4, height: 10.8, rx: 1.6 }),
        React.createElement('circle', { cx: 5.6, cy: 6.2, r: 1.1 }),
        React.createElement('path', { d: 'M3.2 12.2 6.9 8.6l2.6 2.6 1.7-1.5 2.3 2.5' }),
      )
    }

    // ------------------------------ plugin wiring ------------------------------

    /** Services this browser half needs. */
    const inject = ['slots']

    /**
     * Wire the plugin into the page.
     * @param {import('@deepseek-ai/cordis').Context} ctx - the browser plugin context.
     */
    /**
     * Tell the host how this half mounted. The host records it next to the image
     * requests, so one `diag` read says whether the card registered and why not.
     * @param {string} stage - the mount step that finished or failed.
     * @param {unknown} [error] - the failure, when that step failed.
     * @param {object} [extra] - any extra facts worth reporting.
     */
    function report(stage, error, extra) {
      try {
        const url = new URL('image-preview/client-report', document.baseURI).href
        fetch(url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            stage,
            error: error === undefined ? '' : String((error instanceof Error ? error.stack || error.message : error) || '').slice(0, 600),
            ...extra,
          }),
        }).catch(() => {})
      } catch {
        /* a report that cannot be sent is not worth failing over */
      }
    }

    /**
     * Wire the plugin into the page.
     *
     * Each surface is mounted on its own so one failure cannot take the others
     * down, and each outcome is reported to the host for diagnosis.
     * @param {import('@deepseek-ai/cordis').Context} ctx - the browser plugin context.
     */
    function apply(ctx) {
      try {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-plugin-image-preview'
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => {
          style.remove()
        })
        report('style', undefined, { base: document.baseURI })
      } catch (error) {
        report('style-failed', error)
      }

      try {
        ctx.effect(() => () => viewer.destroy())
        ctx.effect(() => () => hover.destroy())
        // Every cached picture is an object URL: letting the plugin unload without
        // revoking them would leak the whole conversation's images.
        ctx.effect(() => () => {
          releaseReadCache()
          releaseBlobUrls()
        })
      } catch (error) {
        report('effects-failed', error)
      }

      try {
        // "Send to the composer" needs to know which editor the reader was last in:
        // the viewer covers the page, so nothing is focused when it closes.
        document.addEventListener('focusin', rememberEditor, true)
        ctx.effect(() => () => document.removeEventListener('focusin', rememberEditor, true))
      } catch (error) {
        report('composer-watch-failed', error)
      }

      try {
        // The keyed tool slot dispatches by the wire tool name. Register the plain
        // name first and the namespaced spellings as a hedge: an extra key that no
        // call ever uses costs nothing, a missing one costs the whole card.
        const keys = ['preview_image', 'image-preview.preview_image', 'dsh-plugin-image-preview.preview_image']
        ctx.slots.inject('tool.call.toolview', () => {
          const disposers = keys.map((key) =>
            ctx.slots.register({ name: 'tool.call.toolview', key, priority: -1 }, PreviewImageCard),
          )
          return () => {
            for (const dispose of disposers) {
              if (typeof dispose === 'function') dispose()
            }
          }
        })
        report('slots-registered', undefined, { keys: keys.join(',') })
      } catch (error) {
        report('slots-failed', error, { hasSlots: Boolean(ctx.slots) })
      }

      try {
        watchText(ctx)
        report('text-watch')
      } catch (error) {
        report('text-watch-failed', error)
      }
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
