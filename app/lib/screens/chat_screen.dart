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
import 'model_sheet.dart';
import 'session_actions.dart';
import 'tool_call_card.dart';

export 'session_actions.dart';
import 'tree_dialog.dart';

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
        if (MediaQuery.of(context).size.width >= wideBarMinWidth)
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
    final isSteering = s.pendingSteering.contains(text);

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
                if (!svc.isMessageQueued(s.id, text)) {
                  showAppToast(
                    context,
                    "Can't edit: message already processed",
                    isError: true,
                  );
                  return;
                }
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
                  'Message removed from queue and copied to editor',
                  duration: const Duration(seconds: 2),
                );
              },
            ),
            if (isSteering)
              ListTile(
                leading: const Icon(Icons.schedule, color: Colors.indigoAccent),
                title: const Text('Change to Queued'),
                subtitle: const Text('Run after agent finishes current turn'),
                onTap: () {
                  Navigator.of(ctx).pop();
                  if (!svc.isMessageQueued(s.id, text)) {
                    showAppToast(
                      context,
                      "Can't change: message already processed",
                      isError: true,
                    );
                    return;
                  }
                  svc.deleteQueuedMessage(s, text);
                  svc.sendMessage(
                    s,
                    text == '[image]' ? '' : text,
                    images: pendingImgs,
                    steer: false,
                  );
                  showAppToast(
                    context,
                    'Changed to Queued (will run after current turn)',
                  );
                },
              )
            else
              ListTile(
                leading: const Icon(Icons.alt_route, color: Colors.orangeAccent),
                title: const Text('Change to Steered'),
                subtitle: const Text('Deliver immediately to guide current turn'),
                onTap: () {
                  Navigator.of(ctx).pop();
                  if (!svc.isMessageQueued(s.id, text)) {
                    showAppToast(
                      context,
                      "Can't change: message already processed",
                      isError: true,
                    );
                    return;
                  }
                  svc.deleteQueuedMessage(s, text);
                  svc.sendMessage(
                    s,
                    text == '[image]' ? '' : text,
                    images: pendingImgs,
                    steer: true,
                  );
                  showAppToast(
                    context,
                    'Changed to Steered (guiding current turn)',
                  );
                },
              ),
            ListTile(
              leading: const Icon(Icons.bolt, color: Colors.amber),
              title: const Text('Interrupt agent & send now'),
              subtitle: const Text('Stop current response and run this message immediately'),
              onTap: () {
                Navigator.of(ctx).pop();
                if (!svc.isMessageQueued(s.id, text)) {
                  showAppToast(
                    context,
                    "Can't interrupt: message already processed",
                    isError: true,
                  );
                  return;
                }
                svc.deleteQueuedMessage(s, text);
                svc.cancel(s);
                Future.delayed(const Duration(milliseconds: 80), () {
                  svc.sendMessage(
                    s,
                    text == '[image]' ? '' : text,
                    images: pendingImgs,
                    steer: false,
                  );
                });
                showAppToast(
                  context,
                  'Interrupted agent and running message now',
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
                if (!svc.isMessageQueued(s.id, text)) {
                  showAppToast(
                    context,
                    "Can't delete: message already processed",
                    isError: true,
                  );
                  return;
                }
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
    final historyToolIds = <String>{};
    for (final msg in history) {
      final tools = msg['tools'] as List?;
      if (tools != null) {
        for (final t in tools) {
          if (t is Map) {
            final id = t['id'] as String? ?? t['callId'] as String?;
            if (id != null && id.isNotEmpty) historyToolIds.add(id);
          }
        }
      }
    }
    final liveTools = toolCalls.where((t) {
      final id = t['callId'] as String? ?? t['id'] as String?;
      return id == null || id.isEmpty || !historyToolIds.contains(id);
    }).toList();

    final isWorking = svc.statusFor(widget.sessionId) == 'working';
    final segments = isWorking
        ? svc.streamingSegmentsFor(widget.sessionId)
        : const <String>[];
    for (var i = 0; i < liveTools.length || i < segments.length; i++) {
      if (i < segments.length) {
        items.add(_bubble(segments[i], Alignment.centerLeft, null));
      }
      if (i < liveTools.length) {
        items.add(
          _toolCallCard(
            ToolCallView.fromPayload(liveTools[i], source: ToolCallSource.live),
          ),
        );
      }
    }
    if (streaming != null && isWorking) {
      items.add(_StreamingBubble(text: streaming));
    }
    // Queued messages at the very end — reported by the server, not tracked
    // locally. Image-only messages arrive as the server's '[image]' text.
    // LONG-PRESS clears the queue: pi dequeues by text-match at message_start,
    // so a message can get genuinely stuck in its steering/followUp queues;
    // the server-side queue_clear drains pi's own queue (the honest fix).
    // If a message has already begun processing and landed as the latest
    // user entry in history, skip showing it as a queued duplicate.
    final latestHistoryUser = history.lastWhere(
      (m) => m['role'] == 'user',
      orElse: () => const {},
    );
    final latestHistoryUserText =
        (latestHistoryUser['text'] as String? ?? '').trim();
    var skippedLatestUser = false;

    for (final text in queued) {
      final trimmedText = text.trim();
      if (!skippedLatestUser &&
          latestHistoryUserText.isNotEmpty &&
          (trimmedText == latestHistoryUserText ||
              (latestHistoryUserText == '[image]' &&
                  (text.isEmpty || text == '[image]')))) {
        skippedLatestUser = true;
        continue;
      }
      final localImgs = _pendingImagesByText[text] ?? const <PendingImage>[];
      final serverImgs =
          s?.pendingImagesByText[text] ?? const <PendingImage>[];
      final pendingImgs = localImgs.isNotEmpty ? localImgs : serverImgs;
      final isSteering = (s?.isWorking == true) && (s?.pendingSteering.any((st) => st.trim() == trimmedText) ?? false);
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
            steering: isSteering,
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
