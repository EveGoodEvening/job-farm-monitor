// zh/en dictionary. `t(key)` follows the `lang` signal, so components that call
// it re-render on a language switch. Choice persists in localStorage["jfm.lang"].
import { LANG_STORAGE_KEY } from '@jfm/core';
import { lang } from './state.ts';

export type Lang = 'zh' | 'en';
export const LANGS: readonly Lang[] = ['zh', 'en'];

const en = {
  appName: 'job-farm-monitor',
  // states
  'state.idle': 'Idle',
  'state.working': 'Working',
  'state.blocked': 'Waiting',
  'state.done': 'Done',
  'state.error': 'Error',
  'state.ended': 'Ended',
  'state.stale': 'Stale',
  'kind.permission': 'Needs permission',
  'kind.question': 'Needs an answer',
  // sections
  'section.blocked': 'Waiting for you',
  'section.working': 'Working',
  'section.rest': 'Done / idle',
  'section.ended': 'Ended',
  'section.endedHint.1h': 'last hour',
  'section.endedHint.24h': 'last 24 hours',
  // badges / time
  stale: 'no update for {d}',
  delayed: 'delayed',
  delayedTitle: 'Events arrived more than 60 s after they happened',
  ago: '{d} ago',
  justNow: 'just now',
  waitingFor: 'waiting {d}',
  subagents: '↳ {n}: {types}',
  // top bar
  allHosts: 'All hosts',
  showEnded24h: 'Ended: 24 h',
  'conn.connecting': 'Connecting',
  'conn.live': 'Live',
  'conn.error': 'Connection lost',
  'conn.paused': 'Paused',
  lastUpdate: 'Last update {d} ago',
  langSwitch: '中文',
  langSwitchTitle: 'Switch to Chinese',
  logout: 'Sign out',
  // cards
  untitled: 'No prompt yet',
  noProgress: 'No activity yet',
  expand: 'Show details',
  loading: 'Loading…',
  loadFailed: 'Could not load details.',
  'detail.cwd': 'Directory',
  'detail.session': 'Session id',
  'detail.pane': 'herdr pane',
  'detail.started': 'Started',
  'detail.model': 'Model',
  'detail.hostname': 'Hostname',
  'detail.lastMessage': 'Last reply',
  'detail.progress': 'Recent activity',
  tallyLabel: 'Session counts',
  // empty
  emptyTitle: 'No agent sessions yet',
  emptyBody: 'Install the hooks on a machine with local/install.sh; new sessions appear here within seconds.',
  emptyFiltered: 'No sessions on this host.',
  // login
  loginTitle: 'Sign in to the dashboard',
  loginBody: 'Paste the read token (READ_TOKEN) configured on the server.',
  loginLabel: 'Read token',
  loginSubmit: 'Sign in',
  loginBusy: 'Signing in…',
  loginWrong: 'That token was not accepted. Check READ_TOKEN on the server and try again.',
  loginNetwork: 'Could not reach the server. Check the connection and try again.',
} as const;

export type MsgKey = keyof typeof en;

const zh: Record<MsgKey, string> = {
  appName: 'job-farm-monitor',
  'state.idle': '空闲',
  'state.working': '进行中',
  'state.blocked': '等待中',
  'state.done': '完成',
  'state.error': '出错',
  'state.ended': '已结束',
  'state.stale': '无更新',
  'kind.permission': '等待授权',
  'kind.question': '等待回答',
  'section.blocked': '等待处理',
  'section.working': '进行中',
  'section.rest': '完成 / 空闲',
  'section.ended': '已结束',
  'section.endedHint.1h': '近 1 小时',
  'section.endedHint.24h': '近 24 小时',
  stale: '无更新 {d}',
  delayed: '延迟送达',
  delayedTitle: '事件送达时间比发生时间晚 60 秒以上',
  ago: '{d}前',
  justNow: '刚刚',
  waitingFor: '已等待 {d}',
  subagents: '↳ {n} 个 subagent：{types}',
  allHosts: '全部机器',
  showEnded24h: '已结束：24 小时',
  'conn.connecting': '连接中',
  'conn.live': '在线',
  'conn.error': '连接中断',
  'conn.paused': '已暂停',
  lastUpdate: '上次更新 {d}前',
  langSwitch: 'EN',
  langSwitchTitle: 'Switch to English',
  logout: '退出登录',
  untitled: '尚无 prompt',
  noProgress: '暂无进展',
  expand: '展开详情',
  loading: '加载中…',
  loadFailed: '详情加载失败。',
  'detail.cwd': '目录',
  'detail.session': '会话 id',
  'detail.pane': 'herdr pane',
  'detail.started': '开始于',
  'detail.model': '模型',
  'detail.hostname': '主机名',
  'detail.lastMessage': '最后回复',
  'detail.progress': '最近进展',
  tallyLabel: '会话统计',
  emptyTitle: '还没有 agent 会话',
  emptyBody: '在机器上运行 local/install.sh 安装 hook，新会话几秒内就会出现在这里。',
  emptyFiltered: '这台机器上没有会话。',
  loginTitle: '登录仪表盘',
  loginBody: '粘贴服务端配置的读 token（READ_TOKEN）。',
  loginLabel: '读 token',
  loginSubmit: '登录',
  loginBusy: '登录中…',
  loginWrong: 'token 不正确。请核对服务端的 READ_TOKEN 后重试。',
  loginNetwork: '无法连接服务器，请检查网络后重试。',
};

export const DICTS: Record<Lang, Record<MsgKey, string>> = { en, zh };

export type Params = Record<string, string | number>;

/** Pure lookup + `{name}` interpolation. Unknown params stay as-is. */
export function translate(l: Lang, key: MsgKey, params?: Params): string {
  const s = DICTS[l][key];
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

/** Translate in the current language (subscribes the caller to `lang`). */
export function t(key: MsgKey, params?: Params): string {
  return translate(lang.value, key, params);
}

/** Stored choice wins; otherwise Chinese iff the browser language starts with "zh". */
export function detectLang(stored: string | null | undefined, navLang: string | null | undefined): Lang {
  if (stored === 'zh' || stored === 'en') return stored;
  return navLang?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** Set `lang` from localStorage / navigator.language. Call once at startup. */
export function initLang(): void {
  let stored: string | null;
  try {
    stored = storage()?.getItem(LANG_STORAGE_KEY) ?? null;
  } catch {
    stored = null;
  }
  lang.value = detectLang(stored, typeof navigator === 'undefined' ? undefined : navigator.language);
}

export function setLang(l: Lang): void {
  lang.value = l;
  try {
    storage()?.setItem(LANG_STORAGE_KEY, l);
  } catch {
    // private mode / blocked storage: keep the in-memory choice only
  }
}
