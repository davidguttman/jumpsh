import { EventEmitter } from 'node:events';

export function createMockSpawner({ exitCode = 0, stdout = '', stderr = '' } = {}) {
  const calls = [];
  const spawner = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 12345;
    child.kill = () => {};
    process.nextTick(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', exitCode);
    });
    return child;
  };
  spawner.calls = calls;
  return spawner;
}
