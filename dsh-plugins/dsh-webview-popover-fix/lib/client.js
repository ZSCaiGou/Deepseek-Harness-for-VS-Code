// dsh-webview-popover-fix client half.
//
// 背景：DSH 0.2.2-rc.x 的浮层（role="dialog"）用 CSS 锚定定位，并把垂直坐标减去了
// 「最大可滚动量」(scrollHeight - clientHeight)，而不是当前 scrollTop。
// 实测公式：dialogTop ≈ C - (scrollHeight - clientHeight)。于是长转录（转录越高、
// 可滚动量越大）会把浮层推到视口外几万像素处：元素在 DOM 里、样式也正常，但看不见、
// 点不到——典型表现为「命令菜单 / 权限 / 模型 / Token 用量点不开」「问答卡片卡住」。
//
// 作用范围被刻意收紧，避免误伤正常浮层：
//   1) 只处理**完全**在视口外的浮层（部分露出边缘属于正常形态，不碰）；
//   2) 只处理锚点在视口下半部分（输入区那一排按钮）的浮层，其它位置的浮层不碰；
//   3) 插入后先等 SETTLE_MS 再判定，避开框架尚未完成定位的瞬间；
//   4) 不搬 DOM（避免 React 事件委托失效），只写内联样式；下一次 pointerdown /
//      resize 时清掉自己写的样式，把定位权交还框架。
window.__ModuleLoader__.load({ id: 'dsh-webview-popover-fix', factory: function () {
  var module = { exports: {} }
  var exports = module.exports

  var MARGIN = 8              // 与视口边缘的最小间距
  var MAX_HEIGHT_RATIO = 0.7  // 纠偏后的最大高度
  var SETTLE_MS = 160         // 插入后等这么久再判定
  var RECHECK_MS = 450        // 再补一次判定（框架可能动画/测量后才最终定位）
  var COMPOSER_BOTTOM_RATIO = 0.5  // 锚点必须位于视口下半部分
  var SELECTOR = '[role="dialog"],[popover],[style*="position-anchor"]'
  var Z_INDEX = '2000'
  var APPLIED = [
    'position-anchor', 'position-area', 'position-try-fallbacks',
    'position', 'left', 'top', 'right', 'bottom', 'max-height', 'z-index'
  ]

  var touched = new Set()
  var settleTimer = null
  var recheckTimer = null
  var disposed = false

  /** 整个矩形是否完全在视口之外（含"面积太小视为未显示"）。 */
  function fullyOutside(rect) {
    if (rect.width < 2 || rect.height < 2) return false
    return rect.bottom <= 0
      || rect.top >= window.innerHeight
      || rect.right <= 0
      || rect.left >= window.innerWidth
  }

  /** 按 position-anchor 的锚点名找到锚点元素（DSH 用内联 anchor-name 声明）。 */
  function findAnchor(el) {
    var name = el.style.getPropertyValue('position-anchor')
      || (window.getComputedStyle(el).positionAnchor || '')
    if (!name) return null
    name = String(name).trim()
    var candidates = document.querySelectorAll('[style*="anchor-name"]')
    for (var i = 0; i < candidates.length; i += 1) {
      var candidate = candidates[i]
      var declared = candidate.style.getPropertyValue('anchor-name') || ''
      var names = declared.split(',')
      for (var j = 0; j < names.length; j += 1) {
        if (names[j].trim() === name) return candidate
      }
    }
    return null
  }

  /**
   * 只在「输入区那一排按钮」的浮层上生效：锚点必须存在且位于视口下半部分。
   * 侧栏、顶部工具栏等位置的浮层一律不碰。
   */
  function composerAnchor(el) {
    var anchor = findAnchor(el)
    if (anchor === null) return null
    var rect = anchor.getBoundingClientRect()
    if (rect.top < window.innerHeight * COMPOSER_BOTTOM_RATIO) return null
    return anchor
  }

  /** 把元素纠正到视口内（优先贴锚点上方，放不下贴下方，最后视口内 clamp）。 */
  function rescue(el, anchor) {
    var rect = el.getBoundingClientRect()
    var width = Math.min(Math.max(rect.width, 200), window.innerWidth - MARGIN * 2)
    var maxHeight = Math.round(window.innerHeight * MAX_HEIGHT_RATIO)
    var height = Math.min(rect.height > 2 ? rect.height : maxHeight, maxHeight)
    var anchorRect = anchor.getBoundingClientRect()
    var left = anchorRect.right - width
    var top = anchorRect.top - height - MARGIN
    if (top < MARGIN) top = anchorRect.bottom + MARGIN
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - width - MARGIN))
    top = Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN))

    // position: fixed 的包含块可能被祖先（transform / contain / will-change）劫持；
    // offsetParent 的矩形就是那个包含块，换算一下才能落到真正想要的视口位置。
    var offsetParent = el.offsetParent
    if (offsetParent !== null) {
      var box = offsetParent.getBoundingClientRect()
      left -= box.left
      top -= box.top
    }

    var style = el.style
    style.setProperty('position-anchor', 'none', 'important')
    style.setProperty('position-area', 'none', 'important')
    style.setProperty('position-try-fallbacks', 'none', 'important')
    style.setProperty('position', 'fixed', 'important')
    style.setProperty('left', left + 'px', 'important')
    style.setProperty('top', top + 'px', 'important')
    style.setProperty('right', 'auto', 'important')
    style.setProperty('bottom', 'auto', 'important')
    style.setProperty('max-height', maxHeight + 'px', 'important')
    style.setProperty('z-index', Z_INDEX, 'important')
    touched.add(el)
  }

  /** 扫描：只有「完全在视口外」且「锚点在输入区」的浮层才会被纠正。 */
  function scan() {
    if (disposed) return
    var dialogs = document.querySelectorAll(SELECTOR)
    for (var i = 0; i < dialogs.length; i += 1) {
      var el = dialogs[i]
      if (el.nodeType !== 1) continue
      if (el.style.display === 'none') continue
      if (!fullyOutside(el.getBoundingClientRect())) continue
      var anchor = composerAnchor(el)
      if (anchor === null) continue
      try {
        rescue(el, anchor)
      } catch (error) {
        console.error('[dsh-webview-popover-fix] rescue failed:', error)
      }
    }
  }

  function scheduleScan() {
    if (disposed) return
    // 防抖 + 二次判定：插入瞬间框架可能还没定位完，等一拍再测。
    if (settleTimer !== null) window.clearTimeout(settleTimer)
    settleTimer = window.setTimeout(function () {
      settleTimer = null
      scan()
    }, SETTLE_MS)
    if (recheckTimer === null) {
      recheckTimer = window.setTimeout(function () {
        recheckTimer = null
        scan()
      }, RECHECK_MS)
    }
  }

  /** 清掉本插件写过的样式，把定位权交还给框架。 */
  function clearTouched() {
    touched.forEach(function (el) {
      for (var i = 0; i < APPLIED.length; i += 1) el.style.removeProperty(APPLIED[i])
    })
    touched.clear()
  }

  function onPointerDown() {
    clearTouched()
    scheduleScan()
  }

  function onResize() {
    clearTouched()
    scheduleScan()
  }

  function apply(ctx) {
    ctx.effect(function () {
      if (typeof document === 'undefined') return function () {}
      var observer = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i += 1) {
          var added = records[i].addedNodes
          for (var j = 0; j < added.length; j += 1) {
            var node = added[j]
            if (node.nodeType !== 1) continue
            if (node.matches(SELECTOR) || node.querySelector(SELECTOR) !== null) {
              scheduleScan()
              return
            }
          }
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })
      document.addEventListener('pointerdown', onPointerDown, true)
      window.addEventListener('resize', onResize)
      scheduleScan()
      return function () {
        disposed = true
        observer.disconnect()
        document.removeEventListener('pointerdown', onPointerDown, true)
        window.removeEventListener('resize', onResize)
        if (settleTimer !== null) window.clearTimeout(settleTimer)
        if (recheckTimer !== null) window.clearTimeout(recheckTimer)
        clearTouched()
      }
    })
  }

  exports.apply = apply
  exports.inject = []
  return module.exports
} })
