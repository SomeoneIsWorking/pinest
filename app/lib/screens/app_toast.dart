import 'dart:async';

import 'package:flutter/material.dart';

/// How many notices may be on screen at once.
///
/// A burst of completions must not fill the viewport. The OLDEST makes room,
/// because the newest is the one the user has not read yet.
const int kMaxVisibleToasts = 3;

/// One notice currently on screen.
@immutable
class AppToastData {
  const AppToastData({
    required this.id,
    required this.message,
    required this.isError,
    required this.duration,
    this.icon,
    this.generation = 0,
  });

  final int id;
  final String message;
  final bool isError;
  final Duration duration;
  final IconData? icon;

  /// Bumped when the SAME notice is shown again while it is still up. The pill
  /// restarts its own timer instead of a second copy stacking on the first.
  final int generation;

  AppToastData shownAgain() => AppToastData(
    id: id,
    message: message,
    isError: isError,
    duration: duration,
    icon: icon,
    generation: generation + 1,
  );
}

/// Owns the notices currently on screen and the ONE overlay entry that draws
/// them.
///
/// This used to be one overlay entry per notice, each an `Align(topCenter)`
/// pill with identical padding — so two notices at once occupied the same
/// pixels and neither could be read. A single entry owning a column is what
/// makes a second notice appear BELOW the first.
class AppToastController extends ChangeNotifier {
  final List<AppToastData> _toasts = <AppToastData>[];
  OverlayEntry? _entry;
  int _nextId = 1;
  bool _removeScheduled = false;

  List<AppToastData> get toasts => List.unmodifiable(_toasts);

  void show(
    BuildContext context, {
    required String message,
    required Duration duration,
    required bool isError,
    IconData? icon,
  }) {
    final overlay = Overlay.maybeOf(context);
    if (overlay == null) {
      return;
    }
    _attach(overlay);

    final existing = _toasts.indexWhere(
      (t) => t.message == message && t.isError == isError,
    );
    if (existing >= 0) {
      _toasts[existing] = _toasts[existing].shownAgain();
    } else {
      _toasts.add(
        AppToastData(
          id: _nextId++,
          message: message,
          isError: isError,
          duration: duration,
          icon: icon,
        ),
      );
      while (_toasts.length > kMaxVisibleToasts) {
        _toasts.removeAt(0);
      }
    }
    notifyListeners();
  }

  void dismiss(int id) {
    final before = _toasts.length;
    _toasts.removeWhere((t) => t.id == id);
    if (_toasts.length == before) {
      return;
    }
    notifyListeners();
    _removeEntryWhenEmpty();
  }

  /// Drop every notice (used when the connection the notices describe is gone).
  void clear() {
    if (_toasts.isEmpty) {
      return;
    }
    _toasts.clear();
    notifyListeners();
    _removeEntryWhenEmpty();
  }

  void _attach(OverlayState overlay) {
    final entry = _entry;
    if (entry != null && entry.mounted) {
      return;
    }
    final fresh = OverlayEntry(builder: (_) => _ToastStack(controller: this));
    _entry = fresh;
    overlay.insert(fresh);
  }

  /// Drop the overlay entry once nothing is left to draw.
  ///
  /// Removing it inside a build/notification would mutate the overlay's child
  /// list mid-frame, so the removal is deferred by one frame.
  void _removeEntryWhenEmpty() {
    if (_toasts.isNotEmpty || _removeScheduled) {
      return;
    }
    _removeScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _removeScheduled = false;
      if (_toasts.isNotEmpty) {
        return;
      }
      final entry = _entry;
      _entry = null;
      if (entry != null && entry.mounted) {
        entry.remove();
      }
    });
  }

  /// Clear the screen and the overlay entry without waiting for a frame.
  @visibleForTesting
  void resetForTest() {
    _toasts.clear();
    final entry = _entry;
    _entry = null;
    _removeScheduled = false;
    if (entry != null && entry.mounted) {
      entry.remove();
    }
  }
}

/// The one controller behind [showAppToast]. One because there is one screen.
final AppToastController appToasts = AppToastController();

/// Test hook: the live controller, so a test can reset it between cases.
@visibleForTesting
AppToastController debugAppToasts() => appToasts;

/// Shows a non-blocking notice at the top of the screen.
///
/// Unlike standard SnackBars which render at the bottom and cover the chat input
/// box / keyboard, this renders at the top center of the viewport so the user can
/// continue typing and interacting with the input field. Several notices are
/// stacked, newest last, never on top of each other.
void showAppToast(
  BuildContext context,
  String message, {
  Duration duration = const Duration(seconds: 3),
  bool isError = false,
  IconData? icon,
}) {
  appToasts.show(
    context,
    message: message,
    duration: duration,
    isError: isError,
    icon: icon,
  );
}

/// The column of notices, inside the single overlay entry.
class _ToastStack extends StatelessWidget {
  const _ToastStack({required this.controller});

  final AppToastController controller;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: controller,
      builder: (context, _) {
        final toasts = controller.toasts;
        if (toasts.isEmpty) {
          return const SizedBox.shrink();
        }
        return SafeArea(
          child: Align(
            alignment: Alignment.topCenter,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                for (final toast in toasts)
                  Padding(
                    padding: const EdgeInsets.only(top: 8, left: 24, right: 24),
                    child: _ToastPill(
                      key: ValueKey<int>(toast.id),
                      data: toast,
                      onDismissed: () => controller.dismiss(toast.id),
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _ToastPill extends StatefulWidget {
  const _ToastPill({super.key, required this.data, required this.onDismissed});

  final AppToastData data;
  final VoidCallback onDismissed;

  @override
  State<_ToastPill> createState() => _ToastPillState();
}

class _ToastPillState extends State<_ToastPill>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late final Animation<double> _fadeAnimation;
  late final Animation<Offset> _slideAnimation;
  Timer? _dismissTimer;
  bool _leaving = false;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 200),
    );
    _fadeAnimation = CurvedAnimation(parent: _controller, curve: Curves.easeOut);
    _slideAnimation = Tween<Offset>(
      begin: const Offset(0, -0.4),
      end: Offset.zero,
    ).animate(CurvedAnimation(parent: _controller, curve: Curves.easeOutCubic));

    _controller.forward();
    _arm();
  }

  @override
  void didUpdateWidget(_ToastPill oldWidget) {
    super.didUpdateWidget(oldWidget);
    // The same notice arrived again: restart the clock so it is readable for a
    // full duration from the NEWEST arrival.
    if (widget.data.generation != oldWidget.data.generation) {
      _arm();
    }
  }

  void _arm() {
    _dismissTimer?.cancel();
    _dismissTimer = Timer(widget.data.duration, _hide);
  }

  void _hide() {
    if (!mounted || _leaving) {
      return;
    }
    _leaving = true;
    _dismissTimer?.cancel();
    _controller.reverse().then((_) {
      if (mounted) {
        widget.onDismissed();
      }
    });
  }

  @override
  void dispose() {
    _dismissTimer?.cancel();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final data = widget.data;
    final accentColor = data.isError
        ? theme.colorScheme.error
        : theme.colorScheme.primary;
    final defaultIcon = data.isError
        ? Icons.error_outline
        : Icons.info_outline;

    return FadeTransition(
      opacity: _fadeAnimation,
      child: SlideTransition(
        position: _slideAnimation,
        child: Material(
          color: Colors.transparent,
          child: GestureDetector(
            onTap: _hide,
            child: Container(
              constraints: const BoxConstraints(maxWidth: 480),
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
              decoration: BoxDecoration(
                color: const Color(0xFF1E1F2E),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(
                  color: data.isError
                      ? accentColor.withAlpha(160)
                      : Colors.white24,
                  width: 1,
                ),
                boxShadow: const [
                  BoxShadow(
                    color: Colors.black45,
                    blurRadius: 16,
                    offset: Offset(0, 4),
                  ),
                ],
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(data.icon ?? defaultIcon, size: 18, color: accentColor),
                  const SizedBox(width: 10),
                  Flexible(
                    child: Text(
                      data.message,
                      style: theme.textTheme.bodyMedium?.copyWith(
                        color: Colors.white,
                        fontSize: 13,
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
