// dsh-webview-popover-fix host half: no-op.
//
// 本插件只做客户端（浏览器侧）工作：DSH 页面里用 CSS 锚定定位的浮层，在长转录场景
// 下会被算到视口外（垂直坐标减掉了「最大可滚动量」而不是当前 scrollTop）。宿主侧
// 不需要任何逻辑，纠偏全部在 iframe 内的 DOM 层完成。
export const name = 'dsh-webview-popover-fix'

export const inject = []

export function apply(_ctx) {}
