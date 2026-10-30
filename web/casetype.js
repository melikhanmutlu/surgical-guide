/* Case types. A case type decides which workflow steps the left panel shows, how they are grouped into numbered
   steps, what each step and its "next" button are called, and which parts of a step are hidden. A new type is one
   more entry in TYPES:

     maxilla: { label: 'Maksilla rekonstrüksiyonu', hint: '…',
                groups: [{ title: 'Vaka ve BT', parts: [['st1', 'Vaka ve BT']] }, { title: 'Kemik modeli', parts: [['st2', '']] },
                         { title: 'Rezeksiyon', parts: [['st3', 'Rezeksiyon']] }, …],   // numbered steps and their parts
                hide: ['#fibUpload'] }                                                  // selectors hidden for this type

   (`steps: [...]` instead of `groups` gives one numbered step per workflow step.) Steps left out are hidden; the parts
   of a group share its number and title and open as tabs inside it (flow.js). Every "next" button points at the
   following shown part. The type is saved with the plan (PlanExt.caseType) and remembered as the default for new
   cases. A change of type is announced on the studio bus ('caseType'), a new grouping as 'groups'. */
'use strict';
window.CaseType = (function () {
  const St = window.Studio, $ = id => document.getElementById(id);
  const KEY = 'gs.caseType', DEF = 'mandible';
  // groups: the numbered steps of the left panel. A group of several workflow steps is one numbered step whose parts
  // open as tabs inside it (flow.js); each part keeps its own <details> element, so code that opens or watches a
  // workflow step by id works unchanged. [id, tab label]
  const TYPES = {
    mandible: {
      label: 'Çene rekonstrüksiyonu',
      hint: 'Mandibula rezeksiyonu, fibula grefti ile rekonstrüksiyon, kesi ve fibula guide\'ları.',
      groups: [
        { title: 'Vaka ve BT', parts: [['st1', 'Vaka ve BT']] },
        { title: 'Kemik modeli', parts: [['st2', 'Kemik modeli']] },
        { title: 'Rezeksiyon', parts: [['st3', 'Rezeksiyon']] },
        { title: 'Guide\'lar', parts: [['st5', 'Mandibula'], ['st4', 'Fibula'], ['st6', 'Vidalar']] },
        { title: 'Doğrulama ve onay', parts: [['st7', 'Onay']] },
        { title: 'Çıktılar', parts: [['st8', 'Çıktılar']] },
      ],
      hide: ['#sampleA', '#sampleAct', '#hAnk', '#ankAppr', '#ankRoi'],
    },
    // malleolar fracture (ankle.js): the pieces of the fracture are reduced by hand, the reduced model is the output
    ankle: {
      label: 'Malleol kırığı',
      hint: 'Ayak bileği kırığı: parçaları ayırma, sanal redüksiyon, ölçümler, redükte model STL\'i, kesi guide\'ı ve kama.',
      groups: [
        { title: 'Vaka ve BT', parts: [['st1', 'Vaka ve BT']] },
        { title: 'Anatomi ve parçalar', parts: [['st2', 'Anatomi ve parçalar']] },
        { title: 'Redüksiyon', parts: [['stRed', 'Redüksiyon']] },
        { title: 'Vidalar ve guide', parts: [['stAnkS', 'Vidalar'], ['stAnkG', 'Kesi guide\'ı']] },
        { title: 'Doğrulama ve onay', parts: [['st7', 'Onay']] },
        { title: 'Çıktılar', parts: [['stAnkOut', 'Çıktılar']] },
      ],
      hide: ['#upFib', '#sampFib', '#sampleM', '#sampleMct', '#sampleL', '#hMand', '#itemAppr', '#segModeBox', '#refBox'],
    },
  };
  // a type given with plain steps (an older entry, a plugin) gets one group per step
  const groupsOf = T => T.groups || T.steps.map(id => ({ title: '', parts: [[id, '']] }));
  const stepsOf = T => groupsOf(T).flatMap(g => g.parts.map(p => p[0]));

  // the page as written is the reference: each step's own title and the label its incoming "next" button had
  const steps = [...document.querySelectorAll('details.step[name="flow"]')];
  const titleNode = d => [...d.querySelector('summary').childNodes].find(n => n.nodeType === 3 && n.data.trim());
  const nextBtn = d => d.querySelector('.nav button.next');
  const base = {};
  steps.forEach(d => { const t = titleNode(d); base[d.id] = { title: t ? t.data.trim() : '', short: '' }; });
  steps.forEach(d => { const b = nextBtn(d); if (b && base[b.dataset.next]) base[b.dataset.next].short = [...b.childNodes].filter(n => n.nodeType === 3).map(n => n.data).join('').trim(); });
  // the shown steps are moved in front of a fixed marker after the last step (a moving neighbour would scramble the
  // order when the type changes more than once)
  const parent = steps[0].parentNode, end = document.createComment('steps');
  parent.insertBefore(end, steps[steps.length - 1].nextSibling);
  let hidden = [];
  const sel = $('caseType');

  let cur = DEF;
  try { const v = localStorage.getItem(KEY); if (TYPES[v]) cur = v; } catch (e) { /* storage blocked */ }

  function apply() {
    const T = TYPES[cur], order = stepsOf(T).filter(id => $(id)), titles = T.titles || {};
    hidden.forEach(el => { el.hidden = false; }); hidden = [];
    (T.hide || []).forEach(sel => document.querySelectorAll(sel).forEach(el => { if (!el.hidden) { el.hidden = true; hidden.push(el); } }));
    order.forEach(id => parent.insertBefore($(id), end));
    steps.forEach(d => { d.hidden = !order.includes(d.id); if (d.hidden) d.open = false; });
    const grp = {}, gs = groupsOf(T);
    gs.forEach((g, gi) => g.parts.forEach(([id, lab]) => { grp[id] = { gi, g, lab }; }));
    order.forEach((id, i) => {
      const d = $(id), G = grp[id], [title0, short0] = titles[id] || [base[id].title, base[id].short];
      // a step inside a group carries the group's number and title; its own name is the tab label
      const title = G && G.g.title ? G.g.title : title0;
      d.querySelector('summary .n').textContent = G ? G.gi + 1 : i + 1;
      const t = titleNode(d); if (t && t.data.trim() !== title) t.data = title;
      d.dataset.group = G ? G.gi : i;
      const b = nextBtn(d), nx = order[i + 1];
      if (!b) return;
      b.hidden = !nx; if (!nx) return;
      b.dataset.next = nx;
      const N = grp[nx], same = G && N && N.gi === G.gi;
      const label = same ? N.lab : N && N.g.title ? N.g.title : (titles[nx] || [])[1] || base[nx].short || base[nx].title, tn = [...b.childNodes].find(n => n.nodeType === 3);
      if (tn && tn.data.trim() !== label) tn.data = label;
    });
    if (!order.some(id => $(id).open)) $(order[0]).open = true;
    document.documentElement.dataset.case = cur;
    if (sel && sel.value !== cur) sel.value = cur;
    if (sel) sel.title = T.hint || '';
    if (St) St.emit('groups', cur);
  }

  function set(id, quiet) {
    if (!TYPES[id] || id === cur && !quiet) return;
    const was = cur;
    cur = id; try { localStorage.setItem(KEY, id); } catch (e) { /* storage blocked */ }
    apply();
    if (St && was !== cur) St.emit('caseType', cur);
    if (!quiet && St) St.emit('changed');
  }

  const options = () => { if (sel) { sel.innerHTML = Object.entries(TYPES).map(([k, T]) => `<option value="${k}">${T.label}</option>`).join(''); sel.value = cur; } };
  if (sel) sel.addEventListener('change', () => set(sel.value));
  options(); apply();
  // a type can also come from another module (a later plugin, a test)
  const add = (id, def) => { TYPES[id] = def; options(); };

  // saved with the plan; applied before the other extensions so their steps exist when they restore
  (window.PlanExt = window.PlanExt || {}).caseType = {
    label: 'Vaka tipi', pre: true,
    get: () => cur,
    // a plan on a built-in sample takes the sample's type: cases saved before 2026-10-28 could hold the jaw type over the
    // ankle sample (the switch then kept the CT), and reopened the ankle CT with "Çene rekonstrüksiyonu" selected
    set(x) {
      const src = St && St.S && St.S.source, own = src && src.type === 'sample' && src.name ? (/^ankle/.test(src.name) ? 'ankle' : 'mandible') : null;
      set(own && TYPES[own] ? own : TYPES[x] ? x : DEF, true);
    },
  };

  return { get: () => cur, set, add, types: () => Object.keys(TYPES), steps: () => stepsOf(TYPES[cur]).filter(id => $(id)), groups: () => groupsOf(TYPES[cur]).map(g => ({ title: g.title, parts: g.parts.filter(p => $(p[0])) })).filter(g => g.parts.length), def: id => TYPES[id] };
})();
