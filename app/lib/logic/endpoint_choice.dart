/// Which endpoint a dial attempt should use.
///
/// The server reports its own loopback endpoint in every state frame. When the
/// browser runs on the host's machine, that endpoint needs no tunnel, no DNS,
/// and no third-party hop - so it is tried first. It is only tried once per
/// server generation: a browser that is NOT on the host's machine gets an
/// instant connection refusal, and retrying a refused loopback forever would
/// leave that browser staring at "reconnecting" while a working endpoint sat
/// unused. A new generation (a different local port) resets the choice.
Uri? pickEndpoint({
  required Uri? local,
  required Uri? remote,
  Uri? lastFailedLocal,
}) {
  if (local != null && local != lastFailedLocal) return local;
  return remote;
}
