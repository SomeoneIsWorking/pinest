library;

/// Time formatting utilities for chat message timestamps.

String formatRelativeTime(int timestampMs, {DateTime? now}) {
  final current = now ?? DateTime.now();
  final messageTime = DateTime.fromMillisecondsSinceEpoch(timestampMs);
  final diff = current.difference(messageTime);

  if (diff.isNegative || diff.inSeconds < 45) {
    return 'just now';
  } else if (diff.inMinutes < 60) {
    return '${diff.inMinutes}m ago';
  } else if (diff.inHours < 24) {
    return '${diff.inHours}h ago';
  } else if (diff.inDays == 1) {
    return 'yesterday';
  } else if (diff.inDays < 7) {
    return '${diff.inDays}d ago';
  } else {
    const monthNames = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    final m = monthNames[messageTime.month - 1];
    if (messageTime.year == current.year) {
      return '$m ${messageTime.day}';
    } else {
      return '$m ${messageTime.day}, ${messageTime.year}';
    }
  }
}

String formatExactTime(int timestampMs) {
  final dt = DateTime.fromMillisecondsSinceEpoch(timestampMs).toLocal();
  String pad(int n) => n.toString().padLeft(2, '0');
  return '${dt.year}-${pad(dt.month)}-${pad(dt.day)} ${pad(dt.hour)}:${pad(dt.minute)}:${pad(dt.second)}';
}
