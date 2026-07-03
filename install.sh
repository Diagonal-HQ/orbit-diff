#!/bin/sh
# orbit-diff installer.
#   curl -fsSL https://raw.githubusercontent.com/Diagonal-HQ/orbit-diff/main/install.sh | sh
#
# Downloads the latest release binary for this platform and installs it to
# $ORBIT_DIFF_BIN_DIR (default ~/.local/bin).
set -eu

REPO="Diagonal-HQ/orbit-diff"
BIN_DIR="${ORBIT_DIFF_BIN_DIR:-$HOME/.local/bin}"

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin)
    case "$arch" in
      arm64 | aarch64) asset="orbit-diff-darwin-arm64" ;;
      *) echo "orbit-diff: no prebuilt binary for macOS $arch (only Apple Silicon is published)." >&2; exit 1 ;;
    esac ;;
  Linux)
    case "$arch" in
      x86_64 | amd64) asset="orbit-diff-linux-x64" ;;
      arm64 | aarch64) asset="orbit-diff-linux-arm64" ;;
      *) echo "orbit-diff: no prebuilt binary for Linux $arch." >&2; exit 1 ;;
    esac ;;
  *)
    echo "orbit-diff: unsupported OS '$os'." >&2; exit 1 ;;
esac

url="https://github.com/$REPO/releases/latest/download/$asset"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

echo "Downloading ${asset}..."
if command -v curl >/dev/null 2>&1; then
  curl -fL --progress-bar "$url" -o "$tmp"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp" "$url"
else
  echo "orbit-diff: need curl or wget to download." >&2; exit 1
fi

mkdir -p "$BIN_DIR"
chmod +x "$tmp"
mv "$tmp" "$BIN_DIR/orbit-diff"
trap - EXIT

echo "Installed orbit-diff → $BIN_DIR/orbit-diff"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Note: $BIN_DIR is not on your PATH. Add this to your shell profile:"
     echo "  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
echo "Run 'orbit-diff update' later to upgrade in place."
