import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models/chat_item.dart';
import '../models/session.dart';
import '../services/agent_service.dart';
import '../services/user_preferences.dart';
import 'model_sheet.dart';

/// Below this width the action labels cannot all fit inline, so they move into
/// the slide-in sidebar instead of being scrolled off the right edge.
const double wideBarMinWidth = 620;

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
        final wide = c.maxWidth >= wideBarMinWidth;
        return SizedBox(
          width: double.infinity,
          child: Row(
            mainAxisSize: MainAxisSize.max,
            children: [
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

class ContextBadge extends StatelessWidget {
  final double percent;
  final int? tokens;
  final int? window;
  final String? modelName;
  final int? compactAt;
  final bool isCompacting;
  const ContextBadge({
    super.key,
    required this.percent,
    this.tokens,
    this.window,
    this.modelName,
    this.compactAt,
    this.isCompacting = false,
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
    final sub = [
      ?modelName,
      if (compactAt != null)
        'compact @ ${(compactAt! / 1000).toStringAsFixed(0)}k',
      if (isCompacting) 'compacting…',
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

/// Narrow-screen home for the toolbar actions: a panel that slides in from
/// the right edge, same actions, same enabled/disabled state.
Future<void> showSessionActionSidebar(
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
                            ? Colors.grey.withAlpha(80)
                            : (a.color ??
                                Theme.of(ctx).colorScheme.onSurface),
                      ),
                    ),
                    dense: true,
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
  );
}

void showModelsSheet(
  BuildContext context,
  AgentService svc,
  Session s, {
  List<PinestModel>? models,
}) {
  svc.listModels(s);
  showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    builder: (_) => Consumer<AgentService>(
      builder: (ctx, agentSvc, _) {
        final liveModels = agentSvc.modelsFor(s.id);
        final effectiveModels =
            liveModels.isNotEmpty ? liveModels : (models ?? const []);
        return ModelSheet(
          models: effectiveModels,
          onPick: (m) {
            agentSvc.setModel(s, m.provider, m.id);
            ctx.read<UserPreferences>().saveModel('${m.provider}/${m.id}');
            Navigator.pop(ctx);
          },
        );
      },
    ),
  );
}

void showThinkingSheet(BuildContext context, AgentService svc, Session s) {
  const levels = ['off', 'low', 'medium', 'high', 'max'];
  final current = s.thinkingLevel ?? 'off';
  final onDefault = s.thinkingLevel == null || s.thinkingLevel == 'default';
  showModalBottomSheet<void>(
    context: context,
    builder: (ctx) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.all(16),
            child: Text(
              'Thinking level',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
            ),
          ),
          ListTile(
            leading: Icon(
              Icons.auto_fix_high,
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
              ctx.read<UserPreferences>().saveThinking('default');
              Navigator.pop(ctx);
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
                ctx.read<UserPreferences>().saveThinking(l);
                Navigator.pop(ctx);
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

void confirmContextAction(
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

void confirmRemoveSession(
  BuildContext context,
  AgentService svc,
  Session s, {
  VoidCallback? onRemoving,
  VoidCallback? onRemoved,
}) {
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
          onPressed: () async {
            Navigator.pop(context);
            onRemoving?.call();
            svc.despawnSession(s);
            final deadline = DateTime.now().add(const Duration(seconds: 10));
            final sid = s.id;
            while (DateTime.now().isBefore(deadline)) {
              if (!svc.sessions.any((x) => x.id == sid)) break;
              await Future.delayed(const Duration(milliseconds: 300));
            }
            onRemoved?.call();
          },
          child: const Text('Remove'),
        ),
      ],
    ),
  );
}

List<BarAction> buildSessionBarActions({
  required BuildContext context,
  required AgentService svc,
  required Session? session,
  required bool working,
  List<PinestModel> models = const [],
  bool isRemoving = false,
  VoidCallback? onRemoving,
  VoidCallback? onRemoved,
}) {
  final s = session;
  return <BarAction>[
    BarAction(
      label: '/model ${s?.modelName ?? s?.model ?? ""}'.trim(),
      icon: Icons.memory,
      onTap: (s == null) ? null : () => showModelsSheet(context, svc, s, models: models),
    ),
    BarAction(
      label: '/thinking ${s?.thinkingLevel ?? "off"}',
      icon: Icons.psychology,
      color: (s?.thinkingLevel ?? 'off') != 'off' ? Colors.purple : null,
      onTap: (s == null) ? null : () => showThinkingSheet(context, svc, s),
    ),
    BarAction(
      label: '/compact',
      icon: Icons.compress,
      onTap: (working || s == null)
          ? null
          : () => confirmContextAction(
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
          : () => confirmContextAction(
              context,
              title: 'Clear session?',
              body:
                  'Starts a fresh session with an empty context. '
                  'The current conversation is dropped from this session.',
              action: 'Clear',
              onConfirm: () => svc.newSession(s),
            ),
    ),
    if (s != null && !s.isHost)
      BarAction(
        label: '/remove',
        icon: Icons.delete_outline,
        color: Colors.red,
        onTap: isRemoving
            ? null
            : () => confirmRemoveSession(
                context,
                svc,
                s,
                onRemoving: onRemoving,
                onRemoved: onRemoved,
              ),
      ),
  ];
}
