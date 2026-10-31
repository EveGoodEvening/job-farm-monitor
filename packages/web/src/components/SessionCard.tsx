import { INACTIVE_MS, type AgentKind, type ProgressLine, type SessionView } from '@jfm/core';
import { useEffect, useState } from 'preact/hooks';
import { fetchSession } from '../api.ts';
import { isInactive, isStale } from '../group.ts';
import { t } from '../i18n.ts';
import { authed } from '../state.ts';
import { absolute, elapsed, formatDuration, relative } from '../time.ts';
import { Chevron, StatusIcon, type GlyphKind } from './Icons.tsx';

const AGENT_BADGE: Record<AgentKind, { mark: string; name: string }> = {
  claude: { mark: 'C', name: 'Claude Code' },
  codex: { mark: 'X', name: 'Codex CLI' },
  omp: { mark: 'π', name: 'oh-my-pi' },
};

interface Props {
  s: SessionView;
  /** Server-clock now (tick-driven), used for stale and inactive. */
  now: number;
}

export function SessionCard({ s, now }: Props) {
  const [open, setOpen] = useState(false);
  const stale = isStale(s, now);
  // At rest and silent for hours: the agent probably exited without a session_end.
  const inactive = isInactive(s, now);
  const badge = AGENT_BADGE[s.agent];
  // Red wins over stale: a blocked card that went quiet keeps its blocked glyph.
  const glyph: GlyphKind = s.state === 'blocked' ? (s.stateKind === 'question' ? 'question' : 'blocked') : stale ? 'stale' : s.state;
  const bodyId = `b-${s.key}`;

  return (
    <article class={`card card-${s.state}${stale ? ' is-stale' : ''}${inactive ? ' is-inactive' : ''}${open ? ' is-open' : ''}`}>
      <button type="button" class="card-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
        <span class="glyph" title={t(`state.${s.state}`)}>
          <StatusIcon kind={glyph} />
          <span class="sr-only">{t(glyph === 'stale' ? 'state.stale' : `state.${s.state}`)}</span>
        </span>
        <span class={`agent agent-${s.agent}`} title={badge.name}>
          {badge.mark}
          <span class="sr-only">{badge.name}</span>
        </span>
        <span class="project">{s.project ?? s.sessionId.slice(0, 8)}</span>
        <span class="host">{s.host}</span>
        <span class={`title${s.title ? '' : ' muted'}`}>{s.title ?? t('untitled')}</span>
        <span class="age">
          {(s.state === 'error' || s.state === 'idle') && <span class={`state-tag state-tag-${s.state}`}>{t(`state.${s.state}`)}</span>}
          {relative(s.lastEventAt)}
        </span>
        <Chevron />
      </button>
      <div class="card-body" id={bodyId}>
        {/* Fixed-height slots (styles.css) so cards keep their size as state flips. */}
        <div class="card-sum">
          <Flags s={s} stale={stale} inactive={inactive} />
          <Body s={s} />
        </div>
        {open && <Detail s={s} />}
      </div>
    </article>
  );
}

function Flags({ s, stale, inactive }: { s: SessionView; stale: boolean; inactive: boolean }) {
  const subs = s.subagents;
  if (!stale && !inactive && !s.delayed && subs.length === 0) return null;
  return (
    <div class="flags">
      {stale && <span class="flag flag-stale">{t('stale', { d: elapsed(s.lastEventAt, 1) })}</span>}
      {inactive && (
        <span class="flag flag-inactive" title={t('inactiveTitle', { d: formatDuration(INACTIVE_MS, 1) })}>
          {t('inactive', { d: elapsed(s.lastEventAt, 1) })}
        </span>
      )}
      {s.delayed && (
        <span class="flag flag-delayed" title={t('delayedTitle')}>
          {t('delayed')}
        </span>
      )}
      {subs.length > 0 && <SubFlag n={subs.length} types={[...new Set(subs.map((x) => x.type))].join(', ')} />}
    </div>
  );
}

function SubFlag({ n, types }: { n: number; types: string }) {
  const text = t('subagents', { n, types });
  return (
    <span class="flag flag-sub" title={text}>
      <span class="flag-text">{text}</span>
    </span>
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
            <StatusIcon kind={s.stateKind === 'question' ? 'question' : 'blocked'} size={12} />
            <strong>{t(s.stateKind === 'question' ? 'kind.question' : 'kind.permission')}</strong>
            <span class="wait-time">{t('waitingFor', { d: elapsed(s.stateSince) })}</span>
          </div>
          {s.stateMsg && <p class="wait-msg" title={s.stateMsg}>{s.stateMsg}</p>}
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
