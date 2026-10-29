import type { AgentKind, ProgressLine, SessionView } from '@jfm/core';
import { useEffect, useState } from 'preact/hooks';
import { fetchSession } from '../api.ts';
import { isStale } from '../group.ts';
import { t } from '../i18n.ts';
import { authed } from '../state.ts';
import { absolute, elapsed, relative } from '../time.ts';

const AGENT_BADGE: Record<AgentKind, { mark: string; name: string }> = {
  claude: { mark: 'C', name: 'Claude Code' },
  codex: { mark: 'X', name: 'Codex CLI' },
  omp: { mark: 'π', name: 'oh-my-pi' },
};

interface Props {
  s: SessionView;
  /** Server-clock now (tick-driven), used for stale. */
  now: number;
}

export function SessionCard({ s, now }: Props) {
  const [open, setOpen] = useState(false);
  const stale = isStale(s, now);
  const badge = AGENT_BADGE[s.agent];
  const dot = stale ? 'stale' : s.state;
  const bodyId = `b-${s.key}`;

  return (
    <article class={`card card-${s.state}${stale ? ' is-stale' : ''}${open ? ' is-open' : ''}`}>
      <button type="button" class="card-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
        <span class={`dot dot-${dot}`} title={t(`state.${s.state}`)} aria-hidden="true" />
        <span class={`agent agent-${s.agent}`} title={badge.name}>
          {badge.mark}
          <span class="sr-only">{badge.name}</span>
        </span>
        <span class="project">{s.project ?? s.sessionId.slice(0, 8)}</span>
        <span class="host">{s.host}</span>
        <span class={`title${s.title ? '' : ' muted'}`}>{s.title ?? t('untitled')}</span>
        <span class="age">{relative(s.lastEventAt)}</span>
      </button>
      <div class="card-body" id={bodyId}>
        <Flags s={s} stale={stale} />
        <Body s={s} />
        {open && <Detail s={s} />}
      </div>
    </article>
  );
}

function Flags({ s, stale }: { s: SessionView; stale: boolean }) {
  const subs = s.subagents;
  if (!stale && !s.delayed && subs.length === 0) return null;
  return (
    <div class="flags">
      {stale && <span class="flag flag-stale">{t('stale', { d: elapsed(s.lastEventAt, 1) })}</span>}
      {s.delayed && (
        <span class="flag flag-delayed" title={t('delayedTitle')}>
          {t('delayed')}
        </span>
      )}
      {subs.length > 0 && (
        <span class="flag flag-sub">{t('subagents', { n: subs.length, types: [...new Set(subs.map((x) => x.type))].join(', ') })}</span>
      )}
    </div>
  );
}

function Body({ s }: { s: SessionView }) {
  switch (s.state) {
    case 'working':
      return s.progress.length > 0 ? <Progress lines={s.progress} /> : <p class="muted small">{t('noProgress')}</p>;
    case 'blocked':
      return (
        <div class={`wait wait-${s.stateKind ?? 'permission'}`}>
          <div class="wait-head">
            <strong>{t(s.stateKind === 'question' ? 'kind.question' : 'kind.permission')}</strong>
            <span class="muted">{t('waitingFor', { d: elapsed(s.stateSince) })}</span>
          </div>
          {s.stateMsg && <p class="wait-msg">{s.stateMsg}</p>}
        </div>
      );
    case 'error': {
      const msg = s.stateMsg ?? s.lastMessage;
      return msg ? <p class="msg msg-error clamp">{msg}</p> : null;
    }
    default:
      return s.lastMessage ? <p class={`msg clamp${s.state === 'done' ? '' : ' muted'}`}>{s.lastMessage}</p> : null;
  }
}

function Progress({ lines }: { lines: ProgressLine[] }) {
  return (
    <ol class="progress">
      {lines.map((p, i) => (
        <li key={`${p.ts}-${i}`}>
          <span class="p-text">{p.text}</span>
          <span class="p-age">{elapsed(p.ts, 1)}</span>
        </li>
      ))}
    </ol>
  );
}

type DetailState = { kind: 'loading' } | { kind: 'ok'; v: SessionView } | { kind: 'error' };

function Detail({ s }: { s: SessionView }) {
  const [d, setD] = useState<DetailState>({ kind: 'loading' });

  // Refetch whenever the session moves while expanded.
  useEffect(() => {
    let live = true;
    void fetchSession(s.key).then((r) => {
      if (!live) return;
      if (r.kind === 'ok') setD({ kind: 'ok', v: r.data });
      else if (r.kind === 'unauthorized') authed.value = false;
      else setD((prev) => (prev.kind === 'ok' ? prev : { kind: 'error' }));
    });
    return () => {
      live = false;
    };
  }, [s.key, s.lastEventAt]);

  if (d.kind === 'loading') return <p class="detail muted small">{t('loading')}</p>;
  if (d.kind === 'error') return <p class="detail msg-error small">{t('loadFailed')}</p>;
  const v = d.v;
  return (
    <div class="detail">
      {v.progress.length > 0 && (
        <>
          <h3>{t('detail.progress')}</h3>
          <Progress lines={v.progress} />
        </>
      )}
      {v.lastMessage && (
        <>
          <h3>{t('detail.lastMessage')}</h3>
          <p class="msg full">{v.lastMessage}</p>
        </>
      )}
      <dl class="meta">
        <Row k={t('detail.cwd')} v={v.cwd} />
        <Row k={t('detail.session')} v={v.sessionId} />
        <Row k={t('detail.pane')} v={v.herdrPaneId} />
        <Row k={t('detail.model')} v={v.model} />
        <Row k={t('detail.hostname')} v={v.hostname} />
        <Row k={t('detail.started')} v={`${absolute(v.startedAt)} (${relative(v.startedAt, 1)})`} />
      </dl>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string | null }) {
  if (!v) return null;
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}
