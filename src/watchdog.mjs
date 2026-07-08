// Safety net for a known Bun runtime bug (oven-sh/bun#17723, sharpened in
// oven-sh/bun#27766): under sustained allocation pressure — the GC churn from
// Ink's re-renders combined with streaming fetches (AI review/Ask) is a known
// trigger — Bun's bundled bmalloc can spin a CPU core at 100% in a native,
// zero-backoff retry loop with the JS event loop completely frozen. No fix has
// shipped as of this writing, and the process can't rescue itself once wedged
// (nothing in it runs anymore, including its own timers), so this spawns an
// independent sidecar that watches from outside and kills it if it's genuinely
// stuck rather than just doing real (bursty, I/O-bound) work.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { cacheHome } from "./paths.mjs";

const POLL_MS = 20_000;
const CPU_THRESHOLD = 90; // percent
const CONSECUTIVE_HITS = 4; // ~80s sustained at/above threshold before acting

function watchdogDir() {
  return `${cacheHome()}/orbit-diff`;
}

function log(line) {
  try {
    mkdirSync(watchdogDir(), { recursive: true });
    appendFileSync(`${watchdogDir()}/watchdog.log`, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // best-effort — a failed log write shouldn't stop the kill
  }
}

// One `ps` call → { cpu, comm } or null if the pid is gone. `comm` is re-checked
// before killing so a recycled pid can never take out an unrelated process.
function sample(pid) {
  const r = spawnSync("ps", ["-o", "pcpu=,comm=", "-p", String(pid)], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  const m = /^\s*([\d.]+)\s+(.*)$/.exec(r.stdout.trim().split("\n")[0]);
  return m ? { cpu: parseFloat(m[1]), comm: m[2] } : null;
}

// Best-effort forensic capture before killing — the same kind of evidence the
// upstream bug reports relied on, in case this needs to be reported again.
function captureSample(pid) {
  spawnSync("sample", [String(pid), "3", "-f", `${watchdogDir()}/watchdog-sample-${pid}.txt`]);
}

// Spawn the sidecar for the given (already-running) orbit-diff process. Call
// once per launch, right after the pid it should watch is known. No-op on
// platforms without `ps` (only macOS/Linux binaries are published).
export function spawnWatchdog(pid = process.pid) {
  if (process.platform === "win32") return;
  try {
    spawn(process.execPath, ["__watchdog", String(pid)], { stdio: "ignore", detached: true }).unref();
  } catch {
    // best-effort — a failed spawn just means no safety net this run
  }
}

// The sidecar's own main loop, invoked as `orbit-diff __watchdog <pid>`.
export async function runWatchdog(pidArg) {
  const pid = Number(pidArg);
  if (!Number.isInteger(pid) || pid <= 0) return;

  let streak = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const s = sample(pid);
    if (!s || !/orbit-diff/i.test(s.comm)) return; // exited (or pid recycled) — done
    streak = s.cpu >= CPU_THRESHOLD ? streak + 1 : 0;
    if (streak >= CONSECUTIVE_HITS) {
      log(`pid ${pid} pinned at ${s.cpu}% cpu for ~${Math.round((streak * POLL_MS) / 1000)}s — killing`);
      captureSample(pid);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
      log(`pid ${pid} killed (see watchdog-sample-${pid}.txt for a pre-kill stack sample)`);
      return;
    }
  }
}
