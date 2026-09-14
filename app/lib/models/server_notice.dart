/// A one-shot, user-facing message from the server (e.g. notices, notifications, or errors).
library;

class ServerNotice {
  final String message;
  final bool isError;
  final String? sessionId;

  const ServerNotice(
    this.message, {
    this.isError = false,
    this.sessionId,
  });
}
