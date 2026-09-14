/// Writing the app's own diagnosis, and obeying the machine's one request.
///
/// Two jobs, one owner, because both ride the same discovery document:
///
///  * tell the machine what THIS browser sees - whether it believes it is
///    connected, by which path, which channels it opened, which candidate pair
///    its own peer connection chose, and what last went wrong;
///  * reload when the machine asks, which is the only way a stale tab can be
///    fixed without a human.
///
/// Both are throttled and bounded. A report is written at most once per couple
/// of seconds and always on a change of outcome, because a diagnostic that
/// floods the document is a diagnostic that breaks the thing it measures; and a
/// reload request is honoured exactly once per distinct value, because a request
/// that survives a reload would reload forever.
library;

class ClientReporter {
  ClientReporter({
    required Future<void> Function(Map<String, dynamic> payload) write,
    required void Function() reload,
    required int loadedAtMs,
    DateTime Function()? now,
    Duration minInterval = const Duration(seconds: 30),
    Duration minGap = const Duration(seconds: 5),
  })  : _write = write,
        _reload = reload,
        _loadedAtMs = loadedAtMs,
        _now = now ?? DateTime.now,
        _minInterval = minInterval,
        _minGap = minGap;

  final Future<void> Function(Map<String, dynamic> payload) _write;
  final void Function() _reload;

  /// When this page was loaded, by this browser's clock. A reload request older
  /// than the page itself has already had its effect: honouring it again is how
  /// a request that outlives a reload becomes an endless reload loop, with no
  /// storage and no bookkeeping to get wrong.
  final int _loadedAtMs;
  final DateTime Function() _now;
  final Duration _minInterval;
  final Duration _minGap;

  /// The last payload actually written, and when, so a repeated state is not
  /// re-sent and a burst of transitions collapses to the newest one. The
  /// document is metered, so this is a cost decision as much as a noise one.
  Map<String, dynamic>? _last;
  DateTime? _lastAt;
  String? _lastFailure;
  int? _reloadRequest;

  /// Whether a report has ever been written: a status line can then say "this
  /// browser has never reported" rather than showing an empty one.
  bool get hasReported => _last != null;

  /// The last thing that stopped a report from being written, if anything.
  String? get lastFailure => _lastFailure;

  /// Offer a payload. Written immediately when its outcome changed, otherwise
  /// at most once per interval: the machine needs the CHANGE, not the traffic.
  Future<void> report(Map<String, dynamic> payload) async {
    final same = _sameOutcome(_last, payload);
    final now = _now();
    final since = _lastAt == null ? null : now.difference(_lastAt!);
    // Two limits, because this document is METERED and every write also costs
    // a read in the machine's poll: a hard floor of a few seconds between any
    // two reports, and a heartbeat `minInterval` for a state that has not
    // changed at all. Measured: an unthrottled report every couple of seconds
    // exhausts a daily Firestore allowance on its own.
    if (since != null && since < _minGap) {
      return;
    }
    if (same && since != null && since < _minInterval) {
      return;
    }
    _last = Map<String, dynamic>.from(payload);
    _lastAt = now;
    try {
      await _write(payload);
      _lastFailure = null;
    } catch (e) {
      // The report is a diagnostic; failing to send one must never take the app
      // down or be silently mistaken for a successful report. It is recorded so
      // the Settings screen can say the diagnosis itself is not working.
      _lastFailure = '$e';
    }
  }

  /// Honour a reload request from the machine.
  ///
  /// Exactly once per request: it must be newer than this page (a request older
  /// than the page has already been obeyed) and newer than any request already
  /// obeyed here. Those two conditions are the whole loop guard - "a reload is
  /// in flight" is not one, because a request the machine made and the app
  /// silently dropped is exactly the failure this is meant to remove.
  void offerReload(Object? requestTs) {
    final ts = requestTs is num ? requestTs.toInt() : null;
    if (ts == null || ts <= _loadedAtMs) {
      return;
    }
    if (_reloadRequest != null && ts <= _reloadRequest!) {
      return;
    }
    _reloadRequest = ts;
    _reload();
  }

  /// The newest reload request obeyed, or null when none has been.
  int? get honouredReload => _reloadRequest;

  static bool _sameOutcome(Map<String, dynamic>? a, Map<String, dynamic> b) {
    if (a == null) {
      return false;
    }
    return a['connected'] == b['connected']
        && a['path'] == b['path']
        && a['lastError'] == b['lastError']
        && a['note'] == b['note']
        && (a['direct'] as Map?)?['active'] == (b['direct'] as Map?)?['active']
        && (a['direct'] as Map?)?['ice'] == (b['direct'] as Map?)?['ice']
        && (a['bundle'] ?? '') == (b['bundle'] ?? '');
  }
}
