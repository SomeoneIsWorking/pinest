// Silent by default — console writes corrupt the Pi TUI overlay.
// Set RC_DEBUG=1 to route diagnostics to stderr.
export default function debug(...args: unknown[]): void {
  if (process.env.RC_DEBUG) {
    process.stderr.write(args.map(String).join(" ") + "\n");
  }
}
