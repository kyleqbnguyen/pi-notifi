# pi-notifi

A [pi](https://pi.dev/) package that sends desktop notifications when an
interactive pi task finishes, unless the tmux window containing that pi agent is
already visible in Hyprland.

Notifications include a `Focus` action that jumps back to the originating pi
agent by focusing the saved Hyprland/Ghostty/tmux target.

This package is intentionally developed for an Arch + Hyprland + Ghostty +
tmux + dunst workflow. If your setup differs, copy/fork it and adapt the small
focus script.

## Requirements

- Linux with Hyprland
- Ghostty
- tmux
- dunst or another notification daemon compatible with `notify-send` actions
- `notify-send` from `libnotify`
- `dunstctl` if using the example keybinds
- `jq`

On Arch:

```bash
sudo pacman -S libnotify dunst jq
```

Your pi shell should be running inside tmux, and that tmux client should be
inside a Hyprland-managed Ghostty window.

## Install

From npm, once published:

```bash
pi install npm:pi-notifi
```

From git:

```bash
pi install git:github.com/<you>/pi-notifi
```

For a one-off test without installing:

```bash
pi -e git:github.com/<you>/pi-notifi
```

For local development from this checkout:

```bash
pi -e /absolute/path/to/pi-notifi
```

The package manifest loads:

```text
index.ts
```

No manual symlink is required. The extension invokes the packaged focus helper
at:

```text
scripts/notifi-focus
```

## My dunst / Hyprland setup

Hyprland binds:

```ini
bind = SUPER, X, exec, dunstctl close
bind = SUPER, N, exec, dunstctl action 0 && dunstctl close
```

Dunst mouse behavior:

```ini
mouse_left_click = do_action, close_current
mouse_right_click = close_current
```

Behavior:

- `SUPER X` / right click: close the current notification without action.
- `SUPER N` / left click: invoke the notification action, then close it.
- For notifi notifications, the action jumps to the Ghostty/tmux location that
  produced that specific notification.

## Commands

Inside pi:

```text
/notifi status
/notifi test
/notifi on|enable
/notifi off|disable
```

`on` / `off` are persisted into the current pi session.

## Configuration

Configuration is read from the first valid JSON file that exists:

1. `<project>/.pi/notifi.json`
2. `~/.pi/agent/notifi.json`

Example:

```json
{
  "disabled": false,
  "urgency": "normal",
  "expireTime": 0,
  "notifyOnError": true,
  "notifyOnAbort": false
}
```

An example file is included at:

```text
examples/notifi.json
```

Available JSON fields:

| Field           | Default                                          | Description                                                         |
| --------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| `disabled`      | `false`                                          | Start disabled                                                      |
| `title`         | `<tmux-session>:<window-index>` or `pi`          | Notification title                                                  |
| `body`          | `Task Finished` / `Task Failed` / `Task Aborted` | Notification body                                                   |
| `urgency`       | `normal` / `critical`                            | notify-send urgency                                                 |
| `expireTime`    | `0`                                              | notify-send expire time in ms; `0` requests persist until dismissed |
| `notifyOnError` | `true`                                           | Notify when a task fails                                            |
| `notifyOnAbort` | `false`                                          | Notify when a task is aborted                                       |

Environment variables with the old `PI_NOTIFI_*` names override JSON for quick
one-off changes. Invalid JSON config files are ignored so a bad config does not
break notification delivery.

## Behavior

Notification is suppressed only when all of these are true:

1. pi is running inside tmux.
2. notifi identifies the tmux session/window containing the pi pane.
3. an attached tmux client is currently viewing that same tmux window.
4. that tmux client maps through its process tree to a Hyprland window.
5. that Hyprland window is on a workspace visible on a monitor.

Pane focus does not matter for notification suppression. If the pi pane is
anywhere in the visible tmux window, no notification is sent. Notification
actions still try to focus the original pi pane after switching to the saved
tmux session/window.

If the tmux window is not visible, notifi sends a persistent notification with a
`Focus` action:

```text
<title: tmux-session:window-index>
<body: Task Finished | Task Failed>
<action: Focus>
```

Aborted tasks do not notify by default. Headless/print-mode pi runs do not
notify.

## Action target cache

Each notification gets a unique UUID target id. The extension writes that
notification's jump target to:

```text
${XDG_CACHE_HOME:-~/.cache}/notifi/targets/<target-id>.json
```

Each notification action captures its own target id, so multiple concurrent pi
agents and long-lived notifications do not overwrite each other.

`scripts/notifi-focus <target-id>`:

1. validates the target id
2. reads the target file
3. deletes the consumed target file
4. prunes target files older than 24 hours
5. switches Hyprland to the saved Ghostty workspace/window when possible
6. switches tmux to the saved session/window
7. focuses the original pi pane if it still exists

If the original Ghostty window no longer exists but the tmux session/window
still exists, the action opens Ghostty attached to that tmux session/window. If
the tmux session/window no longer exists, it exits successfully and does
nothing.

Target files for notifications dismissed without action are cleaned up the next
time a notifi action is consumed.

## Edge cases

- If multiple Ghostty windows are attached to the same tmux session, notifi
  picks the first usable tmux client it can map back to Hyprland.
- If the saved Ghostty/Hyprland window is stale, notifi falls back to opening
  Ghostty attached to the saved tmux session/window.
- If the saved tmux session or window no longer exists, the action exits
  successfully and does nothing.
- If the saved tmux pane no longer exists, the action still switches to the
  saved tmux window and skips pane focus.
- If the target file is missing, malformed, or older than 24 hours when pruning
  runs, the action exits successfully and/or removes stale metadata.
