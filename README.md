# notifi

A pi extension that sends desktop notifications when pi finishes an interactive
task, unless the tmux window containing the pi agent is currently visible in
Hyprland.

This is intentionally not portable. Pi extensions are easy to iterate on
locally, so if your system differs, copy this extension and adapt it for your
compositor, terminal, multiplexer, or notification daemon.

## Requirements

This extension assumes:

- Arch Linux
- Hyprland
- Ghostty
- tmux
- dunst or another `notify-send` compatible notification daemon
- `notify-send` from `libnotify`
- `jq`

Install the notification pieces on Arch:

```bash
sudo pacman -S libnotify dunst
```

Your pi shell must be running inside tmux, and that tmux client must be inside a
Hyprland-managed Ghostty window.

## Install / use

This repo includes:

```text
.pi/extensions/notifi.ts
```

so pi auto-discovers the extension when you run `pi` from this directory. If pi
is already open, run:

```text
/reload
```

From another project, load this extension directly:

```bash
pi -e /home/red/dotfiles/pi/picosystem/notifi/extensions/notifi.ts
```

## Hyprland binds

```ini
bind = SUPER, X, exec, dunstctl close
bind = SUPER, N, exec, dunstctl action 0 && dunstctl close
```

`SUPER X` dismisses the current notification without action.

`SUPER N` invokes the focused notification's action, then dismisses it. For notifi notifications, that action jumps to the Ghostty/tmux window that produced that specific notification. If that Ghostty window was closed but the tmux session/window still exists, it opens a new Ghostty attached to that tmux session/window.

Dunst mouse behavior:

```ini
mouse_left_click = do_action, close_current
mouse_right_click = close_current
```

Left click invokes the notification action, which runs `~/dotfiles/hypr/scripts/notifi-focus`, then closes the notification. Right click only closes the notification.

The live Hyprland script is symlinked from this repo:

```text
~/dotfiles/hypr/scripts/notifi-focus -> ~/dotfiles/pi/picosystem/notifi/scripts/notifi-focus
```

## Commands

Inside pi:

```text
/notifi status
/notifi test
/notifi on|enable
/notifi off|disable
```

`on`/`off` are persisted into the current pi session.

## Configuration

Configuration is read from the first file that exists:

1. `<project>/.pi/notifi.json`
2. `~/.pi/agent/notifi.json`

This repo includes `.pi/notifi.json`:

```json
{
  "disabled": false,
  "urgency": "normal",
  "expireTime": 0,
  "notifyOnError": true,
  "notifyOnAbort": false
}
```

Available JSON fields:

| Field           | Default                                          | Description                                                         |
| --------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| `disabled`      | `false`                                          | Start disabled                                                      |
| `title`         | `<tmux-session>:<window-index>` or `pi`          | Notification title                                                  |
| `body`          | `Task Finished` / `Task Failed` / `Task Aborted` | Notification body                                                   |
| `urgency`       | `normal` / `critical`                            | notify-send urgency                                                 |
| `icon`          | unset                                            | notify-send icon                                                    |
| `expireTime`    | `0`                                              | notify-send expire time in ms; `0` requests persist until dismissed |
| `notifyOnError` | `true`                                           | Notify when a task fails                                            |
| `notifyOnAbort` | `false`                                          | Notify when a task is aborted                                       |

Environment variables with the old `PI_NOTIFI_*` names still override JSON for
quick one-off changes.

## Behavior

Notification is suppressed only when all of these are true:

1. pi is running inside tmux.
2. notifi identifies the tmux session/window containing the pi pane.
3. an attached tmux client is currently viewing that same tmux window.
4. that tmux client maps through its process tree to a Hyprland window.
5. that Hyprland window is on a workspace visible on a monitor.

Pane focus does not matter. If the pi pane is anywhere in the visible tmux
window, no notification is sent.

If the tmux window is not visible, notifi sends a persistent notification with a `Focus` action:

```text
<title: tmux-session:window-index>
<body: Task Finished | Task Failed>
<action: Focus>
```

Aborted tasks do not notify by default. Headless/print-mode pi runs do not notify.

When a notification is sent, notifi writes that notification's jump target to:

```text
~/.cache/notifi/targets/<target-id>.json
```

Each notification action captures its own target id, so multiple concurrent pi agents and long-lived notifications do not overwrite each other.

`scripts/notifi-focus <target-id>` reads that file, deletes it, prunes target files older than 1 day, switches Hyprland to the target Ghostty workspace/window, and switches tmux to the window containing pi. If the original Ghostty window no longer exists but the tmux session/window still exists, it opens Ghostty and attaches to the saved tmux session/window. If the tmux session/window no longer exists, it does nothing.
