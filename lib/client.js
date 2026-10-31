/**
 * dsh-zcode-native — client half (M2).
 *
 * M0 registered one `settings.section` card. M2 adds:
 *   · a right-sidebar tab (`sidebarRightTabs.register` + the
 *     `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` slots) rendering
 *     a status board. The board is fed ONLY by the local loopback route
 *     GET /plugins/dsh-zcode-native/status (same-origin, no token). It never
 *     talks to the ZCode CDP endpoint or zcode.z.ai directly — that is the
 *     host half's job.
 *   · a toggle inside that settings card that registers/disposes the tab. The
 *     card is registered UNCONDITIONALLY: if it lived inside the toggle's own
 *     registration, switching off would hide the only switch that could turn
 *     the tab back on.
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
 * 4. `settings.plugin.item` does not exist in DSH 0.2.1-rc.2 (measured
 *    count = 0); the settings card uses `settings.section`.
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
    const STATUS_ROUTE = '/plugins/dsh-zcode-native/status'
    const STORAGE_KEY = 'dsh-zcode-native:sidebar'
    const REFRESH_MS = 60 * 1000

    /** Sidebar visibility preference; anything but 'off' (incl. absent) is on. */
    function readSidebarPref() {
      try {
        return window.localStorage.getItem(STORAGE_KEY) !== 'off'
      } catch {
        return true
      }
    }

    /** Applied by the settings card's toggle; reassigned inside apply(). */
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

    // ---- rendering ----------------------------------------------------------

    const styles = {
      root: { padding: '12px', fontSize: '12px', lineHeight: 1.7 },
      row: { display: 'flex', gap: '8px' },
      label: { flex: '0 0 48px', opacity: 0.6 },
      error: { color: '#c0392b' },
      footer: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px', opacity: 0.65 },
      button: { fontSize: '12px', padding: '2px 10px', cursor: 'pointer' },
    }

    function span(text, style) {
      return React.createElement('span', { style }, text)
    }

    function row(label, valueNode) {
      return React.createElement(
        'div',
        { style: styles.row, key: label },
        React.createElement('span', { style: styles.label }, label),
        valueNode,
      )
    }

    function renderBoard(data) {
      const rows = []

      const account = data?.account
      rows.push(
        row(
          '账号',
          account?.error
            ? span(`凭据读取失败：${account.error}`, styles.error)
            : span(
                `${account?.displayName ?? account?.username ?? '未登录 / 未知'}${
                  account?.id ? ` (${account.id})` : ''
                }`,
              ),
        ),
      )

      const plan = data?.plan
      let planNode
      if (!plan) planNode = span('—')
      else if (!plan.authenticated) planNode = span(plan.error ?? '未认证', styles.error)
      else if (Array.isArray(plan.plans) && plan.plans.length > 0) {
        const first = plan.plans[0]
        const countdown = formatCountdown(first.endsAt)
        planNode = span(
          `${first.name ?? '套餐'}${first.status ? ` · ${first.status}` : ''}${
            countdown ? ` · ${countdown}` : ''
          }`,
        )
      } else planNode = span('无套餐')
      rows.push(row('套餐', planNode))

      const balance = data?.balance
      let balanceNode
      if (!balance) balanceNode = span('—')
      else if (balance.available === false) {
        // NEVER render a fake 0 — surface the real reason the value is missing.
        balanceNode = span(`余额不可用（${balance.reason ?? '未知原因'}）`, styles.error)
      } else if (Array.isArray(balance.balances) && balance.balances.length > 0) {
        balanceNode = span(
          balance.balances
            .map((bucket) => `${bucket.showName ?? '余额'}: ${bucket.remainingUnits ?? '?'}`)
            .join('；'),
        )
      } else balanceNode = span('无余额条目')
      rows.push(row('余额', balanceNode))

      const client = data?.client
      rows.push(
        row(
          '客户端',
          client?.reachable
            ? span(`${client.appVersion ?? client.browser ?? '?'} · 可达`)
            : span(`不可达：${client?.reason ?? '未知原因'}`, styles.error),
        ),
      )

      const catalog = data?.catalog
      rows.push(
        row('模板', Array.isArray(catalog) ? span(`${catalog.length} 个`) : span(catalog?.error ?? '不可用', styles.error)),
      )

      return rows
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

      const rows = state.data ? renderBoard(state.data) : []

      return React.createElement(
        'div',
        { style: styles.root },
        state.error
          ? React.createElement(
              'div',
              { style: styles.error, key: 'error' },
              `状态获取失败：${state.error}${state.data ? '（显示的是上次成功数据）' : ''}`,
            )
          : null,
        state.phase === 'loading' && !state.data
          ? React.createElement('div', { key: 'loading' }, '加载中…')
          : null,
        rows.length > 0 ? React.createElement('div', { key: 'rows' }, rows) : null,
        React.createElement(
          'div',
          { style: styles.footer, key: 'footer' },
          React.createElement('span', null, state.at ? `更新于 ${clock(state.at)}` : '尚未获取到数据'),
          React.createElement('button', { style: styles.button, onClick: refresh }, '刷新'),
        ),
      )
    }

    /**
     * The host renders this inside its own tab button, so a click on the tab
     * fires here too — use it as the "tab became visible" hint (throttled).
     */
    function PanelTitle() {
      return React.createElement('span', {
        onClick: () => {
          const now = Date.now()
          if (sharedRefresh && now - lastTabClickFetch > 2000) {
            lastTabClickFetch = now
            sharedRefresh()
          }
        },
      }, 'ZCode')
    }

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
        syncSidebarRef(next)
      }

      return React.createElement(
        'label',
        { style: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' } },
        React.createElement('input', { type: 'checkbox', checked: enabled, onChange: onToggle }),
        React.createElement('span', null, '在右侧边栏显示 ZCode 看板'),
      )
    }

    // ---- assembly -----------------------------------------------------------

    function apply(ctx) {
      let disposeTab = null

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

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          { name: 'settings.section', id: 'zcode-native', order: 90, label: () => 'ZCode Native' },
          ZcodeNativeSection,
        ),
      )

      // Cross-window sync: another DSH window flipping the toggle fires 'storage'.
      ctx.effect(() => {
        const onStorage = (event) => {
          if (event.key === STORAGE_KEY || event.key === null) syncSidebar(readSidebarPref())
        }
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
      }, 'zcode-native: sidebar toggle storage listener')

      console.log('[zcode-native] client active (M2)')
    }

    exports.inject = ['slots', 'sidebarRightTabs']
    exports.apply = apply
    return module.exports
  },
})
