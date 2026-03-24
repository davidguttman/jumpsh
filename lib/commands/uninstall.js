import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

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

  const platform = os.platform();
  const removed = [];

  if (platform === 'darwin') {
    try {
      execSync('launchctl bootout gui/$(id -u)/sh.jump.daemon 2>/dev/null', { stdio: 'ignore' });
      removed.push('Stopped daemon');
    } catch { /* may not be running */ }

    const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'sh.jump.daemon.plist');
    if (fs.existsSync(plistPath)) {
      fs.unlinkSync(plistPath);
      removed.push(`Removed ${plistPath}`);
    }
  } else if (platform === 'linux') {
    try {
      execSync('systemctl --user stop jumpsh 2>/dev/null', { stdio: 'ignore' });
      execSync('systemctl --user disable jumpsh 2>/dev/null', { stdio: 'ignore' });
      removed.push('Stopped and disabled daemon');
    } catch { /* may not be running */ }

    const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', 'jumpsh.service');
    if (fs.existsSync(unitPath)) {
      fs.unlinkSync(unitPath);
      try { execSync('systemctl --user daemon-reload', { stdio: 'ignore' }); } catch { /* best effort */ }
      removed.push(`Removed ${unitPath}`);
    }
  }

  const wrapperPath = path.join(JUMPSH_DIR, 'jumpsh-daemon.sh');
  if (fs.existsSync(wrapperPath)) {
    fs.unlinkSync(wrapperPath);
    removed.push(`Removed ${wrapperPath}`);
  }

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
