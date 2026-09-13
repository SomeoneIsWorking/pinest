/// Parses a token-count written compactly: "300k", "1.5m", "400000".
/// Returns null when the text is not a valid token count.
int? parseTokenCount(String input) {
  final match = RegExp(r'^(\d+(?:\.\d+)?)([km])?$').firstMatch(input.trim().toLowerCase());
  if (match == null) return null;
  final n = double.tryParse(match.group(1)!);
  if (n == null || n < 0) return null;
  final unit = match.group(2);
  final value = unit == 'k' ? n * 1000 : unit == 'm' ? n * 1_000_000 : n;
  return value.round();
}

/// Renders a token count compactly: 300000 → "300k", 4200 → "4200".
String formatTokenCount(int tokens) {
  if (tokens >= 1000 && tokens % 1000 == 0) return '${tokens ~/ 1000}k';
  return '$tokens';
}
