// Declaration shims for dependencies without bundled types.
declare module "localtunnel" {
  interface Tunnel {
    url: string;
    on(event: string, cb: (err: Error) => void): void;
    close(): void;
  }
  function lt(opts: { port: number }): Promise<Tunnel>;
  export default lt;
}
