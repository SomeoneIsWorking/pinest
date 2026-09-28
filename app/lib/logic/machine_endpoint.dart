/// Where this app's machine is, in Realtime Database rather than Firestore.
///
/// Firestore meters reads and writes on separate counters, and this project ran
/// out of writes while reads still worked: the machine could not publish itself,
/// so the document went stale for an hour while the machine ran perfectly. A
/// host that cannot announce itself is a host nobody can find.
///
/// Realtime Database is a different product on a different budget, this project
/// already has it, and the same Google account already signs into it — so moving
/// the lookup costs nothing to set up and no domain.
///
/// The record is small and read once per change, not watched continuously: a
/// client polls politely and stops as soon as it has an endpoint it can dial.
/// That matters because this is a metered service too, and the point of moving
/// is to stop paying, not to start paying somewhere else.
library;

import 'dart:convert';

import 'package:http/http.dart' as http;

/// Freshness: a record older than this is a machine that stopped saying so.
const Duration endpointFreshness = Duration(seconds: 90);

/// The project's Realtime Database, derived from the project id the app already
/// has. Every project gets the region-less host.
String realtimeDatabaseUrl(String projectId) =>
    'https://$projectId-default-rtdb.firebaseio.com';

/// Where one machine's record lives. Matches endpoint-registry.ts on the host.
String endpointPath(String uid) => 'users/$uid';

/// What a host published about itself.
class MachineEndpoint {
  const MachineEndpoint({
    required this.url,
    required this.online,
    required this.hostname,
    required this.publishedAt,
  });

  /// Null when the host has no tunnel right now; it may still be reachable
  /// directly, which is a different path with a different failure mode.
  final Uri? url;
  final bool online;
  final String hostname;
  final DateTime publishedAt;

  /// Whether this record is recent enough to believe. An old one is not a
  /// machine that is down — it is a machine that stopped saying, which is
  /// indistinguishable from one that cannot be found.
  bool get fresh =>
      DateTime.now().difference(publishedAt).abs() < endpointFreshness;
}

/// Read one machine's record, or null when it has never published.
///
/// [idToken] is this app's own Google ID token. The database rules check
/// `auth.uid` against the path, so a token that is not the owner's is refused —
/// the same identity the socket already uses, for the same reason.
Future<MachineEndpoint?> readMachineEndpoint({
  required String baseUrl,
  required String uid,
  required String idToken,
  http.Client? client,
}) async {
  final url = Uri.parse(
    '$baseUrl/${endpointPath(uid)}.json',
  );
  final response = await (client ?? http.Client()).get(
    url,
    headers: {'Authorization': 'Bearer $idToken'},
  );
  // 401 is the rules refusing this token. It is an answer, not a failure to
  // reach the database, and saying so keeps "signed in as the wrong person"
  // distinct from "the service is unreachable".
  if (response.statusCode == 401 || response.statusCode == 403) {
    throw EndpointReadException('this account may not read that machine: HTTP ${response.statusCode}');
  }
  if (response.statusCode == 404) return null;
  if (response.statusCode != 200) {
    throw EndpointReadException('the machine list could not be read: HTTP ${response.statusCode}');
  }
  final body = jsonDecode(response.body);
  if (body is! Map<String, dynamic>) return null;
  final rawUrl = body['url'];
  final publishedAt = body['ts'];
  return MachineEndpoint(
    // Only an https URL is dialled: the Google token goes to whatever host is
    // dialled, so anything else is refused rather than tried.
    url: rawUrl is String ? Uri.tryParse(rawUrl) : null,
    online: body['online'] == true,
    hostname: body['hostname'] is String ? body['hostname'] as String : '',
    publishedAt: publishedAt is num
        ? DateTime.fromMillisecondsSinceEpoch(publishedAt.toInt())
        : DateTime.fromMillisecondsSinceEpoch(0),
  );
}

/// Why a lookup failed, in words a person can act on.
class EndpointReadException implements Exception {
  const EndpointReadException(this.message);
  final String message;
  @override
  String toString() => message;
}

/// What to do about a record that was looked up.
sealed class EndpointDecision {
  const EndpointDecision();
}

/// Nothing was published anywhere this app can see.
class NoEndpointPublished extends EndpointDecision {
  const NoEndpointPublished();
}

/// A machine is here and can be dialled.
class EndpointDialable extends EndpointDecision {
  const EndpointDialable(this.endpoint, this.secureUrl);
  final MachineEndpoint endpoint;
  final Uri secureUrl;
}

/// Decide from one record, with no side effects.
///
/// Split out because "what does this mean" is a judgement worth testing on its
/// own, and because it keeps the service from being the only place that knows
/// what a stale or unaddressable record means.
EndpointDecision decideEndpoint(
  MachineEndpoint? endpoint, {
  required int nowMs,
  Uri? Function(Object? url)? parseUrl,
}) {
  if (endpoint == null || !endpoint.fresh) return const NoEndpointPublished();
  final url = endpoint.url;
  if (url == null) return const NoEndpointPublished();
  // Reuses the same rule discovery applies, so a record found here cannot get
  // dialed by a laxer check than a published document would.
  final secure = parseUrl?.call(url.toString());
  if (secure == null) return const NoEndpointPublished();
  return EndpointDialable(endpoint, secure);
}
