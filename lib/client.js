/**
 * dsh-power-button — browser half.
 *
 * Two independent power affordances, both rendered for the page lifetime:
 *
 * - `FloatingPower` — a draggable control portaled onto `document.body`. It
 *   snaps to a screen edge on drag-end and collapses into a thin strip; hovering
 *   the strip reveals the full button again. Clicking opens the power menu.
 * - `SidebarPower` — a power icon contributed to the sidebar foot through the
 *   shipped `sidebar.footer.action` slot. It seats in the account row itself,
 *   immediately left of the avatar, and the row moves right to make room; the
 *   sidebar's collapsed rail keeps it as a sliver that expands under the pointer.
 *
 * A third contribution, `SettingsPanel`, adds the two show/hide switches to this
 * package's own configuration page in the plugin manager
 * (`plugins.bundle.config`). It is what makes the two UIs separately switchable:
 * the plugin card's own switch governs the whole package, so per-UI control has
 * to live in the package's configuration.
 *
 * The floating control is host-global, so it must not ride a session-scoped dock
 * slot: on the new-conversation screen no session exists to scope one by, and the
 * control would vanish there.
 *
 * Everything renders nothing when the Host answers `supported: false` (a terminal
 * `dsh web`, or a non-Windows build). It genuinely cannot act there, and a
 * live-looking control that does nothing is worse than none: quitting a terminal
 * session is Ctrl+C or closing the window, which needs no GUI affordance.
 *
 * This file is the bundle the DSH client module host loads directly
 * (`package.json` → `dsh.client.platform === "web"` plus `exports["./client"]`),
 * so it must keep the `window.__ModuleLoader__.load({ id, factory })` factory
 * form and `require()` only the static module table (`react`, `react-dom`,
 * `react-dom/client` — `react-dom` for `createPortal`, which the shell itself
 * also requires).
 *
 * Several comments below cite `check.mjs` by name for an invariant that is
 * asserted rather than eyeballed. That file is NOT part of this package and is
 * not shipped: it lives in the author's test harness outside the repository, so
 * the citations are provenance (how the claim was verified) rather than a
 * dependency a reader can run from here.
 *
 * @module dsh-power-button/client
 */

window.__ModuleLoader__.load({
  id: "dsh-power-button",
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })

    var react = require("react")
    var react_dom = require("react-dom")
    var react_dom_client = require("react-dom/client")
    var createPortal = react_dom.createPortal
    var h = react.createElement
    var useState = react.useState
    var useEffect = react.useEffect
    var useRef = react.useRef
    var useCallback = react.useCallback

    // #region configuration

    /**
     * Document-relative on purpose: the GUI is served with `<base href="./">`,
     * so a root-absolute path would escape a sub-path deployment. The desktop
     * shell forwards `dsh-app://app/...` to the Host with the path intact.
     */
    var STATUS_URL = "api/dsh-restart/status"
    var ACTION_URL = "api/dsh-restart/action"
    var CONFIG_URL = "api/dsh-restart/config"

    /** Must equal `package.json`'s name: the plugin manager keys this page by it. */
    var PACKAGE_NAME = "dsh-power-button"

    /** Storage key for the persisted position. */
    // The key deliberately keeps its original spelling: it names the user's saved
    // position, and renaming it would silently drop the pinned edge on upgrade.
    var POS_KEY = "dsh-restart-button:pos:v1"

    /** Expanded button size in CSS pixels. */
    var SIZE = 44
    /**
     * Collapsed sliver geometry.
     *
     * The floating strip must be exactly as tall as the button it expands into, or
     * the reveal appears to change size at the moment it takes over: the user
     * reported the strip and the button as "not matching" and, asked which axis,
     * confirmed HEIGHT. So there is no separate length any more — the strip's height
     * IS `SIZE`, stated once and read in both places, which is the only way the two
     * cannot drift apart.
     *
     * The thickness is shared with the sidebar in spirit but not in value: see
     * `SIDEBAR_SLIVER_W` below for why that one is deliberately heavier.
     */
    var STRIP_W = 8
    /**
     * The sidebar sliver's thickness, deliberately NOT the floating strip's.
     *
     * They are two different objects in two different places, and the user asked
     * for the sidebar one to be visibly heavier than the floating one — so this is
     * its own constant rather than a reuse of `STRIP_W`. Sharing one number would
     * mean either the request cannot be met or the floating strip changes with it.
     *
     * The sliver needs more thickness than the floating strip to read as the same
     * weight: it rests on the sidebar's own near-white `neutral-bluish-50` fill
     * while the floating strip sits on the page background, and it carries a 1px
     * border on ALL four sides (the floating strip drops the border facing the
     * window edge), so a 8px sliver there is visually thinner than a 8px strip
     * here even though the numbers match.
     */
    var SIDEBAR_SLIVER_W = 14
    /** How close to an edge a drop must land to snap and collapse. */
    var SNAP_PX = 28
    /** Pointer travel that turns a press into a drag instead of a click. */
    var CLICK_SLOP = 4
    /**
     * Gap kept between a menu panel and the window edge.
     *
     * Four placements clamp against it — the floating panel's left and top, the
     * sidebar panel's left, and its bottom anchor — and they are all one rule: no
     * panel ever touches the window edge. A literal repeated four times is four
     * chances for one of them to drift and leave a single panel flush against the
     * edge while its siblings breathe, which is the kind of difference a user notices
     * without being able to say what changed.
     */
    var PANEL_MARGIN = 8
    /** Menu panel width, used for viewport clamping. */
    var MENU_W = 212
    /**
     * Height used ONLY to keep the floating menu inside the viewport.
     *
     * This is a guard, not a position: the floating panel is anchored by its top
     * edge at the button's own top, so this value never places it — it only stops
     * the panel from running off the bottom of the window when the button is near
     * it. Computed from the panel's own CSS: 12px of vertical padding plus the
     * menu phase's two 36px rows and ~28px hint, or the confirm phase's title,
     * note and button row, with room for an added error line.
     *
     * The sidebar panel deliberately does NOT use this: it is anchored by its
     * bottom edge, so its height is not needed at all.
     */
    var MENU_H = 140
    /** Host failure code meaning another window already started an action. */
    var CODE_BUSY = "already-running"
    /** Host failure code meaning this is not a desktop launch. */
    var CODE_UNSUPPORTED = "unsupported"
    /** How long the press/release jelly animation runs before the class clears. */
    var JELLY_MS = 520
    /**
     * How long to wait for the page to die before reporting that nothing happened.
     *
     * Generous on purpose. The host answers only after its bootstrap phase
     * returns, and that phase starts a WMI process: measured at 4-6 s here and
     * slower on a cold or busy machine. Adding the worker's own settle delay and
     * the kill, a real restart can take the better part of ten seconds, and
     * reporting failure while the restart is genuinely under way would be a
     * false alarm on the one action the user cannot undo.
     */
    var ACTION_TIMEOUT_MS = 40000

    var ZH = (navigator.language || "").toLowerCase().indexOf("zh") === 0

    var TEXT = ZH
      ? {
          label: "DSH 电源菜单",
          restart: "重启 DSH",
          quit: "退出 DSH",
          confirmRestartTitle: "确认重启 DSH？",
          confirmQuitTitle: "确认退出 DSH？",
          confirmDetail: "有任务正在进行，会被立即中断。",
          confirm: "确认",
          cancel: "取消",
          restarting: "正在重启 DSH…",
          quitting: "正在退出 DSH…",
          timeout: "操作似乎没有生效，可查看日志：DSH 的 logs 目录下的 restart-button.log。",
          failed: "操作失败",
          busy: "已在其他窗口发起了重启或退出操作。",
          unsupported: "当前运行模式不支持此操作。",
          retry: "重试",
          /**
           * The drag/collapse hint. Kept, but shown ONLY by the floating control's
           * menu: the sidebar control is neither draggable nor edge-snapping, and
           * printing this there described a gesture that does not exist.
           */
          hint: "拖动可移动，贴边自动收起",
        }
      : {
          label: "DSH power menu",
          restart: "Restart DSH",
          quit: "Quit DSH",
          confirmRestartTitle: "Restart DSH?",
          confirmQuitTitle: "Quit DSH?",
          confirmDetail: "Work is in progress and will be interrupted immediately.",
          confirm: "Confirm",
          cancel: "Cancel",
          restarting: "Restarting DSH…",
          quitting: "Quitting DSH…",
          timeout: "The action does not seem to have taken effect. See restart-button.log in DSH's logs directory.",
          failed: "Action failed",
          busy: "A restart or quit was already started in another window.",
          unsupported: "This run mode does not support the action.",
          retry: "Retry",
          /** The drag/collapse hint; floating control only (see the zh entry). */
          hint: "Drag to move; snapping to an edge collapses it",
        }

    /**
     * Copy for this package's own configuration page in the plugin manager.
     *
     * There is no `title` entry: the page already renders the package title, and
     * a contributed heading was removed rather than kept unused.
     */
    var SETTINGS = ZH
      ? {
          hint: "两个界面各自独立显示或隐藏；整个插件包的启用与停用仍在插件卡片上。",
          floating: "悬浮电源按钮",
          floatingDetail: "可拖动，贴边自动收起成细条；鼠标移上去会重新展开。",
          sidebar: "侧栏底部电源图标",
          sidebarDetail: "贴在头像左边的细条，鼠标移上去展开成按钮。",
          saveFailed: "保存失败，设置未改变。",
        }
      : {
          hint: "Each interface shows or hides on its own. The plugin card still enables or disables the whole package.",
          floating: "Floating power button",
          floatingDetail: "Draggable; snapping to an edge collapses it into a strip that re-expands on hover.",
          sidebar: "Sidebar power icon",
          sidebarDetail: "A sliver just left of the account row that expands under the pointer.",
          saveFailed: "Could not save; the setting is unchanged.",
        }

    // #endregion configuration

    // #region geometry helpers

    function clamp(value, lo, hi) {
      if (hi < lo) return lo
      return value < lo ? lo : value > hi ? hi : value
    }

    function viewport() {
      return {
        w: window.innerWidth || document.documentElement.clientWidth || 0,
        h: window.innerHeight || document.documentElement.clientHeight || 0,
      }
    }

    /** Default spot: a little clear of the right edge, above mid-height. */
    function defaultPos() {
      var v = viewport()
      return {
        x: Math.max(8, v.w - SIZE - 32),
        y: Math.max(8, Math.round(v.h * 0.38)),
        side: null,
        collapsed: false,
      }
    }

    function loadPos() {
      try {
        var raw = window.localStorage.getItem(POS_KEY)
        if (raw === null) return defaultPos()
        var parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== "object") return defaultPos()
        if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return defaultPos()
        if (!isFinite(parsed.x) || !isFinite(parsed.y)) return defaultPos()
        var side = parsed.side === "left" || parsed.side === "right" ? parsed.side : null
        return {
          x: parsed.x,
          y: parsed.y,
          side: side,
          collapsed: parsed.collapsed === true && side !== null,
        }
      } catch (error) {
        return defaultPos()
      }
    }

    function storePos(pos) {
      try {
        window.localStorage.setItem(POS_KEY, JSON.stringify(pos))
      } catch (error) {
        /* private mode or a full quota: the position simply stops persisting */
      }
    }

    /**
     * A point clamped so a `SIZE`-square control stays entirely on screen.
     *
     * Four call sites need precisely this: the resize reclamp, the drop settle, the
     * drag move and the expanded control's own placement. They are four views of ONE
     * control's position, so they must not each carry their own copy of the
     * arithmetic — a copy that drifted in one of them would park the control off
     * screen, or put a collapsed strip and the button it expands into on different
     * pixels, which is the daylight the containment invariant forbids.
     */
    function clampToViewport(x, y) {
      var v = viewport()
      return {
        x: clamp(x, 0, Math.max(0, v.w - SIZE)),
        y: clamp(y, 0, Math.max(0, v.h - SIZE)),
      }
    }

    /** Keep a position inside the viewport, tolerating a shrink while hidden. */
    function reclamp(pos) {
      var v = viewport()
      var point = clampToViewport(pos.x, pos.y)
      var next = { x: point.x, y: point.y, side: pos.side, collapsed: pos.collapsed }
      if (next.collapsed && next.side === "left") next.x = 0
      if (next.collapsed && next.side === "right") next.x = Math.max(0, v.w - SIZE)
      return next
    }

    /**
     * Decide where a dropped control settles.
     *
     * Within {@link SNAP_PX} of the left or right edge it becomes flush and
     * collapses into a strip; anywhere else it stays expanded. Top and bottom
     * edges are deliberately not snap targets: they carry the window chrome and
     * the composer, and a strip there would sit on top of both.
     */
    function settle(pos) {
      var v = viewport()
      var point = clampToViewport(pos.x, pos.y)
      var x = point.x
      var y = point.y
      if (x <= SNAP_PX) return { x: 0, y: y, side: "left", collapsed: true }
      if (x + SIZE >= v.w - SNAP_PX) return { x: Math.max(0, v.w - SIZE), y: y, side: "right", collapsed: true }
      return { x: x, y: y, side: null, collapsed: false }
    }

    /** Whether a position is currently a collapsed strip. */
    function isStrip(pos) {
      return pos.collapsed === true && pos.side !== null
    }

    /**
     * The top edge of a control pinned to the left or right window edge.
     *
     * Both the collapsed strip and the button it expands into must use THIS, and the
     * reason is the containment invariant: the reveal starts from `scale(.5,1)` with
     * its origin on the pinned edge, so the button's very first frame is only as wide
     * as the strip if the two share the same top edge and the same height. Two
     * separate expressions that happen to agree today would put a frame of daylight
     * between them the moment one was edited — and a frame the pointer is not covered
     * on is the flicker loop this plugin has already paid for once.
     *
     * This used to be written out twice, as a "centre the control on its own centre"
     * expression that cancelled itself out to plain `pos.y` — dead arithmetic with a
     * copy at each call site. Two copies that merely happen to agree are the hazard:
     * editing one would open a frame of daylight between the boxes, which is the
     * flicker loop this plugin has already paid for once.
     */
    function pinnedTop(pos) {
      return clampToViewport(pos.x, pos.y).y
    }

    // #endregion geometry helpers

    // #region shared settings

    /**
     * The two per-UI visibility switches, shared by every contributor.
     *
     * The plugin manager's own switch toggles the whole package, so showing the
     * two UIs separately needs this package-level configuration. It is read from
     * the Host at startup and written back through the same route family, and a
     * `BroadcastChannel` (when the browser has one) keeps a second window's UI
     * in step without a reload.
     *
     * The values act as a module singleton because both interfaces read them,
     * but the CHANNEL is created and closed by `attach()`/`detach()` rather than
     * here: a client hot reload re-evaluates this whole factory, so allocating
     * at evaluation time would add one channel and one listener per reload,
     * each holding the discarded module instance alive.
     *
     * Defaults are `true` so a first run — before any settings file exists —
     * shows both interfaces.
     */
    var configChannel = null

    var configStore = (function () {
      var value = { floating: true, sidebar: true }
      var ready = false
      var error = ""
      var listeners = new Set()

      function emit() {
        listeners.forEach(function (listener) {
          listener()
        })
      }

      function adopt(next, failed) {
        if (next !== null && typeof next === "object") {
          value = {
            floating: next.floating !== false,
            sidebar: next.sidebar !== false,
          }
        }
        error = failed === true ? SETTINGS.saveFailed : ""
        ready = true
        emit()
      }

      function broadcast(next) {
        if (configChannel === null) return
        try {
          configChannel.postMessage(next)
        } catch (notificationError) {
          /* a closed channel must never break the UI */
        }
      }

      function onMessage(event) {
        var next = event && event.data
        if (next === null || typeof next !== "object") return
        value = { floating: next.floating !== false, sidebar: next.sidebar !== false }
        ready = true
        emit()
      }

      /**
       * Open the cross-window channel and return its closer.
       *
       * Called once per `apply`, so the closer must be idempotent and must leave
       * the singleton usable: a second window closing its channel may not take
       * this page's configuration with it.
       *
       * @returns a function that closes whatever this call opened.
       */
      function attach() {
        detach()
        try {
          if (typeof window.BroadcastChannel === "function") {
            configChannel = new window.BroadcastChannel("dsh-power-button/config")
            configChannel.onmessage = onMessage
          }
        } catch (error) {
          configChannel = null
        }
        return detach
      }

      /** Close the channel if one is open. Safe to call more than once. */
      function detach() {
        if (configChannel === null) return
        try {
          configChannel.onmessage = null
          configChannel.close()
        } catch (error) {
          /* closing an already-closed channel is not an error worth surfacing */
        }
        configChannel = null
      }

      return {
        attach: attach,
        detach: detach,
        /** Current values; always defined so the first paint has no blank frame. */
        get: function () {
          return value
        },
        /** Whether the Host has answered yet. */
        isReady: function () {
          return ready
        },
        /** Last write failure, or an empty string. */
        failure: function () {
          return error
        },
        subscribe: function (listener) {
          listeners.add(listener)
          return function () {
            listeners.delete(listener)
          }
        },
        /** Read the Host values once at startup. */
        load: function () {
          return api
            .config()
            .then(function (next) {
              adopt(next, false)
            })
            .catch(function () {
              adopt(null, false)
            })
        },
        /** Write one switch, keeping the other, and adopt the Host's answer. */
        save: function (patch) {
          // The value in force BEFORE this write, so a failed write can put it back.
          var previous = { floating: value.floating, sidebar: value.sidebar }
          var optimistic = {
            floating: patch.floating === undefined ? value.floating : patch.floating === true,
            sidebar: patch.sidebar === undefined ? value.sidebar : patch.sidebar === true,
          }
          value = optimistic
          error = ""
          emit()
          // The optimistic value is NOT broadcast. Another window applies whatever
          // arrives on this channel unconditionally, so announcing a value before the
          // Host has stored it tells every other window about a setting that may not
          // exist — and if the write then fails there is no way to take it back, since
          // the failure path has nothing to broadcast. Only a stored value is sent.
          return api.configWrite(optimistic).then(
            function (next) {
              adopt(next, false)
              broadcast(next)
            },
            function () {
              // The write failed, so the value never moved. Restoring it is what makes
              // the message the user sees — "the setting is unchanged" — true, and it
              // also puts the switch back where the persisted setting actually is. The
              // failure flag survives the restore because `adopt` recomputes `error`
              // from its second argument.
              adopt(previous, true)
            },
          )
        },
      }
    })()

    /** Subscribe a component to the shared settings. */
    function useConfig() {
      var tickState = useState(0)
      var bump = tickState[1]
      useEffect(function () {
        return configStore.subscribe(function () {
          bump(function (value) {
            return value + 1
          })
        })
      }, [])
      return {
        values: configStore.get(),
        ready: configStore.isReady(),
        failure: configStore.failure(),
      }
    }

    // #endregion shared settings

    // #region shared hooks

    /**
     * Whether this Host can perform the power actions at all.
     *
     * Both affordances ask, and they must ask the SAME way, because the answer decides
     * whether they exist: a terminal `dsh web` or a non-Windows build answers
     * `supported: false`, and a control that rendered anyway would be a live-looking
     * button that can do nothing — worse than no control, because the user cannot tell
     * the difference until the click. `null` is "not answered yet", which also renders
     * nothing: the probe is a loopback round trip that resolves long before a human
     * could find the button.
     *
     * `alive` guards the setter rather than the request: a client hot reload replaces
     * this whole module instance, so a probe that resolves afterwards would otherwise
     * set state on a discarded component.
     *
     * @param api - Host route client.
     * @returns true, false, or null while unanswered.
     */
    function useSupported(api) {
      var state = useState(null)
      var setSupported = state[1]
      useEffect(
        function () {
          var alive = true
          api.status().then(
            function (value) {
              if (alive) setSupported(value !== null && value.supported === true)
            },
            function () {
              if (alive) setSupported(false)
            },
          )
          return function () {
            alive = false
          }
        },
        [api],
      )
      return state[0]
    }

    /**
     * Close a menu when a press lands outside every node that belongs to it.
     *
     * `refs` is a LIST, and that is required rather than flexible: the sidebar menu's
     * panel is portalled out of its trigger's subtree into the overlay host, so the
     * trigger and the panel are two separate nodes that both count as "inside".
     * With the trigger's wrapper alone, every press on the panel itself would arrive
     * from outside it and close the menu before the button under the pointer ever
     * received the click.
     *
     * The floating menu passes a single node, because its panel is rendered as a
     * sibling INSIDE its own overlay root — the same host `FloatingPower` returns —
     * so the root already contains both the trigger and the panel.
     *
     * The listener is registered for the CAPTURE phase, so a press that another
     * handler stops from bubbling still closes the panel, and it is bound only while
     * a panel is open, so no page-wide listener outlives the menu.
     *
     * The list is held in a ref instead of being a dependency because a caller
     * naturally builds it inline, so a fresh array each render would resubscribe
     * the document listener on every render for as long as the menu is open. The
     * effect re-runs when the menu opens or closes, which is the only time the
     * set of live nodes actually changes.
     *
     * @param menu - the menu state machine (`phase` gates the listener, `close` acts).
     * @param refs - one or more DOM nodes whose subtrees all count as inside.
     */
    function useDismissOnOutsidePress(menu, refs) {
      var phase = menu.phase
      var close = menu.close
      var refsRef = useRef(refs)
      refsRef.current = refs
      useEffect(
        function () {
          if (phase === null) return undefined
          var onDown = function (event) {
            var nodes = refsRef.current
            for (var index = 0; index < nodes.length; index += 1) {
              var node = nodes[index].current
              if (node !== null && node.contains(event.target)) return
            }
            close()
          }
          document.addEventListener("pointerdown", onDown, true)
          return function () {
            document.removeEventListener("pointerdown", onDown, true)
          }
        },
        [phase, close],
      )
    }

    // #endregion shared hooks

    // #region styles

    /**
     * The body-level host the sidebar menu's panel is portalled into.
     *
     * WHY THIS EXISTS — it is the fix for a real difference, not a preference.
     *
     * The two panels have different parents, and only one of them is chosen by this
     * plugin. The floating panel is rendered by `FloatingPower` inside its own
     * overlay root, which `apply` appends straight to `document.body`. The sidebar
     * panel was rendered NEXT TO ITS TRIGGER, i.e. inside the sidebar column,
     * because that is where the shell renders the slot this control occupies. So it
     * inherited whatever that column does to its descendants.
     *
     * What the column does, from the shell's own stylesheet: it is
     * `overflow: hidden` (unconditionally), and `dsh-web-all` gives it
     * `transform: translateX(0)` under `@media (max-width: 768px)`. A transform
     * makes an element the CONTAINING BLOCK for `position: fixed` descendants, and
     * `overflow: hidden` then clips them to it. Measured in headless Chromium on a
     * page built from the shell's real rules: with the transform present, a `fixed`
     * panel rendered in the column had the column as its `offsetParent` and its own
     * pixels stopped at the column edge with the page showing through; with the
     * transform absent it did not. The media query means that specific clipping
     * needs a window under 768px, which this machine's 1296x828 window does not hit
     * — so the transform is not today's cause of anything, and the reason to portal
     * stands on its own: a panel whose parent is a subtree this plugin does not own
     * is subject to that subtree's rules, and those rules are not this plugin's to
     * predict or to change.
     *
     * Portalling removes the question rather than answering it: the panel now sits
     * in a body-level overlay with the same ancestors, stacking context and
     * containing block as the floating one, so the single component that draws both
     * of them cannot render differently in the two places.
     *
     * The host is created once, lazily, and reused on every render. It carries
     * `.dshrb-root`, so it reuses the existing overlay rules (viewport-sized,
     * pointer-transparent, top-most layer) instead of growing a second set; the
     * panels keep `pointer-events: auto` from the grouped rule, so the overlay stays
     * click-through everywhere else.
     *
     * It is swept on activation and removed on disposal, exactly like the floating
     * root: otherwise a client hot reload would leave the previous instance's host
     * behind, and `apply`'s existing "exactly one control" invariant would hold for
     * the button while quietly failing for this one.
     */
    var MENU_HOST_ATTR = "data-dshrb-menu-host"

    /**
     * The portal host of THIS bundle instance, created by `apply` as a child of the
     * plugin's own `div[data-dsh-restart-root]` container, or null before that.
     *
     * WHY IT IS NOT A DIRECT BODY CHILD — the placement is the point, not tidiness.
     *
     * The overlay spans the viewport (`inset: 0`), and a viewport-spanning element
     * that participates in the window's app-region computation SUBTRACTS itself from
     * the draggable area: `-webkit-app-region` is resolved geometrically, and
     * `pointer-events: none` does not exempt an element from it. The official base
     * stylesheet turns every direct `body` child into a `no-drag` region, sparing
     * only the app's own root element — the rule is
     * `html[data-platform=darwin] body > :not(#root)` and it is macOS-scoped, so on
     * Windows it does not apply. Keeping the host out of the body's child list costs
     * nothing and means the plugin does not depend on that scoping staying true.
     *
     * The second reason is ownership. A host looked up by `querySelector` cannot be
     * told apart from a newer instance's: during a client hot reload the old instance
     * would adopt the replacement's host and then delete it on teardown, leaving the
     * replacement portalling into a detached node. Creating the host inside this
     * instance's own container removes the question — and it also means the existing
     * stale-container sweep takes stale hosts with it, so there is no separate sweep
     * to keep in step.
     */
    var menuHostNode = null

    /**
     * Create the portal host inside `container` and remember it.
     *
     * `container` also holds the React root's own mount node as a SIBLING, so React
     * never renders into a node that already has children of ours: handing React a
     * container clears its existing content on mount, which would delete this host.
     */
    function createMenuHost(container) {
      var host = document.createElement("div")
      host.setAttribute(MENU_HOST_ATTR, "")
      host.className = "dshrb-root"
      container.appendChild(host)
      menuHostNode = host
      return host
    }

    /** The portal host created by `apply` for this bundle instance. */
    function menuHost() {
      return menuHostNode
    }

    /**
     * Portal a node into that host.
     *
     * `createPortal` needs a DOM node it can render into, and the host must exist
     * before the return value is built, so this runs during render. That is safe
     * here because the host is created once by `apply` and this only reads it: a
     * second render — including React's StrictMode double-render — returns the same
     * portal target.
     */
    function portalToHost(node) {
      return createPortal(node, menuHost())
    }

    var STYLE_ID = "dsh-power-button-styles"
    var CSS = [
      // `-webkit-app-region:no-drag` is what keeps both controls usable over the
      // window title bar. DSH paints a native drag strip across the top of the
      // frame (`[data-windows-titlebar] .BynINW_frame:before` sets
      // `-webkit-app-region:drag`), and the operating system resolves a drag
      // region BEFORE the page sees the pointer. Over that strip the page gets no
      // pointer events at all, so: the button could not be grabbed and dragging
      // moved the window instead, and an open menu stopped receiving
      // `pointermove`, leaving the last hovered row highlighted — the highlight
      // appeared not to follow the pointer. A `no-drag` box painted on top
      // subtracts itself from that region and restores ordinary events.
      //
      // It must therefore be declared ONLY on the controls themselves, NEVER on
      // the full-viewport root overlay below. A `no-drag` box subtracts itself
      // from the drag region, so an `inset:0` overlay clears the region for the
      // entire window and the window can no longer be dragged by its title bar.
      // This was observed in the real desktop window, and DSH's own CSS relies
      // on the same mechanism from the other direction: its onboarding surface
      // paints a full-window drag band and cancels it by adding `no-drag`
      // (`Vb49yG_dragBand` -> `[inert] .Vb49yG_dragBand{no-drag}`), so the
      // subtraction is geometric and is not cancelled by `pointer-events:none`.
      // Rule: an element that covers the viewport gets no app-region rule.
      ".dshrb-root{position:fixed;inset:0;pointer-events:none;z-index:2147483600;",
      "font-family:inherit}",
      ".dshrb-btn,.dshrb-strip,.dshrb-menu,.dshrb-toast,.dshrb-sbwrap{pointer-events:auto;-webkit-app-region:no-drag}",
      // `corner-shape:round` is REQUIRED here, not cosmetic, and the host's own
      // documentation is explicit about why:
      //
      //   corner-shape.css smooths every rounded corner: inside
      //   `@supports (corner-shape: superellipse(1.5))` it defines
      //   `--dsw-corner-shape` and applies it to all elements and their
      //   `::before`/`::after` through the universal selector … Full-round shapes —
      //   `border-radius: 50%` circles and pill radii — pair `corner-shape: round`
      //   with their radius in the owning component sheet because a superellipse
      //   deforms them.
      //
      // So the universal superellipse corner is the house style and is FOLLOWED by
      // default everywhere below (menus, rows, panels deliberately declare no
      // `corner-shape`), while a full-round shape must opt back out. This control
      // is a `border-radius:50%` circle, so without this declaration the global
      // superellipse smears it into a rounded square. The same applies to the
      // switch's pill track and its circular thumb further down.
      ".dshrb-btn{position:fixed;display:flex;align-items:center;justify-content:center;",
      "box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));",
      "border-radius:50%;corner-shape:round;background:var(--dsw-alias-bg-layer-1,rgba(28,28,30,.86));",
      "color:var(--dsw-alias-label-primary,#fff);cursor:grab;touch-action:none;user-select:none;",
      "box-shadow:0 2px 10px rgba(0,0,0,.28);padding:0;",
      "transition:transform .14s cubic-bezier(.34,1.56,.64,1),box-shadow .14s ease;",
      "transform-origin:center center;will-change:transform}",
      // The scale this control SETTLES at, as a variable rather than a literal in
      // two places. It is 1.06 while hovered (the entry below) and 1 otherwise, and
      // the reveal animation reads it for its final frame.
      //
      // This is what removes the reported seam. The animation used to end at
      // `scale(1,1)` while `:hover` paints `scale(1.06)`: the moment the animation
      // finished it handed `transform` back to the hover rule, so the control
      // visible-snapped from 1.0 straight to 1.06 — a discontinuity in the middle
      // of what is supposed to be one continuous motion. Ending the animation at
      // the scale the element is about to hold makes the hand-back a no-op.
      //
      // `var()` inside a keyframe is resolved against the element's own computed
      // value at the time the animation is applied, so the hover state that opened
      // the reveal is the same state the reveal lands on.
      ".dshrb-btn{--dshrb-settle:1}",
      ".dshrb-btn:hover{--dshrb-settle:1.06;transform:scale(1.06)}",
      ".dshrb-btn[data-dragging='true']{cursor:grabbing;transition:none}",
      // The reveal: a sliver the pointer entered GROWS OUT from the edge it is
      // anchored to, so the cursor never leaves the element.
      //
      // It used to be a single spring from `scale(.34,.86)` to full size, which
      // reads as the control POPPING into existence — one extreme keyframe, one
      // overshoot, done. It now eases out over several damped stops, so the control
      // slides out of the edge and settles with a small wobble: a jelly slide
      // rather than a pop.
      //
      // Two things make it a SLIDE rather than an expansion-in-place:
      //
      // 1. The origin is moved to the anchored edge (`data-side`, set below), so
      //    only the free edge travels. Growing from the centre moves BOTH edges and
      //    is exactly what makes a shape look like it appeared rather than arrived.
      // 2. No translation is used anywhere in this animation, deliberately. The
      //    cursor entered ON the sliver at the anchored edge, so any travel that is
      //    not anchored can slide the control out from under the pointer, which
      //    fires `pointerleave`, collapses it, and starts the flashing loop again.
      //    Scaling from a fixed edge cannot do that: the box always covers the
      //    sliver, since the minimum scale still leaves the anchored edge in place.
      //
      // Every stop after the first is written as a MULTIPLE of `--dshrb-settle`
      // rather than as a bare number, so the whole tail scales with the state the
      // control is about to hold and the final frame lands exactly on it. That is
      // what removes the seam described above: with hard-coded `scale(1,1)` endings
      // the tail was correct at rest but wrong under the pointer, where the
      // control visibly stepped up to its hover scale as the animation released.
      //
      // The tail is also deliberately gentle — ~6%, 2.5%, 2% and 0.5% deviations
      // over roughly two thirds of the duration. The first version put a 6%
      // overshoot immediately after a 4% undershoot and then finished in barely
      // one frame, which is what read as a sharp snap rather than jelly.
      //
      // CONTAINMENT INVARIANT — the one rule this animation must never break:
      // every frame's rendered box must CONTAIN the collapsed sliver it grew out
      // of. The pointer entered on that sliver, so a single frame that fails to
      // cover it fires `pointerleave`, which collapses the control, which puts the
      // sliver back under the pointer, which re-enters: the user sees it flash
      // closed and open for as long as the cursor rests there.
      //
      // It was broken, and the user reported exactly that on the sidebar: "鼠标在
      // 收起细条的上下边位置的时候打开后会立刻关闭，随后又立刻打开". The `0%` frame
      // squashed the box to `scale(.5,.72)`, so a 32px-tall control was 23px tall
      // for the first frames and its top and bottom 4.5px were no longer part of
      // the element — read by the user, reasonably, as the collapsed state being
      // the taller one. The floating strip's own box is 44px tall, so it lost
      // 6.2px per end for the same frames.
      //
      // Hence the vertical factor is NEVER below 1. The factors the keyframes below
      // actually carry are, in order: 1, 1.04, 1.01, 1.005, 1.002, 1. (This line used
      // to list 1.02 instead of 1.002 — a stale copy of an earlier revision's frame
      // list, which is exactly the kind of hand-written duplicate the guard now reads
      // out of the keyframes themselves rather than trusting.) The control may only
      // ever grow vertically from its resting height, and the jelly reads as a
      // sideways slide with a breath rather than as a squash. The horizontal factor
      // may shrink because it is anchored on the pinned edge and the sliver is far
      // narrower than the button — 0.5 of 44px is still 22px against an 8px strip,
      // and `.dshrb-sb`'s sliver is covered by having its pointer handlers on the
      // untransformed wrapper instead. Both halves of the invariant are asserted in
      // `check.mjs`, because a screenshot diff of computed values cannot see them.
      ".dshrb-btn[data-reveal='true']{animation:dshrb-reveal .44s cubic-bezier(.22,1.1,.36,1)}",
      "@keyframes dshrb-reveal{",
      "0%{transform:scale(.5,1);opacity:0}",
      "26%{transform:scale(calc(var(--dshrb-settle,1) * 1.06),calc(var(--dshrb-settle,1) * 1.04));opacity:1}",
      "48%{transform:scale(calc(var(--dshrb-settle,1) * .975),calc(var(--dshrb-settle,1) * 1.01))}",
      "70%{transform:scale(calc(var(--dshrb-settle,1) * 1.02),calc(var(--dshrb-settle,1) * 1.005))}",
      "86%{transform:scale(calc(var(--dshrb-settle,1) * .995),calc(var(--dshrb-settle,1) * 1.002))}",
      "100%{transform:scale(var(--dshrb-settle,1))}}",
      // Jelly: press squashes, release springs back with a little overshoot.
      //
      // `animation-fill-mode: forwards` on the press matters: it holds the squashed
      // shape for the whole press instead of snapping back to the resting scale on
      // release, which would make the press blink. `data-anim` is cleared by the
      // component after JELLY_MS, and dropping the class is what ends both.
      ".dshrb-btn[data-anim='press']{animation:dshrb-squash .16s ease-out forwards}",
      // The release ends on `--dshrb-settle` for the same reason the reveal does:
      // it hands `transform` back to the resting/hover rule, and a hard `scale(1,1)`
      // ending under the pointer would step the control up to its hover scale as the
      // animation released — a second instance of the reported seam.
      //
      // The overshoot is also softened here (1.18 -> 1.12 on the tall axis, and a
      // 4% deviation instead of 6%): stacked on the entry easing it read as a hard
      // snap rather than jelly.
      ".dshrb-btn[data-anim='release']{animation:dshrb-jelly .46s cubic-bezier(.36,1.28,.5,1)}",
      // The squash starts AND ends on multiples of `--dshrb-settle`: starting from a
      // hard `scale(1,1)` while hovered at 1.06 would also step on the first frame.
      "@keyframes dshrb-squash{from{transform:scale(var(--dshrb-settle,1))}",
      "to{transform:scale(calc(var(--dshrb-settle,1) * .9),calc(var(--dshrb-settle,1) * 1.1))}}",
      "@keyframes dshrb-jelly{0%{transform:scale(calc(var(--dshrb-settle,1) * .9),calc(var(--dshrb-settle,1) * 1.1))}",
      "26%{transform:scale(calc(var(--dshrb-settle,1) * 1.12),calc(var(--dshrb-settle,1) * .88))}",
      "50%{transform:scale(calc(var(--dshrb-settle,1) * .94),calc(var(--dshrb-settle,1) * 1.06))}",
      "72%{transform:scale(calc(var(--dshrb-settle,1) * 1.04),calc(var(--dshrb-settle,1) * .97))}",
      "100%{transform:scale(var(--dshrb-settle,1))}}",
      // Juice: a few droplets squeezed out on press, flung along --dx/--dy.
      //
      // `corner-shape:round` for the same reason as the button and the switch: this
      // is a `border-radius:50%` circle, and the host's universal superellipse would
      // otherwise square it off. Found by the pairing guard in `check.mjs` rather
      // than by eye — the droplets are 7px and on screen for under half a second, so
      // a wrong corner there is not something review would reliably catch.
      ".dshrb-juice{position:fixed;width:7px;height:7px;border-radius:50%;corner-shape:round;",
      "pointer-events:none;",
      "background:radial-gradient(circle at 34% 30%,rgba(255,255,255,.95),rgba(120,180,255,.75));",
      "animation:dshrb-juice .46s cubic-bezier(.22,.7,.3,1) forwards}",
      "@keyframes dshrb-juice{0%{transform:translate(-50%,-50%) scale(1);opacity:.92}",
      "100%{transform:translate(calc(-50% + var(--dx)),calc(-50% + var(--dy))) scale(.25);opacity:0}}",
      // The sliver's appearance is stated ONCE and shared by both affordances:
      // the floating strip (flush against a window edge) and the sidebar sliver
      // (resting inside the sidebar foot, immediately left of the account row).
      // Together with the shared width constant `STRIP_W` this is what keeps the
      // two reading as one family — change either and both follow.
      //
      // They are no longer flush against the same KIND of edge, and the sheet says
      // so: the floating strip drops the border on whichever side faces the window
      // edge (`[data-side='left'|'right']` below), while the sliver keeps all four
      // and is a free-standing bar inside the foot. Only the fill, hairline and
      // shadow are shared — the edge treatment is per-affordance, because only the
      // floating one has a window edge to sit on.
      //
      // The strip must read against whatever it is lying on, and the sidebar's own
      // fill is `neutral-bluish-50` in the light theme. A `--dsw-alias-bg-layer-1`
      // strip would therefore be white on near-white there and effectively
      // invisible; the solid hover token is a grey in the light theme and a dark
      // grey in the dark one, so it is visible in both. That is also why the
      // sidebar sliver is painted with this SAME fill: it rests on that very
      // near-white sidebar, and the faint `--dsw-alias-border-l2` it used before
      // was all but invisible there — it read as a thinner, weaker strip than the
      // floating one even though both were the same number of pixels wide.
      ".dshrb-strip,.dshrb-sb[data-rail='true']{",
      "background:var(--dsw-alias-interactive-bg-hover-solid,rgba(127,127,127,.5));",
      "border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));",
      "box-shadow:0 2px 8px rgba(0,0,0,.24)}",
      // The transition stays on the floating strip ONLY, not in the shared rule.
      // The grouped selector above is (0,2,0) and would therefore beat `.dshrb-sb`'s
      // own (0,1,0) transition declaration, silently discarding the sliver's
      // `transform`/`width` transitions — the very properties its reveal and growth
      // animate. The sliver gets its background fade from `.dshrb-sb` already, so
      // nothing is lost by keeping this here.
      ".dshrb-strip{position:fixed;box-sizing:border-box;cursor:pointer;touch-action:none;",
      "display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary,#8a8f98);",
      "transition:background .12s ease,color .12s ease}",
      // Corners rounder than a hairline box would suggest, and asymmetric on
      // purpose: the strip is flush with a window edge, so the two corners ON that
      // edge stay square (a rounded corner there would open a notch against the
      // screen border) while the two free corners take a generous radius. `8px` on
      // a 8px-wide box is a semicircular cap, which is what reads as "smooth".
      ".dshrb-strip[data-side='left']{border-left:none;border-radius:0 8px 8px 0}",
      ".dshrb-strip[data-side='right']{border-right:none;border-radius:8px 0 0 8px}",
      ".dshrb-strip:hover,.dshrb-sb[data-rail='true']:hover{",
      "background:var(--dsw-alias-brand-primary,rgba(127,127,127,.75));color:#fff}",
      // The mark states its own colour (see `.dshrb-mark`), so the hover rule above
      // — which whitens the sliver by setting ITS `color` — no longer reaches the
      // line. Without this the line would stay muted grey on a brand-blue sliver,
      // i.e. the hover feedback would visibly weaken on the one element the eye is
      // on. Both slivers are covered by the same selector pair as their hover rule.
      ".dshrb-strip:hover .dshrb-mark,.dshrb-sb[data-rail='true']:hover .dshrb-mark{",
      "color:#fff}",
      // The line that marks a collapsed strip as something you can open, rather
      // than an anonymous bar. One shared rule for both affordances, since the
      // need is identical.
      //
      // It replaced a small power glyph on request. The colour is stated here
      // EXPLICITLY rather than left to `currentColor`, and that is a measured fix,
      // not a preference: the two affordances set different `color`s — the floating
      // strip is `--dsw-alias-label-secondary` while the sidebar button inherits the
      // foot's normal text colour — so the same `currentColor` line came out
      // `rgb(138,143,152)` in the strip and `rgb(27,28,30)` beside the avatar: one
      // light grey line and one near-black line, for two marks the user asked to be
      // the same thing. Declaring the muted token here puts both on the same colour
      // in every theme, and the hover rules below still override it to white.
      //
      // `corner-shape:round` is required, not decoration: a 2px-wide box with a 1px
      // radius is a full-round (pill-ended) shape, and the host's universal
      // superellipse would square its ends off. The pairing rule is the one
      // documented at `.dshrb-btn` above. Measured after the change: 2.0x16.0,
      // radius 1px, computed `corner-shape: superellipse(1)` — i.e. round.
      //
      // The sidebar's rail rule hides the sliver's children on purpose (a 14px box
      // cannot show a 16px glyph), and the mark survives that hiding by SPECIFICITY,
      // not by an exception: `.dshrb-sb[data-rail='true'] > *` is (0,2,0) while
      // `.dshrb-sb[data-rail='true'] > .dshrb-mark` is (0,3,0), so the second wins on
      // the only element it names. `check.mjs` asserts that comparison, because
      // swapping the two rules would silently hide the mark in the one state that
      // needs it.
      ".dshrb-mark{display:block;flex:none;pointer-events:none;width:2px;height:16px;",
      "border-radius:1px;corner-shape:round;background:currentColor;opacity:.9;",
      "color:var(--dsw-alias-label-secondary,#8a8f98)}",
      // The panel is fully OPAQUE and does not follow the host's menu-surface
      // translucency setting, while still following its light/dark palette.
      //
      // `--dsw-specific-menu` is the token DSH's own popovers use, but measured in
      // the shipped theme tables it resolves to `--dsw-menu-surface-fill`, which is
      // `#f8f9fa94` in light and `#43454a73` in dark — the trailing hex pair is
      // ALPHA, so the surface is ~58% and ~45% opaque. DSH itself pairs that fill
      // with `backdrop-filter:var(--dsw-menu-backdrop-filter)` (`blur(40px)
      // saturate(150%)`); this panel deliberately does NOT, so it must not be
      // translucent: without the blur it shows the page straight through.
      //
      // So the surface is built from OPAQUE palette tokens instead of that fill:
      // `--dsw-alias-bg-layer-1`, measured as `neutral-bluish-00` (#fff) in light
      // and `neutral-bluish-875` (#232324) in dark, is opaque in both and theme-
      // paired, which is exactly "opaque, but still following the theme".
      ".dshrb-menu{position:fixed;box-sizing:border-box;padding:6px;border-radius:10px;",
      "background:var(--dsw-alias-bg-layer-1,rgba(28,28,30,.97));",
      "border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));",
      "box-shadow:0 8px 28px rgba(0,0,0,.36);color:var(--dsw-alias-label-primary,#fff);",
      // The typeface follows the theme instead of being inherited from whatever
      // element the overlay happens to hang off. `--dsw-font-family` is the token
      // DSH itself declares (`-apple-system, BlinkMacSystemFont, Segoe UI, PingFang
      // SC, …`), so the panel's text matches the surrounding chrome in every locale
      // and picks up a skin that restyles the family.
      //
      // The font here used to be `inherit` via the shared rule at the top of the
      // sheet, which resolved to the root element's family by luck rather than by
      // intent — an overlay mounted under a different subtree would have changed it.
      // Size and line-height stay explicit because the panel is not a text block
      // that should rescale with the user's content-font setting.
      "font-family:var(--dsw-font-family,inherit);font-size:13px;line-height:1.5;",
      "animation:dshrb-pop .18s cubic-bezier(.34,1.56,.64,1)}",
      "@keyframes dshrb-pop{from{transform:scale(.92);opacity:0}to{transform:scale(1);opacity:1}}",
      // Hover styling is stated on the anchor pseudo-class the browsers use for
      // pointer-driven highlighting, and every row is a real `button`, so the
      // highlight has a definite element to attach to and to leave.
      // `--dsw-alias-interactive-bg-hover` is theme-paired and defined for all
      // themes (measured: light `#2631480f`, dark `#ffffff14`), so the tint is
      // present in both; the danger row uses its own paired token instead of a
      // hard-coded red so it stays legible on either surface.
      ".dshrb-item{display:flex;align-items:center;gap:8px;width:100%;box-sizing:border-box;",
      "padding:8px 10px;border:none;border-radius:7px;background:transparent;color:inherit;",
      "font:inherit;text-align:left;cursor:pointer;outline-offset:2px}",
      ".dshrb-item:hover,.dshrb-item:focus-visible{",
      "background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}",
      ".dshrb-item[data-danger='true']:hover{",
      "background:var(--dsw-alias-interactive-bg-hover-danger,rgba(220,60,60,.20))}",
      ".dshrb-title{padding:8px 10px 2px;font-weight:600}",
      ".dshrb-note{padding:2px 10px 6px;opacity:.75;font-size:12px}",
      ".dshrb-hint{padding:7px 10px 3px;margin-top:4px;",
      "border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25));opacity:.6;font-size:11px}",
      ".dshrb-row{display:flex;gap:6px;padding:6px 10px 4px}",
      ".dshrb-row .dshrb-item{justify-content:center;flex:1}",
      // The destructive confirm is marked with a DANGER BORDER, not a filled
      // block. A permanent fill reads as a selected row — and with the hover tint
      // invisible (see above) it was the only tinted row on the panel, so the
      // panel appeared to hold a selection that never moved with the pointer.
      // Outline states "this button is the dangerous one" without ever looking
      // like a selection; the fill then appears only while the pointer is on it.
      ".dshrb-primary{font-weight:600;",
      "border:1px solid var(--dsw-alias-state-error-primary,rgba(220,60,60,.55))}",
      ".dshrb-primary:hover{",
      "background:var(--dsw-alias-interactive-bg-hover-danger,rgba(220,60,60,.20))}",
      ".dshrb-toast{position:fixed;left:50%;top:24px;transform:translateX(-50%);",
      "max-width:min(460px,90vw);box-sizing:border-box;padding:10px 14px;border-radius:9px;",
      "background:var(--dsw-alias-bg-layer-1,rgba(28,28,30,.97));",
      "border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));",
      "color:var(--dsw-alias-label-primary,#fff);font-size:13px;line-height:1.5;",
      "box-shadow:0 8px 28px rgba(0,0,0,.36);word-break:break-word}",
      // A `[data-error='true']` border rule used to sit here. It was dead: the toast
      // is only ever the "busy" notice (`BusyToast` emits it with no data attribute),
      // because a failure is reported inside the menu panel, where the retry button
      // is. A style for a state that cannot be reached is worse than absent — it
      // reads as a working error surface and hides the fact that there is none.
      // Sidebar contribution: an icon-sized button that follows the sidebar's own
      // text colour rather than the overlay palette.
      //
      // The wrapper carries a small negative inline offset to sit the control
      // closer to the sidebar's edge than the row's own padding would place it.
      //
      // The offset is on the WRAPPER, and that placement is the whole point: this
      // exact measure previously lived on the resting-rail rule, so it existed in
      // one state and not the other, and entering the sliver moved the box out from
      // under the pointer — the flicker loop documented at length further down. On
      // the wrapper it is applied in BOTH states, so the control's left edge is the
      // same at rest and while revealed and the geometry cannot fabricate a
      // pointer-leave. `check.mjs` asserts that no rule keyed on the rail state
      // declares an offset, and this is why.
      //
      // It is a margin on this plugin's own box and touches no host rule, so the
      // sidebar's own column and the avatar row keep their widths.
      //
      // `width:fit-content;height:fit-content` is what keeps the HIT BOX tight, and
      // it is load-bearing rather than defensive. The wrapper is where the pointer
      // handlers live, so its box IS the control's hit area — and an auto-width flex
      // item takes its container's width when that container stretches its items.
      // Measured in a real engine, the same shipped pair of boxes gives:
      //
      //   wide sidebar, account row (align-items:center)   wrapper 14x32   slack 0
      //   the same row with align-items:stretch            wrapper 14x32   slack 0
      //   collapsed icon rail, centred column              wrapper 14x32   slack 0
      //   collapsed icon rail, default stretch             wrapper 36x32   slack 22px
      //   no web-all: the shell's stacked foot             wrapper 734x32  slack 720px
      //
      // The last two turned the empty space beside the sliver into a hover target —
      // up to a whole row of it — which would expand the control when the pointer was
      // nowhere near it. `fit-content` collapses all five cases to exactly the
      // sliver, so the hit area is the sliver and nothing else, in every layout the
      // host can put this contribution in.
      ".dshrb-sbwrap{position:relative;display:flex;align-items:center;flex:none;",
      "width:fit-content;height:fit-content;margin-left:-6px}",
      ".dshrb-sb{--dshrb-settle:1;display:flex;align-items:center;justify-content:center;gap:8px;",
      "box-sizing:border-box;",
      "width:32px;height:32px;padding:0;border:none;border-radius:8px;background:transparent;",
      "color:inherit;cursor:pointer;outline-offset:2px;",
      // The origin is stated on the BASE rule rather than on the reveal trigger,
      // because the trigger is a one-shot that is spent before the click — see
      // `useRevealArm` for why it has to be spent. This control grows, and jellies,
      // out of its left edge in every state, so the origin has to outlive the reveal:
      // left on the trigger rule, the press jelly would start scaling from the centre
      // of the button while the reveal it replaced scaled from the edge the control is
      // pinned to.
      "transform-origin:left center;",
      "transition:transform .14s cubic-bezier(.34,1.56,.64,1),background .12s ease,width .18s ease}",
      // The expanded sidebar control is ICON-ONLY and the SAME size as the icon
      // buttons beside it. It used to print the word `电源` / `Power` next to the
      // glyph, which made it noticeably wider than those buttons and let it shove
      // the avatar row; the label was removed for that reason.
      //
      // Removing it left a `width:auto` behind, which is narrower than it sounds:
      // with no padding and a single 16px glyph the button collapsed to 16px,
      // barely wider than the 14px sliver it had just grown out of — reported as
      // "打开后太窄了". There is no override any more: the base rule's 32x32 square
      // IS the expanded size, in both seatings, which is what keeps the control the
      // same weight as its neighbours. No rule sizes the button by its seating, and
      // `check.mjs` asserts that.
      //
      // There is no seating marker on this BUTTON at all: the account-row placement
      // above is gated on `.dshrb-sbwrap[data-dshrb-inrow]`, a different attribute on
      // a different element. A `data-wide` attribute used to sit here mirroring the
      // shell's `wide` prop, but nothing consumed it — no rule, and nothing outside
      // this package either (the host bundles' own `[data-wide=wide]` selectors are
      // scoped to their own trigger classes and use different values). Dead markers
      // invite the belief that changing one will change something, so it is gone.
      ".dshrb-sb:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}",
      // The resting state is the thin rail, whose thickness reads its own constant
      // (`SIDEBAR_SLIVER_W`) rather than the floating strip's, so the two cannot
      // drift apart and the sidebar's deliberate extra weight is not lost. The icon
      // is hidden rather than clipped: a 14px box cannot show a 16px glyph, and
      // `overflow:hidden` on a flex item with a squashed child is what produces a
      // half-drawn icon.
      ".dshrb-sb[data-rail='true']{width:" + SIDEBAR_SLIVER_W + "px;min-width:0;padding:0;gap:0;",
      "border-radius:5px;justify-content:center}",
      ".dshrb-sb[data-rail='true'] > *{display:none}",
      ".dshrb-sb[data-rail='true'] > .dshrb-mark{display:block}",
      // ...and the converse, which is required rather than tidy: the sidebar button
      // has TWO children (the 16px icon and the sliver line), so without this the
      // expanded button would show the glyph and the line side by side. The rail
      // state shows only the line, every other state shows only the icon.
      ".dshrb-sb > .dshrb-mark{display:none}",
      // Seat the control in the ACCOUNT ROW itself, immediately left of the
      // avatar, and let the row give way to it — the account row starts to the
      // right of this control instead of above it.
      //
      // How the row comes to exist: this contribution lands in the
      // `sidebar.footer.action` seat, whose own container is `display:contents`,
      // so the control is laid out as a direct child of the sidebar's foot area.
      // The shell's foot is a COLUMN — footer actions on one line, the account
      // row below — so by the shell's own rules the control would take a
      // full-width row of its own ABOVE the avatar. That is where it was wrongly
      // sitting. The web-all bundle reflows that foot into a single wrapping row
      // (it dissolves the footer-actions box with `display:contents`, gives the
      // account row `flex:auto`, and orders the pieces), which is what allows a
      // footer action to share the avatar's line at all.
      //
      // So this rule does not build the row; it claims a place IN a row. The row
      // itself is built by the sheet, in the block below, and no other bundle's
      // state is consulted for it. This rule used to be scoped to web-all's marker
      // being PRESENT, with that block as its mutually exclusive negated twin — that
      // split is gone on purpose, and the block below records the failure it cost.
      //
      // `order:2` sorts ahead of the account row's `order:3`, which is what puts
      // the control on the LEFT of the avatar; web-all gives its own right-hand
      // entry `order:4` to land on the far side of it.
      //
      // `data-dshrb-inrow` gates the whole rule, and it is emitted from this
      // component's OWN `wide` prop. That is deliberate: this placement belongs
      // to the WIDE sidebar's account row, and the collapsed icon rail is a 36px
      // centred column with no such row, where an `order` would silently reshuffle
      // the rail's stack. Gating on the shell's own `wide` keeps that decision
      // independent of whether any third-party marker is present and accurate.
      //
      // This is the ONE placement rule, and its only gate is that marker. There is
      // deliberately no test of any other bundle's state here — see the reflow
      // block below for the failure that cost, reported from the screen.
      //
      // The two layout properties are `!important` on purpose, and this is the
      // reason rather than decoration. web-all claims every contributed action it
      // does not recognise by name as a full-width item with its own line, via
      // `[data-dsh-frame]:not([data-sidebar-collapsed]) [class*=footerActions]>
      // [data-slot='sidebar.footer.action']>:not([data-dsh-part=entry]):
      // not([class*=entryRow]){flex:100%;order:1}`. Counted the way the cascade
      // counts `:not` (the argument's specificity, not the pseudo-class's), that
      // is (0,6,0) — and this selector is also (0,6,0). A tie is decided by
      // source order, which here means whichever stylesheet the browser happened
      // to evaluate last: the layout would change with plugin install order, a bug
      // waiting to be reported. `!important` is what makes it deterministic, and it
      // is spent on exactly the two properties the competing rule declares, on the
      // one element this plugin owns — nothing else is affected.
      // (Raising specificity instead would work equally well; `!important` is
      // chosen only because it says the intent out loud.)
      //
      // The seat is matched with a DESCENDANT combinator, not a child one, and
      // that is required today rather than defensive: the slot anchor between the
      // footer-actions box and this element is itself `<div data-slot=...>` with
      // `display:contents`, so a `>` would fail to match immediately and the
      // placement would silently not happen.
      "[class*=footArea] [data-slot='sidebar.footer.action'] ",
      ".dshrb-sbwrap[data-dshrb-inrow]{",
      "flex:none!important;order:2!important;min-width:0;align-self:center}",
      // --- the foot reflow: ONE path, and no marker predicate -------------------
      //
      // These declarations are the neighbouring bundle's reflow (`dsh-web-all` /
      // `dsh-remote-web-ui`), reproduced here so the control lands in the account
      // row whether or not that bundle is installed.
      //
      // They were gated on `html:not(:has([data-dsh-frame]))` — on that bundle's
      // marker being ABSENT — and that gate was wrong in a way a user reported from
      // the screen: `data-dsh-frame` is a ONE-WAY LATCH. The bundle stamps it onto
      // the shell frame and never removes it; `removeAttribute("data-dsh-frame")`
      // does not exist anywhere in its packages. So once it has run, the marker
      // outlives the reflow it announced. In exactly that state — bundle switched
      // off, attribute still on the frame — this whole block was unreachable while
      // the plain placement rule above still fired: the foot stayed the shell's
      // COLUMN, `order:2` had no row to sort into, and the control took a line of
      // its own instead of sharing the avatar's. A test of the past dressed up as a
      // test of the present.
      //
      // The reflow is therefore unconditional, and the only thing gating it is the
      // same `data-dshrb-inrow` marker as above — this plugin's OWN `wide` state.
      // That is also what makes running it alongside the other bundle safe instead
      // of needing mutual exclusion: every declaration below is the same value that
      // bundle declares, so two sheets agreeing is a no-op, and where the selectors
      // tie on specificity the source order cannot matter because the values are
      // identical.
      //
      // What has to be reproduced is small, because the reflow is small. It turns
      // the shell's column foot into a wrapping row, dissolves the footer-actions
      // box so its seats become row items, and lets the account row take the
      // space left over. Those are the three declarations below, and they are
      // deliberately the same three values the other bundle uses, not merely
      // similar ones: matching the proven layout is what keeps the two branches
      // from looking different, and any "improvement" here would be a second
      // layout to review rather than a safer one.
      //
      // The values are that bundle's own, not merely similar ones: matching the
      // proven layout is what keeps the two cases from looking different, and any
      // "improvement" here would be a second layout to review rather than a safer
      // one. Two more of its declarations are reproduced below, for the seat's
      // other occupants — see the note there for why leaving them out would have
      // been worse than a gap.
      // The nested `:has()` is a different job: it holds the reflow to the ONE
      // foot area that actually contains this plugin's wide control, so a foot
      // belonging to something else — or this foot with the sidebar control
      // switched off in settings — is left exactly as the shell laid it out.
      //
      // `:has()` is load-bearing here and is not a progressive enhancement: in a
      // browser that does not understand it the selector is invalid and the whole
      // rule is dropped, leaving the control on the shell's own stacked row. That
      // is the same degradation as having no fallback at all, so nothing breaks —
      // it just does not help. The app ships Chromium 152, where it is supported.
      //
      // No `!important` here, unlike the placement rule above. That one carries it
      // because it competes with a blanket declaration of equal specificity inside
      // the other bundle; these declarations have nothing to outrank — the other
      // sheet declares the same values, so whichever rule wins the cascade, the
      // computed layout is the same.
      //
      // The seat is reached with a child combinator here where the placement rule
      // above uses a descendant one. The footnote on that rule explains why a child
      // combinator cannot be used THERE: the other bundle dissolves the box, so the
      // seat anchor may no longer be a direct child. In these rules the box is
      // being dissolved by them, so the anchor is still where the shell put it, and
      // a `>` keeps the reflow from reaching a nested foot area.
      "[class*=footArea]:has(.dshrb-sbwrap[data-dshrb-inrow]){",
      "flex-direction:row;flex-wrap:wrap;align-items:center}",
      "[class*=footArea]:has(.dshrb-sbwrap[data-dshrb-inrow]) ",
      "> [class*=footerActions]{display:contents}",
      "[class*=footArea]:has(.dshrb-sbwrap[data-dshrb-inrow]) ",
      "> [class*=settingsArea]{order:3;flex:1 1 auto;width:auto;min-width:0}",
      // The two rules below keep this fallback from being a LAYOUT CHANGE for
      // anyone else, which is a requirement rather than tidiness: the shell's
      // foot is shared, and making it a wrapping row moves every child of it.
      //
      // A foot child that is neither of the two boxes this plugin already
      // rearranged — another plugin's panel, a usage card — would otherwise slide
      // from a full row of its own into the bottom row beside the account row.
      // The `flex:1 1 100%` below is what the other bundle declares for those same
      // children and for the same reason, so this restores the shell's original
      // stacking for them instead of inventing a second answer. The bare `order:0`
      // default is intentional and does NOT need to be written: it sorts before
      // this plugin's `order:2` and the account row's `order:3`, so such a child
      // takes the first line, exactly as it did when the foot was a column.
      "[class*=footArea]:has(.dshrb-sbwrap[data-dshrb-inrow]) ",
      "> :not([class*=settingsArea]):not([class*=footerActions]){flex:1 1 100%;min-width:0}",
      // The seat is shared too, so this plugin must claim only its OWN wrapper in
      // it. `:not([class*=dshrb-])` excludes this plugin's markup and nothing
      // else, which is what lets the rule stay plain — there is no declaration
      // here for the control's own rule to outrank, because the control is simply
      // not selected.
      //
      // The two `:not()`s in front of it are the other bundle's OWN exemption,
      // copied rather than invented: that bundle's blanket full-row rule skips its
      // family's footer entries (`[data-dsh-part='entry']`, `[class*=entryRow]`).
      // This sheet's selector is MORE specific than that blanket rule, so without
      // the same exemption this sheet would silently overrule it and hand those
      // entries a full row of their own — a layout change for other plugins, in the
      // very state where that bundle is present and had been laying them out
      // correctly. The rule after this one restores its treatment of them, with its
      // values, so the two cases agree rather than merely coexist.
      //
      // These rules carry the same `:has()` scope as the reflow above, and here
      // that is load-bearing rather than consistent: they have to fire only while
      // the foot is the horizontal wrapping row those rules build. With the sidebar
      // control switched off the foot stays the shell's COLUMN, and `flex:1 1 100%`
      // would then resolve its basis against the column's HEIGHT — stretching
      // another plugin's control to the full height of the foot. The scope is what
      // keeps this rule from reaching a layout it was not written for.
      "[class*=footArea]:has(.dshrb-sbwrap[data-dshrb-inrow]) ",
      "> [class*=footerActions] ",
      "> [data-slot='sidebar.footer.action'] ",
      "> :not([data-dsh-part='entry']):not([class*=entryRow]):not([class*=dshrb-]){",
      "flex:1 1 100%;min-width:0}",
      // The exemption above has to leave those entries somewhere, and this is
      // where: the other bundle's own treatment of them, the same three values. A
      // family entry — an icon-sized row — closes the bottom line beside the
      // account row instead of stretching across one of its own.
      "[class*=footArea]:has(.dshrb-sbwrap[data-dshrb-inrow]) ",
      "> [class*=footerActions] ",
      "> [data-slot='sidebar.footer.action'] > [data-dsh-part='entry'],",
      "[class*=footArea]:has(.dshrb-sbwrap[data-dshrb-inrow]) ",
      "> [class*=footerActions] ",
      "> [data-slot='sidebar.footer.action'] > [class*=entryRow]{",
      "flex:0 0 auto;order:4;min-width:0}",
      // No margin in either state, and that is the flicker fix.
      //
      // While resting, the sliver reached the sidebar's edge by cancelling the
      // sidebar's inline padding with a negative margin — and that offset was
      // declared ONLY for the resting state. The pointer entering the sliver
      // cleared the resting state, so the offset disappeared with it and the box
      // jumped a whole padding-width sideways, out from under the cursor. That
      // reported `pointerleave`, which collapsed it again, which put the offset
      // back — landing the sliver under the cursor once more, forever. The user
      // saw the button flashing out and in.
      //
      // The measure is gone rather than moved, and the control now grows to the
      // RIGHT from an edge that never moves: at rest the sliver's left edge is
      // fixed by the row, and expanding only takes width from the account row
      // beside it, which starts to its right. Whichever pixel the pointer entered
      // therefore stays covered for the whole expansion and no pointer event is
      // fabricated by the geometry.
      // The reveal grows from the anchored edge, exactly as the floating strip
      // does; reusing the same keyframes with the origin moved to that edge. The
      // floating control is pinned to a screen edge, so its origin follows the
      // side it collapsed to; the sidebar control is always pinned on its left, and
      // states that origin on its own base rule rather than here, so it survives the
      // reveal being spent — see the note on `.dshrb-sb`.
      ".dshrb-btn[data-side='left']{transform-origin:left center}",
      ".dshrb-btn[data-side='right']{transform-origin:right center}",
      // The sidebar control reuses the reveal KEYFRAMES and the shared timing.
      //
      // The declaration is repeated here rather than inherited because the two
      // controls are different classes (`.dshrb-btn` / `.dshrb-sb`) and neither is
      // a descendant of the other, so there is no rule for the sidebar to inherit
      // from — deleting this line removes its reveal entirely.
      //
      // The duration and curve are the SAME literals as the floating control's, on
      // purpose: this started as a duplicated `.26s cubic-bezier(.34,1.56,.64,1)`
      // left over from when the sidebar had its own single-spring reveal. Sitting
      // later in the sheet it overrode the shared rule, so the sidebar kept a hard
      // 6% overshoot sailing past its target while the floating control eased, and
      // the curve's overshoot stacked on the keyframes' own — which is what read as
      // 偏硬 rather than jelly.
      ".dshrb-sb[data-reveal='true']{animation:dshrb-reveal .44s cubic-bezier(.22,1.1,.36,1)}",
      ".dshrb-sb[data-anim='press']{animation:dshrb-squash .16s ease-out forwards}",
      // NOTE the asymmetry with the floating control, recorded rather than silently
      // equalised:
      //
      //   press    both: .16s ease-out            ← identical
      //   release  sb:   .52s cubic-bezier(.36,1.4,.5,1)
      //            btn:  .46s cubic-bezier(.36,1.28,.5,1)
      //
      // So the two affordances share the `dshrb-jelly` KEYFRAMES but not its timing.
      // Whether that difference is deliberate has not been established from the
      // history, and unifying it is a visible change (a smaller control releasing a
      // touch faster), so it is left as-is and flagged here instead of being
      // "tidied" on a guess. If they were meant to match, this is the one line to
      // change — the same one-line shape the reveal already uses.
      ".dshrb-sb[data-anim='release']{animation:dshrb-jelly .52s cubic-bezier(.36,1.4,.5,1)}",
      // The sidebar control shares the reveal keyframes, and only the keyframes.
      //
      // There used to be a `.26s cubic-bezier(.34,1.56,.64,1)` animation declared
      // here. That was a leftover from when the sidebar had its own single-spring
      // reveal, and because it sat later in the sheet it OVERRODE the shared
      // duration and curve on the floating control's rule — so the sidebar kept a
      // hard 6% overshoot sailing past its target and snapping back while the
      // floating control eased. Two overshoots (the curve's and the keyframes')
      // also stacked on the same property, which is what read as "偏硬".
      //
      // The declaration is repeated here rather than inherited because the two
      // controls are different classes (`.dshrb-btn` / `.dshrb-sb`) and neither is
      // a descendant of the other, so there is no rule for the sidebar to inherit
      // from — deleting that line would remove its reveal entirely.
      // Configuration page contributed to the plugin manager.
      //
      // The standard row pattern, taken from an installed package that renders
      // into the same keyed seat (`dsh-mnemon`, `ToggleRow`): hairline-separated
      // rows, a left copy column whose title is 14px/400 `label-primary` with a
      // 12px `label-tertiary` hint under it, and the control right-aligned.
      // Rows are separated by a `--dsw-alias-border-l2` hairline instead of being
      // drawn as separate cards, and the LAST row drops the hairline.
      //
      // No page-level heading: the plugin manager already renders the package
      // h3 title, its name and its description directly above this contribution,
      // and repeating them here was the "display is not right" part.
      ".dshrb-cfg{display:flex;flex-direction:column;min-width:0}",
      ".dshrb-cfgrow{display:flex;flex-wrap:wrap;justify-content:space-between;",
      "align-items:center;gap:8px 16px;min-width:0;padding:14px 0;position:relative;",
      "border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3))}",
      ".dshrb-cfgrow:last-child{border-bottom:0}",
      ".dshrb-cfgtxt{display:flex;flex-direction:column;flex:1 1 0;gap:2px;",
      "min-width:min(240px,100%)}",
      ".dshrb-cfgtitle{color:var(--dsw-alias-label-primary,inherit);",
      "font-size:14px;font-weight:400;line-height:22px}",
      ".dshrb-cfgdetail{color:var(--dsw-alias-label-tertiary,rgba(127,127,127,.9));",
      "font-size:12px;line-height:18px}",
      ".dshrb-cfghint{color:var(--dsw-alias-label-secondary,rgba(127,127,127,.95));",
      "font-size:12px;line-height:18px;padding-top:4px}",
      ".dshrb-cfgerr{color:var(--dsw-alias-state-error-primary,#e06a6a);",
      "font-size:12px;line-height:18px;padding-top:6px}",
      // A switch that replicates the host's own `Switch` primitive, because the
      // plugin authoring guidance forbids importing that primitive and prescribes
      // exactly this instead: write your own control and match the host, copying
      // the markup, CSS and behavior out of the primitive, renaming the copied
      // classes under this plugin's prefix, keeping only `--dsw-alias-*` token
      // references, and preserving the behavior users rely on — notably the
      // `role="switch"` role together with `aria-checked`.
      //
      // (Prose above avoids double quotes on purpose: the stylesheet's own
      // contract checker rebuilds this array from its string literals, so a quote
      // inside a comment would shift that pairing. The one exception is the quoted
      // attribute below, which stays balanced.)
      //
      // The structure, geometry and states are therefore taken from the shipped
      // primitive (`@deepseek-ai/dsh-client-ui-primitives`, its Switch.module.css):
      // a 36x20 pill button with a 2px padding, `border-radius:999px`, a 16x16
      // round child thumb that travels 16px, an untracked state filled with
      // `--dsw-alias-border-l3`, a tracked state with `--dsw-alias-brand-primary`,
      // and `:disabled` at 50% opacity. It is a real `<button>` with a real
      // `<span>` child — not a checkbox styled with `:after` — because that is the
      // markup the host control uses and the one its focus and switch semantics
      // are defined for.
      //
      // The class names are the plugin's own (`dshrb-sw` / `dshrb-swthumb`), as the
      // guidance requires, and only `--dsw-alias-*` tokens are referenced, so a
      // renamed token degrades the appearance without breaking the control.
      ".dshrb-sw{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;",
      "padding:2px;border:0;border-radius:999px;corner-shape:round;",
      "background:var(--dsw-alias-border-l3,rgba(127,127,127,.22));cursor:pointer}",
      ".dshrb-sw[aria-checked='true']{background:var(--dsw-alias-brand-primary,#4d6bfe)}",
      ".dshrb-sw:disabled{cursor:default;opacity:.5}",
      // The focus ring is taken from the host's own tokens rather than hard-coded.
      // `--dsw-focus-ring-width` is 2px and `--dsw-focus-ring-color` is
      // `transparent` in the shipped theme, so the host's `outline: <width> solid
      // <color>` falls back to `--dsw-alias-state-business-primary` through the
      // var() fallback in color position. Copying the same two tokens means a theme
      // that restyles focus restyles this control too.
      ".dshrb-sw:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid ",
      "var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:2px}",
      ".dshrb-swthumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;",
      "background:var(--dsw-alias-label-primary-foreground,#fff);transition:transform .12s ease}",
      ".dshrb-sw[aria-checked='false'] .dshrb-swthumb{background:var(--dsw-alias-switch-thumb,#fff)}",
      ".dshrb-sw[aria-checked='true'] .dshrb-swthumb{transform:translate(16px)}",
      // #region opaque surfaces
      //
      // The three panel surfaces must be hard-opaque while still taking their
      // COLOUR from the theme, and the theme's colour tokens are not reliably
      // opaque: a skin plugin redefines them with an alpha that follows its own
      // "background occlusion" slider. Measured on this machine, with the
      // blue-fantasy skin at its configured 100, the skin installs
      //
      //   --dsw-alias-bg-layer-1: rgba(243,245,251, calc(1 - var(--dsw-skin-scrim,0) * .5))
      //
      // and `--dsw-skin-scrim` resolves to 1, so the token is only 50% opaque and
      // the panels let the page through. Swapping tokens does not help: the same
      // skin redefines `bg-base`, `bg-layer-2/3`, `bg-overlay` and
      // `bg-module-platform` the same way.
      //
      // Relative colour syntax separates a colour's CHANNELS from its alpha, so the
      // panel can keep following the theme's colour and force the alpha to 1:
      //
      //   rgb(from <colour> r g b / 1)
      //
      // Two properties of this were measured in headless Chromium rather than
      // assumed, because both are easy to get wrong:
      //
      // 1. The `/ 1` is REQUIRED. `rgb(from <colour> r g b)` with no explicit alpha
      //    does not strip it — the resulting alpha is the source colour's own
      //    (measured 0.5 light / 0.55 dark, i.e. still translucent).
      // 2. The fallback must live INSIDE `var()`. A separate preceding declaration
      //    is not a safety net: when the token is undefined the whole
      //    `rgb(from ...)` declaration is invalid at computed-value time and the
      //    background computes to fully transparent (measured
      //    `rgba(0, 0, 0, 0)`), because that invalid-at-computed-value behaviour
      //    does not fall back to the earlier declaration. So each rule writes
      //    `var(--token, <opaque literal>)` first, and the token with the opaque
      //    literal inlined as its fallback.
      //
      // `@supports` is used purely for scoping: without support the plain token
      // declaration (today's behaviour) applies and nothing breaks, because a rule
      // whose declaration is invalid is simply dropped, not the whole stylesheet.
      "@supports (background: rgb(from red r g b / 1)){",
      ".dshrb-menu{background:rgb(from var(--dsw-alias-bg-layer-1,rgba(28,28,30,.97)) r g b / 1)}",
      ".dshrb-btn{background:rgb(from var(--dsw-alias-bg-layer-1,rgba(28,28,30,.86)) r g b / 1)}",
      ".dshrb-toast{background:rgb(from var(--dsw-alias-bg-layer-1,rgba(28,28,30,.97)) r g b / 1)}",
      "}",
      // #endregion opaque surfaces
      "@media (prefers-reduced-motion:reduce){.dshrb-btn,.dshrb-sb{transition:none}",
      ".dshrb-btn[data-anim],.dshrb-sb[data-anim],.dshrb-btn[data-reveal='true'],.dshrb-sb[data-reveal='true'],",
      ".dshrb-menu,.dshrb-juice{animation:none}",
      ".dshrb-swthumb{transition:none}}",
    ].join("")

    function ensureStyles() {
      var style = document.getElementById(STYLE_ID)
      if (style === null) {
        style = document.createElement("style")
        style.id = STYLE_ID
        document.head.appendChild(style)
      }
      // Assigned on every apply, not only on creation. A client hot reload
      // re-evaluates this factory while the PREVIOUS <style> element is still in
      // the DOM, so a create-once guard would keep serving the stale sheet and a
      // CSS fix would silently never reach a reloaded page.
      if (style.textContent !== CSS) style.textContent = CSS
    }

    // #endregion styles

    // #region failure text

    /**
     * Turn a Host failure into something the user can act on.
     *
     * The Host answers with a short machine code (`already-running`,
     * `unsupported`, `spawn-failed`, `refused`, …). Two of those are situations
     * rather than faults and get their own wording; everything else, including a
     * transport error, keeps its own message so the real cause stays visible
     * instead of being flattened into one generic line.
     *
     * The Host also attaches a `reason` to some failures, and for those it is the
     * ONLY actionable part: `refused` and `spawn-failed` name a category, while the
     * reason says which category member it was (a pid-reuse guard naming both
     * executables, a missing PowerShell path). Showing the bare code there told the
     * user nothing they could act on — and left the Host-side promise that the UI
     * explains the block unfulfilled. The two codes with their own wording keep it:
     * their copy is already the better sentence.
     *
     * @param error - the rejection from `api.action`.
     * @returns the text to show in the menu.
     */
    function describeFailure(error) {
      var code = error instanceof Error ? error.message : String(error)
      if (code === CODE_BUSY) return TEXT.busy
      if (code === CODE_UNSUPPORTED) return TEXT.unsupported
      if (code === "") return TEXT.failed
      var reason = error instanceof Error && typeof error.reason === "string" ? error.reason : ""
      return reason === "" ? code : code + ": " + reason
    }

    // #endregion failure text

    // #region icons

    /** The power glyph, drawn at `size` pixels square. */
    function powerIcon(size) {
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false",
        },
        h("path", { d: "M12 3v9", key: "bar" }),
        h("path", { d: "M18.4 6.6a9 9 0 1 1-12.8 0", key: "arc" }),
      )
    }

    /**
     * The mark a COLLAPSED sliver carries.
     *
     * It used to be a second, smaller power glyph. The user asked for it to be
     * one plain vertical line instead: at 8px and 14px of width the glyph was
     * legible but busy, and a lone line says "a bar lives here, it opens" without
     * pretending to be a second button with its own symbol.
     *
     * The line PAINTS from `currentColor` — `background: currentColor` in
     * `.dshrb-mark` — but its colour is not inherited: the same rule states it
     * explicitly, and that is a measured fix rather than redundancy. The two
     * slivers sit in different ancestors, so an inherited `currentColor` made the
     * same line come out in two different colours; the explicit value is what makes
     * one rule drive both. See the four rules that follow `.dshrb-mark`.
     *
     * It is a plain element rather than an SVG because a single 2px rule needs no
     * path.
     *
     * One element for both slivers (the floating strip and the sidebar sliver),
     * so the two can never drift apart.
     */
    function sliverMark() {
      return h("span", { className: "dshrb-mark", "aria-hidden": "true" })
    }

    // #endregion icons

    // #region press feedback

    /**
     * Press/release animation and its juice droplets.
     *
     * One hook per control so both affordances behave identically. The class is
     * cleared on a timer instead of relying on `animationend`, because a rapid
     * press-release-press sequence can drop that event and would then leave the
     * element stuck mid-squash.
     *
     * @returns `{ anim, juice, onPress, onRelease }`. `clear` is internal: it
     *   cancels the pending class-clear timer and is called by `arm` below.
     */
    function usePressFeedback() {
      var animState = useState("")
      var anim = animState[0]
      var setAnim = animState[1]
      var juiceState = useState(null)
      var juice = juiceState[0]
      var setJuice = juiceState[1]
      var timerRef = useRef(null)

      var clear = useCallback(function () {
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current)
          timerRef.current = null
        }
      }, [])

      useEffect(function () {
        return function () {
          if (timerRef.current !== null) window.clearTimeout(timerRef.current)
        }
      }, [])

      var arm = useCallback(
        function (next) {
          clear()
          setAnim(next)
          timerRef.current = window.setTimeout(function () {
            timerRef.current = null
            setAnim("")
          }, JELLY_MS)
        },
        [clear],
      )

      var onPress = useCallback(
        function (event) {
          arm("press")
          // Squeeze a few droplets out of the button, aimed away from the click.
          var x = event && typeof event.clientX === "number" ? event.clientX : null
          var y = event && typeof event.clientY === "number" ? event.clientY : null
          if (x === null || y === null) {
            setJuice(null)
            return
          }
          var drops = []
          for (var index = 0; index < 6; index += 1) {
            var angle = (Math.PI * 2 * index) / 6 + 0.4
            var reach = 16 + (index % 3) * 7
            drops.push({
              key: index,
              x: x,
              y: y,
              dx: Math.round(Math.cos(angle) * reach) + "px",
              dy: Math.round(Math.sin(angle) * reach) + "px",
            })
          }
          setJuice({ id: Date.now(), drops: drops })
        },
        [arm],
      )

      var onRelease = useCallback(
        function () {
          setJuice(null)
          arm("release")
        },
        [arm],
      )

      return { anim: anim, juice: juice, onPress: onPress, onRelease: onRelease }
    }

    /**
     * Whether this face's one-shot reveal animation should still be armed.
     *
     * `data-reveal='true'` is not decoration on a state marker: it is the reveal's
     * ANIMATION TRIGGER, and it is one of two rules that claim the `animation`
     * shorthand on the same element at the same specificity (the press/release pair
     * sits later in the sheet, so it wins while a click is running). Clearing
     * `data-anim` at the end of a click therefore hands the shorthand BACK to the
     * reveal rule — and a hand-back is not a no-op: the browser sees an animation
     * list whose name changed and starts `dshrb-reveal` over, from a 0% frame that is
     * `transform:scale(.5,1)` at `opacity:0`.
     *
     * That is a blink on every click of BOTH affordances: the control vanishes and
     * grows back. Measured in Chromium 154 by driving the emitted attributes in order
     * against this sheet and reading `getAnimations()`: at the instant `data-anim`
     * returns to `""` the element reports `dshrb-reveal@0ms/running` with a computed
     * `opacity` of `0`, while the identical sequence on a face carrying no
     * `data-reveal` reports no animation and `opacity: 1`.
     *
     * The fix is to treat the reveal as what it has always been in spirit — a
     * one-shot, exactly like the press feedback — instead of as a live property of the
     * revealed state. It is armed on the RISING EDGE of `revealed` and disarmed for
     * the remainder of that reveal, so the hand-back lands on the resting rule and
     * changes nothing. Leaving the face and entering it again re-arms it, so a fresh
     * reveal still slides; that is why the disarm cannot simply be
     * "revealed is false", which would leave the attribute in place across a
     * collapse/expand and quietly stop the slide from ever playing again.
     *
     * Disarming also happens while a press animation is running, and that is
     * deliberate: the press rule outranks the reveal anyway, so an arm taken there
     * would be invisible until the hand-back made it visible in the one way this hook
     * exists to prevent. The cost is stated rather than hidden: an entrance that lands
     * inside a jelly loses THAT reveal's slide entirely (it is not merely covered by
     * the jelly — the slide never plays), and the next entrance still slides. Arming
     * it at the end of the jelly instead would put the attribute back on an element
     * that is already painted at full size, which is the blink itself; there is no
     * third option, so the cheaper of the two is taken.
     *
     * @param revealed - whether the expanded face is on screen.
     * @param interacting - the running press/release class, or `""` when idle.
     * @returns `true` while the reveal should stay armed.
     */
    function useRevealArm(revealed, interacting) {
      var armState = useState(false)
      var armed = armState[0]
      var setArmed = armState[1]

      // The PREVIOUS render's `revealed`, kept as STATE rather than in a ref so that a
      // render React discards throws its edge detection away with it. A ref would
      // advance on a discarded render while the arm update that render justified was
      // dropped, which is the one asymmetry that could either swallow a reveal's arm or
      // take it again on an element that is already painted.
      //
      // Both writes below are the documented "adjust state during render" pattern
      // rather than effects: an effect would add the attribute AFTER the expanded face
      // has been painted, so the control would show at full size for one frame before
      // the slide began. Each branch fires only while its value actually differs, so
      // the loop settles after at most one extra pass.
      var previousState = useState(false)
      var previous = previousState[0]
      var setPrevious = previousState[1]
      if (previous !== revealed) {
        setPrevious(revealed)
        // Rising edge: arm, unless a press animation already holds the shorthand.
        // (`interacting !== ""` is belt-and-braces here — the `else` branch below would
        // disarm it again in the same commit cycle anyway — but it saves a discarded
        // state flip and states the rule where the edge is read.)
        // Falling edge: release the arm, so that the next entrance re-arms it — which
        // is why this cannot simply be "revealed is false" in the render below.
        setArmed(revealed && interacting === "")
      } else if (armed && interacting !== "") {
        // A press takes the arm away for the remainder of this reveal.
        setArmed(false)
      }
      return armed
    }

    /** Render the droplets of one press, if any. */
    function juiceNodes(juice) {
      if (juice === null) return []
      return juice.drops.map(function (drop) {
        return h("span", {
          key: "juice-" + juice.id + "-" + drop.key,
          className: "dshrb-juice",
          style: {
            left: drop.x + "px",
            top: drop.y + "px",
            "--dx": drop.dx,
            "--dy": drop.dy,
          },
        })
      })
    }

    // #endregion press feedback

    // #region power menu

    /**
     * The restart/quit menu state machine, shared by both affordances.
     *
     * Phase and intent are separate values: the phase is not a function of the
     * intent, and both the confirmation and the error screen must remember which
     * action they belong to, or a retry after a failed restart would quit.
     *
     * @param api - Host route client.
     * @returns the menu state and the transitions the panel needs.
     */
    function usePowerMenu(api) {
      /** `null` closed, `menu`, `confirm`, `busy`, or `error`. */
      var phaseState = useState(null)
      var phase = phaseState[0]
      var setPhase = phaseState[1]
      var intentState = useState(null)
      var intent = intentState[0]
      var setIntent = intentState[1]
      var errorState = useState("")
      var errorText = errorState[0]
      var setErrorText = errorState[1]

      /**
       * Timer of the in-flight action, so unmounting can cancel it.
       *
       * The action's own resolution clears this, but the component can also go
       * away while the request is still open (a client reload, a hot swap, the
       * user closing the window). Without this the timer would fire afterwards
       * and set state on an unmounted component.
       */
      var timerRef = useRef(null)
      useEffect(
        function () {
          return function () {
            if (timerRef.current !== null) {
              window.clearTimeout(timerRef.current)
              timerRef.current = null
            }
          }
        },
        [],
      )

      /**
       * Whether any agent is working, as last reported by the Host.
       *
       * `undefined` means "not answered yet", which is treated as working.
       * Fetched when the menu OPENS rather than when a row is clicked: the click
       * must stay synchronous, and a round trip inside the click path would make
       * the row feel unresponsive. A localhost probe beats any human click, so it
       * has virtually always answered by the time a row is chosen; if it has not,
       * the fail-safe answer is to ask.
       */
      var workingState = useState(undefined)
      var working = workingState[0]
      var setWorking = workingState[1]

      var close = useCallback(function () {
        setPhase(null)
        setIntent(null)
        setErrorText("")
      }, [])

      /** Open the list, refreshing the "is work running" fact for this opening. */
      var open = useCallback(
        function () {
          setErrorText("")
          setIntent(null)
          setPhase("menu")
          setWorking(undefined)
          api.status().then(
            function (status) {
              setWorking(status === null || status.working !== false)
            },
            function () {
              // The probe failed, so the question is unanswerable: fail safe.
              setWorking(true)
            },
          )
        },
        [api],
      )

      /** Ask the Host to restart or quit. */
      var run = useCallback(
        function (action) {
          setPhase("busy")
          var settled = false
          // The page normally dies mid-request. If it does not, report that
          // rather than showing "restarting" forever.
          if (timerRef.current !== null) window.clearTimeout(timerRef.current)
          timerRef.current = window.setTimeout(function () {
            timerRef.current = null
            if (settled) return
            settled = true
            setErrorText(TEXT.timeout)
            setPhase("error")
          }, ACTION_TIMEOUT_MS)
          api.action(action).then(
            function () {
              // Resolving means the Host ACCEPTED the action, so this page is
              // about to die with the shell. Keep the busy notice rather than
              // flashing an outcome the user will never read, and keep the
              // timeout armed so a page that unexpectedly survives still gets
              // told the action did not take effect.
              //
              // There is no "answered but unconfirmed" case to handle here:
              // `api.action` resolves only with a body whose `ok` is true, and
              // throws otherwise (a rejection, an unreadable body, or an error
              // code). A branch for a null answer would be unreachable.
              return
            },
            function (error) {
              if (settled) return
              settled = true
              if (timerRef.current !== null) {
                window.clearTimeout(timerRef.current)
                timerRef.current = null
              }
              setErrorText(describeFailure(error))
              setPhase("error")
            },
          )
        },
        [api],
      )

      /**
       * Confirm only when it is warranted, otherwise act immediately.
       *
       * The rule: confirm when an agent is working (subagents included), because
       * that is the case where the click destroys work the user cannot get back.
       * Otherwise act at once — an idle DSH has nothing to lose, and a second
       * "are you sure?" for a no-op is friction on the common path.
       *
       * Synchronous on purpose. The `working` fact was fetched when the menu
       * opened (see `open`), so this never waits; an unanswered or unreadable
       * fact fails safe to asking.
       *
       * Defined AFTER `run` so it closes over that binding.
       */
      var choose = useCallback(
        function (action) {
          setErrorText("")
          setIntent(action)
          if (working === false) run(action)
          else setPhase("confirm")
        },
        [run, working],
      )

      return {
        phase: phase,
        intent: intent,
        errorText: errorText,
        open: open,
        close: close,
        choose: choose,
        run: run,
        /** The action the current panel is about. */
        current: intent === "quit" ? "quit" : "restart",
      }
    }

    /**
     * The menu panel itself.
     *
     * Every row is a real `<button>`, so hover highlighting, focus and keyboard
     * activation all come from the element rather than from a synthetic
     * pointer-over state that a drag region can freeze.
     *
     * The action a panel is about is read from `props.menu.current`, never from
     * a separate prop: the two must not be able to disagree, or the
     * confirmation would name one action while its button ran the other.
     *
     * @param props - `{ menu, style, hint, panelRef }`. `hint` is the drag/collapse
     * line, and it is opt-in per affordance: only the floating control can be
     * dragged, so printing it under the sidebar menu described a gesture that does
     * not exist there. `panelRef` is attached to the panel node itself, and only the
     * sidebar menu passes it — its panel leaves the trigger's subtree for the
     * overlay host, so the dismiss hook has to be told about the panel separately.
     */
    function MenuPanel(props) {
      var menu = props.menu
      var items = []
      var isRestart = menu.current !== "quit"

      if (menu.phase === "menu") {
        items.push(
          h(
            "button",
            {
              key: "restart",
              type: "button",
              className: "dshrb-item",
              onClick: function () {
                props.menu.choose("restart")
              },
            },
            powerIcon(15),
            h("span", { key: "label" }, TEXT.restart),
          ),
          h(
            "button",
            {
              key: "quit",
              type: "button",
              className: "dshrb-item",
              "data-danger": "true",
              onClick: function () {
                props.menu.choose("quit")
              },
            },
            h("span", { key: "mark", style: { width: "15px", display: "inline-block", textAlign: "center" } }, "\u2715"),
            h("span", { key: "label" }, TEXT.quit),
          ),
          // The drag/collapse hint belongs to the FLOATING control only. The
          // sidebar control is not draggable, so the menu there must not advertise
          // it; `props.hint` is passed by whichever affordance has the gesture.
          props.hint === undefined || props.hint === null
            ? null
            : h("div", { key: "hint", className: "dshrb-hint" }, props.hint),
        )
      } else {
        items.push(
          h(
            "div",
            { key: "title", className: "dshrb-title" },
            isRestart ? TEXT.confirmRestartTitle : TEXT.confirmQuitTitle,
          ),
          h("div", { key: "detail", className: "dshrb-note" }, TEXT.confirmDetail),
        )
        if (menu.phase === "error") {
          items.push(h("div", { key: "error", className: "dshrb-note" }, menu.errorText || TEXT.failed))
        }
        items.push(
          h(
            "div",
            { key: "row", className: "dshrb-row" },
            h(
              "button",
              {
                key: "cancel",
                type: "button",
                className: "dshrb-item",
                onClick: function () {
                  props.menu.close()
                },
              },
              TEXT.cancel,
            ),
            h(
              "button",
              {
                key: "go",
                type: "button",
                className: "dshrb-item dshrb-primary",
                onClick: function () {
                  props.menu.run(isRestart ? "restart" : "quit")
                },
              },
              menu.phase === "error" ? TEXT.retry : TEXT.confirm,
            ),
          ),
        )
      }

      return h(
        "div",
        {
          className: "dshrb-menu",
          style: props.style,
          role: "menu",
          "data-dsh-part": "restart-menu",
          // Forwarded so a caller can treat the panel as part of its own click
          // region. Required by the sidebar menu, whose panel is portalled out of
          // its trigger's subtree.
          //
          // Passed as an ORDINARY PROP and attached to the node here, rather than
          // handed over as React's own `ref`. A `ref` on a function component is
          // not readable from `props`: React strips it before the component runs
          // (and only `forwardRef` — or React 19 — hands it through), so
          // `props.ref` would silently be `undefined` and the dismiss hook would
          // get a null node. The failure would be invisible in any "does the panel
          // open" assertion and would only show up as the menu closing on its own
          // buttons.
          ref: props.panelRef,
        },
        items,
      )
    }

    /** The "working on it" notice shown while an action is in flight. */
    function BusyToast(props) {
      if (props.menu.phase !== "busy") return null
      return h(
        "div",
        { key: "toast", className: "dshrb-toast" },
        props.menu.current === "quit" ? TEXT.quitting : TEXT.restarting,
      )
    }

    // #endregion power menu

    // #region floating affordance

    /**
     * The floating control's own button, in both states it can take.
     *
     * The control renders as this button in two shapes — the EXPANDED face of a
     * docked strip (`revealed`), and a plain undocked button — and they were written
     * out as two separate `h("button", {...})` calls that differed only in
     * `data-reveal`, `data-side` and the four pointer/focus handlers. Every prop they
     * shared was therefore duplicated, so a change to one (the `aria` pair, the
     * `data-dragging` marker, the icon size) could silently miss the other and leave
     * two faces of one control behaving differently.
     *
     * Only the REVEALED face carries pointer handlers, and that is deliberate rather
     * than an omission: only a docked control has a collapse to hover out of. An
     * undocked button's `hovered` flag changes nothing it renders, so binding the
     * handlers there would be state churn with no visible effect.
     *
     * @param spec - `{ anim, expanded, dragging, onKeyDown, onPointerDown, revealed,
     *   revealArmed, side, style }`. `side` is used only when `revealed`, and
     *   `revealArmed` only when it is true — see `useRevealArm` for why the reveal
     *   trigger is the arm rather than the revealed state.
     */
    function floatingButton(spec) {
      var props = {
        key: "button",
        type: "button",
        className: "dshrb-btn",
        "data-dsh-part": "restart-button",
        "data-dragging": spec.dragging ? "true" : "false",
        "data-anim": spec.anim,
        style: spec.style,
        title: TEXT.label,
        "aria-label": TEXT.label,
        "aria-haspopup": "menu",
        "aria-expanded": spec.expanded,
        onPointerDown: spec.onPointerDown,
        onKeyDown: spec.onKeyDown,
      }
      if (!spec.revealed) return h("button", props, powerIcon(22))
      // The side this control is pinned to, so the shared reveal can put its origin
      // on that edge. Growing from the centre would move BOTH edges, which is what
      // makes the reveal read as a pop, and on the pinned side it can also push the
      // box off the pixel the cursor entered.
      //
      // Keyed on the revealed state, not on the arm: the origin outlives the reveal
      // so the hover scale and the press jelly keep growing from the pinned edge
      // after the reveal has been spent.
      props["data-side"] = spec.side === "left" || spec.side === "right" ? spec.side : null
      // The reveal TRIGGER, which is the arm rather than the state — a `data-reveal`
      // that outlives the reveal replays it the instant a click's press class is
      // cleared. See `useRevealArm`.
      if (spec.revealArmed) props["data-reveal"] = "true"
      props.onPointerEnter = function () {
        spec.setHovered(true)
      }
      props.onPointerLeave = function () {
        // No `menu.phase === null` guard, for the same reason as the sidebar's:
        // swallowing the leave that happens while the panel is open strands `hovered`
        // at true, so the control stayed expanded after the panel closed. The reveal
        // needs no help — `menu.phase !== null` holds it open while the panel is up,
        // and it is re-evaluated on every render, so a real leave recorded now takes
        // effect the moment the menu closes.
        spec.setHovered(false)
      }
      props.onFocus = function () {
        spec.setHovered(true)
      }
      props.onBlur = function () {
        spec.setHovered(false)
      }
      return h("button", props, powerIcon(22))
    }

    /**
     * The floating control.
     *
     * @param props - `{ api }`, the Host route client.
     */
    function FloatingPower(props) {
      var api = props.api
      var config = useConfig()

      var posState = useState(loadPos)
      var pos = posState[0]
      var setPos = posState[1]

      var dragState = useState(false)
      var dragging = dragState[0]
      var setDragging = dragState[1]

      /**
       * Whether the pointer is over a collapsed strip.
       *
       * A collapsed strip expands back into the full button while the pointer is
       * on it, and collapses again when the pointer leaves. It is separate from
       * the position so the collapsed state survives the temporary reveal.
       */
      var hoverState = useState(false)
      var hovered = hoverState[0]
      var setHovered = hoverState[1]

      /** Live drag bookkeeping; a ref because move handlers must not re-bind. */
      var dragRef = useRef(null)
      var rootRef = useRef(null)
      var feedback = usePressFeedback()
      var menu = usePowerMenu(api)

      // The two derived flags are computed HERE, above the visibility guards, because
      // the reveal arm is a hook and a hook may not run after a conditional return.
      // A collapsed strip renders in full while hovered, while its menu is open, or
      // while a drag is in flight.
      //
      // `dragging` is what makes a drag out of the collapsed strip start from the
      // EXPANDED form. Pressing the strip calls `setHovered(false)` (the press
      // handler below), so without this term the very press that begins a drag
      // dropped `hovered`, the control fell back to the 8px sliver, and only the
      // first `pointermove` — which clears `collapsed` outright — brought the full
      // button back. The user saw it snap shut under the finger and then jump to the
      // cursor. Holding the reveal for the whole gesture removes that gap: the
      // press expands it and it stays expanded as it follows the pointer.
      var strip = isStrip(pos)
      var revealed = strip && (hovered || dragging || menu.phase !== null)
      var revealArmed = useRevealArm(revealed, feedback.anim)

      /** Capability probe: decides whether this control exists at all. */
      var supported = useSupported(api)

      /** Keep the control reachable when the window shrinks or is rotated. */
      useEffect(function () {
        var onResize = function () {
          setPos(function (previous) {
            var next = reclamp(previous)
            storePos(next)
            return next
          })
        }
        window.addEventListener("resize", onResize)
        return function () {
          window.removeEventListener("resize", onResize)
        }
      }, [])

      /** A press anywhere outside closes the menu. */
      useDismissOnOutsidePress(menu, [rootRef])

      var endDrag = useCallback(function () {
        dragRef.current = null
        setDragging(false)
      }, [])

      /**
       * Track an active drag on `window`, not on the dragged element.
       *
       * Pointer capture on the element is not usable here: the strip is replaced
       * by the expanded button as soon as the drag starts expanding it, and
       * unmounting the captured element would drop the capture and freeze the
       * drag midway. Window-level listeners survive that swap.
       */
      useEffect(
        function () {
          if (!dragging) return undefined

          var onMove = function (event) {
            var drag = dragRef.current
            if (drag === null || event.pointerId !== drag.pointerId) return
            var dx = event.clientX - drag.startX
            var dy = event.clientY - drag.startY
            if (!drag.moved && Math.abs(dx) + Math.abs(dy) > CLICK_SLOP) drag.moved = true
            if (!drag.moved) return
            var point = clampToViewport(drag.origX + dx, drag.origY + dy)
            setPos({ x: point.x, y: point.y, side: null, collapsed: false })
          }

          var onUp = function (event) {
            var drag = dragRef.current
            if (drag === null || event.pointerId !== drag.pointerId) return
            endDrag()
            feedback.onRelease()
            if (!drag.moved) {
              // A plain click opens the menu and changes NOTHING else.
              //
              // It used to also un-dock the control: a click on a collapsed strip
              // rewrote the position to `{side: null, collapsed: false}` and
              // persisted it. The reveal did not need that — `menu.phase !== null`
              // already holds the button open for as long as the panel is up, and
              // `dragging` holds it for the press — but the rewrite outlived the
              // menu, so the control stayed permanently expanded after the panel
              // closed and only a fresh drag could dock it again. Reported as
              // "鼠标点击旁边空白位置，菜单收回，按钮并没有收回侧边 … 常驻展开了，必须要
              // 再拖动一次重新靠边才可以正常收回".
              //
              // Leaving the position alone is also the honest behaviour: nothing
              // moved the control, so nothing should move it. Only a drag rewrites
              // where it lives.
              //
              // An already-open panel is not re-opened, so this click CLOSES it:
              // the press closed it unconditionally (a drag must not leave a menu
              // beside a moving control), and re-opening here would make the button
              // unable to dismiss its own menu — pointerdown close, pointerup open,
              // net no change plus a `dshrb-pop` replay.
              if (!drag.wasOpen) menu.open()
              return
            }
            setPos(function (previous) {
              var next = settle(previous)
              storePos(next)
              return next
            })
          }

          var onCancel = function () {
            endDrag()
          }

          window.addEventListener("pointermove", onMove)
          window.addEventListener("pointerup", onUp)
          window.addEventListener("pointercancel", onCancel)
          return function () {
            window.removeEventListener("pointermove", onMove)
            window.removeEventListener("pointerup", onUp)
            window.removeEventListener("pointercancel", onCancel)
          }
        },
        [dragging, endDrag, feedback.onRelease, menu.open],
      )

      var onPointerDown = useCallback(
        function (event) {
          if (event.button !== 0) return
          if (menu.phase === "busy") return
          event.preventDefault()
          feedback.onPress(event)
          dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            origX: pos.x,
            origY: pos.y,
            moved: false,
            // Whether a panel was open when this gesture began.
            //
            // The press closes the panel — a drag should not leave a menu hanging
            // beside a control that is moving — but the release re-opens it when the
            // gesture turns out to be a plain click. Without this term the two
            // cancelled out and the menu could never be closed by pressing the button
            // that opened it: pointerdown closed it, pointerup opened it again, and
            // the un-mount/remount also replayed the `dshrb-pop` flash. The sidebar
            // control has always toggled; this makes the floating one agree.
            wasOpen: menu.phase !== null,
          }
          setDragging(true)
          setHovered(false)
          menu.close()
        },
        [menu.phase, menu.close, pos.x, pos.y, feedback.onPress],
      )

      var onKeyDown = useCallback(
        function (event) {
          if (event.key === "Escape") {
            menu.close()
            return
          }
          if (event.key === "Enter" || event.key === " ") {
            // Keyboard equivalent of a click on the collapsed strip.
            event.preventDefault()
            menu.open()
          }
        },
        [menu.close, menu.open],
      )

      // Hidden by its own switch, or by the capability probe.
      if (config.values.floating !== true) return null
      if (supported !== true) return null

      var v = viewport()
      var children = []

      // Whether a PANEL is on screen, which is not the same as `menu.phase !== null`:
      // in `busy` the panel is replaced by the busy notice, so there is nothing for
      // `aria-expanded` to be true about and no confirmation buttons to press. One
      // variable drives both the render and the attribute, so the assistive-tech
      // claim cannot drift from what is actually drawn — and `MenuPanel` is never
      // mounted in `busy`, which is what stops a second press on the confirm button
      // from firing the action again while the first one is still in flight.
      var panelShown = menu.phase !== null && menu.phase !== "busy"

      var buttonStyle = {
        width: SIZE + "px",
        height: SIZE + "px",
      }
      if (strip) {
        // Keep the outer edge pinned, so the reveal grows inward and the pointer
        // never leaves the element. The top comes from the shared helper the strip
        // itself uses — see `pinnedTop`.
        buttonStyle.top = pinnedTop(pos) + "px"
        if (pos.side === "left") buttonStyle.left = "0px"
        else buttonStyle.right = "0px"
      } else {
        var spot = clampToViewport(pos.x, pos.y)
        buttonStyle.left = spot.x + "px"
        buttonStyle.top = spot.y + "px"
      }

      if (revealed) {
        children.push(
          floatingButton({
            anim: feedback.anim,
            dragging: dragging,
            expanded: panelShown,
            onKeyDown: onKeyDown,
            onPointerDown: onPointerDown,
            revealed: true,
            revealArmed: revealArmed,
            setHovered: setHovered,
            side: pos.side,
            style: buttonStyle,
          }),
        )
      } else if (strip) {
        // The strip is the BUTTON's height, centred on the button's centre, so the
        // reveal swaps an identically tall box for an identically tall box. The
        // width is the only axis that differs, which is what makes it read as the
        // button sliding out of the edge rather than as a different object. The top
        // is the SAME expression the button uses (`pinnedTop`), not a copy of it:
        // the first reveal frame only covers the strip if the two agree exactly.
        var stripStyle = { top: pinnedTop(pos) + "px", width: STRIP_W + "px", height: SIZE + "px" }
        if (pos.side === "left") stripStyle.left = "0px"
        else stripStyle.right = "0px"
        children.push(
          h("button", {
            key: "strip",
            type: "button",
            className: "dshrb-strip",
            "data-dsh-part": "restart-strip",
            "data-side": pos.side,
            style: stripStyle,
            title: TEXT.label,
            "aria-label": TEXT.label,
            "aria-haspopup": "menu",
            "aria-expanded": false,
            onPointerDown: onPointerDown,
            onPointerEnter: function () {
              setHovered(true)
            },
            onFocus: function () {
              setHovered(true)
            },
            onKeyDown: onKeyDown,
          }, sliverMark()),
        )
      } else {
        children.push(
          floatingButton({
            anim: feedback.anim,
            dragging: dragging,
            expanded: panelShown,
            onKeyDown: onKeyDown,
            onPointerDown: onPointerDown,
            revealed: false,
            // An undocked control has no edge to slide out of, so it never arms the
            // reveal at all — the property is stated rather than left to the arm's
            // `revealed &&` term, which would be a second place to get it wrong.
            revealArmed: false,
            setHovered: setHovered,
            side: null,
            style: buttonStyle,
          }),
        )
      }

      if (panelShown) {
        var anchorX = strip ? (pos.side === "right" ? v.w - SIZE : 0) : pos.x
        // The panel anchors to the control's top edge, from the same helper the
        // control itself is placed with — a second copy of this arithmetic would let
        // the panel drift off the thing it is pointing at.
        var anchorY = strip ? pinnedTop(pos) : pos.y
        var openLeft = pos.side === "right" || anchorX + SIZE / 2 > v.w / 2
        var menuLeft = openLeft ? anchorX - MENU_W - 10 : anchorX + SIZE + 10
        children.push(
          h(MenuPanel, {
            key: "menu",
            menu: menu,
            // Only this affordance can be dragged and collapsed, so only this
            // menu carries the hint. The sidebar panel passes none.
            hint: TEXT.hint,
            style: {
              left: clamp(menuLeft, PANEL_MARGIN, Math.max(PANEL_MARGIN, v.w - MENU_W - PANEL_MARGIN)) + "px",
              top: clamp(anchorY, PANEL_MARGIN, Math.max(PANEL_MARGIN, v.h - MENU_H - PANEL_MARGIN)) + "px",
              width: MENU_W + "px",
            },
          }),
        )
      }

      children.push(h(BusyToast, { key: "busy", menu: menu }))
      children.push(juiceNodes(feedback.juice))

      return h("div", { className: "dshrb-root", ref: rootRef, "data-dsh-plugin": "restart-button" }, children)
    }

    // #endregion floating affordance

    // #region sidebar affordance

    /**
     * The sidebar-foot power icon.
     *
     * Contributed to the shipped `sidebar.footer.action` slot, which the sidebar
     * shell renders in its foot beside the account launcher. The slot is the
     * sanctioned extension point: the account menu's own rows are a hard-coded
     * list with no slot of their own, and reading another plugin's DOM to place
     * a row there is explicitly forbidden by the plugin guidance.
     *
     * The Host route client is taken from this module's own closure, NOT from a
     * prop: the slot declares exactly one owner prop (`wide`), so a component
     * that expected an injected `api` would be called with `undefined` and crash
     * the whole sidebar. `wide` is the only thing read from props.
     *
     * @param props - `{ wide }`, whether the sidebar renders wide content.
     */
    function SidebarPower(props) {
      var wide = props.wide === true
      // Subscribed, not merely read: the sidebar icon must appear and disappear
      // as the switch is flipped, without a page reload.
      var config = useConfig()
      var menu = usePowerMenu(api)
      var feedback = usePressFeedback()
      var wrapRef = useRef(null)
      var btnRef = useRef(null)
      /**
       * The portalled panel's own node, so presses on it are not "outside".
       *
       * It lives here rather than beside the render because the dismiss hook above
       * consumes it, and the hook has to be called with the same list on every
       * render.
       */
      var panelRef = useRef(null)
      var rectState = useState(null)
      var rect = rectState[0]
      var setRect = rectState[1]

      /** Whether the pointer is over the collapsed rail, which reveals it. */
      var hoverState = useState(false)
      var hovered = hoverState[0]
      var setHovered = hoverState[1]

      var supported = useSupported(api)

      /**
       * A press anywhere outside closes the menu.
       *
       * TWO nodes count as inside, because the panel is portalled to the
       * body-level overlay: `wrapRef` is the trigger, `panelRef` is the panel
       * itself. Both are needed or the panel would close on its own presses.
       */
      useDismissOnOutsidePress(menu, [wrapRef, panelRef])

      /**
       * Measure the trigger whenever the menu opens.
       *
       * The panel is fixed-positioned, so it needs viewport coordinates rather
       * than an offset inside the sidebar: the sidebar column animates its width
       * and clips its children, and a panel laid out inside it would be cut off.
       */
      useEffect(
        function () {
          if (menu.phase === null) {
            setRect(null)
            return undefined
          }
          var measure = function () {
            var node = btnRef.current
            if (node === null) return
            var box = node.getBoundingClientRect()
            setRect({ left: box.left, top: box.top, width: box.width, height: box.height })
          }
          measure()
          window.addEventListener("resize", measure)
          window.addEventListener("scroll", measure, true)
          return function () {
            window.removeEventListener("resize", measure)
            window.removeEventListener("scroll", measure, true)
          }
        },
        [menu.phase],
      )

      // Resting state is the thin rail; the pointer or an open menu reveals the
      // full button. The menu keeps it revealed, so the panel never floats beside
      // a control that has just vanished back into a sliver.
      //
      // `revealArmed` drives the SAME `dshrb-reveal` animation the floating control
      // uses, rather than a second one written for this control — and, like it, only
      // while the arm is live: the arm is a hook, so it is derived here, above the
      // visibility guards, and not in the render below them.
      var rail = !hovered && menu.phase === null
      var revealed = !rail
      var revealArmed = useRevealArm(revealed, feedback.anim)

      // Hidden by its own switch, or by the capability probe.
      if (config.values.sidebar !== true) return null
      if (supported !== true) return null

      var v = viewport()
      var menuStyle = null
      if (rect !== null) {
        // Anchored by its BOTTOM edge, just above the trigger.
        //
        // The panel's height is not a constant — the menu phase lists two rows
        // and a hint, the confirm phase a title and a button row, and an error
        // line changes it again — so placing it with a fixed `top` required its
        // height up front. An estimate was wrong by a measured ~64px and put the
        // panel visibly away from its button; measuring it needed a second paint
        // and a layout effect. Anchoring the bottom edge removes height from the
        // calculation entirely: `bottom: <viewport height - trigger top + gap>`
        // is exact for every phase, in one paint, with no measuring.
        //
        // The one thing bottom-anchoring alone cannot handle is a trigger near
        // the TOP of a short window: the panel would extend past the top edge.
        // That is solved without reintroducing a height estimate — by bounding
        // the panel's `max-height` to the room actually available above the
        // trigger and letting it scroll internally if a phase needs more.
        var gap = PANEL_MARGIN
        var roomAbove = rect.top - gap - PANEL_MARGIN
        menuStyle = {
          left: clamp(rect.left + rect.width / 2 - MENU_W / 2, PANEL_MARGIN,
            Math.max(PANEL_MARGIN, v.w - MENU_W - PANEL_MARGIN)) + "px",
          bottom: Math.max(PANEL_MARGIN, v.h - rect.top + gap) + "px",
          width: MENU_W + "px",
          maxHeight: Math.max(120, roomAbove) + "px",
          overflowY: "auto",
        }
      }

      // `data-dshrb-inrow` arms the account-row placement in the stylesheet, and
      // it is emitted only for the WIDE sidebar: the collapsed icon rail is a
      // centred 36px column with no account row, and the rule's `order` would
      // silently reshuffle its stack. Driving this from the component's own
      // `wide` prop keeps the decision independent of anything another plugin
      // contributes to the foot.
      return h(
        "div",
        {
          className: "dshrb-sbwrap",
          ref: wrapRef,
          "data-dshrb-inrow": wide ? "" : null,
          // The POINTER reveal lives on this wrapper, not on the button, and that
          // placement is the fix for the reported flicker.
          //
          // The button scales during `dshrb-reveal`, and a transform moves the
          // element's hit box with it: for the first frames the button covers less
          // than the sliver the pointer is standing on, so the pointer falls
          // outside it, `pointerleave` fires, the control collapses, the sliver
          // reappears under the cursor and re-enters — a loop the user described as
          // "鼠标在收起细条的上下边位置的时候打开后会立刻关闭，随后又立刻打开，造成闪烁"
          // and reasonably read as the collapsed state being the taller one.
          //
          // The wrapper carries no transform, so its box is the laid-out box: 32px
          // tall in every state, and widening only from the sliver's 14px to the
          // button's 32px. It therefore always contains the sliver, and no frame of
          // the reveal can manufacture a pointer event. (It does NOT contain the
          // whole animation — the 26% frame renders at 33.9x33.3, slightly larger
          // than the button. That is fine and is not a hazard: those frames push the
          // button OUTWARD past the wrapper while the pointer is inside the button
          // itself, which is a descendant, so no leave can be fired in either
          // direction. The invariant only needs to hold for the sliver.)
          // The button stays a descendant of it, so moving between the two is not a
          // boundary crossing and fires nothing.
          //
          // Focus stays on the button below: a keyboard reveal has no pointer, so
          // it has none of this hazard.
          onPointerEnter: function () {
            setHovered(true)
          },
          onPointerLeave: function () {
            // No `menu.phase === null` guard here any more. It swallowed the leave
            // that happens while the panel is open, so `hovered` stayed true and
            // outlived the menu: closing it left the control permanently expanded,
            // while the reveal it was meant to protect is already held open by
            // `menu.phase !== null` for exactly as long as the panel is up.
            setHovered(false)
          },
        },
        h(
          "button",
          {
            ref: btnRef,
            type: "button",
            className: "dshrb-sb",
            "data-dsh-part": "restart-sidebar",
            "data-rail": rail ? "true" : "false",
            "data-anim": feedback.anim,
            "data-reveal": revealArmed ? "true" : null,
            title: TEXT.label,
            "aria-label": TEXT.label,
            "aria-haspopup": "menu",
            "aria-expanded": menu.phase !== null && menu.phase !== "busy",
            onPointerDown: function (event) {
              if (event.button !== 0) return
              feedback.onPress(event)
            },
            onPointerUp: function () {
              feedback.onRelease()
            },
            onFocus: function () {
              setHovered(true)
            },
            onBlur: function () {
              setHovered(false)
            },
            onClick: function () {
              if (menu.phase === null) menu.open()
              else menu.close()
            },
          },
          powerIcon(16),
          // The resting sliver shows the same mark as the floating strip, so a
          // collapsed control is identifiable in both places. It is a child of the
          // button itself (not of the wrapper), which is what lets the rail rule
          // hide the icon and this mark appears in its place.
          sliverMark(),
        ),
        menu.phase !== null && menu.phase !== "busy" && menuStyle !== null
          ? portalToHost(
              h(MenuPanel, { key: "menu", menu: menu, style: menuStyle, panelRef: panelRef }),
            )
          : null,
        // The busy notice and the juice droplets are `position: fixed`, so they are
        // portalled for the SAME reason the panel is: rendered here they would live
        // inside the sidebar column, which is `overflow: hidden` and — under the
        // reflow bundle's mobile rule — `transform: translateX(0)`, i.e. the
        // containing block for fixed descendants. The toast's `left: 50%` would then
        // resolve against the COLUMN's width, centring it on the sidebar and clipping
        // it, and the droplets would be confined to the column as well.
        portalToHost(h(BusyToast, { key: "busy", menu: menu })),
        portalToHost(juiceNodes(feedback.juice)),
      )
    }

    // #endregion sidebar affordance

    // #region configuration page

    /**
     * This package's configuration page inside the plugin manager.
     *
     * Contributed to `plugins.bundle.config`, keyed by the package name: the
     * manager renders it on this bundle's page. Values are read from and written
     * to this plugin's own Host route rather than to the manager's config form,
     * so the page needs no knowledge of the manager's internal form type and the
     * switches take effect immediately in both interfaces.
     *
     * The page draws NO heading of its own: the manager already renders the
     * package h3 title, the package name and the description immediately above
     * this contribution, and repeating them here is what made the page look
     * unlike every other plugin's.
     */
    function SettingsPanel() {
      var config = useConfig()
      var values = config.values

      var onToggle = function (key, next) {
        var patch = {}
        patch[key] = next
        configStore.save(patch)
      }

      /** One standard row: title + hint on the left, the switch on the right. */
      var row = function (key, label, detail, checked) {
        return h(
          "div",
          { className: "dshrb-cfgrow", key: key },
          h(
            "div",
            { className: "dshrb-cfgtxt" },
            h("div", { className: "dshrb-cfgtitle" }, label),
            h("div", { className: "dshrb-cfgdetail" }, detail),
          ),
          // The switch replicates the host primitive's markup: a button carrying
          // `role="switch"` and `aria-checked`, with the knob as a real child
          // element. The host's own control is built this way, and the guidance
          // names `role="switch"` with `aria-checked` as behaviour to preserve, so
          // screen readers and automation see the same thing they see elsewhere.
          h(
            "button",
            {
              type: "button",
              className: "dshrb-sw",
              role: "switch",
              "aria-checked": checked === true,
              "aria-label": label,
              disabled: !config.ready,
              onClick: function () {
                onToggle(key, !(checked === true))
              },
            },
            h("span", { className: "dshrb-swthumb" }),
          ),
        )
      }

      return h(
        "div",
        { className: "dshrb-cfg", "data-dsh-part": "restart-settings" },
        h("div", { className: "dshrb-cfghint" }, SETTINGS.hint),
        row("floating", SETTINGS.floating, SETTINGS.floatingDetail, values.floating),
        row("sidebar", SETTINGS.sidebar, SETTINGS.sidebarDetail, values.sidebar),
        config.failure === "" ? null : h("div", { className: "dshrb-cfgerr", role: "alert" }, config.failure),
      )
    }

    // #endregion configuration page

    // #region host routes

    /** Parse a JSON body, tolerating a non-JSON answer. */
    function readJson(response) {
      return response.json().catch(function () {
        return null
      })
    }

    /**
     * Call one of this plugin's own routes, same-origin and asking for JSON.
     *
     * Every call has to carry the same contract — `credentials: "same-origin"`, because
     * the desktop shell authenticates these routes with the Host cookie, and
     * `accept: application/json` — and each of the four used to restate it. One place
     * means one thing to get right: a call that dropped the cookie would be refused with
     * 401 by the Host's own fence and read as "the plugin is broken".
     *
     * `content-type` is declared only when a body is actually sent. A GET carrying a
     * content type for an empty body is not wrong, but it is not what the route expects
     * either, and the read routes deliberately send none.
     *
     * @param url - document-relative route path.
     * @param init - optional fetch init; `method` and `body` are the only fields read.
     */
    function sendJson(url, init) {
      var options = init === undefined ? {} : init
      var headers = { accept: "application/json" }
      if (options.body !== undefined) headers["content-type"] = "application/json"
      return fetch(url, {
        method: options.method === undefined ? "GET" : options.method,
        headers: headers,
        credentials: "same-origin",
        ...(options.body === undefined ? {} : { body: options.body }),
      })
    }

    /** The parsed body of a successful response, or null for anything else. */
    function bodyOrNull(response) {
      return response.ok ? readJson(response) : null
    }

    /**
     * The body of an accepted write, or a rejection carrying a displayable code.
     *
     * A Host answer that is not `ok` is a refusal, and the code it names is what the
     * menu shows. The Host's own `reason` is carried onto the thrown error when it
     * sent one: for `refused` and `spawn-failed` it is the only part a user can act
     * on (see `describeFailure`), and dropping it here is what made the UI print a
     * bare category name for a failure whose cause was known and stated.
     *
     * `fallbackCode` covers the answer that names none: the action route falls back
     * to the HTTP status, the configuration route to its own literal.
     *
     * @param response - the raw response.
     * @param fallbackCode - `(response) => string` used when no code is given.
     */
    function expectOk(response, fallbackCode) {
      return readJson(response).then(function (body) {
        if (response.ok && body !== null && body.ok === true) return body
        var code = body !== null && typeof body.code === "string" ? body.code : fallbackCode(response)
        var error = new Error(code)
        if (body !== null && typeof body.reason === "string" && body.reason !== "") {
          error.reason = body.reason
        }
        throw error
      })
    }

    /** Same-origin client for the three control routes. */
    var api = {
      /** Resolve to the status body, or null when the Host cannot answer. */
      status: function () {
        return sendJson(STATUS_URL).then(bodyOrNull, function () {
          return null
        })
      },
      /**
       * Ask the Host to restart or quit. Resolves with the Host answer, or
       * rejects with the Host's own error code so the menu can show it.
       */
      action: function (action) {
        return sendJson(ACTION_URL, {
          method: "POST",
          body: JSON.stringify({ action: action }),
        }).then(function (response) {
          return expectOk(response, function (raw) {
            return String(raw.status)
          })
        })
      },
      /** Read the two per-UI visibility switches. */
      config: function () {
        return sendJson(CONFIG_URL).then(bodyOrNull)
      },
      /** Write one or both switches; resolves with the stored values. */
      configWrite: function (patch) {
        return sendJson(CONFIG_URL, {
          method: "POST",
          body: JSON.stringify(patch),
        }).then(function (response) {
          // The Host's configuration route answers a bare `ok:false` for a write it
          // could not apply, with no code of its own, so this route names the code.
          return expectOk(response, function () {
            return "config-write-failed"
          })
        })
      },
    }

    // #endregion host routes

    // #region plugin

    /**
     * Required services. `slots` is needed for the sidebar contribution and the
     * plugin-manager configuration page; the floating control itself depends on
     * nothing but `document.body`, which is why it is mounted here rather than
     * through a slot.
     */
    var inject = ["slots"]

    /**
     * Mount both interfaces and the configuration page for the page lifetime.
     *
     * Stale roots left by an earlier bundle instance are swept first, so a client
     * hot reload leaves exactly one control behind.
     *
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ensureStyles()

      // The stale sweep is a single query, because the portal host is now a CHILD of
      // this container rather than a second body-level overlay of its own. Removing
      // the container takes its host with it, so the two can no longer come apart —
      // there is no separate host sweep to keep in step with this one.
      var stale = document.querySelectorAll("div[data-dsh-restart-root]")
      for (var index = 0; index < stale.length; index += 1) stale[index].remove()

      var container = document.createElement("div")
      container.setAttribute("data-dsh-restart-root", "")
      document.body.appendChild(container)

      // The portal host is a SIBLING of the React mount below, never its container:
      // handing React a node that already has children makes it clear them on mount,
      // which would delete the host. It is created eagerly here rather than lazily on
      // the first menu, so the only DOM write in a render path is a read.
      createMenuHost(container)

      // The React mount node is marked so it is identifiable among the container's
      // children: the portal host is its SIBLING, and a test or a hot-reload sweep
      // looking for "the node React renders into" must not have to guess.
      var mount = document.createElement("div")
      mount.setAttribute("data-dshrb-mount", "")
      container.appendChild(mount)
      var root = react_dom_client.createRoot(mount)
      root.render(h(FloatingPower, { api: api }))

      // The cross-window channel belongs to this bundle instance's lifetime, and
      // so does the DOM root: both are torn down together. The host goes with the
      // container, so it needs no separate teardown — and if it did, removing it by
      // identity here would be the wrong move anyway: after a hot reload this
      // instance's host is not the one on the page that matters.
      var detachChannel = configStore.attach()
      ctx.effect(
        function () {
          return function () {
            detachChannel()
            root.unmount()
            container.remove()
            menuHostNode = null
          }
        },
        "restart-button: floating ui lifetime",
      )

      // The settings must be known before the sidebar icon decides to render.
      configStore.load()

      ctx.slots.inject("sidebar.footer.action", function () {
        return ctx.slots.register(
          {
            name: "sidebar.footer.action",
            id: "dsh-restart-power",
            // No `locale` namespace: this plugin ships its own bilingual copy and
            // registers no dictionary with the locale service.
          },
          SidebarPower,
        )
      })

      ctx.slots.inject("plugins.bundle.config", function () {
        return ctx.slots.register(
          {
            name: "plugins.bundle.config",
            key: PACKAGE_NAME,
          },
          SettingsPanel,
        )
      })
    }

    // #endregion plugin

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
