import 'package:flutter_test/flutter_test.dart';
import 'package:pinest_app/services/correlated_request_broker.dart';
import 'package:pinest_app/services/remote_fs.dart';

void main() {
  group('RemoteFs formatDisplayPath', () {
    test('formats paths relative to home', () {
      expect(RemoteFs.formatDisplayPath('/home/user', '/home/user'), '~');
      expect(RemoteFs.formatDisplayPath('/home/user/project', '/home/user'), '~/project');
      expect(RemoteFs.formatDisplayPath('/var/log', '/home/user'), '/var/log');
      expect(RemoteFs.formatDisplayPath('/var/log', null), '/var/log');
    });
  });

  group('RemoteFs operations', () {
    test('listPaths sends command and decodes response', () async {
      final broker = CorrelatedRequestBroker();
      final sent = <Map<String, dynamic>>[];
      final fs = RemoteFs(
        requests: broker,
        send: (cmd) => sent.add(cmd),
      );

      final future = fs.listPaths('/test');
      expect(sent, hasLength(1));
      expect(sent.first['type'], 'list_paths');
      expect(sent.first['prefix'], '/test');

      final cmdId = sent.first['id'] as String;
      broker.complete(cmdId, {
        'cmdId': cmdId,
        'paths': ['/test/a', '/test/b'],
      });

      final paths = await future;
      expect(paths, ['/test/a', '/test/b']);
    });

    test('checkPath checks directory status', () async {
      final broker = CorrelatedRequestBroker();
      final sent = <Map<String, dynamic>>[];
      final fs = RemoteFs(
        requests: broker,
        send: (cmd) => sent.add(cmd),
      );

      final future = fs.checkPath('/test/dir');
      expect(sent.first['type'], 'path_check');

      final cmdId = sent.first['id'] as String;
      broker.complete(cmdId, {
        'cmdId': cmdId,
        'isDirectory': true,
      });

      expect(await future, isTrue);
    });

    test('createFolder creates and returns path', () async {
      final broker = CorrelatedRequestBroker();
      final sent = <Map<String, dynamic>>[];
      final fs = RemoteFs(
        requests: broker,
        send: (cmd) => sent.add(cmd),
      );

      final future = fs.createFolder('/new/dir');
      expect(sent.first['type'], 'folder_create');

      final cmdId = sent.first['id'] as String;
      broker.complete(cmdId, {
        'cmdId': cmdId,
        'path': '/new/dir',
      });

      expect(await future, '/new/dir');
    });
  });
}
