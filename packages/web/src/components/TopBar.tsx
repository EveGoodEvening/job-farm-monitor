import type { SessionView } from '@jfm/core';
import type { ComponentChildren } from 'preact';
import { logout, refreshFull, stopPolling } from '../api.ts';
import { hostsOf, type Counts } from '../group.ts';
import { setLang, t } from '../i18n.ts';
import { authed, conn, hostFilter, lang, lastOkAt, showEnded, tick } from '../state.ts';
import { formatDuration } from '../time.ts';

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
      <div class="topbar-row">
        <h1 class="brand">
          <span class={`conn conn-${c}`} title={connTitle} aria-hidden="true" />
          {t('appName')}
        </h1>
        <ul class="tally" aria-label="counts">
          <Tally cls="blocked" n={counts.blocked} label={t('state.blocked')} />
          <Tally cls="working" n={counts.working} label={t('state.working')} />
          {counts.stale > 0 && <Tally cls="stale" n={counts.stale} label={t('state.stale')} />}
          {counts.error > 0 && <Tally cls="error" n={counts.error} label={t('state.error')} />}
          <Tally cls="done" n={counts.rest} label={t('section.rest')} />
        </ul>
        <div class="tools">
          <span class={`conn-label conn-label-${c}`} title={connTitle}>
            {t(`conn.${c}`)}
          </span>
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
            {t('logout')}
          </button>
        </div>
      </div>
      <div class="topbar-row filters">
        <div class="chips" role="group" aria-label={t('allHosts')}>
          <Chip active={hostFilter.value === null} onClick={() => (hostFilter.value = null)}>
            {t('allHosts')}
          </Chip>
          {hosts.map((h) => (
            <Chip key={h.host} active={hostFilter.value === h.host} onClick={() => (hostFilter.value = h.host)}>
              {h.blocked > 0 && <span class="dot dot-blocked" aria-hidden="true" />}
              {h.host}
              <span class="chip-n">{h.total}</span>
            </Chip>
          ))}
        </div>
        <label class="toggle">
          <input
            type="checkbox"
            checked={showEnded.value}
            onChange={(e) => {
              showEnded.value = (e.currentTarget as HTMLInputElement).checked;
              refreshFull();
            }}
          />
          {t('showEnded24h')}
        </label>
      </div>
    </header>
  );
}

function Tally({ cls, n, label }: { cls: string; n: number; label: string }) {
  return (
    <li class={`tally-item${n === 0 ? ' zero' : ''}`}>
      <span class={`dot dot-${cls}`} aria-hidden="true" />
      <span class="tally-n">{n}</span>
      <span class="tally-label">{label}</span>
    </li>
  );
}

function Chip(props: { active: boolean; onClick: () => void; children: ComponentChildren }) {
  return (
    <button type="button" class={`chip${props.active ? ' on' : ''}`} aria-pressed={props.active} onClick={props.onClick}>
      {props.children}
    </button>
  );
}
