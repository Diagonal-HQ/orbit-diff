import { spawn } from "node:child_process";

// Shared platform → release-asset mapping, used by the `update` command and
// kept in sync with the targets built in .github/workflows/release.yml.
export const REPO = "Diagonal-HQ/orbit-diff";

// Open a URL in the system's default browser, detached so it never touches
// the caller's terminal. Returns { ok } / { ok:false, error }.
export function openUrl(url) {
  if (!url) return { ok: false, error: "no URL to open" };
  const platform = process.platform;
  const [cmd, args] =
    platform === "darwin" ? ["open", [url]]
    : platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {}); // swallow ENOENT etc.; nothing to log onto the caller
    child.unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Returns the release asset name for the current platform, or null if we don't
// publish a binary for it (e.g. Intel macOS, Windows).
export function assetForPlatform(
  platform = process.platform,
  arch = process.arch,
) {
  if (platform === "darwin" && arch === "arm64") return "orbit-diff-darwin-arm64";
  if (platform === "linux" && arch === "x64") return "orbit-diff-linux-x64";
  if (platform === "linux" && arch === "arm64") return "orbit-diff-linux-arm64";
  return null;
}
