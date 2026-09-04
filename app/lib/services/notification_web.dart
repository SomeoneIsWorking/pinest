// Web-only, imported via conditional import from notification_bridge.dart.
// ignore_for_file: avoid_web_libraries_in_flutter, deprecated_member_use
import 'dart:html' as html;
import 'package:flutter/foundation.dart';

bool isPlatformNotificationSupported() => html.Notification.supported;

Future<bool> isNotificationPermissionGranted() async {
  if (!html.Notification.supported) return false;
  return html.Notification.permission == 'granted';
}

Future<bool> requestNotificationPermission() async {
  if (!html.Notification.supported) return false;
  if (html.Notification.permission == 'granted') return true;
  if (html.Notification.permission == 'denied') return false;
  try {
    final result = await html.Notification.requestPermission();
    return result == 'granted';
  } catch (_) {
    return false;
  }
}

void showPlatformNotification({
  required String title,
  required String body,
  bool isError = false,
  VoidCallback? onClick,
}) {
  if (!html.Notification.supported) return;
  if (html.Notification.permission != 'granted') return;
  try {
    final notification = html.Notification(
      title,
      body: body,
      icon: isError ? '/favicon.png' : '/icons/Icon-192.png',
    );
    if (onClick != null) {
      notification.onClick.listen((_) {
        onClick();
        notification.close();
      });
    }
  } catch (_) {}
}
