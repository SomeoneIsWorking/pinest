import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../logic/image_cache.dart';
import '../services/agent_service.dart';

/// An image from a tool result or a user message.
///
/// Live results carry their bytes inline (a one-off payload). History carries a
/// REFERENCE — id, mime type, size — because history is re-sent on every push
/// and after every reload, and eight 4K screenshots measured 19.36 MB of a
/// 19.7 MB transcript. A referenced image is fetched only when the user asks
/// for it, then cached.
class LazyImageTile extends StatelessWidget {
  const LazyImageTile({
    super.key,
    required this.image,
    this.width = 96,
    this.height = 96,
    this.fit = BoxFit.cover,
    this.tooltip = 'Tap to view full size',
  });

  final Map<String, dynamic> image;
  final double width;
  final double height;
  final BoxFit fit;
  final String tooltip;

  String get _id => (image['id'] as String?) ?? '';

  /// Bytes that travelled with the payload (live results only).
  Uint8List? get _inlineBytes {
    final data = image['data'];
    return data is String && data.isNotEmpty ? decodeImageBytes(data) : null;
  }

  String get _mime => (image['mimeType'] as String?) ?? 'image';

  int get _bytes => (image['bytes'] as num?)?.toInt() ?? 0;

  String get _sizeLabel {
    if (_bytes <= 0) return 'image';
    final mb = _bytes / (1024 * 1024);
    return mb >= 0.1 ? '${mb.toStringAsFixed(1)} MB' : '${(_bytes / 1024).round()} KB';
  }

  @override
  Widget build(BuildContext context) {
    final svc = context.watch<AgentService>();
    final inline = _inlineBytes;
    if (inline != null) return _loaded(context, inline, svc);

    final fetched = svc.images.bytesFor(_id);
    if (fetched != null) return _loaded(context, fetched, svc);

    final failure = svc.images.failureFor(_id);
    if (failure != null) {
      return _placeholder(
        context,
        icon: Icons.image_not_supported_outlined,
        label: 'Image unavailable',
        detail: failure,
        onTap: null,
      );
    }

    // Fetch on sight. The bytes travel in their own request and never in
    // history, so there is nothing to ask permission for: a tap-to-load image
    // is just a picture the user cannot see.
    // Fetch on sight. The bytes travel in their own request and never in
    // history, so there is nothing to ask permission for. Deferred by a frame
    // because the store notifies listeners, and building must not mutate it.
    if (!svc.images.isPending(_id)) {
      WidgetsBinding.instance.addPostFrameCallback((_) => svc.images.ensure(_id));
    }
    final pending = svc.images.isPending(_id);
    return _placeholder(
      context,
      icon: Icons.image_outlined,
      label: pending ? 'Loading…' : 'Image',
      detail: _sizeLabel,
      onTap: pending
          ? null
          : () {
              svc.images.ensure(_id);
              // The store notifies listeners when the bytes arrive; nothing to
              // rebuild here.
            },
    );
  }

  Widget _loaded(BuildContext context, Uint8List bytes, AgentService svc) {
    return InkWell(
      onTap: () => showDialog<void>(
        context: context,
        builder: (ctx) => Dialog(
          insetPadding: const EdgeInsets.all(12),
          child: InteractiveViewer(
            maxScale: 8,
            child: Image.memory(bytes, errorBuilder: (_, _, _) =>
                const Icon(Icons.broken_image, size: 48)),
          ),
        ),
      ),
      borderRadius: BorderRadius.circular(6),
      child: Tooltip(
        message: tooltip,
        child: _framed(
          Stack(
            children: [
              Image.memory(
                bytes,
                width: width,
                height: height,
                fit: fit,
                errorBuilder: (_, _, _) =>
                    const Icon(Icons.broken_image, size: 24),
              ),
              Positioned(
                left: 4,
                bottom: 4,
                child: _chip(Icons.open_in_full, _mime),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _placeholder(
    BuildContext context, {
    required IconData icon,
    required String label,
    required String detail,
    required VoidCallback? onTap,
  }) {
    final scheme = Theme.of(context).colorScheme;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Tooltip(
        message: onTap == null ? detail : 'Tap to load ($detail)',
        child: _framed(
          SizedBox(
            width: width,
            height: height,
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(icon, size: 20, color: scheme.onSurface.withAlpha(160)),
                const SizedBox(height: 4),
                Text(
                  label,
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 10, color: scheme.onSurface.withAlpha(180)),
                ),
                Text(
                  detail,
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 9, color: scheme.onSurface.withAlpha(120)),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _framed(Widget child) {
    return Container(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: const Color(0x80808080).withAlpha(60)),
      ),
      child: ClipRRect(borderRadius: BorderRadius.circular(5), child: child),
    );
  }

  Widget _chip(IconData icon, String text) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: Colors.black.withAlpha(150),
        borderRadius: BorderRadius.circular(10),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 10, color: Colors.white),
          const SizedBox(width: 4),
          Text(text, style: const TextStyle(fontSize: 9, color: Colors.white)),
        ],
      ),
    );
  }
}
