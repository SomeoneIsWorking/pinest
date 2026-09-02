import 'dart:async';
import 'package:flutter/material.dart';

/// Shows a non-blocking toast at the top of the screen.
///
/// Unlike standard SnackBars which render at the bottom and cover the chat input
/// box / keyboard, [showAppToast] renders at the top center of the viewport
/// so the user can continue typing and interacting with the input field.
void showAppToast(
  BuildContext context,
  String message, {
  Duration duration = const Duration(seconds: 3),
  bool isError = false,
  IconData? icon,
}) {
  final overlay = Overlay.maybeOf(context);
  if (overlay == null) return;

  late OverlayEntry entry;
  entry = OverlayEntry(
    builder: (ctx) => _ToastPill(
      message: message,
      isError: isError,
      icon: icon,
      duration: duration,
      onDismiss: () {
        if (entry.mounted) {
          entry.remove();
        }
      },
    ),
  );

  overlay.insert(entry);
}

class _ToastPill extends StatefulWidget {
  final String message;
  final bool isError;
  final IconData? icon;
  final Duration duration;
  final VoidCallback onDismiss;

  const _ToastPill({
    required this.message,
    required this.isError,
    this.icon,
    required this.duration,
    required this.onDismiss,
  });

  @override
  State<_ToastPill> createState() => _ToastPillState();
}

class _ToastPillState extends State<_ToastPill>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late final Animation<double> _fadeAnimation;
  late final Animation<Offset> _slideAnimation;
  Timer? _dismissTimer;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 200),
    );
    _fadeAnimation = CurvedAnimation(
      parent: _controller,
      curve: Curves.easeOut,
    );
    _slideAnimation = Tween<Offset>(
      begin: const Offset(0, -0.4),
      end: Offset.zero,
    ).animate(CurvedAnimation(parent: _controller, curve: Curves.easeOutCubic));

    _controller.forward();

    _dismissTimer = Timer(widget.duration, _hide);
  }

  void _hide() {
    if (!mounted) return;
    _controller.reverse().then((_) {
      if (mounted) {
        widget.onDismiss();
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
    final accentColor = widget.isError
        ? theme.colorScheme.error
        : theme.colorScheme.primary;
    final defaultIcon = widget.isError
        ? Icons.error_outline
        : Icons.info_outline;

    return SafeArea(
      child: Align(
        alignment: Alignment.topCenter,
        child: Padding(
          padding: const EdgeInsets.only(top: 16, left: 24, right: 24),
          child: FadeTransition(
            opacity: _fadeAnimation,
            child: SlideTransition(
              position: _slideAnimation,
              child: Material(
                color: Colors.transparent,
                child: GestureDetector(
                  onTap: _hide,
                  child: Container(
                    constraints: const BoxConstraints(maxWidth: 480),
                    padding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 12,
                    ),
                    decoration: BoxDecoration(
                      color: const Color(0xFF1E1F2E),
                      borderRadius: BorderRadius.circular(16),
                      border: Border.all(
                        color: widget.isError
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
                        Icon(
                          widget.icon ?? defaultIcon,
                          size: 18,
                          color: accentColor,
                        ),
                        const SizedBox(width: 10),
                        Flexible(
                          child: Text(
                            widget.message,
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
          ),
        ),
      ),
    );
  }
}
