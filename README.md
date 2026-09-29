# Screen Activity Recorder

A background Windows app that records the **entire screen** with ffmpeg, but only
while the user is actually doing something. Output is H.264 MP4 at 30 fps, **one
file per activity session**. It starts automatically at logon and shows no window.
A built-in browser viewer shows the recordings on a per-day timeline.

## Requirements as implemented

| Requirement | How it is met |
|---|---|
| Capture only when keyboard/mouse activity occurs | A PowerShell helper polls the Win32 `GetLastInputInfo` API twice a second. Input → ffmpeg starts; `idleTimeoutMs` (default 5s) with no input → ffmpeg stops. |
| MP4, H.264 | `libx264` into the ffmpeg `segment` muxer, `-segment_format mp4`, fragmented for crash safety. |
| 30 fps | `-framerate 30` on the gdigrab input and `-r 30` on the output (constant frame rate). |
| Runs as a background process, auto-starts with the PC | A hidden logon Scheduled Task (`ScreenActivityRecorder`) launched through `launch-hidden.vbs`, so no console window ever appears. |
| Windows | Uses `gdigrab` (whole virtual desktop, all monitors) and Windows-only APIs. |

## How files are split

Idle time is not recorded. Each period of keyboard/mouse activity is written to
its own file, `recordings\screen-YYYYMMDD-HHMMSS.mp4` (the timestamp is when that
session started). When you stop touching the keyboard and mouse for
`idleTimeoutMs`, ffmpeg is stopped and the file is closed; the next input starts
a new file.

```
activity   ████████      ██████      ███████████
idle               ░░░░░       ░░░░░
files      screen-...-090000    screen-...-091205    screen-...-093040
```

`segmentSeconds` (default 3h) is only a safety cap so a single *uninterrupted*
session cannot grow without bound; normal sessions end well before it because the
user goes idle. Files use fragmented MP4, so a crash or power cut costs at most
the few seconds of frames still in flight, not the whole file.

## Install

```powershell
# 1. ffmpeg (skip if ffmpeg is already on PATH)
npm run setup-ffmpeg

# 2. run it once in the foreground to check everything works (Ctrl+C to stop)
npm start

# 3. register it to start hidden at every logon, and start it now
npm run install-autostart
```

## Day-to-day

```powershell
npm run status              # running? capturing now? recent files
npm run stop                # stop cleanly
npm run uninstall-autostart # remove the logon task; recordings are kept
npm run viewer              # serve recordings (foreground)
npm run install-viewer      # run that viewer hidden at logon
npm run package             # build a ZIP to install on other PCs
```

To deploy to another machine, see **[INSTALL.md](INSTALL.md)**.

Finished videos land in `recordings\screen-YYYYMMDD-HHMMSS.mp4`. Logs are in
`logs\monitor.log`.

## Viewing recordings in a browser

A small built-in web server (HTTPS) shows the recordings on a **per-day
timeline** — each session is a block placed at the time of day it was recorded,
sized by its length. Click a block to play it (streamed with seek support),
download it, or delete it. You can watch from another PC without copying files.

```powershell
npm run setup-cert       # once: create the TLS certificate (self-signed)
npm run install-viewer   # start it now and at every logon (hidden, no window)
```

Then open **https://localhost:8443** on this PC. `install-viewer` runs
`setup-cert` for you automatically if no certificate exists yet.

**From another PC on the same network:** set `"viewerBindAll": true` in
`config.json` and re-run `npm run install-viewer`. It binds to all interfaces,
opens the port on the Windows Firewall (private network), and prints the
`https://<this-pc-ip>:8443` address to use.

Because the certificate is self-signed, the browser shows a one-time "not
private" warning — click through it, or remove it permanently by trusting the
certificate on the watching PC:

```powershell
# copy certsiewer.crt from the recording PC, then on the watching PC:
powershell -ExecutionPolicy Bypass -File scripts	rust-cert.ps1 -CrtPath viewer.crt
```

Each recording has a **Download** button and, unless disabled, a **Delete**
control (trash icon in the list, and a Delete button under the player) that
**permanently** removes the file from disk after a two-click confirm. Turn this
off with `"viewerAllowDelete": false`. Only finished videos appear; the clip
still being recorded appears once its session ends. Stop/remove the viewer with `npm run uninstall-viewer`. If it is unreachable
from another PC, run `npm run diagnose-viewer` on the recording PC — the most
common cause is the Windows Firewall rule, which needs an administrator shell
(the installer prints the exact command if it could not add it).

**Using a real certificate instead of self-signed:** point `viewerCertFile` and
`viewerKeyFile` at a PEM certificate and private key in `config.json`; they take
precedence over the self-signed one.

To run the viewer over plain HTTP instead, set `"viewerHttps": false`.

> The viewer has no password. HTTPS encrypts the traffic but does not restrict
> who can connect, and delete is a permanent, unauthenticated action when
> `viewerBindAll` is on. Keep it off unless you are on a trusted network, or set
> `"viewerAllowDelete": false` to make the viewer read-only.

## Configuration — `config.json`

| Key | Default | Meaning |
|---|---|---|
| `outputDir` | `recordings` | Where MP4s go. Relative to the app folder, or an absolute path. |
| `fps` | `30` | Capture and output frame rate. |
| `segmentSeconds` | `10800` | Safety cap on the length of one uninterrupted session (10800 = 3h). A session normally ends earlier, when you go idle. |
| `idleTimeoutMs` | `5000` | Stop capturing after this long without keyboard/mouse input. |
| `minRecordingMs` | `15000` | Minimum clip length before an idle gap may end it, so short input bursts do not create a spray of tiny clips. |
| `stopGraceMs` | `30000` | How long to let ffmpeg drain and close a clip before force-killing it. |
| `pollIntervalMs` | `500` | How often idle time is sampled. |
| `drawMouse` | `true` | Draw the mouse cursor into the video. |
| `captureTarget` | `desktop` | `desktop` = whole virtual screen. Can also be `title=<window title>`. |
| `encoder` | `libx264` | H.264 encoder. Use `h264_nvenc` / `h264_qsv` / `h264_amf` for GPU encoding. |
| `preset` | `veryfast` | x264 speed/size trade-off. |
| `crf` | `28` | Quality. Lower = better and bigger (18–30 is the useful range). |
| `fragmentedMp4` | `true` | Write crash-safe fragmented MP4. `false` = plain MP4 (`+faststart`), which is unplayable if the recording is cut off mid-file. |
| `filePrefix` | `screen` | File name prefix. |
| `minFreeDiskMB` | `2048` | Suspend recording when the drive drops below this, resume when it recovers. |
| `retentionDays` | `0` | `0` = never delete. Above 0, finished videos older than this many days are removed hourly. |
| `viewerPort` | `8443` | Port the browser viewer listens on. |
| `viewerBindAll` | `false` | `false` = localhost only. `true` = reachable from other PCs (opens the firewall port). |
| `viewerHttps` | `true` | Serve over HTTPS. `false` = plain HTTP. |
| `viewerCertFile` | `""` | Optional PEM certificate to use instead of the self-signed one. |
| `viewerKeyFile` | `""` | Optional PEM private key that goes with `viewerCertFile`. |
| `viewerAllowDelete` | `true` | Allow deleting recordings from the viewer page. `false` hides the delete controls and refuses delete requests. |
| `ffmpegPath` | `""` | Explicit path to `ffmpeg.exe`. Empty = look in `tools\ffmpeg`, then PATH. |
| `logLevel` | `info` | `debug` also logs the full ffmpeg command line. |

Restart the app after changing `config.json`. Changing `segmentSeconds` does not
affect a recording already in progress; it applies to the next one.

## Disk usage

At 1080p / CRF 28 / `veryfast`, expect roughly **0.5–1.5 GB per hour of
activity**. A session's file size scales with its length and how much the
screen changes. Raise `crf` (e.g. 30) to shrink files, and use `retentionDays`
to cap how much is kept.

## Behaviour notes

- **Locked workstation / lock screen.** `gdigrab` cannot capture the secure
  desktop. There is no user input then either, so the recorder is simply idle.
  If ffmpeg does exit unexpectedly, a 10-second backoff prevents a restart loop.
- **Reboots** simply start a new file when you next log in and become active;
  the fragmented MP4 written before the reboot stays playable.
- **Not a Windows Service.** Services run in session 0 with no interactive
  desktop, so they cannot capture the screen. A hidden logon task is the correct
  mechanism, which also means recording begins after the user logs on.
- **Only one instance runs.** `logs\recorder.lock` guards against the logon task
  and a manual `npm start` fighting over the same output folder.

## Layout

```
src/index.js           main loop: idle state -> start/stop capture, disk, retention
src/idle-monitor.js    wraps the PowerShell GetLastInputInfo poller
src/recorder.js        builds and supervises one capture process per burst
src/ffmpeg-locator.js  finds ffmpeg/ffprobe (config -> tools\ffmpeg -> PATH)
src/config.js          config.json + defaults
src/logger.js          rotating file log
src/single-instance.js pid lock file
src/server.js          browser viewer: lists and streams finished recordings
src/viewer.html        the viewer page
scripts/setup-cert.ps1 generates the self-signed TLS certificate
scripts/trust-cert.ps1 trusts that certificate on a watching PC
scripts/*.ps1          setup-ffmpeg, install/uninstall-autostart, stop, status,
                       idle-monitor
```
