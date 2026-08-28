// Silent by default — console writes corrupt the Pi TUI overlay.
// Set RC_DEBUG=1 (legacy: PINEST_DEBUG) to route diagnostics to stderr.
export default function debug(...args: unknown[]): void {
  if (process.env.RC_DEBUG || process.env.PINEST_DEBUG) {
    process.stderr.write(args.map(String).join(" ") + "\n");
  }
}
