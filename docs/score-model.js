/*
 * score-model.js
 * 악보 JSON (Gemini가 돌려주는 형식) ↔ MusicXML 변환기.
 * 브라우저(window.ScoreModel)와 Node(module.exports) 양쪽에서 동작합니다.
 *
 * ── 악보 JSON 형식 ─────────────────────────────────────────
 * {
 *   "title": "곡 제목",
 *   "composer": "작곡", "lyricist": "작사",
 *   "key": "G",               // 장조: C, G, D, A, E, B, F#, C#, F, Bb, Eb, Ab, Db, Gb, Cb
 *                             // 단조: Am, Em, Bm, F#m, C#m, G#m, D#m, Dm, Gm, Cm, Fm, Bbm, Ebm
 *   "time": "4/4",
 *   "tempo": 72,              // 선택
 *   "clef": "treble",         // treble | bass
 *   "measures": [
 *     {
 *       "pickup": false,      // 못갖춘마디(첫 마디)면 true
 *       "notes": [
 *         {
 *           "pitch": "G4",    // 음이름+옥타브(C4 = 가운데 도). 쉼표는 "rest"
 *                             // 또는 pitch 대신 오선 위치로: "pos": 0 (맨 아래 줄), "acc": "#" (보이는 임시표)
 *                             //   → resolvePositions() 가 조표를 반영해 pitch 를 계산
 *           "duration": "quarter",  // whole | half | quarter | eighth | 16th | 32nd
 *           "dots": 0,        // 점 개수
 *           "triplet": false, // 셋잇단음표
 *           "tie": null,      // "start" | "stop" | "both" | null
 *           "chord": "G",     // 이 음 위에 붙는 코드 기호(선택). 예: "Em7", "D/F#"
 *           "lyrics": [       // 절별 가사(선택). 빈 칸이면 생략
 *             { "verse": 1, "text": "주", "syllabic": "single" }
 *           ]
 *         }
 *       ],
 *       "barline": null,      // "final" | "double" | "repeat-start" | "repeat-end" | null
 *       "repeatStart": false, "repeatEnd": false,  // 도돌이표 (barline 대신 써도 됨)
 *       "ending": "1",        // 1·2번 괄호 안의 마디면 괄호 번호
 *       "section": "V",       // 마디 위 구간 표시 (V, PC, C, Bridge …)
 *       "line": 1,            // 원본 악보에서 몇 번째 줄(단)에 있는지
 *       "brk": true           // (선택) 사용자가 직접 정한 줄 바꿈: true=여기서 새 줄, false=앞 줄에 붙임
 *     }
 *   ]
 * }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScoreModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DIVISIONS = 24; // 4분음표 하나 = 24 (셋잇단, 32분음표까지 정수로 표현)

  const DURATION_QUARTERS = {
    whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125,
  };
  const DURATION_ALIASES = {
    w: 'whole', h: 'half', q: 'quarter', e: 'eighth', '8th': 'eighth',
    sixteenth: '16th', s: '16th', thirtysecond: '32nd',
  };

  const MAJOR_FIFTHS = {
    Cb: -7, Gb: -6, Db: -5, Ab: -4, Eb: -3, Bb: -2, F: -1, C: 0,
    G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7,
  };
  const MINOR_FIFTHS = {
    Abm: -7, Ebm: -6, Bbm: -5, Fm: -4, Cm: -3, Gm: -2, Dm: -1, Am: 0,
    Em: 1, Bm: 2, 'F#m': 3, 'C#m': 4, 'G#m': 5, 'D#m': 6, 'A#m': 7,
  };
  const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function normalizeKey(k) {
    if (!k) return 'C';
    let s = String(k).trim()
      .replace(/♯/g, '#').replace(/♭/g, 'b')
      .replace(/\s*(major|maj|장조)$/i, '')
      .replace(/\s*(minor|min|단조)$/i, 'm');
    s = s.charAt(0).toUpperCase() + s.slice(1);
    return s;
  }

  function parseKey(k) {
    const s = normalizeKey(k);
    if (s in MINOR_FIFTHS) return { fifths: MINOR_FIFTHS[s], mode: 'minor', name: s };
    if (s in MAJOR_FIFTHS) return { fifths: MAJOR_FIFTHS[s], mode: 'major', name: s };
    return { fifths: 0, mode: 'major', name: 'C' };
  }

  function keyAlters(fifths) {
    const m = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
    if (fifths > 0) SHARP_ORDER.slice(0, fifths).forEach((s) => { m[s] = 1; });
    if (fifths < 0) FLAT_ORDER.slice(0, -fifths).forEach((s) => { m[s] = -1; });
    return m;
  }

  function parseTime(t) {
    const m = String(t || '4/4').match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
    if (!m) return { beats: 4, beatType: 4 };
    return { beats: +m[1], beatType: +m[2] };
  }

  /** "F#4", "Bb3", "C♯5", "E4" → {step, alter, octave} ; "rest" → null */
  function parsePitch(p) {
    if (p == null) return null;
    const s = String(p).trim().replace(/♯/g, '#').replace(/♭/g, 'b').replace(/♮/g, '');
    if (!s || /^(r|rest|쉼표)$/i.test(s)) return null;
    const m = s.match(/^([A-Ga-g])(##|#|bb|b|x)?(-?\d)$/);
    if (!m) throw new Error('알 수 없는 음높이: ' + p);
    const acc = m[2] || '';
    const alter = { '': 0, '#': 1, '##': 2, x: 2, b: -1, bb: -2 }[acc];
    return { step: m[1].toUpperCase(), alter, octave: +m[3] };
  }

  function pitchToString(pt) {
    if (!pt) return 'rest';
    const acc = { 0: '', 1: '#', 2: '##', '-1': 'b', '-2': 'bb' }[pt.alter];
    return pt.step + acc + pt.octave;
  }

  function normDuration(d) {
    const s = String(d || 'quarter').trim().toLowerCase();
    if (s in DURATION_QUARTERS) return s;
    if (s in DURATION_ALIASES) return DURATION_ALIASES[s];
    throw new Error('알 수 없는 음길이: ' + d);
  }

  function noteDivisions(n) {
    const type = normDuration(n.duration);
    const dots = n.dots | 0;
    let q = DURATION_QUARTERS[type] * (2 - Math.pow(0.5, dots));
    if (n.triplet) q = (q * 2) / 3;
    return Math.round(q * DIVISIONS);
  }

  /** 코드 기호 "C#m7/G#" → MusicXML <harmony> */
  /** "Esus4 E7" 처럼 한 음표 위 여러 코드 → 음길이를 나눠 차례로 배치 */
  function chordsXml(sym, dur) {
    const parts = String(sym).trim().split(/\s+/).filter(Boolean);
    return parts.map((p, i) => harmonyXml(p, i ? Math.round((dur * i) / parts.length) : 0)).join('');
  }

  function harmonyXml(sym, offset) {
    const s = String(sym).trim().replace(/♯/g, '#').replace(/♭/g, 'b');
    const m = s.match(/^([A-G])(#|b)?([^/]*)(?:\/([A-G])(#|b)?)?$/);
    if (!m) {
      // 해석이 안 되면 글자 그대로 표시
      return '<direction placement="above"><direction-type><words>' + esc(s) +
        '</words></direction-type>' + (offset ? '<offset>' + offset + '</offset>' : '') + '</direction>';
    }
    const alt = (a) => (a === '#' ? 1 : a === 'b' ? -1 : 0);
    let x = '<harmony><root><root-step>' + m[1] + '</root-step>';
    if (m[2]) x += '<root-alter>' + alt(m[2]) + '</root-alter>';
    x += '</root>';
    const suffix = m[3] || '';
    x += suffix ? '<kind text="' + esc(suffix) + '">other</kind>' : '<kind text="">major</kind>';
    if (m[4]) {
      x += '<bass><bass-step>' + m[4] + '</bass-step>';
      if (m[5]) x += '<bass-alter>' + alt(m[5]) + '</bass-alter>';
      x += '</bass>';
    }
    if (offset) x += '<offset>' + offset + '</offset>';
    return x + '</harmony>';
  }

  const ACC_NAME = { '-2': 'flat-flat', '-1': 'flat', 0: 'natural', 1: 'sharp', 2: 'double-sharp' };

  function leftBarlineXml(repeatStart, ending) {
    if (!repeatStart && !ending) return '';
    return '<barline location="left">' + (repeatStart ? '<bar-style>heavy-light</bar-style>' : '') +
      (ending ? '<ending number="' + esc(ending) + '" type="start">' + esc(ending) + '.</ending>' : '') +
      (repeatStart ? '<repeat direction="forward"/>' : '') + '</barline>';
  }

  function rightBarlineXml(style, repeatEnd, endingStop) {
    if (!style && !repeatEnd && !endingStop) return '';
    const bs = repeatEnd || style === 'final' ? 'light-heavy' : style === 'double' ? 'light-light' : '';
    return '<barline location="right">' + (bs ? '<bar-style>' + bs + '</bar-style>' : '') +
      (endingStop ? '<ending number="' + esc(endingStop.number) + '" type="' + endingStop.type + '"/>' : '') +
      (repeatEnd ? '<repeat direction="backward"/>' : '') + '</barline>';
  }

  /** 줄 나누기 위치 계산. breaks: 'original'(원본 줄) | 'auto' | 숫자(한 줄 마디 수) */
  function systemBreaks(measures, breaks) {
    const out = measures.map(() => false);
    if (breaks === 'original') {
      for (let i = 1; i < measures.length; i++) {
        const m = measures[i];
        if (m.brk != null) { out[i] = !!m.brk; continue; } // 사용자가 직접 정한 줄 바꿈
        const a = measures[i - 1].line, b = m.line;
        if (a != null && b != null && b !== a) out[i] = true;
      }
    } else if (+breaks > 0) {
      const n = +breaks;
      const first = measures[0] && measures[0].pickup ? 1 : 0; // 못갖춘마디는 첫 줄에 붙임
      for (let i = first + 1; i < measures.length; i++) if ((i - first) % n === 0) out[i] = true;
    }
    return out;
  }

  function hasLineInfo(score) {
    const ms = score.measures || [];
    if (ms.some((m) => m.brk != null)) return true;
    return ms.length > 1 && ms.every((m) => m.line != null) && ms[ms.length - 1].line !== ms[0].line;
  }

  const BEAM_LEVEL = { eighth: 1, '16th': 2, '32nd': 3 };

  /**
   * 박자 단위로 8분·16분음표를 묶어 들보(beam) 정보를 계산.
   * 4/4·3/4·2/4 는 4분음표 한 박, 6/8·9/8·12/8 은 점4분음표, 2/2 는 2분음표 단위.
   * @returns 음표마다 [{number, value}] 배열
   */
  function computeBeams(notes, time) {
    const compound = time.beatType === 8 && time.beats % 3 === 0 && time.beats > 3;
    const beatLen = compound ? DIVISIONS * 1.5 : time.beatType === 2 ? DIVISIONS * 2 : DIVISIONS * (4 / time.beatType);
    const out = notes.map(() => []);
    const info = [];
    let t = 0;
    notes.forEach((n) => {
      const dur = noteDivisions(n);
      const lvl = parsePitch(n.pitch) ? (BEAM_LEVEL[normDuration(n.duration)] || 0) : 0;
      const g = Math.floor(t / beatLen + 1e-9);
      const fits = t + dur <= (g + 1) * beatLen + 1e-9;
      info.push({ lvl: fits ? lvl : 0, g, dots: n.dots | 0 });
      t += dur;
    });
    // 같은 박 안에서 연달아 나오는 들보 음표 묶음
    let i = 0;
    while (i < info.length) {
      if (!info[i].lvl) { i++; continue; }
      let j = i;
      while (j + 1 < info.length && info[j + 1].lvl && info[j + 1].g === info[i].g) j++;
      if (j > i) {
        for (let k = i; k <= j; k++) out[k].push({ number: 1, value: k === i ? 'begin' : k === j ? 'end' : 'continue' });
        for (let L = 2; L <= 3; L++) {
          let k = i;
          while (k <= j) {
            if (info[k].lvl < L) { k++; continue; }
            let e = k;
            while (e + 1 <= j && info[e + 1].lvl >= L) e++;
            if (e > k) {
              for (let m = k; m <= e; m++) out[m].push({ number: L, value: m === k ? 'begin' : m === e ? 'end' : 'continue' });
            } else {
              // 혼자인 16분음표: 점음표 옆이면 그쪽으로 짧은 갈고리
              const back = k > i && (k === j || info[k - 1].dots);
              out[k].push({ number: L, value: back ? 'backward hook' : 'forward hook' });
            }
            k = e + 1;
          }
        }
      }
      i = j + 1;
    }
    return out;
  }

  /** 악보 JSON → MusicXML 문자열 */
  function toMusicXML(score, opts) {
    opts = opts || {};
    const key = parseKey(score.key);
    const time = parseTime(score.time);
    const clef = score.clef === 'bass' ? { sign: 'F', line: 4 } : { sign: 'G', line: 2 };
    const kAlt = keyAlters(key.fifths);
    const measures = score.measures || [];

    let x = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n' +
      '<score-partwise version="4.0">\n';
    if (score.title) x += '<work><work-title>' + esc(score.title) + '</work-title></work>\n';
    x += '<identification>';
    if (score.composer) x += '<creator type="composer">' + esc(score.composer) + '</creator>';
    if (score.lyricist) x += '<creator type="lyricist">' + esc(score.lyricist) + '</creator>';
    x += '<encoding><software>score-converter</software></encoding></identification>\n';
    // 제목·작사·작곡 표시 (MuseScore 등에서 열 때 사용)
    x += '<defaults><page-layout><page-height>1584</page-height><page-width>1224</page-width></page-layout></defaults>\n';
    if (score.title) {
      x += '<credit page="1"><credit-type>title</credit-type><credit-words default-x="612" default-y="1500" justify="center" valign="top" font-size="22">' +
        esc(score.title) + '</credit-words></credit>\n';
    }
    if (score.lyricist) {
      x += '<credit page="1"><credit-type>lyricist</credit-type><credit-words default-x="80" default-y="1430" justify="left" valign="top" font-size="10">' +
        esc(score.lyricist) + '</credit-words></credit>\n';
    }
    if (score.composer) {
      x += '<credit page="1"><credit-type>composer</credit-type><credit-words default-x="1144" default-y="1430" justify="right" valign="top" font-size="10">' +
        esc(score.composer) + '</credit-words></credit>\n';
    }
    x += '<part-list><score-part id="P1"><part-name print-object="no">' + esc(score.partName || 'Voice') +
      '</part-name></score-part></part-list>\n<part id="P1">\n';

    const brk = systemBreaks(measures, opts.breaks);
    let barNo = 0;
    measures.forEach((meas, mi) => {
      const pickup = !!meas.pickup; // 못갖춘마디 (곡 중간 구간 시작에도 올 수 있음)
      if (!pickup) barNo++;
      x += '<measure number="' + (pickup ? 'p' + mi : barNo) + '"' +
        (pickup ? ' implicit="yes"' : '') + '>\n';
      if (brk[mi]) x += '<print new-system="yes"/>\n';
      const prev = measures[mi - 1], next = measures[mi + 1];
      const ending = meas.ending ? String(meas.ending) : '';
      const endingStart = ending && (!prev || String(prev.ending || '') !== ending);
      const endingEnd = ending && (!next || String(next.ending || '') !== ending);
      const repeatStart = meas.repeatStart || meas.barline === 'repeat-start';
      const repeatEnd = meas.repeatEnd || meas.barline === 'repeat-end';
      x += leftBarlineXml(repeatStart, endingStart ? ending : '');
      if (mi === 0) {
        x += '<attributes><divisions>' + DIVISIONS + '</divisions>' +
          '<key><fifths>' + key.fifths + '</fifths><mode>' + key.mode + '</mode></key>' +
          '<time><beats>' + time.beats + '</beats><beat-type>' + time.beatType + '</beat-type></time>' +
          '<clef><sign>' + clef.sign + '</sign><line>' + clef.line + '</line></clef></attributes>\n';
        if (score.tempo) {
          x += '<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit>' +
            '<per-minute>' + (+score.tempo) + '</per-minute></metronome></direction-type>' +
            '<sound tempo="' + (+score.tempo) + '"/></direction>\n';
        }
      }
      if (meas.section) {
        x += '<direction placement="above"><direction-type><rehearsal>' + esc(meas.section) +
          '</rehearsal></direction-type></direction>\n';
      }

      const local = {}; // 이 마디 안에서 나온 임시표: "C4" → alter
      let tup = null;   // 진행 중인 셋잇단 묶음 {sum, target}
      const beams = computeBeams(meas.notes || [], time);
      (meas.notes || []).forEach((n, ni) => {
        const pt = parsePitch(n.pitch);
        const type = normDuration(n.duration);
        const dur = noteDivisions(n);
        if (n.chord) x += chordsXml(n.chord, dur) + '\n';

        x += '<note>';
        if (!pt) {
          const wholeRest = type === 'whole' && (meas.notes || []).length === 1;
          x += wholeRest ? '<rest measure="yes"/>' : '<rest/>';
        } else {
          x += '<pitch><step>' + pt.step + '</step>' +
            (pt.alter ? '<alter>' + pt.alter + '</alter>' : '') +
            '<octave>' + pt.octave + '</octave></pitch>';
        }
        x += '<duration>' + dur + '</duration>';
        const tieStart = n.tie === 'start' || n.tie === 'both';
        const tieStop = n.tie === 'stop' || n.tie === 'both';
        if (tieStop) x += '<tie type="stop"/>';
        if (tieStart) x += '<tie type="start"/>';
        x += '<voice>1</voice><type>' + type + '</type>';
        for (let d = 0; d < (n.dots | 0); d++) x += '<dot/>';

        if (pt) {
          const slot = pt.step + pt.octave;
          const expected = slot in local ? local[slot] : kAlt[pt.step];
          if (pt.alter !== expected && !tieStop) {
            x += '<accidental>' + ACC_NAME[pt.alter] + '</accidental>';
          }
          local[slot] = pt.alter;
        }
        if (n.triplet) {
          x += '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>';
        }
        beams[ni].forEach((b) => { x += '<beam number="' + b.number + '">' + b.value + '</beam>'; });
        let tupXml = '';
        if (n.triplet) {
          if (!tup) { tup = { sum: 0, target: dur * 3 }; tupXml = '<tuplet type="start" bracket="yes"/>'; }
          tup.sum += dur;
          if (tup.sum >= tup.target) { tupXml += '<tuplet type="stop"/>'; tup = null; }
        } else if (tup) {
          tup = null; // 셋잇단이 덜 끝난 채 끊긴 경우
        }
        if (tieStart || tieStop || tupXml) {
          x += '<notations>' + (tieStop ? '<tied type="stop"/>' : '') +
            (tieStart ? '<tied type="start"/>' : '') + tupXml + '</notations>';
        }
        (n.lyrics || []).forEach((ly, i) => {
          if (!ly || ly.text == null || ly.text === '') return;
          const verse = ly.verse || i + 1;
          const syl = ['single', 'begin', 'middle', 'end'].includes(ly.syllabic) ? ly.syllabic : 'single';
          x += '<lyric number="' + verse + '"><syllabic>' + syl + '</syllabic><text>' +
            esc(ly.text) + '</text>' + (ly.extend ? '<extend/>' : '') + '</lyric>';
        });
        x += '</note>\n';
      });

      const isLast = mi === measures.length - 1;
      const style = ['final', 'double'].includes(meas.barline) ? meas.barline : (isLast ? 'final' : null);
      const endingStop = endingEnd ? { number: ending, type: repeatEnd ? 'stop' : 'discontinue' } : null;
      x += rightBarlineXml(style, repeatEnd, endingStop) + '\n';
      x += '</measure>\n';
    });

    x += '</part>\n</score-partwise>\n';
    return x;
  }

  /* ───────────── 조옮김 ───────────── */
  const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const SEMI = [0, 2, 4, 5, 7, 9, 11];
  const mod = (a, n) => ((a % n) + n) % n;

  function tonicOf(keyName) {
    const k = parseKey(keyName).name.replace(/m$/, '');
    return { step: k[0], alter: k[1] === '#' ? 1 : k[1] === 'b' ? -1 : 0 };
  }

  /** 두 조 사이의 이동 간격 (글자 수, 반음 수). 가까운 쪽으로 이동 */
  function intervalBetween(fromKey, toKey, direction) {
    const a = tonicOf(fromKey), b = tonicOf(toKey);
    let dl = mod(LETTERS.indexOf(b.step) - LETTERS.indexOf(a.step), 7);
    let ds = mod(SEMI[LETTERS.indexOf(b.step)] + b.alter - SEMI[LETTERS.indexOf(a.step)] - a.alter, 12);
    const goDown = direction === 'down' || (direction !== 'up' && ds > 6);
    if (goDown && (ds > 0 || dl > 0)) { ds -= 12; dl -= 7; }
    return { dl, ds };
  }

  function transposePitchObj(pt, iv) {
    const li = LETTERS.indexOf(pt.step) + iv.dl;
    const octave = pt.octave + Math.floor(li / 7);
    const step = LETTERS[mod(li, 7)];
    const oldAbs = pt.octave * 12 + SEMI[LETTERS.indexOf(pt.step)] + pt.alter;
    let alter = oldAbs + iv.ds - (octave * 12 + SEMI[LETTERS.indexOf(step)]);
    if (Math.abs(alter) <= 2) return { step, alter, octave };
    // 겹올림/겹내림을 넘어가면 이명동음으로 정리
    return spellMidi(oldAbs + iv.ds + 12, alter > 0);
  }

  /** MIDI 번호(C4=60) → 음이름 */
  function spellMidi(midi, preferSharp) {
    const sharp = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const flat = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
    const name = (preferSharp ? sharp : flat)[mod(midi, 12)];
    return parsePitch(name + (Math.floor(midi / 12) - 1));
  }

  function pitchToMidi(pt) {
    return (pt.octave + 1) * 12 + SEMI[LETTERS.indexOf(pt.step)] + pt.alter;
  }

  function transposeChord(sym, iv) {
    const many = String(sym).trim().split(/\s+/);
    if (many.length > 1) return many.map((c) => transposeChord(c, iv)).join(' ');
    const s = String(sym).trim().replace(/♯/g, '#').replace(/♭/g, 'b');
    const m = s.match(/^([A-G])(#|b)?([^/]*)(?:\/([A-G])(#|b)?)?$/);
    if (!m) return sym;
    const one = (step, acc) => {
      const p = transposePitchObj({ step, alter: acc === '#' ? 1 : acc === 'b' ? -1 : 0, octave: 4 }, iv);
      let a = p.alter;
      let st = p.step;
      if (Math.abs(a) > 1) { const q = spellMidi(pitchToMidi(p), a > 0); st = q.step; a = q.alter; }
      return st + (a === 1 ? '#' : a === -1 ? 'b' : '');
    };
    return one(m[1], m[2]) + (m[3] || '') + (m[4] ? '/' + one(m[4], m[5]) : '');
  }

  /** 악보 JSON 을 다른 조로 옮긴 새 JSON 을 돌려줌 (원본은 그대로) */
  function transpose(score, toKey, direction) {
    const fromKey = parseKey(score.key);
    const target = parseKey(toKey);
    const iv = intervalBetween(fromKey.name, target.name, direction);
    const out = JSON.parse(JSON.stringify(score));
    out.key = target.name;
    (out.measures || []).forEach((m) => (m.notes || []).forEach((n) => {
      const pt = parsePitch(n.pitch);
      if (pt) n.pitch = pitchToString(transposePitchObj(pt, iv));
      if (n.chord) n.chord = transposeChord(n.chord, iv);
    }));
    return out;
  }

  /** 반음 위/아래로 한 음 옮기기 (편집용) */
  function shiftSemitone(pitch, delta, score) {
    const pt = parsePitch(pitch);
    if (!pt) return pitch;
    return pitchToString(spellMidi(pitchToMidi(pt) + delta, delta > 0));
  }

  /* ───────────── 오선 위치 → 음이름 ───────────── */
  // 오선 맨 아래 줄의 음 (C0 = 0 기준 온음계 번호): 높은음자리 E4, 낮은음자리 G2
  const BOTTOM_LINE = { treble: 4 * 7 + 2, bass: 2 * 7 + 4 };
  const ACC_ALTER = { '#': 1, '♯': 1, 'b': -1, '♭': -1, 'n': 0, '♮': 0, natural: 0, sharp: 1, flat: -1, '##': 2, x: 2, bb: -2 };

  /**
   * pos(오선 위치)와 acc(눈에 보이는 임시표)만 있는 음표에 pitch 를 채움.
   * 조표, 같은 마디 안의 앞선 임시표, 붙임줄로 넘어온 음까지 반영.
   */
  function resolvePositions(score) {
    const kAlt = keyAlters(parseKey(score.key).fifths);
    const base = BOTTOM_LINE[score.clef === 'bass' ? 'bass' : 'treble'];
    let carry = null; // 붙임줄로 다음 마디에 이어지는 음
    (score.measures || []).forEach((m) => {
      const local = {};
      (m.notes || []).forEach((n) => {
        if (n.rest === true || /^(r|rest)$/i.test(String(n.pitch || ''))) {
          n.pitch = 'rest'; delete n.pos; delete n.acc; delete n.rest; carry = null; return;
        }
        if (n.pos == null || n.pos === '') { carry = null; return; } // 이미 pitch 가 있는 음표
        const d = base + Math.round(+n.pos);
        const step = LETTERS[mod(d, 7)];
        const octave = Math.floor(d / 7);
        const slot = step + octave;
        let alter;
        if (n.acc != null && n.acc !== '' && String(n.acc) in ACC_ALTER) alter = ACC_ALTER[String(n.acc)];
        else if ((n.tie === 'stop' || n.tie === 'both') && carry && carry.slot === slot) alter = carry.alter;
        else alter = slot in local ? local[slot] : kAlt[step];
        local[slot] = alter;
        n.pitch = pitchToString({ step, alter, octave });
        delete n.pos; delete n.acc;
        carry = (n.tie === 'start' || n.tie === 'both') ? { slot, alter } : null;
      });
    });
    return score;
  }

  /** 미리보기에서 클릭한 음표를 JSON 위치로 찾기 위한 목록 (악보에 그려지는 순서와 동일) */
  function listEvents(score) {
    const out = [];
    (score.measures || []).forEach((m, mi) => {
      (m.notes || []).forEach((n, ni) => out.push({ mi, ni, note: n }));
    });
    return out;
  }

  /** 기본적인 형식 점검: 마디 길이가 박자표와 맞는지 등 */
  function validate(score) {
    const issues = [];
    const time = parseTime(score.time);
    const full = Math.round(time.beats * (4 / time.beatType) * DIVISIONS);
    (score.measures || []).forEach((m, mi) => {
      let total = 0;
      (m.notes || []).forEach((n, ni) => {
        try { parsePitch(n.pitch); } catch (e) { issues.push({ mi, ni, msg: e.message }); }
        try { total += noteDivisions(n); } catch (e) { issues.push({ mi, ni, msg: e.message }); }
      });
      const isEdge = m.pickup || m.ending || mi === score.measures.length - 1 ||
        (score.measures[mi + 1] && score.measures[mi + 1].pickup); // 구간 끝(다음이 못갖춘마디)도 짧을 수 있음
      if (total !== full && !(isEdge && total < full)) {
        const beats = (total / DIVISIONS) * (time.beatType / 4);
        const label = score.measures[0] && score.measures[0].pickup ? mi : mi + 1;
        issues.push({ mi, msg: label + '마디 길이가 박자와 다릅니다 (' +
          (+beats.toFixed(2)) + '박 / ' + time.beats + '박)' });
      }
    });
    return issues;
  }

  return {
    DIVISIONS, toMusicXML, listEvents, validate, transpose, transposeChord, shiftSemitone,
    resolvePositions, hasLineInfo, systemBreaks,
    parsePitch, pitchToString, parseKey, normalizeKey, noteDivisions,
    MAJOR_KEYS: Object.keys(MAJOR_FIFTHS), MINOR_KEYS: Object.keys(MINOR_FIFTHS),
  };
});
