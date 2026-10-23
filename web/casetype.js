/* Case types. A case type decides which workflow steps the left panel shows, in what order they are numbered,
   what each step and its "next" button are called, and which parts of a step are hidden. Only mandibular
   reconstruction with a fibula graft exists today; a new type is one more entry in TYPES:

     maxilla: { label: 'Maksilla rekonstrüksiyonu', hint: '…',
                steps: ['st1', 'st2', 'st3', 'st5', 'st6', 'st7', 'st8'],          // shown, in this order
                titles: { st3: ['Rezeksiyon', 'Rezeksiyon'] },                     // [step title, next-button label]
                hide: ['#fibUpload'] }                                             // selectors hidden for this type

   Steps left out are hidden, the rest are renumbered, and every "next" button points at the following shown
   step. The type is saved with the plan (PlanExt.caseType) and remembered as the default for new cases. A change of type
   is announced on the studio bus ('caseType'). */
'use strict';
window.CaseType = (function () {
  const St = window.Studio, $ = id => document.getElementById(id);
  const KEY = 'gs.caseType', DEF = 'mandible';
  const TYPES = {
    mandible: {
      label: 'Çene rekonstrüksiyonu',
      hint: 'Mandibula rezeksiyonu, fibula grefti ile rekonstrüksiyon, kesi ve fibula guide\'ları.',
      steps: ['st1', 'st2', 'st3', 'st4', 'st5', 'st6', 'st7', 'st8'],
      hide: ['#sampleA', '#sampleAct', '#hAnk', '#ankAppr'],
    },
    // malleolar fracture (ankle.js): the pieces of the fracture are reduced by hand, the reduced model is the output
    ankle: {
      label: 'Malleol kırığı',
      hint: 'Ayak bileği kırığı: parçaları ayırma, sanal redüksiyon, ölçümler, redükte model STL\'i, kesi guide\'ı ve kama.',
      steps: ['st1', 'st2', 'stRed', 'stAnkG', 'st7', 'stAnkOut'],
      titles: { st2: ['Anatomi ve parçalar', 'Anatomi'] },
      hide: ['#upFib', '#sampleM', '#sampleMct', '#sampleL', '#hMand', '#itemAppr', '#segModeBox', '#refBox'],
    },
  };

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
    const T = TYPES[cur], order = T.steps.filter(id => $(id)), titles = T.titles || {};
    hidden.forEach(el => { el.hidden = false; }); hidden = [];
    (T.hide || []).forEach(sel => document.querySelectorAll(sel).forEach(el => { if (!el.hidden) { el.hidden = true; hidden.push(el); } }));
    order.forEach(id => parent.insertBefore($(id), end));
    steps.forEach(d => { d.hidden = !order.includes(d.id); if (d.hidden) d.open = false; });
    order.forEach((id, i) => {
      const d = $(id), [title, short] = titles[id] || [base[id].title, base[id].short];
      d.querySelector('summary .n').textContent = i + 1;
      const t = titleNode(d); if (t && t.data.trim() !== title) t.data = title;
      const b = nextBtn(d), nx = order[i + 1];
      if (!b) return;
      b.hidden = !nx; if (!nx) return;
      b.dataset.next = nx;
      const label = (titles[nx] || [])[1] || base[nx].short || base[nx].title, tn = [...b.childNodes].find(n => n.nodeType === 3);
      if (tn && tn.data.trim() !== label) tn.data = label;
    });
    if (!order.some(id => $(id).open)) $(order[0]).open = true;
    document.documentElement.dataset.case = cur;
    if (sel && sel.value !== cur) sel.value = cur;
    if (sel) sel.title = T.hint || '';
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
    set(x) { set(TYPES[x] ? x : DEF, true); },
  };

  return { get: () => cur, set, add, types: () => Object.keys(TYPES), steps: () => TYPES[cur].steps.filter(id => $(id)), def: id => TYPES[id] };
})();
