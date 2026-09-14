/// A one-shot, user-facing message from the server (e.g. notices, notifications, or errors).
library;

/// What a notice is ABOUT, when the client's own notification policy depends on
/// it. A background-task completion is announced by its own notice, so the turn
/// it starts must not also be announced as the session "finishing work".
enum NoticeKind { plain, backgroundTask }

class ServerNotice {
  final String message;
  final bool isError;
  final String? sessionId;
  final NoticeKind kind;

  const ServerNotice(
    this.message, {
    this.isError = false,
    this.sessionId,
    this.kind = NoticeKind.plain,
  });
}
