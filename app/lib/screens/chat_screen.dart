import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import '../services/agent_service.dart';
import '../services/attachment_selection.dart';
import '../services/paste_bridge.dart';
import '../services/user_preferences.dart';
import '../models/session.dart';
import '../models/chat_item.dart';
import '../models/tool_call_view.dart';
import 'app_toast.dart';
import 'tool_call_card.dart';

class ChatScreen extends StatefulWidget {
  final String sessionId;
  const ChatScreen({super.key, required this.sessionId});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

/// Full-size viewer for a base64 image (tool results, user attachments).
void showImageDialog(BuildContext context, String b64) {
  showDialog<void>(
    context: context,
    builder: (ctx) => Dialog(
      insetPadding: const EdgeInsets.all(12),
      child: InteractiveViewer(
        maxScale: 8,
        child: Image.memory(base64Decode(b64)),
      ),
    ),
  );
}

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
  String get _sendShortcutLabel => _isMacOS ? '⌘+Enter' : 'Ctrl+Enter';

  Session? _session(AgentService svc) =>
      svc.sessions.where((s) => s.id == widget.sessionId).firstOrNull;

  /// Removes this screen's clipboard listener (web only).
  void Function()? _disposePaste;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
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
    _input.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (_scroll.hasClients) {
      // Considered "at bottom" if within 80px of the max scroll extent
      _atBottom =
          _scroll.position.pixels >= _scroll.position.maxScrollExtent - 80;
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
        'No image read from clipboard. On Firefox/Zen use ⌘V in the message field instead.',
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

  void _send() {
    final text = _input.text.trim();
    final hasImages = _attachedImages.isNotEmpty;
    if (text.isEmpty && !hasImages) return;
    final svc = context.read<AgentService>();
    final s = _session(svc);
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

    if (streaming != null) _scrollDown();

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
        _toolbar(context, svc, s, working, models),
        Expanded(child: _messageList(history, streaming, toolCalls, svc, s)),
        if (history.isEmpty && streaming == null)
          const Padding(
            padding: EdgeInsets.all(16),
            child: Center(
              child: Text(
                'Send a message to start working.',
                style: TextStyle(color: Colors.grey),
              ),
            ),
          ),
        _inputBar(working, svc, s),
      ],
    );
  }

  void _showQueuedMessageOptions(
    BuildContext context,
    AgentService svc,
    Session s,
    String text,
    List<PendingImage> pendingImgs,
  ) {
    showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.edit_outlined),
              title: const Text('Edit message'),
              subtitle: const Text('Remove from queue and copy back to editor'),
              onTap: () {
                Navigator.of(ctx).pop();
                svc.deleteQueuedMessage(s, text);
                _pendingImagesByText.remove(text);
                setState(() {
                  _input.text = text == '[image]' ? '' : text;
                  if (pendingImgs.isNotEmpty) {
                    _attachedImages.addAll(pendingImgs);
                  }
                });
                showAppToast(
                  context,
                  'Message copied back to editor',
                  duration: const Duration(seconds: 2),
                );
              },
            ),
            ListTile(
              leading: const Icon(Icons.delete_outline, color: Colors.red),
              title: const Text(
                'Delete message',
                style: TextStyle(color: Colors.red),
              ),
              subtitle: const Text('Remove from queue without editing'),
              onTap: () {
                Navigator.of(ctx).pop();
                svc.deleteQueuedMessage(s, text);
                _pendingImagesByText.remove(text);
                showAppToast(
                  context,
                  'Message deleted from queue',
                  duration: const Duration(seconds: 2),
                );
              },
            ),
          ],
        ),
      ),
    );
  }

  Widget _messageList(
    List<Map<String, dynamic>> history,
    String? streaming,
    List<Map<String, dynamic>> toolCalls,
    AgentService svc,
    Session? s,
  ) {
    // Server-authoritative queue — the client is a terminal, not the keeper.
    final queued = s?.pendingMessages ?? const <String>[];
    final items = <Widget>[];

    final hasMore = svc.historyHasMore(widget.sessionId);
    if (_loadingOlder) {
      items.add(
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 12),
          child: Center(
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                const SizedBox(
                  width: 14,
                  height: 14,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                const SizedBox(width: 8),
                Text(
                  'Loading older messages…',
                  style: TextStyle(fontSize: 12, color: Colors.grey.shade600),
                ),
              ],
            ),
          ),
        ),
      );
    } else if (hasMore) {
      items.add(
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Center(
            child: TextButton.icon(
              onPressed: _loadingOlder ? null : _loadOlderHistory,
              icon: const Icon(Icons.arrow_upward, size: 14),
              label: const Text('Load older messages'),
              style: TextButton.styleFrom(
                visualDensity: VisualDensity.compact,
                textStyle: const TextStyle(fontSize: 12),
              ),
            ),
          ),
        ),
      );
    }

    for (final msg in history) {
      final role = msg['role'] as String? ?? '';
      final text = msg['text'] as String? ?? '';
      final tools = msg['tools'] as List?;
      if (role == 'user') {
        items.add(
          _bubble(
            text,
            Alignment.centerRight,
            Colors.blueGrey.withAlpha(40),
            historyImages: [
              for (final img in (msg['images'] as List? ?? const []))
                Map<String, dynamic>.from(img as Map),
            ],
          ),
        );
      } else {
        // Show tools from history (expandable)
        if (tools != null) {
          for (final t in tools) {
            items.add(
              _toolCallCard(
                ToolCallView.fromPayload(
                  Map<String, dynamic>.from(t as Map),
                  source: ToolCallSource.history,
                ),
              ),
            );
          }
        }
        if (text.isNotEmpty) {
          items.add(_bubble(text, Alignment.centerLeft, null, markdown: true));
        }
      }
    }
    // Live tool calls (not yet in history), interleaved with the speech
    // segments the assistant finished before each tool call — the streamed
    // text stays visible while tools run instead of vanishing.
    final segments = svc.streamingSegmentsFor(widget.sessionId);
    for (var i = 0; i < toolCalls.length || i < segments.length; i++) {
      if (i < segments.length) {
        items.add(_bubble(segments[i], Alignment.centerLeft, null));
      }
      if (i < toolCalls.length) {
        items.add(
          _toolCallCard(
            ToolCallView.fromPayload(toolCalls[i], source: ToolCallSource.live),
          ),
        );
      }
    }
    if (streaming != null) {
      items.add(_StreamingBubble(text: streaming));
    }
    // Queued messages at the very end — reported by the server, not tracked
    // locally. Image-only messages arrive as the server's '[image]' text.
    // LONG-PRESS clears the queue: pi dequeues by text-match at message_start,
    // so a message can get genuinely stuck in its steering/followUp queues;
    // the server-side queue_clear drains pi's own queue (the honest fix).
    for (final text in queued) {
      final pendingImgs = _pendingImagesByText[text] ?? const <PendingImage>[];
      items.add(
        GestureDetector(
          onTap: (s == null)
              ? null
              : () => _showQueuedMessageOptions(
                    context,
                    svc,
                    s,
                    text,
                    pendingImgs,
                  ),
          onLongPress: (s == null)
              ? null
              : () => _showQueuedMessageOptions(
                    context,
                    svc,
                    s,
                    text,
                    pendingImgs,
                  ),
          child: _bubble(
            text,
            Alignment.centerRight,
            Colors.orange.withAlpha(40),
            queued: true,
            steering: s?.pendingSteering.contains(text) ?? false,
            images: pendingImgs,
          ),
        ),
      );
    }
    return ListView(
      controller: _scroll,
      padding: const EdgeInsets.all(12),
      children: items,
    );
  }

  Widget _toolCallCard(ToolCallView tool) => ToolCallCard(
    name: tool.name,
    args: tool.args,
    result: tool.result,
    images: tool.images,
    imagesOmitted: tool.imagesOmitted,
    isError: tool.isError,
    running: tool.running,
  );

  Widget _toolbar(
    BuildContext context,
    AgentService svc,
    Session? s,
    bool working,
    List<PinestModel> models,
  ) {
    // If models are empty, re-request once (in case the first request lost).
    if (s != null && models.isEmpty && !_modelsRequested) _requestModels();
    // ONE definition of the actions, shared by the wide bar and the narrow
    // sidebar — two copies would drift in what is enabled when.
    final actions = <BarAction>[
      BarAction(
        label: '/model ${s?.modelName ?? s?.model ?? ""}'.trim(),
        icon: Icons.memory,
        onTap: models.isEmpty ? null : () => _showModels(context, svc, models),
      ),
      BarAction(
        label: '/thinking ${s?.thinkingLevel ?? "off"}',
        icon: Icons.psychology,
        color: (s?.thinkingLevel ?? 'off') != 'off' ? Colors.purple : null,
        onTap: (s == null) ? null : () => _showThinking(context, svc, s),
      ),
      BarAction(
        label: '/compact',
        icon: Icons.compress,
        // Both of these rewrite the transcript irreversibly and are one tap
        // away from /model in the same bar — confirm before firing.
        onTap: (working || s == null)
            ? null
            : () => _confirmContextAction(
                context,
                title: 'Compact context?',
                body:
                    'The conversation so far is replaced by a summary. '
                    'The full transcript is not recoverable from the app.',
                action: 'Compact',
                onConfirm: () => svc.compact(s),
              ),
      ),
      BarAction(
        label: '/clear',
        icon: Icons.cleaning_services,
        onTap: (working || s == null)
            ? null
            : () => _confirmContextAction(
                context,
                title: 'Clear session?',
                body:
                    'Starts a fresh session with an empty context. '
                    'The current conversation is dropped from this session.',
                action: 'Clear',
                onConfirm: () => svc.newSession(s),
              ),
      ),
      if (!working && s != null && !s.isHost)
        BarAction(
          label: '/remove',
          icon: Icons.delete_outline,
          color: Colors.red,
          onTap: _removing ? null : () => _confirmRemove(context, svc, s),
        ),
    ];
    final badge = s?.contextPercent == null
        ? null
        : _ContextBadge(
            percent: s!.contextPercent!,
            tokens: s.contextTokens,
            window: s.contextWindow,
            modelName: s.modelName ?? s.model,
            compactAt: s.contextCompactAt,
          );
    return Material(
      color: Theme.of(
        context,
      ).colorScheme.surfaceContainerHighest.withAlpha(80),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        // The bar spans the FULL width and never scrolls sideways. Wide
        // screens have room for every action inline; narrow ones cannot fit
        // them at any font size, so they move into a slide-in sidebar behind
        // one button instead of being scrolled off-screen where nobody looks.
        child: SessionToolbarRow(
          badge: badge,
          actions: actions,
          busy: _removing,
          onOpenSidebar: () => _showActionSidebar(context, actions),
        ),
      ),
    );
  }

  /// Narrow-screen home for the toolbar actions: a panel that slides in from
  /// the right edge, same actions, same enabled/disabled state.
  Future<void> _showActionSidebar(
    BuildContext context,
    List<BarAction> actions,
  ) {
    return showGeneralDialog<void>(
      context: context,
      barrierDismissible: true,
      barrierLabel: 'Session actions',
      barrierColor: Colors.black54,
      transitionDuration: const Duration(milliseconds: 180),
      pageBuilder: (ctx, _, _) => Align(
        alignment: Alignment.centerRight,
        child: SizedBox(
          width: math.min(300, MediaQuery.of(ctx).size.width * 0.8),
          height: double.infinity,
          child: Material(
            color: Theme.of(ctx).colorScheme.surface,
            child: SafeArea(
              child: ListView(
                padding: const EdgeInsets.symmetric(vertical: 8),
                children: [
                  for (final a in actions)
                    ListTile(
                      leading: Icon(
                        a.icon,
                        size: 20,
                        color: a.onTap == null
                            ? Colors.grey.withAlpha(80)
                            : (a.color ?? Colors.blue),
                      ),
                      title: Text(
                        a.label,
                        style: TextStyle(
                          fontFamily: 'monospace',
                          fontSize: 13,
                          color: a.onTap == null
                              ? Colors.grey.withAlpha(120)
                              : (a.color ?? Colors.blue),
                        ),
                      ),
                      enabled: a.onTap != null,
                      onTap: a.onTap == null
                          ? null
                          : () {
                              Navigator.pop(ctx);
                              a.onTap!();
                            },
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
      transitionBuilder: (ctx, anim, _, child) => SlideTransition(
        position: Tween<Offset>(
          begin: const Offset(1, 0),
          end: Offset.zero,
        ).animate(CurvedAnimation(parent: anim, curve: Curves.easeOut)),
        child: child,
      ),
    );
  }

  Widget _attachmentStrip() {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Wrap(
        spacing: 6,
        runSpacing: 6,
        children: [
          for (var i = 0; i < _attachedImages.length; i++)
            Stack(
              children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(6),
                  child: Image.memory(
                    _attachedImages[i].bytes,
                    width: 72,
                    height: 72,
                    fit: BoxFit.cover,
                  ),
                ),
                Positioned(
                  right: 0,
                  top: 0,
                  child: GestureDetector(
                    onTap: () => setState(() => _attachedImages.removeAt(i)),
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

  Widget _inputBar(bool working, AgentService svc, Session? s) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Expanded(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (svc.outboxCount > 0)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: Text(
                        'Reconnecting… ${svc.outboxCount} message(s) will '
                        'send automatically',
                        style: TextStyle(
                          fontSize: 11,
                          color: Colors.orange.shade700,
                        ),
                      ),
                    ),
                  if (_attachedImages.isNotEmpty) _attachmentStrip(),
                  KeyboardListener(
                    focusNode: FocusNode(),
                    onKeyEvent: (event) {
                      if (event is KeyDownEvent &&
                          event.logicalKey == LogicalKeyboardKey.enter &&
                          (_isMacOS
                              ? HardwareKeyboard.instance.isMetaPressed
                              : HardwareKeyboard.instance.isControlPressed)) {
                        _send();
                      }
                    },
                    child: TextField(
                      controller: _input,
                      minLines: 1,
                      maxLines: 5,
                      decoration: InputDecoration(
                        hintText: working
                            ? 'Agent is working… (steer or wait)'
                            : 'Message… ($_sendShortcutLabel to send)',
                        border: const OutlineInputBorder(),
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 8,
                          vertical: 10,
                        ),
                        prefixIcon: PopupMenuButton<String>(
                          icon: const Icon(Icons.attach_file, size: 20),
                          tooltip: 'Attach files or paste an image',
                          onSelected: (v) {
                            if (v == 'browse') _attachFiles();
                            if (v == 'paste') _pasteClipboardImage();
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
                                  _steer ? Icons.bolt : Icons.low_priority,
                                  size: 20,
                                  color: _steer
                                      ? Colors.deepOrange
                                      : Colors.grey,
                                ),
                                tooltip: _steer
                                    ? 'Steering — tap to queue as follow-up'
                                    : 'Queued follow-up — tap to steer mid-turn',
                                onPressed: () =>
                                    setState(() => _steer = !_steer),
                              )
                            : null,
                      ),
                      onSubmitted: (_) => _send(),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 6),
            // Compact 40px buttons: on phone widths the old 48px set plus the
            // attach/steer buttons overflowed the row.
            SizedBox(
              width: 40,
              height: 40,
              child: IconButton(
                icon: const Icon(Icons.send, size: 20),
                tooltip: 'Send ($_sendShortcutLabel)',
                onPressed: _send,
              ),
            ),
            if (working)
              SizedBox(
                width: 40,
                height: 40,
                child: IconButton(
                  icon: const Icon(Icons.stop, size: 20),
                  tooltip: 'Stop the agent',
                  onPressed: s == null ? null : () => svc.cancel(s),
                  style: IconButton.styleFrom(
                    backgroundColor: Theme.of(context).colorScheme.primary,
                    foregroundColor: Colors.white,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _bubble(
    String text,
    Alignment align,
    Color? bg, {
    bool markdown = false,
    bool queued = false,
    bool steering = false,
    List<PendingImage> images = const [],

    /// History image attachments (base64 maps from the server) — the in-memory
    /// [images] form dies on refresh; this one survives it.
    List<Map<String, dynamic>> historyImages = const [],
  }) {
    return Align(
      alignment: align,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 3),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: bg,
          borderRadius: BorderRadius.circular(12),
        ),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.82,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          mainAxisSize: MainAxisSize.min,
          children: [
            // A steer is NOT a follow-up: measured, pi delivers it at the end
            // of the assistant's current step, not at the end of the turn.
            // Labelling both "queued" made a working steer look ignored.
            if (queued)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Tooltip(
                  message: steering
                      ? 'Steering — delivered when the current step ends'
                      : 'Follow-up — delivered when the turn ends',
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        steering ? Icons.bolt : Icons.schedule,
                        size: 12,
                        color: Colors.orange,
                      ),
                      const SizedBox(width: 4),
                      Text(
                        steering ? 'steering' : 'queued',
                        style: const TextStyle(
                          fontSize: 10,
                          color: Colors.orange,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            if (images.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  alignment: WrapAlignment.end,
                  children: [
                    for (final img in images)
                      ClipRRect(
                        borderRadius: BorderRadius.circular(6),
                        child: Image.memory(
                          img.bytes,
                          width: 96,
                          height: 96,
                          fit: BoxFit.cover,
                          errorBuilder: (_, _, _) =>
                              const Icon(Icons.broken_image, size: 24),
                        ),
                      ),
                  ],
                ),
              ),
            if (historyImages.isNotEmpty)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  alignment: WrapAlignment.end,
                  children: [
                    for (final img in historyImages)
                      InkWell(
                        onTap: () =>
                            showImageDialog(context, img['data'] as String),
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(6),
                          child: Image.memory(
                            base64Decode(img['data'] as String),
                            width: 96,
                            height: 96,
                            fit: BoxFit.cover,
                            errorBuilder: (_, _, _) =>
                                const Icon(Icons.broken_image, size: 24),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            if (text.isNotEmpty)
              markdown
                  ? MarkdownBody(data: text, shrinkWrap: true, selectable: true)
                  : Text(text),
          ],
        ),
      ),
    );
  }

  void _showThinking(BuildContext context, AgentService svc, Session s) {
    const levels = ['off', 'low', 'medium', 'high', 'max'];
    final current = s.thinkingLevel;
    // "Default" = the model's own default: the server omits the reasoning
    // override entirely (opencode semantics) and reports back 'default'.
    final onDefault = current == 'default';
    showModalBottomSheet(
      context: context,
      builder: (_) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.all(16),
              child: Text(
                'Thinking level',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
              ),
            ),
            ListTile(
              leading: Icon(
                Icons.tune,
                size: 20,
                color: onDefault ? Colors.purple : null,
              ),
              title: const Text('Default'),
              subtitle: const Text(
                "The model's own default (no override)",
                style: TextStyle(fontSize: 11),
              ),
              trailing: onDefault
                  ? const Icon(Icons.check, color: Colors.purple, size: 18)
                  : null,
              onTap: () {
                svc.setThinking(s, 'default');
                context.read<UserPreferences>().saveThinking('default');
                Navigator.pop(context);
              },
            ),
            ...levels.map(
              (l) => ListTile(
                leading: Icon(
                  _thinkingIcon(l),
                  size: 20,
                  color: l == current ? Colors.purple : null,
                ),
                title: Text(l[0].toUpperCase() + l.substring(1)),
                trailing: l == current
                    ? const Icon(Icons.check, color: Colors.purple, size: 18)
                    : null,
                onTap: () {
                  svc.setThinking(s, l);
                  context.read<UserPreferences>().saveThinking(l);
                  Navigator.pop(context);
                },
              ),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
  }

  IconData _thinkingIcon(String level) {
    switch (level) {
      case 'off':
        return Icons.block;
      case 'low':
        return Icons.psychology_outlined;
      case 'medium':
        return Icons.psychology;
      case 'high':
        return Icons.lightbulb_outline;
      case 'max':
        return Icons.auto_awesome;
      default:
        return Icons.psychology_outlined;
    }
  }

  void _showModels(
    BuildContext context,
    AgentService svc,
    List<PinestModel> models,
  ) {
    final s = _session(svc);
    if (s == null) return;
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      builder: (_) => _ModelSheet(
        models: models,
        onPick: (m) {
          svc.setModel(s, m.provider, m.id);
          context.read<UserPreferences>().saveModel('${m.provider}/${m.id}');
          Navigator.pop(context);
        },
      ),
    );
  }

  /// Shared confirm for the two destructive context actions (/compact, /clear).
  /// The server answers with a `notice` once it really happened — the shell
  /// snackbars it, so a confirmed action is never silent either way.
  void _confirmContextAction(
    BuildContext context, {
    required String title,
    required String body,
    required String action,
    required VoidCallback onConfirm,
  }) {
    showDialog<void>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: Text(title),
        content: Text(body),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(dialogContext),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () {
              Navigator.pop(dialogContext);
              onConfirm();
            },
            child: Text(action),
          ),
        ],
      ),
    );
  }

  void _confirmRemove(BuildContext context, AgentService svc, Session s) {
    showDialog(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Remove session?'),
        content: Text(
          s.isInteractive
              ? 'This removes the session from PiNest. Your terminal keeps running.'
              : 'This stops and removes the agent session.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Colors.red),
            onPressed: () {
              Navigator.pop(context);
              _doRemove(svc, s);
            },
            child: const Text('Remove'),
          ),
        ],
      ),
    );
  }

  Future<void> _doRemove(AgentService svc, Session s) async {
    setState(() => _removing = true);
    svc.despawnSession(s);
    // Wait for the session to disappear from the state doc (up to 10s).
    final deadline = DateTime.now().add(const Duration(seconds: 10));
    final sid = s.id;
    while (DateTime.now().isBefore(deadline)) {
      if (!svc.sessions.any((x) => x.id == sid)) break;
      await Future.delayed(const Duration(milliseconds: 300));
    }
    if (mounted) setState(() => _removing = false);
  }
}

class _ContextBadge extends StatelessWidget {
  final double percent;
  final int? tokens;
  final int? window;
  final String? modelName;
  final int? compactAt;
  const _ContextBadge({
    required this.percent,
    this.tokens,
    this.window,
    this.modelName,
    this.compactAt,
  });

  @override
  Widget build(BuildContext context) {
    final pct = percent.round();
    final color = pct >= 90
        ? Colors.red
        : pct >= 70
        ? Colors.orange
        : Colors.green;
    final label = tokens != null && window != null
        ? '${(tokens! / 1000).toStringAsFixed(1)}/${(window! / 1000).toStringAsFixed(0)}k'
        : '$pct%';
    // Model + auto-compact threshold, so the user can verify what is active.
    final sub = [
      ?modelName,
      if (compactAt != null)
        'compact @ ${(compactAt! / 1000).toStringAsFixed(0)}k',
    ].join(' · ');
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              label,
              style: TextStyle(
                fontSize: 11,
                color: color,
                fontFamily: 'monospace',
              ),
            ),
            const SizedBox(width: 4),
            SizedBox(
              width: 40,
              child: LinearProgressIndicator(
                value: (percent / 100).clamp(0, 1),
                backgroundColor: Colors.grey.shade300,
                color: color,
                minHeight: 4,
              ),
            ),
          ],
        ),
        if (sub.isNotEmpty)
          Text(
            sub,
            style: TextStyle(fontSize: 9, color: Colors.grey.shade600),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
      ],
    );
  }
}

/// Below this width the action labels cannot all fit, so they move into the
/// slide-in sidebar instead of being scrolled off the right edge.
const double _wideBarMinWidth = 620;

/// One toolbar action, rendered inline on wide screens and as a sidebar row on
/// narrow ones. `onTap == null` means disabled in BOTH places.
class BarAction {
  final String label;
  final IconData icon;
  final Color? color;
  final VoidCallback? onTap;
  const BarAction({
    required this.label,
    required this.icon,
    this.color,
    this.onTap,
  });
}

/// The session toolbar's layout, split out so its geometry can be tested.
///
/// Full width, never sideways-scrolling. Wide: the actions sit at the RIGHT
/// edge with the context badge at the left. Narrow: the actions cannot fit at
/// any font size, so one button opens them in a sidebar instead of scrolling
/// them off-screen where nobody looks.
class SessionToolbarRow extends StatelessWidget {
  final Widget? badge;
  final List<BarAction> actions;
  final bool busy;
  final VoidCallback onOpenSidebar;
  const SessionToolbarRow({
    super.key,
    required this.badge,
    required this.actions,
    required this.onOpenSidebar,
    this.busy = false,
  });

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, c) {
        final wide = c.maxWidth >= _wideBarMinWidth;
        return SizedBox(
          width: double.infinity,
          child: Row(
            mainAxisSize: MainAxisSize.max,
            children: [
              // Expanded (not Flexible + Spacer): a Flexible badge and a
              // Spacer share the free space 50/50, which parked the actions in
              // the middle of the bar instead of at its right edge.
              Expanded(
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: badge ?? const SizedBox.shrink(),
                ),
              ),
              if (wide)
                for (final a in actions)
                  _ToolButton(label: a.label, color: a.color, onTap: a.onTap)
              else ...[
                if (busy)
                  const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 10),
                    child: SizedBox(
                      width: 16,
                      height: 16,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    ),
                  ),
                IconButton(
                  key: const Key('toolbar-sidebar-button'),
                  icon: const Icon(Icons.tune, size: 20),
                  tooltip: 'Session actions',
                  visualDensity: VisualDensity.compact,
                  onPressed: onOpenSidebar,
                ),
              ],
            ],
          ),
        );
      },
    );
  }
}

class _ToolButton extends StatelessWidget {
  final String label;
  final Color? color;
  final VoidCallback? onTap;
  const _ToolButton({required this.label, this.color, this.onTap});

  @override
  Widget build(BuildContext context) {
    final disabled = onTap == null;
    final c = disabled ? Colors.grey.withAlpha(80) : (color ?? Colors.blue);
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
        child: Text(
          label,
          style: TextStyle(
            fontFamily: 'monospace',
            fontSize: 12,
            color: c,
            decoration: TextDecoration.underline,
            decorationColor: c.withAlpha(120),
          ),
        ),
      ),
    );
  }
}

class _StreamingBubble extends StatelessWidget {
  final String text;
  const _StreamingBubble({required this.text});

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 3),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          border: Border.all(color: Colors.orange.withAlpha(120)),
          borderRadius: BorderRadius.circular(12),
        ),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.82,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            MarkdownBody(data: text, shrinkWrap: true),
            const SizedBox(height: 4),
            Row(
              children: [
                const SizedBox(
                  width: 10,
                  height: 10,
                  child: CircularProgressIndicator(strokeWidth: 1.5),
                ),
                const SizedBox(width: 6),
                Text(
                  'streaming…',
                  style: TextStyle(
                    fontSize: 10,
                    color: Colors.orange.withAlpha(220),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _ModelSheet extends StatefulWidget {
  final List<PinestModel> models;
  final ValueChanged<PinestModel> onPick;
  const _ModelSheet({required this.models, required this.onPick});

  @override
  State<_ModelSheet> createState() => _ModelSheetState();
}

class _ModelSheetState extends State<_ModelSheet> {
  String _q = '';

  @override
  Widget build(BuildContext context) {
    final q = _q.toLowerCase();
    final filtered = widget.models.where((m) {
      final hay = '${m.name} ${m.provider} ${m.id}'.toLowerCase();
      return hay.contains(q);
    }).toList();
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.7,
        child: Column(
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 16, 16, 8),
              child: Align(
                alignment: Alignment.centerLeft,
                child: Text(
                  'Select model',
                  style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: TextField(
                autofocus: true,
                decoration: const InputDecoration(
                  isDense: true,
                  hintText: 'Search models…',
                  prefixIcon: Icon(Icons.search),
                  border: OutlineInputBorder(),
                ),
                onChanged: (v) => setState(() => _q = v),
              ),
            ),
            const SizedBox(height: 8),
            Expanded(
              child: filtered.isEmpty
                  ? const Center(
                      child: Text(
                        'No models match',
                        style: TextStyle(color: Colors.grey),
                      ),
                    )
                  : ListView.builder(
                      itemCount: filtered.length,
                      itemBuilder: (_, i) {
                        final m = filtered[i];
                        return ListTile(
                          leading: const Icon(Icons.circle_outlined),
                          title: Text(m.name),
                          subtitle: Text(
                            '${m.provider}${m.reasoning ? " · reasoning" : ""}${m.vision ? " · vision" : ""}',
                          ),
                          onTap: () => widget.onPick(m),
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
