import 'picked_file.dart';

/// Non-web platforms: browsing uses the file_selector plugin directly (see
/// chat_screen.dart) and clipboard images come through normal paste.
Future<List<PickedFile>> pickUserFiles() async => const [];
Future<List<PickedFile>> readClipboardImages() async => const [];
