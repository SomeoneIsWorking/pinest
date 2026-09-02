import 'package:url_launcher/url_launcher.dart';

/// Opens an external URL in the platform browser / handler.
void openExternalUrl(String url) {
  final uri = Uri.tryParse(url);
  if (uri != null) {
    launchUrl(uri, mode: LaunchMode.externalApplication);
  }
}
