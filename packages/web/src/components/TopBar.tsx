import type { SessionView } from '@jfm/core';
import type { ComponentChildren } from 'preact';
import { logout, refreshFull, stopPolling } from '../api.ts';
import { hostsOf, type Counts } from '../group.ts';
import { setLang, t } from '../i18n.ts';
import { authed, conn, hostFilter, lang, lastOkAt, showEnded, tick } from '../state.ts';
import { formatDuration } from '../time.ts';
import { Logo, SignOut, StatusIcon } from './Icons.tsx';
import { ThemeToggle } from './ThemeToggle.tsx';

interface Props {
  counts: Counts;
  /** Visible sessions (already filtered by the ended window), for the host chips. */
  list: readonly SessionView[];
}

export function TopBar({ counts, list }: Props) {
  const hosts = hostsOf(list);
  const c = conn.value;
  void tick.value; // lastOkAt is client clock: age = Date.now() - lastOkAt
  const connTitle = lastOkAt.value ? t('lastUpdate', { d: formatDuration(Date.now() - lastOkAt.value, 1) }) : '';

  return (
    <header class="topbar">
      <div class="topbar-row row-main">
        <h1 class="brand">
          <Logo />
          <span class="brand-name">{t('appName')}</span>
        </h1>
        <ul class="tally" aria-label={t('tallyLabel')}>
          <Tally cls="blocked" n={counts.blocked} label={t('state.blocked')} />
          <Tally cls="working" n={counts.working} label={t('state.working')} />
          {counts.stale > 0 && <Tally cls="stale" n={counts.stale} label={t('state.stale')} />}
          {counts.error > 0 && <Tally cls="error" n={counts.error} label={t('state.error')} />}
          <Tally
            cls="done"
            n={counts.rest}
            label={t('section.rest')}
            title={counts.inactive > 0 ? t('tallyRestTitle', { n: counts.rest, m: counts.inactive }) : undefined}
          />
        </ul>
        <div class="tools">
          <span class={`conn-label conn-label-${c}`} title={connTitle}>
            {t(`conn.${c}`)}
          </span>
          <ThemeToggle />
          <button
            type="button"
            class="ghost"
            title={t('langSwitchTitle')}
            lang={lang.value === 'zh' ? 'en' : 'zh'}
            onClick={() => setLang(lang.value === 'zh' ? 'en' : 'zh')}
          >
            {t('langSwitch')}
          </button>
          <button
            type="button"
            class="ghost"
            onClick={() => {
              stopPolling();
              void logout().then(() => {
                authed.value = false;
              });
            }}
          >
            <SignOut />
            <span class="btn-label">{t('logout')}</span>
          </button>
        </div>
      </div>
      <div class="topbar-row filters">
        <div class="chips" role="group" aria-label={t('allHosts')}>
          <Chip active={hostFilter.value === null} onClick={() => (hostFilter.value = null)}>
            {t('allHosts')}
          </Chip>
          {hosts.map((h) => (
            <Chip
              key={h.host}
              active={hostFilter.value === h.host}
              extra={h.blocked > 0 ? 'has-blocked' : undefined}
              onClick={() => (hostFilter.value = h.host)}
            >
              {h.blocked > 0 && <StatusIcon kind="blocked" size={12} />}
              {h.host}
              <span class="chip-n">{h.total}</span>
            </Chip>
          ))}
        </div>
        <label class="toggle">
          <input
            type="checkbox"
            role="switch"
            checked={showEnded.value}
            onChange={(e) => {
              showEnded.value = (e.currentTarget as HTMLInputElement).checked;
              refreshFull();
            }}
          />
          <span class="switch" aria-hidden="true" />
          <span class="toggle-label">{t('showEnded24h')}</span>
        </label>
      </div>
    </header>
  );
}

/** The blocked count links to the waiting section while there is something to jump to. */
function Tally({
  cls,
  n,
  label,
  title,
}: {
  cls: 'blocked' | 'working' | 'stale' | 'error' | 'done';
  n: number;
  label: string;
  /** Tooltip, e.g. how many rest cards the count leaves out as possibly exited. */
  title?: string;
}) {
  const inner = (
    <>
      <StatusIcon kind={cls} />
      <span class="tally-n">{n}</span>
      <span class="tally-label">{label}</span>
    </>
  );
  return (
    <li class={`tally-item tally-${cls}${n === 0 ? ' zero' : ''}`} title={title}>
      {cls === 'blocked' && n > 0 ? (
        <a class="tally-in" href="#h-blocked">
          {inner}
        </a>
      ) : (
        <span class="tally-in">{inner}</span>
      )}
    </li>
  );
}

function Chip(props: { active: boolean; extra?: string; onClick: () => void; children: ComponentChildren }) {
  return (
    <button type="button" class={`chip${props.active ? ' on' : ''}${props.extra ? ` ${props.extra}` : ''}`} aria-pressed={props.active} onClick={props.onClick}>
      {props.children}
    </button>
  );
}
