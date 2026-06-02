import os from 'os';
import path from 'path';
import { removeDaemonOnly } from '../daemon-service.js';

const JUMPSH_DIR = path.join(os.homedir(), '.jump.sh');

export default async function uninstall(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: jump.sh uninstall

Remove the jump.sh daemon service.

State directory (~/.jump.sh) is kept. To fully remove:
  rm -rf ~/.jump.sh
`);
    process.exit(0);
  }

  const removed = removeDaemonOnly();

  if (removed.length === 0) {
    console.log('Nothing to uninstall.');
  } else {
    for (const msg of removed) {
      console.log(`  ${msg}`);
    }
    console.log(`\nState directory kept: ${JUMPSH_DIR}`);
    console.log('To fully remove, run: rm -rf ~/.jump.sh');
  }
}
