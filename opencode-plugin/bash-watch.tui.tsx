import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import * as fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const STREAMS_DIR = path.join(os.homedir(), ".local", "state", "opencode", "bash-watch", "streams")
const POLL_MS = 500
const VIEWPORT_ROWS = 10
const MAX_LINES = 500
const MAX_WIDTH = 36
const TAIL_BYTES = 262144
const KEEP_AFTER_END_MS = 2 * 60 * 60 * 1000

type StreamStatus = "running" | "done" | "error" | "timeout" | "aborted"

type Manifest = {
  id: string
  sessionID?: string
  command: string
  title?: string
  started: number
  ended?: number
  status: StreamStatus
  exit?: number
}

const OSC_RE = /\u001B\][^\u0007]*(\u0007|\u001B\\)/g
const CSI_RE = /\u001B\[[0-9;?]*[A-Za-z]/g

function stripAnsi(text: string) {
  return text.replace(OSC_RE, "").replace(CSI_RE, "")
}

function clip(line: string) {
  return line.length > MAX_WIDTH ? `${line.slice(0, MAX_WIDTH - 1)}…` : line
}

async function readTail(file: string): Promise<string> {
  try {
    const stat = await fsp.stat(file)
    const start = Math.max(0, stat.size - TAIL_BYTES)
    const length = stat.size - start
    const handle = await fsp.open(file, "r")
    try {
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, start)
      return buffer.toString("utf8")
    } finally {
      await handle.close()
    }
  } catch {
    return ""
  }
}

function tailLines(text: string): string[] {
  return stripAnsi(text)
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.split("\r").pop() ?? "")
    .filter((line) => line.trim().length > 0)
}

function sessionDir(sessionID: string) {
  return path.join(STREAMS_DIR, sessionID)
}

function createTracker(sessionID: string) {
  const [current, setCurrent] = createSignal<Manifest | undefined>(undefined)
  const [lines, setLines] = createSignal<string[]>([])
  const [closedId, setClosedId] = createSignal<string | undefined>(undefined)
  const [collapsed, setCollapsed] = createSignal(false)
  const [tick, setTick] = createSignal(0)

  let stopped = false
  let seenId: string | undefined
  const dir = sessionDir(sessionID)

  async function poll() {
    try {
      const names = await fsp.readdir(dir).catch(() => [] as string[])
      const manifests: Manifest[] = []
      for (const name of names) {
        if (!name.endsWith(".json")) continue
        try {
          const parsed = JSON.parse(await fsp.readFile(path.join(dir, name), "utf8"))
          if (parsed && typeof parsed.id === "string") manifests.push(parsed)
        } catch {}
      }
      manifests.sort((a, b) => a.started - b.started)

      const now = Date.now()
      for (const item of manifests) {
        if (item.status === "running" || !item.ended) continue
        if (now - item.ended > KEEP_AFTER_END_MS) {
          fsp.unlink(path.join(dir, `${item.id}.json`)).catch(() => {})
          fsp.unlink(path.join(dir, `${item.id}.log`)).catch(() => {})
        }
      }

      if (stopped) return
      const latest = manifests.at(-1)
      if (latest && latest.id !== seenId) {
        seenId = latest.id
        setCollapsed(false)
      }
      setCurrent((prev) =>
        prev && latest && prev.id === latest.id && prev.status === latest.status && prev.exit === latest.exit && prev.ended === latest.ended
          ? prev
          : latest,
      )
      if (latest) {
        const text = await readTail(path.join(dir, `${latest.id}.log`))
        if (stopped) return
        const all = tailLines(text)
        setLines(all.slice(-MAX_LINES))
      }
      setTick((t) => t + 1)
    } catch {}
  }

  const timer = setInterval(poll, POLL_MS)
  poll()

  return {
    current,
    lines,
    closedId,
    setClosedId,
    collapsed,
    setCollapsed,
    tick,
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

type Tracker = ReturnType<typeof createTracker>

const tui = async (api: any) => {
  const trackers = new Map<string, Tracker>()

  function trackerFor(sessionID: string) {
    let tracker = trackers.get(sessionID)
    if (!tracker) {
      tracker = createTracker(sessionID)
      trackers.set(sessionID, tracker)
    }
    return tracker
  }

  try {
    api.lifecycle.onDispose(() => {
      for (const tracker of trackers.values()) tracker.stop()
      trackers.clear()
    })
  } catch {}

  function View(props: { session_id: string }) {
    const tracker = trackerFor(props.session_id)
    const theme = () => api.theme.current
    const visible = createMemo(() => {
      const c = tracker.current()
      return c && c.id !== tracker.closedId() ? c : undefined
    })
    const running = createMemo(() => visible()?.status === "running")
    const elapsed = createMemo(() => {
      const c = visible()
      if (!c) return 0
      tracker.tick()
      return Math.max(0, Math.round(((c.ended ?? Date.now()) - c.started) / 1000))
    })

    const glyph = createMemo(() => {
      switch (visible()?.status) {
        case "running":
          return "●"
        case "done":
          return "✓"
        case undefined:
          return "○"
        default:
          return "✗"
      }
    })

    const glyphColor = createMemo(() => {
      const t = theme()
      switch (visible()?.status) {
        case "running":
          return t.accent
        case "done":
          return t.success
        case "error":
        case "timeout":
          return t.error
        default:
          return t.textMuted
      }
    })

    const headerLabel = createMemo(() => {
      const c = visible()
      if (!c) return ""
      return (c.title || c.command.split("\n")[0]).slice(0, 22)
    })

    const statusLine = createMemo(() => {
      const c = visible()
      if (!c) return ""
      switch (c.status) {
        case "running":
          return `running… ${elapsed()}s`
        case "done":
          return `exit ${c.exit ?? "?"} in ${elapsed()}s`
        case "timeout":
          return `timed out after ${elapsed()}s (killed)`
        case "aborted":
          return `aborted after ${elapsed()}s`
        default:
          return `failed (exit ${c.exit ?? "?"}) in ${elapsed()}s`
      }
    })

    const statusColor = createMemo(() => {
      const t = theme()
      return visible()?.status === "done" ? t.success : running() ? t.textMuted : t.error
    })

    let scrollBox: any
    const contentWidth = createMemo(() => {
      let w = 0
      for (const line of tracker.lines()) if (line.length > w) w = line.length
      return Math.min(Math.max(w + 1, 10), 400)
    })
    createEffect(
      on(
        () => visible()?.id,
        (id) => {
          if (id && scrollBox) scrollBox.scrollTo(0)
        },
      ),
    )

    return (
      <Show when={visible()} fallback={<box></box>}>
        <box>
          <box flexDirection="row" gap={1}>
            <box flexDirection="row" gap={1} onMouseDown={() => tracker.setCollapsed((x) => !x)}>
              <text fg={glyphColor()}>{glyph()}</text>
              <text fg={theme().text}>
                <b>Watch</b>
              </text>
              <Show when={headerLabel()}>
                <text fg={theme().textMuted}>{clip(headerLabel())}</text>
              </Show>
            </box>
            <box onMouseDown={() => tracker.setClosedId(visible()?.id)}>
              <text fg={theme().textMuted}>✕</text>
            </box>
          </box>
          <Show when={!tracker.collapsed()}>
            <text fg={theme().textMuted}>$ {clip(visible()!.command.split("\n")[0])}</text>
            <Show when={tracker.lines().length > VIEWPORT_ROWS}>
              <text fg={theme().textMuted}>{tracker.lines().length} lines</text>
            </Show>
            <scrollbox
              ref={(r: any) => (scrollBox = r)}
              height={VIEWPORT_ROWS}
              scrollX={true}
              scrollY={true}
              stickyScroll={true}
              stickyStart="bottom"
              scrollbarOptions={{ showArrows: true }}
            >
              <box width={contentWidth()} flexDirection="column">
                <For each={tracker.lines()}>{(line) => <text fg={theme().text} wrapMode="none">{line}</text>}</For>
              </box>
            </scrollbox>
            <text fg={statusColor()}>{statusLine()}</text>
          </Show>
        </box>
      </Show>
    )
  }

  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx: unknown, props: { session_id: string }) {
        return <View session_id={props.session_id} />
      },
    },
  })
}

const plugin = {
  id: "user:bash-watch",
  tui,
}

export default plugin
