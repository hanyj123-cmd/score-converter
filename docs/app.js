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
    uploads: [],        // 페이지: {name, page:{url,data,mimeType}, systems:[{url,data,mimeType}]}
    layout: 'auto',     // 줄 나누기: 'original' | 'auto' | '2'…'6'
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

  async function addFiles(files) {
    const list = Array.from(files).filter((f) => /^image\//.test(f.type) || f.type === 'application/pdf');
    if (!list.length) return;
    busy(true, '악보를 준비하는 중…');
    try {
      for (const f of list) {
        const room = 6 - state.uploads.length;
        if (room <= 0) { toast('한 번에 6쪽까지 올릴 수 있어요.'); break; }
        const pages = await window.StaffSplit.processFile(f, room);
        pages.forEach((p) => state.uploads.push(p));
      }
    } catch (e) {
      toast('파일을 읽지 못했습니다: ' + e.message, 6000);
    } finally { busy(false); }
    renderThumbs();
  }

  function renderThumbs() {
    $('thumbs').innerHTML = state.uploads.map((u, i) =>
      '<div class="thumb"><img src="' + u.page.url + '" alt="">' +
      '<span class="order">' + (i + 1) + '</span>' +
      '<span class="lines' + (u.systems.length ? '' : ' warn') + '">' + (u.systems.length ? u.systems.length + '줄' : '줄 못 찾음') + '</span>' +
      '<button class="x" data-i="' + i + '" aria-label="삭제">×</button></div>').join('');
    $('btnConvert').disabled = !state.uploads.length;
  }

  /** 동시에 n개씩 실행, 실패하면 잠시 쉬었다가 다시 (최대 3번) */
  async function runPool(jobs, n, worker, onDone) {
    const results = new Array(jobs.length);
    let next = 0, done = 0;
    async function lane() {
      while (next < jobs.length) {
        const i = next++;
        for (let attempt = 0; ; attempt++) {
          try { results[i] = { ok: true, value: await worker(jobs[i]) }; break; }
          catch (e) {
            if (attempt >= 2) { results[i] = { ok: false, error: e.message }; break; }
            const wait = /429|RESOURCE_EXHAUSTED|quota/i.test(e.message) ? 12000 : 3000;
            await new Promise((r) => setTimeout(r, wait * (attempt + 1)));
          }
        }
        done++; if (onDone) onDone(done, jobs.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, lane));
    return results;
  }

  function lineJobs(pages) {
    const jobs = [];
    let line = 1;
    pages.forEach((p) => {
      if (p.systems.length) {
        p.systems.forEach((sys) => {
          jobs.push({ lines: [{ line, mimeType: sys.mimeType, data: sys.data }] });
          line++;
        });
      } else {
        // 줄을 못 찾은 페이지(비뚤어진 사진 등)는 페이지 통째로
        jobs.push({ whole: true, lines: [{ line, mimeType: p.page.mimeType, data: p.page.data }] });
        line += 100; // 이 페이지 안 줄 번호는 Gemini 가 매김
      }
    });
    return jobs;
  }

  async function convert() {
    const hints = {
      title: $('hintTitle').value.trim(),
      key: $('hintKey').value,
      time: $('hintTime').value,
      language: $('hintLang').value,
      speed: $('hintSpeed').value,
    };
    LS.set('speed', hints.speed);
    const started = Date.now();
    const pages = state.uploads;
    const jobs = lineJobs(pages);
    const lineCount = pages.reduce((a, p) => a + p.systems.length, 0);
    busy(true, '악보를 읽는 중… 0/' + jobs.length + '줄');
    try {
      // 곡 정보와 모든 줄을 한꺼번에 요청 (음높이는 오선 위치로 받으므로 조를 먼저 알 필요 없음)
      const lineHints = { key: hints.key, time: hints.time, language: hints.language, speed: hints.speed };
      const metaP = runPool([0], 1, async () => (await api('meta', { pages: pages.map((p) => p.page), lineCount, hints })).meta);
      const linesP = runPool(jobs, Math.min(jobs.length, 10), async (job) =>
        (await api('lines', Object.assign({ hints: lineHints }, job))).result,
        (d, t) => busy(true, '악보를 읽는 중… ' + d + '/' + t + '줄'));
      const [metaR, results] = await Promise.all([metaP, linesP]);
      if (!metaR[0].ok) throw new Error(metaR[0].error);
      const meta = metaR[0].value;
      const key = hints.key || meta.key;
      const time = hints.time || meta.time;

      const measures = [];
      const warnings = [];
      results.forEach((r, i) => {
        const first = jobs[i].lines[0].line;
        if (r.ok) {
          (r.value.measures || []).forEach((m) => { if (m.line == null) m.line = first; measures.push(m); });
          (r.value.warnings || []).forEach((w) => warnings.push(w));
        } else {
          measures.push({ line: first, failed: true, notes: [{ rest: true, duration: 'whole' }] });
          warnings.push('줄 ' + first + '을(를) 읽지 못했습니다 (' + r.error + '). 그 줄의 음표를 눌러 "이 줄 다시 읽기"를 해 보세요.');
        }
      });
      const score = {
        title: hints.title || meta.title, composer: meta.composer, lyricist: meta.lyricist,
        key, time, tempo: meta.tempo, clef: meta.clef || 'treble',
        measures, warnings,
      };
      if (meta.pickup && measures[0]) measures[0].pickup = true;
      (meta.sections || []).forEach((sec) => {
        const m = measures.find((x) => x.line === sec.line);
        if (m && !m.section) m.section = sec.label;
      });
      SM.resolvePositions(score);
      score._model = meta._model;
      state.layout = SM.hasLineInfo(score) ? 'original' : 'auto';
      setScore(score, true);
      $('origPane').hidden = false;
      $('stepEdit').scrollIntoView({ behavior: 'smooth' });
      const failed = results.filter((r) => !r.ok).length;
      const secs = Math.round((Date.now() - started) / 1000);
      toast(failed ? failed + '줄을 읽지 못했습니다. 노란 상자를 확인하세요. (' + secs + '초)' : secs + '초 걸렸습니다.', 6000);
    } catch (e) {
      toast('변환 실패: ' + e.message, 7000);
    } finally { busy(false); }
  }

  /** 선택한 음표가 있는 줄만 Gemini 로 다시 읽기 */
  async function rereadLine() {
    const ev = state.events[state.sel];
    if (!ev) return;
    const line = state.score.measures[ev.mi].line;
    const jobs = lineJobs(state.uploads);
    const job = jobs.find((j) => !j.whole && j.lines[0].line === line);
    if (!job) { toast('원본 이미지가 있어야 다시 읽을 수 있어요. (이 화면에서 변환한 악보만 가능)'); return; }
    busy(true, line + '번째 줄을 다시 읽는 중…');
    try {
      const s = state.score;
      const r = (await api('lines', Object.assign({ hints: { key: s.key, time: s.time, speed: $('hintSpeed').value } }, job))).result;
      const fresh = { key: s.key, clef: s.clef, measures: (r.measures || []).map((m) => Object.assign(m, { line })) };
      SM.resolvePositions(fresh);
      pushUndo();
      const ms = s.measures;
      const firstIdx = ms.findIndex((m) => m.line === line);
      const count = ms.filter((m) => m.line === line).length;
      const old = ms[firstIdx];
      if (old.section && fresh.measures[0]) fresh.measures[0].section = old.section;
      if (old.pickup && fresh.measures[0]) fresh.measures[0].pickup = true;
      ms.splice(firstIdx, count, ...fresh.measures);
      s.warnings = (s.warnings || []).filter((w) => !new RegExp('줄 ' + line + '\\b').test(w)).concat(r.warnings || []);
      state.sel = state.events.findIndex((e2) => e2.mi === firstIdx);
      await render();
      openEditor(Math.max(0, state.events.findIndex((e2) => e2.mi === firstIdx)));
      toast(line + '번째 줄을 다시 읽었습니다.');
    } catch (e) {
      toast('다시 읽기 실패: ' + e.message, 6000);
    } finally { busy(false); }
  }

  /* ───────────── 2단계: 미리보기와 수정 ───────────── */
  function setScore(score, fresh) {
    state.score = score;
    if (fresh) state.layout = score.layout || (SM.hasLineInfo(score) ? 'original' : 'auto');
    delete score.layout;
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
    $('origPane').innerHTML = state.uploads.map((u) => '<img src="' + u.page.url + '" alt="원본 악보">').join('');
  }

  function verovioOptions(extra) {
    return Object.assign({
      scale: +$('zoom').value,
      // 한글은 라틴 대문자보다 키가 커서 음표에 닿기 쉬움 → 자리는 크게 잡고 82% 크기로 그림 (style.css)
      lyricSize: +$('lyricSize').value / 0.82,
      lyricTopMinMargin: 3,
      spacingStaff: 12,
      spacingSystem: 12 + +$('lyricGap').value * 1.2,   // 가사를 내린 만큼 줄 사이도 넓힘
      adjustPageHeight: true,
      breaks: 'auto',
      footer: 'none',
      header: 'none',
      pageMarginLeft: 60, pageMarginRight: 60, pageMarginTop: 60, pageMarginBottom: 60,
      justifyVertically: false,
      svgViewBox: true,
      svgRemoveXlink: true,
    }, extra || {});
  }

  function verovioBreaks() { return state.layout === 'auto' ? 'auto' : 'line'; }

  function syncLayoutSelect() {
    const sel = $('layout');
    const hasLines = SM.hasLineInfo(state.score);
    sel.querySelector('option[value="original"]').disabled = !hasLines;
    if (state.layout === 'original' && !hasLines) state.layout = 'auto';
    sel.value = state.layout;
  }

  /** 이 마디에서 줄 바꾸기 / 앞 줄에 붙이기 (현재 보이는 줄 나누기를 기준으로) */
  function toggleLineBreak(mi) {
    if (mi <= 0) { toast('첫 마디는 항상 첫 줄에 있어요.'); return; }
    pushUndo();
    const ms = state.score.measures;
    const cur = SM.systemBreaks(ms, state.layout === 'auto' ? 'auto' : state.layout);
    if (state.layout === 'auto') {
      // 자동 배치는 위치를 알 수 없으므로, 화면에 그려진 줄을 읽어 옴
      const sys = Array.from($('score').querySelectorAll('g.system'));
      const firstIds = sys.map((g) => { const m = g.querySelector('g.measure'); return m && m.id; });
      const ids = Array.from($('score').querySelectorAll('g.measure')).map((g) => g.id);
      ids.forEach((id, i) => { cur[i] = i > 0 && firstIds.includes(id); });
    }
    ms.forEach((m, i) => { if (i > 0) m.brk = cur[i]; });
    ms[mi].brk = !cur[mi];
    state.layout = 'original';
    render().then(() => openEditor(state.sel));
  }

  function headHtml(score) {
    const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    if (!score.title && !score.lyricist && !score.composer) return '';
    return '<div class="score-head">' +
      (score.title ? '<div class="sh-title">' + esc(score.title) + '</div>' : '') +
      '<div class="sh-sub"><span>' + (score.lyricist ? '작사 ' + esc(score.lyricist) : '') + '</span>' +
      '<span>' + (score.composer ? '작곡 ' + esc(score.composer) : '') + '</span></div></div>';
  }

  /** 가사 간격 슬라이더 → 가사를 아래로 내리는 양 (style.css 의 --lyric-drop) */
  function applyLyricGap() {
    document.documentElement.style.setProperty('--lyric-drop', Math.round(+$('lyricGap').value * 25) + 'px');
  }

  async function render() {
    const tk = await tkReady;
    applyLyricGap();
    const score = state.score;
    $('curKey').textContent = SM.parseKey(score.key).name;
    $('transKey').value = SM.parseKey(score.key).name;
    const box = $('score');
    const width = Math.max(300, box.clientWidth - 16);
    // 좁은 화면(휴대폰)에서는 한 줄에 최소한의 공간을 확보하도록 배율을 자동으로 낮춤
    const MIN_PAGE = 1500;
    const scale = Math.min(+$('zoom').value, (width * 100) / MIN_PAGE);
    tk.setOptions(verovioOptions({ scale: scale, pageWidth: Math.round((width * 100) / scale), pageHeight: 60000, breaks: verovioBreaks() }));
    syncLayoutSelect();
    let xml;
    try { xml = SM.toMusicXML(score, { breaks: state.layout }); } catch (e) { box.innerHTML = '<p class="fine center">' + e.message + '</p>'; return; }
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
    const brks = SM.systemBreaks(state.score.measures, state.layout === 'auto' ? 'none' : state.layout);
    $('edLineBreak').textContent = brks[ev.mi] ? '이 마디를 앞 줄에 붙이기' : '이 마디부터 새 줄';
    $('edReread').hidden = !state.uploads.length || state.score.measures[ev.mi].line == null;
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
    const head = headHtml(state.score);
    const headMm = head ? 26 : 0;                 // 1쪽 머리글(제목·작사·작곡) 높이
    const svgH = paper.h - headMm * 10;
    const xml = SM.toMusicXML(state.score, { breaks: state.layout });
    // 인쇄 배율: 화면 '악보 크기' 슬라이더 45 ≈ 일반 악보 크기(오선 높이 약 7mm)
    let scale = Math.round(+$('zoom').value * 2.2);
    const layout = (sc) => {
      tk.setOptions(verovioOptions({
        scale: sc,
        pageWidth: Math.round((paper.w * 100) / sc),
        pageHeight: Math.round((svgH * 100) / sc),
        adjustPageHeight: false,
        breaks: verovioBreaks(),
        pageMarginLeft: 120, pageMarginRight: 120, pageMarginTop: 110, pageMarginBottom: 110,
        footer: 'none',
      }));
      tk.loadData(xml);
      return tk.getPageCount();
    };
    let pages = layout(scale);
    // 한 장에 맞추기: 넘치면 조금씩 줄여서 다시 배치
    if ($('fitOne').checked) {
      while (pages > 1 && scale > 45) { scale = Math.round(scale * 0.92); pages = layout(scale); }
    }
    let html = '';
    for (let p = 1; p <= pages; p++) {
      html += '<div class="print-page" style="width:' + (paper.w / 10) + 'mm;height:' + (paper.h / 10) + 'mm">' +
        '<div class="print-head" style="height:' + headMm + 'mm">' + (p === 1 ? head : '') + '</div>' +
        '<div class="print-svg" style="height:' + (svgH / 10) + 'mm">' + tk.renderToSVG(p) + '</div></div>';
    }
    let st = document.getElementById('pageStyle');
    if (!st) { st = document.createElement('style'); st.id = 'pageStyle'; document.head.appendChild(st); }
    st.textContent = '@page { size: ' + paper.css + '; margin: 0; }';
    $('printArea').innerHTML = html;
    if ($('fitOne').checked && pages > 1) toast('한 장에 다 들어가지 않아 ' + pages + '장이 됩니다.');
    return pages;
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
    s.layout = state.layout;
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
      state.uploads.forEach((u, i) => files.push({ name: '원본 ' + (i + 1) + ' - ' + u.name + '.jpg', mimeType: u.page.mimeType, base64: u.page.data }));
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
    $('hintSpeed').value = LS.get('speed', 'fast');

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
      if (!state.uploads.length) { toast('원본 이미지가 없습니다.'); return; }
      $('origPane').hidden = !$('origPane').hidden;
      render();
    });

    let rt;
    const rerender = () => { clearTimeout(rt); rt = setTimeout(() => { if (state.score) render(); }, 120); };
    $('zoom').addEventListener('input', rerender);
    $('lyricSize').addEventListener('input', rerender);
    $('lyricGap').addEventListener('input', rerender);
    $('lyricGap').value = LS.get('lyricGap', '4');
    $('lyricGap').addEventListener('change', () => LS.set('lyricGap', $('lyricGap').value));
    window.addEventListener('resize', rerender);
    $('zoom').value = LS.get('zoom', '45');
    $('lyricSize').value = LS.get('lyricSize', '5');
    $('zoom').addEventListener('change', () => LS.set('zoom', $('zoom').value));
    $('lyricSize').addEventListener('change', () => LS.set('lyricSize', $('lyricSize').value));

    $('layout').addEventListener('change', () => {
      state.layout = $('layout').value;
      if (state.layout !== 'original') state.score.measures.forEach((m) => { delete m.brk; });
      render();
    });
    $('fitOne').checked = LS.get('fitOne', '1') === '1';
    $('fitOne').addEventListener('change', () => LS.set('fitOne', $('fitOne').checked ? '1' : '0'));
    $('edLineBreak').addEventListener('click', () => { const ev = state.events[state.sel]; if (ev) toggleLineBreak(ev.mi); });
    $('edReread').addEventListener('click', rereadLine);

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
        ms.splice(ev.mi + 1, 0, { notes: tail, barline: ms[ev.mi].barline, line: ms[ev.mi].line, ending: ms[ev.mi].ending });
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
