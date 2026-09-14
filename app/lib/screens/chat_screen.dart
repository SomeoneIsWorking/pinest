import 'dart:async';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import './retry_banner.dart';
import '../services/agent_service.dart';
import '../services/attachment_selection.dart';
import '../services/paste_bridge.dart';
import '../services/user_preferences.dart';
import '../models/session.dart';
import './goal_banner.dart';
import '../models/chat_item.dart';
import 'app_toast.dart';
import 'session_actions.dart';
import 'chat_items_builder.dart';
import 'background_jobs_sheet.dart';
import '../logic/slash_commands.dart';
import 'composer_bar.dart';

export 'session_actions.dart';
import 'tree_dialog.dart';

class ChatScreen extends StatefulWidget {
  final String sessionId;
  const ChatScreen({super.key, required this.sessionId});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

/// Full-size viewer for a base64 image (tool results, user attachments).
class _ChatScreenState extends State<ChatScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  bool _removing = false;
  bool _modelsRequested = false;
  bool _wasWorking = false;
  bool _steer = true; // send mid-turn messages as steer (vs follow-up)
  final List<PendingImage> _attachedImages = [];
  final Map<String, List<PendingImage>> _pendingImagesByText = {};
  bool _atBottom = true; // track whether user is scrolled to bottom
  final Map<String, int> _prevHistoryLen = {};

  bool get _isMacOS => Theme.of(context).platform == TargetPlatform.macOS;

  Session? _session(AgentService svc) =>
      svc.sessions.where((s) => s.id == widget.sessionId).firstOrNull;

  /// Removes this screen's clipboard listener (web only).
  void Function()? _disposePaste;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    // Rebuild when the text changes so stop/send swap with box emptiness.
    _input.addListener(_onInputChanged);
    if (kIsWeb) {
      _disposePaste = registerImagePasteListener(
        _onPastedImage,
        onNoImage: _onPasteWithoutImage,
      );
    }
    _steer = context.read<UserPreferences>().steerByDefault;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _jumpToBottom(); // load scrolled to bottom
      _requestModels();
      _requestHistory();
    });
  }

  @override
  void dispose() {
    _disposePaste?.call();
    _scroll.removeListener(_onScroll);
    _input.removeListener(_onInputChanged);
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _onInputChanged() {
    if (mounted) setState(() {});
  }

  /// Restores parked (undelivered queued) messages into the composer after a
  /// stop, so the user's prompts survive instead of vanishing with the queue.
  void _restoreParked(List<Map<String, dynamic>> parked) {
    final texts = <String>[];
    for (final m in parked) {
      final text = m['text'] as String? ?? '';
      if (text.isNotEmpty) texts.add(text);
      for (final img in (m['images'] as List? ?? const [])) {
        final data = img['data'] as String?;
        if (data == null) continue;
        final image = PendingImage.fromBase64(
          mimeType: (img['mimeType'] as String?) ?? 'image/png',
          data: data,
        );
        if (!_attachedImages.any(
            (p) => p.bytes.length == image.bytes.length && p.mimeType == image.mimeType)) {
          _attachedImages.add(image);
        }
      }
    }
    final restored = texts.join('\n\n');
    if (restored.isEmpty && _attachedImages.isEmpty) return;
    setState(() {
      _input.text = _input.text.trim().isEmpty
          ? restored
          : '${_input.text}\n\n$restored';
      _input.selection = TextSelection.collapsed(offset: _input.text.length);
    });
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          'Stopped — ${texts.length} queued message(s) parked into the input',
        ),
        duration: const Duration(seconds: 3),
      ),
    );
  }

  void _onScroll() {
    if (_scroll.hasClients) {
      // Considered "at bottom" if within 80px of the max scroll extent
      final atBottom =
          _scroll.position.pixels >= _scroll.position.maxScrollExtent - 80;
      if (atBottom != _atBottom) {
        setState(() => _atBottom = atBottom);
      }
      // Scrolled to the top with older history available → pull the previous
      // page (server-side cursor pagination, HISTORY_PAGE_SIZE at a time).
      if (_scroll.position.pixels <= 0 &&
          !_loadingOlder &&
          context.read<AgentService>().historyHasMore(widget.sessionId)) {
        _loadOlderHistory();
      }
    }
  }

  bool _loadingOlder = false;

  void _loadOlderHistory() {
    if (_loadingOlder) return;
    final svc = context.read<AgentService>();
    final s = _session(svc);
    if (s == null) return;
    setState(() => _loadingOlder = true);
    // Prepending shifts everything down — remember the viewport metrics so the
    // user stays on the message they were reading instead of jumping.
    final pixelsBefore = _scroll.hasClients ? _scroll.position.pixels : 0.0;
    final maxBefore =
        _scroll.hasClients ? _scroll.position.maxScrollExtent : 0.0;
    final cursor = svc.historyCursor(widget.sessionId);
    svc.getHistory(s, cursor: cursor);

    // Safety timeout in case server response is lost
    Timer(const Duration(seconds: 5), () {
      if (mounted && _loadingOlder) {
        setState(() => _loadingOlder = false);
      }
    });

    void check(int attempts) {
      if (!mounted || !_scroll.hasClients || attempts <= 0) {
        if (mounted && _loadingOlder) setState(() => _loadingOlder = false);
        return;
      }
      final delta = _scroll.position.maxScrollExtent - maxBefore;
      if (delta > 1) {
        _scroll.jumpTo(pixelsBefore + delta);
        if (mounted) setState(() => _loadingOlder = false);
      } else {
        WidgetsBinding.instance.addPostFrameCallback(
          (_) => check(attempts - 1),
        );
      }
    }

    WidgetsBinding.instance.addPostFrameCallback((_) => check(10));
  }

  void _jumpToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
      }
    });
  }

  void _requestModels() {
    final svc = context.read<AgentService>();
    final s = _session(svc);
    if (s != null && !_modelsRequested) {
      _modelsRequested = true;
      svc.listModels(s);
    }
  }

  void _requestHistory() {
    final svc = context.read<AgentService>();
    final s = _session(svc);
    if (s != null) {
      svc.getHistory(s);
    }
  }

  void _scrollDown() {
    if (!_atBottom) return; // user scrolled up — don't auto-scroll
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 120),
          curve: Curves.easeOut,
        );
      }
    });
  }

  void _scrollToBottom() {
    if (_scroll.hasClients) {
      _scroll.animateTo(
        _scroll.position.maxScrollExtent,
        duration: const Duration(milliseconds: 250),
        curve: Curves.easeOutCubic,
      );
    }
  }

  /// A paste that carried an image we could not read must SAY so — an empty
  /// attachment strip looks identical to "the listener never fired".
  void _onPasteWithoutImage(String detail) {
    if (!mounted) return;
    showAppToast(
      context,
      'Paste: $detail',
      duration: const Duration(seconds: 4),
    );
  }

  void _onPastedImage(Uint8List bytes, String mimeType) =>
      _applyAttachmentSelection(
        preparePastedImage(bytes, mimeType, _attachedImages, _input.text),
      );

  /// Attach files via the paperclip. Images become image attachments; small
  /// text files are inlined into the message as fenced blocks; anything else
  /// is refused BY NAME (no silent drops).
  Future<void> _attachFiles() async {
    try {
      _applyAttachmentSelection(
        await selectAttachments(
          currentMessage: _input.text,
          attachedImages: _attachedImages,
        ),
      );
    } on StateError catch (error) {
      if (!mounted) return;
      showAppToast(
        context,
        error.message.toString(),
        isError: true,
      );
    }
  }

  /// Explicit clipboard read (web): works even when paste events are
  /// swallowed by the framework, because a button tap is a user gesture.
  Future<void> _pasteClipboardImage() async {
    final files = await readClipboardAttachmentImages();
    if (files.isEmpty && mounted) {
      showAppToast(
        context,
        'No image found on clipboard',
      );
      return;
    }
    _applyAttachmentSelection(
      prepareAttachments(
        files,
        currentMessage: _input.text,
        attachedImages: _attachedImages,
      ),
    );
  }

  void _applyAttachmentSelection(AttachmentSelection selection) {
    if (!mounted) return;
    setState(() {
      _attachedImages.addAll(selection.images);
      _input.text = selection.messageText;
    });
    for (final notice in selection.notices) {
      showAppToast(context, notice);
    }
  }

  /// Applies a tapped slash-command suggestion: argless commands run
  /// immediately, argument commands are inserted ready for typing.
  void _applySlash(SlashCommandSpec command) {
    setState(() {
      _input.text = command.usage;
      _input.selection = TextSelection.collapsed(offset: command.usage.length);
    });
    if (!command.hasArg) _send();
  }

  void _send() async {
    final text = _input.text.trim();
    if (text == '/reload' || text == '/pinest-reload') {
      _input.clear();
      final svc = context.read<AgentService>();
      svc.reload();
      showAppToast(context, 'Reloading runtime…');
      return;
    }
    if (text == '/tree') {
      _input.clear();
      final svc = context.read<AgentService>();
      final s = _session(svc);
      if (s != null) {
        showTreeDialog(context, svc, s);
      }
      return;
    }
    final hasImages = _attachedImages.isNotEmpty;
    if (text.isEmpty && !hasImages) return;
    final svc = context.read<AgentService>();
    final s = _session(svc);
    if (text.startsWith('/')) {
      if (hasImages) {
        showAppToast(context, "Slash commands can't carry attachments", isError: true);
        return;
      }
      if (await runSlashCommand(context, svc: svc, s: s, text: text)) {
        _input.clear();
        return;
      }
    }
    final displayText = text.isEmpty ? '[image]' : text;
    if (hasImages) {
      _pendingImagesByText[displayText] =
          List<PendingImage>.from(_attachedImages);
    }
    if (s != null) {
      svc.sendMessage(
        s,
        text,
        images: List<PendingImage>.from(_attachedImages),
        steer: _steer,
      );
    }
    _input.clear();
    setState(() => _attachedImages.clear());
    _atBottom = true; // sending a message forces scroll to bottom
    _scrollDown();
  }

  @override
  Widget build(BuildContext context) {
    final svc = context.watch<AgentService>();
    final s = _session(svc);
    final working = svc.statusFor(widget.sessionId) == 'working';
    final streaming = svc.streamingFor(widget.sessionId);
    final streamingThinking = svc.streamingThinkingFor(widget.sessionId);
    final prefs = context.watch<UserPreferences>();
    final models = svc.modelsFor(widget.sessionId);
    final history = svc.historyFor(widget.sessionId);
    final toolCalls = svc.toolCallsFor(widget.sessionId);

    // Re-fetch history when agent goes idle (to get image-embedded messages)
    if (!working && _wasWorking) {
      _requestHistory();
    }
    _wasWorking = working;

    // Track history length to detect when it first loads or grows
    final prevLen = _prevHistoryLen[widget.sessionId] ?? 0;
    if (history.length > prevLen) {
      if (prevLen == 0) {
        // First load — jump to bottom
        _jumpToBottom();
      } else {
        // New messages — scroll if at bottom
        _scrollDown();
      }
    }
    _prevHistoryLen[widget.sessionId] = history.length;

    // Parked messages (server parked the queue on stop) restore into the
    // composer once, in a post-frame callback so we don't mutate during build.
    if (s != null) {
      final parked = svc.parkedFor(s.id);
      if (parked.isNotEmpty) {
        svc.clearParked(s.id);
        WidgetsBinding.instance.addPostFrameCallback((_) => _restoreParked(parked));
      }
    }

    if (streaming != null || streamingThinking != null) _scrollDown();

    // Hint only when the chat itself is empty — tool calls, streamed segments,
    // thinking and queued sends all count as content.
    final items = _chatItems(
      history,
      streaming,
      streamingThinking,
      toolCalls,
      svc,
      s,
      prefs,
    );

    return Column(
      children: [
        if (!svc.wsConnected)
          Material(
            color: Colors.orange.withAlpha(60),
            child: const Padding(
              padding: EdgeInsets.symmetric(vertical: 4),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  SizedBox(
                    width: 12,
                    height: 12,
                    child: CircularProgressIndicator(strokeWidth: 1.5),
                  ),
                  SizedBox(width: 8),
                  Text(
                    'Connection lost — reconnecting…',
                    style: TextStyle(fontSize: 12),
                  ),
                ],
              ),
            ),
          ),
        if (MediaQuery.of(context).size.width >= wideBarMinWidth)
          _toolbar(context, svc, s, working, models),
        if (s != null)
          RetryBanner(session: s, onStop: () => svc.cancel(s)),
        BackgroundJobsBanner(svc: svc, sessionId: widget.sessionId),
        Expanded(
          child: Stack(
            children: [
              _messageList(items),
              Positioned(
                right: 16,
                bottom: 16,
                child: AnimatedOpacity(
                  opacity: _atBottom ? 0.0 : 1.0,
                  duration: const Duration(milliseconds: 180),
                  child: IgnorePointer(
                    ignoring: _atBottom,
                    child: FloatingActionButton.small(
                      heroTag: null,
                      onPressed: _scrollToBottom,
                      tooltip: 'Scroll to bottom',
                      backgroundColor:
                          Theme.of(context).colorScheme.surfaceContainerHigh,
                      foregroundColor:
                          Theme.of(context).colorScheme.onSurface,
                      elevation: 3,
                      child: Icon(
                        Icons.keyboard_arrow_down,
                        size: 24,
                        color: Theme.of(context).colorScheme.onSurface,
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
        if (items.isEmpty)
          const Padding(
            padding: EdgeInsets.all(16),
            child: Center(
              child: Text(
                'Send a message to start working.',
                style: TextStyle(color: Colors.grey),
              ),
            ),
          ),
        if (svc.goalFor(widget.sessionId) != null)
          GoalBanner(
            goal: svc.goalFor(widget.sessionId)!,
            onEdit: () => _editGoal(svc),
            onClear: () => _clearGoal(svc),
          ),
        ComposerBar(
          input: _input,
          working: working,
          svc: svc,
          session: s,
          steer: _steer,
          onSteerChanged: (v) => setState(() => _steer = v),
          attachedImages: _attachedImages,
          onRemoveAttachment: (i) => setState(() => _attachedImages.removeAt(i)),
          outboxCount: svc.outboxCount,
          isMacOS: _isMacOS,
          onSend: _send,
          onAttachBrowse: _attachFiles,
          onPasteClipboard: _pasteClipboardImage,
          onSlashSelected: _applySlash,
        ),
      ],
    );
  }

  Widget _messageList(List<Widget> items) {
    // Nested scrollables (expanded tool-output blocks) absorb the drag until
    // they hit their edge; from there the leftover overscroll transfers to the
    // chat list so the finger never gets stuck at the block's boundary.
    return NotificationListener<OverscrollNotification>(
      onNotification: _bubbleNestedOverscroll,
      child: ListView(
        controller: _scroll,
        padding: const EdgeInsets.all(12),
        children: items,
      ),
    );
  }

  /// Everything the chat renders: history, queued sends, streaming text and
  /// live tool calls. The list and the "nothing here yet" hint must agree on
  /// this, otherwise a working agent shows a transcript and "send a message"
  /// at the same time.
  /// Edit the standing objective for THIS tab's session. Reuses the
  /// composer's own `/goal` path so the app never grows a second way to set one.
  Future<void> _editGoal(AgentService svc) async {
    final controller =
        TextEditingController(text: svc.goalFor(widget.sessionId)?.text ?? '');
    final edited = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Goal'),
        content: TextField(
          controller: controller,
          autofocus: true,
          maxLines: 4,
          minLines: 2,
          decoration: const InputDecoration(
            hintText: 'What should the agent work toward?',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(controller.text.trim()),
            child: const Text('Set goal'),
          ),
        ],
      ),
    );
    if (edited != null && edited.isNotEmpty) {
      svc.setGoal(widget.sessionId, edited);
    }
  }

  /// Clear the objective, after saying what that means.
  Future<void> _clearGoal(AgentService svc) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Clear the goal?'),
        content: const Text(
          'The agent stops being told to work toward it. Nothing already done '
          'is undone, and you can set it again at any time.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Keep'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Clear'),
          ),
        ],
      ),
    );
    if (confirmed ?? false) svc.clearGoal(widget.sessionId);
  }

  List<Widget> _chatItems(
    List<Map<String, dynamic>> history,
    String? streaming,
    String? streamingThinking,
    List<Map<String, dynamic>> toolCalls,
    AgentService svc,
    Session? s,
    UserPreferences prefs,
  ) {
    return buildChatItems(
      context: context,
      sessionId: widget.sessionId,
      session: s,
      svc: svc,
      prefs: prefs,
      history: history,
      streaming: streaming,
      streamingThinking: streamingThinking,
      toolCalls: toolCalls,
      loadingOlder: _loadingOlder,
      onLoadOlder: _loadOlderHistory,
      pendingImagesByText: _pendingImagesByText,
      onRewindRestore: (rewoundText, restoredImgs) {
        if (mounted) {
          setState(() {
            _input.text = rewoundText;
            if (restoredImgs.isNotEmpty) {
              _attachedImages.addAll(restoredImgs);
            }
          });
        }
      },
      onConfirmRewind: (entryId) {
        if (s != null) _confirmRewind(s, entryId);
      },
      onEditQueued: (text, editedText, restoredImgs) {
        _pendingImagesByText.remove(text);
        if (mounted) {
          setState(() {
            _input.text = editedText;
            if (restoredImgs.isNotEmpty) {
              _attachedImages.addAll(restoredImgs);
            }
          });
        }
      },
      onDeleteQueued: (text) {
        _pendingImagesByText.remove(text);
      },
    );
  }

  /// Moves the chat list by an inner scrollable's leftover overscroll.
  /// depth 0 is the chat list's own overscroll — only nested (depth > 0)
  /// reports are transferred.
  bool _bubbleNestedOverscroll(OverscrollNotification notification) {
    if (notification.depth == 0 || !_scroll.hasClients) return false;
    final position = _scroll.position;
    final target = (position.pixels + notification.overscroll).clamp(
      position.minScrollExtent,
      position.maxScrollExtent,
    );
    if (target == position.pixels) return false;
    _scroll.jumpTo(target);
    return true;
  }

  /// Rewind the branch to [entryId] after saying what that costs.
  ///
  /// This is the only way to drop a message that makes every later request fail
  /// (a 4K screenshot that the provider refuses), and it discards the messages
  /// after the point — recoverable through the tree, but not silently.
  Future<void> _confirmRewind(Session s, String entryId) async {
    final svc = context.read<AgentService>();
    final go = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Rewind to this point?'),
        content: const Text(
          'Everything after this point leaves the branch. It stays recoverable '
          'from the conversation tree.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('Rewind'),
          ),
        ],
      ),
    );
    if (go != true || !mounted) return;
    await svc.rewindSession(s, entryId);
    if (!mounted) return;
    showAppToast(context, 'Rewound the conversation to that point');
  }

  Widget _toolbar(
    BuildContext context,
    AgentService svc,
    Session? s,
    bool working,
    List<PinestModel> models,
  ) {
    if (s != null && models.isEmpty && !_modelsRequested) _requestModels();
    final actions = buildSessionBarActions(
      context: context,
      svc: svc,
      session: s,
      working: working,
      models: models,
      isRemoving: _removing,
      onRemoving: () {
        if (mounted) setState(() => _removing = true);
      },
      onRemoved: () {
        if (mounted) setState(() => _removing = false);
      },
    );
    final badge = s?.contextPercent == null
        ? null
        : ContextBadge(
            percent: s!.contextPercent!,
            tokens: s.contextTokens,
            window: s.contextWindow,
            modelName: s.modelName ?? s.model,
            compactAt: s.contextCompactAt,
            isCompacting: s.isCompacting,
          );
    return Material(
      color: Theme.of(
        context,
      ).colorScheme.surfaceContainerHighest.withAlpha(80),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        child: SessionToolbarRow(
          badge: badge,
          actions: actions,
          busy: _removing,
          onOpenSidebar: () => showSessionActionSidebar(context, actions),
        ),
      ),
    );
  }

}


