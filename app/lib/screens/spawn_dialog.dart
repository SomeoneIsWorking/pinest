import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../services/agent_service.dart';

/// Spawn dialog — path autocomplete via server query (the web app can't read
/// the local filesystem, so we ask the extension to list matching dirs).
class SpawnDialog extends StatefulWidget {
  final String? initialCwd;
  final String? initialModel;

  const SpawnDialog({super.key, this.initialCwd, this.initialModel});

  @override
  State<SpawnDialog> createState() => _SpawnDialogState();
}

class _SpawnDialogState extends State<SpawnDialog> {
  final _formKey = GlobalKey<FormState>();
  final _cwdController = TextEditingController();
  late final TextEditingController _modelController;
  List<String> _suggestions = [];
  bool _loading = false;
  bool? _pathValid;
  bool _creatingFolder = false;
  String? _pathError;
  int _pathQueryGeneration = 0;
  int _pathCheckGeneration = 0;

  @override
  void initState() {
    super.initState();
    _cwdController.text = widget.initialCwd ?? '';
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
    _modelController.dispose();
    super.dispose();
  }

  void _onChanged() {
    final input = _cwdController.text.trim();
    if (mounted) {
      setState(() {
        _pathValid = null;
        _pathError = null;
      });
    }
    unawaited(_queryPaths(input));
    if (input.isNotEmpty) _checkPath(input);
  }

  Future<void> _checkPath(String input) async {
    final generation = ++_pathCheckGeneration;
    final svc = context.read<AgentService>();
    final valid = await svc.checkPath(input);
    if (!mounted ||
        generation != _pathCheckGeneration ||
        _cwdController.text.trim() != input) {
      return;
    }
    setState(() => _pathValid = valid);
  }

  Future<void> _createFolder() async {
    final input = _cwdController.text.trim();
    if (input.isEmpty) return;
    setState(() {
      _creatingFolder = true;
      _pathError = null;
    });
    final created = await context.read<AgentService>().createFolder(input);
    if (!mounted) return;
    setState(() {
      _creatingFolder = false;
      _pathValid = created != null;
      _pathError = created == null ? 'Could not create this folder.' : null;
    });
    if (created != null) unawaited(_queryPaths(input));
  }

  Future<void> _queryPaths(String input) async {
    final generation = ++_pathQueryGeneration;
    final svc = context.read<AgentService>();
    setState(() => _loading = true);
    final result = await svc.listPaths(input);
    if (!mounted ||
        generation != _pathQueryGeneration ||
        _cwdController.text.trim() != input) {
      return;
    }
    setState(() {
      _suggestions = result;
      _loading = false;
    });
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
                  validator: (v) {
                    if (v == null || v.trim().isEmpty) return 'Required';
                    if (_pathValid != true) {
                      return _pathValid == null
                          ? 'Checking whether this directory exists…'
                          : 'Directory does not exist. Create it first.';
                    }
                    return null;
                  },
                ),
                if (_pathValid == false &&
                    _cwdController.text.trim().isNotEmpty)
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton.icon(
                      onPressed: _creatingFolder ? null : _createFolder,
                      icon: _creatingFolder
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.create_new_folder_outlined),
                      label: const Text('Create folder'),
                    ),
                  ),
                if (_pathError != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(
                      _pathError!,
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
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
              final model = _modelController.text.trim();
              Navigator.pop(context, {
                'cwd': _cwdController.text.trim(),
                'model': model.isEmpty ? null : model,
              });
            }
          },
          child: const Text('Spawn'),
        ),
      ],
    );
  }
}
