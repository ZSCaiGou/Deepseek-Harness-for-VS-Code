// dsh-webview-popover-fix client half.
//
// 背景：DSH 0.2.2-rc.x 的浮层（role="dialog"）用 CSS 锚定定位，并把垂直坐标减去了
// 「最大可滚动量」(scrollHeight - clientHeight)，而不是当前 scrollTop。
// 实测公式：dialogTop ≈ C - (scrollHeight - clientHeight)。长转录里浮层被推到视口外
// 几万像素处：元素在 DOM 里、样式也正常，但看不见点不到——表现为「命令菜单 / 权限 /
// 模型 / Token 用量点不开」「问答卡片卡住」。
//
// 作用范围被刻意收紧，避免误伤正常浮层：
//   1) 只处理**完全**在视口外的浮层（部分露出边缘属于正常形态）；
//   2) 只处理锚点在视口下半部分（输入区那一排按钮）的浮层；
//   3) 插入后先等 SETTLE_MS 再判定，避开框架尚未完成定位的瞬间。
// 一旦被纠偏，浮层就"钉"在锚点上：窗口 resize / 滚动时按锚点重算位置（不清样式，
// 避免闪一下或跳位）；只有下次 pointerdown（可能要开新浮层）才把定位权交还框架。
// 全程不搬 DOM（避免 React 事件委托失效），只写内联样式。
window.__ModuleLoader__.load({ id: 'dsh-webview-popover-fix', factory: function () {
  var module = { exports: {} }
  var exports = module.exports

  var MARGIN = 8
  var MAX_HEIGHT_RATIO = 0.7
  var SETTLE_MS = 160
  var RECHECK_MS = 450
  var COMPOSER_BOTTOM_RATIO = 0.5
  var SELECTOR = '[role="dialog"],[popover],[style*="position-anchor"]'
  var Z_INDEX = '2000'
  var APPLIED = [
    'position-anchor', 'position-area', 'position-try-fallbacks',
    'position', 'left', 'top', 'right', 'bottom', 'max-height', 'z-index'
  ]

  /** 已纠偏的浮层 → 它的锚点元素（resize / 滚动时据此重算）。 */
  var touched = new Map()
  var settleTimer = null
  var recheckTimer = null
  var repositionPending = false
  var disposed = false

  /** 整个矩形是否完全在视口之外（面积太小视为未显示）。 */
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

  /** 只在「输入区那一排按钮」的浮层上生效：锚点必须存在且位于视口下半部分。 */
  function composerAnchor(el) {
    var anchor = findAnchor(el)
    if (anchor === null) return null
    var rect = anchor.getBoundingClientRect()
    if (rect.top < window.innerHeight * COMPOSER_BOTTOM_RATIO) return null
    return anchor
  }

  /** 按锚点算一组视口坐标（优先贴锚点上方，放不下贴下方，最后 clamp）。 */
  function placeAt(el, anchor) {
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
    return { left: left, top: top, maxHeight: maxHeight }
  }

  function remember(el, anchor) {
    touched.set(el, anchor)
  }

  function forget(el) {
    for (var i = 0; i < APPLIED.length; i += 1) el.style.removeProperty(APPLIED[i])
    touched.delete(el)
  }

  /** 纠正一个浮层并记住它的锚点。 */
  function rescue(el, anchor) {
    var spot = placeAt(el, anchor)
    var style = el.style
    style.setProperty('position-anchor', 'none', 'important')
    style.setProperty('position-area', 'none', 'important')
    style.setProperty('position-try-fallbacks', 'none', 'important')
    style.setProperty('position', 'fixed', 'important')
    style.setProperty('left', spot.left + 'px', 'important')
    style.setProperty('top', spot.top + 'px', 'important')
    style.setProperty('right', 'auto', 'important')
    style.setProperty('bottom', 'auto', 'important')
    style.setProperty('max-height', spot.maxHeight + 'px', 'important')
    style.setProperty('z-index', Z_INDEX, 'important')
    remember(el, anchor)
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

  /** 已纠偏的浮层跟着锚点重算（resize / 滚动时调用，不清样式，不会跳位）。 */
  function repositionTouched() {
    if (disposed) return
    touched.forEach(function (anchor, el) {
      if (!el.isConnected || !anchor.isConnected) {
        forget(el)
        return
      }
      if (el.getBoundingClientRect().width < 2) return
      try {
        var spot = placeAt(el, anchor)
        el.style.setProperty('left', spot.left + 'px', 'important')
        el.style.setProperty('top', spot.top + 'px', 'important')
        el.style.setProperty('max-height', spot.maxHeight + 'px', 'important')
      } catch (error) {
        console.error('[dsh-webview-popover-fix] reposition failed:', error)
      }
    })
  }

  function scheduleReposition() {
    if (repositionPending || disposed) return
    repositionPending = true
    window.requestAnimationFrame(function () {
      repositionPending = false
      repositionTouched()
    })
  }

  function scheduleScan() {
    if (disposed) return
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

  /** 清掉所有纠偏样式，把定位权交还框架（只在下次 pointerdown 时做）。 */
  function clearTouched() {
    touched.forEach(function (_anchor, el) { forget(el) })
    touched.clear()
  }

  function onPointerDown() {
    clearTouched()
    scheduleScan()
  }

  function onResize() {
    scheduleReposition()
    scheduleScan()
  }

  function onScroll(event) {
    // 输入区浮层的锚点不会随转录滚动移动；这里只兜住别的滚动容器。
    if (touched.size === 0) return
    if (event.target && event.target.nodeType === 1) scheduleReposition()
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
      document.addEventListener('scroll', onScroll, true)
      scheduleScan()
      return function () {
        disposed = true
        observer.disconnect()
        document.removeEventListener('pointerdown', onPointerDown, true)
        window.removeEventListener('resize', onResize)
        document.removeEventListener('scroll', onScroll, true)
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
