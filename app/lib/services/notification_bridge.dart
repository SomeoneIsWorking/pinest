/// Platform bridge for desktop/browser notifications.
library;

export 'notification_stub.dart'
    if (dart.library.js_interop) 'notification_web.dart';
