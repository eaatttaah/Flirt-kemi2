require('dotenv').config();
const express = require('express'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const { QUICKPAY_API_KEY, QUICKPAY_PRIVATE_KEY, BASE_URL, PORT = 3000 } = process.env;
const QP = 'https://api.quickpay.net';
const CONSENT_VERSION = 'v1';

// Priser/kreditter ligger KUN her: klienten sender kun pakke-id, aldrig beløb.
const PACKAGES = {
  p100: { dkk: 100, credits: 500 },
  p250: { dkk: 250, credits: 1400 },
  p500: { dkk: 500, credits: 3000 },
};

// Simpel filbaseret lagring. Skift til rigtig database i produktion.
const DB_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');
const db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE)) : { customers: {}, orders: {}, consents: [] };
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
const customer = id => (db.customers[id] ||= { credits: 0, sensitiveConsent: false });

const qp = (method, url, body) => fetch(QP + url, {
  method,
  headers: {
    'Accept-Version': 'v10', 'Content-Type': 'application/json',
    Authorization: 'Basic ' + Buffer.from(':' + QUICKPAY_API_KEY).toString('base64'),
  },
  body: body && JSON.stringify(body),
}).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j)); return j; });

const app = express();
app.set('trust proxy', 1);

// Quickpay webhook: skal bruge rå body til signaturtjek
app.post('/api/quickpay/callback', express.raw({ type: '*/*' }), (req, res) => {
  const sig = req.get('QuickPay-Checksum-Sha256') || '';
  const calc = crypto.createHmac('sha256', QUICKPAY_PRIVATE_KEY).update(req.body).digest('hex');
  if (sig.length !== calc.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(calc))) return res.sendStatus(401);
  const p = JSON.parse(req.body);
  const order = db.orders[p.order_id];
  if (!order) return res.sendStatus(200);
  const ok = p.accepted && p.currency === 'DKK' &&
    (p.operations || []).some(o => o.type === 'capture' && o.qp_status_code === '20000' && o.amount === order.amount);
  if (ok) fulfil(order);
  res.sendStatus(200);
});

app.use(express.json());
const SITE = () => process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || '';
app.get('/robots.txt', (_, res) => res.type('text/plain').send('User-agent: *\nAllow: /\nDisallow: /api/\n' + (SITE() ? 'Sitemap: ' + SITE() + '/sitemap.xml\n' : '')));
app.get('/sitemap.xml', (_, res) => res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
  + ['/', '/vilkaar.html', '/privatliv.html'].map(p => '<url><loc>' + SITE() + p + '</loc></url>').join('') + '</urlset>'));
app.use((req, res, next) => { if (/^\/(chat|buy|demo-pay|operator|admin)\.html$|^\/api\//.test(req.path)) res.set('X-Robots-Tag', 'noindex'); next(); });
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/packages', (_, res) => res.json(PACKAGES));
app.get('/api/credits/:id', (req, res) => res.json({ credits: customer(req.params.id).credits }));

app.post('/api/checkout', async (req, res) => {
  try {
    const { customerId, packageId, consent = {} } = req.body;
    const pkg = PACKAGES[packageId];
    if (!customerId || !pkg || !db.customers[customerId]) return res.status(400).json({ error: 'Ugyldig forespørgsel' });
    if (!(consent.adult && consent.fictional && consent.data))
      return res.status(400).json({ error: 'Alle påkrævede samtykker skal gives' });

    const orderId = 'o' + crypto.randomBytes(8).toString('hex');
    const amount = pkg.dkk * 100; // øre
    db.consents.push({ customerId, orderId, version: CONSENT_VERSION, adult: true, fictional: true, data: true,
      sensitive: !!consent.sensitive, at: new Date().toISOString(), ip: req.ip, ua: req.get('user-agent') });
    Object.assign(customer(customerId), { consented: true, sensitiveConsent: !!consent.sensitive });
    db.orders[orderId] = { customerId, amount, credits: pkg.credits, status: 'pending' };
    save();

    if (DEMO) return res.json({ url: '/demo-pay.html?o=' + orderId });
    const payment = await qp('POST', '/payments', { order_id: orderId, currency: 'DKK' });
    const link = await qp('PUT', `/payments/${payment.id}/link`, {
      amount, auto_capture: true, language: 'da',
      continue_url: `${BASE_URL}/buy.html?status=ok`, cancel_url: `${BASE_URL}/buy.html?status=cancel`,
      callback_url: `${BASE_URL}/api/quickpay/callback`,
    });
    res.json({ url: link.url });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Betalingen kunne ikke startes' }); }
});

// ---------- Demo/ægte betaling, chat, operatør ----------
const DEMO = !QUICKPAY_API_KEY, COST = 10;
db.convs ||= {};
const now = () => Date.now(), iso = () => new Date().toISOString(), rid = n => crypto.randomBytes(n).toString('hex');
const conv = id => (db.convs[id] ||= { msgs: [], notes: [], logs: { man: {}, woman: {} }, status: 'open', holdUntil: 0, assignee: '', started: iso() });
const pending = c => c.status === 'open' && c.holdUntil < now() && c.msgs.length && c.msgs.at(-1).from === 'c';
function fulfil(o) { if (o.status === 'paid') return; o.status = 'paid'; customer(o.customerId).credits += o.credits; save(); }

app.post('/api/demo/pay', (req, res) => {           // kun når der ikke er Quickpay-nøgle
  const o = db.orders[req.body.orderId]; if (!DEMO || !o) return res.sendStatus(404);
  fulfil(o); res.json({ ok: true });
});

// Kunde
app.post('/api/register', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40), city = String(req.body.city || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Skriv dit navn' });
  const id = rid(12); db.customers[id] = { name, city, credits: 0, consented: false, sensitiveConsent: false };
  conv(id); save(); res.json({ id });
});
app.get('/api/chat/:id', (req, res) => {
  const c = db.customers[req.params.id]; if (!c) return res.status(404).json({});
  res.json({ name: c.name, credits: c.credits, cost: COST, msgs: conv(req.params.id).msgs });
});
app.post('/api/chat/:id', (req, res) => {
  const c = db.customers[req.params.id], text = String(req.body.text || '').trim().slice(0, 1000);
  if (!c || !text) return res.status(400).json({ error: 'Ugyldig besked' });
  if (!c.consented) return res.status(403).json({ error: 'Giv samtykke under "Køb kreditter" først.' });
  if (c.credits < COST) return res.status(402).json({ error: 'Ikke nok kreditter.' });
  const v = conv(req.params.id); c.credits -= COST; if (v.status === 'closed') v.status = 'open';
  v.msgs.push({ from: 'c', text, at: iso() }); save(); res.json({ ok: true });
});
app.delete('/api/me/:id', (req, res) => {            // ret til sletning (GDPR)
  const id = req.params.id; delete db.customers[id]; delete db.convs[id];
  db.consents = db.consents.filter(x => x.customerId !== id); save(); res.json({ ok: true });
});

// Operatør
const op = express.Router();
const sessions = new Map(), fails = new Map();           // token -> {username, role}
const hashPw = (p, salt) => crypto.scryptSync(p, salt, 32).toString('hex');
db.operators ||= {};
{ const salt = rid(8), pw = process.env.ADMIN_PASSWORD || process.env.OPERATOR_PASSWORD || 'operator';
  db.operators.admin = { salt, hash: hashPw(pw, salt), role: 'admin' }; save(); }   // admin-kodeord styres af miljøvariabel
op.post('/login', (req, res) => {
  const f = fails.get(req.ip) || { n: 0, t: now() }; if (now() - f.t > 9e5) { f.n = 0; f.t = now(); }
  if (f.n >= 10) return res.sendStatus(429);
  const u = String(req.body.username || '').toLowerCase(), o = db.operators[u];
  if (!o || !crypto.timingSafeEqual(Buffer.from(hashPw(String(req.body.password || ''), o.salt)), Buffer.from(o.hash))) {
    f.n++; fails.set(req.ip, f); return res.sendStatus(401);
  }
  const token = rid(24); sessions.set(token, { username: u, role: o.role }); res.json({ token, role: o.role });
});
op.use((req, res, next) => { const s = sessions.get(req.get('x-op-token')); if (!s) return res.sendStatus(401); req.op = s; next(); });
app.use('/api/op', op);
op.get('/next', (req, res) => {
  const queue = Object.entries(db.convs).filter(([, c]) => pending(c));
  const cur = db.convs[req.query.cur];
  let id = cur && cur.status === 'open' && cur.holdUntil < now() ? req.query.cur : null;
  if (!id && queue.length) id = queue.sort((a, b) => a[1].msgs.at(-1).at.localeCompare(b[1].msgs.at(-1).at))[0][0];
  if (!id) return res.json({ none: true, queue: 0 });
  const c = db.convs[id], u = db.customers[id];
  res.json({ id, queue: queue.length, conv: c, customer: { name: u.name, city: u.city, credits: u.credits, sensitive: u.sensitiveConsent },
    inCount: c.msgs.filter(m => m.from === 'c').length, outCount: c.msgs.filter(m => m.from === 'm').length });
});
op.post('/send', (req, res) => {
  const c = db.convs[req.body.id], t = String(req.body.text || '').trim().slice(0, 1000);
  if (!c || !t) return res.sendStatus(400); c.msgs.push({ from: 'm', text: t, by: req.op.username, at: iso() }); (db.opLog ||= []).push({ op: req.op.username, at: iso() }); save(); res.json({ ok: true });
});
op.post('/note', (req, res) => {
  const c = db.convs[req.body.id]; if (!c) return res.sendStatus(404);
  const { action, noteId, text, important, until } = req.body, n = c.notes.find(x => x.id === noteId);
  if (action === 'add') c.notes.push({ id: rid(4), text: String(text).slice(0, 500), important: !!important, until: until || '', at: iso() });
  if (action === 'edit' && n) n.text = String(text).slice(0, 500);
  if (action === 'del') c.notes = c.notes.filter(x => x.id !== noteId);
  save(); res.json({ ok: true });
});
op.post('/log', (req, res) => {
  const { id, person, category, text } = req.body, c = db.convs[id], u = db.customers[id];
  if (!c || !text || !['man', 'woman'].includes(person)) return res.sendStatus(400);
  if (person === 'man' && ['Health', 'Sexual preference'].includes(category) && !u.sensitiveConsent)
    return res.status(403).json({ error: 'Kunden har ikke givet samtykke til denne kategori.' });
  (c.logs[person][category] ||= []).push({ text: String(text).slice(0, 500), at: iso() }); save(); res.json({ ok: true });
});
op.post('/status', (req, res) => {
  const c = db.convs[req.body.id]; if (!c) return res.sendStatus(404);
  const { status, minutes, assignee } = req.body;
  if (status === 'hold') c.holdUntil = now() + (Number(minutes) || 15) * 60000;
  else if (status === 'panic' || status === 'closed') c.status = status;
  else if (status === 'assign') c.assignee = assignee ? req.op.username : '';
  save(); res.json({ ok: true });
});
op.get('/stats', (req, res) => {
  const cs = Object.values(db.convs), ms = cs.flatMap(c => c.msgs);
  if (req.query.me) return res.json({ my_messages: ms.filter(m => m.by === req.op.username).length,
    my_assigned_conversations: cs.filter(c => c.assignee === req.op.username).length });
  res.json({ conversations: cs.length, in_queue: cs.filter(pending).length, panic_room: cs.filter(c => c.status === 'panic').length,
    customer_messages: ms.filter(m => m.from === 'c').length, operator_messages: ms.filter(m => m.from === 'm').length });
});
const admin = (req, res, next) => req.op.role === 'admin' ? next() : res.sendStatus(403);
// Aktivitetslog: gemmer kun operatørnavn + tidspunkt (ingen beskedtekst/kunde-id), så den overlever sletning af kundedata.
const RET = Number(process.env.LOG_RETENTION_DAYS) || 180;   // dage; ændr med LOG_RETENTION_DAYS
db.opLog ||= [];
const prune = () => { db.opLog = db.opLog.filter(x => Date.parse(x.at) >= now() - RET * 864e5); save(); };
prune(); setInterval(prune, 864e5);
op.get('/admin/activity', admin, (req, res) => {
  const from = Date.parse(req.query.from) || 0, to = Date.parse(req.query.to) || now() + 1, o = req.query.op;
  const list = db.opLog.filter(x => { const t = Date.parse(x.at); return t >= from && t <= to && (!o || x.op === o); });
  res.json({ retention_days: RET, entries: list.slice(-50000).map(x => [x.op, x.at]) });
});
op.get('/admin/panic', admin, (_, res) => res.json(Object.entries(db.convs).filter(([, c]) => c.status === 'panic')
  .map(([id, c]) => ({ id, name: db.customers[id]?.name, msgs: c.msgs.slice(-20), notes: c.notes }))));
op.post('/admin/release', admin, (req, res) => {
  const c = db.convs[req.body.id]; if (!c) return res.sendStatus(404);
  c.status = req.body.close ? 'closed' : 'open'; save(); res.json({ ok: true });
});
op.get('/admin/operators', admin, (_, res) => res.json(Object.entries(db.operators).map(([username, o]) => ({ username, role: o.role }))));
op.post('/admin/operators', admin, (req, res) => {
  const u = String(req.body.username || '').trim().toLowerCase(), p = String(req.body.password || '');
  if (!/^[a-z0-9_.-]{3,30}$/.test(u) || p.length < 8) return res.status(400).json({ error: 'Username: 3-30 chars (a-z, 0-9). Password: min 8 chars.' });
  if (db.operators[u]) return res.status(409).json({ error: 'Username already exists.' });
  const salt = rid(8); db.operators[u] = { salt, hash: hashPw(p, salt), role: 'operator' }; save(); res.json({ ok: true });
});
op.delete('/admin/operators/:u', admin, (req, res) => {
  if (req.params.u === 'admin') return res.sendStatus(400);
  delete db.operators[req.params.u]; for (const [t, s] of sessions) if (s.username === req.params.u) sessions.delete(t);
  save(); res.json({ ok: true });
});


app.listen(PORT, () => console.log('http://localhost:' + PORT));
