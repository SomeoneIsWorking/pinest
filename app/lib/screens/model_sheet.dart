import 'package:flutter/material.dart';
import '../models/chat_item.dart';

/// Bottom sheet dialog for searching and selecting available LLM models.
class ModelSheet extends StatefulWidget {
  final List<PinestModel> models;
  final ValueChanged<PinestModel> onPick;

  const ModelSheet({
    super.key,
    required this.models,
    required this.onPick,
  });

  @override
  State<ModelSheet> createState() => _ModelSheetState();
}

class _ModelSheetState extends State<ModelSheet> {
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
