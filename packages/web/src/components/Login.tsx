import { useState } from 'preact/hooks';
import { login, startPolling } from '../api.ts';
import { setLang, t } from '../i18n.ts';
import { authed, lang } from '../state.ts';
import { Logo, StatusIcon } from './Icons.tsx';

export function Login() {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<'wrong' | 'network' | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    const v = token.trim();
    if (!v || busy) return;
    setBusy(true);
    setErr(null);
    const r = await login(v);
    setBusy(false);
    if (r === 'ok') {
      setToken('');
      authed.value = true;
      startPolling();
    } else {
      setErr(r);
    }
  }

  return (
    <main class="login">
      <form class="login-box" onSubmit={(e) => void submit(e)}>
        <div class="login-top">
          <Logo size={22} />
          <span class="brand-sm">{t('appName')}</span>
          <button type="button" class="ghost" onClick={() => setLang(lang.value === 'zh' ? 'en' : 'zh')}>
            {t('langSwitch')}
          </button>
        </div>
        <h1>{t('loginTitle')}</h1>
        <p class="muted">{t('loginBody')}</p>
        <label for="tok">{t('loginLabel')}</label>
        <input
          id="tok"
          type="password"
          autocomplete="current-password"
          spellcheck={false}
          value={token}
          onInput={(e) => setToken((e.currentTarget as HTMLInputElement).value)}
          aria-invalid={err === 'wrong'}
          aria-describedby={err ? 'login-err' : undefined}
          autofocus
        />
        {err && (
          <p id="login-err" class="msg-error small" role="alert">
            <StatusIcon kind="error" size={12} />
            {t(err === 'wrong' ? 'loginWrong' : 'loginNetwork')}
          </p>
        )}
        <button type="submit" class="primary" disabled={busy || token.trim() === ''}>
          {t(busy ? 'loginBusy' : 'loginSubmit')}
        </button>
      </form>
    </main>
  );
}
