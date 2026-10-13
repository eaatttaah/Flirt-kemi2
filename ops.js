// Moderator-/admin-kerne: central kø, opgaver (reminder/match/ASA), låse, hold, panic, statistik, likes, AI.
// Indlæses fra server.js:  require('./ops')({ app, op, db, ... })
module.exports = function (C) {
  const { app, op, db, save, now, iso, rid, conv, convKeys, canSee, COST, cl, sessions, pending, dropFile } = C;
  const TASK_TYPES = ['reminder', 'match', 'asa'];
  const CATS = ['Name', 'City', 'Work', 'Family', 'Personal preferences', 'Health', 'Hobbies', 'Transportation', 'Sexual preferences', 'Holidays', 'Other'];

  // ---------------- Indstillinger (ændres af admin) ----------------
  const DEF = {
    tz: 'Europe/Copenhagen', idleMinutes: 3, autoAssign: false,
    priority: ['live', 'match', 'reminder'],
    reminder: { enabled: true, times: ['15:00', '19:00'], idleMinutes: 120, maxPerDay: 2, maxPerRun: 300 },
    asa: { enabled: true, inactiveDays: 7, cooldownDays: 14, runAt: '11:00' },
    dup: { enabled: true, threshold: 0.8, days: 14 },
    pay: { live: 1, reminder: 1.5, match: 1.5, asa: 0, admin: 0 },
    ai: { assist: true, style: 'Legende, varm og flirtende (antydende, ikke grafisk eksplicit). Korte beskeder på 1-3 sætninger. Skriv på kundens sprog (som udgangspunkt dansk).',
      night: { enabled: false, from: '23:00', to: '07:00', profiles: [], delaySec: 45, maxPerHourPerConv: 20 }, dailyLimit: 300 },
  };
  const merge = (a, b) => { for (const k of Object.keys(b)) { if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) { a[k] = merge(a[k] && typeof a[k] === 'object' ? a[k] : {}, b[k]); } else if (a[k] === undefined) a[k] = b[k]; } return a; };
  db.settings = merge(db.settings || {}, JSON.parse(JSON.stringify(DEF)));
  db.tasks ||= {}; db.likes ||= {}; db.sched ||= {}; db.aiUsage ||= {};
  const S = () => db.settings;
  const idleMs = () => Number(process.env.OP_IDLE_MS) || Math.max(1, Number(S().idleMinutes) || 3) * 60000;

  // Migrér gamle log-kategorier til de nye navne
  const RENAME = { 'Personal preference': 'Personal preferences', Hobby: 'Hobbies', 'Sexual preference': 'Sexual preferences', Holiday: 'Holidays' };
  for (const c of Object.values(db.convs)) for (const who of ['man', 'woman']) for (const [o, n] of Object.entries(RENAME))
    if (c.logs && c.logs[who] && c.logs[who][o]) { (c.logs[who][n] ||= []).push(...c.logs[who][o]); delete c.logs[who][o]; }

  // ---------------- Tid (Danmark) ----------------
  const tzParts = (t = now()) => {
    const o = {}; for (const p of new Intl.DateTimeFormat('en-CA', { timeZone: S().tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t))) o[p.type] = p.value;
    return { date: o.year + '-' + o.month + '-' + o.day, hm: o.hour + ':' + o.minute };
  };
  const dayKey = t => tzParts(t).date;
  const lastDays = n => { const s = new Set(); for (let i = 0; i < n; i++) s.add(dayKey(now() - i * 864e5)); return s; };
  const hmOk = v => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  const inWindow = (from, to) => { const h = tzParts().hm; return from <= to ? h >= from && h < to : h >= from || h < to; };

  // ---------------- Hjælpere ----------------
  const blockedCust = c => { const u = db.customers[c.cid]; return !u || u.blocked; };
  const convOf = t => db.convs[t.convKey];
  const syncLike = t => { if (!t.likeId || !db.likes[t.likeId]) return; db.likes[t.likeId].status = { open: 'queued', claimed: 'assigned', done: 'completed', cancelled: 'cancelled' }[t.status] || 'queued'; };
  const setTask = (t, status, extra) => { t.status = status; Object.assign(t, extra || {}); syncLike(t); };
  const openTaskFor = key => Object.values(db.tasks).find(t => t.convKey === key && (t.status === 'open' || t.status === 'claimed'));
  function release(c, opts = {}) {
    if (!c || !c.claim) return;
    const t = c.claim.taskId && db.tasks[c.claim.taskId];
    if (t && t.status === 'claimed') { setTask(t, opts.done ? 'done' : 'open', opts.done ? { doneAt: iso(), doneBy: c.claim.by, doneNote: opts.note || '' } : {}); if (!opts.done) delete t.claim; }
    delete c.claim;
  }
  const taskOf = c => c && c.claim && c.claim.taskId && db.tasks[c.claim.taskId];

  // ---------------- Kø ----------------
  const taskWorkable = (t, c) => t.status === 'open' && c && c.status !== 'panic' && c.holdUntil <= now() && !blockedCust(c) && !(pending(c));
  function items(s) {
    const me = s.username, out = [], free = c => !c.claim || c.claim.by === me, resv = c => !c.resv || c.resv.by === me || c.resv.until < now();
    if (s.role === 'admin') {
      for (const [k, c] of Object.entries(db.convs)) if (c.status === 'panic' && free(c) && db.customers[c.cid]) out.push({ type: 'panic', key: k, since: (c.panic && c.panic.at) || c.started });
      for (const t of Object.values(db.tasks)) { const c = convOf(t); if (t.type === 'asa' && taskWorkable(t, c) && free(c)) out.push({ type: 'asa', key: t.convKey, taskId: t.id, since: t.createdAt }); }
      const rank = { panic: 0, asa: 1 };
      return out.sort((a, b) => rank[a.type] - rank[b.type] || a.since.localeCompare(b.since));
    }
    for (const [k, c] of Object.entries(db.convs)) if (pending(c) && !blockedCust(c) && canSee(s, c) && free(c) && resv(c)) out.push({ type: 'live', key: k, since: c.msgs.at(-1).at });
    for (const t of Object.values(db.tasks)) { if (t.type === 'asa') continue; const c = convOf(t); if (taskWorkable(t, c) && canSee(s, c) && free(c)) out.push({ type: t.type, key: t.convKey, taskId: t.id, since: t.createdAt }); }
    const pr = S().priority, rank = ty => { const i = pr.indexOf(ty); return i < 0 ? 99 : i; };
    return out.sort((a, b) => rank(a.type) - rank(b.type) || a.since.localeCompare(b.since));
  }
  const counts = s => { const o = {}; for (const i of items(s)) o[i.type] = (o[i.type] || 0) + 1; return o; };
  const myClaimKey = me => Object.keys(db.convs).find(k => db.convs[k].claim && db.convs[k].claim.by === me);
  function claim(s, it) {
    const c = db.convs[it.key]; c.claim = { by: s.username, since: now(), seen: now(), type: it.type, taskId: it.taskId || '' };
    if (it.taskId) { setTask(db.tasks[it.taskId], 'claimed', { claim: { by: s.username, at: iso() } }); }
    save();
  }
  const pick = s => { const it = items(s)[0]; if (it) claim(s, it); return it; };

  op.post('/get-next', (req, res) => {
    const s = req.op, mine = myClaimKey(s.username);
    if (mine) return res.json({ ok: true, key: mine, already: true });
    const it = pick(s); if (!it) return res.json({ ok: true, none: true, counts: counts(s) });
    res.json({ ok: true, key: it.key, type: it.type });
  });

  op.post('/open', (req, res) => {                       // admin åbner en vilkårlig samtale i arbejdsområdet
    if (req.op.role !== 'admin') return res.sendStatus(403);
    const c = db.convs[req.body.id]; if (!c) return res.sendStatus(404);
    if (c.claim && c.claim.by !== req.op.username) return res.status(409).json({ error: 'Samtalen er låst af ' + c.claim.by + '.' });
    const mine = myClaimKey(req.op.username); if (mine && mine !== req.body.id) release(db.convs[mine]);
    if (!c.claim) c.claim = { by: req.op.username, since: now(), seen: now(), type: c.status === 'panic' ? 'panic' : 'admin', taskId: '' };
    save(); res.json({ ok: true, key: req.body.id });
  });

  const payload = (k, s) => {
    const c = db.convs[k], u = db.customers[c.cid], pr = db.profiles[c.pid] || {}, t = taskOf(c), cl2 = c.claim;
    const ago = ms => Math.max(0, Math.round(ms / 60000));
    let info = null;
    if (cl2.type === 'reminder' && t) info = { title: 'REMINDER', text: 'Kunden har ikke svaret i ' + ago(now() - Date.parse((c.msgs.at(-1) || {}).at || t.createdAt)) + ' min. Læs historikken og skriv en personlig besked.' };
    if (cl2.type === 'match' && t) info = { title: 'MATCH MESSAGE', text: (u.name || 'Kunden') + ' har liket ' + (pr.name || 'profilen') + '. Skriv en personlig besked.' };
    if (cl2.type === 'asa' && t) info = { title: 'ASA – REAKTIVERING (kun admin)', text: 'Kunden har været inaktiv i ' + Math.round((now() - Date.parse(t.lastActive || t.createdAt)) / 864e5) + ' dage. Gennemgå samtalen og skriv selv beskeden.', red: true };
    if (cl2.type === 'panic') info = { title: 'PANIC ROOM', text: 'Bedt om hjælp af ' + ((c.panic && c.panic.by) || '?') + (c.panic && c.panic.reason ? ': ' + c.panic.reason : '.'), red: true };
    return {
      id: k, type: cl2.type, task: info, left: s.role === 'admin' || cl2.type === 'admin' ? null : Math.max(0, cl2.since + idleMs() - now()),
      pinfo: { name: pr.name || '', tagline: pr.tagline || '', bio: pr.bio || '', avatar: pr.avatar || '', label: pr.avatar && pr.avatarSource === 'illustration' ? 'Illustration' : '', photos: (pr.gallery || []).length },
      queue: Object.values(counts(s)).reduce((a, b) => a + b, 0), counts: counts(s), profile: pr.name || '',
      gallery: (pr.gallery || []).map(g => ({ file: g.file, label: g.source === 'illustration' ? 'Illustration' : '' })),
      conv: c, customer: { about: u.about || '', avatar: u.avatar || '', name: u.name, first: u.first, last: u.last, age: u.age, city: u.city, likes: u.likes, seeking: u.sensitiveConsent ? u.seeking : '', credits: u.credits, sensitive: u.sensitiveConsent },
      inCount: c.msgs.filter(m => m.from === 'c').length, outCount: c.msgs.filter(m => m.from === 'm').length,
      ai: !!(S().ai.assist && process.env.ANTHROPIC_API_KEY), role: s.role,
    };
  };
  op.get('/next', (req, res) => {
    const s = req.op; let k = myClaimKey(s.username);
    if (!k && S().autoAssign) { const it = pick(s); if (it) k = it.key; }
    if (!k) return res.json({ none: true, queue: 0, counts: counts(s), role: s.role });
    const c = db.convs[k]; if (!db.customers[c.cid]) { release(c); save(); return res.json({ none: true, queue: 0, counts: counts(s), role: s.role }); }
    c.claim.seen = now(); res.json(payload(k, s));
  });

  // ---------------- Dublet-/kopi-beskyttelse (kun opgavebeskeder) ----------------
  const words = (t, skip) => String(t).toLowerCase().normalize('NFKC').replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(w => w && !skip.has(w));
  const shingles = w => { const k = w.length >= 5 ? 3 : 1, s = new Set(); for (let i = 0; i + k <= w.length; i++) s.add(w.slice(i, i + k).join(' ')); return s; };
  const jac = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };
  function tooSimilar(text, c, selfKey) {
    const D = S().dup; if (!D.enabled) return false;
    const names = new Set(); for (const n of [(db.customers[c.cid] || {}).name, (db.customers[c.cid] || {}).first, (db.customers[c.cid] || {}).nick, (db.profiles[c.pid] || {}).name]) String(n || '').toLowerCase().split(/\s+/).forEach(x => x && names.add(x));
    const w = words(text, names); if (w.length < 3) return false; const sh = shingles(w), key = w.join(' '), since = now() - D.days * 864e5;
    for (const [k, cc] of Object.entries(db.convs)) for (const m of cc.msgs) {
      if (m.from !== 'm' || !TASK_TYPES.includes(m.kind) || Date.parse(m.at) < since) continue;
      const w2 = words(m.text, names); if (w2.length < 3) continue;
      if (w2.join(' ') === key || jac(sh, shingles(w2)) >= D.threshold) return true;
    }
    return false;
  }

  // ---------------- Send ----------------
  op.post('/send', (req, res) => {
    const s = req.op, c = db.convs[req.body.id], t = cl(req.body.text, 1000), img = String(req.body.img || '');
    if (!c || (!t && !img)) return res.sendStatus(400);
    if (!c.claim || c.claim.by !== s.username) return res.status(409).json({ error: 'Du har ikke denne samtale. Tryk "Get Next Message".' });
    let label = '';
    if (img) { const u = db.uploads[img]; if (!u || u.kind !== 'gallery' || u.pid !== c.pid) return res.status(400).json({ error: 'Billedet hører ikke til denne profil.' }); label = u.source === 'illustration' ? 'Illustration' : ''; }
    const type = c.claim.type, kind = type === 'panic' ? 'admin' : type;
    if (TASK_TYPES.includes(kind) && t && tooSimilar(t, c))
      return res.status(422).json({ error: 'Beskeden ligner for meget en tidligere påmindelse/match-besked. Skriv den om, så den passer personligt til denne kunde.' });
    const task = taskOf(c);
    c.msgs.push({ from: 'm', text: t, img, label, by: s.username, kind, at: iso() });
    (db.opLog ||= []).push({ op: s.username, at: iso() });
    if (task) release(c, { done: true, note: 'message sent' }); else delete c.claim;
    if (type === 'live') c.resv = { by: s.username, until: now() + idleMs() };
    if (type === 'panic') { c.status = 'open'; c.panic = Object.assign(c.panic || {}, { resolvedAt: iso(), resolvedBy: s.username }); }
    save(); res.json({ ok: true });
  });

  op.post('/task/complete', (req, res) => {              // afslut opgaven uden at skrive (fx ingen grund til at kontakte kunden)
    const c = db.convs[req.body.id];
    if (!c || !c.claim || c.claim.by !== req.op.username) return res.sendStatus(404);
    const wasTask = !!taskOf(c); release(c, { done: wasTask, note: 'completed without message' }); save(); res.json({ ok: true });
  });

  // ---------------- Hold / Panic / Luk ----------------
  const HOLD = [5, 15, 30, 60, 120];
  op.post('/status', (req, res) => {
    const s = req.op, c = db.convs[req.body.id]; if (!c) return res.sendStatus(404);
    if (!c.claim || c.claim.by !== s.username) { if (!(s.role === 'admin' && req.body.status === 'open')) return res.status(409).json({ error: 'Du har ikke denne samtale.' }); }
    const { status, minutes, reason } = req.body;
    if (status === 'hold') {
      const m = Number(minutes); if (!HOLD.includes(m)) return res.status(400).json({ error: 'Vælg 5, 15, 30, 60 eller 120 minutter.' });
      c.holdUntil = now() + m * 60000; release(c); delete c.resv;
    } else if (status === 'panic' || status === 'help') {
      c.status = 'panic'; c.panic = { by: s.username, at: iso(), reason: cl(reason, 300) }; release(c); delete c.resv;
    } else if (status === 'closed') {
      const wasTask = !!taskOf(c); release(c, { done: wasTask, note: 'closed' }); c.status = 'closed'; delete c.resv;
    } else if (status === 'open' && s.role === 'admin') {
      c.status = 'open'; if (c.panic) c.panic.resolvedAt = iso(); release(c);
    } else return res.status(400).json({ error: 'Ukendt status.' });
    save(); res.json({ ok: true });
  });

  // ---------------- Logs: kun gyldige kategorier ----------------
  op.post('/log', (req, res) => {
    const { id, person, category, text } = req.body, c = db.convs[id], u = c && db.customers[c.cid];
    if (!c || !u || !text || !['man', 'woman'].includes(person) || !CATS.includes(category)) return res.sendStatus(400);
    if (!c.claim || c.claim.by !== req.op.username) return res.status(409).json({ error: 'Du har ikke denne samtale.' });
    if (person === 'man' && ['Health', 'Sexual preferences'].includes(category) && !u.sensitiveConsent) return res.status(403).json({ error: 'Kunden har ikke givet samtykke til denne kategori.' });
    (c.logs[person][category] ||= []).push({ text: String(text).slice(0, 500), at: iso(), by: req.op.username }); save(); res.json({ ok: true });
  });

  // ---------------- Sweeper: låse, inaktivitet, opgavegenerering ----------------
  const createTask = (type, key, extra) => {
    const c = db.convs[key]; if (!c || openTaskFor(key)) return null;
    const t = Object.assign({ id: 't' + rid(5), type, convKey: key, cid: c.cid, pid: c.pid, status: 'open', createdAt: iso() }, extra || {}); db.tasks[t.id] = t; return t;
  };
  function makeReminders(slot) {
    const R = S().reminder; let n = 0; const dk = dayKey(now());
    for (const [k, c] of Object.entries(db.convs)) {
      if (n >= R.maxPerRun) break;
      if (c.status !== 'open' || c.holdUntil > now() || c.claim || blockedCust(c) || !c.msgs.length || openTaskFor(k)) continue;
      const last = c.msgs.at(-1); if (last.from !== 'm') continue;                       // kunden har selv skrevet sidst => live-besked, ikke reminder
      if (!c.msgs.some(m => m.from === 'c')) continue;                                   // kun samtaler kunden har deltaget i
      if (now() - Date.parse(last.at) < R.idleMinutes * 60000) continue;
      const today = Object.values(db.tasks).filter(t => t.convKey === k && t.type === 'reminder' && dayKey(Date.parse(t.createdAt)) === dk).length;
      if (today >= R.maxPerDay) continue;
      createTask('reminder', k, { slot }); n++;
    }
    return n;
  }
  function makeAsa() {
    const A = S().asa; let n = 0; const seen = new Set();
    for (const [k, c] of Object.entries(db.convs)) {
      const u = db.customers[c.cid]; if (!u || u.blocked || seen.has(c.cid)) continue;
      const mine = convKeys(c.cid).map(x => db.convs[x]), lastC = Math.max(0, ...mine.flatMap(x => x.msgs.filter(m => m.from === 'c').map(m => Date.parse(m.at))));
      if (!lastC || now() - lastC < A.inactiveDays * 864e5) continue;
      seen.add(c.cid);
      if (Object.values(db.tasks).some(t => t.cid === c.cid && (t.status === 'open' || t.status === 'claimed'))) continue;
      if (Object.values(db.tasks).some(t => t.cid === c.cid && t.type === 'asa' && now() - Date.parse(t.createdAt) < A.cooldownDays * 864e5)) continue;
      const best = convKeys(c.cid).sort((a, b) => (db.convs[b].msgs.at(-1) || { at: '' }).at.localeCompare((db.convs[a].msgs.at(-1) || { at: '' }).at))[0];
      if (createTask('asa', best, { lastActive: new Date(lastC).toISOString() })) n++;
    }
    return n;
  }
  function runSchedulers() {
    const p = tzParts(), mins = hm => +hm.slice(0, 2) * 60 + +hm.slice(3), nowM = mins(p.hm);
    if (S().reminder.enabled) for (const T of S().reminder.times) {
      const key = 'rem:' + p.date + ':' + T; if (db.sched[key] || !hmOk(T)) continue;
      if (nowM >= mins(T) && nowM < mins(T) + 90) { db.sched[key] = true; makeReminders(T); }
    }
    if (S().asa.enabled && hmOk(S().asa.runAt)) { const key = 'asa:' + p.date; if (!db.sched[key] && nowM >= mins(S().asa.runAt) && nowM < mins(S().asa.runAt) + 180) { db.sched[key] = true; makeAsa(); } }
    for (const k of Object.keys(db.sched)) if (k.slice(4, 14) < dayKey(now() - 3 * 864e5)) delete db.sched[k];
  }
  function sweep() {
    let ch = false;
    for (const c of Object.values(db.convs)) {
      if (c.claim) {
        const u = c.claim.by, isAdm = (db.operators[u] || {}).role === 'admin';
        if (now() - (c.claim.seen || c.claim.since) > 60000) { release(c); ch = true; }                      // fane lukket
        else if (!isAdm && c.claim.type !== 'admin' && now() - c.claim.since > idleMs()) {                      // ikke besvaret i tide
          release(c); ch = true; for (const [t, s] of sessions) if (s.username === u) sessions.delete(t);
        }
      }
    }
    for (const t of Object.values(db.tasks)) {
      const c = convOf(t);
      if (t.status === 'open' && (!c || !db.customers[t.cid])) { setTask(t, 'cancelled', { reason: 'customer deleted' }); ch = true; }
      else if (t.status === 'open' && t.type !== 'match' && c && pending(c)) { setTask(t, 'cancelled', { reason: 'customer replied' }); ch = true; }
    }
    const before = JSON.stringify(db.sched); runSchedulers(); if (JSON.stringify(db.sched) !== before) ch = true;
    if (C.ai) C.ai.tick();
    if (ch) save();
  }
  setInterval(sweep, Math.min(10000, idleMs() / 3)).unref();

  // ---------------- Logout ----------------
  op.post('/logout', (req, res) => {
    for (const c of Object.values(db.convs)) if (c.claim && c.claim.by === req.op.username) release(c);
    sessions.delete(req.get('x-op-token')); save(); res.json({ ok: true });
  });

  // ---------------- Statistik / indtjening ----------------
  const payOf = k => Number(S().pay[k]) || 0;
  function earn(user) {
    const t0 = dayKey(now()), d7 = lastDays(7), d30 = lastDays(30), r = { today: { n: 0, dkk: 0 }, d7: { n: 0, dkk: 0 }, d30: { n: 0, dkk: 0 } }, byKind = {};
    for (const c of Object.values(db.convs)) for (const m of c.msgs) {
      if (m.from !== 'm' || m.by !== user) continue; const d = dayKey(Date.parse(m.at)), k = m.kind || 'live', v = payOf(k);
      for (const [w, ok] of [['today', d === t0], ['d7', d7.has(d)], ['d30', d30.has(d)]]) if (ok) { r[w].n++; r[w].dkk += v; }
      if (d30.has(d)) byKind[k] = (byKind[k] || 0) + 1;
    }
    for (const w of Object.keys(r)) r[w].dkk = Math.round(r[w].dkk * 100) / 100;
    return Object.assign(r, { byKind });
  }
  op.get('/mystats', (req, res) => res.json(Object.assign({ user: req.op.username, currency: 'DKK', rates: S().pay }, earn(req.op.username))));
  op.get('/stats', (req, res) => {                        // bagudkompatibel
    if (req.query.me || req.op.role !== 'admin') { const e = earn(req.op.username); return res.json({ messages_today: e.today.n, earnings_today_dkk: e.today.dkk, earnings_7_days_dkk: e.d7.dkk, earnings_30_days_dkk: e.d30.dkk }); }
    const cs = Object.values(db.convs), ms = cs.flatMap(c => c.msgs);
    res.json({ conversations: cs.length, live_in_queue: cs.filter(pending).length, open_tasks: Object.values(db.tasks).filter(t => t.status === 'open').length, panic_room: cs.filter(c => c.status === 'panic').length,
      customer_messages: ms.filter(m => m.from === 'c').length, operator_messages: ms.filter(m => m.from === 'm').length });
  });

  // ---------------- Admin ----------------
  const admin = (req, res, next) => req.op.role === 'admin' ? next() : res.sendStatus(403);
  op.get('/admin/settings', admin, (_, res) => res.json({ settings: S(), aiKey: !!process.env.ANTHROPIC_API_KEY, profiles: Object.entries(db.profiles).map(([id, p]) => ({ id, name: p.name })) }));
  op.put('/admin/settings', admin, (req, res) => {
    const b = req.body || {}, n = JSON.parse(JSON.stringify(S())), bad = m => res.status(400).json({ error: m });
    const num = (v, lo, hi) => { v = Number(v); return Number.isFinite(v) && v >= lo && v <= hi ? v : null; };
    if (b.priority !== undefined) { const p = b.priority; if (!Array.isArray(p) || p.some(x => !['live', 'match', 'reminder'].includes(x)) || new Set(p).size !== 3) return bad('Prioritet skal indeholde live, match og reminder.'); n.priority = p; }
    if (b.autoAssign !== undefined) n.autoAssign = !!b.autoAssign;
    if (b.idleMinutes !== undefined) { const v = num(b.idleMinutes, 1, 60); if (v === null) return bad('Ugyldig inaktivitetstid.'); n.idleMinutes = v; }
    const R = b.reminder; if (R) {
      if (R.enabled !== undefined) n.reminder.enabled = !!R.enabled;
      if (R.times !== undefined) { if (!Array.isArray(R.times) || R.times.length > 8 || R.times.some(x => !hmOk(x))) return bad('Tider skal være HH:MM.'); n.reminder.times = [...new Set(R.times)].sort(); }
      for (const [k, lo, hi] of [['idleMinutes', 0, 4320], ['maxPerDay', 1, 10], ['maxPerRun', 1, 5000]]) if (R[k] !== undefined) { const v = num(R[k], lo, hi); if (v === null) return bad('Ugyldig ' + k); n.reminder[k] = v; }
    }
    const A = b.asa; if (A) {
      if (A.enabled !== undefined) n.asa.enabled = !!A.enabled;
      if (A.runAt !== undefined) { if (!hmOk(A.runAt)) return bad('Ugyldigt tidspunkt.'); n.asa.runAt = A.runAt; }
      for (const [k, lo, hi] of [['inactiveDays', 0, 365], ['cooldownDays', 1, 365]]) if (A[k] !== undefined) { const v = num(A[k], lo, hi); if (v === null) return bad('Ugyldig ' + k); n.asa[k] = v; }
    }
    const Dp = b.dup; if (Dp) { if (Dp.enabled !== undefined) n.dup.enabled = !!Dp.enabled; if (Dp.threshold !== undefined) { const v = num(Dp.threshold, 0.4, 1); if (v === null) return bad('Ugyldig grænse.'); n.dup.threshold = v; } if (Dp.days !== undefined) { const v = num(Dp.days, 1, 90); if (v === null) return bad('Ugyldig dage.'); n.dup.days = v; } }
    if (b.pay) for (const k of Object.keys(n.pay)) if (b.pay[k] !== undefined) { const v = num(b.pay[k], 0, 1000); if (v === null) return bad('Ugyldig takst.'); n.pay[k] = v; }
    const AI = b.ai; if (AI) {
      if (AI.assist !== undefined) n.ai.assist = !!AI.assist;
      if (AI.style !== undefined) n.ai.style = cl(AI.style, 800);
      if (AI.dailyLimit !== undefined) { const v = num(AI.dailyLimit, 0, 100000); if (v === null) return bad('Ugyldig grænse.'); n.ai.dailyLimit = v; }
      const N = AI.night; if (N) {
        if (N.enabled !== undefined) n.ai.night.enabled = !!N.enabled;
        for (const k of ['from', 'to']) if (N[k] !== undefined) { if (!hmOk(N[k])) return bad('Ugyldigt tidspunkt.'); n.ai.night[k] = N[k]; }
        if (N.profiles !== undefined) { if (!Array.isArray(N.profiles)) return bad('Ugyldige profiler.'); n.ai.night.profiles = N.profiles.filter(x => db.profiles[x]); }
        if (N.delaySec !== undefined) { const v = num(N.delaySec, 0, 600); if (v === null) return bad('Ugyldig forsinkelse.'); n.ai.night.delaySec = v; }
        if (N.maxPerHourPerConv !== undefined) { const v = num(N.maxPerHourPerConv, 1, 200); if (v === null) return bad('Ugyldig grænse.'); n.ai.night.maxPerHourPerConv = v; }
      }
    }
    db.settings = n; save(); res.json({ ok: true, settings: n });
  });
  op.post('/admin/run', admin, (req, res) => { const n = req.body.what === 'asa' ? makeAsa() : req.body.what === 'reminders' ? makeReminders('manual') : -1; if (n < 0) return res.sendStatus(400); save(); res.json({ ok: true, created: n }); });

  const nameOf = id => (db.customers[id] || {}).name || '?';
  op.get('/admin/tasks', admin, (req, res) => {
    const ty = req.query.type, st = req.query.status;
    res.json(Object.values(db.tasks).filter(t => (!ty || t.type === ty) && (!st || t.status === st)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 300)
      .map(t => ({ id: t.id, type: t.type, status: t.status, createdAt: t.createdAt, customer: nameOf(t.cid), profile: (db.profiles[t.pid] || {}).name || '?', by: (t.claim || {}).by || t.doneBy || '', slot: t.slot || '', reason: t.reason || '' })));
  });
  op.post('/admin/tasks/:id/cancel', admin, (req, res) => {
    const t = db.tasks[req.params.id]; if (!t || !['open', 'claimed'].includes(t.status)) return res.sendStatus(404);
    const c = convOf(t); if (c && c.claim && c.claim.taskId === t.id) delete c.claim; setTask(t, 'cancelled', { reason: 'cancelled by admin' }); save(); res.json({ ok: true });
  });
  op.get('/admin/queue', admin, (_, res) => {
    const all = Object.values(db.tasks), live = Object.values(db.convs).filter(pending).length;
    res.json({ live, reminder: all.filter(t => t.type === 'reminder' && t.status === 'open').length, match: all.filter(t => t.type === 'match' && t.status === 'open').length, asa: all.filter(t => t.type === 'asa' && t.status === 'open').length,
      panic: Object.values(db.convs).filter(c => c.status === 'panic').length, claimed: Object.values(db.convs).filter(c => c.claim).map(c => ({ by: c.claim.by, type: c.claim.type, customer: nameOf(c.cid), profile: (db.profiles[c.pid] || {}).name })) });
  });
  op.get('/admin/panic', admin, (_, res) => res.json(Object.entries(db.convs).filter(([, c]) => c.status === 'panic')
    .map(([id, c]) => ({ id, name: nameOf(c.cid), profile: (db.profiles[c.pid] || {}).name, by: (c.panic || {}).by, reason: (c.panic || {}).reason || '', at: (c.panic || {}).at }))));
  op.post('/admin/release', admin, (req, res) => { const c = db.convs[req.body.id]; if (!c) return res.sendStatus(404); c.status = req.body.close ? 'closed' : 'open'; release(c); save(); res.json({ ok: true }); });

  // Likes → Match Message (admin vælger manuelt)
  op.get('/admin/likes', admin, (req, res) => res.json(Object.values(db.likes).filter(l => !req.query.status || l.status === req.query.status).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 500)
    .map(l => { const u = db.customers[l.cid] || {}, t = db.tasks[l.taskId]; return { id: l.id, at: l.at, status: l.status, customer: u.name || '?', email: u.email || '', city: u.city || '', profile: (db.profiles[l.pid] || {}).name || '?', by: t ? ((t.claim || {}).by || t.doneBy || '') : '' }; })));
  op.post('/admin/likes/:id/queue', admin, (req, res) => {
    const l = db.likes[req.params.id]; if (!l) return res.sendStatus(404);
    if (l.status !== 'pending') return res.status(409).json({ error: 'Denne like er allerede behandlet (' + l.status + ').' });
    if (!db.customers[l.cid] || !db.profiles[l.pid]) return res.status(409).json({ error: 'Kunden eller profilen findes ikke længere.' });
    const key = l.cid + '~' + l.pid; conv(l.cid, l.pid);
    if (db.tasks[l.taskId] && ['open', 'claimed'].includes(db.tasks[l.taskId].status)) return res.status(409).json({ error: 'Der findes allerede en opgave.' });
    const t = createTask('match', key, { likeId: l.id, createdBy: req.op.username }); if (!t) return res.status(409).json({ error: 'Der er allerede en aktiv opgave i denne samtale.' });
    l.taskId = t.id; l.status = 'queued'; save(); res.json({ ok: true });
  });
  op.post('/admin/likes/:id/cancel', admin, (req, res) => {
    const l = db.likes[req.params.id]; if (!l) return res.sendStatus(404);
    if (['completed', 'cancelled'].includes(l.status)) return res.status(409).json({ error: 'Allerede afsluttet.' });
    const t = db.tasks[l.taskId]; if (t && ['open', 'claimed'].includes(t.status)) { const c = convOf(t); if (c && c.claim && c.claim.taskId === t.id) delete c.claim; setTask(t, 'cancelled', { reason: 'cancelled by admin' }); }
    l.status = 'cancelled'; save(); res.json({ ok: true });
  });

  // Samtalearkiv (admin)
  op.get('/admin/convs', admin, (req, res) => {
    const q = String(req.query.q || '').toLowerCase();
    res.json(Object.entries(db.convs).filter(([, c]) => c.msgs.length && db.customers[c.cid]).map(([id, c]) => { const u = db.customers[c.cid]; return { id, customer: u.name || '', email: u.email || '', profile: (db.profiles[c.pid] || {}).name || '', n: c.msgs.length, at: c.msgs.at(-1).at, status: c.status, locked: c.claim ? c.claim.by : '' }; })
      .filter(r => !q || (r.customer + ' ' + r.email + ' ' + r.profile).toLowerCase().includes(q)).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200));
  });
  op.get('/admin/convs/:id', admin, (req, res) => {
    const c = db.convs[req.params.id]; if (!c) return res.sendStatus(404); const u = db.customers[c.cid] || {};
    res.json({ id: req.params.id, customer: { name: u.name, email: u.email, first: u.first, last: u.last, age: u.age, city: u.city, likes: u.likes, about: u.about, seeking: u.sensitiveConsent ? u.seeking : '', credits: u.credits, blocked: !!u.blocked },
      profile: (db.profiles[c.pid] || {}).name, status: c.status, msgs: c.msgs, notes: c.notes, logs: c.logs, tasks: Object.values(db.tasks).filter(t => t.convKey === req.params.id).map(t => ({ type: t.type, status: t.status, at: t.createdAt })) });
  });

  // Statistik pr. moderator + omsætning
  op.get('/admin/stats', admin, (_, res) => {
    const ops = Object.entries(db.operators).filter(([, o]) => o.role !== 'admin').map(([u]) => Object.assign({ user: u }, earn(u)));
    const paid = Object.values(db.orders || {}).filter(o => o.status === 'paid'), t0 = dayKey(now()), d7 = lastDays(7), d30 = lastDays(30), rev = { today: 0, d7: 0, d30: 0 };
    for (const o of paid) { const d = dayKey(Date.parse(o.paidAt || o.at || 0)); const v = o.amount / 100; if (d === t0) rev.today += v; if (d7.has(d)) rev.d7 += v; if (d30.has(d)) rev.d30 += v; }
    const totals = { today: 0, d7: 0, d30: 0 }; for (const o of ops) for (const w of Object.keys(totals)) totals[w] += o[w].dkk;
    res.json({ operators: ops, payout_total: totals, revenue_dkk: rev, customers: Object.keys(db.customers).length, tasks: { open: Object.values(db.tasks).filter(t => t.status === 'open').length }, ai: db.aiUsage[t0] || { calls: 0 } });
  });

  // ---------------- Kunde: like ----------------
  const custOk = (req, res) => { const c = db.customers[req.params.cid]; if (!c) { res.status(404).json({ error: 'Ukendt profil' }); return null; } return c; };
  app.get('/api/likes/:cid', (req, res) => { if (!custOk(req, res)) return; res.json(Object.values(db.likes).filter(l => l.cid === req.params.cid && l.status !== 'cancelled').map(l => l.pid)); });
  app.post('/api/like/:cid/:pid', (req, res) => {
    const c = custOk(req, res); if (!c) return; if (!db.profiles[req.params.pid]) return res.status(404).json({ error: 'Ukendt profil' });
    if (c.blocked) return res.status(403).json({ error: 'Din konto er spærret.' });
    const id = req.params.cid + '~' + req.params.pid; let l = db.likes[id];
    if (!l || l.status === 'cancelled') { l = db.likes[id] = { id, cid: req.params.cid, pid: req.params.pid, at: iso(), status: 'pending', taskId: '' }; save(); }
    res.json({ ok: true, liked: true });
  });
  app.delete('/api/like/:cid/:pid', (req, res) => {
    if (!custOk(req, res)) return; const id = req.params.cid + '~' + req.params.pid, l = db.likes[id];
    if (l && l.status === 'pending') { delete db.likes[id]; save(); } res.json({ ok: true, liked: !!db.likes[id] });
  });

  // Kontosletning: fjern også opgaver og likes
  C.onCustomerDeleted = id => { for (const [k, l] of Object.entries(db.likes)) if (l.cid === id) delete db.likes[k]; for (const [k, t] of Object.entries(db.tasks)) if (t.cid === id) delete db.tasks[k]; };

  C.ops = { release, createTask, makeReminders, makeAsa, tooSimilar, S, tzParts, inWindow, CATS };
  require('./ai')(C);
};
