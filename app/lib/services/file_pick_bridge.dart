/// Platform bridge for the attach (paperclip) button.
///
/// On web, opens a plain `<input type="file">` — the file_selector plugin's
/// web implementation did not open the picker in practice, and the raw input
/// is the one mechanism that always works. Other platforms return nothing
/// here (chat_screen falls back to file_selector's openFiles).
library;

export 'file_pick_stub.dart' if (dart.library.js_interop) 'file_pick_web.dart';
