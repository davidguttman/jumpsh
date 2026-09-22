const PROJECT_LABEL_RE = /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const HOST_RE = /^([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/u;

export function classifyHost(value, { domain, dashboardHost }) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255 || value !== value.trim()) {
    return { kind: 'invalid' };
  }

  const match = value.match(HOST_RE);
  if (!match) return { kind: 'invalid' };
  if (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535)) return { kind: 'invalid' };

  const hostname = match[1].toLowerCase();
  const exactDomain = String(domain || '').toLowerCase();
  if (!exactDomain) return { kind: 'invalid' };
  const exactDashboard = String(dashboardHost || `dash.${exactDomain}`).toLowerCase();
  if (hostname === exactDashboard) return { kind: 'management' };

  const suffix = `.${exactDomain}`;
  if (!hostname.endsWith(suffix)) return { kind: 'invalid' };
  const label = hostname.slice(0, -suffix.length);
  if (label.includes('.') || !PROJECT_LABEL_RE.test(label)) return { kind: 'invalid' };
  return { kind: 'project', label };
}
