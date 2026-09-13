/// Human sizes for the image cap, and the parser the settings field uses.
///
/// The cap is a byte count, so the field accepts "1MB", "768kb" or "1048576"
/// and shows a canonical form back.
library;

const int _kib = 1024;
const int _mib = 1024 * 1024;

/// Parse a size the user typed. Returns null when it is not a size.
int? parseByteSize(String raw) {
  final text = raw.trim().toLowerCase().replaceAll(' ', '');
  if (text.isEmpty) return null;
  final match = RegExp(r'^([0-9]+(?:\.[0-9]+)?)(b|kb|k|mb|m)?$').firstMatch(text);
  if (match == null) return null;
  final value = double.tryParse(match.group(1)!);
  if (value == null) return null;
  final unit = match.group(2) ?? 'b';
  final multiplier = switch (unit) {
    'kb' || 'k' => _kib,
    'mb' || 'm' => _mib,
    _ => 1,
  };
  final bytes = (value * multiplier).round();
  return bytes > 0 ? bytes : null;
}

/// Canonical display: MiB when the size is a whole-ish number of them.
String formatByteSize(int bytes) {
  if (bytes >= _mib) {
    final mib = bytes / _mib;
    final text = mib >= 10 || mib == mib.roundToDouble()
        ? mib.round().toString()
        : mib.toStringAsFixed(1);
    return '${text}MB';
  }
  if (bytes >= _kib) return '${(bytes / _kib).round()}KB';
  return '${bytes}B';
}
