import { t } from '../i18n.ts';
import { themePref } from '../state.ts';
import { nextThemePref, setThemePref } from '../theme.ts';
import { ThemeIcon } from './Icons.tsx';

/** Icon button cycling follow-system -> light -> dark; the icon shows the current choice. */
export function ThemeToggle() {
  const cur = themePref.value;
  const next = nextThemePref(cur);
  const label = t('themeTitle', { cur: t(`theme.${cur}`), next: t(`theme.${next}`) });
  return (
    <button type="button" class="ghost icon-btn" title={label} aria-label={label} onClick={() => setThemePref(next)}>
      <ThemeIcon pref={cur} />
    </button>
  );
}
