class BackgroundJob {
  final String id;
  final String? name;
  final String command;
  final String cwd;
  final String? sessionId;
  final int? pid;
  final int startedAt;
  final int? finishedAt;
  final String status;
  final int? exitCode;
  final String? error;
  final String logPath;
  final int totalBytes;

  const BackgroundJob({
    required this.id,
    this.name,
    required this.command,
    required this.cwd,
    this.sessionId,
    this.pid,
    required this.startedAt,
    this.finishedAt,
    required this.status,
    this.exitCode,
    this.error,
    required this.logPath,
    required this.totalBytes,
  });

  factory BackgroundJob.fromJson(Map<String, dynamic> json) {
    return BackgroundJob(
      id: json['id'] as String? ?? '',
      name: json['name'] as String?,
      command: json['command'] as String? ?? '',
      cwd: json['cwd'] as String? ?? '',
      sessionId: json['sessionId'] as String?,
      pid: (json['pid'] as num?)?.toInt(),
      startedAt: (json['startedAt'] as num?)?.toInt() ?? 0,
      finishedAt: (json['finishedAt'] as num?)?.toInt(),
      status: json['status'] as String? ?? 'running',
      exitCode: (json['exitCode'] as num?)?.toInt(),
      error: json['error'] as String?,
      logPath: json['logPath'] as String? ?? '',
      totalBytes: (json['totalBytes'] as num?)?.toInt() ?? 0,
    );
  }

  String get displayName => (name != null && name!.trim().isNotEmpty) ? name!.trim() : command;

  bool get isRunning => status == 'running';
  bool get isCompleted => status == 'completed';
  bool get isFailed => status == 'failed';
  bool get isCancelled => status == 'cancelled';
}
