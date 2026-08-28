enum ChatItemKind { user, assistant, tool, error }

class ChatItem {
  final String id;
  final ChatItemKind kind;
  final String text;
  final String? toolName;
  final String? toolError;
  final bool? toolRunning;
  final int ts;

  const ChatItem({
    required this.id,
    required this.kind,
    required this.text,
    this.toolName,
    this.toolError,
    this.toolRunning,
    required this.ts,
  });
}

class PinestModel {
  final String id;
  final String name;
  final String provider;
  final bool reasoning;
  final bool vision;

  const PinestModel({
    required this.id,
    required this.name,
    required this.provider,
    this.reasoning = false,
    this.vision = false,
  });

  factory PinestModel.fromMap(Map<String, dynamic> m) => PinestModel(
        id: m['id'] ?? '',
        name: m['name'] ?? m['id'] ?? '',
        provider: m['provider'] ?? '',
        reasoning: m['reasoning'] ?? false,
        vision: m['vision'] ?? false,
      );
}
