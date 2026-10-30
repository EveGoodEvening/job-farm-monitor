import type { SessionView } from '@jfm/core';
import type { SectionId } from '../group.ts';
import { t } from '../i18n.ts';
import { showEnded } from '../state.ts';
import { Chevron, StatusIcon } from './Icons.tsx';
import { SessionCard } from './SessionCard.tsx';

interface Props {
  id: SectionId;
  items: SessionView[];
  now: number;
}

const G = { blocked: 'blocked', working: 'working', rest: 'done', ended: 'ended' } as const;

/** One priority band. The ended band is a collapsed <details>. */
export function Section({ id, items, now }: Props) {
  if (items.length === 0) return null;
  const title = t(`section.${id}`);
  const cards = (
    <div class="cards">
      {items.map((s) => (
        <SessionCard key={s.key} s={s} now={now} />
      ))}
    </div>
  );

  if (id === 'ended') {
    return (
      <details class={`section section-${id}`}>
        <summary class="section-head">
          <Chevron />
          <StatusIcon kind="ended" />
          <h2>{title}</h2>
          <span class="section-n">{items.length}</span>
          <span class="section-hint">{t(showEnded.value ? 'section.endedHint.24h' : 'section.endedHint.1h')}</span>
        </summary>
        {cards}
      </details>
    );
  }

  return (
    <section class={`section section-${id}`} aria-labelledby={`h-${id}`}>
      <div class="section-head">
        <StatusIcon kind={G[id]} />
        <h2 id={`h-${id}`}>{title}</h2>
        <span class="section-n">{items.length}</span>
      </div>
      {cards}
    </section>
  );
}
