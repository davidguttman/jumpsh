import { detectDomain, detectPort, detectProtocol, formatDashUrl } from '../domain.js';
import { managementAccessLines } from '../management-auth.js';
import { launchBrowser } from '../browser.js';
import { callDaemon } from './_helpers.js';

// Ask the daemon (with the CLI's bearer credential) for a short-lived,
// single-use login code. The reusable token never leaves this request.
export async function requestLoginCode() {
  const { code } = await callDaemon('/api/login-codes', { method: 'POST', timeoutMs: 5000 });
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(code)) {
    throw new Error('Daemon returned an invalid login code');
  }
  return code;
}

export default async function open(argv, { cwd = process.cwd(), issueCode = requestLoginCode, launch = launchBrowser } = {}) {
  const domain = detectDomain();
  const port = detectPort();
  const protocol = detectProtocol();
  const base = formatDashUrl(domain, port, protocol);

  const destination = argv[0] === 'add' ? `/add?dir=${encodeURIComponent(cwd)}` : '/';
  const visibleUrl = `${base}${destination}`;

  let code = null;
  try {
    code = await issueCode();
  } catch {
    // Daemon down, plaintext transport, or an older daemon: manual login.
  }

  // The code only ever appears in the fragment of the launched URL, never in output.
  const launchUrl = code
    ? `${base}/login?next=${encodeURIComponent(destination)}#code=${code}`
    : visibleUrl;

  console.log(visibleUrl);
  if (!code) for (const line of managementAccessLines()) console.log(line);

  if (!(await launch(launchUrl))) {
    console.error(`Could not open browser. Visit: ${visibleUrl}`);
    if (code) for (const line of managementAccessLines()) console.error(line);
  }
}
