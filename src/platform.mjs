// Shared platform → release-asset mapping, used by the `update` command and
// kept in sync with the targets built in .github/workflows/release.yml.
export const REPO = "Diagonal-HQ/orbit-diff";

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
