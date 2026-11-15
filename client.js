/**
 * dsh-deputy 浏览器半：把虚拟桌面做成一个「能看、能点」的浮窗。
 *
 * 契约（对齐 @deepseek-ai/dsh-client-modules 的 lazy-CJS factory）：
 *  - 本脚本被执行时只做一件事：window.__ModuleLoader__.load({ id, factory })。
 *    所有副作用（注入 CSS、注册插槽）都在 factory 物化时运行。
 *  - factory 拿到的 require 只认平台单例（react 等）与其它插件 ./client 入口，
 *    所以这里只 require("react")。
 *  - 导出面是 cordis 客户端插件：apply(ctx) + inject（等待的服务名）。
 *
 * 挂载点选 shell.overlay（整帧浮层，pointer-events 默认穿透，正是"常驻窗口"该待的地方）。
 * 数据面走宿主起的 127.0.0.1:17872，见 src/viewer.mjs。
 */
window.__ModuleLoader__.load({
  id: 'dsh-deputy',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useState, useEffect, useRef, useCallback } = React
    const h = React.createElement

    const CSS = `
.ddn-toggle{position:absolute;left:10px;bottom:10px;pointer-events:auto;z-index:22;display:flex;align-items:center;gap:6px;
  padding:6px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;cursor:pointer;font:inherit;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 2px 10px rgba(0,0,0,.18)}
.ddn-toggle:hover{border-color:var(--dsw-alias-brand-primary)}
.ddn-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-secondary)}
.ddn-dot[data-live="1"]{background:var(--dsw-alias-state-success-primary)}
.ddn-win{position:absolute;left:24px;bottom:56px;pointer-events:auto;z-index:23;display:flex;flex-direction:column;
  min-width:360px;min-height:260px;width:640px;height:420px;resize:both;overflow:hidden;
  border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);
  box-shadow:0 8px 32px rgba(0,0,0,.3);color:var(--dsw-alias-label-primary);font-size:12px}
.ddn-head{flex:none;display:flex;align-items:center;gap:8px;padding:7px 10px;cursor:move;user-select:none;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.ddn-title{font-weight:600;font-size:13px}
.ddn-spacer{flex:1}
.ddn-btn{padding:3px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;cursor:pointer;
  background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit}
.ddn-btn:hover{border-color:var(--dsw-alias-brand-primary)}
.ddn-stage{flex:1;position:relative;display:flex;align-items:center;justify-content:center;
  overflow:hidden;background:var(--dsw-alias-bg-layer-2)}
.ddn-img{max-width:100%;max-height:100%;image-rendering:pixelated;cursor:crosshair}
.ddn-empty{opacity:.75;text-align:center;padding:16px;line-height:1.6}
.ddn-foot{flex:none;display:flex;align-items:center;gap:8px;padding:6px 10px;
  border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;opacity:.85}
.ddn-tag{padding:1px 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-2)}
`

    const CSS_ID = 'dsh-deputy/viewer.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-deputy'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // 宿主端点。端口与 src/viewer.mjs 的 DEFAULT_VIEW_PORT 对齐。
    const BASE = 'http://127.0.0.1:17872'

    async function api(path, init) {
      const res = await fetch(BASE + path, { cache: 'no-store', ...(init ?? {}) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    function ViewerWindow(props) {
      const { onClose, onState } = props
      const [frame, setFrame] = useState(null)
      const [health, setHealth] = useState(null)
      const [err, setErr] = useState(null)
      const [pos, setPos] = useState(null)
      const imgRef = useRef(null)
      const dragRef = useRef(null)

      const pull = useCallback(async () => {
        try {
          const f = await api('/api/frame')
          if (f.ok) {
            setFrame(f)
            setErr(null)
          } else {
            setFrame(null)
            setErr(f.reason)
          }
        } catch (e) {
          setErr(String(e.message || e))
        }
      }, [])

      const beat = useCallback(async () => {
        try {
          const s = await api('/api/health')
          setHealth(s)
          if (onState) onState(s.state)
        } catch (e) {
          setHealth(null)
        }
      }, [onState])

      useEffect(() => {
        let alive = true
        const safePull = () => alive && pull()
        const safeBeat = () => alive && beat()
        safeBeat()
        safePull()
        // 700ms 一帧足够"手动点选"，也不至于把宿主 BitBlt 打满
        const t1 = setInterval(safePull, 700)
        const t2 = setInterval(safeBeat, 2500)
        return () => {
          alive = false
          clearInterval(t1)
          clearInterval(t2)
        }
      }, [pull, beat])

      // 拖窗：只认标题栏，避免拖动时吞掉画面里的点击
      const onHeadDown = (e) => {
        const el = e.currentTarget.parentElement
        const rect = el.getBoundingClientRect()
        dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
        setPos({ left: rect.left, top: rect.top })
        e.preventDefault()
      }
      useEffect(() => {
        if (!pos) return
        const move = (e) => {
          const d = dragRef.current
          if (!d) return
          setPos({ left: e.clientX - d.dx, top: e.clientY - d.dy })
        }
        const up = () => {
          dragRef.current = null
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        return () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
      }, [pos])

      const onClick = async (e) => {
        const img = imgRef.current
        if (!img || !frame) return
        const rect = img.getBoundingClientRect()
        const x = (e.clientX - rect.left) / rect.width
        const y = (e.clientY - rect.top) / rect.height
        if (x < 0 || x > 1 || y < 0 || y > 1) return
        try {
          const r = await api('/api/input', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'click', x, y, button: e.button === 2 ? 'right' : 'left' }),
          })
          if (!r.ok) setErr(r.reason)
          setTimeout(pull, 260)
        } catch (e2) {
          setErr(String(e2.message || e2))
        }
      }

      const open = async () => {
        try {
          const r = await api('/api/open', { method: 'POST' })
          if (!r.ok) setErr(r.reason)
          setTimeout(pull, 600)
        } catch (e) {
          setErr(String(e.message || e))
        }
      }

      const close = async () => {
        try {
          await api('/api/close', { method: 'POST' })
          setFrame(null)
        } catch (e) {
          setErr(String(e.message || e))
        }
      }

      const state = health && health.state ? health.state : 'unknown'
      const live = Boolean(frame)
      const style = pos ? { left: pos.left + 'px', top: pos.top + 'px', bottom: 'auto' } : undefined

      return h(
        'div',
        { className: 'ddn-win', style },
        h(
          'div',
          { className: 'ddn-head', onPointerDown: onHeadDown },
          h('span', { className: 'ddn-dot', 'data-live': live ? '1' : '0' }),
          h('span', { className: 'ddn-title' }, '虚拟桌面'),
          h('span', { className: 'ddn-tag' }, state),
          h('span', { className: 'ddn-spacer' }),
          h('button', { className: 'ddn-btn', onClick: open, title: '开隔离桌面（Windows 上会弹 UAC）' }, '打开'),
          h('button', { className: 'ddn-btn', onClick: close }, '收起'),
          h('button', { className: 'ddn-btn', onClick: pull }, '刷新'),
          h('button', { className: 'ddn-btn', onClick: onClose }, '×'),
        ),
        h(
          'div',
          { className: 'ddn-stage' },
          frame
            ? h('img', {
                ref: imgRef,
                className: 'ddn-img',
                alt: '隔离桌面',
                src: 'data:image/png;base64,' + frame.png,
                onClick: onClick,
                onContextMenu: (e) => {
                  e.preventDefault()
                  onClick(e)
                },
              })
            : h(
                'div',
                { className: 'ddn-empty' },
                h('div', null, err ? '未拿到画面：' + err : '还没有画面'),
                h('div', null, '点「打开」在隔离桌面里起一个桌面会话'),
                health && health.platform !== 'win32'
                  ? h('div', null, '（宿主平台是 ' + health.platform + '，真实桌面只在 Windows 上可用）')
                  : null,
              ),
        ),
        h(
          'div',
          { className: 'ddn-foot' },
          h('span', null, frame ? frame.width + '×' + frame.height : '—'),
          h('span', { className: 'ddn-spacer' }),
          h('span', null, '点画面 = 在隔离桌面里点一下'),
        ),
      )
    }

    function Toggle() {
      const [isOpen, setIsOpen] = useState(false)
      const [live, setLive] = useState(false)
      return h(
        React.Fragment,
        null,
        h(
          'button',
          { className: 'ddn-toggle', onClick: () => setIsOpen(!isOpen), title: '虚拟桌面面板' },
          h('span', { className: 'ddn-dot', 'data-live': live ? '1' : '0' }),
          h('span', null, '桌面'),
        ),
        isOpen
          ? h(ViewerWindow, {
              onClose: () => setIsOpen(false),
              onState: (s) => setLive(s === 'opened' || s === 'running'),
            })
          : null,
      )
    }

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              { name: 'shell.overlay', id: 'dsh-deputy-desktop', order: 90, label: '虚拟桌面' },
              Toggle,
            ),
          ),
        'dsh-deputy: desktop panel',
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.ViewerWindow = ViewerWindow
    exports.Toggle = Toggle

    return module.exports
  },
})
