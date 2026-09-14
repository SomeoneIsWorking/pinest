/// The machine's own direct-transport state, as it reports it.
///
/// The app already knows whether ITS channel is direct; this is the other half,
/// and it is the half that explains a failure. Measured: the app answered an
/// offer the machine had published 941 seconds earlier, whose carrier-grade NAT
/// mapping had long expired, so the punch failed and fell back to the tunnel
/// with nothing said. From outside, "the machine is offering, but nobody is
/// connected through it" and "the machine is not offering at all" are different
/// problems, and neither is diagnosable without this.
class DirectStatus {
  const DirectStatus({
    required this.offering,
    required this.offerAge,
    required this.channelOpen,
    required this.exchanges,
    required this.channelCloses,
    required this.lastError,
    this.bridges = 0,
    this.framesToServer = 0,
    this.framesToClient = 0,
    this.bridgeSocket,
  });

  /// Whether the machine has an offer published right now.
  final bool offering;

  /// How old that offer is: a perishable NAT mapping, so age matters.
  final Duration? offerAge;

  /// Whether a peer is connected through it (possibly another device).
  final bool channelOpen;

  /// How many exchanges the machine has published since it started.
  final int exchanges;

  /// Channels that opened and then closed: a punch that landed and was lost
  /// reads differently from one that never landed at all.
  final int channelCloses;

  /// The last thing that went wrong on the machine's side, verbatim.
  final String? lastError;

  /// Bridges the machine built: a channel that opens and produces no bridge is
  /// a different failure from a bridge that carries nothing.
  final int bridges;

  /// Whole messages the machine's bridge relayed, by direction. The difference
  /// between "the app sent nothing" and "the machine never got it".
  final int framesToServer;
  final int framesToClient;

  /// The loopback socket the bridge is carrying traffic over, by state name.
  final String? bridgeSocket;

  static DirectStatus? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final offerTs = (raw['offerTs'] as num?)?.toInt();
    final ageMs = (raw['offerAgeMs'] as num?)?.toInt();
    return DirectStatus(
      offering: offerTs != null,
      offerAge: ageMs == null ? null : Duration(milliseconds: ageMs),
      channelOpen: raw['channelOpen'] == true,
      exchanges: (raw['exchanges'] as num?)?.toInt() ?? 0,
      channelCloses: (raw['channelCloses'] as num?)?.toInt() ?? 0,
      lastError: (raw['lastError'] as String?)?.trim(),
      bridges: (raw['bridges'] as num?)?.toInt() ?? 0,
      framesToServer: (raw['framesToServer'] as num?)?.toInt() ?? 0,
      framesToClient: (raw['framesToClient'] as num?)?.toInt() ?? 0,
      bridgeSocket: (raw['bridgeSocket'] as String?)?.trim(),
    );
  }

  /// What to show the user about the machine's side of peer-to-peer.
  ///
  /// Every branch says something, including the one where nothing has failed
  /// yet: "no peer connected" and "not offered" must not read the same.
  String describe() {
    if (!offering) {
      return 'Peer to peer is off on the machine.';
    }
    final age = offerAge == null ? '' : ' (offer ${_age()} old)';
    if (channelOpen) {
      return 'A peer is connected directly$age.';
    }
    final error = lastError == null || lastError!.isEmpty ? '' : ' Last error: $lastError';
    final closings = channelCloses == 0
        ? ''
        : ' A channel opened and closed ${channelCloses == 1 ? 'once' : '$channelCloses times'}.';
    // What the machine actually relayed. A peer that connected and sent
    // nothing, and one whose frames never arrived, look identical without it.
    final quiet = channelCloses == 0 && framesToServer == 0 && framesToClient == 0;
    final relayed = quiet
        ? ''
        : ' It relayed $framesToServer frame${framesToServer == 1 ? '' : 's'} in'
            ' and $framesToClient out.';
    return 'Offering a direct connection$age; no peer connected yet.$closings$relayed$error';
  }

  String _age() {
    final seconds = offerAge!.inSeconds;
    if (seconds < 60) return '${seconds}s';
    return '${(seconds / 60).floor()}m';
  }
}
