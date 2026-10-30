// «Пинок» роботу IGM: workflow pipeline.yml запускается пушем в data/pipeline/kick.json
// (а не в posts.json). Пишем файл после каждого изменения, которое даёт роботу работу:
// пост ушёл в сборку (rendering), в публикацию (publishing) или отложенный пост стал «пора».
// Мост IGM_BRIDGE_TOKEN умеет только Contents RW, поэтому запуск workflow — через этот файл.
import { ghGetJson, ghPutJson, ReviewError } from './_lib.js';

export const KICK_PATH = 'data/pipeline/kick.json';
const POSTS_PATH = 'data/pipeline/posts.json';
const POST_RE = /^P\d{4,6}$/;
export const KICK_THROTTLE_MS = 60e3;
export const STUCK_MS = 10 * 60e3;
const WORK = ['rendering', 'publishing'];
const BUSY = ['rendering', 'publishing', 'publishing_in_progress'];

const pause = ms => new Promise(r => setTimeout(r, ms));
export const backoff = () => 150 + Math.floor(Math.random() * 450); // 150–600 мс

const sameSet = (a, b) => Array.isArray(a) && a.length === b.length && [...a].sort().every((x, i) => x === b[i]);

// Записать kick.json { at, reason, posts }. Пропуск, если за последние 60 с уже был пинок с теми же постами
export async function kickRobot(reason, ids = [], deps = {}) {
  const get = deps.get || ghGetJson, put = deps.put || ghPutJson, sleep = deps.sleep || pause;
  const now = deps.now ?? Date.now();
  const posts = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(x => POST_RE.test(x)))].sort();
  for (let attempt = 0; ; attempt++) {
    const { data, sha } = await get(KICK_PATH).catch(() => ({ data: null, sha: null }));
    const last = Date.parse(data?.at || '');
    if (Number.isFinite(last) && now - last >= 0 && now - last < KICK_THROTTLE_MS && sameSet(data?.posts, posts)) return { kicked: false, throttled: true, posts };
    const body = { at: new Date(now).toISOString(), reason: String(reason || 'kick').slice(0, 120), posts };
    try {
      await put(KICK_PATH, body, sha || undefined, `pipeline: kick ${posts.join(',') || '-'} (${body.reason})`.slice(0, 200));
      return { kicked: true, at: body.at, posts };
    } catch (err) {
      if (!(err instanceof ReviewError && err.code === 409) || attempt >= 3) throw err;
      await sleep(backoff());
    }
  }
}

// Снимок статусов до изменения, чтобы понять, какие посты получили работу для робота
export const statusSnapshot = state => new Map((state?.posts || []).map(p => [p.id, { status: p.status, scheduled_at: p.scheduled_at || null }]));
export function postsNeedingRobot(before, state, now = Date.now()) {
  const out = [];
  for (const p of state?.posts || []) {
    const b = before.get(p.id);
    const due = p.status === 'scheduled' && p.scheduled_at && Date.parse(p.scheduled_at) <= now;
    if (!WORK.includes(p.status) && !due) continue;
    if (!b || b.status !== p.status || (due && b.scheduled_at !== (p.scheduled_at || null))) out.push(p.id);
  }
  return out;
}

// Раз в 5 минут от Gmail-скрипта: отложенные посты, которым пора, и зависшие сборки/публикации
export async function tickRobot(deps = {}) {
  const get = deps.get || ghGetJson;
  const now = deps.now ?? Date.now();
  const { data } = await get(POSTS_PATH);
  const posts = Array.isArray(data?.posts) ? data.posts : [];
  const due = posts.filter(p => p.status === 'scheduled' && p.scheduled_at && Date.parse(p.scheduled_at) <= now).map(p => p.id);
  const stuck = posts.filter(p => BUSY.includes(p.status) && now - (Date.parse(p.updated_at_utc || '') || 0) > STUCK_MS).map(p => p.id);
  let ids = [...due];
  if (stuck.length) {
    const { data: k } = await get(KICK_PATH).catch(() => ({ data: null }));
    const last = Date.parse(k?.at || '');
    if (!(Number.isFinite(last) && now - last < STUCK_MS)) ids = [...ids, ...stuck];
  }
  if (!ids.length) return { kicked: false, due };
  const r = await kickRobot(due.length ? 'tick: due' : 'tick: stuck', ids, { ...deps, now });
  return { kicked: r.kicked, due };
}
