import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
export function stateHome() {
  return process.env.PI_COLLAB_HOME || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'collaborate');
}
export function socketPath(home, piId) {
  // macOS Unix socket paths must fit in 104 bytes; never derive a socket from project cwd.
  const hash = createHash('sha256').update(home + '\0' + piId).digest('hex').slice(0, 24);
  return join('/tmp', `pi-collab-${process.getuid?.() ?? 'user'}-${hash}.sock`);
}
export function codexSocket() {
  return process.env.PI_COLLAB_CODEX_SOCKET || join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock');
}
