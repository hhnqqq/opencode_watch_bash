import argparse
import os
import signal
import subprocess
import sys
import threading
import time

from . import __version__

WIDTH = 72


def build_parser():
    parser = argparse.ArgumentParser(
        prog="opencode-watch-bash",
        description=(
            "Run a shell command and stream its output live into a watch panel, "
            "with optional timeout and an end-of-run summary."
        ),
    )
    parser.add_argument(
        "-t",
        "--timeout",
        type=float,
        metavar="SECONDS",
        help="kill the command after this many seconds (exit code 124)",
    )
    parser.add_argument(
        "--tail",
        type=int,
        default=200,
        metavar="N",
        help="lines shown in the end-of-run summary with --no-stream (default: 200)",
    )
    parser.add_argument(
        "--title",
        metavar="LABEL",
        help="label shown in the panel header (default: the command)",
    )
    parser.add_argument(
        "--log",
        metavar="FILE",
        help="append full output to FILE",
    )
    parser.add_argument(
        "--no-stream",
        action="store_true",
        help="do not print output while running; only print the tail summary",
    )
    parser.add_argument(
        "-V",
        "--version",
        action="version",
        version=f"%(prog)s {__version__}",
    )
    parser.add_argument(
        "command",
        nargs=argparse.REMAINDER,
        metavar="COMMAND",
        help="shell command to run; put options first, or use -- before it",
    )
    return parser


def kill_process_group(proc):
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except OSError:
        try:
            proc.kill()
        except OSError:
            pass


def rule(label):
    line = "── {} ".format(label)
    print(line + "─" * max(0, WIDTH - len(line)), flush=True)


def run(argv=None):
    args = build_parser().parse_args(argv)
    command_parts = list(args.command)
    if command_parts and command_parts[0] == "--":
        command_parts = command_parts[1:]
    if not command_parts:
        build_parser().error("a command is required")
    command = " ".join(command_parts)
    title = args.title or command

    rule("Watch: {}".format(title))
    start = time.monotonic()
    proc = subprocess.Popen(
        command,
        shell=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        start_new_session=True,
    )

    lines = []
    lock = threading.Lock()
    eof = threading.Event()
    log_file = open(args.log, "a", encoding="utf-8") if args.log else None

    def pump():
        try:
            for line in iter(proc.stdout.readline, ""):
                line = line.rstrip("\n")
                with lock:
                    lines.append(line)
                if log_file:
                    log_file.write(line + "\n")
                    log_file.flush()
                if not args.no_stream:
                    print("│ " + line, flush=True)
        finally:
            if log_file:
                log_file.close()
            eof.set()

    thread = threading.Thread(target=pump, daemon=True)
    thread.start()

    timed_out = False
    interrupted = False
    try:
        if args.timeout is not None:
            deadline = start + args.timeout
            while proc.poll() is None:
                if time.monotonic() >= deadline:
                    timed_out = True
                    kill_process_group(proc)
                    break
                time.sleep(0.05)
        else:
            proc.wait()
    except KeyboardInterrupt:
        interrupted = True
        kill_process_group(proc)
    eof.wait(timeout=5)
    proc.wait()
    thread.join(timeout=5)
    duration = time.monotonic() - start

    if timed_out:
        status = "killed (timeout after {:g}s)".format(args.timeout)
        exit_code = 124
    elif interrupted:
        status = "interrupted"
        exit_code = 130
    else:
        exit_code = proc.returncode if proc.returncode is not None else 0
        if exit_code == 0:
            status = "done (exit code 0)"
        else:
            status = "failed (exit code {})".format(exit_code)

    if args.no_stream:
        with lock:
            tail = lines[-args.tail :] if args.tail > 0 else []
        for line in tail:
            print("│ " + line)
        if not tail:
            print("│ (no output)")

    rule("Status: {} · {:.1f}s".format(status, duration))
    return exit_code


def main():
    sys.exit(run())


if __name__ == "__main__":
    main()
