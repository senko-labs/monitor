# Installing on another PC

## What the target PC needs

- Windows 10 or newer
- Node.js 18+ — the installer fetches the LTS build with winget if it is missing
- ffmpeg + ffprobe — **bundled inside the package**, nothing to install
- An account that logs in interactively (screen capture needs a real desktop)
- Disk space: sessions vary; budget for how long the PC is used

No administrator rights are required. The task is registered for the user who
runs the installer, under that user's account only.

## 1. Build the package (on this PC)

```powershell
npm run package
```

Produces `dist\screen-activity-recorder-1.0.0.zip` (~170 MB with ffmpeg
bundled).

```powershell
npm run package-small    # ~30 KB instead; the target PC downloads ffmpeg
                         # during installation and needs internet access
```

(npm eats PowerShell-style `-Switch` arguments, so use these script names
rather than `npm run package -- -NoFfmpeg`. To pass other options, call the
script directly: `powershell -ExecutionPolicy Bypass -File scripts\package.ps1
-NoFfmpeg -OutDir X`.)

## 2. Install (on the target PC)

Copy the ZIP over, unzip it somewhere permanent — **not** a temp folder, since
the app runs from where you unzip it — and run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

That checks Windows and Node, verifies ffmpeg, registers the hidden logon task,
starts recording, and prints where the videos go.

Useful options:

```powershell
# Put recordings on another drive (recommended - they are large)
... -File scripts\install.ps1 -OutputDir D:\ScreenRecordings

# Fail instead of installing Node automatically
... -File scripts\install.ps1 -SkipNodeInstall

# Run several instances side by side, or rename the task
... -File scripts\install.ps1 -TaskName ScreenRecorderFloor2
```

Anything else (quality, idle timeout, retention) is in `config.json`; edit it
before installing, or edit it later and restart with `npm run stop` followed by
`schtasks /run /tn ScreenActivityRecorder`.

## 3. Verify

```powershell
npm run status
```

Expect `Running (pid …)`, the task listed with `LastTaskResult 0`, and — after
moving the mouse for a few seconds — `Capturing right now: yes`. To see a real
file immediately without waiting three hours:

Move the mouse for a few seconds, wait ~10s to go idle, and a file appears in
`recordings\`. Then reboot once and run `npm run status` again to confirm it
comes back by itself.

## Viewing recordings from another PC in a browser

`install.ps1` already set up the viewer. To open it from a *different* PC:

1. On the recording PC, set `"viewerBindAll": true` in `config.json`.
2. Re-run `npm run install-viewer` (or `install.ps1`). It rebinds to all
   network interfaces, opens the viewer port on the Windows Firewall for the
   private network, and prints the address, e.g. `https://192.168.1.42:8443`.
3. On the other PC, open that address in any browser and click through the
   self-signed-certificate warning. You get a list of the finished videos;
   click a block to play, seek, download, or delete it.

To remove the certificate warning on the watching PC, copy `certsiewer.crt`
from the recording PC and run there:

```powershell
powershell -ExecutionPolicy Bypass -File scripts	rust-cert.ps1 -CrtPath viewer.crt
```

Both PCs must be on the same network and able to reach the port. HTTPS encrypts
the traffic but the viewer has no password, so only enable `viewerBindAll` on a
trusted network.

### If it is unreachable from the other PC

Run this on the recording PC first — it pinpoints the cause:

```powershell
npm run diagnose-viewer
```

The usual cause is the **Windows Firewall rule**, which needs administrator
rights to create. If `install-viewer` was run without admin, it prints the
command and skips the rule. Fix it by opening **PowerShell as administrator** and
running:

```powershell
New-NetFirewallRule -DisplayName 'ScreenActivityViewer TCP 8443' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8443 -Profile Any
```

(Use your actual `viewerPort` if you changed it.) The rule covers all network
profiles, so it works whether the PC is on a Public, Private, or Domain network.

From the other PC, confirm the port is reachable:

```powershell
Test-NetConnection <recording-pc-ip> -Port 8443    # TcpTestSucceeded : True
```

If that is False, the firewall rule is missing or a router/VLAN is isolating the
two PCs. If it is True but the browser still fails, check you used `https://`
(not `http://`) and the right port.

## Uninstall

```powershell
npm run uninstall-autostart   # stops the recorder and removes its logon task
npm run uninstall-viewer      # stops the viewer and removes its logon task
```

Recordings are left alone; delete the folder afterwards if you want them gone.

## Rolling out to many PCs

The ZIP is self-contained, so any push mechanism works — a share, Intune, PDQ,
or a login script. Two things to keep in mind:

- The task is **per user**. `install.ps1` must run as the account that will be
  recorded; running it as an admin service account registers it for that
  account instead, and nothing will be captured.
- `launch-hidden.vbs` is generated during installation with absolute paths to
  that machine's node.exe and install folder, so never copy it between PCs —
  `package.ps1` deliberately excludes it.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `running scripts is disabled on this system` | Launch with `powershell -ExecutionPolicy Bypass -File …` as shown above. |
| `Node.js was installed but is not on PATH yet` | winget updated PATH for new processes only. Open a new terminal and re-run. |
| Task shows `LastTaskResult 0` but nothing records | Check `logs\monitor.log`. Usually ffmpeg is missing (`npm run setup-ffmpeg`) or the account is not logged in interactively. |
| Nothing recorded while the PC was locked | Expected. `gdigrab` cannot capture the lock screen, and there is no user input then anyway. |
| Recording stops and the log says disk space | Free space fell under `minFreeDiskMB`. It resumes by itself once space is back; set `retentionDays` to prune automatically. |
