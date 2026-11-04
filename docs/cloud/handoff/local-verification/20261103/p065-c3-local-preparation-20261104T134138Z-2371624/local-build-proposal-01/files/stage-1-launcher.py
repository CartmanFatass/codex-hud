#!/usr/bin/env python3
"""PROPOSED ONLY (LOCAL OWNER): P065-on-C3 node24 build stage 1, local paths and tools; no execution admission."""
import ctypes
import hashlib
import json
import os
import signal
import sys
import time
from datetime import datetime, timezone

CHECKOUT = '/LV/p065-c3-local-preparation-20261104T134138Z-2371624/wt-source'
NODE = '/NVM/versions/node/v24.22.1/bin/node'
PYTHON = '/usr/bin/python3'
MANIFEST = '/LV/p065-c3-local-preparation-20261104T134138Z-2371624/p065-local-build-node24-01/manifest.json'
EVIDENCE = '/LV/p065-c3-local-preparation-20261104T134138Z-2371624/p065-local-build-node24-stage-1-evidence-01'
SOURCE = '33dd1bd4ce82c39aa2dceea2d5ce686c02e0faf5'
TREE = 'ef8dc07594d5605eeeb94f3e2bac3e81c80e8822'
EXPECTED = {
    MANIFEST: 'e7a883d1abee980bb320c88a8c26eb2dba1268d31bd7d3763098a883b981c150',
    NODE: 'e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb',
    PYTHON: 'e50d468e8b0adfb05733f5b87b3cff34829c4a8c1aea50c865aa8bdfe4bb150f',
    'node_modules/typescript/package.json': '822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6',
    'node_modules/typescript/bin/tsc': '8d5fa5bd883fec0979fc2004f1fe1d99aef40570155d550eadc0b03b55513bf0',
    'node_modules/typescript/lib/tsc.js': '2cffde0b8c6760dfb0b5b0382bbb7e00ba6a8b2d981b9205b256a700a481d983',
    'node_modules/typescript/lib/_tsc.js': 'e8f349eabd48486bdb2bf9dc1a00c89d58297270c54b745838879e2859194419',
}
ARGV = [NODE, './node_modules/typescript/bin/tsc']
SET_SUBREAPER, GET_SUBREAPER = 36, 37
interrupted = None
log_error = None
log_fd = None


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def emit(kind, **fields):
    global log_error
    record = {'utc': datetime.now(timezone.utc).isoformat(),
              'monotonic_ns': time.monotonic_ns(), 'event': kind, **fields}
    try:
        data = (json.dumps(record, sort_keys=True) + '\n').encode()
        while data:
            n = os.write(log_fd, data)
            if n <= 0:
                raise OSError('short event write')
            data = data[n:]
        os.fsync(log_fd)
    except BaseException as exc:
        log_error = repr(exc)


def on_signal(signum, _frame):
    global interrupted
    if interrupted is None:
        interrupted = signum


def identities():
    actual = {}
    for path, expected in EXPECTED.items():
        full = path if os.path.isabs(path) else os.path.join(CHECKOUT, path)
        value = digest(full)
        actual[path] = value
        if value != expected:
            raise RuntimeError('identity mismatch: ' + path)
    with open(MANIFEST, 'rb') as f:
        manifest = json.load(f)
    if manifest['sourceCommit'] != SOURCE or manifest['sourceTree'] != TREE:
        raise RuntimeError('manifest source mismatch')
    for item in manifest['files'] + manifest['unchangedBuildConfiguration']:
        path = os.path.join(CHECKOUT, item['path'])
        if os.path.islink(path) or os.path.getsize(path) != item['bytes']:
            raise RuntimeError('manifest size or symlink mismatch: ' + item['path'])
        actual[item['path']] = digest(path)
        if actual[item['path']] != item['sha256']:
            raise RuntimeError('manifest hash mismatch: ' + item['path'])
    return actual


def bootstrap():
    if os.path.realpath(CHECKOUT) != CHECKOUT or not os.path.isdir(CHECKOUT):
        raise RuntimeError('checkout path missing or redirected')
    if os.path.lexists(os.path.join(CHECKOUT, 'dist')):
        raise RuntimeError('stage output already exists')
    if os.path.realpath(sys.executable) != os.path.realpath(PYTHON):
        raise RuntimeError('unexpected Python executable')
    actual = identities()
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        raise RuntimeError('pidfd interfaces unavailable')
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    libc.prctl.restype = ctypes.c_int
    if libc.prctl(SET_SUBREAPER, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'PR_SET_CHILD_SUBREAPER')
    enabled = ctypes.c_int(0)
    if libc.prctl(GET_SUBREAPER, ctypes.addressof(enabled), 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'PR_GET_CHILD_SUBREAPER')
    if enabled.value != 1:
        raise RuntimeError('subreaper readback not enabled')
    try:
        pid, status = os.waitpid(-1, os.WNOHANG)
    except ChildProcessError:
        return actual
    raise RuntimeError('owned child before launch: pid=%d status=%d' % (pid, status))


def inventory(root):
    result = []
    if not os.path.lexists(root):
        return result
    if os.path.islink(root) or not os.path.isdir(root):
        raise RuntimeError('output root is not a real directory')
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs.sort()
        files.sort()
        for name in dirs + files:
            path = os.path.join(directory, name)
            rel = os.path.relpath(path, root)
            if os.path.islink(path):
                result.append({'path': rel, 'type': 'symlink', 'target': os.readlink(path)})
            elif os.path.isfile(path):
                result.append({'path': rel, 'type': 'file', 'bytes': os.path.getsize(path), 'sha256': digest(path)})
            elif os.path.isdir(path):
                result.append({'path': rel, 'type': 'directory'})
            else:
                raise RuntimeError('unexpected output entry: ' + rel)
    return result


def main():
    global log_fd
    os.umask(0o077)
    os.mkdir(EVIDENCE, 0o700)
    log_fd = os.open(EVIDENCE + '/events.jsonl', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    out_fd = os.open(EVIDENCE + '/stdout.raw', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    err_fd = os.open(EVIDENCE + '/stderr.raw', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    for name in ('home', 'hud-home', 'tmp'):
        os.mkdir(EVIDENCE + '/' + name, 0o700)
    env = {'HOME': EVIDENCE + '/home', 'HUD_HOME': EVIDENCE + '/hud-home',
           'TMPDIR': EVIDENCE + '/tmp', 'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TZ': 'UTC'}
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)
    emit('initial', supervisor_pid=os.getpid(), python=sys.executable, launcher_sha256=digest(__file__),
         checkout=CHECKOUT, argv=ARGV, environment=env, compile_deadline_seconds=180,
         term_grace_seconds=10, closeout_deadline_seconds=210)
    try:
        if log_error:
            raise RuntimeError('initial evidence failure: ' + log_error)
        before = bootstrap()
        emit('preflight_complete', identities=before, subreaper_readback=1, initial_wait='ECHILD')
        if log_error or interrupted:
            raise RuntimeError('interrupted or evidence failure before launch')
        gate_read, gate_write = os.pipe()
        exec_read, exec_write = os.pipe()
        os.set_blocking(exec_read, False)
    except BaseException as exc:
        emit('not_started', reason=repr(exc))
        return 2
    start = time.monotonic()
    try:
        child = os.fork()
    except BaseException as exc:
        emit('not_started', reason=repr(exc))
        return 2
    if child == 0:
        try:
            os.close(gate_write)
            os.close(exec_read)
            signal.signal(signal.SIGINT, signal.SIG_DFL)
            signal.signal(signal.SIGTERM, signal.SIG_DFL)
            if os.read(gate_read, 1) != b'G':
                raise RuntimeError('launch gate closed')
            os.close(gate_read)
            os.dup2(out_fd, 1)
            os.dup2(err_fd, 2)
            os.close(out_fd)
            os.close(err_fd)
            os.close(log_fd)
            os.chdir(CHECKOUT)
            os.execve(NODE, ARGV, env)
        except BaseException as exc:
            try:
                os.write(exec_write, (repr(exc) + '\n').encode()[:4096])
            finally:
                os._exit(127)
    # Each cleanup operation is isolated so one broken operation cannot starve others.
    direct_status = None
    unexpected = False
    closure = False
    term_at = None
    kill_sent = False
    pidfd = None
    failure = None
    exec_data = b''
    exec_eof = False
    exec_readable = True
    wait_usable = True
    gate_open = True
    released = False
    try:
        os.close(gate_read)
        os.close(exec_write)
        os.close(out_fd)
        os.close(err_fd)
        pidfd = os.pidfd_open(child, 0)
        emit('child_created', pid=child, pidfd_available=True)
        if log_error or interrupted:
            raise RuntimeError('interruption or evidence failure before release')
        os.write(gate_write, b'G')
        released = True
        os.close(gate_write)
        gate_open = False
        emit('launch_released', pid=child)
    except BaseException as exc:
        failure = 'post-fork setup: ' + repr(exc)
    while True:
        elapsed = time.monotonic() - start
        if elapsed >= 180 and direct_status is None:
            failure = failure or 'compile deadline reached before direct status'
        if interrupted:
            failure = failure or ('interrupted by signal %d' % interrupted)
        if log_error:
            failure = failure or ('evidence failure: ' + log_error)
        if gate_open and failure:
            gate_open = False
            try:
                os.close(gate_write)
            except BaseException as exc:
                failure = failure or ('gate close error: ' + repr(exc))
                emit('gate_close_error', error=repr(exc))
        if exec_readable and not exec_eof:
            try:
                data = os.read(exec_read, 4096)
                if data:
                    exec_data += data
                else:
                    exec_eof = True
                    emit('exec_pipe_eof', error=exec_data.decode('utf-8', 'replace'))
            except BlockingIOError:
                pass
            except InterruptedError:
                pass
            except BaseException as exc:
                exec_readable = False
                failure = failure or ('exec pipe error: ' + repr(exc))
                emit('exec_pipe_error', error=repr(exc))
        if wait_usable:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
                if pid:
                    emit('wait_status', pid=pid, status=status,
                         exitcode=os.waitstatus_to_exitcode(status), direct=(pid == child))
                    if pid == child:
                        direct_status = status
                    else:
                        unexpected = True
                        failure = failure or 'unexpected adopted descendant'
            except ChildProcessError:
                closure = True
                emit('wait_echild')
            except InterruptedError:
                pass
            except BaseException as exc:
                wait_usable = False
                failure = failure or ('wait error: ' + repr(exc))
                emit('wait_error', error=repr(exc))
        if closure:
            break
        # Only the unreaped direct child or its pidfd is ever signalled.
        if direct_status is None and failure and term_at is None:
            term_at = time.monotonic()
            try:
                if pidfd is None:
                    raise RuntimeError('no pidfd; direct signal unavailable')
                signal.pidfd_send_signal(pidfd, signal.SIGTERM)
                emit('direct_signal', signal='SIGTERM', elapsed=time.monotonic() - start)
            except BaseException as exc:
                emit('signal_error', signal='SIGTERM', error=repr(exc))
                failure = failure or ('SIGTERM error: ' + repr(exc))
        if direct_status is None and term_at is not None and not kill_sent and time.monotonic() - term_at >= 10:
            kill_sent = True
            try:
                if pidfd is None:
                    raise RuntimeError('no pidfd; direct signal unavailable')
                signal.pidfd_send_signal(pidfd, signal.SIGKILL)
                emit('direct_signal', signal='SIGKILL', elapsed=time.monotonic() - start)
            except BaseException as exc:
                emit('signal_error', signal='SIGKILL', error=repr(exc))
                failure = failure or ('SIGKILL error: ' + repr(exc))
        if time.monotonic() - start >= 210:
            failure = failure or 'closeout deadline reached'
            emit('closeout_deadline', elapsed=time.monotonic() - start)
            break
        try:
            time.sleep(0.05)
        except BaseException as exc:
            failure = failure or ('sleep error: ' + repr(exc))
            emit('sleep_error', error=repr(exc))
    try:
        if exec_readable and not exec_eof:
            try:
                data = os.read(exec_read, 4096)
                if data:
                    exec_data += data
                else:
                    exec_eof = True
            except BlockingIOError:
                pass
        emit('exec_final', released=released, eof=exec_eof,
             error=exec_data.decode('utf-8', 'replace'))
    except BaseException as exc:
        failure = failure or ('exec final error: ' + repr(exc))
        emit('exec_final_error', error=repr(exc))
    for fd in (pidfd, exec_read):
        if fd is not None:
            try:
                os.close(fd)
            except BaseException as exc:
                failure = failure or ('descriptor close error: ' + repr(exc))
                emit('descriptor_close_error', error=repr(exc))
    postcheck_ok = False
    post_error = None
    if closure and direct_status is not None:
        try:
            after = identities()
            output = inventory(os.path.join(CHECKOUT, 'dist'))
            stdout_sha256 = digest(EVIDENCE + '/stdout.raw')
            stderr_sha256 = digest(EVIDENCE + '/stderr.raw')
            postcheck_ok = after == before
            emit('postcheck', identities=after, match_before=postcheck_ok, output=output,
                 stdout_sha256=stdout_sha256, stderr_sha256=stderr_sha256)
            if not postcheck_ok:
                post_error = 'identity postcheck changed'
        except BaseException as exc:
            post_error = 'postcheck exception: ' + repr(exc)
            emit('postcheck_error', error=repr(exc))
    else:
        emit('postcheck_skipped', reason='owned tree closure or direct status unproved')
    lifecycle_valid = bool(closure and direct_status is not None and not unexpected
                           and not interrupted and not log_error and not failure)
    direct_exitcode = os.waitstatus_to_exitcode(direct_status) if direct_status is not None else None
    exec_state = ('reported_failure' if exec_data else
                  'no_error_reported' if released and exec_eof else 'unknown')
    compiler_result = ('not_started_or_exec_failed' if exec_data else
                       'unknown' if not released or not exec_eof or direct_status is None else
                       'exit_status_observed_exec_unverified')
    emit('result', direct_status=direct_status, direct_exitcode=direct_exitcode,
         closure=closure, lifecycle_valid=lifecycle_valid, unexpected_descendant=unexpected,
         interrupted=interrupted, failure=failure, exec_state=exec_state,
         compiler_result=compiler_result, postcheck_ok=postcheck_ok, post_error=post_error)
    if log_error:
        return 2
    os.close(log_fd)
    return 0 if lifecycle_valid and postcheck_ok and exec_state == 'no_error_reported' and direct_exitcode == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
