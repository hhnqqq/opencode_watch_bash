import { spawn } from "node:child_process"
import fs from "node:fs"
import * as fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { tool } from "@opencode-ai/plugin"

const STREAMS_DIR = path.join(os.homedir(), ".local", "state", "opencode", "bash-watch", "streams")
const DEFAULT_TIMEOUT = 600
const MAX_TIMEOUT = 3600
const PRUNE_MS = 60 * 60 * 1000
const TAIL_BYTES = 65536
const RESULT_LINES = 200

type StreamStatus = "running" | "done" | "error" | "timeout" | "aborted"

function makeId() {
  return `stw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function sessionDir(sessionID: string) {
  return path.join(STREAMS_DIR, sessionID)
}

async function pruneFile(file: string, now: number) {
  try {
    const stat = await fsp.stat(file)
    if (now - stat.mtimeMs < PRUNE_MS) return
    if (path.basename(file).endsWith(".json")) {
      const text = await fsp.readFile(file, "utf8").catch(() => "")
      if (text.includes('"running"')) return
    }
    await fsp.unlink(file).catch(() => {})
  } catch {}
}

async function prune() {
  try {
    const now = Date.now()
    for (const name of await fsp.readdir(STREAMS_DIR)) {
      const entry = path.join(STREAMS_DIR, name)
      let stat
      try {
        stat = await fsp.stat(entry)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        for (const file of await fsp.readdir(entry).catch(() => [] as string[])) {
          await pruneFile(path.join(entry, file), now)
        }
        try {
          const remaining = await fsp.readdir(entry)
          if (remaining.length === 0) await fsp.rmdir(entry).catch(() => {})
        } catch {}
      } else {
        await pruneFile(entry, now)
      }
    }
  } catch {}
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

function lastLines(text: string, count: number): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-count)
    .join("\n")
}

export const BashWatchPlugin = async () => {
  return {
    tool: {
      bash_watch: tool({
        description:
          "Run a shell command and stream its output live to a 'Watch' panel in the user's TUI sidebar. The panel pops open automatically and the user can close it at any time (closing does not stop the command). Use this for long-running commands whose progress the user should follow: training runs, builds, large test suites, data processing. For quick commands use the regular bash tool instead. Blocks until the command finishes or times out.",
        args: {
          command: tool.schema.string().describe("Shell command to execute"),
          title: tool.schema.string().optional().describe("Short label shown in the Watch panel header"),
          workdir: tool.schema.string().optional().describe("Working directory (defaults to the project worktree)"),
          timeout_seconds: tool.schema
            .number()
            .optional()
            .describe(`Kill the process after this many seconds (default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT})`),
        },
        async execute(args, context) {
          const command = args.command.trim()
          if (!command) return "No command provided."
          const label = args.title?.trim() || command.split("\n")[0].slice(0, 60)
          const timeoutSeconds = Math.min(Math.max(Math.floor(args.timeout_seconds ?? DEFAULT_TIMEOUT), 1), MAX_TIMEOUT)

          await fsp.mkdir(sessionDir(context.sessionID), { recursive: true })
          prune().catch(() => {})

          const id = makeId()
          const dir = sessionDir(context.sessionID)
          const logFile = path.join(dir, `${id}.log`)
          const manifestFile = path.join(dir, `${id}.json`)
          const started = Date.now()

          const writeManifest = (status: StreamStatus, exit?: number, ended?: number) =>
            fsp.writeFile(
              manifestFile,
              JSON.stringify({
                id,
                sessionID: context.sessionID,
                command,
                title: args.title?.trim(),
                started,
                ...(ended !== undefined ? { ended } : {}),
                status,
                ...(exit !== undefined ? { exit } : {}),
              }),
            )

          await writeManifest("running")
          context.metadata({ title: `Watch: ${label}` })

          let timedOut = false
          let spawnError: string | undefined
          const fd = fs.openSync(logFile, "a")
          let exit: number | undefined
          try {
            const child = spawn("bash", ["-c", command], {
              cwd: args.workdir ?? context.worktree ?? context.directory,
              stdio: ["ignore", fd, fd],
            })
            exit = await new Promise<number | undefined>((resolve) => {
              const timer = setTimeout(() => {
                timedOut = true
                child.kill("SIGKILL")
              }, timeoutSeconds * 1000)
              const onAbort = () => child.kill("SIGKILL")
              context.abort.addEventListener("abort", onAbort, { once: true })
              const finish = (code: number | undefined) => {
                clearTimeout(timer)
                context.abort.removeEventListener("abort", onAbort)
                resolve(code)
              }
              child.once("exit", (code, signal) => finish(code ?? (signal ? 137 : undefined)))
              child.once("error", (err) => {
                spawnError = err.message
                finish(undefined)
              })
            })
          } finally {
            fs.closeSync(fd)
          }

          const ended = Date.now()
          const status: StreamStatus = context.abort.aborted
            ? "aborted"
            : timedOut
              ? "timeout"
              : exit === 0
                ? "done"
                : "error"
          await writeManifest(status, exit, ended)

          const tail = lastLines(await readTail(logFile), RESULT_LINES)
          const lines = [
            `Status: ${status}${exit !== undefined ? ` (exit code ${exit})` : ""}`,
            `Duration: ${((ended - started) / 1000).toFixed(1)}s`,
            spawnError ? `Spawn error: ${spawnError}` : "",
            "The user could follow this live in the sidebar Watch panel.",
            "",
            `Output (last ${RESULT_LINES} lines):`,
            tail || "(no output)",
          ]
          return {
            title: `Watch: ${label}`,
            output: lines.filter((line) => line !== "").join("\n"),
          }
        },
      }),
    },
  }
}
