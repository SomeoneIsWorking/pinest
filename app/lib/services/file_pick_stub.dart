import 'picked_file.dart';

/// Non-web platforms use the file_selector plugin directly (see
/// chat_screen.dart); this bridge is unused there.
Future<List<PickedFile>> pickUserFiles() async => const [];
