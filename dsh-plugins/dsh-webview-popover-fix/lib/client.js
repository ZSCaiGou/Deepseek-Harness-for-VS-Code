// dsh-webview-popover-fix client half.
//
// 背景：DSH 0.2.2-rc.x 的浮层（role="dialog"）改用 CSS 锚定定位，并把垂直坐标
// 减去了「最大可滚动量」(scrollHeight - clientHeight)，而不是当前 scrollTop。
// 实测公式：dialogTop ≈ C - (scrollHeight - clientHeight)。于是长转录（转录越高、
// 可滚动量越大）会把浮层推到视口外几万像素处：元素在 DOM 里、样式也正常，但看不见、
// 点不到——典型表现为「命令菜单/权限/模型/Token 用量点不开」「问答卡片卡住」。
//
// 本插件只做一件事：浮层出现在视口外时，按锚点元素把它的位置纠正回视口内。
// 不搬 DOM（避免 React 事件委托失效），只写内联样式；等下一次 pointerdown 时
// 清掉自己写的样式，让框架按原逻辑重新定位（如果原逻辑正常，就不再干预）。
window.__ModuleLoader__.load({ id: 'dsh-webview-popover-fix', factory: function () {
  var module = { exports: {} }
  var exports = module.exports

  var MARGIN = 8          // 与视口边缘的最小间距
  var MAX_HEIGHT_RATIO = 0.7
  var SELECTOR = '[role="dialog"],[popover],[style*="position-anchor"]'
  var Z_INDEX = '2000'
  var APPLIED = [
    'position-anchor', 'position-area', 'position-try-fallbacks',
    'position', 'left', 'top', 'right', 'bottom', 'max-height', 'z-index'
  ]

  /** 曾经被本插件改过的元素（下次交互前清掉，避免污染框架自己的定位）。 */
  var touched = new Set()
  var scheduled = false
  var disposed = false

  /** 视口矩形是否与可见区域有交集（宽或高为 0 的元素视为未显示）。 */
  function visible(el) {
    var style = window.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
    var rect = el.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) return false
    return rect.bottom > MARGIN
      && rect.top < window.innerHeight - MARGIN
      && rect.right > MARGIN
      && rect.left < window.innerWidth - MARGIN
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

  /** 把元素纠正到视口内（优先贴锚点上方，放不下则贴下方，最后做视口内 clamp）。 */
  function rescue(el) {
    var rect = el.getBoundingClientRect()
    var width = Math.min(Math.max(rect.width, 200), window.innerWidth - MARGIN * 2)
    var maxHeight = Math.round(window.innerHeight * MAX_HEIGHT_RATIO)
    var height = Math.min(rect.height > 2 ? rect.height : maxHeight, maxHeight)
    var left
    var top
    var anchor = findAnchor(el)
    if (anchor !== null) {
      var anchorRect = anchor.getBoundingClientRect()
      left = anchorRect.right - width
      top = anchorRect.top - height - MARGIN
      if (top < MARGIN) top = anchorRect.bottom + MARGIN
    } else {
      left = window.innerWidth - width - MARGIN
      top = window.innerHeight - height - MARGIN
    }
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
    return true
  }

  /** 扫描所有可见浮层，只处理「在视口外」的那些。 */
  function scan() {
    if (disposed) return
    var dialogs = document.querySelectorAll(SELECTOR)
    for (var i = 0; i < dialogs.length; i += 1) {
      var el = dialogs[i]
      if (el.nodeType !== 1) continue
      if (el.getBoundingClientRect().width < 2) continue
      if (visible(el)) continue
      if (el.style.display === 'none') continue
      try {
        rescue(el)
      } catch (error) {
        console.error('[dsh-webview-popover-fix] rescue failed:', error)
      }
    }
  }

  function scheduleScan() {
    if (scheduled || disposed) return
    scheduled = true
    // 两帧：先让框架完成插入与首次布局，再纠正。
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () {
        scheduled = false
        scan()
      })
    })
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
      // 首屏已有浮层（例如被框架恢复的）也检查一次。
      scheduleScan()
      return function () {
        disposed = true
        observer.disconnect()
        document.removeEventListener('pointerdown', onPointerDown, true)
        window.removeEventListener('resize', onResize)
        clearTouched()
      }
    })
  }

  exports.apply = apply
  exports.inject = []
  return module.exports
} })
