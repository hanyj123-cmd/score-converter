/*
 * staff-split.js
 * 악보 이미지에서 오선(5줄)을 찾아 줄(단)마다 잘라 확대 이미지를 만듭니다.
 * 한 줄씩 크게 보여 주면 Gemini 가 음 위치를 훨씬 정확하게 읽습니다.
 * PDF 는 pdf.js 로 페이지를 이미지로 바꾼 뒤 같은 방식으로 처리합니다.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.StaffSplit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PDFJS_VER = '4.10.38';
  const PDFJS_BASE = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@' + PDFJS_VER + '/build/';
  const PAGE_WIDTH = 2400; // 페이지를 이 너비로 맞춰서 처리

  /**
   * 오선 찾기 (순수 함수 – 테스트 가능)
   * @param {Uint8ClampedArray} rgba  이미지 픽셀
   * @param {number} w, h
   * @returns {Array<{lines:number[], top:number, bottom:number, spacing:number}>}
   */
  function detectStaves(rgba, w, h) {
    // 1) 줄마다 어두운 픽셀 수
    const rows = new Float64Array(h);
    for (let y = 0; y < h; y++) {
      let c = 0;
      const o = y * w * 4;
      for (let x = 0; x < w; x++) {
        const i = o + x * 4;
        const a = rgba[i + 3] / 255;
        const lum = (rgba[i] * 0.299 + rgba[i + 1] * 0.587 + rgba[i + 2] * 0.114) * a + 255 * (1 - a);
        if (lum < 150) c++;
      }
      rows[y] = c;
    }
    let max = 0;
    for (let y = 0; y < h; y++) if (rows[y] > max) max = rows[y];
    if (max < w * 0.2) return [];

    // 2) 오선 후보: 가로로 길게 이어진 줄 (가장 긴 줄의 45% 이상)
    const th = max * 0.45;
    const lines = [];
    let start = -1;
    for (let y = 0; y <= h; y++) {
      const on = y < h && rows[y] >= th;
      if (on && start < 0) start = y;
      if (!on && start >= 0) { lines.push((start + y - 1) / 2); start = -1; }
    }

    // 3) 간격이 일정한 5줄 묶음 = 오선
    const staves = [];
    for (let i = 0; i + 4 < lines.length;) {
      const g = [1, 2, 3, 4].map((k) => lines[i + k] - lines[i + k - 1]);
      const avg = g.reduce((a, b) => a + b, 0) / 4;
      const ok = avg > 3 && g.every((d) => d > avg * 0.7 && d < avg * 1.3);
      if (ok) {
        const ls = lines.slice(i, i + 5);
        staves.push({ lines: ls, top: ls[0], bottom: ls[4], spacing: avg });
        i += 5;
      } else i++;
    }
    return staves;
  }

  /** 오선마다 위아래 여백(코드·가사 포함)을 붙여 자를 범위 계산 */
  function systemBounds(staves, h) {
    return staves.map((s, k) => {
      const prev = staves[k - 1], next = staves[k + 1];
      const top = prev ? (prev.bottom + s.top) / 2 : Math.max(0, s.top - s.spacing * 7);
      const bottom = next ? (s.bottom + next.top) / 2 : Math.min(h, s.bottom + s.spacing * 9);
      return { top: Math.max(0, Math.floor(top)), bottom: Math.min(h, Math.ceil(bottom)), spacing: s.spacing };
    });
  }

  /* ───────────── 브라우저 전용 ───────────── */

  async function loadPdfjs() {
    const lib = await import(PDFJS_BASE + 'pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.mjs';
    return lib;
  }

  /** PDF 파일 → 페이지별 캔버스 */
  async function pdfToCanvases(file, maxPages) {
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const out = [];
    for (let p = 1; p <= Math.min(doc.numPages, maxPages || 6); p++) {
      const page = await doc.getPage(p);
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: PAGE_WIDTH / vp1.width });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, viewport: vp }).promise;
      out.push(c);
    }
    return out;
  }

  /** 이미지 파일 → 캔버스 (너비 PAGE_WIDTH 로 맞춤) */
  async function imageToCanvas(file) {
    const bmp = await createImageBitmap(file);
    const r = PAGE_WIDTH / bmp.width;
    const c = document.createElement('canvas');
    c.width = PAGE_WIDTH; c.height = Math.round(bmp.height * r);
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0, c.width, c.height);
    return c;
  }

  function toJpeg(canvas, maxW, q) {
    let src = canvas;
    if (maxW && canvas.width > maxW) {
      src = document.createElement('canvas');
      src.width = maxW; src.height = Math.round(canvas.height * maxW / canvas.width);
      src.getContext('2d').drawImage(canvas, 0, 0, src.width, src.height);
    }
    const url = src.toDataURL('image/jpeg', q || 0.9);
    return { url, data: url.split(',')[1], mimeType: 'image/jpeg' };
  }

  /** 페이지 캔버스 → { page: 전체 이미지, systems: [줄별 이미지] } */
  function splitCanvas(canvas) {
    const g = canvas.getContext('2d');
    const img = g.getImageData(0, 0, canvas.width, canvas.height);
    const staves = detectStaves(img.data, canvas.width, canvas.height);
    const bounds = systemBounds(staves, canvas.height);
    const systems = bounds.map((b) => {
      const c = document.createElement('canvas');
      c.width = canvas.width; c.height = b.bottom - b.top;
      c.getContext('2d').drawImage(canvas, 0, b.top, canvas.width, c.height, 0, 0, c.width, c.height);
      return Object.assign(toJpeg(c, null, 0.92), { top: b.top, bottom: b.bottom });
    });
    return { page: toJpeg(canvas, 1600, 0.85), systems, width: canvas.width, height: canvas.height };
  }

  /** 파일 하나 → 페이지 목록 [{name, page, systems}] */
  async function processFile(file, maxPages) {
    const canvases = file.type === 'application/pdf'
      ? await pdfToCanvases(file, maxPages)
      : [await imageToCanvas(file)];
    return canvases.map((c, i) => Object.assign(splitCanvas(c), {
      name: file.name.replace(/\.[^.]+$/, '') + (canvases.length > 1 ? ' p' + (i + 1) : ''),
    }));
  }

  return { detectStaves, systemBounds, processFile, splitCanvas, PDFJS_BASE };
});
