# dsh-power-button helper.
#
# Two phases, because the process that does the killing must not be inside the
# tree it kills:
#
#   BOOTSTRAP (default): the DSH Host spawns this file as an ordinary child.
#     It re-creates itself as a WORKER through Win32_Process.Create (WMI) and
#     exits. A WMI-created process reports WmiPrvSE.exe as its parent, so it is
#     outside the application's process tree and `taskkill /T` cannot reach it.
#     It also inherits neither the Host's environment nor its console, which is
#     why every fact the worker needs is passed as a parameter.
#
#     WMI is used rather than a detached spawn because a detached
#     `child_process.spawn` was measured to run but NOT to escape: `detached`
#     only starts a new process group, the child still reports the spawning
#     process as its parent, and a `taskkill /T` on the tree was measured to
#     terminate it as well. Win32_Process.Create was measured to parent the child
#     to WmiPrvSE.exe instead, survive its creator's exit, and finish its work.
#
#   WORKER (-Worker): the real work, in sequence.
#     1. Let the HTTP response reach the browser.
#     2. Re-read the shell's own command line WHILE IT IS STILL ALIVE, so the
#        relaunch reuses exactly the arguments it was started with (Electron's
#        own app.relaunch() does the same).
#     3. Kill the shell tree. The Host process is a child of the shell, so this
#        also stops the DSH Host; `/T` is what reaches it.
#     4. Wait, BEFORE relaunching, for three conditions rather than a fixed
#        delay: the shell gone, the Host gone, and the Host's listening port
#        released. The shell takes a single-instance lock at startup, so
#        launching while the old process still holds it makes the new process
#        focus the dying instance and exit without a window -- which looks
#        exactly like nothing having happened.
#     5. Relaunch from the recorded command line.
#     6. Raise the new shell's window to the front. A freshly started shell does
#        NOT reliably end up in front of an application the user is working in,
#        and this process is the only one left that can fix that: it survives
#        the restart and it is not the foreground process, so the technique is
#        the z-order one, not an activation request (see Show-WindowInFront).
#
# For `-Mode quit` steps 2, 4, 5 and 6 are skipped: the tree is killed and
# nothing is started again.
#
# Every step is appended to a log file, because a hidden process with no console
# has nowhere else to report.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int]$MainPid,
    [Parameter(Mandatory = $true)][int]$HostPid,
    [Parameter(Mandatory = $true)][ValidateSet('restart', 'quit')][string]$Mode,
    [Parameter(Mandatory = $true)][string]$ExePath,
    [string]$LogDir,
    [int]$SettleMs = 500,
    [int]$WaitSeconds = 20,
    # The Host's listening port. 0 means "discover it from the process table
    # while the Host is still alive". The Host does not publish its port to its
    # children, so discovery is the normal path and this parameter is the escape
    # hatch for a machine where discovery comes back empty.
    [int]$WebPort = 0,
    # The launching environment's DSH_* variables, base64 JSON. The worker is
    # created through WMI (no environment inheritance) and relaunches with
    # Start-Process (which inherits the WORKER's environment), so without this
    # an override such as DSH_HOME that lived only in the launcher's
    # environment would be lost and the new instance could start against a
    # different profile root.
    [string]$EnvB64 = '',
    [switch]$Worker
)

$ErrorActionPreference = 'Stop'

$helperPath = $PSCommandPath

# --- logging -----------------------------------------------------------------

if (-not $LogDir -or $LogDir.Trim() -eq '') {
    $LogDir = if ($env:DSH_HOME -and $env:DSH_HOME.Trim() -ne '') {
        Join-Path $env:DSH_HOME 'logs'
    } else {
        Join-Path ([System.IO.Path]::GetTempPath()) 'dsh-power-button'
    }
}
try {
    if (-not (Test-Path -LiteralPath $LogDir)) {
        New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    }
} catch {
    $LogDir = [System.IO.Path]::GetTempPath()
}
$logPath = Join-Path $LogDir 'restart-button.log'

function Write-Log {
    param([string]$Message)
    $phase = if ($Worker) { 'worker' } else { 'bootstrap' }
    $line = '{0} [pid {1}] {2} {3} {4}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $PID, $Mode, $phase, $Message
    try {
        Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8 -ErrorAction Stop
    } catch {
        # A vanished log target must never stop the restart itself.
    }
}

# A refusal this script makes BEFORE touching any process.
#
# The Host can only observe the BOOTSTRAP's exit code, and the guards that check
# the shell's identity run in the WORKER -- which the bootstrap has already
# spawned and stopped waiting for. Without a channel back, such a refusal is
# invisible to the Host, which then keeps its one-shot gate claimed and leaves
# the control permanently unable to act.
#
# So a refusal is recorded in a small marker file beside the log, written only on
# this path, and the Host deletes it before each launch and checks it after: its
# presence means "nothing was killed, a retry is safe".
function Write-Refusal {
    param([string]$Reason)
    Write-Log "REFUSED: $Reason"
    try {
        $marker = Join-Path $LogDir 'restart-button.refused'
        Set-Content -LiteralPath $marker -Value $Reason -Encoding UTF8 -ErrorAction Stop
    } catch {
        # The log line is the durable record; the marker is best-effort.
    }
}

# --- phase 1: bootstrap ------------------------------------------------------

if (-not $Worker) {
    # Re-create this script as a WMI child so the worker sits outside the shell's
    # process tree. The worker call is embedded as an encoded command, which
    # avoids every quoting question raised by paths that contain spaces (both
    # this script's own path and the shell's executable can).
    $quote = { param([string]$value) "'" + ($value -replace "'", "''") + "'" }
    $inner = '& {0} -MainPid {1} -HostPid {2} -Mode {3} -ExePath {4} -LogDir {5} -SettleMs {6} -WaitSeconds {7} -WebPort {8} -EnvB64 {9} -Worker' -f `
        (& $quote $helperPath), $MainPid, $HostPid, (& $quote $Mode), (& $quote $ExePath), (& $quote $LogDir), $SettleMs, $WaitSeconds, $WebPort, (& $quote $EnvB64)
    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($inner))

    $powershellPath = if ($env:SystemRoot) {
        Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    } else {
        'powershell.exe'
    }
    $commandLine = '"{0}" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand {1}' -f `
        $powershellPath, $encoded

    # Hide the worker's console window before it can be painted.
    #
    # `-WindowStyle Hidden` alone is NOT enough and was measured to still flash a
    # console window: Win32 creates the window as the process starts, before
    # PowerShell has parsed its own command line, so that flag arrives too late.
    # `Win32_ProcessStartup.ShowWindow = 0` is applied by the WMI provider at
    # creation time and was measured to leave no visible window at all (polling
    # EnumWindows for a visible top-level window of the new pid reported none,
    # against a control launch that did report one).
    #
    # `CreateFlags = CREATE_NO_WINDOW` (0x08000000) is deliberately NOT set:
    # `Win32_Process.Create` rejected it with return value 21 (invalid
    # parameter), both alone and combined with ShowWindow.
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }

    Write-Log "bootstrap: creating worker via WMI (helper=$helperPath)"
    try {
        $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
            CommandLine               = $commandLine
            ProcessStartupInformation = $startup
        }
    } catch {
        # A restricted WMI provider may refuse the startup information; the
        # worker does not depend on it, so retry without it rather than leaving
        # the user with a button that never acts.
        Write-Log "bootstrap: startup information rejected ($($_.Exception.Message)); retrying without it"
        try {
            $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }
        } catch {
            Write-Refusal "WMI unavailable: $($_.Exception.Message)"
            exit 3
        }
    }
    if ($null -eq $created -or $created.ReturnValue -ne 0 -or -not $created.ProcessId) {
        $code = if ($null -eq $created) { 'no result' } else { "returnValue=$($created.ReturnValue)" }
        Write-Refusal "Win32_Process.Create refused the worker: $code"
        exit 3
    }
    Write-Log "bootstrap: worker created pid=$($created.ProcessId)"
    exit 0
}

# --- phase 2: worker ---------------------------------------------------------

# --- process helpers ---------------------------------------------------------

function Get-ProcessRecord {
    param([int]$ProcessId)
    try {
        Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
    } catch {
        $null
    }
}

# Cheap liveness probe for the wait loops, which poll every 200 ms.
# `Get-Process` answers from the process table, whereas `Get-CimInstance` pays a
# WMI round trip per call; the WMI read is kept for the one-time queries that
# need more than a name (`ExecutablePath`, `CommandLine`).
function Test-ProcessAlive {
    param([int]$ProcessId)
    $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Wait-ProcessGone {
    param([int]$ProcessId, [int]$TimeoutSeconds)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-ProcessAlive -ProcessId $ProcessId)) { return $true }
        Start-Sleep -Milliseconds 200
    }
    return -not (Test-ProcessAlive -ProcessId $ProcessId)
}

# Normalise an address column into something `IPAddress.Parse` accepts.
#
# One place, because two discovery paths (netstat and the cmdlet) report the same
# binding in different spellings, and `Test-PortFree` must bind exactly the
# address that was found. netstat wraps an IPv6 literal in brackets (`[::1]`),
# the cmdlet does not, and a dual-stack listener can be reported in IPv4-mapped
# form (`::ffff:127.0.0.1`), which `Parse` accepts but which would never equal
# the `127.0.0.1` the same listener is also reported as.
function Resolve-BindAddress {
    param([string]$Address)
    if (-not $Address) { return '' }
    $text = ([string]$Address).Trim()
    if ($text.StartsWith('[') -and $text.EndsWith(']')) { $text = $text.Trim('[', ']') }
    $mapped = [regex]::Match($text, '^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$')
    if ($mapped.Success) { $text = $mapped.Groups[1].Value }
    return $text
}

# Is this address one the Host's UI could plausibly be reached on? 127/8 is the
# loopback range, not one literal, and `::1` must be accepted: it is the IPv6
# loopback and the address a Node server bound to `::1` reports, which an
# earlier 3-literal filter silently dropped, taking the port condition with it.
function Test-LoopbackAddress {
    param([string]$Address)
    if (-not $Address) { return $false }
    if ($Address -eq '0.0.0.0' -or $Address -eq '::') { return $true }   # wildcard
    if ($Address -eq '::1') { return $true }
    if ($Address -match '^127(\.\d{1,3}){3}$') { return $true }
    return $false
}

# Pick ONE endpoint out of everything the Host is listening on.
#
# The two paths used to disagree: netstat returned the first row whose owner
# matched, taking whatever address that row carried -- measured, pid 4 matched
# 7 rows including a non-loopback one -- while the cmdlet path filtered to three
# literals. Returning a row's address by position also made the answer depend on
# netstat's row order, which is not documented and was measured to differ
# between calls. So every candidate is collected and ranked here instead:
# loopback before non-loopback, a specific address before a wildcard (so the
# answer is the real UI port and not a co-listening port on 0.0.0.0), then port
# and address as a stable tie-break.
function Select-ListeningEndpoint {
    param($Candidates)
    $ranked = @()
    foreach ($c in @($Candidates)) {
        if ($null -eq $c) { continue }
        $address = Resolve-BindAddress -Address $c.Address
        $port = [int]$c.Port
        if ($port -le 0) { continue }
        if (Test-LoopbackAddress -Address $address) { $tier = 0 } else { $tier = 1 }
        if ($address -eq '0.0.0.0' -or $address -eq '::') { $specific = 1 } else { $specific = 0 }
        $ranked += [pscustomobject]@{ Tier = $tier; Specific = $specific; Port = $port; Address = $address }
    }
    if ($ranked.Count -eq 0) { return $null }
    $best = $ranked | Sort-Object Tier, Specific, Port, Address | Select-Object -First 1
    return @{ Port = [int]$best.Port; Address = [string]$best.Address }
}

# Find the port the Host is listening on, with the address it is bound to.
#
# The Host is started with only its profile directory, so it does not tell its
# children which port it picked; asking the process itself is the only way to
# learn it. Discovery is best-effort by design: a port that cannot be found must
# never block a restart, because the other two conditions already cover the
# failure this one exists to catch. It is queried WHILE THE HOST IS ALIVE.
#
# The ADDRESS is returned with the port because the release test below binds
# this exact address: binding a different one reads as "free" while a listener
# still holds the port (measured -- `bind 127.0.0.1` succeeded while another
# process held `0.0.0.0` on the same port).
#
# `netstat` runs FIRST on purpose. Measured on this machine: the first
# `Get-NetTCPConnection` call in a process costs ~700 ms (module import) and
# `netstat -ano` costs ~13 ms for the same answer, so the expensive cmdlet is
# kept only as the fallback for a trimmed install with no netstat.
#
# `-p TCP` is deliberately NOT passed. Measured here: `netstat -ano -p TCP`
# returned 344 rows and ZERO bracketed ones, while plain `netstat -ano` returned
# 434 rows including 27 IPv6 rows, for the same ~13 ms. The protocol selector is
# exclusive (`netstat /?` lists `TCP | UDP | TCPv6 | UDPv6` as separate choices),
# so `-p TCP` silently dropped every `[::]`/`[::1]` listener -- exactly the rows
# a dual-stack Node server produces. That would have made discovery fall through
# to the slow cmdlet for a Host bound to `::`, and fail outright for one bound to
# `::1`, which is the case the port condition must not lose.
#
# `netstat` prints the state as `LISTENING` in English on this locale (checked
# against the zh-CN MUI, which ships both spellings), so the state and owner
# columns are matched structurally as well.
function Get-ListeningPort {
    param([int]$ProcessId)
    $candidates = @()
    try {
        # stderr is relaxed around the call for the same reason as in Stop-Tree:
        # a redirected native stderr record can be promoted to a terminating
        # error under the script-wide `$ErrorActionPreference = 'Stop'`. Measured:
        # `netstat` itself writes 0 bytes to stderr, but a restart must not depend
        # on that.
        $previous = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $lines = & netstat.exe -ano 2>$null
        } finally {
            $ErrorActionPreference = $previous
        }
        foreach ($line in $lines) {
            if ($line -notmatch 'LISTENING') { continue }
            if ($line -notmatch ('^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+' + $ProcessId + '\s*$')) { continue }
            $port = [int]$Matches[2]
            if ($port -le 0) { continue }
            # The raw column is kept as-is; a bracketed IPv6 literal arrives as
            # `[::1]` and is normalised in one place (Resolve-BindAddress), so the
            # two discovery paths cannot disagree about what they are comparing.
            $candidates += @{ Port = $port; Address = $Matches[1] }
        }
    } catch {
        # No netstat, or it refused to run: fall through to the cmdlet.
    }
    try {
        $conn = Get-NetTCPConnection -State Listen -OwningProcess $ProcessId -ErrorAction Stop
        foreach ($c in $conn) {
            $port = [int]$c.LocalPort
            if ($port -le 0) { continue }
            $candidates += @{ Port = $port; Address = [string]$c.LocalAddress }
        }
    } catch {
        # The NetTCPIP module may be absent on a trimmed Windows install.
    }
    $picked = Select-ListeningEndpoint -Candidates $candidates
    if ($null -ne $picked) { return $picked }
    return @{ Port = 0; Address = $null }
}

# Is anything still listening on this port?
#
# The test BINDS the address the listener was found on and asks whether the
# bind succeeds. Binding is the direct question ("is this address free?"),
# whereas connecting asks it indirectly and pays a TCP timeout for the answer.
#
# Measured on this machine, both while the peer address had no listener at all:
#   connect to a free port returns after ~2040 ms (twice, a port that was never
#   listened on), while bind returns in ~20 ms. In the real restart log the
#   shell and the Host were already gone ~2 s before the port reported free --
#   that gap was this probe, not the OS, and it delayed every relaunch.
#
# The failure mode is deliberately the SAFE one. A bind that fails while the
# port is in fact free (a firewall gluing the bind, or an address spelling this
# code failed to recognise) makes this answer "still held", so the wait runs to
# its timeout and then proceeds with a WARNING -- slow, but correct.
#
# TIME_WAIT is NOT such a case, and an earlier version of this comment claimed it
# was. Measured: with a real `TIME_WAIT` socket on the port (confirmed in
# netstat after closing both ends) a same-address bind SUCCEEDS. So there is no
# "safe but slow" cost here -- the answer is fast AND correct, and a comment
# saying otherwise would invite someone to "fix" it back.
#
# The unsafe direction, reporting "free" while a listener holds the port, is
# closed by binding the SAME address the listener was discovered on:
#   bound 0.0.0.0, another process holds 0.0.0.0  -> bind 0.0.0.0    FAILS  (held)
#   bound 127.0.0.1, another process holds it    -> bind 127.0.0.1  FAILS  (held)
#   bound 0.0.0.0, tested against 127.0.0.1      -> bind 127.0.0.1  SUCCEEDS (WRONG)
# which is why the address is carried along -- so the discovered address being
# RIGHT is the load-bearing part, and why `Select-ListeningEndpoint` ranks
# candidates instead of taking whichever row netstat happened to print first.
# A port with no known address falls back to the connect probe below.
#
# A connection-only check is still used when the address is unknown (a
# caller-supplied `-WebPort`, or discovery that produced no address), because
# a bind against a guessed address is exactly the unsafe case above. There, as
# before, only a REFUSED connection counts as free: a timeout, a firewall or
# LSP interception, or Winsock exhaustion is read as "still held", since
# relaunching into a held port is the outcome this check exists to avoid.
function Test-PortFree {
    param([int]$Port, [string]$Address)
    if ($Port -le 0) { return $true }
    $bindAddress = Resolve-BindAddress -Address $Address
    if ($bindAddress -ne '') {
        $listener = $null
        try {
            $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse($bindAddress), $Port)
            $listener.Start()
            return $true
        } catch {
            return $false
        } finally {
            if ($null -ne $listener) {
                try { $listener.Stop() } catch { }
            }
        }
    }
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect('127.0.0.1', $Port)
        return $false
    } catch {
        $inner = $_.Exception.InnerException
        if ($inner -is [System.Net.Sockets.SocketException]) {
            $code = $inner.SocketErrorCode
            if ($code -eq [System.Net.Sockets.SocketError]::ConnectionRefused -or
                $code -eq [System.Net.Sockets.SocketError]::ConnectionReset) {
                return $true
            }
        }
        return $false
    } finally {
        $client.Dispose()
    }
}

# Wait for the three conditions instead of sleeping a fixed interval.
#
# A fixed delay is a guess that is wrong in both directions: too short and the
# relaunch hits the single-instance handoff, too long and every restart is
# needlessly slow. The conditions are the facts the delay was standing in for.
# The overall budget is $TimeoutSeconds, and on expiry the caller is told which
# condition was still unmet rather than being left to infer it.
function Wait-ShellReleased {
    param([int]$ShellPid, [int]$HostPid, [int]$Port, [string]$Address, [int]$TimeoutSeconds)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $shellGone = $false
    $hostGone = $false
    $portFree = ($Port -le 0)
    $waitStarted = Get-Date
    $portProbed = $false
    while ((Get-Date) -lt $deadline) {
        if (-not $shellGone) { $shellGone = -not (Test-ProcessAlive -ProcessId $ShellPid) }
        if (-not $hostGone) { $hostGone = -not (Test-ProcessAlive -ProcessId $HostPid) }
        if (-not $portFree) {
            $portProbed = $true
            $portFree = Test-PortFree -Port $Port -Address $Address
            if ($portFree) {
                # Recorded because this term dominates the relaunch wait, and a
                # regression here (back to a connect probe) shows up as this
                # number jumping by ~2 s rather than as a failure.
                Write-Log ("port $Port released after $([int]((Get-Date) - $waitStarted).TotalMilliseconds)ms")
            }
        }
        if ($shellGone -and $hostGone -and $portFree) {
            return @{ Released = $true; ShellGone = $true; HostGone = $true; PortFree = $true }
        }
        Start-Sleep -Milliseconds 200
    }
    if (-not $portProbed -and $Port -gt 0) {
        Write-Log "port $Port was never re-probed before the deadline"
    }
    return @{ Released = $false; ShellGone = $shellGone; HostGone = $hostGone; PortFree = $portFree }
}

# Kill one process tree, tolerating an already-dead target.
#
# `/F` is not negotiable here, and a gentle `WM_CLOSE` is deliberately not tried
# first: the desktop shell intercepts its main window's `close` event, calls
# `preventDefault()` and hides to the tray instead (`resources/app/lib/main.js`
# window.on("close")), so a close request leaves the process alive and would only
# add the grace period to every restart before the same force-kill. The
# graceful path is `app.quit()` inside the shell, which no external process can
# invoke; see the README for what that costs.
function Stop-Tree {
    param([int]$ProcessId, [string]$Label)
    if (-not (Test-ProcessAlive -ProcessId $ProcessId)) {
        Write-Log "$Label $ProcessId is already gone"
        return
    }
    # `taskkill` writes even its success lines to stderr, and under the script-wide
    # `$ErrorActionPreference = 'Stop'` a redirected native stderr record can be
    # promoted to a terminating error. That would abort the worker immediately
    # after the kill -- with DSH already dead and nothing relaunched, the worst
    # possible moment. The recorded runs continued past this line, so it did not
    # fire here, but a restart must not depend on that: the preference is relaxed
    # for the duration of the call and restored afterwards.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & taskkill.exe /PID $ProcessId /T /F 2>&1 | ForEach-Object { Write-Log "$Label taskkill: $_" }
    } finally {
        $ErrorActionPreference = $previous
    }
}

# Split a Windows command line into the executable token and its arguments.
# The shell's command line is `"C:\path\app.exe" arg1 arg2`: a quoted first token
# is the normal case, an unquoted one ends at the first space.
function Split-CommandLine {
    param([string]$CommandLine)
    $trimmed = $CommandLine.Trim()
    if ($trimmed.StartsWith('"')) {
        $end = $trimmed.IndexOf('"', 1)
        if ($end -lt 0) { return @{ File = $trimmed.Trim('"'); Args = '' } }
        return @{
            File = $trimmed.Substring(1, $end - 1)
            Args = $trimmed.Substring($end + 1).Trim()
        }
    }
    $space = $trimmed.IndexOf(' ')
    if ($space -lt 0) { return @{ File = $trimmed; Args = '' } }
    return @{
        File = $trimmed.Substring(0, $space)
        Args = $trimmed.Substring($space + 1).Trim()
    }
}

# --- raise the relaunched window ---------------------------------------------

# How long to wait for the new shell's window to exist before giving up on
# raising it. The window appears only after the shell's own startup (Electron
# shows it on `ready-to-show`), so it is not there when Start-Process returns.
$WindowRaiseSeconds = 25

# After a raise, how long to keep watching for a FURTHER window before stopping.
# The shell's window is normally the only one, but a splash or a dialog can
# appear after it, and each one is raised as it shows up.
$WindowRaiseQuietSeconds = 3

# Bring the relaunched shell's window to the front.
#
# WHY THIS IS DONE HERE. A freshly started shell does NOT reliably end up in
# front of whatever the user is working in, and the shell cannot fix it for
# itself: it is started by a background process while the foreground belongs to
# some other application, and Windows only lets the process that owns the
# foreground hand it away. This process is the last one standing that can act,
# so the raise is done here, after the relaunch.
#
# WHICH TECHNIQUE, MEASURED. Every candidate was run from this script's own
# context — a WMI-created, console-less process that is NOT the foreground
# process — against two windows and the global top-level z-order:
#
#   SetForegroundWindow                                 no change to z-order
#   SetForegroundWindow after AttachThreadInput         no change
#   SwitchToThisWindow                                  no change
#   BringWindowToTop + SetForegroundWindow              no change
#   SetWindowPos(HWND_TOP), with and without activation no change
#   SetWindowPos(HWND_TOPMOST) then (HWND_NOTOPMOST)     RAISED, and stayed
#
# The failures are the foreground lock: a process that does not own the
# foreground may not take it, and every one of those calls is a request to
# activate. Entering the topmost band and immediately leaving it only changes
# z-order, which needs no such right — and that is the one that worked. It is
# also why this must NOT be replaced with a `SetForegroundWindow` call that
# "looks cleaner": that form was measured to do nothing here.
function Initialize-WindowRaise {
    if ($script:WindowRaiseState -eq 'ready') { return $true }
    if ($script:WindowRaiseState -eq 'failed') { return $false }
    try {
        if (-not ('DshrbWindow' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

/// Window enumeration and z-order placement for the relaunch step.
public static class DshrbWindow {
    private delegate bool EnumProc(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    private const uint GwOwner = 4;
    private const uint RaiseFlags = 0x0001 | 0x0002 | 0x0010 | 0x0040; // NOSIZE | NOMOVE | NOACTIVATE | SHOWWINDOW
    private static readonly IntPtr TopmostBand = new IntPtr(-1);
    private static readonly IntPtr OrdinaryBand = new IntPtr(-2);

    /// The visible, owner-less top-level windows of one process: an
    /// application's real windows, without its message-only and tool windows.
    public static IntPtr[] Windows(uint processId) {
        List<IntPtr> found = new List<IntPtr>();
        EnumWindows(delegate(IntPtr window, IntPtr parameter) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != processId) return true;
            if (!IsWindowVisible(window)) return true;
            if (GetWindow(window, GwOwner) != IntPtr.Zero) return true;
            found.Add(window);
            return true;
        }, IntPtr.Zero);
        return found.ToArray();
    }

    /// Move one window to the front of the ordinary band. Entering the topmost
    /// band and leaving it at once needs no foreground right, which is what
    /// makes this work from a background process.
    public static bool Raise(IntPtr window) {
        bool up = SetWindowPos(window, TopmostBand, 0, 0, 0, 0, RaiseFlags);
        bool down = SetWindowPos(window, OrdinaryBand, 0, 0, 0, 0, RaiseFlags);
        return up || down;
    }
}
'@
        }
        $script:WindowRaiseState = 'ready'
        return $true
    } catch {
        # A locked-down host can refuse Add-Type. Losing the raise must never
        # turn a successful restart into a reported failure.
        Write-Log "window raise unavailable: $($_.Exception.Message)"
        $script:WindowRaiseState = 'failed'
        return $false
    }
}

# Poll for the relaunched process's windows and raise each one ONCE, as it
# appears. Bounded, and never fatal: the restart has already succeeded by the
# time this runs.
#
# Why "each one, as it appears" rather than raising whatever is there and
# stopping: the real shell creates its window hidden and shows it on
# `ready-to-show`, which is seconds after the process starts, so the window that
# matters is usually NOT there on the first poll. Returning after the first
# successful raise was measured to raise the wrong thing and miss the real
# window entirely -- the exact failure the user reported.
#
# A handle is remembered only after its raise SUCCEEDED, which is what "raised
# once" has to mean. Marking it up front (an earlier version did) turns the one
# chance this window gets into a single attempt.
#
# How the failure branch is reached, measured rather than assumed: `Raise` on a
# live, visible window returns True, and `Windows()` never hands out a handle
# that is already dead (a destroyed window stops being enumerated), so the False
# branch is a RACE -- the window exits between being enumerated and being placed.
# That is exactly the moment a relaunched shell is most likely to be churning
# through its startup windows, and retrying is what makes a window that appears
# during that churn get a second look instead of being retired on one attempt.
# Failures are retried on later ticks, with `$MaxRaiseAttempts` as the backstop
# and one log line per window so a permanently refusing window cannot flood the
# log at the 150 ms poll rate.
function Show-WindowInFront {
    param([int]$ProcessId, [int]$TimeoutSeconds, [int]$QuietSeconds)
    if (-not (Initialize-WindowRaise)) { return }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $handled = @{}
    $attempts = @{}
    $MaxRaiseAttempts = 40
    $raisedCount = 0
    $lastRaise = $null
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-ProcessAlive -ProcessId $ProcessId)) {
            Write-Log "window raise: pid $ProcessId exited (raised $raisedCount window(s))"
            return
        }
        foreach ($handle in @([DshrbWindow]::Windows([uint32]$ProcessId))) {
            $key = [string]$handle
            if ($handled.ContainsKey($key)) { continue }
            $tries = 0
            if ($attempts.ContainsKey($key)) { $tries = [int]$attempts[$key] }
            if ($tries -ge $MaxRaiseAttempts) { continue }
            $attempts[$key] = $tries + 1
            if ([DshrbWindow]::Raise($handle)) {
                $handled[$key] = $true
                $raisedCount++
                $lastRaise = Get-Date
                Write-Log "window raise: pid $ProcessId raised window $handle"
            } elseif ($tries -eq 0) {
                Write-Log "window raise: pid $ProcessId window $handle refused the placement; will retry"
            }
        }
        # Leave once a raise has happened and no further window has appeared for
        # a while, so a late one is still caught without lingering indefinitely.
        if ($raisedCount -gt 0 -and $null -ne $lastRaise -and
            ((Get-Date) - $lastRaise).TotalSeconds -ge $QuietSeconds) {
            Write-Log "window raise: pid $ProcessId raised $raisedCount window(s); done"
            return
        }
        Start-Sleep -Milliseconds 150
    }
    Write-Log "window raise: pid $ProcessId stopped after ${TimeoutSeconds}s having raised $raisedCount window(s)"
}

Write-Log "worker start main=$MainPid host=$HostPid exe=$ExePath settle=${SettleMs}ms wait=${WaitSeconds}s"

# Let the HTTP response reach the browser before the shell dies with it.
#
# This is a DEADLINE, not an unconditional sleep. The guarantee that matters is
# "at least $SettleMs elapses between the worker starting and the shell being
# killed"; sleeping the full interval and only THEN doing the identification work
# below added the two together and made every restart slower than it had to be.
# `$settleDeadline` is honoured right before the kill, so the read-only
# identification overlaps the window instead of extending it.
#
# Measured on this machine before the change: the identification (WMI reads plus
# port discovery) took about 2 s, so the fixed 900 ms sleep was pure added
# latency. The deadline keeps the safety property and removes that latency.
$workerStarted = Get-Date
$settleDeadline = $workerStarted.AddMilliseconds($SettleMs)

# --- identify the shell ------------------------------------------------------

$main = Get-ProcessRecord -ProcessId $MainPid
if ($null -eq $main) {
    Write-Log "shell pid $MainPid no longer exists; nothing to do"
    exit 0
}

# The pid must still be the shell executable. A recycled pid must never be
# killed, so compare the live image path against the expected one.
#
# An UNREADABLE image path is treated as "cannot verify" and refuses too. Letting
# it fall through would fail this guard open at exactly the moment it is the only
# thing standing between a recycled pid and a wrong kill -- the comparison is
# skipped silently when WMI cannot read the path (insufficient rights, a
# protected or transitional process), which reads identically to "no mismatch".
$mainExe = $main.ExecutablePath
if (-not $mainExe -or -not $ExePath) {
    Write-Refusal "cannot verify pid $MainPid (live image path '$mainExe', expected '$ExePath')"
    exit 3
}
if ($mainExe.Trim() -ne $ExePath.Trim()) {
    Write-Refusal "pid $MainPid is '$mainExe', not the expected shell '$ExePath'"
    exit 3
}

$launch = $null
if ($Mode -eq 'restart') {
    $launch = Split-CommandLine -CommandLine ([string]$main.CommandLine)
    Write-Log "shell command line captured: file='$($launch.File)' args='$($launch.Args)'"
}

# Learn the web port while the Host is still alive: it is what the third
# relaunch condition watches. `-WebPort 0` means "not supplied", so discovery is
# the normal path; a supplied port is watched too, since supplying one is an
# explicit assertion about which socket belongs to this Host.
#
# `$WebAddress` carries the address the port was found on, because the release
# test binds that exact address. A caller-supplied port comes with no address,
# so the release test falls back to connecting in that case.
$WebAddress = $null
if ($WebPort -le 0) {
    $discovered = Get-ListeningPort -ProcessId $HostPid
    if ($discovered.Port -gt 0) {
        $WebPort = $discovered.Port
        $WebAddress = $discovered.Address
        Write-Log "host $HostPid listening on port $WebPort (address $WebAddress)"
    } else {
        $WebPort = 0
        Write-Log "could not discover the host's listening port; relying on the process conditions alone"
    }
} else {
    Write-Log "using supplied web port $WebPort (address unknown; the release test will connect)"
}

# Resolve the relaunch target BEFORE anything is killed.
#
# Nothing may be closed that cannot be reopened: a restart that dies after the
# kill leaves the user with no window and no process, which is strictly worse
# than not starting. The executable can genuinely be gone or moved mid-session
# (an in-place app update replaces `resources/`, and `$ExePath` came from
# `process.execPath`), so this check is reachable, not theoretical.
if ($Mode -eq 'restart') {
    if ($null -eq $launch -or -not $launch.File) {
        Write-Log 'no command line captured; falling back to the recorded executable path'
        $launch = @{ File = $ExePath; Args = '' }
    }
    if (-not (Test-Path -LiteralPath $launch.File)) {
        Write-Log "recorded executable '$($launch.File)' does not exist; using '$ExePath'"
        $launch = @{ File = $ExePath; Args = $launch.Args }
    }
    if (-not (Test-Path -LiteralPath $launch.File)) {
        Write-Refusal "no launchable executable at '$($launch.File)'; refusing to close DSH"
        exit 3
    }
    Write-Log "relaunch target verified: '$($launch.File)'"
}

# --- stop --------------------------------------------------------------------

# Honour the settle deadline established above. Everything between that point and
# here is read-only, so this is the last possible moment to wait; by now the
# identification work has normally already filled the interval and this is a
# no-op. Only the REMAINING time is slept, never the full interval again.
$remaining = [int][Math]::Ceiling(($settleDeadline - (Get-Date)).TotalMilliseconds)
if ($remaining -gt 0) {
    Write-Log "waiting $($remaining)ms for the response to reach the browser"
    Start-Sleep -Milliseconds $remaining
} else {
    Write-Log 'response window already elapsed during identification'
}

Stop-Tree -ProcessId $MainPid -Label 'shell'
if (-not (Test-ProcessAlive -ProcessId $MainPid)) {
    Write-Log "shell $MainPid exited"
} else {
    Write-Log "shell $MainPid still alive after taskkill; waiting"
    if (-not (Wait-ProcessGone -ProcessId $MainPid -TimeoutSeconds $WaitSeconds)) {
        Write-Log "shell $MainPid did not exit; abandoning the relaunch"
        exit 1
    }
    Write-Log "shell $MainPid exited after waiting"
}

# The Host is a child of the shell and normally dies with it; kill it explicitly
# when it is still alive so a restart cannot leave two Hosts on one web port.
#
# It is verified first, for the same reason the shell is: this runs after
# `$SettleMs`, the shell `taskkill`, and up to `$WaitSeconds` of waiting, which
# is long enough for the pid to have been recycled by an unrelated process.
# The Host runs as the SAME image as the shell (the Electron binary in Node
# mode), so `$ExePath` is the right thing to compare against.
if (Test-ProcessAlive -ProcessId $HostPid) {
    $hostRecord = Get-ProcessRecord -ProcessId $HostPid
    $hostExe = if ($null -eq $hostRecord) { $null } else { $hostRecord.ExecutablePath }
    if (-not $hostExe -or ($hostExe.Trim() -ne $ExePath.Trim())) {
        Write-Log "not killing host ${HostPid}: image is '$hostExe', expected '$ExePath' (pid may have been recycled)"
    } else {
        Stop-Tree -ProcessId $HostPid -Label 'host'
    }
} else {
    Write-Log "host $HostPid is already gone"
}

if ($Mode -eq 'quit') {
    Write-Log 'quit complete'
    exit 0
}

# --- relaunch ----------------------------------------------------------------

# The target was resolved and verified before the shell was killed.
$launchFile = $launch.File

# Wait for the shell and the Host to disappear AND for the web port to be
# released, rather than sleeping a fixed interval. See Wait-ShellReleased.
#
# The port condition is what makes this a judgement instead of a guess. The
# single-instance handoff that a too-early relaunch causes is invisible from the
# outside -- the new process focuses the dying instance and exits, so the user
# sees nothing at all happen -- and a held port is the observable that predicts
# it. If the wait expires, the log records which condition was still unmet so a
# failure names its own cause.
#
# `$WebPort` is 0 only when neither a caller-supplied value nor discovery produced
# one; in that case the wait falls back to the two process conditions rather than
# watching a port that does not describe this Host.
$released = Wait-ShellReleased -ShellPid $MainPid -HostPid $HostPid -Port $WebPort -Address $WebAddress -TimeoutSeconds $WaitSeconds
if (-not $released.Released) {
    Write-Log ("WARNING: proceeding after ${WaitSeconds}s with shellGone=$($released.ShellGone) hostGone=$($released.HostGone) portFree=$($released.PortFree); the relaunch may hit the single-instance handoff")
} else {
    Write-Log "shell, host and port all released"
}

$startArgs = @{
    FilePath         = $launchFile
    WorkingDirectory = (Split-Path -Parent $launchFile)
}

# Restore the launcher's DSH_* variables before starting the new instance.
#
# `Start-Process` gives the child THIS process's environment, and this process was
# created through WMI, which inherits nothing. Without this step an override such
# as `DSH_HOME` that existed only in the environment DSH was launched with would
# be dropped, and the new instance could come up against a different profile root
# -- which the user experiences as their sessions and settings having vanished.
#
# The variables are set in this process rather than passed with a
# `Start-Process -Environment` parameter: that parameter needs PowerShell 7,
# while this script targets the Windows PowerShell 5.1 that ships with Windows.
if ($EnvB64 -and $EnvB64.Trim() -ne '') {
    try {
        $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EnvB64))
        $restored = $json | ConvertFrom-Json
        $names = @()
        foreach ($property in $restored.PSObject.Properties) {
            [System.Environment]::SetEnvironmentVariable($property.Name, [string]$property.Value)
            $names += $property.Name
        }
        Write-Log "restored launcher environment: $($names -join ', ')"
    } catch {
        # Losing the handoff must not stop the restart; the new instance simply
        # inherits whatever this process has.
        Write-Log "could not restore the launcher environment: $($_.Exception.Message)"
    }
}
if ($launch.Args -and $launch.Args.Trim() -ne '') {
    $startArgs.ArgumentList = $launch.Args
}

try {
    # -PassThru is required by the raise step below: the new shell's window is
    # found by process id, and Start-Process does not report it otherwise.
    $relaunched = Start-Process @startArgs -PassThru
    Write-Log "relaunched '$launchFile' with args '$($launch.Args)' (pid $($relaunched.Id))"
} catch {
    Write-Log "FAILED to relaunch '$launchFile': $($_.Exception.Message)"
    exit 1
}

# Put the new window in front, so a restart cannot leave DSH hidden behind the
# application the user was working in. Never fatal: the restart has already
# succeeded, and losing the raise is a cosmetic loss, not a failed restart.
if ($null -ne $relaunched) {
    try {
        Show-WindowInFront -ProcessId $relaunched.Id -TimeoutSeconds $WindowRaiseSeconds -QuietSeconds $WindowRaiseQuietSeconds
    } catch {
        Write-Log "window raise failed: $($_.Exception.Message)"
    }
}

Write-Log 'restart complete'
exit 0
