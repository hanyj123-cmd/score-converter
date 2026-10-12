/**
 * 악보 변환기 – Google Apps Script 백엔드
 *
 * 하는 일
 *  1) meta  : 악보 페이지 → 제목·조·박자·구간 표시
 *     lines : 오선 줄(단) 확대 이미지 → 그 줄의 마디·음표·코드·가사
 *     (브라우저가 줄마다 나눠서 동시에 요청하고 결과를 합칩니다. Apps Script 의 60초 제한 때문)
 *  2) save       : 원본 이미지·JSON·MusicXML·MIDI 를 구글 드라이브 폴더에 저장
 *  3) ping       : 연결 확인
 *
 * 스크립트 속성(프로젝트 설정 → 스크립트 속성)에 넣을 값
 *  GEMINI_API_KEY : Google AI Studio 에서 발급한 키 (필수)
 *  APP_KEY        : 웹 페이지에서 입력할 접속 암호 (필수, 아무 문자열)
 *  GEMINI_MODEL   : 사용할 모델 이름 (선택, 기본값은 아래 DEFAULT_MODEL)
 *  GEMINI_THINKING: (선택) low | high – 생각 깊이. 시간 초과가 잦으면 low
 *  DRIVE_FOLDER_ID: 저장할 드라이브 폴더 ID (선택, 없으면 "악보 변환" 폴더를 자동으로 만듦)
 */

const DEFAULT_MODEL = 'gemini-flash-latest'; // 항상 최신 Flash 모델을 가리키는 별칭

function doGet() {
  return json_({ ok: true, service: 'score-converter', hint: 'POST로 호출하세요' });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents || '{}');
    const props = PropertiesService.getScriptProperties();
    const appKey = props.getProperty('APP_KEY');
    if (!appKey || req.key !== appKey) return json_({ ok: false, error: '접속 암호가 맞지 않습니다.' });

    switch (req.action) {
      case 'ping':
        return json_({ ok: true, model: props.getProperty('GEMINI_MODEL') || DEFAULT_MODEL });
      case 'meta':
        return json_({ ok: true, meta: meta_(req) });
      case 'lines':
        return json_({ ok: true, result: lines_(req) });
      case 'save':
        return json_({ ok: true, ...saveToDrive_(req.title, req.files || []) });
      default:
        return json_({ ok: false, error: '알 수 없는 요청: ' + req.action });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ───────────────────────── Gemini ───────────────────────── */

/* 음표 읽기 규칙 (줄 단위 요청에 공통) */
function noteRules_() {
  return [
    '[음높이 – 음 이름을 적지 말고 오선 위치를 적습니다]',
    '- pos: 음표 머리의 세로 위치. 오선 맨 아래 줄 = 0, 그 위 칸 = 1, 아래에서 둘째 줄 = 2, … 맨 위 줄 = 8.',
    '  오선 아래: 맨 아래 줄 바로 밑 칸 = -1, 첫째 덧줄 = -2, 그 아래 칸 = -3, 둘째 덧줄 = -4, 그 아래 칸 = -5, 셋째 덧줄 = -6.',
    '  오선 위: 맨 위 줄 위 칸 = 9, 첫째 덧줄 = 10, 그 위 칸 = 11.',
    '  덧줄 개수를 꼭 세어 보세요. 음표 머리가 줄에 걸쳐 있으면 짝수, 줄 사이 칸에 있으면 홀수입니다.',
    '- acc: 그 음표 바로 앞에 실제로 그려진 임시표만 ("#", "b", "n"=제자리표). 조표에 의한 올림/내림은 적지 않습니다.',
    '- 쉼표는 rest: true (pos 생략).',
    '',
    '[리듬]',
    '- duration: whole, half, quarter, eighth, 16th, 32nd.',
    '  속이 빈 머리 + 기둥 = half, 속이 빈 머리만 = whole, 검은 머리 + 기둥 = quarter,',
    '  꼬리나 들보(빔) 1개 = eighth, 2개 = 16th. 들보가 한쪽만 짧게 2개면 그 음만 16th.',
    '- 음표 오른쪽 점은 dots: 1. 셋잇단음표(숫자 3)는 triplet: true.',
    '- 붙임줄(같은 높이 두 음을 잇는 곡선)은 앞 음 tie: "start", 뒤 음 tie: "stop" (둘 다면 "both"). 다른 높이를 잇는 이음줄은 적지 않습니다.',
    '  줄 끝에서 다음 줄로 이어지는 붙임줄도 "start" 로 적습니다. 줄 첫 음이 앞 줄에서 이어진 붙임줄이면 "stop".',
    '- 각 마디 음길이 합은 박자표와 같아야 합니다(못갖춘마디·괄호 마디 제외). 다 적은 뒤 마디마다 다시 더해 확인하세요.',
    '',
    '[코드·가사]',
    '- chord: 코드 기호(A, E7/G#, F#m, AM7/E, Esus4 등)를 그 바로 아래 음표(또는 쉼표)에. ♯ 는 #, ♭ 는 b.',
    '  한 음표 위에 코드가 두 개면 두 번째 코드는 그 뒤 처음 나오는 음표에.',
    '- lyrics: 음표 바로 아래 글자를 절(verse) 번호와 함께. 한글은 한 음절씩, syllabic "single".',
    '  영어는 음절로 나누어 begin/middle/end, 한 음절 단어는 single.',
    '  가사 줄이 여러 개면 위에서부터 1절, 2절. "—", "-" 같은 늘임 표시는 가사가 아닙니다.',
    '  한 음절을 여러 음으로 끌 때(붙임줄·이음줄로 이어진 뒤 음표)는 가사를 넣지 않습니다.',
    '',
    '[구조]',
    '- 도돌이표: 시작 |: 은 repeatStart: true, 끝 :| 은 repeatEnd: true.',
    '- 1·2번 괄호: 괄호 안 마디마다 ending: "1" 또는 "2".',
    '- 겹세로줄은 barline: "double", 끝세로줄은 "final".',
    '- 확실하지 않은 곳은 가장 가능성 높은 값으로 적고 warnings 에 "줄 K, M번째 마디: 이유" 형식으로.',
  ].join('\n');
}

function hintText_(hints) {
  const h = [];
  if (hints.title) h.push('- 곡 제목: ' + hints.title);
  if (hints.key) h.push('- 조: ' + hints.key);
  if (hints.time) h.push('- 박자: ' + hints.time);
  if (hints.language) h.push('- 가사 언어: ' + hints.language);
  return h.length ? '\n알려진 정보(이미지보다 우선):\n' + h.join('\n') : '';
}

/* ── 1) 곡 정보: 제목, 조, 박자, 구간 표시 ── */
function metaSchema_() {
  return {
    type: 'OBJECT',
    properties: {
      title: { type: 'STRING' },
      composer: { type: 'STRING' },
      lyricist: { type: 'STRING' },
      key: { type: 'STRING' },
      time: { type: 'STRING' },
      tempo: { type: 'INTEGER' },
      clef: { type: 'STRING', enum: ['treble', 'bass'] },
      pickup: { type: 'BOOLEAN' },
      sections: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { line: { type: 'INTEGER' }, label: { type: 'STRING' } },
          required: ['line', 'label'],
        },
      },
    },
    required: ['key', 'time'],
  };
}

function meta_(req) {
  const pages = req.pages || [];
  if (!pages.length) throw new Error('이미지가 없습니다.');
  const parts = [{ text: [
    '단선 악보(멜로디·코드·가사) 이미지입니다. 곡 정보만 JSON 으로 적으세요. 음표는 적지 않습니다.',
    '- title: 곡 제목. composer / lyricist: 작곡·작사 (Words & Music 이면 둘 다 같은 이름).',
    '- key: 조표와 곡의 끝 음으로 판단한 조. "A", "Bb", "F#m" 처럼.',
    '- time: "4/4" 처럼. tempo: 숫자로 적힌 빠르기(BPM)가 있으면.',
    '- pickup: 첫 마디가 못갖춘마디면 true.',
    '- sections: 오선 줄(단) 왼쪽이나 위에 적힌 구간 표시(V, PC, C, C2, Bridge 등)와 그 줄 번호(위에서부터 1, 2, 3…, 페이지가 넘어가면 이어서).',
    '  줄 번호는 오선 줄 기준입니다. 표시가 여러 줄을 묶고 있으면 첫 줄 번호만.',
    '  맨 위의 진행 순서 메모(Intro - V - PC …)는 구간 표시가 아닙니다.',
    req.lineCount ? '- 이 악보는 모두 ' + req.lineCount + '줄입니다.' : '',
  ].join('\n') + hintText_(req.hints || {}) }];
  pages.forEach(function (p, i) {
    parts.push({ text: '페이지 ' + (i + 1) + ':' });
    parts.push({ inline_data: { mime_type: p.mimeType || 'image/jpeg', data: p.data } });
  });
  return callGemini_(parts, metaSchema_());
}

/* ── 2) 줄 단위 음표 읽기 ── */
function lineSchema_() {
  const lyric = {
    type: 'OBJECT',
    properties: {
      verse: { type: 'INTEGER' },
      text: { type: 'STRING' },
      syllabic: { type: 'STRING', enum: ['single', 'begin', 'middle', 'end'] },
    },
    required: ['verse', 'text', 'syllabic'],
  };
  const note = {
    type: 'OBJECT',
    properties: {
      rest: { type: 'BOOLEAN' },
      pos: { type: 'INTEGER' },
      acc: { type: 'STRING', enum: ['#', 'b', 'n', '##', 'bb'] },
      duration: { type: 'STRING', enum: ['whole', 'half', 'quarter', 'eighth', '16th', '32nd'] },
      dots: { type: 'INTEGER' },
      triplet: { type: 'BOOLEAN' },
      tie: { type: 'STRING', enum: ['start', 'stop', 'both'] },
      chord: { type: 'STRING' },
      lyrics: { type: 'ARRAY', items: lyric },
    },
    required: ['duration'],
  };
  return {
    type: 'OBJECT',
    properties: {
      measures: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            line: { type: 'INTEGER' },
            repeatStart: { type: 'BOOLEAN' },
            repeatEnd: { type: 'BOOLEAN' },
            ending: { type: 'STRING' },
            barline: { type: 'STRING', enum: ['final', 'double'] },
            notes: { type: 'ARRAY', items: note },
          },
          required: ['line', 'notes'],
        },
      },
      warnings: { type: 'ARRAY', items: { type: 'STRING' } },
    },
    required: ['measures'],
  };
}

/**
 * req.lines: [{ line: K, mimeType, data }]  (확대한 줄 이미지들)
 * req.page : { mimeType, data }  (그 줄이 있는 페이지 전체, 참고용 – 선택)
 * req.whole: true 이면 줄 검출에 실패한 페이지 전체를 읽음
 */
function lines_(req) {
  const lines = req.lines || [];
  if (!lines.length) throw new Error('줄 이미지가 없습니다.');
  const hints = req.hints || {};
  const nums = lines.map(function (l) { return l.line; });
  const intro = req.whole
    ? '단선 악보 페이지를 읽어 모든 마디를 적습니다. 마디마다 line 에 그 마디가 있는 오선 줄 번호(위에서부터, ' +
      nums[0] + '번부터 시작)를 적습니다.'
    : '단선 악보의 일부 줄(단)을 확대한 이미지입니다. 아래 "줄 K" 이미지에 있는 마디만 빠짐없이 순서대로 적고, ' +
      '마디마다 line 에 K 를 적습니다. 줄 번호: ' + nums.join(', ') + '.' +
      (req.page ? ' "페이지 전체" 이미지는 위치 확인용 참고 자료이며, 그 안의 다른 줄은 적지 않습니다.' : '');
  const ctx = [];
  if (hints.key) ctx.push('조: ' + hints.key + ' (조표는 이미 반영되니 pos 와 실제로 보이는 임시표만 적으세요)');
  if (hints.time) ctx.push('박자: ' + hints.time);
  if (hints.pickup && nums[0] === 1) ctx.push('1번 줄 첫 마디는 못갖춘마디입니다.');
  const parts = [{ text: intro + '\n' + (ctx.length ? ctx.join('\n') + '\n' : '') + '\n' + noteRules_() }];
  if (req.page && !req.whole) {
    parts.push({ text: '페이지 전체 (참고용):' });
    parts.push({ inline_data: { mime_type: req.page.mimeType || 'image/jpeg', data: req.page.data } });
  }
  lines.forEach(function (l) {
    parts.push({ text: req.whole ? '페이지:' : '줄 ' + l.line + ':' });
    parts.push({ inline_data: { mime_type: l.mimeType || 'image/jpeg', data: l.data } });
  });
  const out = callGemini_(parts, lineSchema_());
  if (!req.whole) {
    // 줄 하나만 보냈으면 줄 번호는 우리가 확실히 앎
    if (lines.length === 1) (out.measures || []).forEach(function (m) { m.line = lines[0].line; });
  }
  return out;
}

/* ── Gemini 호출 (한 번에 60초 안에 끝나야 함) ── */
function callGemini_(parts, schema) {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('스크립트 속성에 GEMINI_API_KEY 가 없습니다.');
  const model = props.getProperty('GEMINI_MODEL') || DEFAULT_MODEL;
  const gen = {
    responseMimeType: 'application/json',
    responseSchema: schema,
    maxOutputTokens: 32768,
  };
  const thinking = props.getProperty('GEMINI_THINKING'); // 선택: low | high
  if (thinking) gen.thinkingConfig = { thinkingLevel: thinking };

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) + ':generateContent';
  let res;
  try {
    res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': apiKey },
      payload: JSON.stringify({ contents: [{ role: 'user', parts: parts }], generationConfig: gen }),
      muteHttpExceptions: true,
    });
  } catch (e) {
    throw new Error('Gemini 응답이 너무 오래 걸렸습니다(60초 제한). 다시 시도하면 대부분 됩니다.');
  }
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code !== 200) {
    let msg = text;
    try { msg = JSON.parse(text).error.message; } catch (e) {}
    const err = new Error('Gemini 오류 (' + code + '): ' + msg);
    throw err;
  }
  const data = JSON.parse(text);
  const cand = data.candidates && data.candidates[0];
  const out = cand && cand.content && cand.content.parts &&
    cand.content.parts.filter(function (p) { return !p.thought; }).map(function (p) { return p.text || ''; }).join('');
  if (!out) throw new Error('Gemini 응답이 비어 있습니다. (' + (cand && cand.finishReason) + ')');
  let obj;
  try { obj = JSON.parse(out); }
  catch (e) { throw new Error('Gemini 응답을 해석하지 못했습니다 (' + (cand && cand.finishReason) + '). 다시 시도해 주세요.'); }
  obj._model = model;
  return obj;
}

/* ───────────────────────── Drive ───────────────────────── */

function rootFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('DRIVE_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  const folder = DriveApp.createFolder('악보 변환');
  props.setProperty('DRIVE_FOLDER_ID', folder.getId());
  return folder;
}

function saveToDrive_(title, files) {
  const tz = Session.getScriptTimeZone() || 'America/Toronto';
  const stamp = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HHmm');
  const safe = String(title || '제목 없음').replace(/[\\/:*?"<>|]/g, ' ').trim();
  const folder = rootFolder_().createFolder(stamp + ' ' + safe);

  const saved = files.map(function (f) {
    const blob = f.base64
      ? Utilities.newBlob(Utilities.base64Decode(f.base64), f.mimeType, f.name)
      : Utilities.newBlob(f.text || '', f.mimeType || 'text/plain', f.name);
    const file = folder.createFile(blob);
    return { name: f.name, url: file.getUrl(), id: file.getId() };
  });
  return { folderUrl: folder.getUrl(), folderId: folder.getId(), files: saved };
}

/** 편집기에서 한 번 실행해 권한 승인 + 설정 확인용 */
function setupCheck() {
  const props = PropertiesService.getScriptProperties();
  Logger.log('GEMINI_API_KEY: ' + (props.getProperty('GEMINI_API_KEY') ? '있음' : '없음'));
  Logger.log('APP_KEY: ' + (props.getProperty('APP_KEY') ? '있음' : '없음'));
  Logger.log('GEMINI_MODEL: ' + (props.getProperty('GEMINI_MODEL') || DEFAULT_MODEL + ' (기본값)'));
  Logger.log('저장 폴더: ' + rootFolder_().getUrl());
  UrlFetchApp.fetch('https://generativelanguage.googleapis.com/', { muteHttpExceptions: true });
}
