import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

export class PinestCustomEditor extends CustomEditor {
  private readonly onLeftOnEmpty?: () => void;

  constructor(
    tui: any,
    theme: any,
    keybindings: any,
    onLeftOnEmpty?: () => void,
    options?: any,
  ) {
    super(tui, theme, keybindings, options);
    this.onLeftOnEmpty = onLeftOnEmpty;
  }

  override handleInput(data: string): void {
    // When editor text is empty, pressing Left opens the sessions view (Claude Code style)
    if (matchesKey(data, "left") && (this.getText() || "").length === 0) {
      if (this.onLeftOnEmpty) {
        this.onLeftOnEmpty();
        return;
      }
    }
    super.handleInput(data);
  }
}
