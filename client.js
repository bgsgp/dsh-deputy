/**
 * dsh-deputy 的客户端半：把隔离桌面做成 DSH「应用」侧栏里的一页，并在那条侧栏行右侧挂一个状态点。
 *
 * 契约（对齐 @deepseek-ai/dsh-client-modules 的 lazy-CJS factory）：
 *  - 本脚本被执行时只做一件事：window.__ModuleLoader__.load({ id, factory })。
 *    所有副作用（注入 CSS、注册插槽）都在 factory 物化时运行。
 *  - factory 拿到的 require 只认平台单例（react 等）与其它插件 ./client 入口，
 *    所以这里只 require("react")。
 *  - 导出面是 cordis 客户端插件：apply(ctx) + inject（等待的服务名）。
 *
 * 挂载点（0.2.2 契约，见 @deepseek-ai/dsh-client-ui-sidebar/src/client/contract/slots.ts）：
 *  - sidebar.panellist：list 槽，每个 id 对应 main 里同 key 的一页；
 *    注册项 = { name, id, order, label } + 图标组件，图标收 { size, active }。
 *    侧栏自己渲染行、管选中和 More 菜单，插件只提供 id/顺序/文字/图标。
 *  - main：keyed 槽，注册项 = { name, key } + 页面组件；key 必须等于侧栏 id。
 *    点侧栏行 → ctx.layout.selectPanel(id) → 中央区切到这一页（本插件不直接调 layout）。
 *  - 行内没有「尾部插槽」，所以状态点是从图标组件里绝对定位出去的：
 *    最近的定位祖先是侧栏自己的 .panelEntry(position:relative)，right:7px 就是那一行的右端。
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

    /** 侧栏 id 与 main 页 key 共用的唯一标识。 */
    const PANEL_ID = 'dsh-deputy-desktop'
    /** 侧栏行文字；也是页面标题。 */
    const PANEL_LABEL = 'DSH操作电脑'

    const CSS = `
.ddp-page{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.ddp-head{flex:none;display:flex;align-items:center;gap:8px;padding:10px 14px;
  border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
.ddp-title{font-weight:600;font-size:14px}
.ddp-spacer{flex:1}
.ddp-tag{padding:1px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);
  font-size:11px;opacity:.9}
.ddp-tag[data-live="1"]{color:var(--dsw-alias-state-success-primary)}
.ddp-btn{padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;cursor:pointer;
  background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit}
.ddp-btn:hover{border-color:var(--dsw-alias-brand-primary)}
.ddp-btn:disabled{opacity:.5;cursor:wait}
.ddp-btn[data-primary="1"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.ddp-stage{flex:1;min-height:0;position:relative;display:flex;align-items:center;justify-content:center;
  overflow:auto;background:var(--dsw-alias-bg-layer-2)}
.ddp-img{max-width:100%;max-height:100%;image-rendering:pixelated;cursor:crosshair;
  box-shadow:0 6px 24px rgba(0,0,0,.28)}
.ddp-empty{max-width:560px;padding:24px;line-height:1.9;text-align:center;opacity:.9}
.ddp-empty b{font-size:15px;display:block;margin-bottom:6px;opacity:1}
.ddp-empty .ddp-actions{display:flex;gap:8px;justify-content:center;margin-top:14px;flex-wrap:wrap}
.ddp-foot{flex:none;display:flex;align-items:center;gap:10px;padding:7px 14px;
  border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;opacity:.85}
/* 侧栏状态点：在图标组件里绝对定位，祖先是侧栏行的 .panelEntry(position:relative) */
.ddp-dot{position:absolute;right:7px;top:50%;margin-top:-3px;width:6px;height:6px;border-radius:50%;
  pointer-events:none;transition:background-color .2s ease,opacity .15s ease;
  box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1)}
.ddp-dot[data-level="running"]{background:#22c55e}
.ddp-dot[data-level="error"]{background:#ef4444}
.ddp-dot[data-level="idle"]{background:#9ca3af}
/* 悬停时侧栏会显示 unpin 按钮，点让位 */
.panelEntry:hover .ddp-dot{opacity:0}
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

    const STATE_TEXT = {
      idle: '未打开',
      opened: '已打开',
      running: '运行中',
      closed: '已收起',
    }

    const BROWSER_TEXT = {
      stopped: '浏览器未启动',
      starting: '浏览器启动中',
      running: '浏览器运行中',
      paused: '浏览器组件被停用',
      error: '浏览器出错',
    }

    const LEVEL_TEXT = { running: '正在运行', error: '出现错误', idle: '未运行' }

    /**
     * 状态点数据源：os + browser 两个组件的合成状态，2s 轮询一次。
     * 侧栏图标与页面共用同一份订阅，避免一个页面开两套定时器。
     */
    const statusStore = {
      value: { level: 'idle', os: null, browser: null, error: null, at: 0 },
      subs: new Set(),
      timer: null,
      inflight: false,
    }

    function publishStatus(next) {
      statusStore.value = next
      for (const fn of statusStore.subs) {
        try {
          fn(next)
        } catch {
          /* 单个订阅者出错不影响其它人 */
        }
      }
    }

    async function refreshStatus() {
      if (statusStore.inflight) return
      statusStore.inflight = true
      try {
        const s = await api('/api/status')
        publishStatus({ level: s.level || 'idle', os: s.os || null, browser: s.browser || null, error: null, at: s.at || Date.now() })
      } catch (e) {
        // 连不上宿主 = 插件没在跑 / 端点没起，按灰点处理，但把原因留着给 title 看
        publishStatus({ level: 'idle', os: null, browser: null, error: String(e.message || e), at: Date.now() })
      } finally {
        statusStore.inflight = false
      }
    }

    function subscribeStatus(fn) {
      statusStore.subs.add(fn)
      fn(statusStore.value)
      if (!statusStore.timer) {
        statusStore.timer = setInterval(refreshStatus, 2000)
        refreshStatus()
      }
      return () => {
        statusStore.subs.delete(fn)
        if (statusStore.subs.size === 0 && statusStore.timer) {
          clearInterval(statusStore.timer)
          statusStore.timer = null
        }
      }
    }

    /**
     * 侧栏图标：显示器 + 指针 + 行右端状态点。收 { size, active }，用 currentColor 跟随主题。
     * @param {{size?: number, active?: boolean}} props
     */
    function DeputyIcon(props) {
      const size = props && props.size ? props.size : 18
      const active = Boolean(props && props.active)
      const [level, setLevel] = useState(statusStore.value.level)
      const [tip, setTip] = useState('')
      useEffect(
        () =>
          subscribeStatus((s) => {
            setLevel(s.level || 'idle')
            const parts = []
            if (s.os) parts.push('桌面：' + (STATE_TEXT[s.os.state] || s.os.state || '未知'))
            if (s.browser && s.browser.state && s.browser.state !== 'stopped') {
              parts.push(BROWSER_TEXT[s.browser.state] || ('浏览器：' + s.browser.state))
            }
            const err = (s.os && s.os.error) || (s.browser && s.browser.error) || s.error
            if (err) parts.push('错误：' + err)
            setTip((LEVEL_TEXT[s.level] || s.level) + (parts.length ? ' · ' + parts.join(' · ') : ''))
          }),
        [],
      )
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } },
        h(
          'svg',
          {
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            'aria-hidden': 'true',
            style: { opacity: active ? 1 : 0.82 },
          },
          h('rect', { x: 2.5, y: 3.5, width: 19, height: 13, rx: 2.2, stroke: 'currentColor', strokeWidth: 1.6 }),
          h('path', { d: 'M8 20.2h8', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
          h('path', { d: 'M12.6 9.4l5.2 2.1-2.2 1.1-1.1 2.2-1.9-5.4z', fill: 'currentColor' }),
        ),
        h('i', { className: 'ddp-dot', 'data-level': level, title: tip, 'aria-label': tip, role: 'img' }),
      )
    }

    /** 中央面板：整页展示隔离桌面，点画面 = 在隔离桌面里点一下。 */
    function DeputyPage() {
      const [frame, setFrame] = useState(null)
      const [health, setHealth] = useState(null)
      const [err, setErr] = useState(null)
      const [errCode, setErrCode] = useState(null)
      const [busy, setBusy] = useState(null)
      const [bus, setBus] = useState(statusStore.value)
      const imgRef = useRef(null)
      const mountedRef = useRef(true)
      const pullingRef = useRef(false)
      const beatingRef = useRef(false)

      const pull = useCallback(async () => {
        if (pullingRef.current) return
        pullingRef.current = true
        try {
          const f = await api('/api/frame')
          if (!mountedRef.current) return
          if (f.ok) {
            setFrame(f)
            setErr(null)
            setErrCode(null)
          } else {
            setFrame(null)
            setErr(f.reason)
            setErrCode(f.code ?? null)
          }
        } catch (e) {
          if (mountedRef.current) {
            setFrame(null) // 连接断开时不保留可点击的旧画面
            setErr(String(e.message || e))
            setErrCode(null)
          }
        } finally {
          pullingRef.current = false
        }
      }, [])

      const beat = useCallback(async () => {
        if (beatingRef.current) return
        beatingRef.current = true
        try {
          const s = await api('/api/health')
          if (!mountedRef.current) return
          setHealth((prev) =>
            prev && prev.platform === s.platform && prev.state === s.state && prev.name === s.name && prev.pid === s.pid
              ? prev
              : s,
          )
        } catch (e) {
          if (mountedRef.current) setHealth(null)
        } finally {
          beatingRef.current = false
        }
      }, [])

      useEffect(() => {
        mountedRef.current = true
        beat()
        pull()
        // 700ms 一帧足够"手动点选"；请求未完成时下一轮直接跳过，不叠加。
        const t1 = setInterval(pull, 700)
        const t2 = setInterval(beat, 2500)
        const off = subscribeStatus(setBus)
        return () => {
          mountedRef.current = false
          clearInterval(t1)
          clearInterval(t2)
          off()
        }
      }, [pull, beat])

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

      const post = useCallback(
        async (path, body, tag) => {
          if (busy) return null
          setBusy(tag)
          try {
            const r = await api(path, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body ?? {}),
            })
            if (!mountedRef.current) return null
            if (!r.ok) setErr(r.reason)
            else setErr(null)
            await beat()
            setTimeout(pull, tag === 'launch' ? 1200 : 600)
            return r
          } catch (e) {
            if (mountedRef.current) setErr(String(e.message || e))
            return null
          } finally {
            if (mountedRef.current) setBusy(null)
          }
        },
        [busy, beat, pull],
      )

      const open = () => post('/api/open', {}, 'open')
      const close = () => {
        setFrame(null)
        setErr(null)
        setErrCode(null)
        return post('/api/close', {}, 'close')
      }
      const launch = (app) => post('/api/launch', { app }, 'launch')

      const state = health && health.state ? health.state : 'unknown'
      const live = Boolean(frame)
      const isWin = !health || health.platform === 'win32'
      const openState = state === 'opened' || state === 'running'
      const browserText = bus && bus.browser ? BROWSER_TEXT[bus.browser.state] || bus.browser.state : null

      return h(
        'section',
        { className: 'ddp-page' },
        h(
          'header',
          { className: 'ddp-head' },
          h('span', { className: 'ddp-title' }, PANEL_LABEL),
          h('span', { className: 'ddp-tag', 'data-live': live ? '1' : '0' }, STATE_TEXT[state] || state),
          health && health.name ? h('span', { className: 'ddp-tag' }, health.name) : null,
          browserText ? h('span', { className: 'ddp-tag', 'data-live': bus.browser.state === 'running' ? '1' : '0' }, browserText) : null,
          h('span', { className: 'ddp-spacer' }),
          h('button', { className: 'ddp-btn', type: 'button', onClick: open, disabled: Boolean(busy) || !isWin, title: '开隔离桌面（Windows 上会弹 UAC）' }, busy === 'open' ? '打开中…' : '打开桌面'),
          h('button', { className: 'ddp-btn', type: 'button', onClick: () => launch('edge'), disabled: Boolean(busy) || !openState, title: '在隔离桌面里启动 Edge' }, busy === 'launch' ? '启动中…' : '启动 Edge'),
          h('button', { className: 'ddp-btn', type: 'button', onClick: () => launch('notepad'), disabled: Boolean(busy) || !openState, title: '在隔离桌面里启动记事本' }, '记事本'),
          h('button', { className: 'ddp-btn', type: 'button', onClick: pull }, '刷新'),
          h('button', { className: 'ddp-btn', type: 'button', onClick: close, disabled: Boolean(busy) || !openState }, '收起桌面'),
        ),
        h(
          'div',
          { className: 'ddp-stage' },
          frame
            ? h('img', {
                ref: imgRef,
                className: 'ddp-img',
                alt: '隔离桌面画面',
                src: 'data:image/png;base64,' + frame.png,
                onClick: onClick,
                onContextMenu: (e) => {
                  e.preventDefault()
                  onClick(e)
                },
              })
            : h(
                'div',
                { className: 'ddp-empty' },
                h('b', null, errCode === 'NOWINDOW' ? '桌面里还没有窗口' : err ? '未拿到画面' : '还没有画面'),
                h(
                  'div',
                  null,
                  errCode === 'NOWINDOW'
                    ? '隔离桌面已经打开了，但里面没有任何程序。启动一个程序就会出画面（隔离桌面没有系统合成，只能逐窗口截图）。'
                    : err
                      ? err
                      : '点上方「打开桌面」，让宿主在隔离桌面里起一个桌面会话',
                ),
                errCode === 'NOWINDOW'
                  ? h(
                      'div',
                      { className: 'ddp-actions' },
                      h('button', { className: 'ddp-btn', type: 'button', onClick: () => launch('edge'), disabled: Boolean(busy) }, busy === 'launch' ? '启动中…' : '启动 Edge'),
                      h('button', { className: 'ddp-btn', type: 'button', onClick: () => launch('notepad'), disabled: Boolean(busy) }, '启动记事本'),
                    )
                  : null,
                h('div', null, '之后这页每 0.7 秒刷新一次；点画面 = 在隔离桌面里点一下'),
                !isWin ? h('div', null, '（宿主平台是 ' + health.platform + '，真实桌面只在 Windows 上可用）') : null,
              ),
        ),
        h(
          'footer',
          { className: 'ddp-foot' },
          h('span', null, frame ? frame.width + '×' + frame.height : '—'),
          h('span', null, health && health.pid ? 'pid ' + health.pid : '无会话'),
          h('span', null, bus && bus.browser && bus.browser.state === 'running' ? '浏览器 pid ' + (bus.browser.detail || '—') : ''),
          h('span', { className: 'ddp-spacer' }),
          h('span', null, '所有点击只落在隔离桌面，不碰你当前的主桌面'),
        ),
      )
    }

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: PANEL_LABEL },
              DeputyIcon,
            ),
          ),
        'dsh-deputy: sidebar entry',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: PANEL_ID }, DeputyPage),
          ),
        'dsh-deputy: desktop page',
      )
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.PANEL_ID = PANEL_ID
    exports.PANEL_LABEL = PANEL_LABEL
    exports.DeputyIcon = DeputyIcon
    exports.DeputyPage = DeputyPage
    exports.subscribeStatus = subscribeStatus

    return module.exports
  },
})
