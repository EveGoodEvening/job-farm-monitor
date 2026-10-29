import { useEffect } from 'preact/hooks';
import { Login } from './components/Login.tsx';
import { Section } from './components/Section.tsx';
import { TopBar } from './components/TopBar.tsx';
import { countGroups, endedWindowMs, groupSessions, SECTION_ORDER, withinEndedWindow } from './group.ts';
import { t } from './i18n.ts';
import { authed, conn, hostFilter, lang, sessions, showEnded } from './state.ts';
import { now as serverNow } from './time.ts';

export function App() {
  const l = lang.value;
  useEffect(() => {
    document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en';
  }, [l]);

  if (authed.value === null) {
    // Still checking the cookie; on a transient failure bootAuth() keeps retrying.
    return (
      <main class="boot" aria-busy="true">
        {conn.value === 'error' && (
          <p class="muted" role="status">
            {t('conn.error')}
          </p>
        )}
      </main>
    );
  }
  if (!authed.value) return <Login />;
  return <Dashboard />;
}

function Dashboard() {
  const now = serverNow();
  // 304s never re-run the server's ended-window filter, so apply it here too.
  const list = withinEndedWindow(sessions.value, now, endedWindowMs(showEnded.value));
  const g = groupSessions(list, now, hostFilter.value);
  const counts = countGroups(g, now);

  // Waiting sessions show up in the tab title so a background tab still signals.
  useEffect(() => {
    document.title = counts.blocked > 0 ? `(${counts.blocked}) ${t('appName')}` : t('appName');
  }, [counts.blocked]);

  const empty = SECTION_ORDER.every((id) => g[id].length === 0);
  return (
    <>
      <TopBar counts={counts} list={list} />
      <main class="board">
        {empty ? (
          <div class="empty">
            <h2>{hostFilter.value ? t('emptyFiltered') : t('emptyTitle')}</h2>
            {!hostFilter.value && <p class="muted">{t('emptyBody')}</p>}
          </div>
        ) : (
          SECTION_ORDER.map((id) => <Section key={id} id={id} items={g[id]} now={now} />)
        )}
      </main>
    </>
  );
}
