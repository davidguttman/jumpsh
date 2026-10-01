// Standalone login page. It is served before authentication, so it cannot use
// the (protected) dashboard stylesheet and inlines a minimal copy of the theme.

function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

export function renderLoginPage({ next = '/', error = null, tokenPath = '~/.jump.sh/management-token' } = {}) {
  const alert = error
    ? `<p class="alert" role="alert">${escapeHtml(error)}</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>jump.sh — connect</title>
<style>
:root {
  --bg-check-a: #80d890;
  --bg-check-b: #68a8d8;
  --panel-bg: #161616;
  --text: #d0d4d0;
  --text-muted: #8a9292;
  --text-bright: #eef0ee;
  --accent-gold: #d8c830;
  --accent-cyan: #48c8f0;
  --accent-red: #f04040;
  --border-inner: #505058;
  --font: 'AppleKid', 'Silkscreen', 'ChicagoFLF', 'Chicago', 'Menlo', 'Courier New', monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 16px;
  font-family: var(--font);
  color: var(--text);
  background-color: #74c0b4;
  background-image: repeating-conic-gradient(var(--bg-check-a) 0% 25%, var(--bg-check-b) 0% 50%);
  background-size: 32px 32px;
  line-height: 1.6;
}
main {
  width: 100%;
  max-width: 420px;
  background: var(--panel-bg);
  border: 4px solid var(--accent-gold);
  box-shadow: 0 0 0 4px var(--panel-bg), 8px 8px 0 4px rgba(0, 0, 0, 0.35);
  padding: 1.75rem 1.5rem 1.5rem;
}
h1 {
  font-size: 1rem;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--text-bright);
  margin-bottom: 0.25rem;
}
.hint { font-size: 0.8rem; color: var(--text-muted); margin-bottom: 1.25rem; }
.hint code { color: var(--accent-cyan); word-break: break-all; }
label { display: block; font-size: 0.8rem; color: var(--text-bright); margin-bottom: 0.35rem; }
input[type="password"] {
  width: 100%;
  padding: 0.6rem 0.7rem;
  font: inherit;
  font-size: 0.9rem;
  color: var(--text-bright);
  background: #22242e;
  border: 2px solid var(--border-inner);
  border-radius: 0;
}
input[type="password"]:focus { outline: none; border-color: var(--accent-cyan); }
.remember { display: flex; align-items: center; gap: 0.5rem; margin: 1rem 0 1.25rem; font-size: 0.8rem; }
.remember label { margin: 0; color: var(--text); }
.remember input { width: 1rem; height: 1rem; accent-color: var(--accent-gold); }
button {
  width: 100%;
  padding: 0.65rem;
  font: inherit;
  font-size: 0.9rem;
  letter-spacing: 1px;
  text-transform: uppercase;
  color: var(--panel-bg);
  background: var(--accent-gold);
  border: 0;
  cursor: pointer;
}
button:hover, button:focus-visible { background: #f0e050; outline: none; }
.alert {
  margin-bottom: 1rem;
  padding: 0.5rem 0.7rem;
  font-size: 0.8rem;
  color: var(--text-bright);
  border-left: 4px solid var(--accent-red);
  background: rgba(240, 64, 64, 0.15);
}
</style>
</head>
<body>
<main>
  <h1>jump.sh</h1>
  <p class="hint">Paste your management token from <code>${escapeHtml(tokenPath)}</code>.</p>
  ${alert}
  <form method="post" action="/login">
    <input type="hidden" name="next" value="${escapeHtml(next)}">
    <label for="token">Token</label>
    <input id="token" name="token" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false" required autofocus>
    <div class="remember">
      <input id="remember" name="remember" type="checkbox">
      <label for="remember">Remember this device</label>
    </div>
    <button type="submit">Connect</button>
  </form>
</main>
</body>
</html>
`;
}
