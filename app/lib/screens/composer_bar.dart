import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../logic/slash_commands.dart';
import '../models/session.dart';
import '../services/agent_service.dart';

/// The chat composer: attachment strip, text field, slash-command
/// suggestions, and the single stop/send action button.
///
/// Stateless by design — the parent chat screen owns the text controller and
/// attached images and rebuilds on their changes.
class ComposerBar extends StatelessWidget {
  final TextEditingController input;
  final bool working;
  final AgentService svc;
  final Session? session;
  final bool steer;
  final ValueChanged<bool> onSteerChanged;
  final List<PendingImage> attachedImages;
  final ValueChanged<int> onRemoveAttachment;
  final int outboxCount;
  final bool isMacOS;
  final VoidCallback onSend;
  final VoidCallback onAttachBrowse;
  final VoidCallback onPasteClipboard;
  final ValueChanged<SlashCommandSpec> onSlashSelected;

  const ComposerBar({
    super.key,
    required this.input,
    required this.working,
    required this.svc,
    required this.session,
    required this.steer,
    required this.onSteerChanged,
    required this.attachedImages,
    required this.onRemoveAttachment,
    required this.outboxCount,
    required this.isMacOS,
    required this.onSend,
    required this.onAttachBrowse,
    required this.onPasteClipboard,
    required this.onSlashSelected,
  });

  /// Stop replaces send only while the agent is working AND the box is empty;
  /// with text in the box, send takes over (it delivers as steer/follow-up)
  /// and clearing the box reveals stop again.
  bool get _showStop => working && input.text.trim().isEmpty;

  String get _sendShortcutLabel => isMacOS ? '⌘+Enter' : 'Ctrl+Enter';

  List<SlashCommandSpec> get _slashMatches => matchSlashCommands(input.text);

  @override
  Widget build(BuildContext context) {
    final suggestions = _slashMatches;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (suggestions.isNotEmpty)
              _suggestionList(context, suggestions),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Expanded(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (outboxCount > 0)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 4),
                          child: Text(
                            'Reconnecting… $outboxCount message(s) will '
                            'send automatically',
                            style: TextStyle(
                              fontSize: 11,
                              color: Colors.orange.shade700,
                            ),
                          ),
                        ),
                      if (attachedImages.isNotEmpty)
                        _attachmentStrip(context),
                      KeyboardListener(
                        focusNode: FocusNode(),
                        onKeyEvent: (event) {
                          if (event is KeyDownEvent &&
                              event.logicalKey == LogicalKeyboardKey.enter &&
                              (isMacOS
                                  ? HardwareKeyboard.instance.isMetaPressed
                                  : HardwareKeyboard.instance.isControlPressed)) {
                            onSend();
                          }
                        },
                        child: TextField(
                          controller: input,
                          minLines: 1,
                          maxLines: 5,
                          decoration: InputDecoration(
                            hintText: working
                                ? 'Agent is working… (steer or wait)'
                                : 'Message… ($_sendShortcutLabel to send)',
                            // Keep the hint to one line so a large text scale
                            // doesn't grow the empty field to two rows.
                            hintMaxLines: 1,
                            border: const OutlineInputBorder(),
                            contentPadding: const EdgeInsets.symmetric(
                              horizontal: 8,
                              vertical: 10,
                            ),
                            prefixIcon: PopupMenuButton<String>(
                              icon: const Icon(Icons.attach_file, size: 20),
                              tooltip: 'Attach files or paste an image',
                              onSelected: (v) {
                                if (v == 'browse') onAttachBrowse();
                                if (v == 'paste') onPasteClipboard();
                              },
                              itemBuilder: (_) => [
                                const PopupMenuItem(
                                  value: 'browse',
                                  child: Text('Browse files…'),
                                ),
                                if (kIsWeb)
                                  const PopupMenuItem(
                                    value: 'paste',
                                    child: Text('Paste image from clipboard'),
                                  ),
                              ],
                            ),
                            // Mid-turn delivery mode: bolt = steer (delivered
                            // before the next LLM call), low-priority = follow-up
                            // (after the turn). Irrelevant when idle.
                            suffixIcon: working
                                ? IconButton(
                                    icon: Icon(
                                      steer ? Icons.bolt : Icons.low_priority,
                                      size: 20,
                                      color: steer
                                          ? Colors.deepOrange
                                          : Colors.grey,
                                    ),
                                    tooltip: steer
                                        ? 'Steering — tap to queue as follow-up'
                                        : 'Queued follow-up — tap to steer mid-turn',
                                    onPressed: () => onSteerChanged(!steer),
                                  )
                                : null,
                          ),
                          onSubmitted: (_) => onSend(),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 6),
                // One action button: STOP only when the agent is working with an
                // empty box (stopping is what the user can do); otherwise SEND.
                SizedBox(
                  width: 40,
                  height: 40,
                  child: IconButton(
                    icon: Icon(_showStop ? Icons.stop : Icons.send, size: 20),
                    tooltip: _showStop
                        ? 'Stop the agent'
                        : 'Send ($_sendShortcutLabel)',
                    onPressed: _showStop
                        ? (session == null ? null : () => svc.cancel(session!))
                        : onSend,
                    style: _showStop
                        ? IconButton.styleFrom(
                            backgroundColor:
                                Theme.of(context).colorScheme.primary,
                            foregroundColor: Colors.white,
                          )
                        : null,
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _suggestionList(BuildContext context, List<SlashCommandSpec> matches) {
    return Container(
      margin: const EdgeInsets.only(bottom: 4),
      constraints: const BoxConstraints(maxHeight: 220),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHighest.withAlpha(140),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: Theme.of(context).colorScheme.onSurface.withAlpha(40),
        ),
      ),
      child: ListView(
        shrinkWrap: true,
        padding: const EdgeInsets.symmetric(vertical: 4),
        children: [
          for (final command in matches)
            ListTile(
              dense: true,
              visualDensity: VisualDensity.compact,
              title: Text(
                command.usage,
                style: const TextStyle(
                  fontSize: 12,
                  fontFamily: 'monospace',
                  fontWeight: FontWeight.bold,
                ),
              ),
              subtitle: Text(
                command.description,
                style: const TextStyle(fontSize: 11),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              onTap: () => onSlashSelected(command),
            ),
        ],
      ),
    );
  }

  Widget _attachmentStrip(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Wrap(
        spacing: 6,
        runSpacing: 6,
        children: [
          for (var i = 0; i < attachedImages.length; i++)
            Stack(
              children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(6),
                  child: Image.memory(
                    attachedImages[i].bytes,
                    width: 72,
                    height: 72,
                    fit: BoxFit.cover,
                  ),
                ),
                Positioned(
                  right: 0,
                  top: 0,
                  child: GestureDetector(
                    onTap: () => onRemoveAttachment(i),
                    child: Container(
                      decoration: const BoxDecoration(
                        color: Colors.black54,
                        shape: BoxShape.circle,
                      ),
                      padding: const EdgeInsets.all(2),
                      child: const Icon(
                        Icons.close,
                        size: 14,
                        color: Colors.white,
                      ),
                    ),
                  ),
                ),
              ],
            ),
        ],
      ),
    );
  }
}
