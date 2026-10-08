/**
 * dsh-power-button — host half.
 *
 * Serves the two loopback-only control routes the floating button calls, and
 * performs the actual process work for the DSH desktop shell:
 *
 * - `GET  /api/dsh-restart/status` reports whether this Host runs as the child
 *   of a DSH desktop shell, i.e. whether restart/quit can work at all. The
 *   browser half renders nothing when it answers `supported: false`, so a
 *   terminal `dsh web` session never shows a button that cannot act.
 * - `POST /api/dsh-restart/action` accepts `{ action: "restart" | "quit" }`,
 *   starts the helper, and answers once the helper's bootstrap phase has
 *   reported success. The helper is what kills the shell and (for a restart)
 *   launches it again.
 *
 * Why a helper process instead of doing the work here: this Host process is a
 * child of the Electron main process (spawned over IPC at
 * `dsh-desktop-host/lib/index.js`). Killing the shell therefore kills this
 * process too, so the kill must be issued by something outside the shell's
 * process tree that also survives long enough to relaunch it. This module
 * starts that helper and the helper re-creates its real work through WMI, whose
 * children are parented to `WmiPrvSE.exe` and are therefore unreachable by
 * `taskkill /T`; see `lib/restart-helper.ps1` for the exact sequence and for
 * why a detached `spawn` alone does not escape the tree.
 *
 * The shell owns `app.relaunch()`, but no IPC channel exposes it to plugins
 * (`preload-app.cjs` publishes only browser/deviceInfo/keyboard/shortcuts/
 * updates), so a plugin can only reproduce a relaunch from the outside. The
 * relaunch reuses the shell's own recorded command line, so a development
 * launch with arguments restarts the same way it was started.
 *
 * @module dsh-power-button
 */

import { spawn } from "node:child_process"
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/** Cordis plugin name; matches the `name` of the `insert` row in cordis.patch.yml
 * (that row's `id` is `ui-restart-button`, which is a different field). */
const name = "dsh-power-button"

/** Services required by this plugin. */
const inject = ["webServer", "connection", "agents"]

/** Route paths, exact matches under the Host's origin. */
const ROUTE_STATUS = "/api/dsh-restart/status"
const ROUTE_ACTION = "/api/dsh-restart/action"
const ROUTE_CONFIG = "/api/dsh-restart/config"

/**
 * Per-interface visibility switches, with defaults.
 *
 * This plugin ships two independent interfaces — the floating draggable button
 * and the sidebar-foot power icon — and the plugin manager's own switch governs
 * the whole package rather than either interface. These two flags are therefore
 * what makes the interfaces separately hideable, and they are stored by this
 * Host so the choice survives a restart. Both default to on, so a first run
 * before any settings file exists shows both.
 */
const DEFAULT_UI_CONFIG = { floating: true, sidebar: true }

/** Default JSON response headers. */
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
}

/**
 * How long the bootstrap may take before it is treated as failed.
 *
 * WMI creation is fast (the log shows bootstrap and worker start in the same
 * second); the latency a user sees is PowerShell's own cold start, which is
 * seconds at worst. This bound exists so a HUNG helper cannot leave the request
 * unanswered and the one-shot gate claimed forever.
 */
const BOOTSTRAP_TIMEOUT_MS = 30000

/**
 * Exit code the helper uses for a refusal it made before touching anything.
 *
 * Distinct from 1 (a failure mid-flight) on purpose: the caller may release the
 * one-shot gate for this code and must NOT for any other non-zero code, because
 * a mid-flight failure may still have killed the tree.
 */
const EXIT_REFUSED = 3

/** Largest accepted action body; the only valid body is a few dozen bytes. */
const MAX_BODY_BYTES = 4096

/**
 * Business failure code for a second action while one is already running.
 *
 * Restart and quit kill the process tree, so a second request started while the
 * first is still being set up would put two workers on the same shell: the
 * second would find a half-dead pid, or both would race the relaunch. The
 * button disables itself while busy, but a second tab, a double submit or a
 * retry can still arrive here, so the guard belongs on the Host.
 */
const ALREADY_RUNNING = "already-running"

/**
 * Tunables accepted from the loader entry's `config` block, with defaults.
 *
 * These are the two timings that depend on the machine rather than on the code:
 * how long to let the HTTP response reach the browser before the shell dies
 * with it, and how long to wait for the shell to actually disappear. A slow or
 * heavily loaded machine may need larger values than these.
 */
const DEFAULT_CONFIG = { settleMs: 500, waitForExitSeconds: 20 }

/** Clamp one integer option to `[lo, hi]`, falling back on anything invalid. */
function intOption(value, lo, hi, fallback) {
  return Number.isInteger(value) && value >= lo && value <= hi ? value : fallback
}

/**
 * Resolve the effective config from a loader entry's `config` block.
 *
 * Read directly rather than through a schema service: the loader hands the
 * block over as plain data, and every option has a safe default, so an absent
 * or malformed block must not be able to stop the plugin from loading.
 *
 * @param raw - the loader entry's `config` value, normally undefined.
 * @returns the effective `{ settleMs, waitForExitSeconds }`.
 */
function resolveConfig(raw) {
  if (raw === null || typeof raw !== "object") return { ...DEFAULT_CONFIG }
  return {
    settleMs: intOption(raw.settleMs, 0, 30000, DEFAULT_CONFIG.settleMs),
    waitForExitSeconds: intOption(raw.waitForExitSeconds, 1, 300, DEFAULT_CONFIG.waitForExitSeconds),
  }
}

/** Absolute path of the PowerShell helper shipped beside this module. */
const HELPER_PATH = fileURLToPath(new URL("./restart-helper.ps1", import.meta.url))

/** Write one JSON response. */
function writeJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS)
  res.end(JSON.stringify(body))
}

/** IPv4 127/8 predicate (four decimal octets, first == 127). */
function isIPv4Loopback(v4) {
  const parts = v4.split(".")
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

/** Whether a socket remote address names the loopback range (127/8, ::1, IPv4-mapped). */
function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === "::1") return true
  if (normalized.startsWith("::ffff:")) return isIPv4Loopback(normalized.slice(7))
  return isIPv4Loopback(normalized)
}

/** Whether a normalized URL hostname names the loopback authority (localhost, [::1], 127/8). */
function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true
  return isIPv4Loopback(hostname)
}

/**
 * Request-level trust fence: a loopback socket address AND a loopback Host
 * header, plus browser same-origin markers. The socket address is
 * authoritative; X-Forwarded-For is never trusted.
 *
 * The desktop shell reaches the Host through its own `dsh-app://app` protocol
 * handler, which strips `origin` and `sec-fetch-site` before forwarding and
 * authenticates with the Host cookie, so both paths below accept it.
 */
function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== "string") return false
  let hostUrl
  try {
    hostUrl = new URL("http://" + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers["sec-fetch-site"] === "cross-site") return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Read a bounded JSON request body; undefined on malformed input. */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    return undefined
  }
}

/**
 * The desktop shell owning this Host, or undefined when this is not a desktop
 * launch.
 *
 * Three facts together identify the desktop topology, and each is required:
 * the process runs under the Electron binary in Node mode
 * (`ELECTRON_RUN_AS_NODE`), its entry is the desktop Host
 * (`dsh-desktop-host/lib/index.js`), and its parent is the Electron main
 * process. A terminal `dsh web` fails the first two; the packaged `dsh.cmd`
 * launcher also runs the Electron binary in Node mode but fails the second.
 *
 * `logDir` is resolved here and passed to the helper explicitly: a
 * WMI-created worker inherits neither this process's environment nor its
 * console, so it cannot work out `%DSH_HOME%` for itself.
 *
 * @returns `{ mainPid, hostPid, exePath, logDir }` or undefined.
 */
function desktopShell() {
  if (process.platform !== "win32") return undefined
  if (typeof process.versions.electron !== "string") return undefined
  const entry = process.argv[1] ?? ""
  if (!/dsh-desktop-host[\\/]lib[\\/]index\.js$/i.test(entry)) return undefined
  const mainPid = process.ppid
  if (!Number.isSafeInteger(mainPid) || mainPid <= 0) return undefined
  return { mainPid, hostPid: process.pid, exePath: process.execPath, logDir: logDirectory() }
}

/**
 * Directory the helper writes its log to: `$DSH_HOME/logs`, else the temp dir.
 *
 * `DSH_HOME` is normally absent from the desktop Host's environment even though
 * the profile it was started from lives under `$DSH_HOME`. Relying on it alone
 * sent the log to `%TEMP%` on a real install, which is not where the README says
 * to look, so the profile path is used as a second source: the Host always
 * receives its profile directory as an argument, and that profile sits directly
 * under `$DSH_HOME\profiles`.
 *
 * @returns the absolute log directory, or `.` when nothing can be resolved.
 */
function logDirectory() {
  const home = process.env.DSH_HOME
  if (typeof home === "string" && home.trim() !== "") return `${home}\\logs`
  const derived = homeFromProfileArgument()
  if (derived !== undefined) return `${derived}\\logs`
  const temp = process.env.TEMP ?? process.env.TMP
  return typeof temp === "string" && temp !== "" ? temp : "."
}

/**
 * Recover `$DSH_HOME` from the Host's own profile argument.
 *
 * The profile directory is `<DSH_HOME>\profiles\<name>`, so walking two levels up
 * from it yields `$DSH_HOME` without guessing a default location.
 *
 * @returns the `$DSH_HOME` path, or undefined when it cannot be derived.
 */
function homeFromProfileArgument() {
  const profileDir = profileDirectory()
  if (profileDir === undefined) return undefined
  const cut = profileDir.lastIndexOf("\\")
  if (cut < 0) return undefined
  const home = profileDir.slice(0, cut).replace(/[\\/]profiles$/i, "")
  return home === "" || home === profileDir ? undefined : home
}

/** Windows PowerShell 5.1, present on every supported Windows release. */
function powershellPath() {
  const root = process.env.SystemRoot
  if (typeof root === "string" && root !== "") {
    return `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  }
  return "powershell.exe"
}

/**
 * Path of the helper's refusal marker, beside its log.
 *
 * @param logDir - the directory the helper logs to.
 * @returns the absolute marker path.
 */
function refusalMarkerPath(logDir) {
  return `${logDir}\\restart-button.refused`
}

/**
 * Whether the last launch recorded a refusal, and why.
 *
 * The marker is written only by a helper that stopped BEFORE touching any
 * process, and the launch path deletes it first, so its presence means "the most
 * recent attempt killed nothing and a retry is safe". This is what makes a
 * WORKER-phase refusal observable: the Host can only see the bootstrap's exit
 * code, and the identity guards run after the bootstrap has already exited 0.
 *
 * @param logDir - the directory the helper logs to.
 * @returns the recorded reason, or undefined when there was no refusal.
 */
function readRefusal(logDir) {
  try {
    const reason = readFileSync(refusalMarkerPath(logDir), "utf8").trim()
    return reason === "" ? "the helper refused the action" : reason
  } catch {
    return undefined
  }
}

/**
 * The launching environment's `DSH_*` variables, as a base64 JSON blob.
 *
 * The worker is created through WMI, which does not inherit this process's
 * environment, and it relaunches with `Start-Process`, which inherits the
 * WORKER's environment. Anything that existed only in the environment DSH was
 * started with is therefore lost across a restart.
 *
 * That matters: `DSH_HOME` is often set by whatever launched DSH and is not
 * written to the registry (measured on this machine: User and Machine both
 * empty, while the running process has it). Losing it silently moves the new
 * instance to a different profile root, which the user experiences as "my
 * sessions and settings are gone".
 *
 * Only `DSH_*` names are captured, and only name/value pairs: this is a
 * launcher-environment handoff, not a dump of the environment, and no other
 * variable is either needed or forwarded.
 *
 * @returns base64 of the JSON object, or an empty string when there is nothing
 *   to carry.
 */
function environmentBlob() {
  const captured = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("DSH_")) continue
    if (typeof value !== "string" || value === "") continue
    captured[key] = value
  }
  if (Object.keys(captured).length === 0) return ""
  return Buffer.from(JSON.stringify(captured), "utf8").toString("base64")
}

/**
 * Run the bootstrap that starts the restart/quit worker and wait for it.
 *
 * The helper has two phases (`lib/restart-helper.ps1`): this call runs the
 * BOOTSTRAP phase, which re-creates itself as a WORKER through
 * `Win32_Process.Create` and exits. Only the worker performs the kill, and
 * because a WMI-created process reports `WmiPrvSE.exe` as its parent it sits
 * outside the application's process tree, where `taskkill /T` cannot reach it.
 *
 * A detached `child_process.spawn` is deliberately not relied on here. It was
 * measured to work, but it does NOT escape: `detached` only starts a new
 * process group, the child still reports this process as its parent, and a
 * `taskkill /T` on the tree was measured to terminate it as well. Since the
 * helper's whole job is to kill the tree that contains this process, a
 * detached child would kill itself. `Win32_Process.Create` was measured to
 * parent the child to `WmiPrvSE.exe` instead, survive its creator's exit, and
 * finish its work.
 *
 * The bootstrap is awaited because its exit is what reports whether the WMI
 * call succeeded: without that the browser would be told "restarting" while
 * nothing had been started. It returns within a few hundred milliseconds.
 *
 * @param shell - resolved desktop shell facts.
 * @param action - `restart` or `quit`.
 * @param config - effective timings from the loader entry.
 * @returns `{ ok: true }` or `{ ok: false, error }`.
 */
function launchWorker(shell, action, config) {
  const args = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-File",
    HELPER_PATH,
    "-MainPid",
    String(shell.mainPid),
    "-HostPid",
    String(shell.hostPid),
    "-Mode",
    action,
    "-ExePath",
    shell.exePath,
    "-LogDir",
    shell.logDir,
    "-SettleMs",
    String(config.settleMs),
    "-WaitSeconds",
    String(config.waitForExitSeconds),
    "-EnvB64",
    environmentBlob(),
  ]
  // Clear the refusal marker first, so what is read afterwards can only have
  // been written by THIS launch.
  const marker = refusalMarkerPath(shell.logDir)
  try {
    unlinkSync(marker)
  } catch {
    /* absent is the normal case */
  }
  return new Promise((resolve) => {
    let child
    let settled = false
    let watchdog = null
    const finish = (outcome) => {
      if (settled) return
      settled = true
      if (watchdog !== null) clearTimeout(watchdog)
      resolve(outcome)
    }
    try {
      // Not detached: the bootstrap must be waited on, and it exits by itself
      // once the WMI worker exists. Its stdio is piped so a failure is logged.
      child = spawn(powershellPath(), args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      })
    } catch (error) {
      finish({ ok: false, retryable: true, error: error instanceof Error ? error.message : String(error) })
      return
    }
    // Bounded: a hung PowerShell would otherwise never emit `close`, leaving the
    // request unanswered and -- because the gate is claimed before this call --
    // the UI permanently unable to try again. Nothing has been created yet, so a
    // retry is safe.
    watchdog = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish({ ok: false, retryable: true, error: `bootstrap timeout after ${BOOTSTRAP_TIMEOUT_MS}ms` })
    }, BOOTSTRAP_TIMEOUT_MS)
    // A timeout is a normal outcome, not a reason to keep the process alive.
    if (typeof watchdog.unref === "function") watchdog.unref()
    let stderr = ""
    child.stderr?.setEncoding("utf8")
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2048)
    })
    child.stdout?.resume()
    child.once("error", (error) => {
      finish({ ok: false, retryable: true, error: error.message })
    })
    // The helper uses a dedicated exit code for the refusals it makes BEFORE it
    // touches anything (see `restart-helper.ps1`). Only that code, a spawn
    // failure and the timeout above mark the failure as safely retryable: any
    // other non-zero exit means the helper may already have killed the tree, and
    // clearing the gate there could start a second restart over the first.
    child.once("close", (code) => {
      if (code === 0) finish({ ok: true })
      else {
        finish({
          ok: false,
          retryable: code === EXIT_REFUSED,
          error: `bootstrap exit ${String(code)}${stderr.trim() === "" ? "" : `: ${stderr.trim()}`}`,
        })
      }
    })
  })
}

/**
 * One-shot gate for the destructive actions.
 *
 * Once an action is accepted the process is going away, so the gate is never
 * released on success: it only clears if the worker could not be started at
 * all, which is the one case where a retry is meaningful.
 */
function createActionGate() {
  return { action: null, failed: false }
}

/** Accept only a real boolean, so a malformed body cannot flip a switch. */
function boolOption(value, fallback) {
  return typeof value === "boolean" ? value : fallback
}

/**
 * The profile directory this Host was started with, from its own arguments.
 *
 * The desktop Host is spawned as
 * `<entry> <dshRoot> <profileDir> <runtime> <pnpm> <bin>`, so the profile is the
 * FIRST argument shaped like `<something>\profiles\<name>`. It is located by
 * shape rather than by a fixed index on purpose: the launcher has inserted
 * arguments before (`--inspect` is added in development), and an index that is
 * off by one points at `dshRoot` — inside `app.asar`, which is a FILE, so every
 * write silently fails and the log lands in `%TEMP%`.
 *
 * @returns the absolute profile directory, or undefined when absent.
 */
function profileDirectory() {
  for (const argument of process.argv.slice(1)) {
    if (typeof argument !== "string") continue
    const normalized = argument.replace(/[\\/]+$/, "")
    if (/[\\/]profiles[\\/][^\\/]+$/i.test(normalized)) return normalized
  }
  return undefined
}

/**
 * The settings file holding the two interface switches.
 *
 * Kept beside the plugin's other host-side state under the profile directory the
 * Host was started with, so it is per-profile and removed with the profile.
 *
 * @returns the absolute path, or undefined when no profile directory is known.
 */
function configFilePath() {
  const profileDir = profileDirectory()
  if (profileDir === undefined) return undefined
  return `${profileDir}\\dsh-power-button.json`
}

/**
 * Load the interface switches, falling back to the defaults.
 *
 * A missing, unreadable or malformed file yields the defaults rather than an
 * error: the switches are a convenience, and a broken file must never hide both
 * interfaces with no way back.
 *
 * @returns the effective `{ floating, sidebar }`.
 */
function loadUiConfig() {
  const path = configFilePath()
  if (path === undefined) return { ...DEFAULT_UI_CONFIG }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    if (parsed === null || typeof parsed !== "object") return { ...DEFAULT_UI_CONFIG }
    return {
      floating: boolOption(parsed.floating, DEFAULT_UI_CONFIG.floating),
      sidebar: boolOption(parsed.sidebar, DEFAULT_UI_CONFIG.sidebar),
    }
  } catch {
    return { ...DEFAULT_UI_CONFIG }
  }
}

/** Persist the interface switches; returns the values now in force. */
function saveUiConfig(next) {
  const path = configFilePath()
  if (path === undefined) return next
  try {
    const dir = path.slice(0, path.lastIndexOf("\\"))
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8")
  } catch {
    /* read-only profile: the switches apply to this session but do not persist */
  }
  return next
}

/**
 * Whether any agent is working right now, subagents included.
 *
 * `ctx.agents` is the process-wide agent registry, and a subagent is created
 * through the SAME registry as its parent (`ctx.agents.create({ parentAgent })`),
 * so `list()` returns both and no recursion is needed to include them. `status`
 * is the authoritative bit and already normalises the maintenance phase to
 * `idle`; a turn that is parked waiting for an approval or an answer still
 * reports `running`, which is exactly the case that must not be interrupted
 * silently.
 *
 * The read is deliberately defensive: the service is optional in the sense that
 * a Host build without it must still be able to restart, and an unreadable
 * registry must not be reported as "nothing is running". It returns `undefined`
 * for "cannot tell", which the browser treats as "ask the user", because
 * restarting during unseen work is the expensive mistake.
 *
 * @param ctx - the host plugin context.
 * @returns true/false, or undefined when the registry cannot be read.
 */
function agentsWorking(ctx) {
  try {
    const list = ctx.agents?.list?.()
    if (!Array.isArray(list)) return undefined
    return list.some((agent) => agent?.status === "running")
  } catch {
    return undefined
  }
}

/**
 * Build the restart-button route family.
 *
 * @param ctx - the host plugin context (its `connection` is read per request).
 * @param shell - lazily resolved desktop shell facts.
 * @param gate - shared one-shot action gate.
 * @param config - effective timings from the loader entry.
 * @param uiConfig - live interface switches; read on GET, mutated on POST.
 * @returns the exact routes to register on `webServer`.
 */
function makeRoutes(ctx, shell, gate, config, uiConfig) {
  /**
   * The Host's own trust fence, applied before anything else.
   *
   * An EXACT route is dispatched before the `/api` PREFIX table, so these routes
   * would otherwise SHADOW the authentication the Host puts on every other
   * `/api` endpoint — measured: without a cookie `/api/session/list` answers 401
   * while this plugin's routes answered 200. `requestRejection` is the Host's own
   * authority (Host/Origin fence plus the browser auth cookie, and on the desktop
   * build whatever the shell injects), so reusing it keeps this plugin inside the
   * same permission model instead of beside it.
   *
   * The service is read from the LIVE context on every request rather than
   * captured once, matching the Host's own `connectionOf(ctx)` helper: a
   * reference taken at mount time could outlive a service restart.
   *
   * @returns true when the request was rejected and a response was sent.
   */
  const rejected = (req, res) => {
    const status = ctx.connection?.requestRejection?.(req)
    if (status === undefined || status === null) return false
    writeJson(res, status, {
      ok: false,
      code: status === 401 ? "unauthenticated" : "forbidden",
    })
    return true
  }

  /**
   * The gate every route passes before it does anything.
   *
   * All three routes need the same four steps in the same order — method
   * discipline, the Host's own trust fence, the loopback fence, and only then the
   * work — and each was written out separately. Three copies of an authorization
   * sequence is three chances for one of them to be edited into a hole, and the
   * order is load-bearing: the fence must come before the loopback check, or a
   * request the Host would have refused is answered by the loopback branch instead.
   *
   * @param req - the incoming request.
   * @param res - the response to answer on.
   * @param methods - exact methods this route accepts.
   * @returns true when the request was already answered and the handler must stop.
   */
  const fenced = (req, res, methods) => {
    if (!methods.includes(req.method)) {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" })
      res.end("method not allowed")
      return true
    }
    if (rejected(req, res)) return true
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { ok: false, code: "forbidden" })
      return true
    }
    return false
  }

  const handleStatus = (req, res) => {
    if (fenced(req, res, ["GET"])) return
    const facts = shell()
    writeJson(res, 200, {
      ok: true,
      supported: facts !== undefined,
      platform: process.platform,
      ...(gate.action !== null ? { busy: gate.action } : {}),
      ...(facts === undefined ? { reason: "not-desktop" } : {}),
      // A refusal the worker recorded but the Host could not observe at launch time.
      //
      // DIAGNOSTIC, not a UI channel: the browser half deliberately does not read it,
      // because the user learns the reason where it matters — on the retry, whose 500
      // carries the same text as `reason` and is shown in the menu. Emitting it here
      // still earns its place: it makes the stranded state visible to an operator (or
      // a future UI) BEFORE a click, which is the difference between "the button does
      // nothing" and "the button is blocked, here is why".
      ...(facts === undefined ? {} : { refused: readRefusal(facts.logDir) }),
      // Whether the extra confirmation is warranted, i.e. whether any agent
      // (subagents included) is working. This is a REPORT, not a policy: the menu
      // decides what to do with it, and the Host deliberately does not refuse the
      // action on it — a user may still mean to restart while work is running, and
      // the confirmation is what gives them the chance to say so.
      working: agentsWorking(ctx),
    })
  }

  /**
   * Read or write the two interface switches.
   *
   * Deliberately independent of the desktop check: the switches describe which
   * interfaces to draw, and they must stay readable and writable even where the
   * power actions cannot run, otherwise the configuration page would be dead on
   * a terminal launch.
   */
  const handleConfig = async (req, res) => {
    if (fenced(req, res, ["GET", "POST"])) return
    if (req.method === "GET") {
      writeJson(res, 200, { ok: true, ...uiConfig.value })
      return
    }
    const body = await readJsonBody(req)
    if (body === undefined || body === null || typeof body !== "object") {
      writeJson(res, 400, { ok: false, code: "bad-config" })
      return
    }
    // A patch: only the keys actually present are changed.
    const next = {
      floating: boolOption(body.floating, uiConfig.value.floating),
      sidebar: boolOption(body.sidebar, uiConfig.value.sidebar),
    }
    uiConfig.value = saveUiConfig(next)
    writeJson(res, 200, { ok: true, ...uiConfig.value })
  }

  const handleAction = async (req, res) => {
    if (fenced(req, res, ["POST"])) return
    const facts = shell()
    if (facts === undefined) {
      writeJson(res, 409, { ok: false, code: "unsupported", reason: "not-desktop" })
      return
    }
    const body = await readJsonBody(req)
    const action = body?.action
    if (action !== "restart" && action !== "quit") {
      writeJson(res, 400, { ok: false, code: "bad-action" })
      return
    }
    // Claim the gate before doing any work, so two near-simultaneous requests
    // cannot both get past this point: Node runs this handler to its first
    // await above, and the check-then-set below has no await between them.
    if (gate.action !== null && !gate.failed) {
      // Self-healing for a WORKER-phase refusal.
      //
      // The identity and relaunch-target guards run in the worker, after the
      // bootstrap has already exited 0 -- so the Host cannot see them when it
      // decides whether to release the gate. The worker records such a refusal
      // in a marker file instead, and it is read HERE, when the user tries again:
      // by then the worker has long since finished, so the answer is stable.
      //
      // This ordering is deliberate. Checking at launch time would mean waiting
      // for the worker, and the whole point of the bootstrap handshake is that
      // the HTTP response returns immediately -- the page must survive long
      // enough to receive it before the shell dies.
      const refusal = readRefusal(facts.logDir)
      if (refusal !== undefined) {
        gate.action = null
        gate.failed = true
        writeJson(res, 500, { ok: false, code: "refused", reason: refusal })
        return
      }
      writeJson(res, 409, { ok: false, code: ALREADY_RUNNING, reason: gate.action })
      return
    }
    gate.action = action
    gate.failed = false
    const launched = await launchWorker(facts, action, config)
    if (!launched.ok) {
      // Release the gate only when a retry is provably safe. `retryable` is set
      // for a spawn failure, a bootstrap timeout and the helper's dedicated
      // refusal code -- all of which happen before anything is killed. A failure
      // AFTER the kill keeps the gate claimed, because the process is already
      // going away and a second attempt would race the first.
      if (launched.retryable) {
        gate.action = null
        gate.failed = true
      }
      writeJson(res, 500, { ok: false, code: "spawn-failed", reason: launched.error })
      return
    }
    writeJson(res, 200, { ok: true, action })
  }

  return [
    { kind: "exact", path: ROUTE_STATUS, handler: handleStatus },
    { kind: "exact", path: ROUTE_ACTION, handler: handleAction },
    { kind: "exact", path: ROUTE_CONFIG, handler: handleConfig },
  ]
}

/**
 * Mount the restart-button control routes.
 *
 * @param ctx - host plugin context carrying the web server and connection.
 * @param rawConfig - the loader entry's optional `config` block.
 */
function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const gate = createActionGate()
  const uiConfig = { value: loadUiConfig() }
  const routes = makeRoutes(ctx, desktopShell, gate, config, uiConfig)
  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, "restart-button: control routes")
}

export { apply, inject, name }
