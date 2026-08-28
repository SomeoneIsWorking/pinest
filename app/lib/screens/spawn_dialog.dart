import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/agent_service.dart';

/// Spawn dialog — path autocomplete via server query (the web app can't read
/// the local filesystem, so we ask the extension to list matching dirs).
class SpawnDialog extends StatefulWidget {
  final String? initialModel;

  const SpawnDialog({super.key, this.initialModel});

  @override
  State<SpawnDialog> createState() => _SpawnDialogState();
}

class _SpawnDialogState extends State<SpawnDialog> {
  final _formKey = GlobalKey<FormState>();
  final _cwdController = TextEditingController();
  final _nameController = TextEditingController();
  late final TextEditingController _modelController;
  List<String> _suggestions = [];
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    _modelController = TextEditingController(
      text: widget.initialModel ?? 'opencode-go/glm-5.3-flash',
    );
    _cwdController.addListener(_onChanged);
    // Trigger initial suggestions (show home dir contents)
    _onChanged();
  }

  @override
  void dispose() {
    _cwdController.dispose();
    _nameController.dispose();
    _modelController.dispose();
    super.dispose();
  }

  void _onChanged() {
    _queryPaths(_cwdController.text);
  }

  void _queryPaths(String input) {
    final svc = context.read<AgentService>();
    // Send a list_paths command; the reply comes back in the state doc's
    // pathSuggestions field for this session. We poll for the result.
    final cmdId = svc.listPaths(input);
    setState(() => _loading = true);
    // Check for the reply after a short delay
    _pollSuggestions(cmdId, input);
  }

  void _pollSuggestions(String cmdId, String input) async {
    final svc = context.read<AgentService>();
    for (var i = 0; i < 10; i++) {
      await Future.delayed(const Duration(milliseconds: 150));
      if (!mounted) return;
      final result = svc.pathSuggestionsFor(cmdId);
      if (result != null) {
        // Only show if the input hasn't changed since the query
        if (_cwdController.text == input) {
          setState(() {
            _suggestions = result;
            _loading = false;
          });
        }
        return;
      }
    }
    if (mounted && _cwdController.text == input) {
      setState(() {
        _suggestions = [];
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Spawn new session'),
      content: Form(
        key: _formKey,
        child: SizedBox(
          width: 460,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                TextFormField(
                  controller: _cwdController,
                  decoration: InputDecoration(
                    labelText: 'Project directory *',
                    hintText: 'workspace/path',
                    border: const OutlineInputBorder(),
                    suffixIcon: _loading
                        ? const Padding(
                            padding: EdgeInsets.all(10),
                            child: SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            ),
                          )
                        : null,
                  ),
                  validator: (v) =>
                      (v == null || v.trim().isEmpty) ? 'Required' : null,
                ),
                if (_suggestions.isNotEmpty)
                  Container(
                    margin: const EdgeInsets.only(top: 4),
                    constraints: const BoxConstraints(maxHeight: 200),
                    decoration: BoxDecoration(
                      border: Border.all(color: Colors.grey.shade300),
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: ListView.builder(
                      shrinkWrap: true,
                      itemCount: _suggestions.length,
                      itemBuilder: (_, i) {
                        final path = _suggestions[i];
                        return ListTile(
                          dense: true,
                          leading: const Icon(Icons.folder, size: 18),
                          title: Text(
                            path,
                            style: const TextStyle(
                              fontFamily: 'monospace',
                              fontSize: 13,
                            ),
                          ),
                          onTap: () {
                            _cwdController.text = path;
                            _cwdController.selection =
                                TextSelection.fromPosition(
                                  TextPosition(offset: path.length),
                                );
                          },
                        );
                      },
                    ),
                  ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _nameController,
                  decoration: const InputDecoration(
                    labelText: 'Name (optional — defaults to folder name)',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _modelController,
                  decoration: const InputDecoration(
                    labelText: 'Model',
                    border: OutlineInputBorder(),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () {
            if (_formKey.currentState!.validate()) {
              Navigator.pop(context, {
                'cwd': _cwdController.text.trim(),
                'name': _nameController.text.trim(),
                'model': _modelController.text.trim(),
              });
            }
          },
          child: const Text('Spawn'),
        ),
      ],
    );
  }
}
