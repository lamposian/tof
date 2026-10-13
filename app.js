(function () {
  // Format seen in TextNow Android exports:
  // <html>2026-10-13 07:51 UTC - You: <br/> text<br/><br/>2026-10-13 07:51 UTC - +14752015569: <br/> text</html>
  // Despite the "UTC" label, the times are the phone's local time, so they're read as local.
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
      const [y, mo, d] = m[1].split('-').map(Number);
      const when = new Date(y, mo - 1, d, +m[2], +m[3], +(m[4] || 0));
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
  // people: contact records. records: one entry per phone number, pointing at its contact.
  // log is kept apart: Clear all leaves the activity log in place.
  const STORES = ['messages', 'records', 'media', 'meta', 'people'];
  let db = null;
  function openDb() {
    return new Promise(res => {
      try {
        const r = indexedDB.open('tof', 3);
        r.onupgradeneeded = () => {
          const d = r.result, make = (n, k) => { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: k }); };
          make('messages', 'k'); make('records', 'contact'); make('media', 'url'); make('meta', 'id'); make('people', 'id'); make('log', 'id');
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
    if (!db || isExample || !items.length) return res();
    const t = db.transaction(store, 'readwrite'); const s = t.objectStore(store);
    items.forEach(i => s.put(i));
    t.oncomplete = () => res(); t.onerror = () => { console.error(t.error); res(); };
  });
  const delOne = (store, k) => new Promise(res => {
    if (!db || isExample) return res();
    const t = db.transaction(store, 'readwrite'); t.objectStore(store).delete(k);
    t.oncomplete = () => res(); t.onerror = () => res();
  });
  const clearAll = () => new Promise(res => {
    if (!db) return res();
    const t = db.transaction(STORES, 'readwrite');
    STORES.forEach(n => t.objectStore(n).clear());
    t.oncomplete = () => res(); t.onerror = () => res();
  });
  const toStored = m => ({ k: m.k, contact: m.contact, when: m.when.getTime(), you: m.you, sender: m.sender, text: m.text, media: m.media || [] });
  const fromStored = m => ({ ...m, when: new Date(m.when) });

  // ---- State ----
  let messages = [], isExample = false, query = '';
  let sel = null;              // 'p:<contact id>' for a contact, 'n:<number>' for a number not yet given a contact
  let only = '';               // number the open contact's messages are narrowed to, '' for all
  const people = new Map();    // id -> {id, fields: {name, links, tags, notes, ...custom}, created, updated}
  const numbers = new Map();   // number -> {contact: number, person: id or null, label, updated}
  let fieldDefs = [];          // custom fields shared by all contacts: [{id, label}]
  const mediaIdx = new Map();  // url -> {url, status: saved|notmedia|failed|gone, local, mime, size, tries}
  const pendingMedia = new Set();

  const $ = id => document.getElementById(id);
  const fmt = new Intl.NumberFormat('en');
  const dayFmt = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
  const fullFmt = new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const localDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const phoneNames = {};       // number -> name saved in the phone's contacts (only ever a suggestion)
  let contactsState = '';      // granted | denied | not-asked
  const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const num = n => numbers.get(n) || { contact: n, person: null, label: '' };
  const personOf = n => { const id = num(n).person; return id && people.has(id) ? id : null; };
  const numbersOf = id => [...numbers.values()].filter(r => r.person === id).map(r => r.contact);
  const fieldsOf = id => (people.get(id) || {}).fields || {};
  const nameOf = id => (fieldsOf(id).name || '').trim() || numbersOf(id)[0] || 'Unnamed contact';
  const tagsOf = id => (fieldsOf(id).tags || '').split(',').map(t => t.trim()).filter(Boolean);
  const linksOf = id => fieldsOf(id).links || [];
  const openId = () => sel && sel.startsWith('p:') ? sel.slice(2) : null;
  const numLabel = n => num(n).label ? `${n} (${num(n).label})` : n;
  // Numbers typed by hand are matched to TextNow's +1XXXXXXXXXX form.
  function normNumber(s) {
    const t = (s || '').trim(), d = t.replace(/\D/g, '');
    if (!d) return '';
    if (t.startsWith('+')) return '+' + d;
    if (d.length === 10) return '+1' + d;
    if (d.length === 11 && d[0] === '1') return '+' + d;
    return d;
  }

  // ---- Activity log: every action in Tof, kept in IndexedDB and, when a folder is chosen, in tof-log.txt there ----
  let logs = [];               // newest first: {id, at, kind, text}
  let logFolderName = '';
  const LOG_KINDS = { app: 'App', import: 'Import', contact: 'Contact', number: 'Number', link: 'Link', field: 'Field', phone: 'Phone', media: 'Media', timer: 'Timer', data: 'Data' };
  const putLog = items => new Promise(res => {
    if (!db || !items.length) return res();
    const t = db.transaction('log', 'readwrite'); const st = t.objectStore('log');
    items.forEach(i => st.put(i));
    t.oncomplete = () => res(); t.onerror = () => res();
  });
  function logEvent(kind, text) {
    const e = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), at: Date.now(), kind, text };
    logs.unshift(e);
    putLog([e]);
    if (native && native.appendLog && logFolderName) { try { native.appendLog(JSON.stringify(e) + '\n'); } catch (err) {} }
    clearTimeout(logRender); logRender = setTimeout(renderLog, 200);
  }
  let logRender;
  // Entries from tof-log.txt (for example after a reinstall) are merged in; the file is then rewritten with everything.
  window.__tofLogFile = (text, folder) => {
    logFolderName = folder || '';
    const have = new Set(logs.map(e => e.id)), fresh = [];
    let fileIds = 0;
    (text || '').split('\n').forEach(line => {
      try { const e = JSON.parse(line); if (e && e.id && e.at) { fileIds++; if (!have.has(e.id)) { have.add(e.id); fresh.push(e); } } } catch (err) {}
    });
    if (fresh.length) { logs = [...logs, ...fresh].sort((a, b) => b.at - a.at); putLog(fresh); }
    if (logFolderName && native && native.rewriteLog && fileIds !== logs.length) native.rewriteLog([...logs].reverse().map(e => JSON.stringify(e)).join('\n') + '\n');
    if (fresh.length) setStatus(`Brought back ${fmt.format(fresh.length)} log entr${fresh.length === 1 ? 'y' : 'ies'} from ${logFolderName}.`);
    renderLog(); renderSettings();
  };

  function setStatus(text, warn) { const s = $('status'); s.textContent = text; s.classList.toggle('warn', !!warn); }

  async function addFiles(files) {
    const added = [], failed = [], shared = [];
    for (const f of files) {
      try {
        const text = await f.text(), msgs = parseExport(text, f.name);
        if (msgs.length) added.push(...msgs);
        else if (text.length < 4000 && linksIn(text).length) shared.push(text);
        else failed.push(f.name);
      } catch (e) { failed.push(f.name); }
    }
    // A shared link, not a conversation export: ask which contact it belongs to.
    if (shared.length && !added.length && !failed.length) return window.__tofLink(shared.join('\n'), '');
    const fresh = [];
    if (added.length) {
      if (isExample) { messages = []; people.clear(); numbers.clear(); isExample = false; sel = null; }
      const seen = new Set(messages.map(m => m.k));
      added.forEach(m => { if (!seen.has(m.k)) { seen.add(m.k); messages.push(m); fresh.push(m); } });
      await putAll('messages', fresh.map(toStored));
      flushSave();
    }
    // One summary per number in the import, shown in the import dialog.
    const byNum = new Map(), isFresh = new Set(fresh);
    added.forEach(m => {
      const e = byNum.get(m.contact) || { n: m.contact, read: 0, fresh: 0, first: m.when, last: m.when, media: 0 };
      e.read++; if (isFresh.has(m)) e.fresh++; e.media += urlsOf(m).length;
      if (m.when < e.first) e.first = m.when; if (m.when > e.last) e.last = m.when;
      byNum.set(m.contact, e);
    });
    // A second import while the dialog is still open adds to it instead of replacing it.
    if (imported && $('importdlg').open) {
      byNum.forEach((e, n) => { const i = imported.items.findIndex(x => x.n === n); if (i >= 0) imported.items.splice(i, 1); });
      imported = { items: [...imported.items, ...byNum.values()], failed: [...imported.failed, ...failed] };
    } else imported = { items: [...byNum.values()], failed };
    byNum.forEach(e => { const id = personOf(e.n); logEvent('import', `Imported ${e.n}${id ? ` (${nameOf(id)})` : ' (new number)'}: ${fmt.format(e.fresh)} new of ${fmt.format(e.read)} messages`); });
    failed.forEach(f => logEvent('import', `Could not read ${f}: no TextNow messages found`));
    const lastN = added.length ? added[added.length - 1].contact : null;
    if (lastN) { const id = personOf(lastN); sel = id ? 'p:' + id : 'n:' + lastN; only = ''; }
    setStatus(added.length ? `Imported ${fmt.format(fresh.length)} new message${fresh.length === 1 ? '' : 's'}.` : 'Nothing imported.', failed.length > 0);
    showTab('contact');
    render();
    showImport();
    saveMediaFor(fresh);
    if (fresh.length) lookupContacts(false);
  }

  // ---- Import dialog: says what just came in and, for a number Tof hasn't seen, asks for its contact ----
  let imported = null;
  function showImport() {
    const dlg = $('importdlg');
    if (!imported || !dlg) return;
    const { items, failed } = imported;
    const range = e => +e.first === +e.last || localDay(e.first) === localDay(e.last) ? dayFmt.format(e.first) : `${dayFmt.format(e.first)} to ${dayFmt.format(e.last)}`;
    $('importbody').innerHTML = items.map(e => {
      const id = personOf(e.n), hint = phoneNames[e.n] || '';
      const match = hint && byName().find(p => nameOf(p).toLowerCase() === hint.toLowerCase());
      const counts = e.fresh ? `${fmt.format(e.fresh)} new message${e.fresh === 1 ? '' : 's'}${e.fresh < e.read ? ` (${fmt.format(e.read - e.fresh)} already in Tof)` : ''}` : `Nothing new: all ${fmt.format(e.read)} messages were already in Tof`;
      return `<section class="imp" data-n="${esc(e.n)}">
        <div class="imphead"><b>${esc(e.n)}</b><span class="badge ${id ? '' : 'new'}">${id ? esc(nameOf(id)) : 'New number'}</span></div>
        <p class="impline">${counts}. ${range(e)}${e.media ? ` · ${fmt.format(e.media)} picture${e.media === 1 ? '' : 's'} or video${e.media === 1 ? '' : 's'}` : ''}.</p>
        ${id ? `<button type="button" class="btn" data-goto="p:${esc(id)}">Open ${esc(nameOf(id))}</button>` : `
        <p class="impline">${hint ? `Your phone contacts have this number as <b>${esc(hint)}</b>. ` : ''}Which contact does it belong to?</p>
        ${people.size ? `<div class="add"><select data-pick aria-label="Contact for ${esc(e.n)}"><option value="">Choose a contact…</option>${byName().map(p => `<option value="${esc(p)}"${p === match ? ' selected' : ''}>${esc(nameOf(p))}</option>`).join('')}</select><button type="button" class="btn solid" data-assign="pick">Add</button></div>` : ''}
        <div class="add"><input data-newname placeholder="New contact name" aria-label="New contact name for ${esc(e.n)}" value="${esc(match ? '' : hint)}"><button type="button" class="btn${people.size ? '' : ' solid'}" data-assign="new">Create contact</button></div>`}
      </section>`;
    }).join('') + (failed.length ? `<p class="impline warn">No TextNow messages found in ${esc(failed.join(', '))}. Check it's an exported conversation file.</p>` : '');
    const waiting = items.filter(e => !personOf(e.n)).length;
    $('importdone').textContent = waiting ? 'Decide later' : 'Done';
    $('importtitle').textContent = items.length ? `Imported from TextNow` : 'Nothing imported';
    if (!dlg.open) { if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', ''); }
  }
  function closeImport() { const dlg = $('importdlg'); imported = null; if (dlg.open) { if (dlg.close) dlg.close(); else dlg.removeAttribute('open'); } }
  function assignNumber(n, to) {
    setNumber(n, { person: to }); touch(to); flushSave();
    setStatus(`Added ${n} to ${nameOf(to)}.`);
    logEvent('number', `Added ${n} to ${nameOf(to)}`);
    lookupContacts(false);
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
  let rr, mediaLogT;
  const mediaTally = { saved: 0, gone: 0 };
  // Freshness: saved files are compared with TextNow's copy, without downloading, at most once a week each.
  const WEEK = 7 * 864e5;
  const checking = new Set();
  function checkFresh(urls) {
    if (!native || !native.checkMedia || isExample) return;
    urls.forEach(u => {
      const e = mediaIdx.get(u);
      if (!e || e.status !== 'saved' || e.online === false || e.turns || e.dupOf || checking.has(u) || Date.now() - (e.checkedAt || 0) < WEEK) return;
      checking.add(u);
      try { native.checkMedia(u, e.etag || '', e.lastMod || ''); } catch (err) { checking.delete(u); }
    });
  }
  window.__tofMediaCheck = (url, result, etag, lastMod, oldLocal) => {
    checking.delete(url);
    const e = mediaIdx.get(url); if (!e) return;
    if (result === 'error') return;
    e.checkedAt = Date.now();
    if (result === 'offline') e.online = false;
    else { e.online = true; if (etag) e.etag = etag; if (lastMod) e.lastMod = lastMod; }
    if (result === 'changed') {
      e.versions = [...(e.versions || []), { local: oldLocal, mime: e.mime, at: Date.now() }];
      pendingMedia.add(url);
      const m = messages.find(x => urlsOf(x).includes(url)), who = m ? (personOf(m.contact) ? nameOf(personOf(m.contact)) : m.contact) : 'a conversation';
      logEvent('media', `TextNow had a newer version of a picture or video from ${who}. Downloaded it and kept the old one`);
    }
    putAll('media', [e]);
    clearTimeout(rr); rr = setTimeout(refreshMedia, 300);
  };
  // ---- Duplicates: identical files (same content hash) are kept once ----
  const shown = e => e && e.dupOf ? mediaIdx.get(e.dupOf) || e : e;
  let dupTally = 0, dupLogT;
  // Same picture = same bytes, or the same look and shape at another size (a thumbnail and the full one).
  // The biggest copy is kept; the others point at it and their files are deleted.
  const ham = (a, b) => { let n = 0; for (let i = 0; i < 16; i++) { let x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { n += x & 1; x >>= 1; } } return n; };
  const ratio = x => x.w && x.h ? x.w / x.h : 0;
  const looksSame = (a, b) => !!(a.dhash && b.dhash && ratio(a) && ratio(b) && ham(a.dhash, b.dhash) <= 6 && Math.abs(ratio(a) - ratio(b)) / Math.max(ratio(a), ratio(b)) < 0.08);
  const area = x => (x.w || 0) * (x.h || 0);
  function dedupe(e) {
    if (!e || e.dupOf || e.status !== 'saved' || (!e.hash && !e.dhash)) return;
    const o = [...mediaIdx.values()].find(x => x !== e && x.url !== e.url && x.status === 'saved' && !x.dupOf && ((e.hash && x.hash === e.hash) || looksSame(e, x)));
    if (!o) return;
    if (area(e) > area(o)) mergeInto(o, e); else mergeInto(e, o);
  }
  function mergeInto(drop, keep) {
    if (native && native.deleteMedia && fileOf(drop) && fileOf(drop) !== fileOf(keep)) native.deleteMedia(fileOf(drop));
    const moved = [...mediaIdx.values()].filter(x => x.dupOf === drop.url);
    moved.forEach(x => { x.dupOf = keep.url; x.local = keep.local; });
    const turns = (drop.turns || 0) % 4;
    drop.dupOf = keep.url; drop.local = keep.local;
    putAll('media', [drop, ...moved]);
    // A thumbnail Bob already turned passes its turn on to the full-size copy.
    if (turns && !keep.turns) setTimeout(() => rotateSaved(keep.url, turns * 90), 0);
    dupTally++; clearTimeout(dupLogT);
    dupLogT = setTimeout(() => { logEvent('media', `Kept one copy of ${fmt.format(dupTally)} duplicate picture${dupTally === 1 ? '' : 's'} or video${dupTally === 1 ? '' : 's'}, the largest`); dupTally = 0; }, 3000);
  }
  const takeInfo = (e, info) => { e.hash = info.hash || e.hash || ''; if (info.dhash) { e.dhash = info.dhash; e.w = info.w; e.h = info.h; } if (info.hash) e.infoAt = Date.now(); };
  // Files saved before this check existed are measured once.
  function hashOld() {
    if (!native || !native.hashMedia || isExample) return;
    const files = [...new Set([...mediaIdx.values()].filter(e => isSavedE(e) && !e.infoAt && !e.dupOf).map(fileOf))];
    for (let k = 0; k < files.length; k += 100) native.hashMedia(JSON.stringify(files.slice(k, k + 100)));
  }
  window.__tofMediaHash = (file, info) => {
    if (!info || !info.hash) return;
    const list = [...mediaIdx.values()].filter(e => !e.dupOf && fileOf(e) === file && !e.infoAt);
    list.forEach(e => { takeInfo(e, info); dedupe(e); });
    if (list.length) { putAll('media', list); clearTimeout(rr); rr = setTimeout(refreshMedia, 300); }
  };
  function logMedia() {
    if (mediaTally.saved) logEvent('media', `Saved ${fmt.format(mediaTally.saved)} picture${mediaTally.saved === 1 ? '' : 's'} or video${mediaTally.saved === 1 ? '' : 's'} on the phone`);
    if (mediaTally.gone) logEvent('media', `${fmt.format(mediaTally.gone)} picture${mediaTally.gone === 1 ? '' : 's'} or video${mediaTally.gone === 1 ? '' : 's'} had already expired at TextNow`);
    mediaTally.saved = mediaTally.gone = 0;
  }
  window.__tofMediaDone = (url, status, local, mime, size, etag, lastMod, info) => {
    pendingMedia.delete(url);
    const prev = mediaIdx.get(url) || {};
    // A copy already on the phone always wins over a later failed or expired check.
    if (prev.status === 'saved' && status !== 'saved') { if (status === 'gone') { prev.online = false; putAll('media', [prev]); } clearTimeout(rr); rr = setTimeout(refreshMedia, 300); return; }
    const fresh = status === 'saved' && !!etag;
    const e = { ...prev, url, status, local: local || '', mime: mime || '', size: size || 0, tries: (prev.tries || 0) + (status === 'failed' ? 1 : 0),
      savedAt: prev.status === 'saved' && prev.local === local ? prev.savedAt : Date.now(),
      etag: etag || prev.etag || '', lastMod: lastMod || prev.lastMod || '', checkedAt: fresh ? Date.now() : prev.checkedAt || 0, online: status === 'gone' ? false : fresh ? true : prev.online,
      dupOf: prev.local === local ? prev.dupOf : undefined };
    if (prev.local !== local) { delete e.hash; delete e.dhash; delete e.infoAt; }
    if (info && typeof info === 'object') takeInfo(e, info);
    mediaIdx.set(url, e);
    if (status === 'saved') dedupe(e);
    putAll('media', [e]);
    if (status === 'saved') { copySoon(); const r = pendingRotation(url); if (r && !r.x.rotDone) { r.x.rotDone = true; touch(r.p.id); setTimeout(() => rotateSaved(url, r.x.rot), 0); } }
    if (status === 'saved' || status === 'gone') { mediaTally[status]++; clearTimeout(mediaLogT); mediaLogT = setTimeout(logMedia, 3000); }
    clearTimeout(rr); rr = setTimeout(refreshMedia, 300);
  };

  function mediaHtml(u) {
    const e = shown(mediaIdx.get(u));
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
  // ---- Names from the phone's contacts (Android app only). They are offered as suggestions, never applied. ----
  const looksLikeNumber = c => /^\+?[\d\s().-]{6,}$/.test(c);
  function lookupContacts(ask) {
    if (!native || !native.lookupContacts || isExample) return;
    const all = [...new Set([...messages.map(m => m.contact), ...numbers.keys()])].filter(looksLikeNumber);
    if (!all.length) return;
    let asked = false;
    try { asked = localStorage.getItem('tof-contacts-asked') === '1'; localStorage.setItem('tof-contacts-asked', '1'); } catch (e) {}
    native.lookupContacts(JSON.stringify(all), ask || !asked);
  }
  window.__tofContacts = (names, state, details) => {
    let last = ''; try { last = localStorage.getItem('tof-phone-state') || ''; localStorage.setItem('tof-phone-state', state); } catch (e) {}
    if (state !== last && state !== 'not-asked') logEvent('phone', `Phone contacts access: ${state === 'granted' ? 'allowed' : 'not allowed'}`);
    contactsState = state;
    Object.assign(phoneNames, names || {});
    copyFromPhone(details || {});
    if (state === 'denied') setStatus("Tof can't read your contacts. To see suggestions from them, allow Contacts for Tof in Settings > Apps > Tof > Permissions.", true);
    renderContacts(); renderReader(); renderSettings();
    if (imported) showImport();
  };

  // A Tof contact whose number is saved on the phone keeps a copy of that phone entry.
  // The copy is refreshed whenever Tof reads the phone's contacts; Tof never writes to them.
  function copyFromPhone(details) {
    if (isExample) return;
    const changed = new Set();
    people.forEach(p => {
      const d = numbersOf(p.id).map(n => details[n]).find(Boolean);
      if (!d) return;
      const copy = { name: d.name || '', nickname: d.nickname || '', phones: d.phones || [], emails: d.emails || [], addresses: d.addresses || [], company: d.company || '', title: d.title || '', websites: d.websites || [], birthday: d.birthday || '', note: d.note || '' };
      const prev = p.phone ? JSON.stringify({ ...p.phone, copied: 0 }) : '';
      if (prev !== JSON.stringify({ ...copy, copied: 0 })) { p.phone = { ...copy, copied: Date.now() }; changed.add(p.id); logEvent('phone', `${prev ? 'Updated' : 'Copied'} ${nameOf(p.id)}'s details from phone contacts`); }
      if (!(p.fields.name || '').trim() && copy.name) { p.fields = { ...p.fields, name: copy.name }; changed.add(p.id); }
      // The phone entry's other numbers join this contact, unless they already belong to another one.
      copy.phones.forEach(ph => {
        const n = normNumber(ph.value);
        if (!n) return;
        const owner = personOf(n), label = (ph.label || '').toLowerCase();
        if (!owner) { setNumber(n, { person: p.id, label: num(n).label || label }); changed.add(p.id); logEvent('number', `Added ${n} to ${nameOf(p.id)} from phone contacts`); }
        else if (owner === p.id && !num(n).label && label) { setNumber(n, { label }); changed.add(p.id); }
      });
    });
    changed.forEach(touch);
    if (changed.size) flushSave();
  }

  // ---- Rendering ----
  function numStats() {
    const out = new Map();
    messages.forEach(m => {
      const c = out.get(m.contact) || { n: m.contact, total: 0, last: m.when };
      c.total++; if (m.when > c.last) c.last = m.when;
      out.set(m.contact, c);
    });
    return out;
  }
  // The list: contacts (with all their numbers' messages) plus numbers that don't have a contact yet.
  function entries() {
    const stats = numStats();
    const ppl = [...people.values()].map(p => {
      const ns = numbersOf(p.id), e = { key: 'p:' + p.id, id: p.id, numbers: ns, total: 0, last: null };
      ns.forEach(n => { const s = stats.get(n); if (s) { e.total += s.total; if (!e.last || s.last > e.last) e.last = s.last; } });
      return e;
    }).sort((a, b) => (b.last || 0) - (a.last || 0) || nameOf(a.id).localeCompare(nameOf(b.id)));
    const loose = [...stats.values()].filter(s => !personOf(s.n)).sort((a, b) => b.last - a.last)
      .map(s => ({ key: 'n:' + s.n, n: s.n, numbers: [s.n], total: s.total, last: s.last }));
    return { ppl, loose };
  }

  function render() {
    $('example').hidden = !isExample;
    $('newperson').disabled = isExample;
    renderContacts();
    renderStats();
    renderReader();
    renderAllMedia();
  }

  function renderStats() {
    const total = messages.length, sent = messages.filter(m => m.you).length;
    const { ppl, loose } = entries();
    const all = [...ppl.filter(e => e.total), ...loose].sort((a, b) => b.total - a.total);
    const times = messages.map(m => m.when.getTime());
    const first = total ? new Date(Math.min(...times)) : null, last = total ? new Date(Math.max(...times)) : null;
    const spanDays = total ? Math.max(1, Math.round((last - first) / 864e5) + 1) : 0;
    $('stats').innerHTML = [
      ['Messages', fmt.format(total), total ? `over ${fmt.format(spanDays)} day${spanDays === 1 ? '' : 's'}` : 'none yet'],
      ['Sent by you', fmt.format(sent), total ? `${Math.round(sent / total * 100)}% of all` : '—'],
      ['Received', fmt.format(total - sent), total ? `${Math.round((total - sent) / total * 100)}% of all` : '—'],
      ['Contacts', fmt.format(all.length), all[0] ? `most: ${esc(all[0].id ? nameOf(all[0].id) : all[0].n)}` : '—'],
      ['Per day', total ? (total / spanDays).toFixed(1) : '—', first ? `${dayFmt.format(first)} to ${dayFmt.format(last)}` : '—'],
    ].map(([k, v, n]) => `<div class="stat"><span class="k">${k}</span><span class="v">${v}</span><span class="n">${n}</span></div>`).join('');
    $('statssub').textContent = first ? `All contacts and new numbers, ${dayFmt.format(first)} to ${dayFmt.format(last)}.` : 'No messages yet.';
    const most = all.slice(0, 8), top = Math.max(1, ...most.map(e => e.total));
    $('top').innerHTML = most.length ? most.map(e => `<button type="button" data-k="${esc(e.key)}"><span class="nm">${esc(e.id ? nameOf(e.id) : e.n)}</span><span class="track"><span class="fill" style="width:${Math.max(2, Math.round(e.total / top * 100))}%"></span></span><span class="ct">${fmt.format(e.total)}</span></button>`).join('') : '<p class="empty">No messages yet.</p>';
    if (!$('view-stats').hidden) { drawDaily(); drawHours(); }
    renderSettings();
  }

  let logQuery = '', logShown = 300;
  function renderLog() {
    if ($('view-log').hidden) return;
    const words = logQuery.toLowerCase().split(/\s+/).filter(Boolean);
    const list = logs.filter(e => words.every(w => (e.text + ' ' + (LOG_KINDS[e.kind] || '')).toLowerCase().includes(w)));
    $('logsub').textContent = `${fmt.format(logs.length)} entr${logs.length === 1 ? 'y' : 'ies'}${logs.length ? ` since ${dayFmt.format(new Date(logs[logs.length - 1].at))}` : ''}, newest first.`;
    let day = '', html = '';
    list.slice(0, logShown).forEach(e => {
      const d = new Date(e.at), k = localDay(d);
      if (k !== day) { day = k; html += `<h3 class="logday">${esc(new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(d))}</h3>`; }
      html += `<div class="logrow"><time>${esc(new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(d))}</time><span class="chip kind-${esc(e.kind)}">${esc(LOG_KINDS[e.kind] || e.kind)}</span><span class="lt">${esc(e.text)}</span></div>`;
    });
    $('loglist').innerHTML = html || `<p class="empty">${logs.length ? 'Nothing matches.' : 'Nothing logged yet.'}</p>`;
    $('logmore').hidden = list.length <= logShown;
  }

  function renderSettings() {
    $('logcard').hidden = !native || !native.pickLogFolder;
    $('logfolder').innerHTML = logFolderName ? `Kept in <b>${esc(logFolderName)}</b> as tof-log.txt.` : 'Only inside Tof right now, so uninstalling would delete it.';
    $('pickfolder').textContent = logFolderName ? 'Change folder' : 'Choose folder';
    $('mediacard').hidden = !native || !native.pickMediaFolder;
    const savedN = [...mediaIdx.values()].filter(e => isSavedE(e) && !e.dupOf).length;
    $('mediafolder').innerHTML = mediaFolderName ? `Copies go to <b>${esc(mediaFolderName)}</b>. ${fmt.format(Math.min(copiedTokens.size, savedN))} of ${fmt.format(savedN)} copied.` : 'Not copied anywhere yet. Saved pictures and videos are only inside Tof.';
    $('pickmedia').textContent = mediaFolderName ? 'Change folder' : 'Choose folder';
    const urls = [...mediaIdx.values()].filter(m => m.status === 'saved');
    const mb = urls.reduce((n, m) => n + (m.size || 0), 0) / 1048576;
    const nums = new Set([...messages.map(m => m.contact), ...numbers.keys()]).size;
    $('datasummary').textContent = isExample ? 'Only example data so far. Nothing is uploaded.'
      : `${fmt.format(people.size)} contact${people.size === 1 ? '' : 's'}, ${fmt.format(nums)} number${nums === 1 ? '' : 's'}, ${fmt.format(messages.length)} message${messages.length === 1 ? '' : 's'}${native ? `, ${fmt.format(urls.length)} saved picture${urls.length === 1 ? '' : 's'} or video${urls.length === 1 ? '' : 's'} (${mb < 1 ? mb.toFixed(1) : Math.round(mb)} MB)` : ''}. Nothing is uploaded.`;
    $('phonecard').hidden = !native || !native.lookupContacts;
    $('phonestate').innerHTML = `Access: <b>${contactsState === 'granted' ? 'Allowed' : contactsState === 'denied' ? 'Not allowed' : 'Not asked yet'}</b>`;
    $('phonecheck').textContent = contactsState === 'granted' ? 'Check again' : 'Allow access';
    let v = ''; try { v = native && native.version ? native.version() : ''; } catch (e) {}
    $('version').textContent = v ? `Tof ${v}` : 'Tof';
  }

  function matches(e) {
    if (!query) return true;
    const hay = [...e.numbers.flatMap(n => [n, num(n).label || '', phoneNames[n] || '']), ...(e.id ? Object.values(fieldsOf(e.id)).flat() : [])].join(' ').toLowerCase();
    return query.toLowerCase().split(/\s+/).every(w => hay.includes(w));
  }

  const normLink = u => { u = (u || '').trim(); return !u ? '' : /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : 'https://' + u; };

  function renderContacts() {
    const { ppl, loose } = entries();
    const all = [...loose, ...ppl];
    if ((!sel || !all.some(e => e.key === sel)) && all[0]) { sel = (ppl[0] || all[0]).key; only = ''; }
    const max = Math.max(1, ...all.map(e => e.total));
    $('usecontacts').hidden = !native || isExample || contactsState === 'granted' || !all.length;
    const cells = e => `<td class="num">${e.total ? fmt.format(e.total) : '—'}</td><td class="num">${e.last ? dayFmt.format(e.last) : '—'}</td>`;
    const looseRows = loose.filter(matches).map(e => `<tr tabindex="0" data-k="${esc(e.key)}" class="sub${e.key === sel ? ' sel' : ''}"><td><div class="who"><b>${esc(e.n)}</b>${phoneNames[e.n] ? `<small>Phone contacts: ${esc(phoneNames[e.n])}</small>` : '<small>No contact yet</small>'}</div></td>${cells(e)}</tr>`).join('');
    const pplRows = ppl.filter(matches).map(e => {
      const tags = tagsOf(e.id);
      return `<tr tabindex="0" data-k="${esc(e.key)}" class="${e.key === sel ? 'sel' : ''}"><td><div class="who"><b>${esc(nameOf(e.id))}</b><small>${e.numbers.length ? esc(e.numbers.map(numLabel).join(' · ')) : 'No numbers yet'}</small>${tags.length ? `<span class="chips">${tags.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</span>` : ''}</div></td>${cells(e)}</tr>`;
    }).join('');
    $('contacts').innerHTML = (looseRows ? `<tr class="grp"><td colspan="3"><b>New numbers</b> <small>Choose a contact for each</small></td></tr>${looseRows}${pplRows ? '<tr class="grp"><td colspan="3"><b>Contacts</b></td></tr>' : ''}` : '') + pplRows
      || `<tr><td colspan="3" class="empty">${all.length ? 'Nothing matches.' : 'No contacts yet.'}</td></tr>`;
  }

  function mediaLine(msgs) {
    const urls = [...new Set(msgs.flatMap(urlsOf))];
    const st = s => urls.filter(u => (mediaIdx.get(u) || {}).status === s).length;
    if (!urls.length) return 'No pictures or videos.';
    if (!native) return `${urls.length} picture or video link${urls.length === 1 ? '' : 's'}. Saving them needs the Android app.`;
    return `Pictures and videos saved on this phone: ${st('saved')} of ${urls.length - st('notmedia')}${pendingMedia.size ? ' (saving…)' : ''}.${st('gone') ? ` ${st('gone')} had already expired at TextNow.` : ''}`;
  }
  const dis = () => isExample ? ' disabled' : '';
  const byName = () => [...people.values()].map(p => p.id).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));

  // A number with no contact yet: Bob picks the contact (phone contacts only suggest one).
  function renderAssign(n, msgs) {
    const hint = phoneNames[n] || '';
    const match = hint && byName().find(id => nameOf(id).toLowerCase() === hint.toLowerCase());
    $('record').innerHTML = `
      <p class="hint">${hint ? `Your phone contacts have this number as <b>${esc(hint)}</b>.` : 'Which contact does this number belong to?'}</p>
      ${people.size ? `<div class="add"><select id="a-pick" aria-label="Contact"${dis()}><option value="">Choose a contact…</option>${byName().map(id => `<option value="${esc(id)}"${id === match ? ' selected' : ''}>${esc(nameOf(id))}</option>`).join('')}</select><button type="button" class="btn solid" id="a-add"${dis()}>Add to contact</button></div>` : ''}
      <div class="add"><input id="a-new" placeholder="New contact name" aria-label="New contact name" value="${esc(match ? '' : hint)}"${dis()}><button type="button" class="btn${people.size ? '' : ' solid'}" id="a-create"${dis()}>Create contact</button></div>
      <p class="meta">${esc(mediaLine(msgs))}</p>`;
  }

  // A contact gets the offer once it has a number, while none of its numbers are in the phone's contacts.
  // With Contacts access turned off Tof can't tell, so it offers anyway.
  const offerSave = (id, ns) => !!(native && native.saveContact) && !isExample && ns.length > 0 && !ns.some(n => phoneNames[n]);
  let savedOffer = false;

  function phoneCopyHtml(c) {
    const rows = [];
    const add = (k, v) => { if (v) rows.push(`<div class="pc-row"><span class="pc-k">${esc(k)}</span><span class="pc-v">${v}</span></div>`); };
    const list = (xs, link) => xs.map(x => `<span>${link ? link(x.value || x) : esc(x.value || x)}${x.label ? ` <small>${esc(x.label)}</small>` : ''}</span>`).join('');
    add('Name', esc(c.name)); add('Nickname', esc(c.nickname));
    add('Phone', list(c.phones));
    add('Email', list(c.emails, e => `<a href="mailto:${esc(e)}">${esc(e)}</a>`));
    add('Address', list(c.addresses));
    add('Company', esc([c.title, c.company].filter(Boolean).join(', ')));
    add('Birthday', esc(c.birthday));
    add('Website', list(c.websites, w => `<button type="button" class="linkbtn" data-openurl="${esc(w)}">${esc(w)}</button>`));
    add('Note', esc(c.note));
    return `<details class="phonecopy" open><summary>From your phone's contacts</summary>${rows.join('')}<p class="hint">Copied ${esc(fullFmt.format(new Date(c.copied)))}. Tof reads this entry and never changes it.</p></details>`;
  }

  function renderPerson(id, msgs) {
    const f = fieldsOf(id), p = people.get(id), ns = numbersOf(id), name = (f.name || '').trim();
    $('record').innerHTML = `
      <label for="f-name">Name<input id="f-name" data-f="name" value="${esc(f.name || '')}" placeholder="Contact name"${dis()}></label>
      <div class="group"><span class="lbl">Numbers</span>
        ${ns.map(n => `<div class="numrow"><span class="n">${esc(n)}</span><input data-label="${esc(n)}" value="${esc(num(n).label || '')}" placeholder="Label, like work" aria-label="Label for ${esc(n)}"${dis()}>${native && native.textVia ? `<button type="button" class="btn" data-text="${esc(n)}" aria-label="Text ${esc(n)} in TextNow">Text</button>` : ''}<button type="button" class="x" data-detach="${esc(n)}" aria-label="Remove ${esc(n)} from this contact"${dis()}>×</button></div>${phoneNames[n] && phoneNames[n].toLowerCase() !== name.toLowerCase() ? `<small class="hint">Phone contacts: ${esc(phoneNames[n])}${name ? '' : ` <button type="button" class="chip goto" data-usename="${esc(phoneNames[n])}"${dis()}>Use this name</button>`}</small>` : ''}`).join('')}
        <div class="add"><input id="newnum" placeholder="Add a number" aria-label="Add a number" inputmode="tel"${dis()}><button type="button" class="btn" id="addnum"${dis()}>Add number</button></div>
      </div>
      ${offerSave(id, ns) ? `<p class="offer">${name ? esc(name) : 'This contact'} isn't in your phone's contacts. <button type="button" class="btn" id="savephone"${dis()}>Save to phone contacts</button></p>` : ''}
      ${p.phone ? phoneCopyHtml(p.phone) : ''}
      <div class="group"><span class="lbl">Links</span>
        ${linksOf(id).map((u, i) => `<div class="linkrow"><input data-link="${i}" value="${esc(u)}" aria-label="Link ${i + 1}" inputmode="url"${dis()}><button type="button" class="btn" data-open="${i}">Open</button><button type="button" class="btn" data-copy="${i}">Copy</button><button type="button" class="x" data-unlink="${i}" aria-label="Remove link ${i + 1}"${dis()}>×</button></div>${snapLine(u)}`).join('')}
        <div class="add"><input id="newlink" placeholder="Paste a link" aria-label="New link" inputmode="url"${dis()}><button type="button" class="btn" id="addlink"${dis()}>Add link</button></div>
      </div>
      <label for="f-tags">Tags<input id="f-tags" data-f="tags" value="${esc(f.tags || '')}" placeholder="Comma separated, like work, family"${dis()}></label>
      ${fieldDefs.map(d => `<div class="row"><label for="f-${esc(d.id)}">${esc(d.label)}<input id="f-${esc(d.id)}" data-f="${esc(d.id)}" value="${esc(f[d.id] || '')}"${dis()}></label><button type="button" class="x" data-remove="${esc(d.id)}" aria-label="Remove field ${esc(d.label)}"${dis()}>×</button></div>`).join('')}
      <label for="f-notes">Notes<textarea id="f-notes" data-f="notes"${dis()}>${esc(f.notes || '')}</textarea></label>
      <div class="add"><input id="newfield" placeholder="New field, like Company or Case number" aria-label="New field name"${dis()}><button type="button" class="btn" id="addfield"${dis()}>Add field</button></div>
      <p class="meta">${isExample ? 'Add your own exports in Settings to start keeping records.' : esc(mediaLine(msgs)) + (p.updated ? ` Record updated ${esc(fullFmt.format(new Date(p.updated)))}.` : '')}</p>
      <div><button type="button" class="btn quiet" id="delperson"${dis()}>Delete contact</button></div>`;
  }

  // Stats scoped to the open contact.
  const dur = ms => ms < 36e5 ? `${Math.max(1, Math.round(ms / 6e4))} min` : ms < 864e5 ? `${(ms / 36e5).toFixed(1)} h` : `${(ms / 864e5).toFixed(1)} d`;
  const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
  function renderConvoStats(msgs) {
    if ($('view-contact').hidden || sub !== 'cstats') return;
    if (!msgs.length) { $('cstats-tiles').innerHTML = '<p class="empty">No messages yet.</p>'; $('cdaily').innerHTML = $('chours').innerHTML = ''; $('cdaysub').textContent = ''; return; }
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

  function scope() {
    if (!sel) return { ns: [], msgs: [] };
    const id = openId(), ns = id ? numbersOf(id) : [sel.slice(2)];
    if (only && !ns.includes(only)) only = '';
    const set = new Set(only ? [only] : ns);
    return { id, ns, msgs: messages.filter(m => set.has(m.contact)).sort((a, b) => a.when - b.when) };
  }

  function renderReader() {
    const { id, ns, msgs } = scope();
    const title = !sel ? 'Contact' : id ? nameOf(id) : sel.slice(2);
    $('readertitle').textContent = title;
    $('contactbody').hidden = !sel; $('nocontact').hidden = !!sel; $('back').hidden = !sel;
    $('readersub').textContent = !sel ? ''
      : !id ? `New number · ${fmt.format(msgs.length)} message${msgs.length === 1 ? '' : 's'}.`
      : `${ns.length} number${ns.length === 1 ? '' : 's'} · ${fmt.format(msgs.length)} message${msgs.length === 1 ? '' : 's'}${only ? ` with ${only}` : ''}, oldest first.`;
    const active = document.activeElement && $('record').contains(document.activeElement) ? document.activeElement.id : null;
    if (sel) id ? renderPerson(id, msgs) : renderAssign(sel.slice(2), msgs);
    renderTimers();
    if (active && $(active)) $(active).focus();
    renderConvoStats(msgs);
    // A contact with several numbers can show all their messages together or one number's at a time.
    const multi = id && ns.length > 1;
    $('only').hidden = !multi || sub === 'info';
    $('only').innerHTML = multi ? [['', 'All numbers'], ...ns.map(n => [n, num(n).label || n])].map(([v, t]) => `<button type="button" class="chip pick${v === only ? ' on' : ''}" data-only="${esc(v)}" aria-pressed="${v === only}">${esc(t)}</button>`).join('') : '';
    const tag = multi && !only;
    renderMedia(msgs, multi);
    $('reader').innerHTML = msgs.length ? msgs.map(m => `<div class="msg ${m.you ? 'you' : 'them'}" data-k="${esc(m.k)}">${bodyHtml(m)}<time>${fullFmt.format(m.when)}${tag ? ` · ${esc(num(m.contact).label || m.contact)}` : ''}</time></div>`).join('')
      : sel ? '<p class="empty">No messages yet. Share a TextNow export for one of these numbers to add them.</p>' : '';
    // A URL that isn't a loadable picture falls back to a plain link.
    $('reader').querySelectorAll('img.pic').forEach(img => img.addEventListener('error', () => {
      const a = img.parentElement; a.classList.add('link'); a.textContent = a.href;
    }, { once: true }));
    document.querySelectorAll('#contacts tr').forEach(tr => tr.classList.toggle('sel', tr.dataset.k === sel));
  }
  // ---- Media: the Contact > Media subtab and the Media tab share tiles, the viewer and the jump to a message ----
  const VIDEO_RE = /\.(mp4|m4v|webm|3gp|mov)(\?|#|$)/i;
  const isSavedE = e => e.status === 'saved' && !!e.local;
  const isVideo = i => isSavedE(i.e) ? /^video\//.test(i.e.mime) : VIDEO_RE.test(i.u);
  const keyOfNumber = n => personOf(n) ? 'p:' + personOf(n) : 'n:' + n;
  const whoOf = n => personOf(n) ? nameOf(personOf(n)) : phoneNames[n] || n;
  const keyOfM = m => m.person ? 'p:' + m.person : keyOfNumber(m.contact);
  const whoOfM = m => m.person ? nameOf(m.person) : whoOf(m.contact);
  // The same picture saved from two links is kept once and shown once (the newest message's).
  const itemsOf = msgs => {
    const out = [], seen = new Set();
    [...msgs].sort((a, b) => b.when - a.when).forEach(m => urlsOf(m).forEach(u => {
      const e = shown(mediaIdx.get(u));
      if (e && e.status === 'notmedia') return;
      const key = e ? e.url : u;
      if (seen.has(key)) return;
      seen.add(key); out.push({ u, m, e: e || {} });
    }));
    return out;
  };
  function tileHtml(i, n, cap) {
    const { e } = i, saved = isSavedE(e), video = isVideo(i);
    const badge = e.status === 'gone' ? ''
      : saved && e.online === false ? '<span class="mbadge">Only on this phone</span>'
      : saved ? '' : pendingMedia.has(i.u) ? '<span class="mbadge">Saving…</span>' : '<span class="mbadge">Not saved yet</span>';
    const thumb = e.status === 'gone' ? '<span class="mgone">Expired at TextNow before saving</span>'
      : video ? `<video src="${esc(saved ? e.local : i.u)}#t=0.1" preload="metadata" muted playsinline></video><span class="mplay" aria-hidden="true">▶</span>`
      : `<img src="${esc(saved ? e.local : i.u)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
    return `<button type="button" class="mtile" data-mi="${n}" aria-label="${video ? 'Video' : 'Picture'}, ${esc(cap)}. Press and hold to open the message.">${thumb}${badge}<span class="mcap">${esc(cap)}</span></button>`;
  }
  const savedLine = list => {
    const saved = list.filter(i => isSavedE(i.e)).length, gone = list.filter(i => i.e.status === 'gone').length;
    return native ? `${fmt.format(saved)} saved on this phone${gone ? `, ${fmt.format(gone)} expired before saving` : ''}.` : 'Saving them needs the Android app.';
  };

  // Contact > Media: every picture and video for the open contact.
  let mediaItems = [];
  function renderMedia(msgs, multi) {
    if ($('view-contact').hidden || sub !== 'media') return;
    mediaItems = itemsOf(only || !openId() ? msgs : [...msgs, ...pickMsgs(openId())]);
    $('mediasub').textContent = !mediaItems.length ? 'No pictures or videos.'
      : `${fmt.format(mediaItems.length)} picture${mediaItems.length === 1 ? '' : 's'} or video${mediaItems.length === 1 ? '' : 's'}, newest first. ${savedLine(mediaItems)}`;
    $('mediagrid').innerHTML = mediaItems.map((i, n) => tileHtml(i, n, i.m.link ? 'From ' + hostOf(i.m.link) : dayFmt.format(i.m.when) + (multi ? ' · ' + (num(i.m.contact).label || i.m.contact) : ''))).join('');
    checkFresh(mediaItems.map(i => i.u));
    saveMediaFor(mediaItems.map(i => i.m));
  }

  // The Media tab: everyone's pictures and videos, newest first, by month.
  let allItems = [], mWho = '', mKind = '', mShown = 240;
  const monthFmt = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' });
  function renderAllMedia() {
    if ($('view-media').hidden) return;
    const every = itemsOf([...messages, ...allPickMsgs()]);
    const counts = new Map();
    every.forEach(i => { const k = keyOfM(i.m); counts.set(k, (counts.get(k) || 0) + 1); });
    if (mWho && !counts.has(mWho)) mWho = '';
    const whoName = k => k.startsWith('p:') ? nameOf(k.slice(2)) : phoneNames[k.slice(2)] || k.slice(2);
    const chip = (v, t, on, attr) => `<button type="button" class="chip pick${on ? ' on' : ''}" data-${attr}="${esc(v)}" aria-pressed="${on}">${esc(t)}</button>`;
    $('mwho').innerHTML = counts.size > 1 ? [chip('', 'Everyone', !mWho, 'who'), ...[...counts].sort((a, b) => b[1] - a[1]).map(([k]) => chip(k, whoName(k), k === mWho, 'who'))].join('') : '';
    $('mkind').innerHTML = every.length ? [['', 'All'], ['pic', 'Pictures'], ['video', 'Videos']].map(([v, t]) => chip(v, t, v === mKind, 'kind')).join('') : '';
    allItems = every.filter(i => (!mWho || keyOfM(i.m) === mWho) && (!mKind || (mKind === 'video') === isVideo(i)));
    const whoN = new Set(every.map(i => keyOfM(i.m))).size;
    $('allmediasub').textContent = isExample ? 'Pictures and videos from your conversations will show here once you import some.'
      : !every.length ? 'No pictures or videos yet.'
      : `${fmt.format(every.length)} picture${every.length === 1 ? '' : 's'} and video${every.length === 1 ? '' : 's'} from ${fmt.format(whoN)} contact${whoN === 1 ? '' : 's'}. Tap to view, press and hold to open the message. ${savedLine(every)}`;
    const shown = allItems.slice(0, mShown);
    let html = '', month = '';
    shown.forEach((i, n) => {
      const mo = monthFmt.format(i.m.when);
      if (mo !== month) { html += `${month ? '</div>' : ''}<h2 class="mmonth">${esc(mo)}</h2><div class="mgrid">`; month = mo; }
      html += tileHtml(i, n, whoOfM(i.m) + ' · ' + (i.m.link ? hostOf(i.m.link) : dayFmt.format(i.m.when)));
    });
    $('allmedia').innerHTML = html + (month ? '</div>' : '') + (every.length && !allItems.length ? '<p class="empty">Nothing matches.</p>' : '');
    $('mediamore').hidden = allItems.length <= mShown;
    checkFresh(shown.map(i => i.u));
    saveMediaFor(shown.map(i => i.m));
  }
  $('mwho').addEventListener('click', e => { const b = e.target.closest('[data-who]'); if (b) { mWho = b.dataset.who; mShown = 240; renderAllMedia(); } });
  $('mkind').addEventListener('click', e => { const b = e.target.closest('[data-kind]'); if (b) { mKind = b.dataset.kind; mShown = 240; renderAllMedia(); } });
  $('mediamore').addEventListener('click', () => { mShown += 240; renderAllMedia(); });
  function refreshMedia() { renderReader(); renderAllMedia(); }

  // Tap a tile to view it; press and hold to open its message in the contact's conversation.
  function pressable(el, list) {
    let t, fired = false, sx = 0, sy = 0;
    const tile = ev => ev.target.closest('.mtile');
    const long = b => { fired = true; clearTimeout(t); try { native && native.buzz && native.buzz(); } catch (err) {} jumpTo(list()[+b.dataset.mi]); };
    el.addEventListener('pointerdown', ev => { const b = tile(ev); if (!b) return; fired = false; sx = ev.clientX; sy = ev.clientY; clearTimeout(t); t = setTimeout(() => long(b), 500); });
    el.addEventListener('pointermove', ev => { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 10) clearTimeout(t); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(n => el.addEventListener(n, () => clearTimeout(t)));
    el.addEventListener('contextmenu', ev => { const b = tile(ev); if (!b) return; ev.preventDefault(); if (!fired) long(b); });
    el.addEventListener('click', ev => { const b = tile(ev); if (!b) return; if (fired) { fired = false; ev.preventDefault(); return; } openMedia(list(), +b.dataset.mi); });
    el.addEventListener('keydown', ev => { const b = tile(ev); if (b && ev.key === 'Enter' && ev.shiftKey) { ev.preventDefault(); long(b); } });
  }
  pressable($('mediagrid'), () => mediaItems);
  pressable($('allmedia'), () => allItems);

  // ---- Viewer ----
  let viewList = [], viewAt = 0;
  function openMedia(list, n) {
    viewList = list; viewAt = n;
    const i = list[n]; if (!i) return;
    const { e, m } = i, saved = isSavedE(e), src = saved ? e.local : i.u;
    $('mediaview').innerHTML = e.status === 'gone' ? '<p class="empty">This one expired at TextNow before Tof could save it.</p>'
      : isVideo(i) ? `<video src="${esc(src)}" controls autoplay playsinline></video>` : `<img src="${esc(src)}" alt="Picture message" referrerpolicy="no-referrer">`;
    const state = e.status === 'gone' ? 'Expired before saving' : !saved ? 'Not saved on this phone yet' : e.online === false ? 'Saved on this phone. No longer on TextNow' : e.checkedAt ? `Saved on this phone. Matched TextNow's copy ${dayFmt.format(new Date(e.checkedAt))}` : 'Saved on this phone';
    const label = m.contact && num(m.contact).label, who = whoOfM(m) + (label ? ` · ${label}` : '') + (m.link ? ` · from ${hostOf(m.link)}` : '');
    $('mediacap').innerHTML = `<b>${esc(m.you ? 'You to ' + who : who)}</b><br>${esc(fullFmt.format(m.when))}<br>${esc(state)}${(e.versions || []).length ? `<br>Earlier versions: ${e.versions.map(v => `<a href="${esc(v.local)}" target="_blank" rel="noopener">${esc(dayFmt.format(new Date(v.at)))}</a>`).join(', ')}` : ''}`;
    $('mediacount').textContent = list.length > 1 ? `${fmt.format(n + 1)} of ${fmt.format(list.length)}` : '';
    $('mediaprev').disabled = n === 0; $('medianext').disabled = n >= list.length - 1;
    $('mediaprev').hidden = $('medianext').hidden = list.length < 2;
    $('mediasave').hidden = !saved || !native || !native.saveMediaAs;
    $('mediarot').hidden = !saved || isVideo(i) || !native || !native.rotateMedia;
    $('mediashow').textContent = m.link ? 'Show the link' : 'Show in conversation';
    const d = $('mediadlg'); if (!d.open) { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }
  }
  function closeMedia() { const d = $('mediadlg'); $('mediaview').innerHTML = ''; if (d.close) d.close(); else d.removeAttribute('open'); }
  const step = d => { if (viewList[viewAt + d]) openMedia(viewList, viewAt + d); };
  $('mediaprev').addEventListener('click', () => step(-1));
  $('medianext').addEventListener('click', () => step(1));
  $('mediadlg').addEventListener('keydown', e => { if (e.key === 'ArrowLeft') step(-1); else if (e.key === 'ArrowRight') step(1); });
  let swipeX = null;
  $('mediaview').addEventListener('touchstart', e => { swipeX = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
  $('mediaview').addEventListener('touchend', e => { if (swipeX == null) return; const dx = e.changedTouches[0].clientX - swipeX; swipeX = null; if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1); });
  $('mediaclose').addEventListener('click', closeMedia);
  $('mediadlg').addEventListener('close', () => { $('mediaview').innerHTML = ''; });
  $('mediashow').addEventListener('click', () => jumpTo(viewList[viewAt]));
  $('mediarot').addEventListener('click', () => { const i = viewList[viewAt]; if (i) rotateSaved(i.u, 90); });
  $('mediasave').addEventListener('click', () => {
    const i = viewList[viewAt]; if (!i || !isSavedE(i.e)) return;
    native.saveMediaAs(fileOf(i.e), exportName(i), i.e.mime || '');
  });
  window.__tofSavedAs = (ok, name) => {
    setStatus(ok ? `Saved a copy as ${name}.` : `Couldn't save ${name}.`, !ok);
    if (ok) logEvent('media', `Saved a copy of a picture or video as ${name}`);
  };

  // Opens the message a picture or video came in, in its contact's Conversations, and highlights it.
  let jumpFrom = null;
  function jumpTo(i) {
    if (!i) return;
    const fromMedia = !$('view-media').hidden;
    jumpFrom = fromMedia ? window.scrollY : null;
    if ($('mediadlg').open) closeMedia();
    flushSave(); sel = keyOfM(i.m); only = '';
    renderContacts(); showTab('contact'); showSub(i.m.link ? 'info' : 'convos');
    const el = i.m.link ? [...document.querySelectorAll('#record [data-link]')].find(x => normLink(x.value) === i.m.link)?.closest('.linkrow')
      : [...document.querySelectorAll('#reader .msg')].find(x => x.dataset.k === i.m.k);
    if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 2600); }
    $('jumptext').textContent = `Jumped to ${i.m.you ? 'your' : whoOfM(i.m) + "'s"} ${isVideo(i) ? 'video' : 'picture'} from ${i.m.link ? hostOf(i.m.link) : dayFmt.format(i.m.when)}`;
    $('jumpback').hidden = !fromMedia;
    $('jumpnote').hidden = false;
    clearTimeout(jumpTo.t); jumpTo.t = setTimeout(() => { $('jumpnote').hidden = true; }, 6000);
  }
  $('jumpback').addEventListener('click', () => {
    const y = jumpFrom; $('jumpnote').hidden = true; showTab('media'); renderAllMedia();
    if (y != null) window.scrollTo(0, y);
  });

  // ---- Media folder: copies of saved pictures and videos in a folder Bob picks, so they outlive Tof ----
  let mediaFolderName = '';
  const copiedTokens = new Set();
  const fileOf = e => (e.local || '').replace(/\?.*$/, '').split('/').pop();
  const tokenOf = e => fileOf(e).split('.')[0].slice(0, 10) + ((e.versions || []).length ? '-v' + (e.versions.length + 1) : '') + (e.turns ? '-r' + e.turns : '');
  const pad = n => String(n).padStart(2, '0');
  function exportName(i) {
    const d = i.m.when, ext = fileOf(i.e).split('.').pop();
    const who = whoOfM(i.m).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())} ${who}${i.m.you ? ' (you)' : ''} ${tokenOf(i.e)}.${ext}`;
  }
  let copyT;
  function copyToFolder() {
    if (!native || !native.copyMedia || !mediaFolderName || isExample) return;
    const items = itemsOf([...messages, ...allPickMsgs()]).filter(i => isSavedE(i.e) && !copiedTokens.has(tokenOf(i.e)))
      .map(i => ({ file: fileOf(i.e), name: exportName(i), token: tokenOf(i.e), replace: i.e.turns ? fileOf(i.e).split('.')[0].slice(0, 10) : '' }));
    Object.entries(pages).forEach(([u, e]) => [e, ...(e.versions || [])].forEach(v => {
      if (!v.file || copiedTokens.has(v.file.replace(/\.\w+$/, ''))) return;
      const p = whoHasLink(u), d = new Date(v.savedAt || v.at), clean = s => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
      items.push({ dir: 'pages', file: v.file, token: v.file.replace(/\.\w+$/, ''),
        name: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clean(p ? nameOf(p.id) : 'Link')} ${clean(e.title || hostOf(u))} ${v.file}` });
    }));
    for (let k = 0; k < items.length; k += 200) native.copyMedia(JSON.stringify(items.slice(k, k + 200)));
  }
  const copySoon = () => { clearTimeout(copyT); copyT = setTimeout(copyToFolder, 2000); };
  window.__tofMediaFolder = name => {
    mediaFolderName = name; copiedTokens.clear();
    if (name) logEvent('media', `Keeping copies of saved pictures and videos in ${name}`);
    renderSettings(); copyToFolder();
  };
  let copyTally = { made: 0, failed: 0 }, copyLogT;
  window.__tofMediaCopied = (tokens, made, failed) => {
    tokens.forEach(t => copiedTokens.add(t));
    copyTally.made += made; copyTally.failed += failed;
    clearTimeout(copyLogT);
    copyLogT = setTimeout(() => {
      if (copyTally.made) logEvent('media', `Copied ${fmt.format(copyTally.made)} picture${copyTally.made === 1 ? '' : 's'} or video${copyTally.made === 1 ? '' : 's'} to ${mediaFolderName}`);
      if (copyTally.failed) logEvent('media', `Couldn't copy ${fmt.format(copyTally.failed)} to ${mediaFolderName}`);
      copyTally = { made: 0, failed: 0 };
    }, 1500);
    renderSettings();
  };

  // ---- Timers: one-off reminders on a contact. Android sets an alarm for each and notifies when it ends. ----
  const timersOf = id => (people.get(id) || {}).timers || [];
  const ended = t => !!t.done || t.at <= Date.now();
  const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  function durText(ms) {
    const m = Math.round(ms / 6e4), d = Math.floor(m / 1440), h = Math.floor(m % 1440 / 60), mi = m % 60;
    const parts = [d && unit(d, 'day'), h && unit(h, 'hour'), !d && mi && unit(mi, 'minute')].filter(Boolean);
    return parts.length ? parts.slice(0, 2).join(', ') : 'less than a minute';
  }
  const countdownWord = ms => { const m = Math.round(ms / 6e4); return m % 1440 === 0 ? `${m / 1440}-day` : m % 60 === 0 ? `${m / 60}-hour` : `${m}-minute`; };
  const timerTitle = (id, t) => `${nameOf(id)}: ${t.note || 'Timer'}`;
  const timerText = t => t.kind === 'in' ? `Your ${countdownWord(t.dur)} timer ended. Tap to open the conversation.` : `Your timer for ${fullFmt.format(new Date(t.at))} ended. Tap to open the conversation.`;
  let notifyState = '';
  function readNotify() { try { notifyState = native && native.notifyState ? native.notifyState() : ''; } catch (e) { notifyState = ''; } }
  window.__tofNotifyChanged = () => { readNotify(); renderTimers(); };

  function renderTimers() {
    const id = openId(), box = $('timers');
    box.hidden = !id || isExample;
    if (box.hidden) return;
    const list = [...timersOf(id)].sort((a, b) => (ended(a) - ended(b)) || (ended(a) ? b.at - a.at : a.at - b.at));
    const now = Date.now();
    const off = native && native.setTimer && notifyState.startsWith('off') && list.some(t => !ended(t));
    box.innerHTML = `<div class="cardhead"><h2>Timers</h2><button type="button" class="btn" id="addtimer">Add timer</button></div>
      ${!native || !native.setTimer ? '<p class="sub">Timers notify you only in the Android app.</p>' : ''}
      ${off ? '<p class="offer">Notifications are off for Tof, so these timers can\'t alert you. <button type="button" class="btn" id="allownotify">Turn on</button></p>' : ''}
      ${notifyState.includes('inexact') && list.some(t => !ended(t)) ? '<p class="sub">Android may deliver these a few minutes late.</p>' : ''}
      ${list.length ? '' : '<p class="sub">No timers. Add one to be reminded about this contact.</p>'}
      ${list.map(t => { const done = ended(t); return `<div class="trow${done ? ' done' : ''}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5a8 8 0 1 1 0 16 8 8 0 0 1 0-16M12 9v4l2.5 2M5 3L2 6M19 3l3 3"/></svg>
        <div class="tmain"><b>${esc(t.note || 'Timer')}</b>
          <span class="twhen">${done ? `Ended ${esc(fullFmt.format(new Date(t.at)))}` : `In ${esc(durText(t.at - now))} · ${esc(fullFmt.format(new Date(t.at)))}`}</span>
          <small>${t.kind === 'in' ? `Countdown of ${esc(durText(t.dur))}` : 'Set for a date'}, set ${esc(dayFmt.format(new Date(t.created)))}${t.snoozed ? ` · snoozed ${t.snoozed === 1 ? 'once' : t.snoozed + ' times'}` : ''}</small></div>
        <button type="button" class="btn" data-tdel="${esc(t.id)}">${done ? 'Remove' : 'Cancel'}</button></div>`; }).join('')}`;
  }
  // Countdowns tick while the Info subtab is open.
  setInterval(() => { if (!$('view-contact').hidden && sub === 'info' && openId() && timersOf(openId()).length) renderTimers(); }, 30000);

  function saveTimers(id, list) { const p = people.get(id); if (!p) return; p.timers = list; touch(id); flushSave(); }
  function startTimer(id, t) {
    saveTimers(id, [...timersOf(id), t]);
    if (native && native.setTimer) native.setTimer(t.id, t.at, timerTitle(id, t), timerText(t), 'p:' + id);
    logEvent('timer', `Started ${t.kind === 'in' ? `a ${durText(t.dur)} timer` : `a timer for ${fullFmt.format(new Date(t.at))}`} on ${nameOf(id)}${t.note ? `: ${t.note}` : ''}`);
    if (native && native.askNotify && notifyState.startsWith('off')) native.askNotify();
  }
  function dropTimers(id) { timersOf(id).forEach(t => { if (native && native.cancelTimer) native.cancelTimer(t.id); }); }

  // Snoozes and Done taps happen in the notification, so the page takes Android's copy as current.
  function syncTimers() {
    if (!native || !native.timers || isExample) return;
    let them = {}; try { them = JSON.parse(native.timers()) || {}; } catch (e) {}
    const known = new Set();
    people.forEach(p => {
      let changed = false;
      (p.timers || []).forEach(t => {
        known.add(t.id);
        const n = them[t.id];
        if (!n) { if (!ended(t)) native.setTimer(t.id, t.at, timerTitle(p.id, t), timerText(t), 'p:' + p.id); return; }
        if (n.at && n.at !== t.at) { t.at = n.at; t.snoozed = n.snoozed || (t.snoozed || 0) + 1; changed = true; logEvent('timer', `Snoozed ${nameOf(p.id)}${t.note ? `: ${t.note}` : ''} for an hour`); }
        if (n.done && !t.done) { t.done = true; changed = true; }
        // Keep the notification's wording in step with a renamed contact.
        if (!ended(t) && n.title !== timerTitle(p.id, t)) native.setTimer(t.id, t.at, timerTitle(p.id, t), timerText(t), 'p:' + p.id);
      });
      if (changed) touch(p.id);
    });
    Object.keys(them).forEach(k => { if (!known.has(k)) native.cancelTimer(k); });
    flushSave();
  }

  $('timers').addEventListener('click', e => {
    const id = openId(); if (!id) return;
    const t = e.target.closest('button'); if (!t) return;
    if (t.id === 'addtimer') return openTimerDlg(id);
    if (t.id === 'allownotify') return native.askNotify();
    if (t.dataset.tdel) {
      const tm = timersOf(id).find(x => x.id === t.dataset.tdel); if (!tm) return;
      if (native && native.cancelTimer) native.cancelTimer(tm.id);
      saveTimers(id, timersOf(id).filter(x => x.id !== tm.id));
      if (!ended(tm)) logEvent('timer', `Cancelled the timer on ${nameOf(id)}${tm.note ? `: ${tm.note}` : ''}`);
      renderTimers();
    }
  });

  // Add timer dialog: a countdown or a date and time.
  let tKind = 'in';
  const PRESETS = [['1 hour', 60], ['4 hours', 240], ['1 day', 1440], ['3 days', 4320], ['1 week', 10080], ['2 weeks', 20160]];
  const dateVal = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function timerAt() {
    if (tKind === 'in') {
      const mins = (+$('tdays').value || 0) * 1440 + (+$('thours').value || 0) * 60 + (+$('tmins').value || 0);
      return mins > 0 ? { at: Date.now() + mins * 6e4, dur: mins * 6e4 } : null;
    }
    const [y, mo, d] = ($('tdate').value || '').split('-').map(Number), [h, mi] = ($('ttime').value || '').split(':').map(Number);
    if (!y || isNaN(h)) return null;
    const at = new Date(y, mo - 1, d, h, mi || 0).getTime();
    return at > Date.now() ? { at, dur: 0 } : { past: true };
  }
  function renderTimerDlg() {
    ['in', 'on'].forEach(k => { $('tk-' + k).setAttribute('aria-pressed', tKind === k); $('tpane-' + k).hidden = tKind !== k; });
    const mins = (+$('tdays').value || 0) * 1440 + (+$('thours').value || 0) * 60 + (+$('tmins').value || 0);
    $('tpresets').querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.min === mins));
    const r = timerAt();
    $('tpreview').textContent = r && r.at ? `Ends ${fullFmt.format(new Date(r.at))}. Tof will notify you then, even if it's closed.` : r && r.past ? 'That time has already passed.' : tKind === 'in' ? 'Choose how long.' : 'Choose a date and time.';
    $('tpreview').classList.toggle('warn', !!(r && r.past));
    $('tstart').disabled = !(r && r.at);
  }
  function openTimerDlg(id) {
    const d = $('timerdlg'); d.dataset.id = id;
    $('timertitle').textContent = `New timer for ${nameOf(id)}`;
    $('tnote').value = ''; tKind = 'in';
    $('tdays').value = 1; $('thours').value = 0; $('tmins').value = 0;
    const tomorrow = new Date(Date.now() + 864e5); $('tdate').value = dateVal(tomorrow); $('tdate').min = dateVal(new Date()); $('ttime').value = '09:00';
    $('tpresets').innerHTML = PRESETS.map(([t, m]) => `<button type="button" class="chip pick" data-min="${m}">${t}</button>`).join('');
    renderTimerDlg();
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
    $('tnote').focus();
  }
  const closeTimerDlg = () => { const d = $('timerdlg'); if (d.close) d.close(); else d.removeAttribute('open'); };
  $('tk-in').addEventListener('click', () => { tKind = 'in'; renderTimerDlg(); });
  $('tk-on').addEventListener('click', () => { tKind = 'on'; renderTimerDlg(); });
  $('tpresets').addEventListener('click', e => { const b = e.target.closest('[data-min]'); if (!b) return; const m = +b.dataset.min; $('tdays').value = Math.floor(m / 1440); $('thours').value = Math.floor(m % 1440 / 60); $('tmins').value = m % 60; renderTimerDlg(); });
  ['tdays', 'thours', 'tmins', 'tdate', 'ttime'].forEach(k => $(k).addEventListener('input', renderTimerDlg));
  $('tcancel').addEventListener('click', closeTimerDlg);
  $('timerdlg').addEventListener('submit', e => e.preventDefault());
  $('tstart').addEventListener('click', () => {
    const id = $('timerdlg').dataset.id, r = timerAt(); if (!id || !r || !r.at) return;
    startTimer(id, { id: newId(), note: $('tnote').value.trim(), kind: tKind, at: r.at, dur: r.dur, created: Date.now() });
    closeTimerDlg(); renderTimers();
  });

  // A tapped timer notification opens that contact's conversation at the newest message.
  window.__tofOpen = async key => {
    await loaded;
    syncTimers();
    if (!entries().ppl.concat(entries().loose).some(e => e.key === key)) return;
    select(key); showSub('convos');
    requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight));
  };

  // ---- Add link: a link shared from another app or sent from a PC lands here, and Bob picks its contact ----
  let pendingLinks = null;
  function linksIn(text) { return [...new Set((String(text).match(/https?:\/\/[^\s<>"']+/g) || []).map(u => u.replace(/[).,;!?]+$/, '')))]; }
  function showLinkDlg(urls, title) {
    if (!urls.length) return;
    pendingLinks = { urls, title: (title || '').trim() };
    $('linkurls').innerHTML = urls.map(u => `<li>${esc(u)}</li>`).join('');
    $('linktitle').textContent = pendingLinks.title;
    $('linktitle').hidden = !pendingLinks.title;
    $('linkhead').textContent = urls.length === 1 ? 'Add this link to a contact' : `Add these ${urls.length} links to a contact`;
    $('linksearch').value = ''; $('linknew').value = '';
    renderLinkPick();
    const d = $('linkdlg'); if (!d.open) { if (d.showModal) d.showModal(); else d.setAttribute('open', ''); }
  }
  function renderLinkPick() {
    const q = $('linksearch').value.trim().toLowerCase();
    const list = isExample ? [] : [...people.values()].filter(p => !q || [nameOf(p.id), ...numbersOf(p.id)].join(' ').toLowerCase().includes(q))
      .sort((a, b) => (b.updated || 0) - (a.updated || 0)).slice(0, 30);
    $('linkpick').innerHTML = list.length ? list.map(p => `<button type="button" class="pickrow" data-lp="${esc(p.id)}"><b>${esc(nameOf(p.id))}</b><small>${esc(numbersOf(p.id).map(n => num(n).label || n).join(', ') || 'No numbers')}</small></button>`).join('')
      : `<p class="impline">${isExample ? 'No contacts yet. Name a new one below.' : 'No contacts match.'}</p>`;
  }
  function addLinksTo(id) {
    const p = people.get(id); if (!p || !pendingLinks) return;
    const before = linksOf(id), fresh = pendingLinks.urls.filter(u => !before.includes(u));
    p.fields = { ...p.fields, links: [...before, ...fresh] };
    touch(id); snaps.set(id, snapOf(id)); flushSave();
    fresh.forEach(u => logEvent('link', `Added a link to ${nameOf(id)}: ${u}`));
    setStatus(fresh.length ? `Added ${fresh.length === 1 ? 'the link' : fresh.length + ' links'} to ${nameOf(id)}.` : `${nameOf(id)} already has ${pendingLinks.urls.length === 1 ? 'that link' : 'those links'}.`);
    closeLinkDlg();
    select('p:' + id); showSub('info');
  }
  const closeLinkDlg = () => { pendingLinks = null; const d = $('linkdlg'); if (d.close) d.close(); else d.removeAttribute('open'); };
  $('linksearch').addEventListener('input', renderLinkPick);
  $('linkpick').addEventListener('click', e => { const b = e.target.closest('[data-lp]'); if (b) addLinksTo(b.dataset.lp); });
  $('linkcreate').addEventListener('click', () => {
    const name = $('linknew').value.trim(); if (!name) { $('linknew').focus(); return; }
    if (isExample) { messages = []; people.clear(); numbers.clear(); isExample = false; sel = null; }
    addLinksTo(createPerson(name));
  });
  $('linknew').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('linkcreate').click(); } });
  $('linkcancel').addEventListener('click', closeLinkDlg);
  $('linkdlg').addEventListener('cancel', () => { pendingLinks = null; });
  window.__tofLink = async (text, title) => {
    await loaded;
    const urls = linksIn(text);
    const rest = String(text).replace(/https?:\/\/[^\s<>"']+/g, '').trim();
    showLinkDlg(urls, title || rest.split('\n')[0].slice(0, 200));
  };

  // ---- Saved copies of links: Android saves each contact link's page (or file) so it can be read offline ----
  let pages = {}; // normalised link -> { status, file, mime, size, title, images[], at, versions[] }
  const savePages = () => putAll('meta', [{ id: 'pages', map: pages }]);
  const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u; } };
  const whoHasLink = u => [...people.values()].find(p => (p.fields.links || []).some(l => normLink(l) === u));
  let snapT;
  function snapLinks() {
    if (!native || !native.snapshot || isExample) return;
    const stale = Date.now() - 10 * 6e4;
    people.forEach(p => (p.fields.links || []).map(normLink).filter(Boolean).forEach(u => {
      const e = pages[u];
      if (e && (e.status === 'saved' || e.status === 'failed' || (e.status === 'pending' && e.at > stale))) return;
      pages[u] = { ...(e || {}), status: 'pending', at: Date.now() };
      native.snapshot(u);
    }));
    savePages();
  }
  const snapSoon = () => { clearTimeout(snapT); snapT = setTimeout(snapLinks, 800); };
  function snapAgain(u) {
    if (!native || !native.snapshot) return;
    pages[u] = { ...(pages[u] || {}), status: 'pending', again: true, at: Date.now() };
    savePages(); native.snapshot(u); renderReader();
  }
  window.__tofPageDone = (url, status, file, mime, size, title, images) => {
    const prev = pages[url] || {}, p = whoHasLink(url), who = p ? nameOf(p.id) : 'a contact';
    if (status === 'saved') {
      const versions = [...(prev.versions || [])];
      if (prev.file && prev.file !== file) versions.push({ file: prev.file, mime: prev.mime, at: prev.savedAt || prev.at });
      pages[url] = { status, file, mime, size, title: title || prev.title || '', images: (images && images.length ? images : prev.images) || [], at: Date.now(), savedAt: Date.now(), versions };
      logEvent('link', `${prev.again ? 'Saved a new copy' : 'Saved a copy'} of ${url} for ${who}`);
      copySoon();
    } else if (prev.file) {
      pages[url] = { ...prev, status: 'saved', again: false };
      logEvent('link', `Couldn't save a new copy of ${url}; the earlier copy is kept`);
    } else {
      pages[url] = { status: 'failed', at: Date.now() };
      logEvent('link', `Couldn't save a copy of ${url} for ${who}`);
    }
    savePages();
    clearTimeout(rr); rr = setTimeout(refreshMedia, 300);
  };
  function snapLine(raw) {
    const u = normLink(raw), e = pages[u];
    if (!native || !native.snapshot || !u || isExample) return '';
    if (!e || e.status === 'pending') return `<small class="snap">Saving a copy of this page…</small>`;
    if (e.status === 'failed') return `<small class="snap warn">Couldn't save a copy. <button type="button" class="linkbtn" data-snapagain="${esc(u)}">Try again</button></small>`;
    const kind = /pdf/.test(e.mime) ? 'PDF' : /^image\//.test(e.mime) ? 'picture' : /^video\//.test(e.mime) ? 'video' : 'copy';
    const n = (e.images || []).length;
    return `<small class="snap">Saved ${kind} ${esc(dayFmt.format(new Date(e.savedAt || e.at)))}${(e.versions || []).length ? ` (${e.versions.length + 1} versions)` : ''} ·
      <button type="button" class="linkbtn" data-snapopen="${esc(u)}">Open saved ${kind === 'copy' ? 'copy' : kind}</button>
      ${n ? ` · <button type="button" class="linkbtn" data-picks="${esc(u)}">Pick pictures (${n})</button>` : ''}
      · <button type="button" class="linkbtn" data-snapagain="${esc(u)}">Save again</button></small>`;
  }

  // Pictures picked from a saved page join the contact's media, labelled with the link they came from.
  const pickMsgs = id => ((people.get(id) || {}).picks || []).map(x => ({ person: id, contact: '', media: [x.u], text: '', when: new Date(x.at), you: false, k: 'pick:' + x.u, link: x.link }));
  const allPickMsgs = () => [...people.keys()].flatMap(pickMsgs);
  let pickState = null;
  function openPicks(id, u) {
    const e = pages[u]; if (!e) return;
    const have = new Set(((people.get(id) || {}).picks || []).map(x => x.u));
    pickState = { id, link: u, items: (e.images || []).map(src => ({ u: src, on: false, rot: 0, have: have.has(src) })) };
    $('picktitle').textContent = `Pictures from ${e.title || hostOf(u)}`;
    renderPicks();
    const d = $('pickdlg'); if (d.showModal) d.showModal(); else d.setAttribute('open', '');
  }
  function renderPicks() {
    const s = pickState; if (!s) return;
    $('pickgrid').innerHTML = s.items.map((i, n) => `<div class="ptile${i.on ? ' on' : ''}${i.have ? ' have' : ''}">
      <button type="button" class="pimg" data-pt="${n}" aria-pressed="${i.on || i.have}"${i.have ? ' disabled' : ''} aria-label="${i.have ? 'Already in Media' : 'Picture ' + (n + 1)}"><img src="${esc(i.u)}" alt="" loading="lazy" referrerpolicy="no-referrer" style="transform: rotate(${i.rot}deg)">${i.have ? '<span class="mbadge">In Media</span>' : i.on ? '<span class="pcheck" aria-hidden="true">✓</span>' : ''}</button>
      ${i.have ? '' : `<button type="button" class="prot" data-prot="${n}" aria-label="Rotate picture ${n + 1}">↻ ${i.rot ? i.rot + '°' : ''}</button>`}</div>`).join('') || '<p class="impline">No pictures found on this page.</p>';
    const k = s.items.filter(i => i.on).length;
    $('pickadd').textContent = k ? `Add ${k} to Media` : 'Add to Media';
    $('pickadd').disabled = !k;
  }
  $('pickgrid').addEventListener('click', e => {
    const s = pickState; if (!s) return;
    const t = e.target.closest('[data-pt], [data-prot]'); if (!t) return;
    if (t.dataset.prot != null) { const i = s.items[+t.dataset.prot]; i.rot = (i.rot + 90) % 360; i.on = true; }
    else { const i = s.items[+t.dataset.pt]; i.on = !i.on; }
    renderPicks();
  });
  const closePicks = () => { pickState = null; const d = $('pickdlg'); if (d.close) d.close(); else d.removeAttribute('open'); };
  $('pickcancel').addEventListener('click', closePicks);
  $('pickdlg').addEventListener('cancel', () => { pickState = null; });
  $('pickadd').addEventListener('click', () => {
    const s = pickState, p = s && people.get(s.id); if (!p) return;
    const chosen = s.items.filter(i => i.on && !i.have);
    p.picks = [...(p.picks || []), ...chosen.map((i, n) => ({ u: i.u, link: s.link, at: Date.now() + n, rot: i.rot }))];
    touch(s.id); flushSave();
    logEvent('media', `Added ${chosen.length} picture${chosen.length === 1 ? '' : 's'} from ${hostOf(s.link)} to ${nameOf(s.id)}`);
    saveMediaFor(pickMsgs(s.id));
    chosen.forEach(i => { const e = mediaIdx.get(i.u); if (i.rot && isSavedE(e || {})) rotateSaved(i.u, i.rot); });
    setStatus(`Added ${chosen.length} picture${chosen.length === 1 ? '' : 's'} to ${nameOf(s.id)}'s media.`);
    closePicks(); renderReader();
  });

  // Rotation: the saved file itself is turned, so copies and the media folder get it the right way up.
  const rotating = new Map(); // file -> url
  function rotateSaved(u, deg) {
    const e = shown(mediaIdx.get(u)); if (!e || !isSavedE(e) || !native || !native.rotateMedia) return;
    rotating.set(fileOf(e), e.url); native.rotateMedia(fileOf(e), deg);
  }
  function pendingRotation(u) {
    for (const p of people.values()) { const x = (p.picks || []).find(x => x.u === u && x.rot && !x.rotDone); if (x) return { p, x }; }
    return null;
  }
  window.__tofRotated = (file, ok) => {
    const u = rotating.get(file); rotating.delete(file);
    const e = u && mediaIdx.get(u); if (!e) return;
    const r = [...mediaIdx.values()].filter(x => x.url === u || x.dupOf === u).map(x => pendingRotation(x.url)).find(Boolean);
    if (r) { r.x.rotDone = true; touch(r.p.id); flushSave(); }
    if (!ok) { setStatus("Couldn't rotate that picture.", true); return; }
    e.local = e.local.replace(/\?.*$/, '') + '?v=' + Date.now();
    e.turns = (e.turns || 0) + 1;
    putAll('media', [e]);
    copySoon();
    if ($('mediadlg').open && viewList[viewAt] && (shown(mediaIdx.get(viewList[viewAt].u)) || {}).url === u) { viewList[viewAt].e = e; openMedia(viewList, viewAt); }
    clearTimeout(rr); rr = setTimeout(refreshMedia, 100);
  };

  function select(key) { flushSave(); sel = key; only = ''; renderContacts(); showTab('contact'); renderReader(); window.scrollTo(0, 0); }
  // Contact subtabs: Info, Conversations, Stats.
  let sub = 'info';
  try { const v = localStorage.getItem('tof-sub'); if (['info', 'convos', 'cstats', 'media'].includes(v)) sub = v; } catch (e) {}
  function showSub(name) {
    sub = name;
    ['info', 'convos', 'cstats', 'media'].forEach(t => { $('sub-' + t).setAttribute('aria-selected', t === name); $('pane-' + t).hidden = t !== name; });
    try { localStorage.setItem('tof-sub', name); } catch (e) {}
    renderReader();
  }
  ['info', 'convos', 'cstats', 'media'].forEach(t => $('sub-' + t).addEventListener('click', () => showSub(t)));
  ['info', 'convos', 'cstats', 'media'].forEach(t => { $('sub-' + t).setAttribute('aria-selected', t === sub); $('pane-' + t).hidden = t !== sub; });
  $('back').addEventListener('click', () => showTab('contacts'));
  $('gocontacts').addEventListener('click', () => showTab('contacts'));
  $('top').addEventListener('click', e => { const b = e.target.closest('button'); if (b && b.dataset.k) select(b.dataset.k); });

  // ---- Editing contacts ----
  const dirty = new Set();
  let saveTimer;
  // Edits are logged once they're saved, naming the fields that changed.
  const snaps = new Map();
  const snapOf = id => { const p = people.get(id); return p ? { ...p.fields, labels: numbersOf(id).filter(n => num(n).label).map(n => n + '=' + num(n).label).join(',') } : null; };
  const fieldName = k => ({ name: 'Name', tags: 'Tags', notes: 'Notes', links: 'Links', labels: 'Number labels' })[k] || (fieldDefs.find(d => d.id === k) || {}).label || k;
  function logEdits(id) {
    const now = snapOf(id), was = snaps.get(id) || {};
    if (!now) return;
    const keys = [...new Set([...Object.keys(now), ...Object.keys(was)])].filter(k => JSON.stringify(now[k] || '') !== JSON.stringify(was[k] || ''));
    snaps.set(id, now);
    if (keys.length && !isExample) logEvent('contact', `Edited ${nameOf(id)}: ${keys.map(fieldName).join(', ')}`);
  }
  function flushSave() {
    clearTimeout(saveTimer); saveTimer = null;
    if (dirty.size) { putAll('people', [...dirty].map(id => people.get(id)).filter(Boolean)); dirty.forEach(logEdits); dirty.clear(); snapSoon(); }
  }
  function touch(id) { const p = people.get(id); if (p) { p.updated = Date.now(); dirty.add(id); } }
  function updateField(f, value) {
    const id = openId(); if (isExample || !id) return;
    const p = people.get(id);
    p.fields = { ...p.fields, [f]: value };
    touch(id);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { flushSave(); renderContacts(); if (openId() === id) $('readertitle').textContent = nameOf(id); }, 400);
  }
  function setNumber(n, change) {
    const r = { ...num(n), ...change, updated: Date.now() };
    numbers.set(n, r); putAll('records', [r]);
  }
  function createPerson(name) {
    const p = { id: newId(), fields: { name: name || '' }, created: Date.now(), updated: Date.now() };
    people.set(p.id, p); putAll('people', [p]);
    snaps.set(p.id, snapOf(p.id));
    logEvent('contact', `Created contact ${name || '(no name yet)'}`);
    return p.id;
  }
  // Takes a number off its contact. One that has no messages is forgotten; one with messages goes back to New numbers.
  function detach(n) {
    const from = personOf(n);
    if (from) logEvent('number', `Removed ${n} from ${nameOf(from)}`);
    if (messages.some(m => m.contact === n)) setNumber(n, { person: null });
    else { numbers.delete(n); delOne('records', n); }
  }

  $('newperson').addEventListener('click', () => {
    if (isExample) return;
    select('p:' + createPerson(''));
    showSub('info');
    $('f-name').focus();
  });
  $('only').addEventListener('click', e => { const v = e.target.dataset.only; if (v != null) { only = v; renderReader(); } });
  $('record').addEventListener('input', e => {
    const d = e.target.dataset, id = openId();
    if (d.f) updateField(d.f, e.target.value);
    if (d.link != null && id) { const l = [...linksOf(id)]; l[+d.link] = e.target.value; updateField('links', l); }
    if (d.label != null && !isExample) { setNumber(d.label, { label: e.target.value.trim() }); if (id) dirty.add(id); clearTimeout(saveTimer); saveTimer = setTimeout(() => { flushSave(); renderContacts(); }, 400); }
  });
  $('record').addEventListener('change', e => {
    // Tidy a link once editing is done: add https:// and drop emptied rows.
    const id = openId();
    if (e.target.dataset.link == null || !id) return;
    updateField('links', linksOf(id).map(normLink).filter(Boolean)); renderReader();
  });
  function openLink(u) {
    u = normLink(u); if (!u) return;
    if (native && native.openPrivate) native.openPrivate(u); else window.open(u, '_blank', 'noopener');
  }
  async function copyLink(u, btn) {
    try { await navigator.clipboard.writeText(u); } catch (_) { const t = document.createElement('textarea'); t.value = u; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); }
    btn.textContent = 'Copied'; setTimeout(() => { if (btn.isConnected) btn.textContent = 'Copy'; }, 1500);
  }
  // Destructive buttons take a second tap.
  function armed(btn, label) {
    if (btn.dataset.armed === '1') return true;
    const was = btn.textContent; btn.dataset.armed = '1'; btn.textContent = label;
    setTimeout(() => { if (btn.isConnected) { btn.dataset.armed = ''; btn.textContent = was; } }, 3000);
    return false;
  }
  $('record').addEventListener('submit', e => e.preventDefault());
  $('record').addEventListener('click', e => {
    const t = e.target, d = t.dataset || {}, id = openId();
    if (isExample && t.tagName === 'BUTTON' && d.open == null && d.copy == null) return;
    // Giving a new number a contact.
    if (t.id === 'a-add' || t.id === 'a-create') {
      const n = sel.slice(2);
      let to = t.id === 'a-add' ? $('a-pick').value : '';
      if (t.id === 'a-add' && !to) { $('a-pick').focus(); return; }
      if (t.id === 'a-create') { const name = $('a-new').value.trim(); if (!name) { $('a-new').focus(); return; } to = createPerson(name); }
      assignNumber(n, to);
      select('p:' + to); renderStats();
      return;
    }
    if (!id) return;
    if (d.open != null) { logEvent('link', `Opened ${normLink(linksOf(id)[+d.open])} for ${nameOf(id)}`); openLink(linksOf(id)[+d.open]); return; }
    if (d.openurl != null) { logEvent('link', `Opened ${normLink(d.openurl)} for ${nameOf(id)}`); openLink(d.openurl); return; }
    if (d.copy != null) { copyLink(normLink(linksOf(id)[+d.copy]), t); return; }
    if (d.text != null) {
      const how = native.textVia(d.text);
      if (how === 'none') { setStatus('No texting app found to open.', true); return; }
      if (how === 'other') setStatus("TextNow isn't installed, so your usual texting app opened.");
      logEvent('contact', `Started a text to ${nameOf(id)} (${d.text}) in ${how === 'textnow' ? 'TextNow' : 'the texting app'}`);
      return;
    }
    if (d.snapopen != null) { const e = pages[d.snapopen]; if (e && e.file) { logEvent('link', `Opened the saved copy of ${d.snapopen}`); native.openSaved(e.file, e.mime); } return; }
    if (d.snapagain != null) { snapAgain(d.snapagain); return; }
    if (d.picks != null) { openPicks(id, d.picks); return; }
    if (d.unlink != null) { updateField('links', linksOf(id).filter((_, i) => i !== +d.unlink)); renderReader(); return; }
    if (d.usename != null) { updateField('name', d.usename); flushSave(); renderContacts(); renderReader(); return; }
    if (d.detach != null) {
      detach(d.detach); touch(id); flushSave();
      setStatus(messages.some(m => m.contact === d.detach) ? `Removed ${d.detach} from ${nameOf(id)}. It's under New numbers now.` : `Removed ${d.detach} from ${nameOf(id)}.`);
      renderContacts(); renderReader(); renderStats();
      return;
    }
    if (t.id === 'addnum') {
      const n = normNumber($('newnum').value);
      if (!n) { $('newnum').focus(); return; }
      const prev = personOf(n);
      if (prev === id) { setStatus(`${n} is already on this contact.`); return; }
      setNumber(n, { person: id }); touch(id); if (prev) touch(prev); flushSave();
      logEvent('number', prev ? `Moved ${n} from ${nameOf(prev)} to ${nameOf(id)}` : `Added ${n} to ${nameOf(id)}`);
      setStatus(prev ? `Moved ${n} from ${nameOf(prev)} to ${nameOf(id)}.` : `Added ${n}. Exports from this number will go to ${nameOf(id)}.`);
      renderContacts(); renderReader(); renderStats(); $('newnum').focus();
      lookupContacts(false);
      return;
    }
    if (t.id === 'savephone') {
      savedOffer = true;
      logEvent('phone', `Opened the Contacts app to save ${nameOf(id)} on the phone`);
      native.saveContact(nameOf(id) === numbersOf(id)[0] ? '' : nameOf(id), JSON.stringify(numbersOf(id)));
      return;
    }
    if (t.id === 'delperson') {
      if (!armed(t, 'Tap again to delete')) return;
      const name = nameOf(id);
      numbersOf(id).forEach(detach);
      dropTimers(id);
      people.delete(id); dirty.delete(id); delOne('people', id);
      setStatus(`Deleted ${name}. Its messages are kept under New numbers.`);
      logEvent('contact', `Deleted contact ${name}`);
      sel = null; render();
      return;
    }
    if (t.id === 'addlink') {
      const u = normLink($('newlink').value);
      if (!u) { $('newlink').focus(); return; }
      updateField('links', [...linksOf(id), u]); renderReader(); $('newlink').focus(); return;
    }
    if (t.id === 'addfield') {
      const label = $('newfield').value.trim();
      if (!label) { $('newfield').focus(); return; }
      if (fieldDefs.some(f => f.label.toLowerCase() === label.toLowerCase())) { setStatus(`There's already a field called ${label}.`, true); return; }
      fieldDefs.push({ id: 'c' + Date.now().toString(36), label });
      logEvent('field', `Added field ${label} to all contacts`);
      putAll('meta', [{ id: 'fields', list: fieldDefs }]);
      renderReader();
      const last = fieldDefs[fieldDefs.length - 1]; if ($('f-' + last.id)) $('f-' + last.id).focus();
      return;
    }
    if (d.remove) {
      if (!armed(t, 'Remove?')) return;
      logEvent('field', `Removed field ${fieldName(d.remove)}`);
      fieldDefs = fieldDefs.filter(f => f.id !== d.remove);
      putAll('meta', [{ id: 'fields', list: fieldDefs }]);
      renderReader();
    }
  });
  $('record').addEventListener('keydown', e => {
    const go = { newfield: 'addfield', newlink: 'addlink', newnum: 'addnum', 'a-new': 'a-create' }[e.target.id];
    if (go && e.key === 'Enter') { e.preventDefault(); $(go).click(); }
  });

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

  $('importbody').addEventListener('click', e => {
    const t = e.target, box = t.closest('.imp');
    if (t.dataset.goto) { closeImport(); select(t.dataset.goto); return; }
    if (!box || !t.dataset.assign) return;
    const n = box.dataset.n;
    let to = '';
    if (t.dataset.assign === 'pick') { const s = box.querySelector('[data-pick]'); to = s.value; if (!to) { s.focus(); return; } }
    else { const i = box.querySelector('[data-newname]'), name = i.value.trim(); if (!name) { i.focus(); return; } to = createPerson(name); }
    assignNumber(n, to);
    sel = 'p:' + to; only = '';
    render(); showImport();
  });
  $('importbody').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.dataset.newname != null) { e.preventDefault(); e.target.nextElementSibling.click(); } });
  $('importdone').addEventListener('click', closeImport);
  $('importdlg').addEventListener('cancel', () => { imported = null; });

  // ---- Tabs ----
  function showTab(name) {
    ['contacts', 'contact', 'media', 'stats', 'log', 'settings'].forEach(t => {
      const on = t === name;
      $('tab-' + t).setAttribute('aria-selected', on);
      $('view-' + t).hidden = !on;
    });
    if (name === 'stats') { drawDaily(); drawHours(); }
    window.scrollTo(0, 0);
    try { localStorage.setItem('tof-tab', name); } catch (e) {}
  }
  $('tab-contacts').addEventListener('click', () => showTab('contacts'));
  $('tab-contact').addEventListener('click', () => { showTab('contact'); renderReader(); });
  $('tab-media').addEventListener('click', () => { showTab('media'); renderAllMedia(); });
  $('tab-stats').addEventListener('click', () => showTab('stats'));
  $('tab-log').addEventListener('click', () => { showTab('log'); renderLog(); });
  $('tab-settings').addEventListener('click', () => showTab('settings'));

  // ---- Wiring ----
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => { if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); });
  $('file').addEventListener('change', e => { if (e.target.files.length) addFiles([...e.target.files]); e.target.value = ''; });
  $('usecontacts').addEventListener('click', () => lookupContacts(true));
  $('phonecheck').addEventListener('click', () => lookupContacts(true));
  $('pickfolder').addEventListener('click', () => native.pickLogFolder());
  $('pickmedia').addEventListener('click', () => native.pickMediaFolder());
  $('logsearch').addEventListener('input', e => { logQuery = e.target.value.trim(); logShown = 300; renderLog(); });
  $('logmore').addEventListener('click', () => { logShown += 300; renderLog(); });
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
    people.forEach(p => dropTimers(p.id));
    await clearAll();
    isExample = false;
    await putAll('meta', [{ id: 'localtime', at: Date.now() }, { id: 'people', at: Date.now() }]);
    if (native) { try { native.clearMedia(); } catch (e) {} }
    messages = []; people.clear(); numbers.clear(); dirty.clear(); fieldDefs = []; mediaIdx.clear(); pages = {}; sel = null;
    setStatus('Deleted all contacts, conversations and saved media. The log is kept.');
    logEvent('data', 'Cleared all contacts, conversations and saved media');
    render();
  });

  const pick = tr => { if (tr && tr.dataset.k) select(tr.dataset.k); };
  $('contacts').addEventListener('click', e => pick(e.target.closest('tr')));
  $('contacts').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(e.target.closest('tr')); } });
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (!$('view-stats').hidden) { drawDaily(); drawHours(); } else if (!$('view-contact').hidden) renderConvoStats(scope().msgs); }, 120); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushSave();
    // Back from the Contacts app: check again so a contact that was just saved stops being offered.
    else if (savedOffer) { savedOffer = false; lookupContacts(false); }
    if (!document.hidden && !isExample) { readNotify(); syncTimers(); renderTimers(); }
  });

  // Before contacts existed, each number had its own record. Numbers whose records hold anything
  // become contacts; numbers that share a typed name become one contact. The rest wait under New numbers.
  function migrateToPeople(recs) {
    const made = new Map();
    const has = v => Array.isArray(v) ? v.length > 0 : String(v || '').trim() !== '';
    recs.forEach(r => {
      const f = r.fields || {};
      if (r.person !== undefined || !Object.values(f).some(has)) return;
      const name = (f.name || '').trim(), k = name ? 'name:' + name.toLowerCase() : 'num:' + r.contact;
      let p = made.get(k);
      if (!p) { p = { id: newId(), fields: {}, created: r.updated || Date.now(), updated: r.updated || Date.now() }; made.set(k, p); }
      Object.entries(f).forEach(([key, v]) => {
        if (!has(v)) return;
        const cur = p.fields[key];
        if (key === 'links') p.fields.links = [...new Set([...(cur || []), ...v])];
        else if (key === 'tags') p.fields.tags = [...new Set([...(cur || '').split(','), ...String(v).split(',')].map(s => s.trim()).filter(Boolean))].join(', ');
        else if (!has(cur)) p.fields[key] = typeof v === 'string' ? v.trim() : v;
        else if (key !== 'name' && String(cur) !== String(v).trim()) p.fields[key] = cur + (key === 'notes' ? '\n\n' : ' / ') + String(v).trim();
      });
      r.person = p.id;
    });
    return [...made.values()];
  }

  // Example data: two contacts (one with two numbers) and one number that has no contact yet.
  function exampleContacts() {
    const a = { id: 'ex-a', fields: { name: 'Alex Rivera', tags: 'family', links: ['https://example.com'] }, created: 0, updated: 0 };
    const b = { id: 'ex-b', fields: { name: 'Sam Lee', tags: 'work' }, created: 0, updated: 0 };
    people.set(a.id, a); people.set(b.id, b);
    [['+15555550142', 'ex-a', 'mobile'], ['+15555550187', 'ex-a', 'work'], ['+15555550123', 'ex-b', '']].forEach(([n, person, label]) => numbers.set(n, { contact: n, person, label }));
  }

  // Shares that arrive before storage has loaded wait for it.
  let ready;
  const loaded = new Promise(r => ready = r);
  window.__tofAdd = async files => { await loaded; return addFiles(files); };

  (async function init() {
    db = await openDb();
    if (db && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    const [stored, recs, media, meta, ppl, logged] = await Promise.all([getAll('messages'), getAll('records'), getAll('media'), getAll('meta'), getAll('people'), getAll('log')]);
    logs = logged.sort((a, b) => b.at - a.at);
    messages = stored.map(fromStored);
    // Messages imported before the time fix were read as UTC; re-read their clock times as local.
    if (messages.length && !meta.some(m => m.id === 'localtime')) {
      messages.forEach(m => { const u = m.when; m.when = new Date(u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(), u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds()); m.k = key(m); });
      await new Promise(res => { if (!db) return res(); const t = db.transaction('messages', 'readwrite'); t.objectStore('messages').clear(); t.oncomplete = res; t.onerror = res; });
      await putAll('messages', messages.map(toStored));
    }
    ppl.forEach(p => people.set(p.id, p));
    if (!meta.some(m => m.id === 'people')) {
      const made = migrateToPeople(recs);
      made.forEach(p => people.set(p.id, p));
      await putAll('people', made);
      await putAll('records', recs.filter(r => r.person !== undefined));
    }
    await putAll('meta', [{ id: 'localtime', at: Date.now() }, { id: 'people', at: Date.now() }]);
    recs.forEach(r => numbers.set(r.contact, { contact: r.contact, person: r.person || null, label: r.label || '', updated: r.updated }));
    media.forEach(m => mediaIdx.set(m.url, m));
    const f = meta.find(m => m.id === 'fields'); if (f) fieldDefs = f.list || [];
    const pg = meta.find(m => m.id === 'pages'); if (pg) pages = pg.map || {};
    people.forEach(p => snaps.set(p.id, snapOf(p.id)));
    if (!messages.length && !people.size) { messages = exampleData(); isExample = true; exampleContacts(); }
    let ver = ''; try { ver = native && native.version ? native.version() : ''; } catch (e) {}
    if (!logs.length) logEvent('app', native ? 'Tof installed or its data was reset' : 'Started keeping a log');
    logEvent('app', `Opened Tof${ver ? ' ' + ver : ''}`);
    try { logFolderName = native && native.logFolder ? native.logFolder() : ''; } catch (e) {}
    if (logFolderName) native.readLog();
    try { mediaFolderName = native && native.mediaFolder ? native.mediaFolder() : ''; } catch (e) {}
    if (!db) setStatus('This browser is not keeping data, so contacts last until you close Tof.', true);
    try { { const t = localStorage.getItem('tof-tab'); if (['contacts', 'contact', 'media', 'stats', 'log', 'settings'].includes(t)) showTab(t); } } catch (e) {}
    render();
    ready();
    readNotify(); syncTimers(); renderTimers();
    saveMediaFor([...messages, ...allPickMsgs()]);
    hashOld();
    snapLinks();
    copyToFolder();
    lookupContacts(false);
  })();
})();
