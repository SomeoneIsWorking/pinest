/// Merging a server history page into the pages already loaded.
///
/// The server sends a page and a mode, and the client has to end up with one
/// transcript: a replace-page preserves a previously fetched prefix, an
/// `older` page prepends, and a reset (compact or clear) throws the prefix away
/// because the transcript genuinely changed. Overlap is detected by content, so
/// a page that re-sends the tail of what is already loaded does not duplicate
/// it.
library;

bool itemsMatch(Map<String, dynamic> a, Map<String, dynamic> b) {
  if (a['role'] != b['role']) {
    return false;
  }
  if (a['text'] != b['text']) {
    return false;
  }
  final aTools = a['tools'] as List?;
  final bTools = b['tools'] as List?;
  if ((aTools?.length ?? 0) != (bTools?.length ?? 0)) {
    return false;
  }
  if (aTools != null && bTools != null && aTools.isNotEmpty) {
    final at0 = aTools[0] as Map?;
    final bt0 = bTools[0] as Map?;
    if (at0?['id'] != bt0?['id']) {
      return false;
    }
    if (at0?['name'] != bt0?['name']) {
      return false;
    }
  }
  return true;
}

List<Map<String, dynamic>> mergeHistoryPage({
  required List<Map<String, dynamic>> existing,
  required List<dynamic> page,
  required String mode,
  required int cursor,
  required bool reset,
}) {
  final decoded = page
      .map((item) => Map<String, dynamic>.from(item as Map))
      .toList();
  if (reset || existing.isEmpty) {
    return decoded;
  }
  if (decoded.isEmpty) {
    return existing;
  }

  if (mode == 'older') {
    // Overlap is where the suffix of decoded meets the prefix of existing.
    for (var i = 0; i < decoded.length; i++) {
      final overlapLen = decoded.length - i;
      if (overlapLen > existing.length) {
        continue;
      }
      var match = true;
      for (var j = 0; j < overlapLen; j++) {
        if (!itemsMatch(decoded[i + j], existing[j])) {
          match = false;
          break;
        }
      }
      if (match) {
        return [...decoded.take(i), ...existing];
      }
    }
    return [...decoded, ...existing];
  }

  // mode == 'replace': overlap is where the suffix of existing meets the
  // prefix of decoded.
  for (var i = 0; i < existing.length; i++) {
    final overlapLen = existing.length - i;
    if (overlapLen > decoded.length) {
      continue;
    }
    var match = true;
    for (var j = 0; j < overlapLen; j++) {
      if (!itemsMatch(existing[i + j], decoded[j])) {
        match = false;
        break;
      }
    }
    if (match) {
      return [...existing.take(i), ...decoded];
    }
  }

  if (cursor > 0 && cursor <= existing.length) {
    return [...existing.take(cursor), ...decoded];
  }
  return decoded;
}
