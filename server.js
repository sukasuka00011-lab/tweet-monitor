// Peluang Masuk - monitor tweet. Node 18+, tanpa npm install.  Jalankan: node server.js
const http = require('http'), fs = require('fs'), path = require('path');
const D = process.env.DATA_DIR || path.join(__dirname, 'data'); fs.mkdirSync(D, { recursive: true });
const rd = (n, d) => { try { return JSON.parse(fs.readFileSync(path.join(D, n))); } catch { return d; } };
const wr = (n, v) => fs.writeFileSync(path.join(D, n), JSON.stringify(v, null, 1));

const DEF = {
  provider: 'twitterapi_io', apiKey: '', intervalMin: 0, maxPerPoll: 50,
  products: ['Netflix','Canva','Capcut','Spotify','ChatGPT','YouTube','Prime Video','Vidio','Disney+'].map(name => ({ name, on: true })),
  hashtags: ['zonauang', 'bealanja'],
  signals: 'wtb,cari,nyari,butuh,mau beli,mau,pengen,adakah,ada yang jual,ada yg jual,info,want to buy,ada,need'.split(','),
  ignore: 'wts,open order,ready stock,ready stok,jual akun,price list,pricelist,jasa convert,giveaway,stock melimpah,stok melimpah'.split(','),
  template: 'Halo kak {nama}! Untuk {produk} ada nih, boleh DM ya 🙌'
};
let cfg = { ...DEF, ...rd('config.json', {}) };
if (process.env.API_KEY) cfg.apiKey = process.env.API_KEY;
if (process.env.PROVIDER) cfg.provider = process.env.PROVIDER;
const PW = process.env.APP_PASSWORD, PORT = +process.env.PORT || 3000;
if (process.env.PORT && !PW) { console.error('Isi APP_PASSWORD dulu supaya dashboard tidak terbuka untuk umum'); process.exit(1); }
let leads = rd('leads.json', []);
let st = rd('state.json', { sinceId: null, lastPoll: 0, lastError: '', lastNew: 0 });
const save = () => { wr('config.json', cfg); wr('leads.json', leads); wr('state.json', st); };

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const has = (t, w) => new RegExp('(^|[^\\p{L}\\p{N}_])' + esc(w.trim()) + '($|[^\\p{L}\\p{N}_])', 'iu').test(t);

function buildQuery() {
  const tags = cfg.hashtags.slice(0, 8).map(h => '#' + h.replace(/^#/, '').trim()).filter(h => h.length > 1);
  const prods = cfg.products.filter(p => p.on).map(p => /\s/.test(p.name) ? `"${p.name}"` : p.name);
  if (!tags.length || !prods.length) throw new Error('Isi minimal 1 hashtag dan 1 produk aktif');
  return `(${tags.join(' OR ')}) (${prods.join(' OR ')}) -is:retweet -is:reply`;
}

async function fetchTweets(q) {
  if (!cfg.apiKey) throw new Error('API key belum diisi (menu Pengaturan)');
  if (cfg.provider === 'x_official') {
    const u = new URL('https://api.x.com/2/tweets/search/recent');
    u.search = new URLSearchParams({ query: q, max_results: String(Math.min(100, Math.max(10, cfg.maxPerPoll))),
      'tweet.fields': 'created_at,author_id', expansions: 'author_id', 'user.fields': 'username,name' });
    if (st.sinceId) u.searchParams.set('since_id', st.sinceId); // hemat kredit: hanya tweet baru
    const r = await fetch(u, { headers: { Authorization: 'Bearer ' + cfg.apiKey } });
    const j = await r.json();
    if (!r.ok) throw new Error(j.detail || j.title || 'HTTP ' + r.status);
    const us = Object.fromEntries((j.includes?.users || []).map(x => [x.id, x]));
    return (j.data || []).map(t => ({ id: t.id, text: t.text, at: t.created_at, user: us[t.author_id]?.username || '', name: us[t.author_id]?.name || '' }));
  }
  const u = new URL('https://api.twitterapi.io/twitter/tweet/advanced_search');
  u.search = new URLSearchParams({ query: q, queryType: 'Latest' });
  const r = await fetch(u, { headers: { 'X-API-Key': cfg.apiKey } });
  const j = await r.json();
  if (!r.ok || j.status === 'error') throw new Error(j.msg || j.message || 'HTTP ' + r.status);
  return (j.tweets || []).slice(0, cfg.maxPerPoll).map(t => ({ id: t.id, text: t.text, at: t.createdAt, user: t.author?.userName || '', name: t.author?.name || '' }));
}

function analyze(t) {
  if (cfg.ignore.some(w => w.trim() && has(t.text, w))) return null;
  const sig = cfg.signals.filter(w => w.trim() && has(t.text, w));
  const prod = cfg.products.filter(p => p.on && has(t.text, p.name));
  if (!sig.length || !prod.length) return null;
  const tags = cfg.hashtags.filter(h => has(t.text, '#' + h.replace(/^#/, '')));
  return { ...t, at: new Date(t.at).toISOString(), product: prod[0].name, matched: [...sig, ...tags.map(h => '#' + h.replace(/^#/, ''))],
    status: 'baru', saved: false };
}

let busy = false;
async function poll() {
  if (busy) return; busy = true;
  try {
    const raw = await fetchTweets(buildQuery());
    const ids = new Set(leads.map(l => l.id)); let n = 0;
    for (const t of raw) { if (ids.has(t.id)) continue; const a = analyze(t); if (a) { leads.push(a); n++; } }
    const maxId = raw.reduce((m, t) => (BigInt(t.id) > m ? BigInt(t.id) : m), BigInt(st.sinceId || 0));
    if (raw.length) st.sinceId = String(maxId);
    leads.sort((a, b) => new Date(b.at) - new Date(a.at)); leads = leads.slice(0, 500);
    st.lastError = ''; st.lastNew = n;
  } catch (e) { st.lastError = String(e.message || e); }
  st.lastPoll = Date.now(); busy = false; save();
}
setInterval(() => { if (cfg.intervalMin > 0 && Date.now() - st.lastPoll > cfg.intervalMin * 60000) poll(); }, 30000);

const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type + '; charset=utf-8' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const body = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });

const srv = http.createServer(async (req, res) => { try {
  if (PW) {
    const p = Buffer.from((req.headers.authorization || '').split(' ')[1] || '', 'base64').toString().split(':').slice(1).join(':');
    if (p !== PW) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Peluang masuk"' }); return res.end('Login diperlukan'); }
  }
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/state') return send(res, 200, { cfg: { ...cfg, apiKey: '', hasKey: !!cfg.apiKey }, leads, st, busy });
  if (url.pathname === '/api/config' && req.method === 'POST') {
    const b = await body(req); const key = b.apiKey || cfg.apiKey;
    cfg = { ...cfg, ...b, apiKey: key, intervalMin: +b.intervalMin || 0, maxPerPoll: Math.min(100, +b.maxPerPoll || 50) }; save(); return send(res, 200, { ok: 1 });
  }
  if (url.pathname === '/api/poll' && req.method === 'POST') { await poll(); return send(res, 200, { ok: 1, st }); }
  if (url.pathname === '/api/lead' && req.method === 'POST') {
    const b = await body(req); const l = leads.find(x => x.id === b.id);
    if (l) { if (b.status) l.status = b.status; if (b.saved !== undefined) l.saved = !!b.saved; save(); }
    return send(res, 200, { ok: 1 });
  }
  if (url.pathname === '/api/export.csv') {
    const q = v => '"' + String(v).replace(/"/g, '""') + '"';
    const rows = [['id','username','nama','waktu','produk','status','tweet','link'].join(',')].concat(leads.map(l =>
      [l.id, l.user, l.name, l.at, l.product, l.status, l.text, `https://x.com/${l.user}/status/${l.id}`].map(q).join(',')));
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename=peluang.csv' }); return res.end('\ufeff' + rows.join('\n'));
  }
  send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'), 'text/html');
} catch (e) { console.error(e); if (!res.headersSent) res.writeHead(500); res.end('Error'); }
});
srv.keepAliveTimeout = 120000; srv.headersTimeout = 125000;
process.on('uncaughtException', e => console.error(e));
srv.listen(PORT, process.env.PORT ? '0.0.0.0' : '127.0.0.1', () => console.log('Jalan di port ' + PORT));
