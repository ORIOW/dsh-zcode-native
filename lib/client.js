/**
 * dsh-zcode-native — client half (M2/UI).
 *
 * Registers exactly two surfaces:
 *   · a right-sidebar tab (`sidebarRightTabs.register` + the
 *     `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` slots) rendering
 *     a status board. The board is fed ONLY by the local loopback route
 *     GET /plugins/dsh-zcode-native/status (same-origin, no token). It never
 *     talks to the ZCode CDP endpoint or zcode.z.ai directly — that is the
 *     host half's job.
 *   · a bundle-config slot (BUNDLE_CONFIG_SLOT below) keyed by THIS PACKAGE'S
 *     NAME, which the DSH 0.14.0 plugin manager renders on the bundle detail page
 *     (插件 → 已安装 → dsh-zcode-native). It answers ONLY the 'page' view:
 *     the host also queries the 'summary' view, and any element returned
 *     there is painted into the summary strip, so summary/unknown → null.
 *     The page holds the sidebar toggle (above) and the status board (below).
 *     The toggle itself is registered UNCONDITIONALLY: if it lived inside the
 *     toggle's own registration, switching off would hide the only switch
 *     that could turn the tab back on. A pref=off sidebar (all three tab
 *     registrations disposed) therefore still renders this page, which shows
 *     the toggle so the tab can be re-enabled from the plugin page.
 *
 * There is deliberately no separate panel module: the client half is NOT
 * bundled, and the host injects only the bytes that `exports["./client"]`
 * resolves to, so any other file under lib/ would never reach the page.
 *
 * WHY THE `__ModuleLoader__.load` ENVELOPE IS MANDATORY
 * ----------------------------------------------------
 * `dsh-client-modules` reads the file at the path `exports["./client"]`
 * resolves to, strips only the sourceMappingURL tail, and injects it as a
 * plain <script> with no `type="module"`. The bytes therefore run as a
 * CLASSIC SCRIPT. Measured consequences of an `import`/`export` statement
 * here: `SyntaxError: Cannot use import statement outside a module`, the
 * entry never calls `__ModuleLoader__.load`, and the whole web plugin
 * startup fails (`web boot: N entries did not activate`) — not just this
 * card. `require` is legal only as the `factory` argument.
 *
 * CONTRACTS
 * ---------
 * 1. `inject: ['slots', 'sidebarRightTabs']` — the two services this half
 *    touches. `ctx.effect` is a cordis built-in verb (not a service); React
 *    comes from the platform seed. `dsh.client.inject` in package.json is a
 *    DIFFERENT mechanism and does not replace this runtime list.
 * 2. `ctx.slots.register(spec, Component)` — the component is the SECOND
 *    argument; the spec has no `render` key.
 * 3. The three sidebar-tab registrations share ONE key (TAB_ID), matching the
 *    contract recovered from the host asar.
 * 4. The bundle-config slot's key is the PACKAGE NAME (`dsh-zcode-native`),
 *    not the module id and not a locale namespace — measured against the
 *    shipped dshmarket client (profiles/desktop/node_modules). `plugins.row.
 *    config` needs a patch-declared row, which this single-line bundle does
 *    not have, so it is NOT used.
 * 5. Styling: one <style> element injected in apply() (guarded — the vm test
 *    sandbox has no document). Colors come from host tokens, currentColor,
 *    color-mix(), and light-dark(oklch…) pairs — no literal hex values, no
 *    box-shadow, no backdrop-filter, no external fonts.
 *
 * @module dsh-zcode-native/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-zcode-native',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const TAB_ID = 'zcode-native'
    const PACKAGE_ID = 'dsh-zcode-native'
    const STATUS_ROUTE = '/plugins/dsh-zcode-native/status'
    const STORAGE_KEY = 'dsh-zcode-native:sidebar'
    const BUNDLE_CONFIG_SLOT = 'plugins.bundle.config'
    const REFRESH_MS = 60 * 1000
    const STYLE_ID = 'dsh-zcode-native-style'

    /** Sidebar visibility preference; anything but 'off' (incl. absent) is on. */
    function readSidebarPref() {
      try {
        return window.localStorage.getItem(STORAGE_KEY) !== 'off'
      } catch {
        return true
      }
    }

    /** Applied by the bundle-page toggle; reassigned inside apply(). */
    let syncSidebarRef = () => {}

    /** Set by the mounted PanelBody so the tab title can trigger a refresh. */
    let sharedRefresh = null
    let lastTabClickFetch = 0

    // ---- formatting ---------------------------------------------------------

    /** plan.endsAt is epoch SECONDS. */
    function formatCountdown(endsAt) {
      const seconds = Number(endsAt)
      if (!Number.isFinite(seconds)) return null
      const remaining = seconds * 1000 - Date.now()
      if (remaining <= 0) return '已过期'
      const totalMinutes = Math.floor(remaining / 60000)
      return `剩 ${Math.floor(totalMinutes / 60)} 小时 ${totalMinutes % 60} 分`
    }

    function clock(at) {
      const date = at instanceof Date ? at : new Date(at)
      return Number.isNaN(date.getTime()) ? '—' : date.toTimeString().slice(0, 8)
    }

    // ---- styling ------------------------------------------------------------
    // All colors derive from host tokens / currentColor / system-adaptive
    // functions; the two status hues use light-dark(oklch…) pairs declared on
    // the card root (with `color-scheme: light dark`) so they track the host
    // theme instead of hardcoding a paint for one mode.

    const CSS_TEXT = `
.zkn-stack { display: flex; flex-direction: column; gap: var(--dsh-sidebar-label-gap); }
.zkn-card {
  --zkn-ok: light-dark(oklch(54% 0.13 150), oklch(72% 0.13 150));
  --zkn-bad: light-dark(oklch(55% 0.18 27), oklch(68% 0.16 27));
  color-scheme: light dark;
  display: flex;
  flex-direction: column;
  gap: var(--dsh-sidebar-label-gap);
  padding: var(--dsh-sidebar-paint-inset);
  font-size: var(--dsh-content-font-size-secondary);
}
.zkn-head { display: flex; align-items: center; gap: calc(var(--dsh-sidebar-label-gap) * 0.75); }
.zkn-head > .zkn-refresh { margin-left: auto; }
.zkn-title { margin: 0; font-size: var(--dsh-content-font-size); font-weight: 600; }
.zkn-status { display: inline-flex; align-items: center; gap: calc(var(--dsh-sidebar-label-gap) * 0.5); }
.zkn-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.zkn-status-up { color: var(--zkn-ok); }
.zkn-status-error { color: var(--zkn-bad); }
.zkn-status-down, .zkn-status-pending { opacity: 0.7; }
.zkn-body { display: flex; flex-direction: column; }
.zkn-row { display: flex; align-items: baseline; gap: var(--dsh-sidebar-label-gap); padding: var(--dsh-sidebar-row-padding); }
.zkn-row + .zkn-row { border-top: 1px solid color-mix(in oklab, currentColor 14%, transparent); }
.zkn-who { display: flex; flex-direction: column; align-items: baseline; gap: 2px; }
.zkn-strong { font-size: var(--dsh-content-font-size); }
.zkn-num { font-size: var(--dsh-code-font-size); font-variant-numeric: tabular-nums; }
.zkn-dim { opacity: 0.72; }
.zkn-error { color: var(--zkn-bad); }
.zkn-alert, .zkn-empty { margin: 0; }
.zkn-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--dsh-sidebar-label-gap);
  font-size: calc(var(--dsh-content-font-size-secondary) * var(--dsh-content-font-delta));
  opacity: 0.65;
}
.zkn-toggle, .zkn-refresh {
  font: inherit;
  color: inherit;
  cursor: pointer;
  background: color-mix(in oklab, currentColor 6%, transparent);
  border: 1px solid color-mix(in oklab, currentColor 20%, transparent);
  border-radius: 6px;
  padding: 2px 10px;
}
.zkn-toggle:hover, .zkn-refresh:hover { background: color-mix(in oklab, currentColor 12%, transparent); }
.zkn-toggle[aria-pressed='true'] {
  background: color-mix(in oklab, currentColor 14%, transparent);
  border-color: color-mix(in oklab, currentColor 35%, transparent);
}
.zkn-toggle:focus-visible, .zkn-refresh:focus-visible {
  outline: 2px solid var(--dsh-button-outline-color);
  outline-offset: 2px;
}
@media (prefers-reduced-motion: no-preference) {
  .zkn-toggle, .zkn-refresh, .zkn-status, .zkn-body { transition: opacity 150ms ease, transform 150ms ease; }
  .zkn-toggle:active, .zkn-refresh:active { transform: translateY(1px); }
}
`

    /** Inject the stylesheet once; the sidebar tab mounts/unmounts repeatedly. */
    function injectStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS_TEXT
      document.head.appendChild(style)
    }

    function el(tag, props, ...children) {
      return React.createElement(tag, props, ...children)
    }

    // ---- rendering ----------------------------------------------------------

    function planNode(plan) {
      if (!plan) return el('span', { className: 'zkn-dim' }, '套餐信息缺失')
      if (!plan.authenticated) {
        return el('span', { className: 'zkn-error' }, `套餐认证错误：${plan.error ?? '未认证'}`)
      }
      if (Array.isArray(plan.plans) && plan.plans.length > 0) {
        const first = plan.plans[0]
        const countdown = formatCountdown(first.endsAt)
        return el(
          'span',
          null,
          `${first.name ?? '套餐'}${first.status ? ` · ${first.status}` : ''}`,
          countdown ? el('span', { className: 'zkn-num zkn-dim' }, ` · ${countdown}`) : null,
        )
      }
      return el('span', { className: 'zkn-dim' }, '无套餐')
    }

    function balanceNode(balance) {
      if (!balance) return el('span', { className: 'zkn-dim' }, '—')
      if (balance.available === false) {
        // NEVER render a fake 0 — surface the real reason the value is missing.
        return el('span', { className: 'zkn-dim' }, `余额不可用（${balance.reason ?? '未知原因'}）`)
      }
      if (Array.isArray(balance.balances) && balance.balances.length > 0) {
        return el(
          'span',
          null,
          balance.balances
            .map((bucket) => `${bucket.showName ?? '余额'}: ${bucket.remainingUnits ?? '?'}`)
            .join('；'),
        )
      }
      return el('span', { className: 'zkn-dim' }, '无余额条目')
    }

    function PanelBody() {
      const [state, setState] = React.useState({ phase: 'loading', data: null, error: null, at: null })

      const refresh = React.useCallback(() => {
        setState((prev) => ({ ...prev, phase: prev.data ? 'refreshing' : 'loading' }))
        fetch(STATUS_ROUTE, { headers: { accept: 'application/json' } })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            return response.json()
          })
          .then((data) => setState({ phase: 'ready', data, error: null, at: new Date() }))
          .catch((error) => {
            setState((prev) => ({
              phase: 'error',
              data: prev.data,
              error: error && error.message ? error.message : String(error),
              at: prev.at,
            }))
          })
      }, [])

      React.useEffect(() => {
        sharedRefresh = refresh
        refresh()
        const timer = window.setInterval(refresh, REFRESH_MS)
        return () => {
          window.clearInterval(timer)
          if (sharedRefresh === refresh) sharedRefresh = null
        }
      }, [refresh])

      const data = state.data
      const account = data?.account
      const client = data?.client
      const catalog = data?.catalog

      // Connection dot: the fetch error wins (data may be stale-but-shown);
      // otherwise the client half's reachability decides.
      let connClass = 'pending'
      let connText = '读取中'
      if (state.error) {
        connClass = 'error'
        connText = '错误'
      } else if (data) {
        connClass = client?.reachable ? 'up' : 'down'
        connText = client?.reachable ? '已连上' : '未运行'
      }

      const rows = []

      rows.push(
        el(
          'div',
          { className: 'zkn-row', key: 'who' },
          account?.error
            ? el('span', { className: 'zkn-error' }, `凭据读取错误：${account.error}`)
            : el(
                'div',
                { className: 'zkn-who' },
                el(
                  'span',
                  { className: 'zkn-strong' },
                  `${account?.displayName ?? account?.username ?? '未登录 / 未知'}${
                    account?.id ? ` (${account.id})` : ''
                  }`,
                ),
                planNode(data?.plan),
              ),
        ),
      )

      rows.push(
        el(
          'div',
          { className: 'zkn-row', key: 'balance' },
          el('span', { className: 'zkn-dim' }, '余额'),
          balanceNode(data?.balance),
        ),
      )

      const clientNode = !client
        ? el('span', { className: 'zkn-dim' }, '客户端：—')
        : client.reachable
          ? el('span', null, `客户端 ${client.appVersion ?? client.browser ?? '?'}`)
          : el('span', { className: 'zkn-dim' }, `客户端不可达：${client.reason ?? '未知原因'}`)
      const catalogNode = Array.isArray(catalog)
        ? el('span', null, `模板 ${catalog.length} 个`)
        : el('span', { className: 'zkn-dim' }, `模板不可用：${catalog?.error ?? '未知原因'}`)
      const stamp = state.at
        ? state.error
          ? `数据来自 ${clock(state.at)}`
          : `更新于 ${clock(state.at)}`
        : '尚未获取到数据'

      return el(
        'article',
        { className: 'zkn-card' },
        el(
          'header',
          { className: 'zkn-head' },
          el('h3', { className: 'zkn-title' }, 'ZCode'),
          el(
            'span',
            { className: `zkn-status zkn-status-${connClass}`, role: 'status' },
            el('span', { className: 'zkn-dot', 'aria-hidden': 'true' }),
            connText,
          ),
          el('button', { type: 'button', className: 'zkn-refresh', onClick: refresh }, '刷新'),
        ),
        state.error
          ? el(
              'p',
              { className: 'zkn-alert zkn-error', key: 'alert' },
              `状态获取错误：${state.error}${data ? '（显示的是上次成功数据）' : ''}`,
            )
          : null,
        state.phase === 'loading' && !data
          ? el('p', { className: 'zkn-empty zkn-dim', key: 'loading' }, '读取中…')
          : null,
        el('div', { className: 'zkn-body', key: 'body' }, rows),
        el('footer', { className: 'zkn-foot', key: 'foot' }, clientNode, catalogNode, el('span', { className: 'zkn-num' }, stamp)),
      )
    }

    /**
     * The host renders this inside its own tab button, so a click on the tab
     * fires here too — use it as the "tab became visible" hint (throttled).
     */
    function PanelTitle() {
      return el(
        'span',
        {
          onClick: () => {
            const now = Date.now()
            if (sharedRefresh && now - lastTabClickFetch > 2000) {
              lastTabClickFetch = now
              sharedRefresh()
            }
          },
        },
        'ZCode',
      )
    }

    /** The bundle-page toggle: a real <button aria-pressed>, no checkbox. */
    function ZcodeNativeSection() {
      const [enabled, setEnabled] = React.useState(readSidebarPref)

      React.useEffect(() => {
        const onStorage = (event) => {
          if (event.key === STORAGE_KEY) setEnabled(readSidebarPref())
        }
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
      }, [])

      const onToggle = () => {
        const next = !enabled
        setEnabled(next)
        try {
          window.localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off')
        } catch {
          /* private mode etc. — the in-memory toggle still works for this window */
        }
        // Same page, same node: focus stays on the button across re-render.
        syncSidebarRef(next)
      }

      // The visible 开/关 text is the non-color state indicator; aria-pressed
      // carries the same fact to assistive technology.
      return el(
        'button',
        { type: 'button', className: 'zkn-toggle', 'aria-pressed': enabled, onClick: onToggle },
        `侧栏看板：${enabled ? '已开启' : '已关闭'}`,
      )
    }

    /**
     * Bundle-config component. The host asks for BOTH views; only
     * 'page' may paint — a summary-view element lands in the bundle list
     * strip, which is the wrong place.
     */
    function BundleConfigPage(ownerProps) {
      if (!ownerProps || ownerProps.view !== 'page') return null
      return el(
        'section',
        { className: 'zkn-stack' },
        el(ZcodeNativeSection, null),
        el(PanelBody, null),
      )
    }

    // ---- assembly -----------------------------------------------------------

    function apply(ctx) {
      let disposeTab = null

      injectStyles()

      const registerSidebarTab = () => {
        const disposers = []
        const push = (disposer) => {
          if (typeof disposer === 'function') disposers.push(disposer)
        }

        push(
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: 'zcode-native',
            priority: 'extension',
            title: () => 'ZCode',
            guide: [{ order: 80, title: () => 'ZCode 看板', description: () => '账号 / 套餐 / 余额 / 客户端状态' }],
          }),
        )
        push(
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, PanelBody)),
        )
        push(
          ctx.slots.inject('sidebar.right.pane.tab.title', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, PanelTitle)),
        )

        // Reverse order: inner registrations before the inject that produced them.
        // `slots.inject` itself returns the disposer for its registration (same
        // pattern the shipped dsh-zcode-connect uses) — pushing the register
        // disposer separately would dispose the same slot twice.
        return () => {
          for (let i = disposers.length - 1; i >= 0; i--) {
            try {
              disposers[i]()
            } catch (error) {
              console.log(`[zcode-native] tab disposer failed: ${error && error.message}`)
            }
          }
        }
      }

      const syncSidebar = (enabled) => {
        if (enabled && disposeTab === null) {
          disposeTab = registerSidebarTab()
        } else if (!enabled && disposeTab !== null) {
          const dispose = disposeTab
          disposeTab = null
          dispose()
        }
      }
      syncSidebarRef = syncSidebar

      // Default is ON — a missing preference must not hide the tab.
      syncSidebar(readSidebarPref())

      ctx.slots.inject(BUNDLE_CONFIG_SLOT, () =>
        ctx.slots.register({ name: BUNDLE_CONFIG_SLOT, key: PACKAGE_ID }, BundleConfigPage))

      // Cross-window sync: another DSH window flipping the toggle fires 'storage'.
      ctx.effect(() => {
        const onStorage = (event) => {
          if (event.key === STORAGE_KEY || event.key === null) syncSidebar(readSidebarPref())
        }
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
      }, 'zcode-native: sidebar toggle storage listener')

      console.log('[zcode-native] client active (M2/UI)')
    }

    exports.inject = ['slots', 'sidebarRightTabs']
    exports.apply = apply
    return module.exports
  },
})
