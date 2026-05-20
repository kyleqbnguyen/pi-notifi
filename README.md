# pi-notifi

A tiny [pi](https://pi.dev) extension that sends a desktop notification when pi finishes a task.

It is designed for Linux notification daemons such as `dunst` and uses `notify-send` by default.

## Install / use

### Project-local development

This repo includes:

```text
.pi/extensions/notifi.ts
```

so pi will auto-discover the extension when you run `pi` from this directory. If pi is already open, run:

```text
/reload
```

### As a pi package

From another project, load this extension directly:

```bash
pi -e /home/red/dotfiles/pi/picosystem/notifi/extensions/notifi.ts
```

Or install it as a local package/path once you publish or wire it into your package setup.

## Requirements

Linux desktop notifications require `notify-send` and a notification daemon:

```bash
sudo pacman -S libnotify dunst   # Arch
sudo apt install libnotify-bin dunst # Debian/Ubuntu
```

Make sure your desktop session exposes `DBUS_SESSION_BUS_ADDRESS`/`DISPLAY` or `WAYLAND_DISPLAY` to the shell that starts pi.

## Commands

Inside pi:

```text
/notifi status
/notifi test
/notifi on
/notifi off
```

`on`/`off` are persisted into the current pi session.

## Configuration

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PI_NOTIFI_DISABLED=1` | unset | Start disabled |
| `PI_NOTIFI_COMMAND` | `notify-send` | Notification command to run |
| `PI_NOTIFI_TITLE` | `<tmux-session>` or `pi` | Notification title |
| `PI_NOTIFI_BODY` | `Task Finished` / `Task Failed` / `Task Aborted` | Notification body |
| `PI_NOTIFI_URGENCY` | `normal` / `critical` | notify-send urgency |
| `PI_NOTIFI_APP_NAME` | `pi` | notify-send app name |
| `PI_NOTIFI_ICON` | unset | notify-send icon |
| `PI_NOTIFI_EXPIRE_TIME` | `0` | notify-send expire time in ms; `0` requests persistence until dismissed |
| `PI_NOTIFI_ON_ERROR_ONLY=1` | unset | Only notify on errors; aborts still require `PI_NOTIFI_NOTIFY_ON_ABORT=1` |
| `PI_NOTIFI_NOTIFY_ON_ABORT=1` | unset | Notify when a task is aborted |
| `PI_NOTIFI_BELL_FALLBACK=0` | enabled | Disable terminal bell fallback if notify-send fails |

Example:

```bash
PI_NOTIFI_TITLE="pi done" \
PI_NOTIFI_URGENCY=low \
PI_NOTIFI_EXPIRE_TIME=5000 \
pi
```

## How it works

pi extensions can subscribe to agent lifecycle events. `notifi` listens for `agent_end`, checks that no queued follow-up/steering messages remain, and then calls the OS notification command via `pi.exec()`.

pi itself does not emit a dunst-specific signal by default. For headless integrations, `pi --mode json` and `pi --mode rpc` also emit `agent_end` events that external programs can watch.
