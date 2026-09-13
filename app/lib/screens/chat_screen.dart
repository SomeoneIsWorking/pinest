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
import '../logic/transcript_order.dart';
import '../models/chat_item.dart';
import '../models/tool_call_view.dart';
import 'app_toast.dart';
import 'session_actions.dart';
import 'tool_call_card.dart';
import 'tool_call_group.dart';
import 'thinking_card.dart';
import 'task_notification_card.dart';
import 'message_options_sheet.dart';
import 'background_jobs_sheet.dart';
import '../logic/slash_commands.dart';
import 'composer_bar.dart';

export 'session_actions.dart';
import 'tree_dialog.dart';
import '../models/stream_segment.dart';
import 'message_bubbles.dart';

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
  List<Widget> _chatItems(
    List<Map<String, dynamic>> history,
    String? streaming,
    String? streamingThinking,
    List<Map<String, dynamic>> toolCalls,
    AgentService svc,
    Session? s,
    UserPreferences prefs,
  ) {
    // Server-authoritative queue — the client is a terminal, not the keeper.
    final queued = s?.pendingMessages ?? const <String>[];
    final showThinking = prefs.showThinking;
    final collapseToolCalls = prefs.collapseToolCalls;
    final items = <Widget>[];

    final currentToolBatch = <ToolCallView>[];
    void flushTools() {
      if (currentToolBatch.isEmpty) return;
      if (currentToolBatch.length == 1 || !collapseToolCalls) {
        for (final t in currentToolBatch) {
          items.add(_toolCallCard(t));
        }
      } else {
        items.add(ToolCallGroup(
          key: ValueKey('tools-${currentToolBatch.first.entryId ?? ''}'
              '-${currentToolBatch.first.name}-${currentToolBatch.length}'),
          tools: List.of(currentToolBatch),
        ));
      }
      currentToolBatch.clear();
    }

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
      final timestamp = (msg['timestamp'] as num?)?.toInt() ?? (msg['ts'] as num?)?.toInt();
      final isTaskNotification = (msg['customType'] == 'background-task-notification') ||
          text.trim().startsWith('<background-task-notification>');
      if (isTaskNotification) {
        flushTools();
        items.add(TaskNotificationCard(text: text, timestamp: timestamp));
      } else if (msg['customType'] == 'compaction') {
        flushTools();
        items.add(SystemBubble(text: 'Conversation compacted', timestamp: timestamp));
      } else if (role == 'system') {
        flushTools();
        items.add(SystemBubble(text: text, timestamp: timestamp));
      } else if (role == 'user') {
        flushTools();
        final historyImgs = [
          for (final img in (msg['images'] as List? ?? const []))
            Map<String, dynamic>.from(img as Map),
        ];
        final entryId = msg['id'] as String?;
        void openOptions() {
          if (s == null) return;
          showHistoryMessageOptions(
            context: context,
            svc: svc,
            session: s,
            text: text,
            entryId: entryId,
            historyImages: historyImgs,
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
          );
        }

        items.add(
          MessageBubble(
            text: text,
            align: Alignment.centerRight,
            background: Colors.blueGrey.withAlpha(40),
            historyImages: historyImgs,
            timestamp: timestamp,
            onTap: (s == null) ? null : openOptions,
            onSecondaryTap: (s == null) ? null : openOptions,
            onLongPress: (s == null) ? null : openOptions,
          ),
        );
      } else {
        final thinking = msg['thinking'] as String?;
        if (showThinking && thinking != null && thinking.trim().isNotEmpty) {
          flushTools();
          items.add(ThinkingCard(thinking: thinking));
        }
        if (tools != null) {
          for (final t in tools) {
            currentToolBatch.add(
              ToolCallView.fromPayload(
                Map<String, dynamic>.from(t as Map),
                source: ToolCallSource.history,
              ).atEntry(msg['id'] as String?),
            );
          }
        }
        if (text.isNotEmpty) {
          flushTools();
          final assistantEntry = msg['id'] as String?;
          items.add(MessageBubble(
            text: text,
            align: Alignment.centerLeft,
            markdown: true,
            timestamp: timestamp,
            onLongPress: (s == null || assistantEntry == null || assistantEntry.isEmpty)
                ? null
                : () => _confirmRewind(s, assistantEntry),
          ));
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
        : const <StreamSegment>[];
    // Speech goes where it happened, decided by the segment's own anchor rather
    // than by a position in a list that shrinks as the turn is recorded. See
    // orderStreamAndTools: misplacing this was why cards and paragraphs traded
    // places while a session streamed.
    for (final step in orderStreamAndTools(
      segments: segments,
      liveTools: liveTools,
      historyToolIds: historyToolIds,
    )) {
      if (step.isSpeech) {
        flushTools();
        items.add(MessageBubble(
          text: step.speech!,
          align: Alignment.centerLeft,
          markdown: true,
        ));
      } else {
        currentToolBatch.add(
          ToolCallView.fromPayload(step.tool!, source: ToolCallSource.live),
        );
      }
    }
    flushTools();

    if (showThinking &&
        streamingThinking != null &&
        streamingThinking.trim().isNotEmpty &&
        isWorking) {
      items.add(ThinkingCard(thinking: streamingThinking, isStreaming: true));
    }
    if (streaming != null && isWorking) {
      items.add(StreamingBubble(text: streaming));
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

    // Texts this client sent and is still showing as outgoing bubbles — their
    // bubble carries the queue state, so they are not drawn twice.
    final outgoingTexts = {
      for (final out in svc.outgoingFor(widget.sessionId)) out.text.trim(),
    };
    for (var queuedIndex = 0; queuedIndex < queued.length; queuedIndex++) {
      final text = queued[queuedIndex];
      final trimmedText = text.trim();
      if (!skippedLatestUser &&
          latestHistoryUserText.isNotEmpty &&
          (trimmedText == latestHistoryUserText ||
              (latestHistoryUserText == '[image]' &&
                  (text.isEmpty || text == '[image]')))) {
        skippedLatestUser = true;
        continue;
      }
      // A queued message this client sent is rendered as ITS outgoing bubble
      // (with the queue state), so it is not drawn twice.
      if (outgoingTexts.contains(trimmedText) ||
          (trimmedText == '[image]' && outgoingTexts.contains(''))) {
        continue;
      }
      final localImgs = _pendingImagesByText[text] ?? const <PendingImage>[];
      final serverImgs =
          s?.pendingImagesByText[text] ?? const <PendingImage>[];
      final pendingImgs = localImgs.isNotEmpty ? localImgs : serverImgs;
      final isSteering = (s?.isWorking == true) && (s?.pendingSteering.any((st) => st.trim() == trimmedText) ?? false);
      void openQueuedOptions() {
        if (s == null) return;
        showQueuedMessageOptions(
          context: context,
          svc: svc,
          session: s,
          text: text,
          index: queuedIndex,
          pendingImgs: pendingImgs,
          onEdit: (editedText, restoredImgs) {
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
          onDelete: () {
            _pendingImagesByText.remove(text);
          },
        );
      }

      items.add(
        MessageBubble(
          text: text,
          align: Alignment.centerRight,
          background: Colors.orange.withAlpha(40),
          queued: true,
          steering: isSteering,
          images: pendingImgs,
          onTap: (s == null) ? null : openQueuedOptions,
          onSecondaryTap: (s == null) ? null : openQueuedOptions,
          onLongPress: (s == null) ? null : openQueuedOptions,
        ),
      );
    }
    // Locally-sent messages with no confirmed landing yet. They are shown with a
    // sending/delivered state so a send can never silently vanish — including in
    // the window where pi has dequeued the message but history has not arrived.
    // A message the server already reports as queued keeps ONE bubble (the
    // outgoing one, labelled), never two.
    final queuedTexts = {
      for (final text in queued) text.trim(),
    };
    final sendingNow = svc.wsConnected;
    for (final out in svc.outgoingFor(widget.sessionId)) {
      final delivered = queuedTexts.contains(out.text.trim()) ||
          (out.text.trim().isEmpty && queuedTexts.contains('[image]'));
      // Keep the steer/follow-up distinction the sender chose: it says WHEN pi
      // delivers it (end of step vs end of turn), which "queued" does not.
      final steering = s?.pendingSteering.any((st) => st.trim() == out.text.trim()) ?? out.steer;
      final status = sendStatusFor(
        connected: sendingNow,
        queuedSeen: delivered || out.queuedSeen,
        steer: steering,
        failure: out.failure,
      );
      // An unconfirmed send can be discarded or retried: waiting is not the
      // only answer to "sending…", and a message stuck in a dead socket must be
      // something the user can end.
      void openSendOptions() {
        if (s == null) return;
        showOutgoingSendOptions(
          context: context,
          svc: svc,
          session: s,
          message: out,
        );
      }

      items.add(
        MessageBubble(
          text: out.text.isEmpty ? '[image]' : out.text,
          align: Alignment.centerRight,
          background: Colors.blueGrey.withAlpha(30),
          images: _pendingImagesByText[out.text] ?? const <PendingImage>[],
          statusIcon: status.icon,
          statusLabel: status.label,
          onTap: (s == null) ? null : openSendOptions,
          onLongPress: (s == null) ? null : openSendOptions,
        ),
      );
    }
    // Nested scrollables (expanded tool-output blocks) absorb the drag until
    // they hit their edge; from there the leftover overscroll transfers to the
    // chat list so the finger never gets stuck at the block's boundary.
    return items;
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

  Widget _toolCallCard(ToolCallView tool) {
    final s = _session(context.read<AgentService>());
    final entry = tool.entryId;
    return ToolCallCard(
      key: ValueKey('tool-${entry ?? tool.name}-${tool.timestamp ?? 0}'),
      name: tool.name,
      args: tool.args,
      result: tool.result,
      images: tool.images,
      isError: tool.isError,
      running: tool.running,
      timestamp: tool.timestamp,
      onLongPress: (s == null || entry == null || entry.isEmpty)
          ? null
          : () => _confirmRewind(s, entry),
    );
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


