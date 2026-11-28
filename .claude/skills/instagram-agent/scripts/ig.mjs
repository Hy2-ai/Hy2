#!/usr/bin/env node
// Instagram Graph API CLI for the instagram-agent skill.
// Node 18+ only (uses global fetch). No dependencies.
//
// Env:
//   IG_ACCESS_TOKEN  (required)  long-lived token
//   IG_USER_ID       (optional)  Instagram professional account id; resolved via /me when missing
//   IG_API_VERSION   (optional)  default v23.0
//   IG_GRAPH_HOST    (optional)  default https://graph.instagram.com
//                                (use https://graph.facebook.com for Facebook-Login tokens)
//   IG_QUEUE_FILE    (optional)  default <skill dir>/queue.json
//
// Every command prints JSON on stdout. Errors print JSON on stderr and exit 1.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = (process.env.IG_GRAPH_HOST || 'https://graph.instagram.com').replace(/\/+$/, '');
const VERSION = process.env.IG_API_VERSION || 'v23.0';
const QUEUE_FILE = process.env.IG_QUEUE_FILE || join(SKILL_DIR, 'queue.json');
const CAPTION_MAX = 2200;
const HASHTAG_MAX = 30;
const CAROUSEL_MIN = 2;
const CAROUSEL_MAX = 10;
const POLL_INTERVAL_MS = Number(process.env.IG_POLL_INTERVAL_MS || 5000);
const POLL_TIMEOUT_MS = Number(process.env.IG_POLL_TIMEOUT_MS || 10 * 60 * 1000);

class CliError extends Error {
  constructor(message, details) {
    super(message);
    this.details = details;
  }
}

// ---------- argument parsing ----------
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else positional.push(a);
  }
  return { positional, flags };
}

function need(flags, name) {
  const v = flags[name];
  if (v === undefined || v === true || v === '') throw new CliError(`--${name} 값이 필요합니다.`);
  return String(v);
}

// ---------- validation ----------
function assertHttpsUrl(url, label) {
  let u;
  try { u = new URL(url); } catch { throw new CliError(`${label}: 올바른 URL이 아닙니다: ${url}`); }
  if (u.protocol !== 'https:') throw new CliError(`${label}: 공개 https URL이어야 합니다 (Instagram 서버가 직접 내려받습니다): ${url}`);
}

function validateCaption(caption = '') {
  const tags = caption.match(/(^|\s)#[^\s#]+/g) || [];
  if ([...caption].length > CAPTION_MAX) throw new CliError(`캡션이 ${CAPTION_MAX}자를 넘습니다 (${[...caption].length}자).`);
  if (tags.length > HASHTAG_MAX) throw new CliError(`해시태그가 ${HASHTAG_MAX}개를 넘습니다 (${tags.length}개).`);
  return { length: [...caption].length, hashtags: tags.length };
}

async function readCaption(flags) {
  if (flags['caption-file']) return (await readFile(String(flags['caption-file']), 'utf8')).trim();
  if (typeof flags.caption === 'string') return flags.caption;
  return '';
}

// ---------- HTTP ----------
function token() {
  const t = process.env.IG_ACCESS_TOKEN;
  if (!t) throw new CliError('IG_ACCESS_TOKEN 환경변수가 없습니다. references/setup.md 를 보세요.');
  return t;
}

async function graph(method, path, params = {}) {
  const url = new URL(`${HOST}/${VERSION}/${path.replace(/^\/+/, '')}`);
  const body = new URLSearchParams();
  const target = method === 'GET' ? url.searchParams : body;
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') target.set(k, String(v));
  // Token goes in the Authorization header, never in the URL, so it does not leak into logs.
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token()}`, ...(method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) },
    body: method === 'GET' ? undefined : body,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok || data.error) {
    const e = data.error || {};
    throw new CliError(`Graph API 오류 (HTTP ${res.status}): ${e.message || text}`, {
      type: e.type, code: e.code, error_subcode: e.error_subcode, fbtrace_id: e.fbtrace_id,
    });
  }
  return data;
}

let cachedUserId;
async function userId() {
  if (process.env.IG_USER_ID) return process.env.IG_USER_ID;
  if (!cachedUserId) {
    const me = await graph('GET', 'me', { fields: 'user_id,id,username' });
    cachedUserId = me.user_id || me.id;
  }
  return cachedUserId;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForContainer(id) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const s = await graph('GET', id, { fields: 'status_code,status' });
    if (s.status_code === 'FINISHED') return s;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') {
      throw new CliError(`미디어 컨테이너 처리 실패: ${s.status_code}`, { container: id, status: s.status });
    }
    if (Date.now() > deadline) throw new CliError('미디어 처리 대기 시간 초과', { container: id, last: s });
    await sleep(POLL_INTERVAL_MS);
  }
}

async function publishContainer(containerId) {
  await waitForContainer(containerId);
  const uid = await userId();
  const pub = await graph('POST', `${uid}/media_publish`, { creation_id: containerId });
  const media = await graph('GET', pub.id, { fields: 'id,permalink,media_type,timestamp' }).catch(() => ({ id: pub.id }));
  return { published: true, container_id: containerId, media };
}

// ---------- post building (shared by publish + queue) ----------
// A "post spec" is a plain object so it can be stored in the queue file.
async function specFromFlags(kind, flags) {
  const caption = await readCaption(flags);
  const spec = { kind, caption };
  switch (kind) {
    case 'image':
      spec.image_url = need(flags, 'image-url');
      if (flags['alt-text']) spec.alt_text = String(flags['alt-text']);
      break;
    case 'carousel':
      spec.items = need(flags, 'items').split(',').map((s) => s.trim()).filter(Boolean);
      break;
    case 'reel':
      spec.video_url = need(flags, 'video-url');
      if (flags['cover-url']) spec.cover_url = String(flags['cover-url']);
      if (flags['share-to-feed'] !== undefined) spec.share_to_feed = flags['share-to-feed'] !== 'false';
      break;
    case 'story':
      if (flags['image-url']) spec.image_url = String(flags['image-url']);
      else spec.video_url = need(flags, 'video-url');
      break;
    default:
      throw new CliError(`알 수 없는 게시물 종류: ${kind}`);
  }
  return validateSpec(spec);
}

function isVideoUrl(url) {
  return /\.(mp4|mov)(\?|$)/i.test(url);
}

function validateSpec(spec) {
  const info = spec.kind === 'story' ? { length: 0, hashtags: 0 } : validateCaption(spec.caption);
  if (spec.image_url) assertHttpsUrl(spec.image_url, 'image-url');
  if (spec.video_url) assertHttpsUrl(spec.video_url, 'video-url');
  if (spec.cover_url) assertHttpsUrl(spec.cover_url, 'cover-url');
  if (spec.kind === 'carousel') {
    if (spec.items.length < CAROUSEL_MIN || spec.items.length > CAROUSEL_MAX) {
      throw new CliError(`캐러셀은 ${CAROUSEL_MIN}~${CAROUSEL_MAX}장이어야 합니다 (현재 ${spec.items.length}장).`);
    }
    spec.items.forEach((u, i) => assertHttpsUrl(u, `items[${i}]`));
  }
  return { ...spec, _check: info };
}

async function createContainers(spec) {
  const uid = await userId();
  const { kind } = spec;
  if (kind === 'image') {
    const c = await graph('POST', `${uid}/media`, { image_url: spec.image_url, caption: spec.caption, alt_text: spec.alt_text });
    return c.id;
  }
  if (kind === 'reel') {
    const c = await graph('POST', `${uid}/media`, {
      media_type: 'REELS', video_url: spec.video_url, caption: spec.caption,
      cover_url: spec.cover_url, share_to_feed: spec.share_to_feed,
    });
    return c.id;
  }
  if (kind === 'story') {
    const c = await graph('POST', `${uid}/media`, spec.image_url
      ? { media_type: 'STORIES', image_url: spec.image_url }
      : { media_type: 'STORIES', video_url: spec.video_url });
    return c.id;
  }
  if (kind === 'carousel') {
    const children = [];
    for (const u of spec.items) {
      const params = isVideoUrl(u)
        ? { media_type: 'VIDEO', video_url: u, is_carousel_item: true }
        : { image_url: u, is_carousel_item: true };
      const c = await graph('POST', `${uid}/media`, params);
      children.push(c.id);
    }
    for (const id of children) await waitForContainer(id);
    const parent = await graph('POST', `${uid}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: spec.caption });
    return parent.id;
  }
  throw new CliError(`알 수 없는 게시물 종류: ${kind}`);
}

async function publishSpec(spec) {
  const containerId = await createContainers(spec);
  return publishContainer(containerId);
}

// ---------- queue (local scheduling; the API has no native IG scheduling) ----------
async function loadQueue() {
  if (!existsSync(QUEUE_FILE)) return [];
  return JSON.parse(await readFile(QUEUE_FILE, 'utf8'));
}
async function saveQueue(q) {
  await writeFile(QUEUE_FILE, JSON.stringify(q, null, 2) + '\n');
}

function parseWhen(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new CliError(`--at 시간 형식이 잘못되었습니다: ${value} (예: 2026-12-01T19:00:00+09:00)`);
  return d.toISOString();
}

// ---------- commands ----------
const commands = {
  async whoami() {
    return graph('GET', 'me', { fields: 'user_id,id,username,account_type,media_count,followers_count' });
  },

  async limit() {
    const uid = await userId();
    return graph('GET', `${uid}/content_publishing_limit`, { fields: 'quota_usage,config' });
  },

  async publish({ positional, flags }) {
    const kind = positional[1];
    const spec = await specFromFlags(kind, flags);
    if (flags['dry-run'] || !flags.confirm) {
      return {
        dry_run: true,
        note: flags.confirm ? undefined : '실제 게시하려면 사용자 승인 후 --confirm 을 붙여 다시 실행하세요.',
        spec,
      };
    }
    return publishSpec(spec);
  },

  async media({ flags }) {
    const uid = await userId();
    return graph('GET', `${uid}/media`, {
      fields: 'id,caption,media_type,permalink,timestamp,like_count,comments_count',
      limit: flags.limit || 10,
    });
  },

  async comments({ flags }) {
    return graph('GET', `${need(flags, 'media-id')}/comments`, {
      fields: 'id,text,username,timestamp,like_count,hidden,replies{id,text,username,timestamp}',
      limit: flags.limit || 50,
    });
  },

  async reply({ flags }) {
    const message = need(flags, 'message');
    if (!flags.confirm) return { dry_run: true, comment_id: need(flags, 'comment-id'), message, note: '사용자 승인 후 --confirm 을 붙이세요.' };
    return graph('POST', `${need(flags, 'comment-id')}/replies`, { message });
  },

  async hide({ flags }) {
    const hidden = flags.unhide ? 'false' : 'true';
    if (!flags.confirm) return { dry_run: true, comment_id: need(flags, 'comment-id'), hide: hidden, note: '사용자 승인 후 --confirm 을 붙이세요.' };
    return graph('POST', need(flags, 'comment-id'), { hide: hidden });
  },

  async insights({ flags }) {
    if (flags['media-id']) {
      return graph('GET', `${flags['media-id']}/insights`, {
        metric: flags.metric || 'reach,likes,comments,saved,shares,views,total_interactions',
      });
    }
    const uid = await userId();
    return graph('GET', `${uid}/insights`, {
      metric: flags.metric || 'reach,views,accounts_engaged,total_interactions',
      period: flags.period || 'day',
      metric_type: flags['metric-type'] || 'total_value',
      since: flags.since, until: flags.until,
    });
  },

  async queue({ positional, flags }) {
    const sub = positional[1];
    const q = await loadQueue();
    if (sub === 'add') {
      const spec = await specFromFlags(need(flags, 'kind'), flags);
      const item = {
        id: `q_${Date.now().toString(36)}`,
        at: parseWhen(need(flags, 'at')),
        status: 'pending',
        approved: Boolean(flags.confirm),
        spec,
      };
      q.push(item);
      q.sort((a, b) => a.at.localeCompare(b.at));
      await saveQueue(q);
      return { added: item, note: item.approved ? undefined : '승인되지 않은 항목은 run 때 건너뜁니다. 사용자 승인 후 queue approve --id 로 승인하세요.' };
    }
    if (sub === 'list') return q;
    if (sub === 'approve' || sub === 'remove') {
      const id = need(flags, 'id');
      const idx = q.findIndex((x) => x.id === id);
      if (idx < 0) throw new CliError(`큐에 ${id} 항목이 없습니다.`);
      if (sub === 'approve') q[idx].approved = true; else q.splice(idx, 1);
      await saveQueue(q);
      return { ok: true, id, action: sub };
    }
    if (sub === 'run') {
      const now = new Date().toISOString();
      const results = [];
      for (const item of q) {
        if (item.status !== 'pending' || item.at > now) continue;
        if (!item.approved) { results.push({ id: item.id, skipped: '승인 안 됨' }); continue; }
        if (flags['dry-run']) { results.push({ id: item.id, would_publish: item.spec }); continue; }
        try {
          const r = await publishSpec(item.spec);
          Object.assign(item, { status: 'published', published_at: new Date().toISOString(), media: r.media });
          results.push({ id: item.id, ...r });
        } catch (e) {
          Object.assign(item, { status: 'failed', error: e.message });
          results.push({ id: item.id, error: e.message, details: e.details });
        }
        await saveQueue(q); // persist after each item so a crash never re-posts
      }
      return { ran_at: now, results };
    }
    throw new CliError('queue 하위 명령: add | list | approve | remove | run');
  },

  help() {
    return {
      usage: [
        'node ig.mjs whoami',
        'node ig.mjs limit',
        'node ig.mjs publish image    --image-url URL [--caption TEXT | --caption-file F] [--alt-text T] [--confirm]',
        'node ig.mjs publish carousel --items URL1,URL2,... [--caption ...] [--confirm]',
        'node ig.mjs publish reel     --video-url URL [--cover-url URL] [--share-to-feed true|false] [--caption ...] [--confirm]',
        'node ig.mjs publish story    (--image-url URL | --video-url URL) [--confirm]',
        'node ig.mjs media [--limit N]',
        'node ig.mjs comments --media-id ID',
        'node ig.mjs reply --comment-id ID --message TEXT [--confirm]',
        'node ig.mjs hide --comment-id ID [--unhide] [--confirm]',
        'node ig.mjs insights [--media-id ID] [--metric a,b] [--period day] [--since UNIX --until UNIX]',
        'node ig.mjs queue add --kind image|carousel|reel|story --at ISO_TIME ...post flags... [--confirm]',
        'node ig.mjs queue list | approve --id ID | remove --id ID | run [--dry-run]',
      ],
      note: 'publish/reply/hide 는 --confirm 없이는 미리보기(dry run)만 합니다.',
    };
  },
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args.positional[0] || 'help';
  const fn = commands[cmd];
  if (!fn) throw new CliError(`알 수 없는 명령: ${cmd}. 'help' 를 실행해 보세요.`);
  const out = await fn(args);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main().catch((e) => {
  process.stderr.write(JSON.stringify({ error: e.message, details: e.details }, null, 2) + '\n');
  process.exit(1);
});
