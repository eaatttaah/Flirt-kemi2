// AI-assisterede svar (forslag til moderatorer) og valgfri natte-autosvar (kun profiler valgt af admin).
module.exports = function (C) {
  const { op, db, save, now, iso, cl } = C, O = () => C.ops, S = () => db.settings;
  const KEY = () => process.env.ANTHROPIC_API_KEY, MODEL = () => process.env.AI_MODEL || 'claude-haiku-5-5';
  const CRISIS = /(selvmord|slå mig ihjel|tage mit eget liv|vil ikke leve|vil dø|self.?harm|kill myself|suicid|skære i mig selv)/i;
  const MINOR = /(jeg er (kun )?(1[0-7]|[0-9]) år|i am (1[0-7]|[0-9]) years|under 18)/i;
  const RULES = [
    'You write messages for a fictional character profile on an adult-only (18+) Danish flirt-chat entertainment service. Customers know profiles are fictional and run by staff or an AI assistant.',
    'Write 1-3 short sentences in the customer\'s language (default Danish). Be warm, curious and personal: refer to concrete things from the conversation and the customer facts. Never use generic template phrases.',
    'Keep it flirtatious and suggestive but never graphically explicit. Do not use sensitive personal details (health, sexual preference) unless the customer wrote them in the chat.',
    'Never agree to meet in person. Never share or ask for addresses, phone numbers, payment details, passwords or other identifying data.',
    'If the customer sincerely asks whether you are a real person, answer honestly and briefly that the profile is fictional and run by the service, then continue playfully. Never claim to be a specific real human.',
    'Refuse and steer away from anything involving minors, violence, coercion, or illegal activity.',
    'If the customer seems to be in crisis, mentions self-harm, says they are under 18, or asks for real-life help, output exactly: [ESCALATE]',
    'Output only the message text, nothing else.',
  ];
  function usage(inT, outT) { const k = O().tzParts().date, u = db.aiUsage[k] ||= { calls: 0, inTokens: 0, outTokens: 0 }; u.calls++; u.inTokens += inT || 0; u.outTokens += outT || 0; }
  const calls = () => (db.aiUsage[O().tzParts().date] || { calls: 0 }).calls;

  function build(c, hint) {
    const u = db.customers[c.cid] || {}, p = db.profiles[c.pid] || {};
    const fact = o => Object.entries(o || {}).filter(([cat]) => u.sensitiveConsent || !['Health', 'Sexual preferences'].includes(cat)).map(([cat, a]) => cat + ': ' + a.map(x => x.text).join('; ')).join('\n');
    const facts = ['Name: ' + (u.first || u.name || ''), 'Age: ' + (u.age || ''), 'City: ' + (u.city || ''), 'Likes: ' + (u.likes || ''), 'About: ' + (u.about || '')].filter(x => x.split(': ')[1]).join('\n');
    const sys = RULES.join('\n') + '\n\nProfile: ' + p.name + (p.tagline ? ' – ' + p.tagline : '') + (p.bio ? '\nBio: ' + p.bio : '') + '\nStyle: ' + S().ai.style;
    const hist = c.msgs.slice(-30).map(m => (m.from === 'c' ? 'Customer' : 'Profile') + ': ' + (m.text || '[image]')).join('\n') || '(no messages yet)';
    const user = 'Customer facts:\n' + (facts || '(none)') + '\n\nNotes from moderators about the customer:\n' + (fact(c.logs && c.logs.man) || '(none)') + '\n\nNotes about the profile:\n' + (fact(c.logs && c.logs.woman) || '(none)') + '\n\nConversation so far:\n' + hist + '\n\nTask: ' + hint + ' Write the profile\'s next message.';
    return { sys, user };
  }
  async function generate(c, hint) {
    const { sys, user } = build(c, hint);
    const r = await fetch((process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com') + '/v1/messages', { method: 'POST', headers: { 'x-api-key': KEY(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL(), max_tokens: 300, system: sys, messages: [{ role: 'user', content: user }] }) });
    if (!r.ok) throw new Error('AI ' + r.status);
    const j = await r.json(); usage(j.usage && j.usage.input_tokens, j.usage && j.usage.output_tokens);
    const text = ((j.content || []).find(x => x.type === 'text') || {}).text || '';
    return text.trim();
  }

  const lim = new Map();
  op.post('/ai/suggest', async (req, res) => {
    const c = db.convs[req.body.id];
    if (!S().ai.assist || !KEY()) return res.status(400).json({ error: 'AI er ikke aktiveret.' });
    if (!c || !c.claim || c.claim.by !== req.op.username) return res.status(409).json({ error: 'Du har ikke denne samtale.' });
    const n = (lim.get(req.op.username) || []).filter(t => now() - t < 6e4); if (n.length >= 10) return res.status(429).json({ error: 'For mange forslag. Vent lidt.' });
    if (S().ai.dailyLimit && calls() >= S().ai.dailyLimit) return res.status(429).json({ error: 'Dagens AI-grænse er nået.' });
    n.push(now()); lim.set(req.op.username, n);
    const hint = { reminder: 'The customer has not replied for a while; write a personal check-in that fits the conversation.', match: 'The customer liked this profile; write a personal opening message.', asa: 'The customer has been inactive for days; write a personal re-engagement message.' }[c.claim.type] || 'Reply to the customer\'s latest message.';
    try { const t = await generate(c, hint); if (t.startsWith('[ESCALATE]')) return res.json({ escalate: true, text: '' }); res.json({ text: t }); }
    catch (e) { console.error('ai suggest', e.message); res.status(502).json({ error: 'AI-tjenesten svarede ikke. Prøv igen.' }); }
  });

  // ---- natte-autosvar (kun admin-valgte profiler) ----
  const busy = new Set();
  function tick() {
    const N = S().ai.night; if (!N.enabled || !KEY() || !N.profiles.length || !O().inWindow(N.from, N.to)) return;
    if (S().ai.dailyLimit && calls() >= S().ai.dailyLimit) return;
    for (const [k, c] of Object.entries(db.convs)) {
      if (busy.has(k) || !N.profiles.includes(c.pid) || c.claim || !C.pending(c)) continue;
      const u = db.customers[c.cid]; if (!u || u.blocked) continue;
      const last = c.msgs.at(-1); if (now() - Date.parse(last.at) < N.delaySec * 1000) continue;
      const hourAgo = now() - 36e5; if (c.msgs.filter(m => m.ai && Date.parse(m.at) > hourAgo).length >= N.maxPerHourPerConv) continue;
      if (CRISIS.test(last.text || '') || MINOR.test(last.text || '')) { c.status = 'panic'; c.panic = { by: 'ai-filter', at: iso(), reason: 'Sikkerhedsord i kundens besked' }; save(); continue; }
      busy.add(k);
      generate(c, 'Reply to the customer\'s latest message.').then(t => {
        const cur = db.convs[k]; if (!cur || cur.claim || !C.pending(cur) || cur.msgs.at(-1).at !== last.at) return;
        if (!t || t.startsWith('[ESCALATE]')) { cur.status = 'panic'; cur.panic = { by: 'ai', at: iso(), reason: 'AI bad om hjælp' }; save(); return; }
        cur.msgs.push({ from: 'm', text: cl(t, 1000), img: '', label: '', by: 'ai', kind: 'ai', ai: true, at: iso() }); save();
      }).catch(e => console.error('ai night', e.message)).finally(() => busy.delete(k));
    }
  }
  C.ai = { tick, generate };
};
