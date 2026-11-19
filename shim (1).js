// Provides window.claude.use('user' | 'db' | 'sample') on top of this project's own server,
// so the page runs unchanged outside claude.ai.
(function () {
  'use strict';
  function fail(code, extra) { var e = { code: code }; if (extra) Object.assign(e, extra); return e; }

  async function post(url, body, signal) {
    var r;
    try { r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: signal, credentials: 'same-origin' }); }
    catch (e) { throw fail(e && e.name === 'AbortError' ? 'cancelled' : 'unavailable'); }
    return r;
  }
  async function dbCall(body) {
    var r = await post('/api/db', body);
    var j = null; try { j = await r.json(); } catch (e) {}
    if (!r.ok) throw fail((j && j.code) || 'unavailable');
    return j;
  }

  /* ---- user ---- */
  var userCap = {
    me: async function () {
      var r = await fetch('/api/me', { credentials: 'same-origin' });
      if (!r.ok) throw fail('unavailable');
      return r.json();
    }
  };

  /* ---- db ---- */
  function join(a, b) { return a.replace(/\/+$/, '') + '/' + b; }
  function docRef(p) {
    return {
      get: async function () { var j = await dbCall({ op: 'get', path: p }); return { exists: j.exists, data: function () { return j.data; } }; },
      set: async function (data) { await dbCall({ op: 'set', path: p, data: data }); },
      delete: async function () { await dbCall({ op: 'delete', path: p }); },
      collection: function (name) { return colRef(join(p, name)); }
    };
  }
  function colRef(p) {
    return {
      doc: function (id) { return docRef(join(p, id)); },
      get: async function () {
        var j = await dbCall({ op: 'list', path: p });
        return { docs: j.docs.map(function (d) { return { id: d.id, data: function () { return d.data; } }; }) };
      }
    };
  }
  var dbCap = { doc: docRef, collection: colRef };

  /* ---- sample (Claude) ---- */
  async function ask(input, opts) {
    opts = opts || {};
    var body = typeof input === 'string' ? { prompt: input } : { messages: input };
    var r = await post('/api/ai', body, opts.signal);
    if (!r.ok) { var j = null; try { j = await r.json(); } catch (e) {} throw fail((j && j.code) || 'unavailable'); }
    var text = '', truncated = false, buf = '', dec = new TextDecoder(), reader = r.body.getReader();
    function line(l) {
      if (!l.trim()) return;
      var ev; try { ev = JSON.parse(l); } catch (e) { return; }
      if (ev.t) { text += ev.t; if (opts.onText) opts.onText({ text: text }); }
      else if (ev.stop === 'max_tokens') truncated = true;
      else if (ev.error) throw fail(ev.error, { text: text });
    }
    try {
      for (;;) {
        var c = await reader.read(); if (c.done) break;
        buf += dec.decode(c.value, { stream: true });
        var i; while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
      line(buf);
    } catch (e) {
      if (e && e.name === 'AbortError') throw fail('cancelled', { text: text });
      throw e && e.code ? e : fail('unavailable', { text: text });
    }
    return { text: text, truncated: truncated };
  }
  ask.json = async function (prompt, opts) {
    var r = await ask(prompt, Object.assign({}, opts, { onText: null }));
    var t = r.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try { return JSON.parse(t); } catch (e) {}
    var a = t.indexOf('['), z = t.lastIndexOf(']');
    if (a >= 0 && z > a) { try { return JSON.parse(t.slice(a, z + 1)); } catch (e) {} }
    throw fail('invalid_json');
  };

  var caps = { user: userCap, db: dbCap, sample: ask };
  window.claude = window.claude || {};
  if (!window.claude.use) window.claude.use = async function (name) { if (!caps[name]) throw fail('not_declared'); return caps[name]; };
})();
