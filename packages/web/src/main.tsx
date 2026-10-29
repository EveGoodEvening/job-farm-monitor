import { render } from 'preact';
import { bootAuth, startPolling, tokenFromHash } from './api.ts';
import { App } from './app.tsx';
import { initLang } from './i18n.ts';
import { startTicker } from './time.ts';
import './styles.css';

async function boot(): Promise<void> {
  // First visit via `#token=<READ_TOKEN>`: log in, then scrub the token from the URL.
  const token = tokenFromHash(location.hash);
  if (token !== null) history.replaceState(null, '', location.pathname + location.search);
  // Retries transient /api/login and /api/me failures; only a 401 shows <Login/>.
  if (await bootAuth(token)) startPolling();
}

initLang();
startTicker();
const root = document.getElementById('app');
if (root) render(<App />, root);
void boot();
