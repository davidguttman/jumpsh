import { fileURLToPath } from 'url';
import { parseArgs } from 'node:util';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default async function startDaemon(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dmg: { type: 'boolean', default: false },
      domain: { type: 'string' },
      port: { type: 'string' },
    },
    strict: false,
  });

  // CLI flags override env vars: --domain > --dmg
  if (values.domain) {
    process.env.JUMPSH_DOMAIN = values.domain;
  } else if (values.dmg) {
    process.env.JUMPSH_DOMAIN = 'dmg.jump.sh';
  }

  if (values.port) {
    process.env.JUMPSH_PORT = values.port;
  }

  await import(path.join(__dirname, '..', '..', 'server.js'));
}
