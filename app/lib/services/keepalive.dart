import 'dart:async';

import 'control_channel.dart';

/// Keeps one socket visibly alive, and stops when that socket does.
///
/// It exists because a connected but idle link carries no traffic in either
/// direction, and an intermediary in the middle reads that as a dead connection:
/// it closes the link, the client calls it a loss and reconnects, goes idle, and
/// is closed again. The symptom is a client that connects and then says
/// "reconnecting" forever with nothing to send, on a link that was working.
///
/// 20 seconds is well inside the ~100s an intermediary will hold an idle
/// connection. Fast enough that a genuinely dead link is noticed in one interval
/// rather than in a minute, slow enough that the ping traffic is nothing.
const Duration keepAliveInterval = Duration(seconds: 20);

/// A timer bound to ONE channel, not to the service.
///
/// That binding is the whole point. A timer that outlived a replaced channel
/// would ping a socket nobody is reading, which is exactly the silence this
/// exists to prevent, and it would do it forever.
class KeepAlive {
  Timer? _timer;

  void start(ControlChannel channel, {bool Function()? stillCurrent}) {
    stop();
    _timer = Timer.periodic(keepAliveInterval, (_) {
      if (stillCurrent != null && !stillCurrent()) {
        stop();
        return;
      }
      try {
        channel.send(commandFrame({'type': 'ping'}));
      } catch (_) {
        // A ping that cannot be written is a socket that is already gone. The
        // channel's own error path reports the real reason, so there is nothing
        // to add here — and nothing to retry, because retrying into a dead
        // socket is the spin this avoids.
      }
    });
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
  }

  bool get running => _timer != null;
}
