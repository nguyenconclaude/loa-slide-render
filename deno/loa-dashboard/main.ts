/**
 * Nc9Loa Dashboard v2 — Deno Deploy edition.
 *
 * Migrated from Cloudflare Worker (cloudflare/workers/loa-dashboard/src/index.ts)
 * Reason: CF KV free tier 1000 writes/day too low. Deno KV: 10k writes/day.
 *
 * Routes (mirror Worker):
 *   GET  /                       → mobile UI HTML inline
 *   GET  /api/v2/digest          → all cards single round-trip
 *   GET  /api/v2/cards/:id       → drill-down per card
 *   POST /api/v2/sync-batch      → VM batch upload all cards (X-Sync-Key auth)
 *   POST /api/v2/sync/:key       → VM legacy single-card upload
 *   POST /api/v2/actions/:id     → enqueue action (X-Action-Key auth)
 *   GET  /api/v2/actions/:id     → poll action result
 *   GET  /api/v2/queue           → VM polls queue (X-Sync-Key auth)
 *   POST /api/v2/queue/clear     → VM clears queue
 *   GET  /api/v2/health          → status
 *
 * Env vars (Deno Deploy dashboard):
 *   DASHBOARD_TOKEN — single secret for both X-Sync-Key + X-Action-Key
 */

const CARD_IDS = [
  // Inbox
  "quick_actions", "drafts_ready", "drafts_blocked", "discovery",
  // Library
  "posts_archive", "calendar", "quota",
  // System
  "mode", "pulse", "resources", "security", "cost",
  // Roadmap
  "backlog", "shipped", "decisions",
] as const;

const CARD_SECTION: Record<string, string> = {
  quick_actions: "inbox", drafts_ready: "inbox", drafts_blocked: "inbox", discovery: "inbox",
  posts_archive: "library", calendar: "library", quota: "library",
  mode: "system", pulse: "system", resources: "system", security: "system", cost: "system",
  backlog: "roadmap", shipped: "roadmap", decisions: "roadmap",
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Sync-Key, X-Action-Key",
};

const DEDUP_WINDOW_MS = 5 * 60 * 1000;
const TOKEN = Deno.env.get("DASHBOARD_TOKEN") || "";

// Lazy init KV — opens connection on first request
let kvInstance: Deno.Kv | null = null;
async function kv(): Promise<Deno.Kv> {
  if (!kvInstance) kvInstance = await Deno.openKv();
  return kvInstance;
}

// Helper: read JSON from KV (single key as array)
async function kvGet<T>(key: string): Promise<T | null> {
  const k = await kv();
  const r = await k.get<T>([key]);
  return r.value;
}

// Helper: write JSON to KV with TTL in seconds
async function kvSet(key: string, value: unknown, ttlSec = 86400 * 7): Promise<void> {
  const k = await kv();
  await k.set([key], value, { expireIn: ttlSec * 1000 });
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

function checkSyncAuth(req: Request): boolean {
  if (!TOKEN) return false;
  return (req.headers.get("X-Sync-Key") || "") === TOKEN;
}

function checkActionAuth(req: Request): boolean {
  if (!TOKEN) return true;
  return (req.headers.get("X-Action-Key") || "") === TOKEN;
}

// ─── Handlers ───

async function handleDigest(): Promise<Response> {
  const batch = await kvGet<{ ts: string; cards: Record<string, unknown>[] }>("cards:all");
  let cards: Record<string, unknown>[];
  let lastSync: string | null = null;

  if (batch && Array.isArray(batch.cards)) {
    cards = batch.cards.map((c) => {
      const id = (c.card_id as string) || "?";
      (c as Record<string, unknown>).section = CARD_SECTION[id] || "system";
      return c;
    });
    lastSync = batch.ts || null;
  } else {
    cards = await Promise.all(
      CARD_IDS.map(async (id) => {
        const data = await kvGet<Record<string, unknown>>(`card:${id}`);
        const card = data ?? { card_id: id, status: "missing", headline: "Chưa có dữ liệu", evidence: [], actions: [] };
        (card as Record<string, unknown>).section = CARD_SECTION[id] || "system";
        return card;
      })
    );
    const meta = await kvGet<{ ts: string }>("meta:last_sync");
    lastSync = meta?.ts ?? null;
  }

  return jsonResponse({
    ts: new Date().toISOString(),
    last_sync: lastSync,
    cards,
    sections: ["inbox", "library", "system", "roadmap"],
    backend: "deno-deploy",
  });
}

async function handleCardDetail(id: string): Promise<Response> {
  if (!CARD_IDS.includes(id as typeof CARD_IDS[number])) {
    return jsonResponse({ error: "unknown_card" }, 404);
  }
  const data = await kvGet(`card:${id}`);
  if (!data) return jsonResponse({ error: "no_data", card_id: id }, 404);
  return jsonResponse(data);
}

async function handleActionEnqueue(actionId: string, body: string): Promise<Response> {
  let payload: Record<string, unknown> = {};
  if (body) { try { payload = JSON.parse(body); } catch { /* ok */ } }

  const queue = (await kvGet<Array<Record<string, unknown>>>("action_queue")) || [];

  const now = Date.now();
  for (const q of queue) {
    if (q.action_id === actionId && q.enqueued_at) {
      const ts = new Date(q.enqueued_at as string).getTime();
      if (now - ts < DEDUP_WINDOW_MS) {
        return jsonResponse({ ok: true, ack_id: q.ack_id, deduped: true,
                              note: "Action đã được queue trong 5 phút qua" });
      }
    }
  }

  const ackId = `act_${now}_${Math.random().toString(36).slice(2, 8)}`;
  queue.push({ ack_id: ackId, action_id: actionId, payload,
                enqueued_at: new Date().toISOString(), status: "pending" });
  try {
    await kvSet("action_queue", queue, 86400);
    await kvSet(`action:${ackId}:result`, { status: "pending" }, 86400);
  } catch (e) {
    return jsonResponse({ error: "kv_write_fail", detail: String(e).slice(0, 100) }, 503);
  }
  return jsonResponse({ ok: true, ack_id: ackId });
}

async function handleActionPoll(ackId: string): Promise<Response> {
  const data = await kvGet(`action:${ackId}:result`);
  if (!data) return jsonResponse({ error: "not_found", ack_id: ackId }, 404);
  return jsonResponse(data);
}

async function handleSyncBatch(body: string): Promise<Response> {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return jsonResponse({ error: "invalid_json" }, 400); }
  await kvSet("cards:all", parsed, 86400 * 7);
  return jsonResponse({ ok: true, bytes: body.length });
}

async function handleSyncSingle(key: string, body: string): Promise<Response> {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return jsonResponse({ error: "invalid_json" }, 400); }
  await kvSet(key, parsed, 86400 * 7);
  if (key.startsWith("card:")) {
    await kvSet("meta:last_sync", { ts: new Date().toISOString(), key }, 86400 * 7);
  }
  return jsonResponse({ ok: true, key, bytes: body.length });
}

async function handleQueueGet(): Promise<Response> {
  const queue = (await kvGet("action_queue")) || [];
  return jsonResponse({ queue });
}

async function handleQueueClear(): Promise<Response> {
  await kvSet("action_queue", [], 86400);
  return jsonResponse({ ok: true });
}

async function handleHealth(): Promise<Response> {
  const meta = await kvGet<{ ts: string }>("meta:last_sync");
  const batch = await kvGet<{ ts: string }>("cards:all");
  return jsonResponse({
    status: "ok",
    backend: "deno-deploy",
    last_sync: meta?.ts ?? null,
    cards_last_batch: batch?.ts ?? null,
  });
}

// ─── HTML UI (inline, same as Worker) ───

const HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Loa · Foodquest</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Lora:wght@700&display=swap&subset=vietnamese,latin" rel="stylesheet">
<style>
:root {
  --bg: #0a0c0a; --surface: #14171a; --surface-2: #1c2024;
  --text: #e8e6df; --text-dim: #9aa3a8;
  --accent: #d2af82; --accent-dim: #8a6f3f;
  --good: #5eb96b; --warn: #d4a356; --critical: #e07058;
  --border: rgba(255,255,255,0.07);
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text);
  font-family: 'Inter', -apple-system, system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
body { padding: env(safe-area-inset-top) 0 env(safe-area-inset-bottom); max-width: 480px; margin: 0 auto; }
header { padding: 20px 20px 8px; display: flex; justify-content: space-between; align-items: baseline; }
h1 { font-family: 'Lora', serif; font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
.last-sync { font-size: 11px; color: var(--text-dim); letter-spacing: 0.05em; text-transform: uppercase; }
.refresh { background: none; border: none; color: var(--accent); padding: 6px 10px; font-size: 12px; cursor: pointer;
  letter-spacing: 0.08em; text-transform: uppercase; }
.refresh:active { opacity: 0.5; }
.tabs { display: flex; gap: 4px; padding: 0 16px; margin-bottom: 12px; position: sticky; top: 0;
  background: var(--bg); z-index: 10; padding-top: 6px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
.tab { flex: 1; background: none; border: none; color: var(--text-dim); padding: 10px 8px; font-size: 11px;
  cursor: pointer; font-family: inherit; letter-spacing: 0.16em; text-transform: uppercase; font-weight: 500;
  border-bottom: 2px solid transparent; transition: all 0.15s; }
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.tab .tab-badge { display: inline-block; background: var(--critical); color: #fff; font-size: 9px;
  border-radius: 8px; padding: 1px 6px; margin-left: 4px; vertical-align: middle; letter-spacing: 0; }
main { padding: 0 16px 60px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
  padding: 18px; margin-bottom: 14px; }
.card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.dot.good { background: var(--good); box-shadow: 0 0 6px var(--good); }
.dot.warn { background: var(--warn); }
.dot.critical { background: var(--critical); box-shadow: 0 0 8px var(--critical); }
.dot.missing { background: var(--text-dim); }
.card-title { font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-dim); flex: 1; }
.headline { font-size: 17px; line-height: 1.35; font-weight: 500; margin: 0 0 12px; color: var(--text); }
.evidence { display: flex; flex-direction: column; gap: 8px; margin: 0 0 14px; }
.ev-row { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; }
.ev-label { color: var(--text-dim); }
.ev-value { color: var(--text); font-variant-numeric: tabular-nums; text-align: right; }
.recommendation { font-size: 13px; line-height: 1.5; color: var(--accent); border-left: 2px solid var(--accent-dim);
  padding: 6px 0 6px 12px; margin: 6px 0 14px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.btn { background: var(--surface-2); border: 1px solid var(--border); color: var(--text); padding: 9px 14px;
  border-radius: 8px; font-size: 13px; cursor: pointer; font-family: inherit; letter-spacing: 0.02em; }
.btn:active { transform: scale(0.97); }
.btn.primary { background: var(--accent); color: #1a1410; border-color: var(--accent); font-weight: 500; }
.btn.danger { color: var(--critical); }
footer { text-align: center; font-size: 11px; color: var(--text-dim); padding: 16px; letter-spacing: 0.08em; }
.empty { padding: 24px; text-align: center; color: var(--text-dim); font-size: 13px; }
.list { display: flex; flex-direction: column; margin: 6px -2px 4px; }
.list-row { padding: 12px 14px; background: var(--surface-2); border-radius: 8px; margin-bottom: 6px;
  display: flex; flex-direction: column; gap: 2px; cursor: pointer; position: relative;
  border: 1px solid var(--border); }
.list-row:active { background: rgba(210,175,130,0.1); transform: scale(0.99); }
.list-main { font-size: 14px; font-weight: 500; color: var(--text); padding-right: 20px; }
.list-sub { font-size: 11px; color: var(--text-dim); letter-spacing: 0.05em; }
.list-arrow { position: absolute; right: 14px; top: 50%; transform: translateY(-50%);
  color: var(--accent-dim); font-size: 18px; }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: flex-end;
  justify-content: center; z-index: 1000; padding: 12px; backdrop-filter: blur(4px); }
.modal-box { background: var(--surface); border: 1px solid var(--border); border-radius: 14px;
  width: 100%; max-width: 480px; max-height: 80vh; overflow: hidden; display: flex; flex-direction: column; }
.modal-head { display: flex; justify-content: space-between; align-items: center; padding: 16px 18px;
  border-bottom: 1px solid var(--border); }
.modal-close { background: none; border: none; color: var(--text-dim); font-size: 22px; cursor: pointer;
  padding: 0 6px; line-height: 1; }
.modal-close:active { color: var(--text); }
.modal-body { padding: 16px 18px; overflow-y: auto; font-size: 13px; line-height: 1.5; }
.r-row { padding: 6px 0; border-bottom: 1px solid var(--border); }
.r-row:last-child { border-bottom: none; }
.r-row b { color: var(--accent); font-weight: 600; }
.r-dim { color: var(--text-dim); font-size: 11px; margin-left: 8px; }
.r-pre { background: var(--bg); border-radius: 6px; padding: 10px; font-size: 11px; overflow-x: auto;
  font-family: ui-monospace, monospace; color: var(--text-dim); margin: 6px 0; }
.r-section { font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-dim);
  margin: 14px 0 6px; font-weight: 600; }
.meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px;
  font-size: 12px; line-height: 1.4; }
.meta-grid b { color: var(--accent); font-weight: 600; }
.draft-image { width: 100%; border-radius: 8px; margin: 8px 0; max-height: 180px; object-fit: cover; }
.slides-strip { display: flex; gap: 6px; overflow-x: auto; padding: 4px 0; }
.slide-thumb-wrap { flex-shrink: 0; }
.slide-thumb { width: 70px; height: 88px; object-fit: cover; border-radius: 6px; border: 1px solid var(--border); }
.caption-box { background: var(--bg); border-radius: 8px; padding: 12px; font-size: 13px; line-height: 1.5;
  white-space: pre-wrap; max-height: 180px; overflow-y: auto; color: var(--text); border: 1px solid var(--border); }
.list-row-loading { opacity: 0.5; pointer-events: none; }
.list-row-loading::after { content: '⏳'; position: absolute; right: 38px; top: 50%; transform: translateY(-50%); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
.chip { background: var(--surface-2); border: 1px solid var(--border); border-radius: 12px;
  padding: 4px 10px; font-size: 11px; color: var(--accent); letter-spacing: 0.05em; }
a.btn { display: inline-block; text-decoration: none; }
</style>
</head>
<body>
<header>
  <h1>Foodquest</h1>
  <button class="refresh" onclick="loadDigest()">Reload</button>
</header>
<div class="last-sync" id="lastSync" style="padding: 0 20px; margin-bottom: 8px;"></div>
<nav class="tabs" id="tabs">
  <button class="tab active" data-section="inbox">Inbox</button>
  <button class="tab" data-section="library">Library</button>
  <button class="tab" data-section="system">System</button>
  <button class="tab" data-section="roadmap">Roadmap</button>
</nav>
<main id="cards">
  <div class="empty">Loading...</div>
</main>
<footer>v2 · deno-deploy · story-first</footer>
<script>
const STATUS_ORDER = ['critical','warn','good','missing'];
let _allCards = [];
let _activeSection = localStorage.getItem('loa_section') || 'inbox';
async function loadDigest() {
  try {
    const r = await fetch('/api/v2/digest', { cache: 'no-store' });
    const d = await r.json();
    document.getElementById('lastSync').textContent = d.last_sync ? 'Sync: ' + new Date(d.last_sync).toLocaleString('vi-VN') : 'Chưa sync';
    _allCards = d.cards || [];
    updateTabBadges();
    setSection(_activeSection);
  } catch (e) {
    document.getElementById('cards').innerHTML = '<div class="empty">Error: ' + e.message + '</div>';
  }
}
function updateTabBadges() {
  for (const t of document.querySelectorAll('.tab')) {
    const sec = t.dataset.section;
    const critN = _allCards.filter(c => c.section === sec && (c.status === 'critical' || c.status === 'warn')).length;
    const existing = t.querySelector('.tab-badge');
    if (existing) existing.remove();
    if (critN > 0) {
      const b = document.createElement('span');
      b.className = 'tab-badge';
      b.textContent = critN;
      t.appendChild(b);
    }
  }
}
function setSection(sec) {
  _activeSection = sec;
  localStorage.setItem('loa_section', sec);
  for (const t of document.querySelectorAll('.tab')) {
    t.classList.toggle('active', t.dataset.section === sec);
  }
  const filtered = _allCards.filter(c => c.section === sec);
  render(filtered);
}
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => setSection(t.dataset.section));
});
function render(cards) {
  cards.sort((a,b) => STATUS_ORDER.indexOf(a.status||'missing') - STATUS_ORDER.indexOf(b.status||'missing'));
  const html = cards.map(card => {
    const status = card.status || 'missing';
    const ev = (card.evidence || []).map(e =>
      \`<div class="ev-row"><span class="ev-label">\${escapeHtml(e.label||'')}</span><span class="ev-value">\${escapeHtml(e.value||'')}</span></div>\`
    ).join('');
    const items = (card.items || []).map(it =>
      \`<div class="list-row" onclick="trigger('\${escapeAttr(it.action_id)}', this, true)">
        <div class="list-main">\${escapeHtml(it.label||'')}</div>
        <div class="list-sub">\${escapeHtml(it.sublabel||'')}</div>
        <span class="list-arrow">›</span>
      </div>\`
    ).join('');
    const actions = (card.actions || []).map(a =>
      \`<button class="btn \${a.style||''}" onclick="trigger('\${escapeAttr(a.id)}', this)">\${escapeHtml(a.label||'Action')}</button>\`
    ).join('');
    const rec = card.recommendation ? \`<div class="recommendation">\${escapeHtml(card.recommendation)}</div>\` : '';
    return \`<div class="card">
      <div class="card-head">
        <span class="dot \${status}"></span>
        <span class="card-title">\${escapeHtml(card.title || card.card_id || '')}</span>
      </div>
      \${card.headline ? \`<div class="headline">\${escapeHtml(card.headline)}</div>\` : ''}
      \${ev ? \`<div class="evidence">\${ev}</div>\` : ''}
      \${items ? \`<div class="list">\${items}</div>\` : ''}
      \${rec}
      \${actions ? \`<div class="actions">\${actions}</div>\` : ''}
    </div>\`;
  }).join('');
  document.getElementById('cards').innerHTML = html || '<div class="empty">No cards</div>';
}
function getActionKey() {
  let k = localStorage.getItem('loa_action_key');
  if (!k) {
    k = prompt('Action key (chỉ paste 1 lần, lưu trong trình duyệt):');
    if (k) localStorage.setItem('loa_action_key', k.trim());
  }
  return k || '';
}
async function trigger(actionId, btn, isListItem = false) {
  const orig = isListItem ? '' : btn.textContent;
  if (!isListItem) { btn.textContent = '...'; btn.disabled = true; }
  else { btn.classList.add('list-row-loading'); }
  try {
    const key = getActionKey();
    const r = await fetch('/api/v2/actions/' + encodeURIComponent(actionId), {
      method: 'POST',
      headers: key ? { 'X-Action-Key': key } : {},
    });
    if (r.status === 401) {
      localStorage.removeItem('loa_action_key');
      if (!isListItem) { btn.textContent = 'auth'; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000); }
      else { btn.classList.remove('list-row-loading'); }
      return;
    }
    const d = await r.json();
    if (!d.ack_id) {
      if (!isListItem) { btn.textContent = 'fail'; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000); }
      else { btn.classList.remove('list-row-loading'); }
      return;
    }
    if (!isListItem) btn.textContent = '⏳';
    pollResult(d.ack_id, btn, orig, isListItem);
  } catch (e) {
    if (!isListItem) { btn.textContent = 'fail'; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000); }
    else { btn.classList.remove('list-row-loading'); }
  }
}
async function pollResult(ackId, btn, origLabel, isListItem = false) {
  const start = Date.now();
  const maxWait = 180000;
  while (Date.now() - start < maxWait) {
    try {
      const r = await fetch('/api/v2/actions/' + encodeURIComponent(ackId), { cache: 'no-store' });
      if (r.ok) {
        const d = await r.json();
        if (d.status && d.status !== 'pending') {
          if (!isListItem) {
            btn.textContent = d.status === 'ok' ? '✓' : '⚠';
            setTimeout(() => { btn.textContent = origLabel; btn.disabled = false; }, 2500);
          } else {
            btn.classList.remove('list-row-loading');
          }
          showResultModal(d);
          setTimeout(() => loadDigest(), 1500);
          return;
        }
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 4000));
  }
  if (!isListItem) { btn.textContent = '⏱'; setTimeout(() => { btn.textContent = origLabel; btn.disabled = false; }, 2000); }
  else { btn.classList.remove('list-row-loading'); }
}
function showResultModal(result) {
  const existing = document.getElementById('result-modal');
  if (existing) existing.remove();
  const modal = document.createElement('div');
  modal.id = 'result-modal';
  modal.className = 'modal';
  const out = result.output || {};
  let body = '';
  if (Array.isArray(out.errors)) {
    body = out.errors.length === 0 ? '<em>Không có error 24h qua.</em>' :
      out.errors.map(e => \`<div class="r-row"><b>\${escapeHtml(e.type)}</b> <span class="r-dim">\${escapeHtml(e.ts||'')}</span></div>\`).join('');
  } else if (Array.isArray(out.items)) {
    body = out.items.length === 0 ? '<em>Không có item pending.</em>' :
      out.items.map(i => \`<div class="r-row"><b>\${escapeHtml(i.type)}</b>: \${escapeHtml(i.slug||i.label||'')}</div>\`).join('');
  } else if (Array.isArray(out.candidates)) {
    body = out.candidates.map((c,i) => \`<div class="r-row">\${i+1}. <b>\${escapeHtml(c.name)}</b> · \${(c.rev/1e6).toFixed(1)}M · qty \${c.qty}</div>\`).join('');
  } else if (out.skip_until) {
    body = \`<div class="r-row">Skip đến: <b>\${escapeHtml(out.skip_until)}</b></div>\`;
  } else if (Array.isArray(out.posts)) {
    body = out.posts.length === 0 ? '<em>No posts.</em>' :
      out.posts.map(p => \`<div class="r-row"><b>\${escapeHtml(p.page||'?')}</b> · \${escapeHtml(p.slug||'')}<span class="r-dim">\${escapeHtml((p.ts||'').slice(0,16).replace('T',' '))}</span></div>\`).join('');
  } else if (out.draft) {
    const d = out.draft;
    const sc = d.slide_counts || {};
    const sc_html = Object.keys(sc).length === 0 ? '<em class="r-dim">Chưa render slides</em>' :
      Object.entries(sc).map(([k, v]) => \`<span class="chip">\${k}: \${v} slide</span>\`).join(' ');
    const drive_btn = d.drive_url
      ? \`<a class="btn primary" href="\${escapeAttr(d.drive_url)}" target="_blank" rel="noopener">📁 Mở folder Drive</a>\`
      : \`<button class="btn" onclick="trigger('archive_to_drive_\${escapeAttr(d.slug)}', this)">📤 Push lên Drive</button>\`;
    body = \`
      <div class="meta-grid">
        <div><span class="r-dim">Slug</span><br><b>\${escapeHtml(d.slug)}</b></div>
        <div><span class="r-dim">Pages</span><br>\${escapeHtml((d.pages||[]).join(', '))}</div>
        <div><span class="r-dim">Post at</span><br>\${escapeHtml(d.post_at||'-')}</div>
        <div><span class="r-dim">Tier</span><br>\${escapeHtml(d.image_tier||'-')}</div>
      </div>
      <div class="r-section">SLIDES (Plan B render)</div>
      <div class="chips">\${sc_html}</div>
      <div style="margin: 8px 0 14px">\${drive_btn}</div>
      <div class="r-section">CAPTION</div>
      <div class="caption-box">\${escapeHtml(d.body||'')}</div>
      <div class="r-section">ACTIONS</div>
      <div class="actions">
        <button class="btn primary" onclick="trigger('post_draft_now_\${escapeAttr(d.slug)}', this)">Post now</button>
        <button class="btn" onclick="trigger('edit_draft_\${escapeAttr(d.slug)}', this)">Edit caption</button>
        <button class="btn" onclick="trigger('defer_draft_\${escapeAttr(d.slug)}', this)">Defer 24h</button>
        <button class="btn danger" onclick="if(confirm('Xoá draft \${escapeAttr(d.slug)}?')) trigger('delete_draft_\${escapeAttr(d.slug)}', this)">Delete</button>
      </div>
    \`;
  } else if (out.post) {
    const p = out.post;
    body = \`
      <div class="meta-grid">
        <div><span class="r-dim">Page</span><br><b>\${escapeHtml(p.page)}</b></div>
        <div><span class="r-dim">Posted</span><br>\${escapeHtml((p.ts||'').slice(0,16).replace('T',' '))}</div>
        <div><span class="r-dim">Post ID</span><br><code style="font-size:11px">\${escapeHtml(p.post_id||'-')}</code></div>
        <div><span class="r-dim">Mode</span><br>\${escapeHtml(p.mode||'-')}</div>
      </div>
      \${p.fb_url ? \`<a class="btn primary" href="\${escapeAttr(p.fb_url)}" target="_blank" rel="noopener">Open on FB</a>\` : ''}
      \${p.drive_url ? \`<a class="btn" href="\${escapeAttr(p.drive_url)}" target="_blank" rel="noopener">Open on Drive</a>\` : ''}
      <div class="r-section">BODY</div>
      <div class="caption-box">\${escapeHtml(p.body||'')}</div>
      <div class="r-section">ACTIONS</div>
      <div class="actions">
        <button class="btn danger" onclick="if(confirm('Xoá khỏi FB?')) trigger('delete_fb_post_\${escapeAttr(p.post_id||'')}', this)">Delete from FB</button>
      </div>
    \`;
  } else if (out.counts_14d) {
    body = Object.entries(out.counts_14d).map(([k,v]) => \`<div class="r-row"><b>\${escapeHtml(k)}</b><span style="float:right">\${v} bài/14d</span></div>\`).join('');
  } else if (out.mem_total_mb !== undefined) {
    body = \`
      <div class="r-row"><b>RAM</b> <span style="float:right">\${out.mem_total_mb - out.mem_free_mb}/\${out.mem_total_mb}MB (\${out.mem_used_pct}%)</span></div>
      <div class="r-row"><b>Disk</b> <span style="float:right">\${out.disk_total_gb - out.disk_free_gb}/\${out.disk_total_gb}GB (\${out.disk_used_pct}%)</span></div>
      \${(out.breaches || []).map(b => \`<div class="r-row r-dim">⚠ \${escapeHtml(typeof b === 'string' ? b : JSON.stringify(b))}</div>\`).join('')}
    \`;
  } else if (out.exit_code !== undefined) {
    body = \`<div class="r-row">Exit: <b>\${out.exit_code}</b></div><pre class="r-pre">\${escapeHtml((out.stdout_tail||'').slice(-400))}</pre>\`;
  } else {
    body = \`<pre class="r-pre">\${escapeHtml(JSON.stringify(out, null, 2).slice(0, 600))}</pre>\`;
  }
  modal.innerHTML = \`
    <div class="modal-box">
      <div class="modal-head">
        <span class="card-title">\${escapeHtml(result.action_id||'result')}</span>
        <button class="modal-close" onclick="this.closest('.modal').remove()">×</button>
      </div>
      <div class="modal-body">\${body}</div>
    </div>
  \`;
  document.body.appendChild(modal);
}
function escapeHtml(s) { return String(s||'').replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'})[c]); }
function escapeAttr(s) { return String(s||'').replace(/['"\\\\]/g, c => '\\\\' + c); }
loadDigest();
setInterval(loadDigest, 60000);
</script>
</body>
</html>`;

// ─── Router ───

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  try {
    if (path === "/api/v2/digest" && method === "GET") return handleDigest();

    const cardMatch = path.match(/^\/api\/v2\/cards\/([a-z_]+)$/);
    if (cardMatch && method === "GET") return handleCardDetail(cardMatch[1]);

    if (path === "/api/v2/sync-batch" && method === "POST") {
      if (!checkSyncAuth(req)) return jsonResponse({ error: "sync_unauthorized" }, 401);
      return handleSyncBatch(await req.text());
    }

    const syncMatch = path.match(/^\/api\/v2\/sync\/(.+)$/);
    if (syncMatch && method === "POST") {
      if (!checkSyncAuth(req)) return jsonResponse({ error: "sync_unauthorized" }, 401);
      return handleSyncSingle(syncMatch[1].replace(/\//g, ":"), await req.text());
    }

    const actionMatch = path.match(/^\/api\/v2\/actions\/([a-zA-Z0-9_-]+)$/);
    if (actionMatch) {
      if (method === "POST") {
        if (!checkActionAuth(req)) return jsonResponse({ error: "action_unauthorized" }, 401);
        return handleActionEnqueue(actionMatch[1], await req.text());
      }
      if (method === "GET") return handleActionPoll(actionMatch[1]);
    }

    if (path === "/api/v2/health") return handleHealth();

    if (path === "/api/v2/queue" && method === "GET") {
      if (!checkSyncAuth(req)) return jsonResponse({ error: "unauthorized" }, 401);
      return handleQueueGet();
    }
    if (path === "/api/v2/queue/clear" && method === "POST") {
      if (!checkSyncAuth(req)) return jsonResponse({ error: "unauthorized" }, 401);
      return handleQueueClear();
    }

    if (path === "/" || path === "/index.html") {
      return new Response(HTML, { status: 200, headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      } });
    }

    return jsonResponse({ error: "not_found", path }, 404);
  } catch (e) {
    return jsonResponse({ error: "internal", detail: String(e).slice(0, 200) }, 500);
  }
});
