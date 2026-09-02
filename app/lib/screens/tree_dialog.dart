import 'package:flutter/material.dart';
import '../models/session.dart';
import '../models/session_tree.dart';
import '../services/agent_service.dart';
import 'app_toast.dart';

/// Shows the interactive session conversation tree.
void showTreeDialog(BuildContext context, AgentService svc, Session s) {
  showDialog<void>(
    context: context,
    builder: (ctx) => _TreeDialog(svc: svc, session: s),
  );
}

class _TreeDialog extends StatefulWidget {
  final AgentService svc;
  final Session session;

  const _TreeDialog({required this.svc, required this.session});

  @override
  State<_TreeDialog> createState() => _TreeDialogState();
}

class _TreeDialogState extends State<_TreeDialog> {
  bool _loading = true;
  String? _error;
  List<SessionTreeNode> _roots = const [];
  String? _leafId;
  bool _onlyUserMessages = false;
  bool _summarizeBranch = false;

  @override
  void initState() {
    super.initState();
    _loadTree();
  }

  Future<void> _loadTree() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final tree = await widget.svc.fetchSessionTree(widget.session);
      final leaf = widget.svc.leafIdFor(widget.session.id);
      if (mounted) {
        setState(() {
          _roots = tree;
          _leafId = leaf;
          _loading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = e.toString();
          _loading = false;
        });
      }
    }
  }

  Set<String> _computeActivePath(List<SessionTreeNode> roots, String? leafId) {
    if (leafId == null) return const {};
    final active = <String>{};

    bool findLeaf(SessionTreeNode node) {
      if (node.entry.id == leafId) {
        active.add(node.entry.id);
        return true;
      }
      for (final child in node.children) {
        if (findLeaf(child)) {
          active.add(node.entry.id);
          return true;
        }
      }
      return false;
    }

    for (final root in roots) {
      if (findLeaf(root)) break;
    }
    return active;
  }

  List<FlatTreeNode> _flattenNodes(
    List<SessionTreeNode> roots,
    Set<String> activePath,
  ) {
    final list = <FlatTreeNode>[];
    for (final root in roots) {
      list.addAll(root.flatten(depth: 0, activePath: activePath));
    }
    if (_onlyUserMessages) {
      return list
          .where(
            (n) =>
                n.node.entry.role == 'user' ||
                n.node.entry.id == _leafId ||
                n.node.children.length > 1,
          )
          .toList();
    }
    return list;
  }

  Future<void> _navigate(String entryId) async {
    if (entryId == _leafId) {
      showAppToast(context, 'Already at this point in the tree');
      return;
    }
    widget.svc.navigateSessionTree(
      widget.session,
      entryId,
      summarize: _summarizeBranch,
    );
    Navigator.of(context).pop();
    showAppToast(
      context,
      'Navigating tree…',
      duration: const Duration(seconds: 2),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final activePath = _computeActivePath(_roots, _leafId);
    final flatNodes = _flattenNodes(_roots, activePath);

    return Dialog(
      insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      child: Container(
        width: 720,
        height: 640,
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header
            Row(
              children: [
                const Icon(Icons.account_tree, color: Color(0xFF6366F1)),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Session Tree (${widget.session.name})',
                        style: theme.textTheme.titleMedium?.copyWith(
                          fontWeight: FontWeight.bold,
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                      Text(
                        'Explore branch points and navigate the conversation history',
                        style: theme.textTheme.bodySmall?.copyWith(
                          color: Colors.grey,
                        ),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.refresh, size: 20),
                  tooltip: 'Reload tree',
                  onPressed: _loadTree,
                ),
                IconButton(
                  icon: const Icon(Icons.close, size: 20),
                  tooltip: 'Close',
                  onPressed: () => Navigator.of(context).pop(),
                ),
              ],
            ),
            const Divider(height: 24),

            // Controls & options
            Row(
              children: [
                FilterChip(
                  label: const Text('User messages only'),
                  selected: _onlyUserMessages,
                  onSelected: (val) => setState(() => _onlyUserMessages = val),
                ),
                const SizedBox(width: 12),
                FilterChip(
                  label: const Text('Summarize branched context'),
                  selected: _summarizeBranch,
                  onSelected: (val) => setState(() => _summarizeBranch = val),
                ),
                const Spacer(),
                if (flatNodes.isNotEmpty)
                  Text(
                    '${flatNodes.length} node(s)',
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: Colors.grey,
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 12),

            // Main tree view
            Expanded(
              child: _loading
                  ? const Center(child: CircularProgressIndicator())
                  : _error != null
                  ? Center(
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(
                            Icons.error_outline,
                            size: 40,
                            color: theme.colorScheme.error,
                          ),
                          const SizedBox(height: 8),
                          Text('Failed to load session tree: $_error'),
                          const SizedBox(height: 12),
                          OutlinedButton(
                            onPressed: _loadTree,
                            child: const Text('Retry'),
                          ),
                        ],
                      ),
                    )
                  : flatNodes.isEmpty
                  ? const Center(
                      child: Text('No messages or branches in this session yet'),
                    )
                  : ListView.builder(
                      itemCount: flatNodes.length,
                      itemBuilder: (ctx, idx) {
                        final item = flatNodes[idx];
                        final isLeaf = item.node.entry.id == _leafId;
                        return _TreeNodeTile(
                          item: item,
                          isLeaf: isLeaf,
                          onNavigate: () => _navigate(item.node.entry.id),
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

class _TreeNodeTile extends StatelessWidget {
  final FlatTreeNode item;
  final bool isLeaf;
  final VoidCallback onNavigate;

  const _TreeNodeTile({
    required this.item,
    required this.isLeaf,
    required this.onNavigate,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final entry = item.node.entry;
    final role = entry.role ?? entry.type;

    IconData icon;
    Color iconColor;
    if (role == 'user') {
      icon = Icons.person;
      iconColor = const Color(0xFF6366F1);
    } else if (role == 'assistant') {
      icon = Icons.smart_toy;
      iconColor = Colors.greenAccent;
    } else if (role == 'tool' || entry.type.contains('tool')) {
      icon = Icons.build_circle_outlined;
      iconColor = Colors.blueGrey;
    } else {
      icon = Icons.chat_bubble_outline;
      iconColor = Colors.orangeAccent;
    }

    final hasBranches = item.node.children.length > 1;
    final textSnippet = (entry.text ?? '').replaceAll('\n', ' ').trim();
    final displayText = textSnippet.isEmpty ? '[${entry.type}]' : textSnippet;

    return Padding(
      padding: EdgeInsets.only(
        left: (item.depth * 20.0).clamp(0.0, 200.0),
        top: 2,
        bottom: 2,
      ),
      child: Container(
        decoration: BoxDecoration(
          color: isLeaf
              ? Colors.green.withAlpha(25)
              : item.inActivePath
              ? theme.colorScheme.primary.withAlpha(15)
              : Colors.white.withAlpha(5),
          borderRadius: BorderRadius.circular(8),
          border: Border.all(
            color: isLeaf
                ? Colors.green.withAlpha(120)
                : item.inActivePath
                ? theme.colorScheme.primary.withAlpha(60)
                : Colors.white10,
            width: isLeaf ? 1.5 : 1,
          ),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        child: Row(
          children: [
            Icon(icon, size: 16, color: iconColor),
            const SizedBox(width: 8),
            if (hasBranches) ...[
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                decoration: BoxDecoration(
                  color: Colors.amber.withAlpha(40),
                  borderRadius: BorderRadius.circular(4),
                ),
                child: Text(
                  '${item.node.children.length} branches',
                  style: const TextStyle(fontSize: 10, color: Colors.amber),
                ),
              ),
              const SizedBox(width: 6),
            ],
            Expanded(
              child: Text(
                displayText,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 12.5,
                  fontWeight: item.inActivePath
                      ? FontWeight.w600
                      : FontWeight.normal,
                  color: item.inActivePath ? Colors.white : Colors.white70,
                ),
              ),
            ),
            const SizedBox(width: 8),
            if (isLeaf)
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 8,
                  vertical: 3,
                ),
                decoration: BoxDecoration(
                  color: Colors.green.withAlpha(40),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: const Text(
                  'Current Leaf',
                  style: TextStyle(
                    fontSize: 11,
                    color: Colors.greenAccent,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              )
            else
              TextButton(
                onPressed: onNavigate,
                style: TextButton.styleFrom(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 2,
                  ),
                  minimumSize: const Size(50, 26),
                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                ),
                child: const Text('Jump here', style: TextStyle(fontSize: 11)),
              ),
          ],
        ),
      ),
    );
  }
}
