import { loadConfig } from "./config.ts";
import debug from "./log.ts";

export interface FooterStateProvider {
  getOwnerEmail: () => string | null | undefined;
  getLiveSessionCount: () => { live: number; working: number };
  getTunnelUrl: () => string | null;
  isTunnelStarting: () => boolean;
}

const PINEST_ORIGINAL_SET_STATUS = Symbol.for("pinest.ui.original-set-status");

export class FooterManager {
  private timer: NodeJS.Timeout | null = null;
  private ui: any = null;
  private disposed = false;
  private readonly state: FooterStateProvider;

  constructor(state: FooterStateProvider) {
    this.state = state;
  }

  setUi(ui: unknown): void {
    if (!ui || typeof (ui as any).setStatus !== "function") return;
    this.ui = ui;
    this.wrapUi(ui);
  }

  /**
   * Wrap ui.setStatus so that any direct call with a "pinest:" key made by an
   * orphaned/stale module closure (such as a leaked timer from a pre-reload instance)
   * is dropped. Live instances publish status through setStatus() which uses the
   * saved original method directly.
   */
  private wrapUi(ui: any): void {
    if (!ui[PINEST_ORIGINAL_SET_STATUS]) {
      const original = ui.setStatus.bind(ui);
      ui[PINEST_ORIGINAL_SET_STATUS] = original;
      ui.setStatus = (key: string, text: string | undefined): void => {
        if (typeof key === "string" && key.startsWith("pinest:")) {
          debug("[pinest] dropped status update from stale caller:", key, text);
          return;
        }
        return original(key, text);
      };
    }
  }

  private setStatus(key: string, text: string | undefined): void {
    if (this.disposed || !this.ui) return;
    const original = this.ui[PINEST_ORIGINAL_SET_STATUS] ?? this.ui.setStatus?.bind(this.ui);
    try {
      original?.(key, text);
    } catch {
      /* footer is best-effort */
    }
  }

  render(): void {
    if (this.disposed || !this.ui) return;
    try {
      const email = this.state.getOwnerEmail();
      this.setStatus("pinest:owner", email ? `🟣 ${email}` : undefined);

      const { live, working } = this.state.getLiveSessionCount();
      this.setStatus(
        "pinest:sessions",
        live ? `📡 ${live} session${live === 1 ? "" : "s"}${working ? ` · ⚡${working} working` : ""}` : undefined,
      );

      const prov = loadConfig().tunnelProvider;
      const tunnelUrl = this.state.getTunnelUrl();
      const starting = this.state.isTunnelStarting();
      const url = tunnelUrl ?? (prov === "off" ? "off (local-only)" : starting ? "(starting…)" : "(local-only)");
      this.setStatus("pinest:url", `${prov}: ${url}`);
    } catch {
      /* footer is best-effort */
    }
  }

  startTimer(intervalMs = 3000): void {
    if (this.disposed) return;
    this.stopTimer();
    this.timer = setInterval(() => this.render(), intervalMs);
    this.timer.unref?.();
    this.render();
  }

  stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setOffline(reason: string): void {
    if (this.disposed) return;
    this.setStatus("pinest:url", `offline — ${reason}`);
  }

  dispose(clearStatus = false): void {
    this.stopTimer();
    if (clearStatus) {
      this.setStatus("pinest:owner", undefined);
      this.setStatus("pinest:sessions", undefined);
      this.setStatus("pinest:url", undefined);
    }
    this.disposed = true;
    this.ui = null;
  }
}
