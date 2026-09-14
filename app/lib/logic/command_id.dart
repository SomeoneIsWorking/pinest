/// Command ids: the identity a command carries so its answer can name it.
///
/// A refusal used to be attributed to a SESSION — every message that session had
/// pending was marked "not delivered" — so an unrelated session-level error (a
/// compaction failure, a tool failure) told the user their message had been
/// refused. A command that can be refused therefore travels with an id, and the
/// refusal names that id.
library;

int _counter = 0;

/// A unique id for one command, unique within this client.
///
/// Survives a page reload because it is stored with the send, not derived from
/// the connection: the same message refused after a reload is still the same
/// message.
String nextCommandId() {
  final id =
      '${DateTime.now().microsecondsSinceEpoch}-${_counter.toRadixString(36)}';
  _counter++;
  return id;
}
