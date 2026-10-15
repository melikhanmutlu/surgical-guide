/* Server access token (G2). A server started with YOLMED_TOKEN answers /cases*, /guide and /segment only with
   `Authorization: Bearer <token>`, and its config.js says so (window.YOLMED_AUTH). The token is asked once in a dialog
   (#dlgTok), kept for this tab only (sessionStorage, gone when the tab closes) and sent with every server call
   (ServerAuth.fetch). A 401 clears it, asks again and retries the call once. A person who closes the dialog is not
   asked again on every autosave: Settings → "Erişim anahtarını gir" asks again. */
'use strict';
window.ServerAuth = (function () {
  const KEY = 'yolmed.token';
  let mem = '', asking = null, declined = false;
  const get = () => { try { return sessionStorage.getItem(KEY) || mem; } catch (e) { return mem; } };
  const set = t => { mem = t || ''; try { if (t) sessionStorage.setItem(KEY, t); else sessionStorage.removeItem(KEY); } catch (e) { /* storage blocked: kept in memory */ } };
  const need = () => window.YOLMED_AUTH === true;
  const header = (h, t = get()) => Object.assign({}, h || {}, t ? { Authorization: 'Bearer ' + t } : {});
  // the dialog: resolves with the entered token, or null when closed / cancelled
  function dialog(again) {
    const d = document.getElementById('dlgTok'), inp = document.getElementById('tokIn'), err = document.getElementById('tokErr');
    if (!d || !inp) return Promise.resolve(null);
    return new Promise(res => {
      inp.value = ''; if (err) err.textContent = again ? 'Anahtar kabul edilmedi; yeniden girin.' : '';
      d.returnValue = '';
      // Enter in the field connects (the form's first button is the header's close button, which implicit submission would pick)
      const enter = e => { if (e.key === 'Enter') { e.preventDefault(); d.close ? d.close('ok') : (d.returnValue = 'ok', done()); } };
      inp.addEventListener('keydown', enter);
      const done = () => { d.removeEventListener('close', done); inp.removeEventListener('keydown', enter); const t = d.returnValue === 'ok' ? inp.value.trim() : ''; inp.value = ''; res(t || null); };
      d.addEventListener('close', done);
      if (d.showModal) d.showModal(); else d.setAttribute('open', '');
      inp.focus();
    });
  }
  // one question at a time: calls that hit a 401 together share the same answer
  function ask(again) {
    if (!asking) {
      asking = Promise.resolve().then(() => api.prompt(again)).then(t => { if (t) { set(t); declined = false; } else declined = true; return !!t; }, () => { declined = true; return false; })
        .finally(() => { asking = null; });
    }
    return asking;
  }
  async function sfetch(url, opts = {}) {
    if (need() && !get() && !declined) await ask(false);
    const sent = get();
    let r = await fetch(url, Object.assign({}, opts, { headers: header(opts.headers, sent) }));
    if (r.status !== 401) return r;
    // another call already got a new token while this one was on its way: retry with it without asking
    if (get() && get() !== sent) return fetch(url, Object.assign({}, opts, { headers: header(opts.headers) }));
    set('');
    if (declined && !sent) return r;
    if (await ask(!!sent)) r = await fetch(url, Object.assign({}, opts, { headers: header(opts.headers) }));
    return r;
  }
  const api = {
    fetch: sfetch, header, need, token: get, clear: () => set(''),
    prompt: dialog,                 // replaceable (unit tests)
    // before a call that should not meet a 401 at all (the store's first probe): ask now when the server wants a token
    async ready() { if (need() && !get() && !declined) await ask(false); return !!get(); },
    // Settings: ask again even after the dialog was closed once
    async enter() { declined = false; return ask(false); },
  };
  return api;
})();
