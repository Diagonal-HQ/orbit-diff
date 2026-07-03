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
