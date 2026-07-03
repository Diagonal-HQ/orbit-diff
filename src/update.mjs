import { basename, dirname, join } from "node:path";
import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import { assetForPlatform, REPO } from "./platform.mjs";
import { VERSION } from "./version.mjs";

// `orbit-diff update` — replace the running standalone binary in place with the
// latest published release asset for this platform.
export async function runUpdate() {
  const target = process.execPath;

  // In dev mode (`bun index.jsx`) execPath is the bun runtime, not our binary,
  // so there's nothing to self-replace.
  if (basename(target) === "bun") {
    console.error("orbit-diff update: only works on the installed standalone binary.");
    console.error("You're running via `bun` (dev mode). Install the binary with:");
    console.error(`  curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | sh`);
    process.exit(1);
  }

  const asset = assetForPlatform();
  if (!asset) {
    console.error(`orbit-diff update: no prebuilt binary for ${process.platform}/${process.arch}.`);
    process.exit(1);
  }

  // Resolve the latest tag so we can skip the download when already current.
  let tag = null;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "User-Agent": "orbit-diff", Accept: "application/vnd.github+json" },
    });
    if (res.ok) tag = (await res.json()).tag_name ?? null;
  } catch {
    // Network hiccup on the version check — fall through and try the download.
  }
  if (tag && tag === VERSION) {
    console.log(`orbit-diff is already up to date (${VERSION}).`);
    return;
  }

  const url = `https://github.com/${REPO}/releases/latest/download/${asset}`;
  process.stdout.write(`Downloading orbit-diff ${tag ?? "latest"} (${asset})… `);
  let buf;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "orbit-diff" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    buf = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    console.error(`\norbit-diff update: download failed (${err.message}).`);
    process.exit(1);
  }

  // Write next to the target and atomically rename over it. Replacing a running
  // executable is fine on macOS/Linux — the live process keeps the old inode.
  const tmp = join(dirname(target), `.orbit-diff.update.${process.pid}`);
  try {
    await writeFile(tmp, buf, { mode: 0o755 });
    await chmod(tmp, 0o755);
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    console.error(`\norbit-diff update: could not replace ${target}: ${err.message}`);
    if (err.code === "EACCES" || err.code === "EPERM") {
      console.error("You may need write access to that directory (e.g. re-run with sudo).");
    }
    process.exit(1);
  }

  console.log(`done.\nUpdated → ${tag ?? "latest"} at ${target}`);
}
