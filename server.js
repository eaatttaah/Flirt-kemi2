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

app.use(express.json({ limit: '3mb' }));
const SITE = () => process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || '';
app.get('/robots.txt', (_, res) => res.type('text/plain').send('User-agent: *\nAllow: /\nDisallow: /api/\n' + (SITE() ? 'Sitemap: ' + SITE() + '/sitemap.xml\n' : '')));
app.get('/sitemap.xml', (_, res) => res.type('application/xml').send('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
  + ['/', '/vilkaar.html', '/privatliv.html'].map(p => '<url><loc>' + SITE() + p + '</loc></url>').join('') + '</urlset>'));
app.use((req, res, next) => { if (/^\/(chat|buy|demo-pay|operator|admin|samtaler|profil|login|profiler)\.html$|^\/(api|img)\//.test(req.path)) res.set('X-Robots-Tag', 'noindex'); next(); });
// Kun disse sider serveres (virker både med og uden public-mappe; udsætter aldrig server.js eller data)
const PAGES = ['index', 'chat', 'buy', 'demo-pay', 'operator', 'admin', 'vilkaar', 'privatliv', 'samtaler', 'profil', 'login', 'profiler'];
const PUB = fs.existsSync(path.join(__dirname, 'index.html')) ? __dirname : path.join(__dirname, 'public');   // nyeste filer i roden vinder
app.get('/hero.jpg', (req, res) => { res.set('Cache-Control', 'public, max-age=86400'); res.sendFile(path.join(PUB, 'hero.jpg')); });
app.get(['/', ...PAGES.map(p => '/' + p + '.html')], (req, res) =>
  res.sendFile(path.join(PUB, req.path === '/' ? 'index.html' : req.path.slice(1))));


// ---- Offentlige data, ordrehistorik, favicon ----
app.get('/api/public/profiles', (_, res) => { res.set('Cache-Control', 'public, max-age=60'); res.json(Object.entries(db.profiles).map(([id, p]) => { const o = pubProfile(id, p); return { name: o.name, tagline: o.tagline, avatar: o.avatar, label: o.label }; })); });
app.get('/api/orders/:cid', (req, res) => { const c = cust(req, res); if (!c) return;
  res.json(Object.values(db.orders).filter(o => o.customerId === req.params.cid && o.status === 'paid').map(o => ({ at: o.paidAt || o.at || '', dkk: o.amount / 100, credits: o.credits })).sort((a, b) => b.at.localeCompare(a.at))); });
const FAV = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f0508a"/><stop offset="1" stop-color="#9b5de5"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#g)"/><path d="M32 47S15 37 15 26a9 9 0 0117-4.5A9 9 0 0149 26c0 11-17 21-17 21z" fill="#fff"/></svg>';
app.get('/favicon.svg', (_, res) => { res.set('Cache-Control', 'public, max-age=86400'); res.type('image/svg+xml').send(FAV); });
app.get('/favicon.ico', (_, res) => res.redirect('/favicon.svg'));
app.get('/api/packages', (_, res) => res.json(PACKAGES));

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
    Object.assign(customer(customerId), { consented: true, sensitiveConsent: customer(customerId).sensitiveConsent || !!consent.sensitive });
    db.orders[orderId] = { customerId, amount, credits: pkg.credits, status: 'pending', at: new Date().toISOString() };
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
const conv = (cid, pid) => (db.convs[cid + '~' + pid] ||= { cid, pid, msgs: [], notes: [], logs: { man: {}, woman: {} }, status: 'open', holdUntil: 0, assignee: '', started: iso() });
const pending = c => c.status === 'open' && c.holdUntil < now() && c.msgs.length && c.msgs.at(-1).from === 'c';
function fulfil(o) { if (o.status === 'paid') return; o.status = 'paid'; o.paidAt = new Date().toISOString(); customer(o.customerId).credits += o.credits; save(); }

// ---------- Profiler, uploads og migrering ----------
db.profiles ||= {}; db.uploads ||= {};
if (!Object.keys(db.profiles).length) db.profiles.maria = { name: 'JomfruMaria', tagline: 'Charmerende og legesyg' };
for (const p of Object.values(db.profiles)) { p.bio ||= ''; p.avatar ||= ''; p.avatarSource ||= ''; p.gallery ||= []; p.operators ||= []; }
for (const [k, c] of Object.entries(db.convs)) if (!c.cid) { c.cid = k; c.pid = 'maria'; db.convs[k + '~maria'] = c; delete db.convs[k]; }   // ældre samtaler
const UP = path.join(process.env.DATA_DIR || __dirname, 'uploads'); fs.mkdirSync(UP, { recursive: true });
save();
const convKeys = cid => Object.keys(db.convs).filter(k => db.convs[k].cid === cid);
function dropFile(f) { if (!f) return; delete db.uploads[f]; try { fs.unlinkSync(path.join(UP, f)); } catch {} }
// Operatører med begrænset adgang ser kun de profiler, de er tildelt (ingen tildelte operatører = alle operatører)
const canSee = (s, c) => { const p = db.profiles[c.pid] || {}; return s.role === 'admin' || !(p.operators || []).length || p.operators.includes(s.username); };
const IDLE_MS = Number(process.env.OP_IDLE_MS) || 180000;   // operatøren skal svare inden 3 min, ellers logges vedkommende ud
const cv = (req, id) => { const c = db.convs[id]; return c && canSee(req.op, c) && (!c.claim || c.claim.by === req.op.username || req.op.role === 'admin') ? c : null; };
const pubProfile = (id, p) => ({ id, name: p.name, tagline: p.tagline || '', bio: p.bio || '', avatar: p.avatar || '',
  label: p.avatar && p.avatarSource === 'illustration' ? 'Illustration' : '' });

app.post('/api/demo/pay', (req, res) => {           // kun når der ikke er Quickpay-nøgle
  const o = db.orders[req.body.orderId]; if (!DEMO || !o) return res.sendStatus(404);
  fulfil(o); res.json({ ok: true });
});

// Kunde
const cl = (v, n) => String(v || '').trim().slice(0, n);
const pubMsg = m => ({ from: m.from, text: m.text, img: m.img || '', label: m.label || '', at: m.at });       // aldrig operatørnavn til kunden
const meOut = (id, c) => ({ id, name: c.name, nick: c.nick || '', first: c.first || '', last: c.last || '', age: c.age || '', city: c.city || '',
  likes: c.likes || '', about: c.about || '', seeking: c.sensitiveConsent ? (c.seeking || '') : '', sensitive: !!c.sensitiveConsent,
  avatar: c.avatar || '', email: c.email || '', hasLogin: !!c.pw, verified: !!c.emailVerified, credits: c.credits, cost: COST });
const cust = (req, res) => { const c = db.customers[req.params.cid]; if (!c) res.status(404).json({ error: 'Ukendt profil' }); return c; };

app.post('/api/register', (req, res) => {
  const b = req.body, cs = b.consent || {};
  const first = cl(b.first, 40), last = cl(b.last, 40), nick = cl(b.nick, 40), age = parseInt(b.age, 10), name = nick || first;
  if (!name) return res.status(400).json({ error: 'Skriv et kaldenavn eller dit fornavn.' });
  if (!(age >= 18 && age <= 99)) return res.status(400).json({ error: 'Du skal være mindst 18 år.' });
  if (!cs.adult || !cs.data) return res.status(400).json({ error: 'Bekræft alder og samtykke for at fortsætte.' });
  const email = cl(b.email, 120).toLowerCase(), pw = String(b.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) return res.status(400).json({ error: 'Skriv en gyldig e-mail.' });
  if (pw.length < 8) return res.status(400).json({ error: 'Adgangskoden skal være mindst 8 tegn.' });
  if (Object.values(db.customers).some(x => x.email === email)) return res.status(409).json({ error: 'Der findes allerede en profil med den e-mail. Prøv at logge ind.' });
  const sens = !!cs.sensitive, id = rid(12);
  db.customers[id] = { email, pw: mkPw(pw), name, first, last, nick, age, city: cl(b.city, 40), likes: cl(b.likes, 300), about: '', seeking: sens ? cl(b.seeking, 60) : '',
    credits: 0, consented: false, sensitiveConsent: sens, profileConsentAt: iso() };
  sendVerify(req, db.customers[id]); save(); res.json({ id });
});
const mkPw = p => { const salt = rid(8); return { salt, hash: hashPw(p, salt) }; };
const pwOk = (c, p) => { if (!c || !c.pw) return false; const a = Buffer.from(hashPw(String(p || ''), c.pw.salt)), b = Buffer.from(c.pw.hash); return a.length === b.length && crypto.timingSafeEqual(a, b); };

// ---- E-mail (Brevo eller Resend via HTTPS; uden nøgle logges mailen i serverloggen) ----
const MAIL_FROM = process.env.MAIL_FROM || '', MAIL_NAME = process.env.MAIL_NAME || 'Flirt & Kemi';
async function sendMail(to, subject, text) {
  try {
    if (process.env.BREVO_API_KEY && MAIL_FROM) {
      const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ sender: { name: MAIL_NAME, email: MAIL_FROM }, to: [{ email: to }], subject, textContent: text }) });
      if (!r.ok) console.error('mail fejl (brevo)', r.status); return r.ok;
    }
    if (process.env.RESEND_API_KEY && MAIL_FROM) {
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ from: MAIL_NAME + ' <' + MAIL_FROM + '>', to: [to], subject, text }) });
      if (!r.ok) console.error('mail fejl (resend)', r.status); return r.ok;
    }
    console.log('[MAIL ikke konfigureret] Til: ' + to + ' | ' + subject + '\n' + text); return false;
  } catch (e) { console.error('mail fejl', e.message); return false; }
}
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const siteUrl = req => (SITE() || ((req.protocol || 'https') + '://' + req.get('host'))).replace(/\/$/, '');
function mkToken(c, kind, ttlMs) { const t = rid(24); (c.tokens ||= {})[kind] = { h: sha(t), exp: now() + ttlMs }; return t; }
function findByToken(kind, t) {
  const h = sha(t); for (const [id, c] of Object.entries(db.customers)) { const k = c.tokens && c.tokens[kind]; if (k && k.h === h && k.exp > now()) return [id, c]; } return null;
}
const sendVerify = (req, c) => sendMail(c.email, 'Bekræft din e-mail hos Flirt & Kemi', 'Hej ' + (c.name || '') + '\n\nKlik på linket for at bekræfte din e-mail:\n' + siteUrl(req) + '/api/verify?t=' + mkToken(c, 'verify', 7 * 864e5) + '\n\nLinket virker i 7 dage. Har du ikke oprettet en profil, kan du ignorere denne mail.\n');
const loginFails = new Map();
const tooMany = k => { const f = loginFails.get(k); return !!f && f.n >= 10 && now() - f.t < 9e5; };
const bump = k => { const f = loginFails.get(k); if (!f || now() - f.t >= 9e5) loginFails.set(k, { n: 1, t: now() }); else f.n++; };
app.post('/api/login', (req, res) => {
  const email = cl((req.body || {}).email, 120).toLowerCase(), k1 = 'ip:' + req.ip, k2 = 'em:' + email;
  if (tooMany(k1) || tooMany(k2)) return res.status(429).json({ error: 'For mange forsøg. Prøv igen om lidt.' });
  const hit = Object.entries(db.customers).find(([, c]) => c.email === email);
  if (!hit || !pwOk(hit[1], req.body.password)) { bump(k1); bump(k2); return res.status(401).json({ error: 'Forkert e-mail eller adgangskode.' }); }
  if (hit[1].blocked) return res.status(403).json({ error: 'Kontoen er spærret. Kontakt os, hvis du mener, det er en fejl.' });
  res.json({ id: hit[0] });
});

app.get('/api/verify', (req, res) => {
  const hit = findByToken('verify', req.query.t);
  if (!hit) return res.redirect('/login.html?verified=0');
  hit[1].emailVerified = true; delete hit[1].tokens.verify; save(); res.redirect('/login.html?verified=1');
});
app.post('/api/me/:cid/resend', (req, res) => {
  const c = cust(req, res); if (!c) return;
  if (!c.email) return res.status(400).json({ error: 'Tilføj først en e-mail.' });
  if (c.emailVerified) return res.json({ ok: true });
  const k = 'rs:' + req.params.cid; if (tooMany(k)) return res.status(429).json({ error: 'Prøv igen om lidt.' }); bump(k);
  sendVerify(req, c); save(); res.json({ ok: true });
});
app.post('/api/forgot', (req, res) => {
  const email = cl((req.body || {}).email, 120).toLowerCase(), k1 = 'fi:' + req.ip, k2 = 'fe:' + email;
  if (tooMany(k1) || tooMany(k2)) return res.status(429).json({ error: 'For mange forsøg. Prøv igen om lidt.' });
  bump(k1); bump(k2);
  const hit = email && Object.values(db.customers).find(c => c.email === email);
  if (hit) { const t = mkToken(hit, 'reset', 36e5); save(); sendMail(email, 'Nulstil din adgangskode hos Flirt & Kemi', 'Hej\n\nKlik her for at vælge en ny adgangskode:\n' + siteUrl(req) + '/login.html?reset=' + t + '\n\nLinket virker i 1 time. Bad du ikke om det, kan du ignorere denne mail.\n'); }
  res.json({ ok: true });   // samme svar uanset om e-mailen findes
});
app.post('/api/reset', (req, res) => {
  const b = req.body || {}, pw = String(b.password || ''), k = 'rt:' + req.ip;
  if (tooMany(k)) return res.status(429).json({ error: 'For mange forsøg. Prøv igen om lidt.' });
  if (pw.length < 8) return res.status(400).json({ error: 'Adgangskoden skal være mindst 8 tegn.' });
  const hit = findByToken('reset', b.token);
  if (!hit) { bump(k); return res.status(400).json({ error: 'Linket er udløbet eller allerede brugt. Bed om et nyt.' }); }
  hit[1].pw = mkPw(pw); hit[1].emailVerified = true; delete hit[1].tokens.reset; save(); res.json({ ok: true });
});
app.put('/api/me/:cid/login', (req, res) => {          // tilføj/skift e-mail og adgangskode
  const c = cust(req, res); if (!c) return; const b = req.body || {};
  const email = cl(b.email, 120).toLowerCase(), pw = String(b.password || '');
  if (c.pw && !pwOk(c, b.current)) return res.status(403).json({ error: 'Nuværende adgangskode er forkert.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) return res.status(400).json({ error: 'Skriv en gyldig e-mail.' });
  if (pw.length < 8) return res.status(400).json({ error: 'Adgangskoden skal være mindst 8 tegn.' });
  if (Object.entries(db.customers).some(([id, x]) => id !== req.params.cid && x.email === email)) return res.status(409).json({ error: 'E-mailen er allerede i brug.' });
  if (c.email !== email) { c.emailVerified = false; sendVerify(req, c); } c.email = email; c.pw = mkPw(pw); save(); res.json({ ok: true, me: meOut(req.params.cid, c) });
});
app.get('/api/me/:cid', (req, res) => { const c = cust(req, res); if (c) res.json(meOut(req.params.cid, c)); });
app.put('/api/me/:cid', (req, res) => {
  const c = cust(req, res); if (!c) return; const b = req.body || {}, id = req.params.cid;
  const nick = cl(b.nick, 40), first = cl(b.first, 40), age = parseInt(b.age, 10), sens = !!b.sensitive;
  if (!(nick || first)) return res.status(400).json({ error: 'Skriv et kaldenavn eller dit fornavn.' });
  if (!(age >= 18 && age <= 99)) return res.status(400).json({ error: 'Du skal være mindst 18 år.' });
  Object.assign(c, { nick, first, last: cl(b.last, 40), age, city: cl(b.city, 40), likes: cl(b.likes, 300), about: cl(b.about, 600),
    sensitiveConsent: sens, seeking: sens ? cl(b.seeking, 60) : '', name: nick || first });
  if (!sens) for (const k of convKeys(id)) { delete db.convs[k].logs.man.Health; delete db.convs[k].logs.man['Sexual preference']; }   // samtykke trukket tilbage
  save(); res.json({ ok: true, me: meOut(id, c) });
});
app.delete('/api/me/:cid/avatar', (req, res) => { const c = cust(req, res); if (!c) return; dropFile(c.avatar); c.avatar = ''; save(); res.json({ ok: true }); });
app.delete('/api/me/:cid', (req, res) => {            // ret til sletning (GDPR). Ordrer beholdes pga. bogføringsloven.
  const id = req.params.cid; if (!db.customers[id]) return res.json({ ok: true });
  for (const k of convKeys(id)) delete db.convs[k];
  for (const [f, u] of Object.entries(db.uploads)) if (u.cid === id) dropFile(f);
  delete db.customers[id]; db.consents = db.consents.filter(x => x.customerId !== id); save(); res.json({ ok: true });
});

const upHits = new Map();
app.post('/api/upload/:cid', (req, res) => {
  const c = cust(req, res); if (!c) return; const cid = req.params.cid;
  const h = (upHits.get(cid) || []).filter(t => t > now() - 36e5); if (h.length >= 30) return res.status(429).json({ error: 'For mange billeder. Prøv igen senere.' });
  const pre = 'data:image/jpeg;base64,', s = String((req.body || {}).data || '');
  if (!s.startsWith(pre)) return res.status(400).json({ error: 'Kun JPEG-billeder.' });
  const buf = Buffer.from(s.slice(pre.length), 'base64');
  if (buf.length < 200 || buf.length > 1.5e6 || buf[0] !== 0xFF || buf[1] !== 0xD8 || buf[2] !== 0xFF) return res.status(400).json({ error: 'Billedet er ugyldigt eller for stort.' });
  h.push(now()); upHits.set(cid, h);
  const kind = req.body.kind === 'avatar' ? 'avatar' : 'chat', file = rid(16) + '.jpg';
  fs.writeFileSync(path.join(UP, file), buf); db.uploads[file] = { cid, kind, at: iso() };
  if (kind === 'avatar') { dropFile(c.avatar); c.avatar = file; }
  save(); res.json({ file });
});
app.get('/img/:file', (req, res) => {
  if (!/^[a-f0-9]{32}\.jpg$/.test(req.params.file) || !db.uploads[req.params.file]) return res.sendStatus(404);
  res.set({ 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' });
  res.type('image/jpeg'); res.sendFile(req.params.file, { root: UP });
});

app.get('/api/convs/:cid', (req, res) => {
  const id = req.params.cid, c = cust(req, res); if (!c) return;
  const profiles = Object.entries(db.profiles).map(([pid, p]) => pubProfile(pid, p));
  const convs = convKeys(id).map(k => db.convs[k]).filter(v => v.msgs.length && db.profiles[v.pid]).map(v => {
    const m = v.msgs.at(-1), p = db.profiles[v.pid];
    const seen = (c.seen || {})[v.pid] || '', unread = v.msgs.filter(x => x.from === 'm' && x.at > seen).length;
    return { pid: v.pid, unread, name: p.name, tagline: p.tagline || '', avatar: p.avatar || '', last: m.text || (m.img ? '📷 Billede' : ''), from: m.from, at: m.at, count: v.msgs.length };
  }).sort((a, b) => b.at.localeCompare(a.at));
  res.json({ me: meOut(id, c), profiles, convs });
});
app.get('/api/chat/:cid/:pid', (req, res) => {
  const c = cust(req, res); if (!c) return; const p = db.profiles[req.params.pid];
  if (!p) return res.status(404).json({ error: 'Ukendt profil' });
  const v = db.convs[req.params.cid + '~' + req.params.pid];
  const lastO = v ? (v.msgs.filter(x => x.from === 'm').at(-1) || {}).at : null;
  if (lastO && ((c.seen ||= {})[req.params.pid] || '') < lastO) { c.seen[req.params.pid] = lastO; save(); }
  res.json({ me: meOut(req.params.cid, c), profile: pubProfile(req.params.pid, p), msgs: v ? v.msgs.map(pubMsg) : [] });
});
app.post('/api/chat/:cid/:pid', (req, res) => {
  const c = cust(req, res); if (!c) return; const id = req.params.cid, pid = req.params.pid, b = req.body || {};
  if (!db.profiles[pid]) return res.status(404).json({ error: 'Ukendt profil' });
  const text = cl(b.text, 1000), img = String(b.img || '');
  if (!text && !img) return res.status(400).json({ error: 'Skriv en besked først.' });
  if (img) { const u = db.uploads[img]; if (!u || u.cid !== id || u.kind !== 'chat') return res.status(400).json({ error: 'Ugyldigt billede.' }); }
  if (c.blocked) return res.status(403).json({ error: 'Din konto er spærret.' });
  if (!c.consented) return res.status(403).json({ error: 'Giv samtykke under "Køb kreditter" først.' });
  if (c.credits < COST) return res.status(402).json({ error: 'Ikke nok kreditter.' });
  const v = conv(id, pid); c.credits -= COST; if (v.status === 'closed') v.status = 'open';
  v.msgs.push({ from: 'c', text, img, at: iso() }); save(); res.json({ ok: true, credits: c.credits });
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
setInterval(() => {                                  // frigiv samtaler og log inaktive operatører ud
  let ch = false;
  for (const c of Object.values(db.convs)) {
    if (!c.claim) continue;
    if (!pending(c)) { delete c.claim; ch = true; continue; }
    if (now() - c.claim.since > IDLE_MS) {
      const u = c.claim.by; delete c.claim; ch = true;
      if (db.operators[u] && db.operators[u].role !== 'admin') for (const [t, s] of sessions) if (s.username === u) sessions.delete(t);
    }
  }
  if (ch) save();
}, Math.min(10000, IDLE_MS / 3)).unref();
app.use('/api/op', op);
op.get('/next', (req, res) => {
  const me = req.op.username, free = c => (!c.claim || c.claim.by === me) && (!c.resv || c.resv.by === me || c.resv.until < now());   // kun én operatør pr. samtale
  const queue = Object.entries(db.convs).filter(([, c]) => pending(c) && canSee(req.op, c) && free(c));
  const cur = cv(req, req.query.cur);
  let id = cur && cur.status === 'open' && cur.holdUntil < now() ? req.query.cur : null;
  if (!id && queue.length) id = queue.sort((a, b) => a[1].msgs.at(-1).at.localeCompare(b[1].msgs.at(-1).at))[0][0];
  if (!id) return res.json({ none: true, queue: 0 });
  const c = db.convs[id], u = db.customers[c.cid]; if (!u) return res.json({ none: true, queue: 0 });
  let left = null;
  if (pending(c)) {                                   // ny kundebesked: samtalen låses til denne operatør
    const lastC = c.msgs.at(-1).at;
    if (!c.claim || c.claim.by !== me || c.claim.msgAt !== lastC) c.claim = { by: me, since: now(), msgAt: lastC };
    left = Math.max(0, c.claim.since + IDLE_MS - now());
  } else if (c.claim && c.claim.by === me) delete c.claim;
  res.json({ id, left: left, queue: queue.length, profile: (db.profiles[c.pid] || {}).name || '', gallery: ((db.profiles[c.pid] || {}).gallery || []).map(g => ({ file: g.file, label: g.source === 'illustration' ? 'Illustration' : '' })), conv: c, customer: { about: u.about || '', avatar: u.avatar || '', name: u.name, first: u.first, last: u.last, age: u.age, city: u.city, likes: u.likes, seeking: u.sensitiveConsent ? u.seeking : '', credits: u.credits, sensitive: u.sensitiveConsent },
    inCount: c.msgs.filter(m => m.from === 'c').length, outCount: c.msgs.filter(m => m.from === 'm').length });
});
op.post('/send', (req, res) => {
  const c = cv(req, req.body.id), t = cl(req.body.text, 1000), img = String(req.body.img || '');
  if (!c || (!t && !img)) return res.sendStatus(400);
  let label = '';
  if (img) { const u = db.uploads[img]; if (!u || u.kind !== 'gallery' || u.pid !== c.pid) return res.status(400).json({ error: 'Billedet hører ikke til denne profil.' }); label = u.source === 'illustration' ? 'Illustration' : ''; }
  delete c.claim; c.resv = { by: req.op.username, until: now() + IDLE_MS };   // samme operatør fortsætter samtalen i 3 min
  c.msgs.push({ from: 'm', text: t, img, label, by: req.op.username, at: iso() }); (db.opLog ||= []).push({ op: req.op.username, at: iso() }); save(); res.json({ ok: true });
});
op.post('/note', (req, res) => {
  const c = cv(req, req.body.id); if (!c) return res.sendStatus(404);
  const { action, noteId, text, important, until } = req.body, n = c.notes.find(x => x.id === noteId);
  if (action === 'add') c.notes.push({ id: rid(4), text: String(text).slice(0, 500), important: !!important, until: until || '', at: iso() });
  if (action === 'edit' && n) n.text = String(text).slice(0, 500);
  if (action === 'del') c.notes = c.notes.filter(x => x.id !== noteId);
  save(); res.json({ ok: true });
});
op.post('/log', (req, res) => {
  const { id, person, category, text } = req.body, c = cv(req, id), u = c && db.customers[c.cid];
  if (!c || !u || !text || !['man', 'woman'].includes(person)) return res.sendStatus(400);
  if (person === 'man' && ['Health', 'Sexual preference'].includes(category) && !u.sensitiveConsent)
    return res.status(403).json({ error: 'Kunden har ikke givet samtykke til denne kategori.' });
  (c.logs[person][category] ||= []).push({ text: String(text).slice(0, 500), at: iso() }); save(); res.json({ ok: true });
});
op.post('/status', (req, res) => {
  const c = cv(req, req.body.id); if (!c) return res.sendStatus(404);
  const { status, minutes, assignee } = req.body;
  if (['hold', 'panic', 'closed'].includes(status)) { delete c.claim; delete c.resv; }
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
  .map(([id, c]) => ({ id, name: (db.customers[c.cid] || {}).name, profile: (db.profiles[c.pid] || {}).name, msgs: c.msgs.slice(-20), notes: c.notes }))));
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
  delete db.operators[req.params.u]; for (const p of Object.values(db.profiles)) p.operators = (p.operators || []).filter(x => x !== req.params.u);
  for (const [t, s] of sessions) if (s.username === req.params.u) sessions.delete(t);
  save(); res.json({ ok: true });
});


// Moderator kan fjerne et billede, en kunde har sendt (fx ulovligt indhold)
op.post('/delmsg', (req, res) => {
  const c = cv(req, req.body.id), m = c && c.msgs[req.body.idx]; if (!m) return res.sendStatus(404);
  const u = db.uploads[m.img]; if (u && u.kind === 'chat') dropFile(m.img); m.img = ''; if (!m.text) m.text = '[Billede fjernet af moderator]'; save(); res.json({ ok: true });
});
// Admin: profiler kunderne kan skrive med. Fotos kræver en erklæring og illustrationer mærkes over for kunderne.
const opNames = () => Object.entries(db.operators).filter(([, o]) => o.role === 'operator').map(([u]) => u);
const adminProfile = (id, p) => ({ id, name: p.name, tagline: p.tagline || '', bio: p.bio || '', avatar: p.avatar || '', avatarSource: p.avatarSource || '',
  gallery: p.gallery || [], operators: p.operators || [] });
const profileFields = b => ({ name: cl(b.name, 30), tagline: cl(b.tagline, 80), bio: cl(b.bio, 600),
  operators: [...new Set((Array.isArray(b.operators) ? b.operators : []).map(String).filter(u => opNames().includes(u)))] });

op.get('/admin/customers', admin, (_, res) => res.json(Object.entries(db.customers).map(([id, c]) => ({ id, name: c.name || '', email: c.email || '', verified: !!c.emailVerified, credits: c.credits || 0,
  blocked: !!c.blocked, msgs: convKeys(id).reduce((n, k) => n + db.convs[k].msgs.filter(m => m.from === 'c').length, 0) })).sort((a, b) => b.msgs - a.msgs)));
op.post('/admin/customers/:id/credits', admin, (req, res) => { const c = db.customers[req.params.id], d = parseInt(req.body.delta, 10);
  if (!c || !Number.isFinite(d) || Math.abs(d) > 100000) return res.sendStatus(400);
  c.credits = Math.max(0, (c.credits || 0) + d); save(); res.json({ ok: true, credits: c.credits }); });
op.post('/admin/customers/:id/block', admin, (req, res) => { const c = db.customers[req.params.id]; if (!c) return res.sendStatus(404);
  c.blocked = !!req.body.blocked; save(); res.json({ ok: true }); });
op.get('/admin/profiles', admin, (_, res) => res.json({ profiles: Object.entries(db.profiles).map(([id, p]) => adminProfile(id, p)), operators: opNames() }));
op.post('/admin/profiles', admin, (req, res) => {
  const f = profileFields(req.body || {}); if (f.name.length < 2) return res.status(400).json({ error: 'Name: min 2 characters.' });
  const id = rid(4); db.profiles[id] = { ...f, avatar: '', avatarSource: '', gallery: [] }; save(); res.json({ ok: true, id });
});
op.put('/admin/profiles/:id', admin, (req, res) => {
  const p = db.profiles[req.params.id]; if (!p) return res.sendStatus(404);
  const f = profileFields(req.body || {}); if (f.name.length < 2) return res.status(400).json({ error: 'Name: min 2 characters.' });
  Object.assign(p, f); save(); res.json({ ok: true });
});
op.post('/admin/profiles/:id/photo', admin, (req, res) => {
  const p = db.profiles[req.params.id]; if (!p) return res.sendStatus(404); const b = req.body || {};
  if (b.attest !== true || !['own', 'illustration'].includes(b.source)) return res.status(400).json({ error: 'Choose the image type and confirm the statement.' });
  const pre = 'data:image/jpeg;base64,', s = String(b.data || '');
  if (!s.startsWith(pre)) return res.status(400).json({ error: 'JPEG only.' });
  const buf = Buffer.from(s.slice(pre.length), 'base64');
  if (buf.length < 200 || buf.length > 1.5e6 || buf[0] !== 0xFF || buf[1] !== 0xD8 || buf[2] !== 0xFF) return res.status(400).json({ error: 'Invalid or too large image.' });
  const kind = b.kind === 'avatar' ? 'persona' : 'gallery', file = rid(16) + '.jpg';
  fs.writeFileSync(path.join(UP, file), buf);
  db.uploads[file] = { cid: null, pid: req.params.id, kind, source: b.source, attested: true, by: req.op.username, at: iso() };
  if (kind === 'persona') { dropFile(p.avatar); p.avatar = file; p.avatarSource = b.source; }
  else (p.gallery ||= []).push({ file, source: b.source });
  save(); res.json({ ok: true, file });
});
op.delete('/admin/profiles/:id/photo/:file', admin, (req, res) => {
  const p = db.profiles[req.params.id]; if (!p) return res.sendStatus(404); const f = req.params.file;
  if (p.avatar === f) { p.avatar = ''; p.avatarSource = ''; dropFile(f); }
  else if ((p.gallery || []).some(g => g.file === f)) { p.gallery = p.gallery.filter(g => g.file !== f); dropFile(f); }
  else return res.sendStatus(404);
  save(); res.json({ ok: true });
});
op.delete('/admin/profiles/:id', admin, (req, res) => {
  const p = db.profiles[req.params.id]; if (!p) return res.sendStatus(404);
  if (Object.keys(db.profiles).length < 2) return res.status(409).json({ error: 'Cannot delete the last profile.' });
  if (Object.values(db.convs).some(c => c.pid === req.params.id)) return res.status(409).json({ error: 'This profile has conversations and cannot be deleted.' });
  dropFile(p.avatar); (p.gallery || []).forEach(g => dropFile(g.file)); delete db.profiles[req.params.id]; save(); res.json({ ok: true });
});

app.use((req, res) => { if (/^\/(api|img)\//.test(req.path)) return res.status(404).json({ error: 'Ikke fundet' }); res.status(404).sendFile(path.join(PUB, '404.html')); });
app.listen(PORT, () => console.log('http://localhost:' + PORT));
