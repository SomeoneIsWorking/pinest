/// Non-web fallback: in-app notifications/toasts handle alerts.
bool isPlatformNotificationSupported() => false;

Future<bool> isNotificationPermissionGranted() async => false;

Future<bool> requestNotificationPermission() async => false;

void showPlatformNotification({
  required String title,
  required String body,
  bool isError = false,
  VoidCallback? onClick,
}) {}

typedef VoidCallback = void Function();
