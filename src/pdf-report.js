/* Speaker Measure Pro PDF writer - raster A4 landscape pages, dependency free */
(function attachSpeakerPdf(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SpeakerPdf = api;
})(typeof self !== 'undefined' ? self : globalThis, function createSpeakerPdf() {
  'use strict';

  const encoder = new TextEncoder();
  const A4_LANDSCAPE = { width: 841.89, height: 595.28 };

  function ascii(value) {
    return encoder.encode(String(value));
  }

  function concatBytes(parts) {
    const normalized = parts.map((part) => part instanceof Uint8Array ? part : new Uint8Array(part));
    const total = normalized.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    for (const part of normalized) {
      output.set(part, offset);
      offset += part.length;
    }
    return output;
  }

  function pdfDate(date = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return `D:${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }

  function makeStream(dictionary, bytes) {
    return concatBytes([
      ascii(`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`),
      bytes,
      ascii('\nendstream')
    ]);
  }

  function buildRasterPdf(pages, options = {}) {
    if (!Array.isArray(pages) || pages.length === 0) throw new Error('PDFページがありません。');

    const pageSize = options.pageSize || A4_LANDSCAPE;
    const objects = [];
    const catalogId = 1;
    const pagesId = 2;
    const infoId = 3;
    let nextId = 4;
    const pageObjectIds = [];

    for (const page of pages) {
      const imageBytes = page.jpegBytes instanceof Uint8Array ? page.jpegBytes : new Uint8Array(page.jpegBytes);
      if (!imageBytes.length || !(page.pixelWidth > 0) || !(page.pixelHeight > 0)) {
        throw new Error('PDFページ画像が不正です。');
      }

      const imageId = nextId++;
      const contentId = nextId++;
      const pageId = nextId++;
      pageObjectIds.push(pageId);

      const mediaWidth = Number(page.pageWidth || pageSize.width);
      const mediaHeight = Number(page.pageHeight || pageSize.height);
      const imageRatio = page.pixelWidth / page.pixelHeight;
      const pageRatio = mediaWidth / mediaHeight;
      let drawWidth;
      let drawHeight;
      let drawX;
      let drawY;
      if (imageRatio >= pageRatio) {
        drawWidth = mediaWidth;
        drawHeight = mediaWidth / imageRatio;
        drawX = 0;
        drawY = (mediaHeight - drawHeight) / 2;
      } else {
        drawHeight = mediaHeight;
        drawWidth = mediaHeight * imageRatio;
        drawX = (mediaWidth - drawWidth) / 2;
        drawY = 0;
      }

      objects[imageId] = makeStream(
        `/Type /XObject /Subtype /Image /Width ${Math.round(page.pixelWidth)} /Height ${Math.round(page.pixelHeight)} ` +
        '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',
        imageBytes
      );

      const content = ascii(
        `q\n${drawWidth.toFixed(4)} 0 0 ${drawHeight.toFixed(4)} ${drawX.toFixed(4)} ${drawY.toFixed(4)} cm\n/Im0 Do\nQ\n`
      );
      objects[contentId] = makeStream('', content);
      objects[pageId] = ascii(
        `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${mediaWidth.toFixed(2)} ${mediaHeight.toFixed(2)}] ` +
        `/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`
      );
    }

    objects[catalogId] = ascii(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
    objects[pagesId] = ascii(`<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjectIds.length} >>`);
    objects[infoId] = ascii(
      `<< /Producer (Speaker Measure Pro ${String(options.version || '')}) ` +
      `/Creator (Speaker Measure Pro) /Title (Speaker measurement report) /CreationDate (${pdfDate(options.createdAt)}) >>`
    );

    const header = concatBytes([ascii('%PDF-1.4\n%'), Uint8Array.of(0xFF, 0xFF, 0xFF, 0xFF), ascii('\n')]);
    const chunks = [header];
    const offsets = new Array(objects.length).fill(0);
    let length = chunks[0].length;
    for (let id = 1; id < objects.length; id++) {
      if (!objects[id]) throw new Error(`PDF内部オブジェクト ${id} が不足しています。`);
      offsets[id] = length;
      const chunk = concatBytes([ascii(`${id} 0 obj\n`), objects[id], ascii('\nendobj\n')]);
      chunks.push(chunk);
      length += chunk.length;
    }

    const xrefOffset = length;
    const xrefLines = [`xref\n0 ${objects.length}\n`, '0000000000 65535 f \n'];
    for (let id = 1; id < objects.length; id++) {
      xrefLines.push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
    }
    const trailer =
      `${xrefLines.join('')}trailer\n<< /Size ${objects.length} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`;
    chunks.push(ascii(trailer));
    return concatBytes(chunks);
  }

  return {
    A4_LANDSCAPE,
    buildRasterPdf
  };
});
