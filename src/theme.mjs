// Derive the "current line" and "selection" band colors from the *actual*
// terminal background, so the highlight is a subtle off-shade of whatever theme
// you run — light or dark — instead of a hardcoded dark block.
//
// We ask the terminal for its background with an OSC 11 query and nudge the
// answer a few shades toward the foreground (lighten a dark bg, darken a light
// one). Many terminals don't answer (some multiplexers included), so everything
// degrades to dark-tuned defaults on a timeout.

// Dark-tuned fallback used when the terminal won't report its background.
export const FALLBACK = {
  activeBg: "#2b2f36",
  selectBg: "#23262c",
  addBg: "#12261c",
  delBg: "#2d1618",
};

// Hue anchors we blend the terminal background toward to tint added/removed
// rows. Low alpha keeps the tint subtle and lets it adapt to any theme: on a
// dark bg it reads as a dim green/red wash, on a light bg as a pale one.
const ADD_TINT = { r: 46, g: 160, b: 67 };
const DEL_TINT = { r: 248, g: 81, b: 73 };
const DIFF_ALPHA = 0.22;

export async function detectLineColors(timeoutMs = 200) {
  const bg = await queryBackground(timeoutMs);
  return bg ? deriveColors(bg) : FALLBACK;
}

// Nudge the background toward its contrasting side: a dark bg lifts a little, a
// light bg drops a little. The current line moves more than the selection band.
export function deriveColors({ r, g, b }) {
  const dark = luminance(r, g, b) < 128;
  const dActive = dark ? 16 : -16;
  const dSelect = dark ? 8 : -8;
  return {
    activeBg: hex(nudge(r, dActive), nudge(g, dActive), nudge(b, dActive)),
    selectBg: hex(nudge(r, dSelect), nudge(g, dSelect), nudge(b, dSelect)),
    addBg: mix({ r, g, b }, ADD_TINT, DIFF_ALPHA),
    delBg: mix({ r, g, b }, DEL_TINT, DIFF_ALPHA),
  };
}

// Alpha-blend a base color toward a tint, returning a hex string.
const mix = (base, tint, a) =>
  hex(
    Math.round(base.r * (1 - a) + tint.r * a),
    Math.round(base.g * (1 - a) + tint.g * a),
    Math.round(base.b * (1 - a) + tint.b * a),
  );

// Parse an OSC 11 reply, e.g. `ESC]11;rgb:2e2e/3434/4040 BEL` (or ST-terminated).
// Channels may be any hex width (16-bit `2e2e`, 8-bit `2e`, …); scale to 0-255.
export function parseOsc11(s) {
  const m = /\x1b\]11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)(?:\x07|\x1b\\)/i.exec(s);
  if (!m) return null;
  return { r: scale(m[1]), g: scale(m[2]), b: scale(m[3]) };
}

function scale(hexStr) {
  const max = Math.pow(16, hexStr.length) - 1;
  return Math.round((parseInt(hexStr, 16) / max) * 255);
}

const nudge = (c, d) => Math.max(0, Math.min(255, c + d));
// Rec. 709 relative luminance — good enough to call light vs dark.
const luminance = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const hex = (r, g, b) => "#" + [r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("");

// Write the OSC 11 query and resolve with the parsed background, or null if the
// terminal stays silent past the timeout. Restores stdin so Ink can take over.
function queryBackground(timeoutMs) {
  const { stdin, stdout } = process;
  if (!stdout.isTTY || !stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const wasRaw = stdin.isRaw;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.removeListener("data", onData);
      try {
        stdin.setRawMode(wasRaw);
      } catch {}
      stdin.pause();
      resolve(result);
    };

    const onData = (chunk) => {
      buf += chunk.toString("latin1");
      const rgb = parseOsc11(buf);
      if (rgb) finish(rgb);
    };

    try {
      stdin.setRawMode(true);
    } catch {}
    stdin.resume();
    stdin.on("data", onData);
    stdout.write("\x1b]11;?\x07");
    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}
