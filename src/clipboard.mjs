// Copy text to the *local* system clipboard via OSC 52.
//
// OSC 52 (`ESC ] 52 ; c ; <base64> BEL`) asks the terminal emulator itself to
// set the clipboard. Because it's just bytes in the terminal stream, it rides an
// SSH connection back to the machine your terminal actually runs on — unlike
// pbcopy/xclip, which would only touch the remote host's clipboard. That makes
// it the one mechanism that works from a tmux session over SSH.
//
// Caveats the caller should plan around:
//   - tmux swallows OSC 52 unless it's wrapped in its DCS passthrough form and
//     `set -g set-clipboard on` is configured. We do the wrapping here.
//   - Some terminals (notably macOS Terminal.app) ignore OSC 52 entirely, and
//     there is no reply, so we can't confirm success. Callers should pair this
//     with a visible fallback (e.g. writing the text to a file).

import { spawnSync } from "node:child_process";

// Many terminals cap the OSC 52 payload (xterm's default is ~74994 bytes of
// base64). Past that the sequence is silently dropped, so we surface it instead
// of emitting a truncated clipboard.
const MAX_B64 = 74994;

// Build the escape sequence for `text`, wrapped for the current multiplexer.
// Exported for testing without writing to a real terminal.
export function osc52(text, env = process.env) {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  if (b64.length > MAX_B64) {
    throw new Error(`too large for OSC 52 clipboard (${b64.length} > ${MAX_B64} bytes)`);
  }
  const inner = `\x1b]52;c;${b64}\x07`;
  if (env.TMUX) {
    // tmux passthrough: wrap in `ESC Ptmux; … ESC \`, doubling every ESC inside.
    return `\x1bPtmux;${inner.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
  }
  if ((env.TERM || "").startsWith("screen")) {
    // GNU screen passthrough. screen also caps DCS strings; long payloads may
    // need chunking, but change requests comfortably fit.
    return `\x1bP${inner}\x1b\\`;
  }
  return inner;
}

// Emit the sequence to the terminal. Writes straight to the underlying stdout
// (not Ink's render proxy): OSC 52 prints nothing and moves no cursor, so it
// interleaves harmlessly with frames. Returns true if the bytes were written,
// which is NOT a guarantee the terminal honored them — see the file fallback.
export function copyViaOSC52(text, out = process.stdout) {
  out.write(osc52(text));
  return true;
}

// Best-effort copy to the *host* clipboard using whatever native tool exists
// (pbcopy on macOS, wl-copy/xclip/xsel on Linux). This covers the local case
// where the terminal ignores OSC 52 (notably macOS Terminal.app). It's a no-op
// over SSH (the tool would touch the remote clipboard), so callers should still
// emit OSC 52 as the primary path — this is the belt to that suspenders.
export function copyNative(text) {
  if (process.env.SSH_TTY || process.env.SSH_CONNECTION) return false;
  const candidates =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : [["wl-copy", []], ["xclip", ["-selection", "clipboard"]], ["xsel", ["-ib"]]];
  for (const [cmd, args] of candidates) {
    try {
      const r = spawnSync(cmd, args, { input: text });
      if (!r.error && r.status === 0) return true;
    } catch {
      // try the next tool
    }
  }
  return false;
}

// Copy `text` everywhere we can: OSC 52 (works over SSH/tmux) plus a best-effort
// native copy (works locally when the terminal ignores OSC 52). Returns null on
// success or an Error if OSC 52 couldn't be emitted (e.g. payload too large).
export function copyEverywhere(text, out = process.stdout) {
  copyNative(text);
  try {
    copyViaOSC52(text, out);
    return null;
  } catch (err) {
    return err;
  }
}
