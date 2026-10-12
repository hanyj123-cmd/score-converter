/* 악보 변환기 – 화면 로직 */
(function () {
  'use strict';
  const SM = window.ScoreModel;
  const $ = (id) => document.getElementById(id);

  const LS = {
    get(k, d) { try { const v = localStorage.getItem('scoreconv.' + k); return v == null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('scoreconv.' + k, v); } catch (e) { /* 저장 불가 환경 */ } },
  };

  const PAPER = {
    letter: { w: 2159, h: 2794, css: 'letter' },
    a4: { w: 2100, h: 2970, css: 'A4' },
  };

  const state = {
    uploads: [],        // {name, mimeType, data(base64), url}
    score: null,        // 현재 악보 JSON
    undo: [],
    sel: -1,            // 선택한 음표 번호 (listEvents 기준)
    events: [],
    tk: null,
  };

  /* ───────────── Verovio 준비 ───────────── */
  const tkReady = new Promise((resolve) => {
    function init() {
      const done = () => { state.tk = new verovio.toolkit(); resolve(state.tk); };
      if (verovio.module.calledRun) done();
      else verovio.module.onRuntimeInitialized = done;
    }
    if (window.verovio) init();
    else window.addEventListener('load', init);
  });

  /* ───────────── 공통 UI ───────────── */
  let toastTimer;
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || 3200);
  }
  function busy(on, msg) {
    $('busy').hidden = !on;
    if (msg) $('busyMsg').textContent = msg;
  }
  function download(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  const safeName = (s) => (s || '악보').replace(/[\\/:*?"<>|]/g, ' ').trim() || '악보';

  /* ───────────── 백엔드 호출 ───────────── */
  async function api(action, payload) {
    const url = LS.get('url', '');
    const key = LS.get('key', '');
    if (!url) { $('settings').showModal(); throw new Error('먼저 설정에서 Apps Script 주소를 넣어 주세요.'); }
    // Content-Type 을 지정하지 않아야 (text/plain) 브라우저 사전 요청 없이 Apps Script 로 바로 갑니다.
    const res = await fetch(url, { method: 'POST', body: JSON.stringify({ action, key, ...payload }) });
    const data = await res.json().catch(() => { throw new Error('서버 응답을 읽지 못했습니다. 웹 앱 주소와 배포 권한을 확인하세요.'); });
    if (!data.ok) throw new Error(data.error || '알 수 없는 오류');
    return data;
  }

  /* ───────────── 1단계: 업로드 ───────────── */
  function fillKeySelects() {
    const keys = SM.MAJOR_KEYS.concat(SM.MINOR_KEYS);
    const label = (k) => k.endsWith('m') ? k.slice(0, -1) + ' 단조 (' + k + ')' : k + ' 장조';
    $('hintKey').insertAdjacentHTML('beforeend', keys.map((k) => '<option value="' + k + '">' + label(k) + '</option>').join(''));
  }

  async function readFile(file) {
    if (file.type === 'application/pdf') {
      const buf = await file.arrayBuffer();
      return { name: file.name, mimeType: 'application/pdf', data: bufToB64(buf), url: null };
    }
    // 사진은 긴 변 2400px JPEG 로 줄여서 보냄 (용량↓, 인식률 유지)
    const bmp = await createImageBitmap(file);
    const max = 2400;
    const r = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * r); c.height = Math.round(bmp.height * r);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', 0.9);
    return { name: file.name.replace(/\.[^.]+$/, '') + '.jpg', mimeType: 'image/jpeg', data: url.split(',')[1], url };
  }
  function bufToB64(buf) {
    let s = ''; const b = new Uint8Array(buf);
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }

  async function addFiles(files) {
    const list = Array.from(files).filter((f) => /^image\//.test(f.type) || f.type === 'application/pdf');
    if (!list.length) return;
    busy(true, '이미지를 준비하는 중…');
    try {
      for (const f of list) {
        if (state.uploads.length >= 6) { toast('한 번에 6장까지 올릴 수 있어요.'); break; }
        state.uploads.push(await readFile(f));
      }
    } catch (e) {
      toast('이미지를 읽지 못했습니다: ' + e.message);
    } finally { busy(false); }
    renderThumbs();
  }

  function renderThumbs() {
    $('thumbs').innerHTML = state.uploads.map((u, i) =>
      '<div class="thumb">' + (u.url ? '<img src="' + u.url + '" alt="">' : '<span>PDF<br>' + u.name + '</span>') +
      '<span class="order">' + (i + 1) + '</span><button class="x" data-i="' + i + '" aria-label="삭제">×</button></div>').join('');
    $('btnConvert').disabled = !state.uploads.length;
  }

  async function convert() {
    busy(true, '악보를 읽는 중… (보통 20초~1분)');
    try {
      const hints = {
        title: $('hintTitle').value.trim(),
        key: $('hintKey').value,
        time: $('hintTime').value,
        language: $('hintLang').value,
      };
      const data = await api('transcribe', {
        images: state.uploads.map((u) => ({ mimeType: u.mimeType, data: u.data })),
        hints,
      });
      const score = data.score;
      if (hints.key) score.key = hints.key;
      if (hints.time) score.time = hints.time;
      if (hints.title) score.title = hints.title;
      setScore(score, true);
      $('origPane').hidden = !state.uploads.some((u) => u.url);
      $('stepEdit').scrollIntoView({ behavior: 'smooth' });
    } catch (e) {
      toast('변환 실패: ' + e.message, 6000);
    } finally { busy(false); }
  }

  /* ───────────── 2단계: 미리보기와 수정 ───────────── */
  function setScore(score, fresh) {
    state.score = score;
    if (fresh) { state.undo = []; state.sel = -1; closeEditor(); }
    $('stepEdit').hidden = false; $('stepExport').hidden = false;
    $('fTitle').value = score.title || '';
    $('fLyricist').value = score.lyricist || '';
    $('fComposer').value = score.composer || '';
    $('fTempo').value = score.tempo || '';
    renderOrig();
    render();
  }

  function pushUndo() {
    state.undo.push(JSON.stringify(state.score));
    if (state.undo.length > 80) state.undo.shift();
    $('btnUndo').disabled = false;
  }
  function undo() {
    const prev = state.undo.pop();
    if (!prev) return;
    state.score = JSON.parse(prev);
    $('btnUndo').disabled = !state.undo.length;
    $('fTitle').value = state.score.title || '';
    $('fLyricist').value = state.score.lyricist || '';
    $('fComposer').value = state.score.composer || '';
    $('fTempo').value = state.score.tempo || '';
    render();
    if (state.sel >= 0) openEditor(Math.min(state.sel, state.events.length - 1));
  }

  function renderOrig() {
    $('origPane').innerHTML = state.uploads.filter((u) => u.url).map((u) => '<img src="' + u.url + '" alt="원본 악보">').join('');
  }

  function verovioOptions(extra) {
    return Object.assign({
      scale: +$('zoom').value,
      lyricSize: +$('lyricSize').value,
      adjustPageHeight: true,
      breaks: 'auto',
      footer: 'none',
      header: 'none',
      pageMarginLeft: 60, pageMarginRight: 60, pageMarginTop: 60, pageMarginBottom: 60,
      spacingStaff: 14,
      justifyVertically: false,
      svgViewBox: true,
      svgRemoveXlink: true,
    }, extra || {});
  }

  function headHtml(score) {
    const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    if (!score.title && !score.lyricist && !score.composer) return '';
    return '<div class="score-head">' +
      (score.title ? '<div class="sh-title">' + esc(score.title) + '</div>' : '') +
      '<div class="sh-sub"><span>' + (score.lyricist ? '작사 ' + esc(score.lyricist) : '') + '</span>' +
      '<span>' + (score.composer ? '작곡 ' + esc(score.composer) : '') + '</span></div></div>';
  }

  async function render() {
    const tk = await tkReady;
    const score = state.score;
    $('curKey').textContent = SM.parseKey(score.key).name;
    $('transKey').value = SM.parseKey(score.key).name;
    const box = $('score');
    const width = Math.max(300, box.clientWidth - 16);
    // 좁은 화면(휴대폰)에서는 한 줄에 최소한의 공간을 확보하도록 배율을 자동으로 낮춤
    const MIN_PAGE = 1500;
    const scale = Math.min(+$('zoom').value, (width * 100) / MIN_PAGE);
    tk.setOptions(verovioOptions({ scale: scale, pageWidth: Math.round((width * 100) / scale), pageHeight: 60000 }));
    let xml;
    try { xml = SM.toMusicXML(score); } catch (e) { box.innerHTML = '<p class="fine center">' + e.message + '</p>'; return; }
    tk.loadData(xml);
    let html = headHtml(score);
    for (let p = 1; p <= tk.getPageCount(); p++) html += tk.renderToSVG(p);
    box.innerHTML = html;
    state.events = SM.listEvents(score);
    box.querySelectorAll('g.note, g.rest, g.mRest').forEach((el, i) => { el.dataset.ev = i; });
    showIssues();
    highlight();
  }

  function showIssues() {
    const s = state.score;
    const issues = SM.validate(s);
    const warnings = (s.warnings || []).map((w) => ({ msg: 'Gemini: ' + w }));
    const all = issues.concat(warnings);
    const box = $('issues');
    box.hidden = !all.length;
    box.innerHTML = all.length ? '<strong>확인이 필요한 곳 ' + all.length + '개</strong><ul>' +
      all.map((it) => '<li data-mi="' + (it.mi != null ? it.mi : '') + '">' + it.msg + '</li>').join('') + '</ul>' : '';
  }

  function highlight() {
    const box = $('score');
    box.querySelectorAll('g.sel').forEach((el) => el.classList.remove('sel'));
    if (state.sel < 0) return;
    const el = box.querySelector('[data-ev="' + state.sel + '"]');
    if (el) {
      el.classList.add('sel');
      const r = el.getBoundingClientRect();
      const edTop = $('editor').hidden ? window.innerHeight : $('editor').getBoundingClientRect().top;
      if (r.top < 60 || r.bottom > edTop - 40) {
        window.scrollBy({ top: r.top - window.innerHeight * 0.22, behavior: 'smooth' });
      }
    }
  }

  function maxVerse() {
    let v = 1;
    (state.score.measures || []).forEach((m) => (m.notes || []).forEach((n) =>
      (n.lyrics || []).forEach((l, i) => { v = Math.max(v, l.verse || i + 1); })));
    return v;
  }

  function currentNote() {
    const ev = state.events[state.sel];
    return ev ? state.score.measures[ev.mi].notes[ev.ni] : null;
  }

  function openEditor(i) {
    if (i < 0 || i >= state.events.length) return;
    state.sel = i;
    const ev = state.events[i];
    const n = currentNote();
    const isRest = !SM.parsePitch(n.pitch);
    const pk = state.score.measures[0] && state.score.measures[0].pickup;
    const mLabel = pk && ev.mi === 0 ? '못갖춘마디' : (ev.mi + (pk ? 0 : 1)) + '마디';
    $('edTitle').textContent = mLabel + ' · ' + (ev.ni + 1) + '번째 음';
    $('edPitch').value = isRest ? '' : n.pitch;
    $('edPitch').disabled = isRest;
    $('edRest').checked = isRest;
    $('edDur').value = n.duration || 'quarter';
    $('edDots').value = String(n.dots | 0);
    $('edTriplet').checked = !!n.triplet;
    $('edTie').value = n.tie || '';
    $('edChord').value = n.chord || '';
    renderLyricInputs(n);
    $('editor').hidden = false;
    document.body.classList.add('editing');
    highlight();
  }

  function renderLyricInputs(n) {
    const count = Math.max(maxVerse(), state.extraVerse || 0);
    let h = '';
    for (let v = 1; v <= count; v++) {
      const ly = (n.lyrics || []).find((l, i) => (l.verse || i + 1) === v) || {};
      h += '<label>' + v + '절 가사<div class="syl-row"><input data-verse="' + v + '" value="' +
        (ly.text || '').replace(/"/g, '&quot;') + '"><select data-syl="' + v + '" title="음절 연결 (영어 가사용)">' +
        ['single', 'begin', 'middle', 'end'].map((s) => '<option value="' + s + '"' + ((ly.syllabic || 'single') === s ? ' selected' : '') + '>' +
          { single: '단독', begin: '시작-', middle: '-중간-', end: '-끝' }[s] + '</option>').join('') +
        '</select></div></label>';
    }
    $('edLyrics').innerHTML = h;
  }

  function closeEditor() {
    $('editor').hidden = true; state.sel = -1; highlight();
    document.body.classList.remove('editing');
  }

  /** 수정 패널의 값을 현재 음표에 반영 */
  function applyEditor() {
    const n = currentNote();
    if (!n) return;
    const pitchText = $('edPitch').value.trim();
    if (!$('edRest').checked) {
      try { SM.parsePitch(pitchText || 'X'); } catch (e) { toast('음높이 형식: C4, F#4, Bb3 처럼 적어 주세요.'); return; }
    }
    pushUndo();
    n.pitch = $('edRest').checked ? 'rest' : pitchText;
    n.duration = $('edDur').value;
    n.dots = +$('edDots').value || undefined;
    n.triplet = $('edTriplet').checked || undefined;
    n.tie = $('edTie').value || undefined;
    n.chord = $('edChord').value.trim() || undefined;
    const lyrics = [];
    $('edLyrics').querySelectorAll('input[data-verse]').forEach((inp) => {
      const v = +inp.dataset.verse;
      if (inp.value.trim()) {
        lyrics.push({ verse: v, text: inp.value.trim(), syllabic: $('edLyrics').querySelector('[data-syl="' + v + '"]').value });
      }
    });
    n.lyrics = lyrics.length ? lyrics : undefined;
    render();
  }

  function structural(fn) {
    pushUndo();
    fn();
    render().then(() => openEditor(Math.min(Math.max(state.sel, 0), state.events.length - 1)));
  }

  /* ───────────── 3단계: 내보내기 ───────────── */
  async function renderPrintPages() {
    const tk = await tkReady;
    const paper = PAPER[$('paper').value];
    // 인쇄 배율: 화면 '악보 크기' 슬라이더를 종이 기준으로 환산
    // 화면 슬라이더 45 ≈ 일반 악보 크기(오선 높이 약 7mm)
    const scale = Math.round(+$('zoom').value * 2.2);
    const head = headHtml(state.score);
    const headMm = head ? 26 : 0;                 // 1쪽 머리글(제목·작사·작곡) 높이
    const svgH = paper.h - headMm * 10;
    tk.setOptions(verovioOptions({
      pageWidth: Math.round((paper.w * 100) / scale),
      pageHeight: Math.round((svgH * 100) / scale),
      adjustPageHeight: false,
      pageMarginLeft: 120, pageMarginRight: 120, pageMarginTop: 110, pageMarginBottom: 110,
      footer: 'none',
    }));
    tk.loadData(SM.toMusicXML(state.score));
    let html = '';
    for (let p = 1; p <= tk.getPageCount(); p++) {
      html += '<div class="print-page" style="width:' + (paper.w / 10) + 'mm;height:' + (paper.h / 10) + 'mm">' +
        '<div class="print-head" style="height:' + headMm + 'mm">' + (p === 1 ? head : '') + '</div>' +
        '<div class="print-svg" style="height:' + (svgH / 10) + 'mm">' + tk.renderToSVG(p) + '</div></div>';
    }
    let st = document.getElementById('pageStyle');
    if (!st) { st = document.createElement('style'); st.id = 'pageStyle'; document.head.appendChild(st); }
    st.textContent = '@page { size: ' + paper.css + '; margin: 0; }';
    $('printArea').innerHTML = html;
    return tk.getPageCount();
  }

  async function exportPdf() {
    syncMeta();
    await renderPrintPages();
    const oldTitle = document.title;
    document.title = safeName(state.score.title);
    await document.fonts.ready;
    window.print();
    document.title = oldTitle;
    render(); // 화면용 레이아웃 복구
  }

  async function midiBase64() {
    const tk = await tkReady;
    tk.loadData(SM.toMusicXML(state.score));
    const b64 = tk.renderToMIDI();
    render();
    return b64;
  }

  function b64ToBlob(b64, type) {
    const bin = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type });
  }

  function syncMeta() {
    const s = state.score;
    s.title = $('fTitle').value.trim() || undefined;
    s.lyricist = $('fLyricist').value.trim() || undefined;
    s.composer = $('fComposer').value.trim() || undefined;
    s.tempo = +$('fTempo').value || undefined;
  }

  function cleanJson() {
    const s = JSON.parse(JSON.stringify(state.score));
    delete s._model;
    return JSON.stringify(s, null, 2);
  }

  async function saveDrive() {
    syncMeta();
    busy(true, '드라이브에 저장하는 중…');
    try {
      const name = safeName(state.score.title);
      const files = [
        { name: name + '.musicxml', mimeType: 'application/vnd.recordare.musicxml+xml', text: SM.toMusicXML(state.score) },
        { name: name + '.json', mimeType: 'application/json', text: cleanJson() },
        { name: name + '.mid', mimeType: 'audio/midi', base64: await midiBase64() },
      ];
      state.uploads.forEach((u, i) => files.push({ name: '원본 ' + (i + 1) + ' - ' + u.name, mimeType: u.mimeType, base64: u.data }));
      const res = await api('save', { title: state.score.title, files });
      $('driveResult').innerHTML = '저장했습니다: <a href="' + res.folderUrl + '" target="_blank" rel="noopener">드라이브 폴더 열기</a>';
    } catch (e) {
      toast('저장 실패: ' + e.message, 6000);
    } finally { busy(false); }
  }

  /* ───────────── 이벤트 연결 ───────────── */
  function bind() {
    fillKeySelects();
    $('transKey').innerHTML = SM.MAJOR_KEYS.concat(SM.MINOR_KEYS).map((k) => '<option>' + k + '</option>').join('');

    const drop = $('drop');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); });
    $('fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
    $('thumbs').addEventListener('click', (e) => {
      const b = e.target.closest('.x'); if (!b) return;
      e.preventDefault();
      state.uploads.splice(+b.dataset.i, 1); renderThumbs();
    });
    $('btnConvert').addEventListener('click', convert);

    $('btnSample').addEventListener('click', async () => {
      try {
        const r = await fetch('sample-amazing-grace.json');
        setScore(await r.json(), true);
      } catch (e) {
        setScore(JSON.parse(JSON.stringify(window.SAMPLE_SCORE)), true);
      }
      $('stepEdit').scrollIntoView({ behavior: 'smooth' });
    });
    $('btnLoadJson').addEventListener('click', () => $('jsonInput').click());
    $('jsonInput').addEventListener('change', async (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      try { setScore(JSON.parse(await f.text()), true); } catch (err) { toast('JSON 파일을 읽지 못했습니다.'); }
    });

    // 설정
    $('btnSettings').addEventListener('click', () => {
      $('setUrl').value = LS.get('url', ''); $('setKey').value = LS.get('key', ''); $('setStatus').textContent = '';
      $('settings').showModal();
    });
    $('btnSaveSettings').addEventListener('click', () => {
      LS.set('url', $('setUrl').value.trim()); LS.set('key', $('setKey').value);
      toast('저장했습니다.');
    });
    $('btnPing').addEventListener('click', async () => {
      LS.set('url', $('setUrl').value.trim()); LS.set('key', $('setKey').value);
      $('setStatus').textContent = '확인 중…';
      try { const r = await api('ping', {}); $('setStatus').textContent = '연결됨 · 모델: ' + r.model; }
      catch (e) { $('setStatus').textContent = e.message; }
    });

    // 미리보기 클릭
    $('score').addEventListener('click', (e) => {
      if (e.target.closest('.score-head')) return;
      const g = e.target.closest('[data-ev]');
      if (g) { openEditor(+g.dataset.ev); return; }
      // 음표를 정확히 못 눌렀으면(휴대폰) 가장 가까운 음표를 선택
      let best = -1, bestD = 48 * 48;
      $('score').querySelectorAll('[data-ev]').forEach((el) => {
        const r = (el.querySelector('.notehead, use') || el).getBoundingClientRect();
        const dx = (r.left + r.right) / 2 - e.clientX, dy = (r.top + r.bottom) / 2 - e.clientY;
        const d = dx * dx + dy * dy * 0.6;
        if (d < bestD) { bestD = d; best = +el.dataset.ev; }
      });
      if (best >= 0) openEditor(best);
    });
    $('issues').addEventListener('click', (e) => {
      const li = e.target.closest('li'); if (!li || li.dataset.mi === '') return;
      const idx = state.events.findIndex((ev) => ev.mi === +li.dataset.mi);
      if (idx >= 0) openEditor(idx);
    });

    // 제목 등
    ['fTitle', 'fLyricist', 'fComposer', 'fTempo'].forEach((id) => $(id).addEventListener('change', () => { pushUndo(); syncMeta(); render(); }));
    $('btnUndo').addEventListener('click', undo);
    $('btnToggleOrig').addEventListener('click', () => {
      if (!state.uploads.some((u) => u.url)) { toast('원본 이미지가 없습니다.'); return; }
      $('origPane').hidden = !$('origPane').hidden;
      render();
    });

    let rt;
    const rerender = () => { clearTimeout(rt); rt = setTimeout(() => { if (state.score) render(); }, 120); };
    $('zoom').addEventListener('input', rerender);
    $('lyricSize').addEventListener('input', rerender);
    window.addEventListener('resize', rerender);
    $('zoom').value = LS.get('zoom', '45');
    $('lyricSize').value = LS.get('lyricSize', '5');
    $('zoom').addEventListener('change', () => LS.set('zoom', $('zoom').value));
    $('lyricSize').addEventListener('change', () => LS.set('lyricSize', $('lyricSize').value));

    $('btnTranspose').addEventListener('click', () => {
      const to = $('transKey').value;
      const from = SM.parseKey(state.score.key);
      const target = SM.parseKey(to);
      if ((from.mode === 'minor') !== (target.mode === 'minor')) {
        toast('장조는 장조로, 단조는 단조로 옮길 수 있어요.'); return;
      }
      pushUndo();
      state.score = SM.transpose(state.score, to, $('transDir').value);
      render();
      toast(from.name + ' → ' + target.name + ' 로 옮겼습니다.');
    });

    // 음표 수정 패널
    ['edPitch', 'edDur', 'edDots', 'edTriplet', 'edTie', 'edChord'].forEach((id) => $(id).addEventListener('change', applyEditor));
    $('edRest').addEventListener('change', () => {
      $('edPitch').disabled = $('edRest').checked;
      if (!$('edRest').checked && !$('edPitch').value) $('edPitch').value = 'C5';
      applyEditor();
    });
    $('edLyrics').addEventListener('change', applyEditor);
    document.querySelectorAll('[data-shift]').forEach((b) => b.addEventListener('click', () => {
      const n = currentNote(); if (!n || !SM.parsePitch(n.pitch)) return;
      $('edPitch').value = SM.shiftSemitone(n.pitch, +b.dataset.shift, state.score);
      applyEditor();
    }));
    $('edPrev').addEventListener('click', () => openEditor(state.sel - 1));
    $('edNext').addEventListener('click', () => openEditor(state.sel + 1));
    $('edClose').addEventListener('click', closeEditor);
    $('edAddVerse').addEventListener('click', () => {
      state.extraVerse = maxVerse() + 1; renderLyricInputs(currentNote());
    });
    $('edInsBefore').addEventListener('click', () => structural(() => {
      const ev = state.events[state.sel];
      const n = currentNote();
      state.score.measures[ev.mi].notes.splice(ev.ni, 0, { pitch: n.pitch, duration: n.duration });
    }));
    $('edInsAfter').addEventListener('click', () => structural(() => {
      const ev = state.events[state.sel];
      const n = currentNote();
      state.score.measures[ev.mi].notes.splice(ev.ni + 1, 0, { pitch: n.pitch, duration: n.duration });
      state.sel += 1;
    }));
    $('edDelete').addEventListener('click', () => structural(() => {
      const ev = state.events[state.sel];
      const m = state.score.measures[ev.mi];
      m.notes.splice(ev.ni, 1);
      if (!m.notes.length) state.score.measures.splice(ev.mi, 1);
      if (state.sel >= state.events.length - 1) state.sel -= 1;
    }));
    $('edSplit').addEventListener('click', () => {
      const ev = state.events[state.sel];
      if (!ev || ev.ni === 0) { toast('마디의 첫 음표에서는 나눌 수 없어요.'); return; }
      structural(() => {
        const ms = state.score.measures;
        const tail = ms[ev.mi].notes.splice(ev.ni);
        ms.splice(ev.mi + 1, 0, { notes: tail, barline: ms[ev.mi].barline });
        ms[ev.mi].barline = undefined;
      });
    });
    $('edMerge').addEventListener('click', () => {
      const ev = state.events[state.sel];
      if (!ev || ev.mi === 0) { toast('첫 마디는 합칠 앞 마디가 없어요.'); return; }
      structural(() => {
        const ms = state.score.measures;
        const prev = ms[ev.mi - 1];
        prev.notes = prev.notes.concat(ms[ev.mi].notes);
        prev.barline = ms[ev.mi].barline;
        ms.splice(ev.mi, 1);
      });
    });

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !/INPUT|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); undo(); return; }
      if ($('editor').hidden || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); openEditor(state.sel + 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); openEditor(state.sel - 1); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const n = currentNote(); if (!n || !SM.parsePitch(n.pitch)) return;
        $('edPitch').value = SM.shiftSemitone(n.pitch, e.key === 'ArrowUp' ? 1 : -1, state.score);
        applyEditor();
      } else if (e.key === 'Escape') closeEditor();
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); $('edDelete').click(); }
    });

    // 내보내기
    $('btnPdf').addEventListener('click', exportPdf);
    $('btnXml').addEventListener('click', () => {
      syncMeta();
      download(safeName(state.score.title) + '.musicxml', new Blob([SM.toMusicXML(state.score)], { type: 'application/vnd.recordare.musicxml+xml' }));
    });
    $('btnJson').addEventListener('click', () => {
      syncMeta();
      download(safeName(state.score.title) + '.json', new Blob([cleanJson()], { type: 'application/json' }));
    });
    $('btnMidi').addEventListener('click', async () => {
      syncMeta();
      download(safeName(state.score.title) + '.mid', b64ToBlob(await midiBase64(), 'audio/midi'));
    });
    $('btnDrive').addEventListener('click', saveDrive);
    $('paper').value = LS.get('paper', 'letter');
    $('paper').addEventListener('change', () => LS.set('paper', $('paper').value));
  }

  // 다른 앱(콘티 앱 등)에서 쓸 수 있도록 공개
  window.ScoreConverter = {
    load(score) { setScore(score, true); },
    get score() { return state.score; },
    toMusicXML() { return SM.toMusicXML(state.score); },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
