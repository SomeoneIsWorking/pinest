import 'dart:convert';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:file_selector/file_selector.dart';
import 'package:provider/provider.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import '../services/agent_service.dart';
import '../services/paste_bridge.dart';
import '../services/picked_file.dart';
import '../services/file_pick_bridge.dart' show pickUserFiles, readClipboardImages;
import '../services/user_preferences.dart';
import '../models/session.dart';
import '../models/chat_item.dart';

class ChatScreen extends StatefulWidget {
  final String sessionId;
  const ChatScreen({super.key, required this.sessionId});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _input = TextEditingController();
  final _scroll = ScrollController();
  bool _removing = false;
  bool _modelsRequested = false;
  bool _wasWorking = false;
  bool _steer = true; // send mid-turn messages as steer (vs follow-up)
  final List<PendingImage> _attachedImages = [];
  bool _atBottom = true; // track whether user is scrolled to bottom
  final Map<String, int> _prevHistoryLen = {};

  bool get _isMacOS => Theme.of(context).platform == TargetPlatform.macOS;
  String get _sendShortcutLabel => _isMacOS ? '⌘+Enter' : 'Ctrl+Enter';

  Session? _session(AgentService svc) =>
      svc.sessions.where((s) => s.id == widget.sessionId).firstOrNull;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScroll);
    if (kIsWeb) {
      registerImagePasteListener(_onPastedImage);
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
    }
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

  void _onPastedImage(Uint8List bytes, String mimeType) {
    if (!mounted) return;
    setState(() => _attachedImages.add(
          PendingImage(mimeType: mimeType, bytes: bytes),
        ));
    // Observable confirmation that the paste event fired and was captured —
    // an image strip that silently stays empty is indistinguishable from a
    // listener that never fired.
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text('Image attached from clipboard ($mimeType)'),
      duration: const Duration(seconds: 2),
    ));
  }

  /// Attach files via the paperclip. Images become image attachments; small
  /// text files are inlined into the message as fenced blocks; anything else
  /// is refused BY NAME (no silent drops).
  Future<void> _attachFiles() async {
    final files = kIsWeb ? await pickUserFiles() : await _browseNativeFiles();
    await _handlePicked(files);
  }

  /// Explicit clipboard read (web): works even when paste events are
  /// swallowed by the framework, because a button tap is a user gesture.
  Future<void> _pasteClipboardImage() async {
    final files = await readClipboardImages();
    if (files.isEmpty && mounted) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        content: Text(
          'No image read from clipboard. On Firefox/Zen use ⌘V in the '
          'message field instead.',
        ),
      ));
      return;
    }
    await _handlePicked(files);
  }

  Future<List<PickedFile>> _browseNativeFiles() async {
    const images = XTypeGroup(label: 'Images', mimeTypes: [
      'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    ]);
    const texts = XTypeGroup(label: 'Text', mimeTypes: ['text/*']);
    final xfiles = await openFiles(acceptedTypeGroups: [images, texts]);
    return [
      for (final f in xfiles)
        PickedFile(name: f.name, bytes: await f.readAsBytes()),
    ];
  }

  /// Route picked files: images to the attachment strip, small text files
  /// into the message body, everything else refused with a named snackbar.
  Future<void> _handlePicked(List<PickedFile> files) async {
    if (files.isEmpty || !mounted) return;
    const textExt = {
      'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'toml', 'csv', 'log',
      'ts', 'tsx', 'js', 'jsx', 'mjs', 'py', 'rb', 'go', 'rs', 'c', 'h', 'cc',
      'cpp', 'hpp', 'java', 'kt', 'swift', 'sh', 'bash', 'zsh', 'fish', 'html',
      'css', 'scss', 'sql', 'xml', 'dart', 'ini', 'conf', 'env', 'lock',
    };
    final extraText = StringBuffer();
    const imageExt = {'png', 'jpg', 'jpeg', 'gif', 'webp'};
    for (final file in files) {
      final name = file.name;
      final ext = name.contains('.')
          ? name.split('.').last.toLowerCase()
          : '';
      final bytes = file.bytes;
      if (bytes.length > 10 * 1024 * 1024) {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Text('$name is too large (max 10 MB) — skipped')));
        }
        continue;
      }
      if (imageExt.contains(ext)) {
        setState(() => _attachedImages.add(PendingImage(
              mimeType: switch (ext) {
                'png' => 'image/png',
                'gif' => 'image/gif',
                'webp' => 'image/webp',
                _ => 'image/jpeg',
              },
              bytes: bytes,
            )));
      } else if (textExt.contains(ext) && bytes.length <= 512 * 1024) {
        extraText
          ..writeln()
          ..writeln('--- file: $name ---')
          ..writeln('```')
          ..write(utf8.decode(bytes, allowMalformed: true))
          ..writeln()
          ..writeln('```');
      } else {
        if (mounted) {
          ScaffoldMessenger.of(context).showSnackBar(SnackBar(
              content: Text(
                  '$name: unsupported type — images and text files only')));
        }
        continue;
      }
    }
    if (extraText.isNotEmpty) {
      final existing = _input.text;
      _input.text = existing.isEmpty
          ? extraText.toString().trimRight()
          : '$existing\n${extraText.toString().trimRight()}';
    }
  }

  void _send() {
    final text = _input.text.trim();
    final hasImages = _attachedImages.isNotEmpty;
    if (text.isEmpty && !hasImages) return;
    final svc = context.read<AgentService>();
    final s = _session(svc);
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
    for (final msg in history) {
      final role = msg['role'] as String? ?? '';
      final text = msg['text'] as String? ?? '';
      final tools = msg['tools'] as List?;
      if (role == 'user') {
        items.add(
          _bubble(text, Alignment.centerRight, Colors.blueGrey.withAlpha(40)),
        );
      } else {
        // Show tools from history (expandable)
        if (tools != null) {
          for (final t in tools) {
            final tm = Map<String, dynamic>.from(t as Map);
            items.add(
              _ToolCallCard(
                name: tm['name'] ?? 'tool',
                args: tm['args'],
                result: null,
                images: const [],
                isError: false,
                running: false,
              ),
            );
          }
        }
        if (text.isNotEmpty) {
          items.add(_bubble(text, Alignment.centerLeft, null, markdown: true));
        }
      }
    }
    // Live tool calls (not yet in history)
    for (final tc in toolCalls) {
      items.add(
        _ToolCallCard(
          name: tc['name'] ?? 'tool',
          args: tc['args'],
          result: tc['result'] as String?,
          images:
              (tc['images'] as List?)
                  ?.map((i) => Map<String, dynamic>.from(i as Map))
                  .toList() ??
              const [],
          isError: tc['isError'] ?? false,
          running: tc['running'] ?? false,
        ),
      );
    }
    if (streaming != null) {
      items.add(_StreamingBubble(text: streaming));
    }
    // Queued messages at the very end — reported by the server, not tracked
    // locally. Image-only messages arrive as the server's '[image]' text.
    for (final text in queued) {
      items.add(
        _bubble(
          text,
          Alignment.centerRight,
          Colors.orange.withAlpha(40),
          queued: true,
        ),
      );
    }
    return ListView(
      controller: _scroll,
      padding: const EdgeInsets.all(12),
      children: items,
    );
  }

  Widget _toolbar(
    BuildContext context,
    AgentService svc,
    Session? s,
    bool working,
    List<PinestModel> models,
  ) {
    // If models are empty, re-request once (in case the first request lost).
    if (s != null && models.isEmpty && !_modelsRequested) _requestModels();
    return Material(
      color: Theme.of(
        context,
      ).colorScheme.surfaceContainerHighest.withAlpha(80),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        // Horizontal scroll: the button row must never crop on narrow screens.
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          reverse: true,
          child: Row(
            children: [
            // Context window usage
            if (s?.contextPercent != null)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: _ContextBadge(
                  percent: s!.contextPercent!,
                  tokens: s.contextTokens,
                  window: s.contextWindow,
                  modelName: s.modelName ?? s.model,
                  compactAt: s.contextCompactAt,
                ),
              ),
            Expanded(child: Container()),
            _ToolButton(
              label: '/model ${s?.modelName ?? ""}'.trim(),
              onTap: models.isEmpty
                  ? null
                  : () => _showModels(context, svc, models),
            ),
            _ToolButton(
              label: '/thinking ${s?.thinkingLevel ?? "off"}',
              color: (s?.thinkingLevel ?? 'off') != 'off'
                  ? Colors.purple
                  : null,
              onTap: (s == null) ? null : () => _showThinking(context, svc, s),
            ),
            _ToolButton(
              label: '/compact',
              onTap: (working || s == null) ? null : () => svc.compact(s),
            ),
            _ToolButton(
              label: '/clear',
              onTap: (working || s == null) ? null : () => svc.newSession(s),
            ),
            if (!working && s != null && !s.isHost)
              _removing
                  ? const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 10),
                      child: SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    )
                  : _ToolButton(
                      label: '/remove',
                      color: Colors.red,
                      onTap: () => _confirmRemove(context, svc, s),
                    ),
            ],
          ),
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
                      child: const Icon(Icons.close,
                          size: 14, color: Colors.white),
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
    List<PendingImage> images = const [],
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
            if (queued)
              const Padding(
                padding: EdgeInsets.only(bottom: 4),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(Icons.schedule, size: 12, color: Colors.orange),
                    SizedBox(width: 4),
                    Text(
                      'queued',
                      style: TextStyle(fontSize: 10, color: Colors.orange),
                    ),
                  ],
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

class _ToolCallCard extends StatefulWidget {
  final String name;
  final dynamic args;
  final String? result;
  final List<Map<String, dynamic>> images;
  final bool isError;
  final bool running;
  const _ToolCallCard({
    required this.name,
    required this.args,
    required this.result,
    required this.images,
    required this.isError,
    required this.running,
  });

  @override
  State<_ToolCallCard> createState() => _ToolCallCardState();
}

class _ToolCallCardState extends State<_ToolCallCard> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final icon = widget.running
        ? const SizedBox(
            width: 12,
            height: 12,
            child: CircularProgressIndicator(strokeWidth: 1.5),
          )
        : Icon(
            widget.isError ? Icons.error_outline : Icons.check,
            size: 14,
            color: widget.isError ? Colors.red : Colors.green,
          );
    final argStr = widget.args != null
        ? const JsonEncoder.withIndent('  ').convert(widget.args)
        : '';
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 2),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.85,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            InkWell(
              onTap: () => setState(() => _expanded = !_expanded),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      icon,
                      const SizedBox(width: 6),
                      Text(
                        widget.name,
                        style: const TextStyle(
                          fontSize: 12,
                          fontFamily: 'monospace',
                          color: Colors.grey,
                        ),
                      ),
                      const SizedBox(width: 4),
                      Icon(
                        _expanded ? Icons.expand_less : Icons.expand_more,
                        size: 16,
                        color: Colors.grey,
                      ),
                    ],
                  ),
                  // The summary gets its OWN line with the full card width:
                  // one line, ellipsized, character-capped. Squeezing it into
                  // a Flexible next to the name starved it to nothing (cards
                  // that "just say bash") or wrapped into tall blocks.
                  if (argStr.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(left: 20),
                      child: Text(
                        _argSummary(widget.name, widget.args),
                        style: TextStyle(
                          fontSize: 11,
                          fontFamily: 'monospace',
                          color: Colors.grey.shade600,
                        ),
                        maxLines: 1,
                        softWrap: false,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                ],
              ),
            ),
            if (_expanded) ...[
              if (argStr.isNotEmpty)
                Container(
                  margin: const EdgeInsets.only(top: 4),
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: Colors.grey.shade100,
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: SelectableText(
                    argStr,
                    style: TextStyle(
                      fontSize: 11,
                      fontFamily: 'monospace',
                      color: Colors.grey.shade700,
                    ),
                  ),
                ),
              if (widget.result != null)
                Container(
                  margin: const EdgeInsets.only(top: 4),
                  padding: const EdgeInsets.all(8),
                  decoration: BoxDecoration(
                    color: widget.isError
                        ? Colors.red.shade50
                        : Colors.grey.shade100,
                    borderRadius: BorderRadius.circular(6),
                  ),
                  constraints: BoxConstraints(maxHeight: 300),
                  child: SingleChildScrollView(
                    child: SelectableText(
                      widget.result!,
                      style: TextStyle(
                        fontSize: 11,
                        fontFamily: 'monospace',
                        color: widget.isError
                            ? Colors.red.shade700
                            : Colors.grey.shade700,
                      ),
                    ),
                  ),
                ),
              for (final img in widget.images)
                Container(
                  margin: const EdgeInsets.only(top: 4),
                  child: Image.memory(
                    base64Decode(img['data'] as String),
                    width: 200,
                  ),
                ),
            ],
          ],
        ),
      ),
    );
  }

  static const _summaryMaxChars = 160;

  String _argSummary(String toolName, dynamic args) {
    if (args == null) return '';
    String? summary;
    if (args is Map) {
      // Show the most relevant field
      for (final key in [
        'command',
        'path',
        'file',
        'url',
        'query',
        'pattern',
      ]) {
        if (args[key] != null) {
          // Bash commands keep their newlines visible as separators.
          summary = key == 'command'
              ? (args[key] as String).replaceAll('\n', ' ; ').trim()
              : '${args[key]}';
          break;
        }
      }
      summary ??= args.length == 1 ? '${args.values.first}' : null;
    }
    summary ??= '';
    // Hard character cap: long terminal calls must fit one line, not wrap the
    // card into a tall block. The full args stay in the expandable body.
    if (summary.length > _summaryMaxChars) {
      summary = '${summary.substring(0, _summaryMaxChars)}…';
    }
    return summary;
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
