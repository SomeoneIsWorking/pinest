/// Slash commands typed into the chat composer.
///
/// Pure data + matching; execution lives in `screens/session_actions.dart`
/// (`runSlashCommand`) because it opens dialogs and drives services.
class SlashCommandSpec {
  /// Text inserted/executed verbatim, e.g. `/compact` or `/autocompact `.
  final String usage;

  /// True when the command needs arguments typed after [usage] — selecting it
  /// only inserts the text; argument-less commands run immediately.
  final bool takesArg;

  final String description;

  const SlashCommandSpec(this.usage, this.description, {this.takesArg = false});

  bool get hasArg => usage.contains('<') || takesArg;
}

const List<SlashCommandSpec> slashCommandCatalog = [
  SlashCommandSpec('/compact', 'Replace the context with a summary'),
  SlashCommandSpec('/clear', 'Start a fresh session'),
  // A pi command, not an app feature: pinest registers /goal and hands the
  // objective to the agent, so the composer only has to offer it.
  SlashCommandSpec('/goal <objective>', 'State the objective to work toward', takesArg: true),
  SlashCommandSpec('/model', 'Change the model'),
  SlashCommandSpec('/thinking', 'Change the thinking level'),
  SlashCommandSpec(
    '/autocompact <300k>',
    'Set the auto-compact threshold (tokens, e.g. 300k)',
    takesArg: true,
  ),
];

/// Suggestions for a partially typed first token (the input starts with `/`
/// and has no space yet). Empty when nothing matches or the input is already
/// an exact, fully-typed command.
List<SlashCommandSpec> matchSlashCommands(String input) {
  if (!input.startsWith('/') || input.contains(' ')) return const [];
  final query = input.toLowerCase();
  final matches = slashCommandCatalog
      .where((c) => c.usage.toLowerCase().startsWith(query) || c.usage.toLowerCase().startsWith('$query '))
      .toList();
  if (matches.length == 1 && matches.single.usage.trim().toLowerCase() == query.trim().toLowerCase() && !query.endsWith(' ')) {
    return const [];
  }
  return matches;
}
