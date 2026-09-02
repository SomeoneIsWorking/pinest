/// Data models for the session conversation tree.
library;

class SessionTreeEntry {
  final String id;
  final String? parentId;
  final String type;
  final String? role;
  final String? text;
  final int? timestamp;
  final Map<String, dynamic> raw;

  const SessionTreeEntry({
    required this.id,
    this.parentId,
    required this.type,
    this.role,
    this.text,
    this.timestamp,
    required this.raw,
  });

  factory SessionTreeEntry.fromJson(Map<String, dynamic> json) {
    String? role;
    String? text;
    int? timestamp = json['timestamp'] is int ? json['timestamp'] as int : null;

    final msg = json['message'];
    if (msg is Map<String, dynamic>) {
      role = msg['role'] as String?;
      final content = msg['content'];
      if (content is String) {
        text = content;
      } else if (content is List) {
        final textParts = <String>[];
        for (final part in content) {
          if (part is Map<String, dynamic> && part['type'] == 'text') {
            textParts.add(part['text']?.toString() ?? '');
          }
        }
        text = textParts.join('\n');
      }
    } else if (json['type'] == 'custom_message') {
      role = 'custom';
      text = json['content']?.toString() ?? json['text']?.toString();
    } else if (json['type'] == 'label') {
      text = 'Label: ${json['label']}';
    } else if (json['type'] == 'session_info') {
      text = 'Session: ${json['name'] ?? ''}';
    }

    return SessionTreeEntry(
      id: json['id']?.toString() ?? '',
      parentId: json['parentId']?.toString(),
      type: json['type']?.toString() ?? 'message',
      role: role,
      text: text,
      timestamp: timestamp,
      raw: json,
    );
  }
}

class SessionTreeNode {
  final SessionTreeEntry entry;
  final List<SessionTreeNode> children;
  final String? label;
  final String? labelTimestamp;

  const SessionTreeNode({
    required this.entry,
    required this.children,
    this.label,
    this.labelTimestamp,
  });

  factory SessionTreeNode.fromJson(Map<String, dynamic> json) {
    final entryJson = json['entry'] is Map<String, dynamic>
        ? json['entry'] as Map<String, dynamic>
        : json;
    final rawChildren = json['children'] as List? ?? const [];
    final children = rawChildren
        .whereType<Map<String, dynamic>>()
        .map(SessionTreeNode.fromJson)
        .toList();

    return SessionTreeNode(
      entry: SessionTreeEntry.fromJson(entryJson),
      children: children,
      label: json['label'] as String?,
      labelTimestamp: json['labelTimestamp'] as String?,
    );
  }

  /// Flattens the tree into a depth-first list of nodes with their hierarchy depths.
  List<FlatTreeNode> flatten({int depth = 0, Set<String>? activePath}) {
    final list = <FlatTreeNode>[];
    final isInPath = activePath?.contains(entry.id) ?? false;
    list.add(FlatTreeNode(node: this, depth: depth, inActivePath: isInPath));
    for (final child in children) {
      list.addAll(child.flatten(depth: depth + 1, activePath: activePath));
    }
    return list;
  }
}

class FlatTreeNode {
  final SessionTreeNode node;
  final int depth;
  final bool inActivePath;

  const FlatTreeNode({
    required this.node,
    required this.depth,
    required this.inActivePath,
  });
}
