# dsh-power-button

![npm version](https://img.shields.io/npm/v/dsh-power-button)
![platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6)
![language: JavaScript](https://img.shields.io/badge/language-JavaScript-F7DF1E)
![helper: PowerShell](https://img.shields.io/badge/helper-PowerShell-5391FE)
![dependencies: none](https://img.shields.io/badge/dependencies-none-brightgreen)
![license: MIT](https://img.shields.io/badge/license-MIT-blue)

**English** ・ [中文](README.md)

Two power affordances for the **DSH Desktop** GUI (DeepSeek Harness), each switchable on
its own:

- **Floating button** — draggable; snapping to the left or right screen edge collapses it
  into a thin strip, and hovering the strip expands it again. Clicking opens a
  "Restart DSH / Quit DSH" menu.
- **Sidebar power icon** — sits in the sidebar's account row, to the left of the avatar,
  shaped like the official icon buttons beside it, with the same menu.

```
drag → snaps to an edge and collapses → hover to expand → click
     → (a second confirmation only when work is running) → restart or quit
```

DSH Desktop ships no in-window restart entry: the restart item in the tray menu appears
only in development builds, so on a release build the only way is to quit and reopen from
the Start menu. This plugin fills that gap.

- **Windows only**: relies on `taskkill`, WMI and the system's Windows PowerShell 5.1.
- **Zero dependencies**: plain JS, imports no Harness client package.
- **Reads no other plugin's DOM or styles**: both seats are official slots, and the
  sidebar icon's position does not depend on any other package (with
  `@linxin666/dsh-web-all` installed it lands in the same place).

---

## Preamble

This plugin was built by **DeepSeek Harness Desktop + DeepSeek v4.1 flash**: the code and
both READMEs were written by the model, and the human only took part in debugging and
review. It is a piece of **vibe code** — every counter-intuitive decision is backed by
evidence and measurements in `docs/DESIGN.md`, but treat it as "a project raised by
somebody else's AI": read the Known limits first, and open an issue when something breaks.

---

## Install

Installing rewrites the profile's `package.json` and `pnpm-lock.yaml`, so back it up first:

```powershell
Copy-Item "$env:DSH_HOME\profiles\desktop\package.json" `
  "$env:DSH_HOME\profiles\desktop\package.json.bak" -Force
```

### Option 1: from npm (recommended)

```powershell
& 'D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' `
  plugin --profile desktop add dsh-power-button
```

This installs the released registry version (currently `0.1.0`). **It is the only install
method the plugin manager's update check understands** — that check compares versions only
for packages installed straight from the npm registry, and skips `github:` specs and local
paths.

### Option 2: a local directory

```powershell
git clone https://github.com/WhichWitchWin/dsh-power-button.git
& 'D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' `
  plugin --profile desktop add 'D:\path\to\dsh-power-button'
```

### Option 3: straight from GitHub

```powershell
& 'D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' `
  plugin --profile desktop add 'github:WhichWitchWin/dsh-power-button#main'
```

(`#main` is a git committish — any branch, tag or commit works; drop the whole `#…` part to
take the default branch.)

Every method writes the dependency into the profile's `package.json` and adds this package
to `dsh.profile.bundles` automatically — its `dsh.bundle.patch` declaration is what
activates it. **Restart DSH once afterwards** (quit from the tray, then reopen) and both
interfaces appear. There is no build step: `lib/` is the finished loadable artifact, and the
package ships no `src/`, no `node_modules/` and no intermediate build output.

> Adjust the CLI path to your own install, and **use this desktop-bundled entry**: it is the
> one that sets `manageDesktopProfile` for profile `desktop`. An arbitrary `dsh` from `PATH`
> refuses with `profile "desktop" is managed exclusively by the Electron application`. If you
> install into a different profile, change `--profile` to its name.

### Uninstall

```powershell
& 'D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' `
  plugin --profile desktop remove dsh-power-button
```

---

## Usage

| Action | Result |
| --- | --- |
| Drag the floating button | Moves it; releasing near the left or right edge snaps and collapses it |
| Hover the thin strip | Expands into the full button (collapses again on leaving) |
| Click the button | Opens the power menu |
| Click empty space | Closes the menu and the control returns to its strip (it does **not** stay expanded) |
| `Esc` | Closes the menu |
| `Enter` / `Space` | Same as clicking the button |

- **The top and bottom edges are deliberately not snap targets**: they carry the window
  chrome and the composer, and a strip there would sit on top of both.
- The floating position is persisted in browser `localStorage`.
- **The second confirmation appears only when work is actually running.** It is asked when
  the Host reports a running agent (subagents included) — exactly the case where a click
  destroys work the user cannot get back. An idle DSH acts at once, so the common path
  carries no extra friction. When the Host cannot answer, the fail-safe answer is to ask.

### It feels like a little jelly 🍮

Both buttons can be squished:

- **Press**: squashed sideways and stretched a little vertically (`scale(.9, 1.1)`, 0.16s),
  which also squeezes out a few 7px droplets — they are flung along the direction you
  pressed and shrink away as they fly.
- **Release**: it springs back like jelly, overshooting +12% sideways, dipping to −6% and
  then +4%, with the vertical axis mirroring it the other way, settling after a couple of
  wobbles (0.46s floating, 0.52s sidebar).
- **Coming out of the sliver**: it does not pop into existence — it slides out from half
  width (`scale(.5,1)`, transparent) and bounces gently into place (0.44s).

So it is not merely usable: the press has some give, the release springs, and even sliding
back out of the edge stays soft. (The timings and curves were tuned against measurements —
read that part of `docs/DESIGN.md` before touching them; the numbers there bite each other.)

### Switching the two interfaces separately

This plugin's own configuration page in the plugin manager carries two switches: **floating
power button** and **sidebar power icon**. The plugin card's own switch enables the whole
package; these two control the individual interfaces, and both take effect immediately with
no reload.

---

## Configuration

The interface switches live in `dsh-power-button.json` under the profile directory,
written by the configuration page:

```json
{ "floating": true, "sidebar": true }
```

The Host half also accepts an optional `config` block with two machine-dependent **ceilings**
(the defaults suit an ordinary machine):

| Key | Default | Range | Meaning |
| --- | --- | --- | --- |
| `settleMs` | `500` | 0–30000 | Time allowed for the HTTP response to reach the browser before the shell dies with it |
| `waitForExitSeconds` | `20` | 1–300 | Upper bound on the wait for the old shell to actually disappear |

Both are ceilings, not fixed waits: the relaunch continues as soon as the port is released.
If the log shows `WARNING: proceeding after ...s`, raise them. Add `config` to the Host row
in the profile's bundle patch:

```yaml
- insert:
    - id: ui-restart-button
      name: 'dsh-power-button'
      config:
        settleMs: 800
        waitForExitSeconds: 30
```

---

## How it works

Electron's main process owns the desktop restart (`app.relaunch()` + `app.quit()`), but no
channel exposes it to plugins, so a plugin cannot *request* a restart — it can only reproduce
one from the outside. That reproduction has a chicken-and-egg constraint: **the DSH Host
process is a child of the Electron main process**, so killing the shell kills the Host too,
and whatever issues the kill must not live inside the Host process. The work therefore goes
to a PowerShell helper that **escapes the process tree**:

```
click "Restart DSH" → confirm
      ↓
Host half POSTs /api/dsh-restart/action { action: "restart" }
      ↓
Host half waits synchronously for lib/restart-helper.ps1's BOOTSTRAP phase
      ↓
bootstrap re-creates itself as the WORKER through Win32_Process.Create (WMI), then exits
      ↓
worker (parented to WmiPrvSE, outside the app's process tree, unreachable by taskkill):
  1. records the start time and the settleMs deadline
  2. reads the shell's own command line while it is still alive  ← app.relaunch()'s semantics
  3. asks which port the Host is listening on, and the ADDRESS it is bound to (IPv4 and IPv6)
  4. kills the old process tree and waits for it to disappear
  5. waits for the port to be released (decided by BINDING that address)
  6. relaunches with the original arguments (handing over the DSH_* environment)
  7. polls for the new instance's window and raises it, so it cannot stay hidden
     behind another application
```

A `detached: true` `spawn` is not enough: the child still reports this process as its parent,
and `taskkill /T` kills it too — and this helper's entire job is to kill the tree that
contains it. Only a **WMI-created child** both escapes the tree and outlives its creator.

"Quit" still goes through `taskkill`: once the Host process exits, this shell treats its exit
code as a fatal error whatever the code is, so there is no more elegant route here.

---

## Security

All three routes live under the Host origin and must call `requestRejection` themselves —
they are registered as `exact` routes, which are dispatched before the Host's `/api` prefix
table and therefore shadow the authentication the Host puts on every other `/api` endpoint.
The plugin reuses the Host's own authority (Host/Origin fence plus the browser auth cookie),
staying inside the same permission model rather than beside it.

- Two more independent fences: the socket's remote address must be loopback (127/8, `::1`,
  IPv4-mapped), and the `Host` header must name a loopback authority.
  `X-Forwarded-For` is never trusted; `sec-fetch-site: cross-site` is refused outright.
- Request bodies are bounded to 4 KiB and refused past that (not buffered and then inspected).
- A **one-shot gate** on the destructive actions: once accepted it is never released, because
  the process is going away anyway. It clears only when the helper could not be started at all
  (spawn failure, bootstrap timeout, or the helper's dedicated exit code 3) — the one case
  where a retry is meaningful.
- Exit code 3 and the refusal marker distinguish "refused before touching anything" (safe to
  retry) from "failed mid-flight" (the tree may already be killed, so the gate must never be
  released). A WORKER-phase refusal happens after the bootstrap has already exited 0, so the
  Host cannot observe it — the helper records it in a marker file, read on the next attempt.

---

## Troubleshooting

The log lives in DSH's logs directory as `restart-button.log` (plus a refusal marker
`restart-button.refused`). That directory is resolved as `$DSH_HOME\logs`, then by deriving
it from the Host's own profile argument, then `%TEMP%` — so on a machine whose `DSH_HOME` is
not `~/.dsh`, the log is wherever it actually points.

---

## Known limits

- **Windows only.** Relies on `taskkill`, `Win32_Process.Create` (WMI) and
  `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`; macOS / Linux answer
  `supported: false` and hide both interfaces.
- **WMI must be available.** If it is disabled or blocked by security software the bootstrap
  fails and the UI shows the failure rather than silently doing nothing.
- **It hard-interrupts work in progress.** That is the inherent cost of a forced kill; the
  confirmation says so when work is running.
- **A restart does not restore UI state.** It is equivalent to "quit and reopen": uncommitted
  input is lost and a running turn does not resume.
- **Neither interface appears in terminal mode (`dsh web`).** There is no restart semantics to
  reproduce there; the plugin answers `supported: false` and hides entirely rather than
  showing a button that does nothing.
- **The new window is raised, but keyboard focus is not guaranteed.** Windows' foreground lock
  keeps a background process from taking focus, so the window comes to the front while you may
  need one click before typing.
- **No "restart" row can be added to the avatar menu.** That menu's rows are a hard-coded array
  with no menu-row slot.
- **The sidebar seat relies on `:has()` and on the shell's class suffixes** (`footArea` /
  `footerActions` / `settingsArea`); where `:has()` is unsupported that reflow is dropped
  entirely and the layout reverts to the shell's own stacked foot — exactly what it was before
  this plugin, so nothing gets worse. The floating button is unaffected either way.

---

## Files

| File | Purpose |
| --- | --- |
| `lib/index.js` | Host half: three loopback routes (status / action / config), desktop-topology probe, starts and awaits the bootstrap |
| `lib/restart-helper.ps1` | Two-phase helper: the bootstrap re-creates itself through WMI; the worker reads the command line, asks for the port, kills the tree, waits for the conditions, relaunches with the original arguments, and raises the new window |
| `lib/client.js` | Browser half: the floating control (drag / edge snap / hover reveal / jelly feedback), the sidebar power icon, and the configuration page's two switches |
| `cordis.patch.yml` | Bundle patch: one Host row; the browser half is composed automatically from `dsh.client` |
| `docs/DESIGN.md` | Engineering notes (Chinese): the evidence and measurements behind each counter-intuitive decision |
| `LICENSE` | MIT |

## Development (for contributors only)

`lib/` is the finished loadable artifact. Edit it and the UI hot-reloads (when the profile
installs the package with `link:`, source edits need no reinstall). Read `docs/DESIGN.md`
before changing code — it records the places that look simplifiable and are not.

## License

MIT
