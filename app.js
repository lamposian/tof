(function () {
  // Format seen in TextNow Android exports:
  // <html>2026-10-13 07:51 UTC - You: <br/> text<br/><br/>2026-10-13 07:51 UTC - +14752015569: <br/> text</html>
  const HEAD = /(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})(?::(\d{2}))? UTC - (.+?):\s*<br\s*\/?>/g;
  const URL_RE = /https?:\/\/[^\s<>"']+/gi;
  const decoder = new DOMParser();
  const native = window.TofAndroid || null;
  const toText = html => {
    const s = html.replace(/<br\s*\/?>/gi, '\n');
    return (decoder.parseFromString('<body>' + s, 'text/html').body.textContent || '').replace(/^\s+|\s+$/g, '');
  };

  // Picture and link messages: collect http(s) URLs from <img src> and <a href> in a message.
  const isWeb = u => /^https?:\/\//i.test(u || '');
  function mediaOf(html) {
    const doc = decoder.parseFromString('<body>' + html, 'text/html');
    const urls = [];
    doc.querySelectorAll('img[src], a[href]').forEach(el => {
      const u = (el.getAttribute('src') || el.getAttribute('href') || '').trim();
      if (isWeb(u) && !urls.includes(u)) urls.push(u);
    });
    return urls;
  }
  const urlsOf = m => [...new Set([...(m.media || []), ...((m.text || '').match(URL_RE) || [])])];

  function parseExport(raw, fileName) {
    const body = raw.replace(/^[\s\S]*?<html[^>]*>/i, '').replace(/<\/html>[\s\S]*$/i, '');
    const heads = [...body.matchAll(HEAD)];
    const msgs = [];
    heads.forEach((m, i) => {
      const start = m.index + m[0].length;
      const end = i + 1 < heads.length ? heads[i + 1].index : body.length;
      const sender = toText(m[5]);
      const when = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4] || '00'}Z`);
      const seg = body.slice(start, end);
      msgs.push({ when, you: /^you$/i.test(sender), sender, text: toText(seg), media: mediaOf(seg) });
    });
    const other = msgs.find(x => !x.you);
    const fromName = (fileName.match(/\+?\d{7,}/) || [])[0];
    const contact = other ? other.sender : (fromName || fileName.replace(/\.[^.]+$/, ''));
    msgs.forEach(x => { x.contact = contact; x.k = key(x); });
    return msgs;
  }
  const key = m => [m.contact, m.when.getTime(), m.sender, m.text].join('\u0001');

  // Example data shown until real files are added. Numbers are fictional (555).
  function exampleData() {
    const people = [['+15555550142', 34], ['+15555550187', 21], ['+15555550123', 14], ['+15555550199', 8]];
    const lines = ['On my way', 'Sounds good, see you then', 'Can you send the address?', 'Thanks!', 'Running 10 min late', 'Did you get my email?', 'Call me when you can', 'Haha yes', 'What time works tomorrow?', 'Perfect'];
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const out = []; const now = Date.UTC(2026, 9, 13);
    people.forEach(([who, n]) => {
      for (let i = 0; i < n * 3; i++) {
        const day = Math.floor(rnd() * 28), hour = [8, 9, 12, 13, 17, 18, 19, 20, 21, 22][Math.floor(rnd() * 10)];
        out.push({ contact: who, sender: rnd() < .5 ? 'You' : who, when: new Date(now - day * 864e5 + hour * 36e5 + Math.floor(rnd() * 60) * 6e4), text: lines[Math.floor(rnd() * lines.length)] });
      }
    });
    out.forEach(m => { m.you = m.sender === 'You'; m.k = key(m); });
    return out;
  }

  // ---- Storage (IndexedDB, kept in the app's own data on the phone) ----
  let db = null;
  function openDb() {
    return new Promise(res => {
      try {
        const r = indexedDB.open('tof', 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          d.createObjectStore('messages', { keyPath: 'k' });
          d.createObjectStore('records', { keyPath: 'contact' });
          d.createObjectStore('media', { keyPath: 'url' });
          d.createObjectStore('meta', { keyPath: 'id' });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
      } catch (e) { res(null); }
    });
  }
  const getAll = store => new Promise(res => {
    if (!db) return res([]);
    const q = db.transaction(store).objectStore(store).getAll();
    q.onsuccess = () => res(q.result || []); q.onerror = () => res([]);
  });
  const putAll = (store, items) => new Promise(res => {
    if (!db || !items.length) return res();
    const t = db.transaction(store, 'readwrite'); const s = t.objectStore(store);
    items.forEach(i => s.put(i));
    t.oncomplete = () => res(); t.onerror = () => { console.error(t.error); res(); };
  });
  const clearAll = () => new Promise(res => {
    if (!db) return res();
    const t = db.transaction(['messages', 'records', 'media', 'meta'], 'readwrite');
    ['messages', 'records', 'media', 'meta'].forEach(n => t.objectStore(n).clear());
    t.oncomplete = () => res(); t.onerror = () => res();
  });
  const toStored = m => ({ k: m.k, contact: m.contact, when: m.when.getTime(), you: m.you, sender: m.sender, text: m.text, media: m.media || [] });
  const fromStored = m => ({ ...m, when: new Date(m.when) });

  // ---- State ----
  let messages = [], isExample = false, selected = null, query = '';
  const records = new Map();   // contact -> {contact, fields: {name, tags, notes, ...custom}, updated}
  let fieldDefs = [];          // custom fields shared by all records: [{id, label}]
  const mediaIdx = new Map();  // url -> {url, status: saved|notmedia|failed, local, mime, size, tries}
  const pendingMedia = new Set();

  const $ = id => document.getElementById(id);
  const fmt = new Intl.NumberFormat('en');
  const dayFmt = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
  const fullFmt = new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const localDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rec = c => records.get(c) || { contact: c, fields: {} };
  const phoneNames = {};       // number -> name saved in the phone's contacts
  let contactsState = '';       // granted | denied | not-asked
  const displayName = c => (rec(c).fields.name || '').trim() || phoneNames[c] || c;
  const tagsOf = c => (rec(c).fields.tags || '').split(',').map(t => t.trim()).filter(Boolean);

  function setStatus(text, warn) { const s = $('status'); s.textContent = text; s.classList.toggle('warn', !!warn); }

  async function addFiles(files) {
    const added = [], failed = [];
    for (const f of files) {
      try {
        const msgs = parseExport(await f.text(), f.name);
        if (msgs.length) added.push(...msgs); else failed.push(f.name);
      } catch (e) { failed.push(f.name); }
    }
    const fresh = [];
    if (added.length) {
      if (isExample) { messages = []; isExample = false; selected = null; }
      const seen = new Set(messages.map(m => m.k));
      added.forEach(m => { if (!seen.has(m.k)) { seen.add(m.k); messages.push(m); fresh.push(m); } });
      await putAll('messages', fresh.map(toStored));
      selected = added[added.length - 1].contact;
    }
    const parts = [];
    if (added.length) parts.push(`Read ${fmt.format(added.length)} messages from ${files.length - failed.length} file${files.length - failed.length === 1 ? '' : 's'} (${fmt.format(fresh.length)} new).`);
    if (failed.length) parts.push(`No TextNow messages found in ${failed.join(', ')}. Check it's an exported conversation file.`);
    setStatus(parts.join(' '), failed.length > 0);
    showTab('convos');
    render();
    saveMediaFor(fresh);
    if (fresh.length) lookupContacts(false);
  }

  // ---- Media: pictures and videos are downloaded into the app so they outlive TextNow's links ----
  function saveMediaFor(msgs) {
    if (!native || isExample) return;
    msgs.forEach(m => urlsOf(m).forEach(u => {
      const e = mediaIdx.get(u);
      if (e && (['saved', 'notmedia', 'gone'].includes(e.status) || (e.tries || 0) >= 3)) return;
      if (pendingMedia.has(u)) return;
      pendingMedia.add(u);
      try { native.saveMedia(u); } catch (err) { pendingMedia.delete(u); }
    }));
  }
  let rr;
  window.__tofMediaDone = (url, status, local, mime, size) => {
    pendingMedia.delete(url);
    const prev = mediaIdx.get(url) || {};
    // A copy already on the phone always wins over a later failed or expired check.
    if (prev.status === 'saved' && status !== 'saved') { clearTimeout(rr); rr = setTimeout(renderReader, 300); return; }
    const e = { url, status, local: local || '', mime: mime || '', size: size || 0, tries: (prev.tries || 0) + (status === 'failed' ? 1 : 0), savedAt: Date.now() };
    mediaIdx.set(url, e);
    putAll('media', [e]);
    clearTimeout(rr); rr = setTimeout(renderReader, 300);
  };

  function mediaHtml(u) {
    const e = mediaIdx.get(u);
    if (e && e.status === 'notmedia') return `<a class="link" href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>`;
    if (e && e.status === 'gone') return `<span class="link gone">Picture or video expired at TextNow before Tof could save it</span>`;
    const saved = e && e.status === 'saved' && e.local;
    const src = saved ? e.local : u;
    const isVideo = saved ? /^video\//.test(e.mime) : /\.(mp4|m4v|webm|3gp|mov)(\?|#|$)/i.test(u);
    if (isVideo) return `<video class="pic" controls preload="metadata" playsinline src="${esc(src)}"></video>`;
    return `<a class="picwrap" href="${esc(u)}" target="_blank" rel="noopener noreferrer"><img class="pic" src="${esc(src)}" alt="Picture message" loading="lazy" referrerpolicy="no-referrer"></a>`;
  }
  function bodyHtml(m) {
    const words = esc((m.text || '').replace(URL_RE, '').replace(/^\s+|\s+$/g, ''));
    const pics = urlsOf(m).map(mediaHtml).join('');
    return (pics ? `<div class="pics">${pics}</div>` : '') + words;
  }

  // ---- Names from the phone's contacts (Android app only) ----
  const looksLikeNumber = c => /^\+?[\d\s().-]{6,}$/.test(c);
  function lookupContacts(ask) {
    if (!native || !native.lookupContacts || isExample) return;
    const numbers = [...new Set(messages.map(m => m.contact))].filter(looksLikeNumber);
    if (!numbers.length) return;
    let asked = false;
    try { asked = localStorage.getItem('tof-contacts-asked') === '1'; localStorage.setItem('tof-contacts-asked', '1'); } catch (e) {}
    native.lookupContacts(JSON.stringify(numbers), ask || !asked);
  }
  window.__tofContacts = (names, state) => {
    contactsState = state;
    Object.assign(phoneNames, names || {});
    if (state === 'denied') setStatus("Tof can't read your contacts. To show their names, allow Contacts for Tof in Settings > Apps > Tof > Permissions.", true);
    renderContacts(); renderReader();
  };

  // ---- Rendering ----
  function contactList() {
    const contacts = new Map();
    messages.forEach(m => {
      const c = contacts.get(m.contact) || { name: m.contact, total: 0, you: 0, them: 0, last: m.when };
      c.total++; m.you ? c.you++ : c.them++; if (m.when > c.last) c.last = m.when;
      contacts.set(m.contact, c);
    });
    return [...contacts.values()].sort((a, b) => b.last - a.last);
  }

  function render() {
    $('example').hidden = !isExample;
    renderContacts();
    renderStats();
    renderReader();
  }

  function renderStats() {
    const total = messages.length, sent = messages.filter(m => m.you).length;
    const list = contactList().sort((a, b) => b.total - a.total);
    const times = messages.map(m => m.when.getTime());
    const first = total ? new Date(Math.min(...times)) : null, last = total ? new Date(Math.max(...times)) : null;
    const spanDays = total ? Math.max(1, Math.round((last - first) / 864e5) + 1) : 0;
    $('stats').innerHTML = [
      ['Messages', fmt.format(total), total ? `over ${fmt.format(spanDays)} day${spanDays === 1 ? '' : 's'}` : 'none yet'],
      ['Sent by you', fmt.format(sent), total ? `${Math.round(sent / total * 100)}% of all` : '—'],
      ['Received', fmt.format(total - sent), total ? `${Math.round((total - sent) / total * 100)}% of all` : '—'],
      ['Contacts', fmt.format(list.length), list[0] ? `most: ${esc(displayName(list[0].name))}` : '—'],
      ['Per day', total ? (total / spanDays).toFixed(1) : '—', first ? `${dayFmt.format(first)} to ${dayFmt.format(last)}` : '—'],
    ].map(([k, v, n]) => `<div class="stat"><span class="k">${k}</span><span class="v">${v}</span><span class="n">${n}</span></div>`).join('');
    if (!$('view-stats').hidden) { drawDaily(); drawHours(); }
  }

  function matches(c) {
    if (!query) return true;
    const r = rec(c);
    const hay = [c, phoneNames[c] || '', ...Object.values(r.fields || {})].join(' ').toLowerCase();
    return query.toLowerCase().split(/\s+/).every(w => hay.includes(w));
  }

  function renderContacts() {
    const list = contactList();
    const shown = list.filter(c => matches(c.name));
    const max = Math.max(1, ...list.map(c => c.total));
    if (!selected && list[0]) selected = list[0].name;
    $('usecontacts').hidden = !native || isExample || contactsState === 'granted' || !list.some(c => looksLikeNumber(c.name));
    $('contacts').innerHTML = shown.length ? shown.map(c => {
      const name = displayName(c.name), tags = tagsOf(c.name);
      return `<tr tabindex="0" data-c="${esc(c.name)}" class="${c.name === selected ? 'sel' : ''}"><td><div class="who"><b>${esc(name)}</b>${name !== c.name ? `<small>${esc(c.name)}</small>` : ''}${tags.length ? `<span class="chips">${tags.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</span>` : ''}</div></td><td class="num">${fmt.format(c.total)}<span class="bar" style="width:${Math.max(2, c.total / max * 50)}px"></span></td><td class="num">${dayFmt.format(c.last)}</td></tr>`;
    }).join('') : `<tr><td colspan="3" class="empty">${list.length ? 'No conversations match.' : 'No messages yet.'}</td></tr>`;
  }

  function renderRecord(msgs) {
    const form = $('record');
    if (!selected) { form.hidden = true; return; }
    const r = rec(selected), f = r.fields || {};
    const urls = [...new Set(msgs.flatMap(urlsOf))];
    const saved = urls.filter(u => (mediaIdx.get(u) || {}).status === 'saved').length;
    const notMedia = urls.filter(u => (mediaIdx.get(u) || {}).status === 'notmedia').length;
    const gone = urls.filter(u => (mediaIdx.get(u) || {}).status === 'gone').length;
    const mediaLine = !urls.length ? 'No pictures or videos.'
      : native ? `Pictures and videos saved on this phone: ${saved} of ${urls.length - notMedia}${pendingMedia.size ? ' (saving…)' : ''}.${gone ? ` ${gone} had already expired at TextNow.` : ''}`
      : `${urls.length} picture or video link${urls.length === 1 ? '' : 's'}. Saving them needs the Android app.`;
    const dis = isExample ? ' disabled' : '';
    form.innerHTML = `
      <label for="f-name">Name<input id="f-name" data-f="name" value="${esc(f.name || '')}" placeholder="${esc(phoneNames[selected] || selected)}"${dis}></label>
      <label for="f-tags">Tags<input id="f-tags" data-f="tags" value="${esc(f.tags || '')}" placeholder="Comma separated, like work, family"${dis}></label>
      ${fieldDefs.map(d => `<div class="row"><label for="f-${esc(d.id)}">${esc(d.label)}<input id="f-${esc(d.id)}" data-f="${esc(d.id)}" value="${esc(f[d.id] || '')}"${dis}></label><button type="button" class="x" data-remove="${esc(d.id)}" aria-label="Remove field ${esc(d.label)}"${dis}>×</button></div>`).join('')}
      <label for="f-notes">Notes<textarea id="f-notes" data-f="notes"${dis}>${esc(f.notes || '')}</textarea></label>
      <div class="add"><input id="newfield" placeholder="New field, like Company or Case number" aria-label="New field name"${dis}><button type="button" class="btn" id="addfield"${dis}>Add field</button></div>
      <p class="meta">${isExample ? 'Add your own exports to start keeping records.' : (phoneNames[selected] ? `Saved in your contacts as ${esc(phoneNames[selected])}. ` : '') + esc(mediaLine) + (r.updated ? ` Record updated ${esc(fullFmt.format(new Date(r.updated)))}.` : '')}</p>`;
    form.hidden = false;
  }

  // Stats scoped to the open conversation.
  const dur = ms => ms < 36e5 ? `${Math.max(1, Math.round(ms / 6e4))} min` : ms < 864e5 ? `${(ms / 36e5).toFixed(1)} h` : `${(ms / 864e5).toFixed(1)} d`;
  const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
  function renderConvoStats(msgs) {
    const box = $('cstats');
    box.hidden = !msgs.length;
    if (!msgs.length || !box.open) return;
    const you = msgs.filter(m => m.you).length, them = msgs.length - you;
    const days = new Set(msgs.map(m => localDay(m.when))).size;
    const first = msgs[0].when, last = msgs[msgs.length - 1].when;
    const span = Math.max(1, Math.round((last - first) / 864e5) + 1);
    // Reply time: gap before the first message of each turn, ignoring gaps over 3 days.
    const yourReplies = [], theirReplies = [];
    for (let i = 1; i < msgs.length; i++) {
      if (msgs[i].you === msgs[i - 1].you) continue;
      const gap = msgs[i].when - msgs[i - 1].when;
      if (gap <= 3 * 864e5) (msgs[i].you ? yourReplies : theirReplies).push(gap);
    }
    const hours = new Array(24).fill(0); msgs.forEach(m => hours[m.when.getHours()]++);
    const peak = hours.indexOf(Math.max(...hours));
    const hl = h => h === 0 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : (h - 12) + 'p';
    const media = msgs.reduce((n, m) => n + urlsOf(m).length, 0);
    const words = msgs.reduce((n, m) => n + ((m.text || '').replace(URL_RE, '').match(/\S+/g) || []).length, 0);
    const yr = median(yourReplies), tr = median(theirReplies);
    $('cstats-tiles').innerHTML = [
      ['Messages', fmt.format(msgs.length), `You ${fmt.format(you)} · Them ${fmt.format(them)}`],
      ['Your share', `${Math.round(you / msgs.length * 100)}%`, `${fmt.format(words)} words in all`],
      ['Active days', fmt.format(days), `of ${fmt.format(span)} · ${(msgs.length / days).toFixed(1)} per active day`],
      ['First and last', dayFmt.format(first), `to ${dayFmt.format(last)}`],
      ['You reply in', yr == null ? '—' : dur(yr), 'median time to answer'],
      ['They reply in', tr == null ? '—' : dur(tr), 'median time to answer'],
      ['Busiest hour', hl(peak), `${fmt.format(hours[peak])} messages`],
      ['Pictures and videos', fmt.format(media), 'links found in messages'],
    ].map(([k, v, n]) => `<div class="stat"><span class="k">${k}</span><span class="v">${v}</span><span class="n">${n}</span></div>`).join('');
    drawDaily($('cdaily'), msgs, $('cdaysub'));
    drawHours($('chours'), msgs);
  }

  function renderReader() {
    const msgs = messages.filter(m => m.contact === selected).sort((a, b) => a.when - b.when);
    $('readertitle').textContent = selected ? displayName(selected) : 'Conversation';
    $('readersub').textContent = selected ? `${displayName(selected) !== selected ? selected + ' · ' : ''}${fmt.format(msgs.length)} message${msgs.length === 1 ? '' : 's'}, oldest first.` : 'Select a conversation.';
    const active = document.activeElement && $('record').contains(document.activeElement) ? document.activeElement.id : null;
    renderRecord(msgs);
    if (active && $(active)) $(active).focus();
    renderConvoStats(msgs);
    $('reader').innerHTML = msgs.map(m => `<div class="msg ${m.you ? 'you' : 'them'}">${bodyHtml(m)}<time>${fullFmt.format(m.when)}</time></div>`).join('');
    // A URL that isn't a loadable picture falls back to a plain link.
    $('reader').querySelectorAll('img.pic').forEach(img => img.addEventListener('error', () => {
      const a = img.parentElement; a.classList.add('link'); a.textContent = a.href;
    }, { once: true }));
    document.querySelectorAll('#contacts tr').forEach(tr => tr.classList.toggle('sel', tr.dataset.c === selected));
  }

  // ---- Record editing ----
  let saveTimer;
  function updateField(f, value) {
    if (isExample || !selected) return;
    const r = rec(selected);
    r.fields = { ...(r.fields || {}), [f]: value };
    r.updated = Date.now();
    records.set(selected, r);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { putAll('records', [records.get(selected)]); renderContacts(); $('readertitle').textContent = displayName(selected); }, 400);
  }
  $('record').addEventListener('input', e => { const f = e.target.dataset.f; if (f) updateField(f, e.target.value); });
  $('record').addEventListener('submit', e => e.preventDefault());
  $('record').addEventListener('click', e => {
    if (e.target.id === 'addfield') {
      const label = $('newfield').value.trim();
      if (!label) { $('newfield').focus(); return; }
      if (fieldDefs.some(d => d.label.toLowerCase() === label.toLowerCase())) { setStatus(`There's already a field called ${label}.`, true); return; }
      fieldDefs.push({ id: 'c' + Date.now().toString(36), label });
      putAll('meta', [{ id: 'fields', list: fieldDefs }]);
      renderReader();
      const last = fieldDefs[fieldDefs.length - 1]; if ($('f-' + last.id)) $('f-' + last.id).focus();
    }
    const rm = e.target.dataset && e.target.dataset.remove;
    if (rm) {
      if (e.target.dataset.armed !== '1') { e.target.dataset.armed = '1'; e.target.textContent = 'Remove?'; setTimeout(() => { if (e.target.isConnected) { e.target.dataset.armed = ''; e.target.textContent = '×'; } }, 3000); return; }
      fieldDefs = fieldDefs.filter(d => d.id !== rm);
      putAll('meta', [{ id: 'fields', list: fieldDefs }]);
      renderReader();
    }
  });
  $('record').addEventListener('keydown', e => { if (e.target.id === 'newfield' && e.key === 'Enter') { e.preventDefault(); $('addfield').click(); } });

  // ---- Charts ----
  function chart(el, bins, labelEvery, labelOf, tipOf) {
    const W = Math.max(280, el.clientWidth || 420), H = 200, L = 34, R = 6, T = 8, B = 22;
    const max = Math.max(1, ...bins.map(b => b.you + b.them));
    const step = Math.max(1, Math.ceil(max / 4)), top = step * 4;
    const bw = (W - L - R) / bins.length, y = v => H - B - v / top * (H - B - T);
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img">`;
    for (let v = 0; v <= top; v += step) s += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    bins.forEach((b, i) => {
      const w = Math.max(1, Math.min(bw * 0.7, 28)), x = L + i * bw + (bw - w) / 2;
      if (b.you) s += `<rect x="${x}" width="${w}" y="${y(b.you)}" height="${y(0) - y(b.you)}" fill="var(--you)" rx="1.5"/>`;
      if (b.them) s += `<rect x="${x}" width="${w}" y="${y(b.you + b.them)}" height="${y(b.you) - y(b.you + b.them)}" fill="var(--them)" rx="1.5"/>`;
      if (i % labelEvery === 0) s += `<text x="${L + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${labelOf(b, i)}</text>`;
      s += `<rect x="${L + i * bw}" width="${bw}" y="${T}" height="${H - B - T}" fill="transparent" data-i="${i}"/>`;
    });
    el.innerHTML = s + '</svg><div class="tip" hidden></div>';
    const tip = el.querySelector('.tip'), svg = el.querySelector('svg');
    svg.addEventListener('pointermove', e => {
      const i = e.target.dataset && e.target.dataset.i; if (i == null) { tip.hidden = true; return; }
      const b = bins[+i];
      tip.innerHTML = `<div class="d">${tipOf(b)}</div><div>You ${b.you} · Them ${b.them}</div>`;
      tip.hidden = false;
      const r = el.getBoundingClientRect(), px = e.clientX - r.left;
      tip.style.left = Math.min(Math.max(0, px - tip.offsetWidth / 2), r.width - tip.offsetWidth) + 'px';
      tip.style.top = '0px';
    });
    svg.addEventListener('pointerleave', () => tip.hidden = true);
  }

  function drawDaily(el = $('daily'), msgs = messages, sub = $('daysub')) {
    if (!msgs.length) { el.innerHTML = '<p class="empty">No messages yet.</p>'; return; }
    const byDay = new Map();
    msgs.forEach(m => { const k = localDay(m.when); const b = byDay.get(k) || { you: 0, them: 0 }; m.you ? b.you++ : b.them++; byDay.set(k, b); });
    const keys = [...byDay.keys()].sort();
    const bins = []; const d = new Date(keys[0] + 'T00:00'), endD = new Date(keys[keys.length - 1] + 'T00:00');
    // Long histories show the most recent 400 days.
    if ((endD - d) / 864e5 > 400) d.setTime(endD.getTime() - 399 * 864e5);
    for (; d <= endD; d.setDate(d.getDate() + 1)) { const k = localDay(d); bins.push({ date: new Date(d), ...(byDay.get(k) || { you: 0, them: 0 }) }); }
    sub.textContent = bins.length > 1 ? `Sent and received, ${dayFmt.format(bins[0].date)} to ${dayFmt.format(bins[bins.length - 1].date)}.` : `Sent and received on ${dayFmt.format(bins[0].date)}.`;
    const every = Math.max(1, Math.ceil(bins.length / Math.max(2, Math.floor((el.clientWidth || 420) / 70))));
    chart(el, bins, every, b => dayFmt.format(b.date), b => dayFmt.format(b.date));
  }

  function drawHours(el = $('hours'), msgs = messages) {
    if (!msgs.length) { el.innerHTML = '<p class="empty">No messages yet.</p>'; return; }
    const bins = Array.from({ length: 24 }, (_, h) => ({ h, you: 0, them: 0 }));
    msgs.forEach(m => { const b = bins[m.when.getHours()]; m.you ? b.you++ : b.them++; });
    const hl = h => h === 0 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : (h - 12) + 'p';
    chart(el, bins, (el.clientWidth || 420) < 420 ? 6 : 3, b => hl(b.h), b => `${hl(b.h)} to ${hl((b.h + 1) % 24)}`);
  }

  // ---- Tabs ----
  function showTab(name) {
    ['convos', 'stats'].forEach(t => {
      const on = t === name;
      $('tab-' + t).setAttribute('aria-selected', on);
      $('view-' + t).hidden = !on;
    });
    if (name === 'stats') { drawDaily(); drawHours(); }
    try { localStorage.setItem('tof-tab', name); } catch (e) {}
  }
  $('tab-convos').addEventListener('click', () => { showTab('convos'); renderReader(); });
  $('cstats').addEventListener('toggle', () => { if ($('cstats').open) renderReader(); try { localStorage.setItem('tof-cstats', $('cstats').open ? '1' : '0'); } catch (e) {} });
  try { if (localStorage.getItem('tof-cstats') === '0') $('cstats').open = false; } catch (e) {}
  $('tab-stats').addEventListener('click', () => showTab('stats'));

  // ---- Wiring ----
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => { if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); });
  $('file').addEventListener('change', e => { if (e.target.files.length) addFiles([...e.target.files]); e.target.value = ''; });
  $('usecontacts').addEventListener('click', () => lookupContacts(true));
  $('search').addEventListener('input', e => { query = e.target.value.trim(); renderContacts(); });

  // Clearing deletes saved records and media, so it takes a second tap.
  let clearArmed = 0;
  $('clear').addEventListener('click', async () => {
    const btn = $('clear');
    if (Date.now() - clearArmed > 4000) {
      clearArmed = Date.now(); btn.textContent = 'Tap again to delete everything';
      setTimeout(() => { if (Date.now() - clearArmed >= 4000) btn.textContent = 'Clear all'; }, 4100);
      return;
    }
    clearArmed = 0; btn.textContent = 'Clear all';
    await clearAll();
    if (native) { try { native.clearMedia(); } catch (e) {} }
    messages = []; records.clear(); fieldDefs = []; mediaIdx.clear(); isExample = false; selected = null;
    setStatus('Deleted all conversations, records and saved media.');
    render();
  });

  const pick = tr => { if (tr && tr.dataset.c != null) { selected = tr.dataset.c; renderReader(); } };
  $('contacts').addEventListener('click', e => pick(e.target.closest('tr')));
  $('contacts').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(e.target.closest('tr')); } });
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (!$('view-stats').hidden) { drawDaily(); drawHours(); } else renderConvoStats(messages.filter(m => m.contact === selected).sort((a, b) => a.when - b.when)); }, 120); });

  // Shares that arrive before storage has loaded wait for it.
  let ready;
  const loaded = new Promise(r => ready = r);
  window.__tofAdd = async files => { await loaded; return addFiles(files); };

  (async function init() {
    db = await openDb();
    if (db && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    const [stored, recs, media, meta] = await Promise.all([getAll('messages'), getAll('records'), getAll('media'), getAll('meta')]);
    messages = stored.map(fromStored);
    recs.forEach(r => records.set(r.contact, r));
    media.forEach(m => mediaIdx.set(m.url, m));
    const f = meta.find(m => m.id === 'fields'); if (f) fieldDefs = f.list || [];
    if (!messages.length) { messages = exampleData(); isExample = true; }
    if (!db) setStatus('This browser is not keeping data, so conversations last until you close Tof.', true);
    try { if (localStorage.getItem('tof-tab') === 'stats') showTab('stats'); } catch (e) {}
    render();
    ready();
    saveMediaFor(messages);
    lookupContacts(false);
  })();
})();
