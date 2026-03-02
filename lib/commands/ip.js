import os from 'os';

export default async function ip(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Usage: jumpsh ip

Print the machine's LAN IP address.
`);
    process.exit(0);
  }

  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log(iface.address);
        return;
      }
    }
  }

  console.error('No external IPv4 address found.');
  process.exit(1);
}
