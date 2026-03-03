import { fileURLToPath } from 'url';
import { parseArgs } from 'node:util';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default async function startDaemon(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      domain: { type: 'string' },
      port: { type: 'string' },
    },
    strict: false,
  });

  if (values.domain) {
    process.env.JUMPSH_DOMAIN = values.domain;
  }

  if (values.port) {
    process.env.JUMPSH_PORT = values.port;
  }

  await import(path.join(__dirname, '..', '..', 'server.js'));
}
