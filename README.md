# opencode_watch_bash

A tiny zero-dependency CLI inspired by opencode's `bash_watch` tool: run a shell
command, stream its output live into a watch panel, kill it on timeout, and
print an end-of-run status line.

```
$ owatch -t 30 "for i in 1 2 3; do echo step $i; sleep 1; done"
── Watch: for i in 1 2 3; do echo step $i; sleep 1; done ──────────
│ step 1
│ step 2
│ step 3
── Status: done (exit code 0) · 3.0s ──────────────────────────────
```

This repo contains two things:

- **`opencode_watch_bash/`** — a standalone Python CLI (`owatch`) that works in any terminal
- **`opencode-plugin/`** — the actual opencode plugin pair (`bash-watch` tool + TUI watch panel), including the fix that keeps each opencode window's Watch panel scoped to its own session (see below)

## Features

- Live line-by-line streaming of stdout + stderr (merged)
- Optional timeout that kills the whole process group (exit code 124)
- End-of-run summary with exit status and duration
- `--no-stream` mode that only prints the last N lines (`--tail`, default 200)
- Optional `--log FILE` to keep the full output on disk
- Custom panel title via `--title`
- Zero dependencies, Python 3.8+

## Install

```bash
pip install .
```

Or run it straight from a checkout without installing:

```bash
python -m opencode_watch_bash.cli "make build"
```

## Usage

```
usage: opencode-watch-bash [-h] [-t SECONDS] [--tail N] [--title LABEL]
                           [--log FILE] [--no-stream] [-V] [COMMAND ...]

Run a shell command and stream its output live into a watch panel, with
optional timeout and an end-of-run summary.

positional arguments:
  COMMAND              shell command to run; put options first, or use -- before it

options:
  -h, --help           show this help message and exit
  -t, --timeout SECONDS
                       kill the command after this many seconds (exit code 124)
  --tail N             lines shown in the end-of-run summary with --no-stream (default: 200)
  --title LABEL        label shown in the panel header (default: the command)
  --log FILE           append full output to FILE
  --no-stream          do not print output while running; only print the tail summary
  -V, --version        show program's version number and exit
```

`opencode-watch-bash` and the shorter alias `owatch` both work.

## Examples

Stream a test suite and stop it if it hangs for more than 10 minutes:

```bash
owatch -t 600 "pytest -x"
```

Give the panel a name:

```bash
owatch --title "training" "python train.py --epochs 100"
```

Long build: stay quiet, log everything, only show the last 50 lines at the end:

```bash
owatch --no-stream --tail 50 --log build.log "make -j8"
```

## Exit codes

- the command's own exit code on normal exit
- `124` when the command was killed by `--timeout`
- `130` when interrupted with Ctrl+C

## Development

```bash
python -m unittest discover -s tests -v
```

## The opencode plugin (opencode-plugin/)

The original form of this tool: two plugin files for [opencode](https://opencode.ai).

- `bash-watch.ts` — a server plugin that registers the `bash_watch` tool: spawns the command, streams stdout+stderr to a log file, honors `timeout_seconds`, and writes a small JSON manifest next to the log
- `bash-watch.tui.tsx` — a TUI plugin that registers the sidebar Watch panel: polls the streams directory, renders the live tail, status, elapsed time; click the header to collapse, `✕` to close the panel

The output area is a two-dimensional scrollbox: mouse wheel scrolls up/down through the tail (up to 500 lines), Shift+wheel or the scrollbar arrows scroll left/right for long lines, and while the command is running the view auto-follows new output (sticky scroll).

The panel height is adjustable: click the `⤢` button next to the close `✕` to cycle the viewport height (10 → 20 → 40 rows). The preference is remembered across sessions. The panel width is fixed by the opencode sidebar (42 columns, hardcoded in opencode's TUI); horizontal scrolling exists to compensate.

### Install

Copy the two files into your opencode config directories (rename the TUI file
to `bash-watch.tsx`):

```bash
cp opencode-plugin/bash-watch.ts     ~/.config/opencode/plugins/
cp opencode-plugin/bash-watch.tui.tsx ~/.config/opencode/tui-plugins/bash-watch.tsx
```

The tool plugin needs `@opencode-ai/plugin` available to your plugin loader
(opencode resolves it automatically for config-dir plugins). Restart opencode
after installing.

### Session isolation

Each stream is stored under `~/.local/state/opencode/bash-watch/streams/<sessionID>/`,
and the sidebar panel reads only the current session's directory (via the
`session_id` prop of the `sidebar_content` slot). Streams are pruned after one
hour; finished panels disappear after two.

This fixes cross-talk between multiple opencode windows: originally all
windows shared one flat directory and every panel showed whichever stream
happened to be newest globally.

## License

[MIT](LICENSE)
