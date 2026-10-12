/**
 * 악보 변환기 – Google Apps Script 백엔드
 *
 * 하는 일
 *  1) transcribe : 악보 이미지 → Gemini → 악보 JSON
 *  2) save       : 원본 이미지·JSON·MusicXML·MIDI 를 구글 드라이브 폴더에 저장
 *  3) ping       : 연결 확인
 *
 * 스크립트 속성(프로젝트 설정 → 스크립트 속성)에 넣을 값
 *  GEMINI_API_KEY : Google AI Studio 에서 발급한 키 (필수)
 *  APP_KEY        : 웹 페이지에서 입력할 접속 암호 (필수, 아무 문자열)
 *  GEMINI_MODEL   : 사용할 모델 이름 (선택, 기본값은 아래 DEFAULT_MODEL)
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
      case 'transcribe':
        return json_({ ok: true, score: transcribe_(req.images || [], req.hints || {}) });
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

function buildPrompt_(hints) {
  const h = [];
  if (hints.title) h.push('- 곡 제목: ' + hints.title);
  if (hints.key) h.push('- 조표(사용자 확인): ' + hints.key);
  if (hints.time) h.push('- 박자(사용자 확인): ' + hints.time);
  if (hints.language) h.push('- 가사 언어: ' + hints.language);
  if (hints.note) h.push('- 메모: ' + hints.note);

  return [
    '당신은 악보 판독 전문가입니다. 첨부된 악보 이미지(여러 장이면 순서대로 이어지는 페이지)를 읽어',
    '아래 JSON 형식으로 정확하게 옮겨 적으세요.',
    '',
    '규칙',
    '1. 이 악보는 단선 악보(오선 하나에 멜로디 한 줄, 위에 코드 기호, 아래에 가사)입니다.',
    '   페이지 안의 여러 줄(단)은 위에서 아래로 이어지는 하나의 멜로디이니 순서대로 이어서 적습니다.',
    '   오선 아래 가사가 여러 줄이면 위에서부터 1절, 2절, 3절입니다.',
    '2. pitch 는 영어 음이름+옥타브입니다. 가운데 도 = C4. 실제로 들리는 음을 적습니다.',
    '   조표에 의해 올리거나 내린 음도 반영해서 적습니다. 예: G장조의 파는 "F#4".',
    '   쉼표는 "rest".',
    '3. duration 은 whole, half, quarter, eighth, 16th, 32nd 중 하나. 점음표는 dots 로, 셋잇단음표는 triplet: true.',
    '4. 붙임줄(같은 음 연결)은 tie: "start" / "stop" / "both" 로 적습니다. 이음줄(다른 음 연결)은 적지 않습니다.',
    '5. 코드 기호(G, Em7, D/F# 등)는 그 코드가 시작되는 음표의 chord 에 적습니다. 없으면 생략.',
    '6. 가사는 음표마다 lyrics 배열에 절(verse) 번호와 함께 적습니다.',
    '   한글은 한 글자(음절)씩, syllabic 은 "single".',
    '   영어는 음절 단위로 나누고 단어 처음/중간/끝을 syllabic "begin"/"middle"/"end", 한 음절 단어는 "single".',
    '   한 음절을 여러 음으로 끌어 부르는(멜리스마) 뒤쪽 음표에는 가사를 넣지 않습니다.',
    '7. 각 마디의 음길이 합은 박자표와 정확히 같아야 합니다. 첫 마디가 못갖춘마디면 pickup: true.',
    '8. 반복 기호는 barline 에 "repeat-start" / "repeat-end", 겹세로줄은 "double", 끝세로줄은 "final".',
    '9. 이미지에서 읽을 수 없는 부분은 지어내지 말고, 가장 가능성 높은 값을 적은 뒤 warnings 에 몇 번째 마디인지 적습니다.',
    '10. key 는 "G", "Bb", "F#m" 처럼, time 은 "4/4" 처럼 적습니다.',
    '',
    h.length ? '사용자가 알려준 정보(이미지보다 우선):\n' + h.join('\n') : '',
  ].join('\n');
}

function scoreSchema_() {
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
      pitch: { type: 'STRING' },
      duration: { type: 'STRING', enum: ['whole', 'half', 'quarter', 'eighth', '16th', '32nd'] },
      dots: { type: 'INTEGER' },
      triplet: { type: 'BOOLEAN' },
      tie: { type: 'STRING', enum: ['start', 'stop', 'both'] },
      chord: { type: 'STRING' },
      lyrics: { type: 'ARRAY', items: lyric },
    },
    required: ['pitch', 'duration'],
  };
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
      measures: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            pickup: { type: 'BOOLEAN' },
            barline: { type: 'STRING', enum: ['final', 'double', 'repeat-start', 'repeat-end'] },
            notes: { type: 'ARRAY', items: note },
          },
          required: ['notes'],
        },
      },
      warnings: { type: 'ARRAY', items: { type: 'STRING' } },
    },
    required: ['key', 'time', 'measures'],
  };
}

function transcribe_(images, hints) {
  if (!images.length) throw new Error('이미지가 없습니다.');
  if (images.length > 6) throw new Error('한 번에 6장까지 올릴 수 있습니다.');
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('스크립트 속성에 GEMINI_API_KEY 가 없습니다.');
  const model = props.getProperty('GEMINI_MODEL') || DEFAULT_MODEL;

  const parts = [{ text: buildPrompt_(hints) }];
  images.forEach(function (img) {
    parts.push({ inline_data: { mime_type: img.mimeType || 'image/jpeg', data: img.data } });
  });

  const body = {
    contents: [{ role: 'user', parts: parts }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: scoreSchema_(),
    },
  };

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(model) + ':generateContent';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': apiKey },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code !== 200) {
    let msg = text;
    try { msg = JSON.parse(text).error.message; } catch (e) {}
    throw new Error('Gemini 오류 (' + code + '): ' + msg);
  }
  const data = JSON.parse(text);
  const cand = data.candidates && data.candidates[0];
  const out = cand && cand.content && cand.content.parts &&
    cand.content.parts.map(function (p) { return p.text || ''; }).join('');
  if (!out) throw new Error('Gemini 응답이 비어 있습니다. (' + (cand && cand.finishReason) + ')');
  const score = JSON.parse(out);
  if (hints.title && !score.title) score.title = hints.title;
  score._model = model;
  return score;
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
