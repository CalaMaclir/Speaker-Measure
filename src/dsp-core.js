/* Speaker Measure Pro DSP core - dependency free */
(function attachSpeakerDSP(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SpeakerDSP = api;
})(typeof self !== 'undefined' ? self : globalThis, function createSpeakerDSP() {
  'use strict';

  const TAU = Math.PI * 2;
  const EPS = 1e-20;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function nextPowerOfTwo(value) {
    let n = 1;
    while (n < value) n <<= 1;
    return n;
  }

  function rms(samples, start = 0, end = samples.length) {
    start = clamp(Math.floor(start), 0, samples.length);
    end = clamp(Math.floor(end), start, samples.length);
    if (end <= start) return 0;
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / (end - start));
  }

  function db20(value) {
    return 20 * Math.log10(Math.max(EPS, Math.abs(value)));
  }

  function db10(value) {
    return 10 * Math.log10(Math.max(EPS, value));
  }

  function logSweepPhase(time, f0, f1, duration) {
    const logRatio = Math.log(f1 / f0);
    const L = duration / logRatio;
    const K = TAU * f0 * L;
    return K * (Math.exp(time / L) - 1);
  }

  function generateLogSweep(sampleRate, f0, f1, duration, level = 0.25, timeScale = 1) {
    if (!(sampleRate > 0 && f0 > 0 && f1 > f0 && duration > 0 && timeScale > 0)) {
      throw new Error('スイープ信号の設定値が不正です。');
    }
    const count = Math.max(1, Math.round(sampleRate * duration * timeScale));
    const output = new Float32Array(count);
    const fadeSamples = Math.max(1, Math.round(sampleRate * 0.045 * timeScale));
    for (let i = 0; i < count; i++) {
      const nominalTime = i / (sampleRate * timeScale);
      let env = 1;
      if (i < fadeSamples) env *= 0.5 - 0.5 * Math.cos(Math.PI * i / fadeSamples);
      if (i >= count - fadeSamples) {
        env *= 0.5 - 0.5 * Math.cos(Math.PI * (count - 1 - i) / fadeSamples);
      }
      output[i] = Math.sin(logSweepPhase(nominalTime, f0, f1, duration)) * level * env;
    }
    return output;
  }

  function fillLogChirp(target, offset, sampleRate, f0, f1, duration, level, polarity = 1) {
    const count = Math.min(target.length - offset, Math.round(sampleRate * duration));
    if (count <= 0) return 0;
    const fade = Math.max(1, Math.round(sampleRate * 0.009));
    const logRatio = Math.log(f1 / f0);
    const L = duration / logRatio;
    const K = TAU * f0 * L;
    for (let i = 0; i < count; i++) {
      const t = i / sampleRate;
      let env = 1;
      if (i < fade) env *= 0.5 - 0.5 * Math.cos(Math.PI * i / fade);
      if (i >= count - fade) env *= 0.5 - 0.5 * Math.cos(Math.PI * (count - 1 - i) / fade);
      target[offset + i] = polarity * level * env * Math.sin(K * (Math.exp(t / L) - 1));
    }
    return count;
  }

  function generateMarker(sampleRate, level = 0.32, variant = 'start') {
    // Two asymmetric chirps make the marker resistant to music/noise false positives.
    const chirpA = 0.105;
    const gap = 0.026;
    const chirpB = 0.105;
    const total = chirpA + gap + chirpB;
    const output = new Float32Array(Math.round(sampleRate * total));
    const aCount = fillLogChirp(
      output,
      0,
      sampleRate,
      variant === 'start' ? 720 : 3450,
      variant === 'start' ? 3450 : 880,
      chirpA,
      level,
      1
    );
    const bOffset = aCount + Math.round(sampleRate * gap);
    fillLogChirp(
      output,
      bOffset,
      sampleRate,
      variant === 'start' ? 3300 : 820,
      variant === 'start' ? 910 : 3250,
      chirpB,
      level * 0.92,
      variant === 'start' ? -1 : 1
    );
    return output;
  }

  function buildMeasurementSignal(sampleRate, config) {
    const preRoll = Number(config.preRoll ?? 0.7);
    const gap = Number(config.markerGap ?? 0.52);
    const responseTail = Number(config.responseTail ?? 2.2);
    const postRoll = Number(config.postRoll ?? 0.55);
    const level = Number(config.level ?? 0.25);
    const markerLevel = clamp(Math.max(level * 1.25, 0.18), 0.12, 0.52);
    const startMarker = generateMarker(sampleRate, markerLevel, 'start');
    const endMarker = generateMarker(sampleRate, markerLevel, 'end');
    const sweep = generateLogSweep(
      sampleRate,
      Number(config.startFreq),
      Number(config.endFreq),
      Number(config.sweepDuration),
      level,
      1
    );

    const preSamples = Math.round(preRoll * sampleRate);
    const gapSamples = Math.round(gap * sampleRate);
    const tailSamples = Math.round(responseTail * sampleRate);
    const postSamples = Math.round(postRoll * sampleRate);
    const startMarkerOffset = preSamples;
    const sweepOffset = startMarkerOffset + startMarker.length + gapSamples;
    const endMarkerOffset = sweepOffset + sweep.length + tailSamples;
    const total = endMarkerOffset + endMarker.length + postSamples;
    const output = new Float32Array(total);
    output.set(startMarker, startMarkerOffset);
    output.set(sweep, sweepOffset);
    output.set(endMarker, endMarkerOffset);

    return {
      samples: output,
      startMarker,
      endMarker,
      sweep,
      offsets: {
        startMarker: startMarkerOffset,
        sweep: sweepOffset,
        endMarker: endMarkerOffset
      },
      durations: {
        preRoll,
        marker: startMarker.length / sampleRate,
        markerGap: gap,
        sweep: sweep.length / sampleRate,
        responseTail,
        postRoll,
        total: output.length / sampleRate
      }
    };
  }

  function fft(real, imag, inverse = false) {
    const n = real.length;
    if (n !== imag.length || (n & (n - 1)) !== 0) throw new Error('FFT長は2の累乗である必要があります。');

    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const tr = real[i]; real[i] = real[j]; real[j] = tr;
        const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
      }
    }

    for (let len = 2; len <= n; len <<= 1) {
      const angle = (inverse ? TAU : -TAU) / len;
      const wLenR = Math.cos(angle);
      const wLenI = Math.sin(angle);
      const half = len >> 1;
      for (let base = 0; base < n; base += len) {
        let wr = 1;
        let wi = 0;
        for (let j = 0; j < half; j++) {
          const even = base + j;
          const odd = even + half;
          const vr = real[odd] * wr - imag[odd] * wi;
          const vi = real[odd] * wi + imag[odd] * wr;
          const ur = real[even];
          const ui = imag[even];
          real[even] = ur + vr;
          imag[even] = ui + vi;
          real[odd] = ur - vr;
          imag[odd] = ui - vi;
          const nextWr = wr * wLenR - wi * wLenI;
          wi = wr * wLenI + wi * wLenR;
          wr = nextWr;
        }
      }
    }

    if (inverse) {
      for (let i = 0; i < n; i++) {
        real[i] /= n;
        imag[i] /= n;
      }
    }
  }

  function normalizedCrossCorrelation(searchSamples, markerSamples, options = {}) {
    const searchStart = clamp(Math.round(options.searchStart ?? 0), 0, searchSamples.length);
    const searchEnd = clamp(Math.round(options.searchEnd ?? searchSamples.length), searchStart, searchSamples.length);
    const search = searchSamples.subarray(searchStart, searchEnd);
    const marker = markerSamples;
    if (search.length < marker.length + 2) return null;

    const n = nextPowerOfTwo(search.length + marker.length - 1);
    const ar = new Float64Array(n);
    const ai = new Float64Array(n);
    const br = new Float64Array(n);
    const bi = new Float64Array(n);
    for (let i = 0; i < search.length; i++) ar[i] = search[i];
    let markerMean = 0;
    for (let i = 0; i < marker.length; i++) markerMean += marker[i];
    markerMean /= marker.length;
    let markerEnergy = 0;
    for (let i = 0; i < marker.length; i++) {
      const value = marker[marker.length - 1 - i] - markerMean;
      br[i] = value;
      markerEnergy += value * value;
    }
    fft(ar, ai, false);
    fft(br, bi, false);
    for (let i = 0; i < n; i++) {
      const rr = ar[i] * br[i] - ai[i] * bi[i];
      const ii = ar[i] * bi[i] + ai[i] * br[i];
      ar[i] = rr;
      ai[i] = ii;
    }
    fft(ar, ai, true);

    const prefix = new Float64Array(search.length + 1);
    for (let i = 0; i < search.length; i++) prefix[i + 1] = prefix[i] + search[i] * search[i];

    const last = search.length - marker.length;
    let bestK = -1;
    let bestScore = -Infinity;
    const scores = new Float64Array(last + 1);
    for (let k = 0; k <= last; k++) {
      const energy = prefix[k + marker.length] - prefix[k];
      const denom = Math.sqrt(Math.max(EPS, markerEnergy * energy));
      const score = ar[k + marker.length - 1] / denom;
      scores[k] = score;
      const absScore = Math.abs(score);
      if (absScore > bestScore) {
        bestScore = absScore;
        bestK = k;
      }
    }
    if (bestK < 0) return null;

    let fraction = 0;
    if (bestK > 0 && bestK < last) {
      const y1 = Math.abs(scores[bestK - 1]);
      const y2 = Math.abs(scores[bestK]);
      const y3 = Math.abs(scores[bestK + 1]);
      const denom = y1 - 2 * y2 + y3;
      if (Math.abs(denom) > 1e-12) fraction = clamp(0.5 * (y1 - y3) / denom, -0.5, 0.5);
    }

    return {
      startSample: searchStart + bestK + fraction,
      score: bestScore,
      signedScore: scores[bestK]
    };
  }

  function removeDc(samples) {
    let mean = 0;
    for (let i = 0; i < samples.length; i++) mean += samples[i];
    mean /= Math.max(1, samples.length);
    const output = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) output[i] = samples[i] - mean;
    return output;
  }

  function deconvolve(recordedSweep, referenceSweep, sampleRate, f0, f1, regularizationDb = -100) {
    const n = nextPowerOfTwo(recordedSweep.length);
    if (referenceSweep.length >= n) throw new Error('解析FFT長が不足しています。スイープ時間または残響時間を短くしてください。');
    const xr = new Float64Array(n);
    const xi = new Float64Array(n);
    const yr = new Float64Array(n);
    const yi = new Float64Array(n);
    for (let i = 0; i < referenceSweep.length; i++) xr[i] = referenceSweep[i];
    for (let i = 0; i < recordedSweep.length; i++) yr[i] = recordedSweep[i];
    fft(xr, xi, false);
    fft(yr, yi, false);

    let maxPower = 0;
    for (let k = 0; k <= n / 2; k++) {
      const p = xr[k] * xr[k] + xi[k] * xi[k];
      if (p > maxPower) maxPower = p;
    }
    const regularization = maxPower * Math.pow(10, regularizationDb / 10);
    const nyquist = sampleRate / 2;
    for (let k = 0; k < n; k++) {
      const folded = k <= n / 2 ? k : n - k;
      const frequency = folded * sampleRate / n;
      const xPower = xr[k] * xr[k] + xi[k] * xi[k];
      const denom = xPower + regularization;
      let hr = (yr[k] * xr[k] + yi[k] * xi[k]) / denom;
      let hi = (yi[k] * xr[k] - yr[k] * xi[k]) / denom;

      // Smooth cosine band limit suppresses unstable inverse outside the sweep band.
      const low0 = Math.max(1, f0 * 0.55);
      const low1 = f0;
      const high0 = Math.min(nyquist * 0.98, f1);
      const high1 = Math.min(nyquist, f1 * 1.08);
      let weight = 1;
      if (frequency < low0 || frequency > high1) weight = 0;
      else if (frequency < low1) weight = 0.5 - 0.5 * Math.cos(Math.PI * (frequency - low0) / Math.max(EPS, low1 - low0));
      else if (frequency > high0) weight = 0.5 + 0.5 * Math.cos(Math.PI * (frequency - high0) / Math.max(EPS, high1 - high0));
      hr *= weight;
      hi *= weight;
      yr[k] = hr;
      yi[k] = hi;
    }
    fft(yr, yi, true);
    return { impulse: yr, fftSize: n };
  }

  function findMainImpulse(impulse, sampleRate, maxSearchSeconds = 0.25) {
    const end = Math.min(impulse.length, Math.round(maxSearchSeconds * sampleRate));
    let best = 0;
    let index = 0;
    for (let i = 0; i < end; i++) {
      const value = Math.abs(impulse[i]);
      if (value > best) {
        best = value;
        index = i;
      }
    }
    return { index, amplitude: best };
  }

  function makeGatedImpulse(impulse, sampleRate, peakIndex, gateMs, responseTailSeconds) {
    const n = impulse.length;
    const output = new Float64Array(n);
    const preSamples = Math.max(1, Math.round(sampleRate * 0.003));
    const start = Math.max(0, peakIndex - preSamples);
    const requestedEnd = gateMs === 'full' || gateMs === 0
      ? peakIndex + Math.round(responseTailSeconds * sampleRate)
      : peakIndex + Math.round(Number(gateMs) * sampleRate / 1000);
    const end = Math.min(n, Math.max(start + 8, requestedEnd));
    const availablePre = Math.max(0, peakIndex - start);
    const leftFade = Math.min(availablePre, Math.max(1, Math.round((end - start) * 0.04)));
    const rightFade = Math.min(Math.max(1, Math.round(sampleRate * 0.012)), Math.max(1, Math.round((end - start) * 0.12)));
    for (let i = start; i < end; i++) {
      let w = 1;
      if (leftFade > 0 && i < start + leftFade) w *= 0.5 - 0.5 * Math.cos(Math.PI * (i - start) / leftFade);
      if (i >= end - rightFade) w *= 0.5 - 0.5 * Math.cos(Math.PI * (end - 1 - i) / rightFade);
      output[i] = impulse[i] * w;
    }
    return { samples: output, start, end, effectiveGateMs: (end - peakIndex) * 1000 / sampleRate };
  }

  function fftImpulse(gatedImpulse) {
    const real = new Float64Array(gatedImpulse);
    const imag = new Float64Array(real.length);
    fft(real, imag, false);
    return { real, imag };
  }

  function interpolateCalibration(calibration, frequency) {
    if (!calibration || calibration.length === 0) return 0;
    if (frequency <= calibration[0].f) return calibration[0].db;
    if (frequency >= calibration[calibration.length - 1].f) return calibration[calibration.length - 1].db;
    let lo = 0;
    let hi = calibration.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (calibration[mid].f <= frequency) lo = mid;
      else hi = mid;
    }
    const a = calibration[lo];
    const b = calibration[hi];
    const x = (Math.log(frequency) - Math.log(a.f)) / (Math.log(b.f) - Math.log(a.f));
    return a.db + (b.db - a.db) * x;
  }

  function sampleFrequencyResponse(spectrum, sampleRate, f0, f1, smoothing, calibration, peakIndex) {
    const n = spectrum.real.length;
    const half = n >> 1;
    const binHz = sampleRate / n;
    const count = 360;
    const magnitude = [];
    const phase = [];
    const halfOctave = smoothing > 0 ? 1 / (2 * smoothing) : 0;

    for (let i = 0; i < count; i++) {
      const f = f0 * Math.pow(f1 / f0, i / (count - 1));
      let lo;
      let hi;
      if (smoothing > 0) {
        lo = Math.max(1, Math.floor((f / Math.pow(2, halfOctave)) / binHz));
        hi = Math.min(half - 1, Math.ceil((f * Math.pow(2, halfOctave)) / binHz));
      } else {
        const center = Math.round(f / binHz);
        lo = Math.max(1, center - 1);
        hi = Math.min(half - 1, center + 1);
      }
      let power = 0;
      let valid = 0;
      for (let k = lo; k <= hi; k++) {
        const re = spectrum.real[k];
        const im = spectrum.imag[k];
        power += re * re + im * im;
        valid++;
      }
      let db = db10(power / Math.max(1, valid));
      db += interpolateCalibration(calibration, f);
      magnitude.push({ f, db });

      const exactBin = clamp(Math.round(f / binHz), 1, half - 1);
      const re = spectrum.real[exactBin];
      const im = spectrum.imag[exactBin];
      const delayCorrection = TAU * f * peakIndex / sampleRate;
      let angle = Math.atan2(im, re) + delayCorrection;
      angle = ((angle + Math.PI) % TAU + TAU) % TAU - Math.PI;
      phase.push({ f, deg: angle * 180 / Math.PI });
    }
    return { magnitude, phase };
  }

  function normalizeMagnitude(points, low, high) {
    const band = points.filter((p) => p.f >= low && p.f <= high);
    if (!band.length) return 0;
    let sum = 0;
    for (const p of band) sum += Math.pow(10, p.db / 10);
    const offset = db10(sum / band.length);
    for (const p of points) p.db -= offset;
    return offset;
  }

  function averageDb(points, low, high) {
    const values = points.filter((p) => p.f >= low && p.f <= high);
    if (!values.length) return null;
    let sum = 0;
    for (const p of values) sum += Math.pow(10, p.db / 10);
    return db10(sum / values.length);
  }

  function findLowExtension(points, thresholdDb) {
    const candidates = points.filter((p) => p.f <= 500 && p.db >= thresholdDb);
    return candidates.length ? candidates[0].f : null;
  }

  function makeImpulseSeries(impulse, sampleRate, peakIndex, effectiveGateMs) {
    const start = Math.max(0, peakIndex - Math.round(sampleRate * 0.005));
    const maxMs = Math.min(Math.max(100, effectiveGateMs), 600);
    const end = Math.min(impulse.length, peakIndex + Math.round(sampleRate * maxMs / 1000));
    const targetCount = 1800;
    const step = Math.max(1, Math.floor((end - start) / targetCount));
    let peak = 0;
    for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(impulse[i]));
    const series = [];
    for (let i = start; i < end; i += step) {
      let localMax = 0;
      let signed = 0;
      for (let j = i; j < Math.min(end, i + step); j++) {
        if (Math.abs(impulse[j]) > localMax) {
          localMax = Math.abs(impulse[j]);
          signed = impulse[j];
        }
      }
      const normalized = peak > 0 ? signed / peak : 0;
      series.push({
        tMs: (i - peakIndex) * 1000 / sampleRate,
        value: normalized,
        etcDb: Math.max(-100, db20(localMax / Math.max(EPS, peak)))
      });
    }
    return series;
  }

  function estimateTrackingAmplitude(samples, sampleRate, f0, f1, duration, timeScale, peakDelaySamples, targetFrequency, harmonic) {
    const logRatio = Math.log(f1 / f0);
    const L = duration / logRatio;
    const nominalCenterTime = L * Math.log(targetFrequency / f0);
    const center = peakDelaySamples + nominalCenterTime * sampleRate * timeScale;
    const windowSeconds = clamp(10 / Math.max(20, targetFrequency), 0.028, 0.14);
    const half = Math.round(windowSeconds * sampleRate / 2);
    const start = Math.max(0, Math.floor(center - half));
    const end = Math.min(samples.length, Math.ceil(center + half));
    if (end - start < 32) return 0;
    let real = 0;
    let imag = 0;
    let weightSum = 0;
    for (let i = start; i < end; i++) {
      const sourceTime = (i - peakDelaySamples) / (sampleRate * timeScale);
      if (sourceTime < 0 || sourceTime > duration) continue;
      const relative = (i - start) / Math.max(1, end - start - 1);
      const w = 0.5 - 0.5 * Math.cos(TAU * relative);
      const phase = harmonic * logSweepPhase(sourceTime, f0, f1, duration);
      real += samples[i] * w * Math.cos(phase);
      imag -= samples[i] * w * Math.sin(phase);
      weightSum += w;
    }
    return weightSum > 0 ? 2 * Math.hypot(real, imag) / weightSum : 0;
  }

  function estimateThd(recordedSweep, sampleRate, config, peakIndex) {
    const f0 = Number(config.startFreq);
    const f1 = Number(config.endFreq);
    const duration = Number(config.sweepDuration);
    const timeScale = Number(config.timeScale ?? 1);
    const maxFundamental = Math.min(f1 / 5, sampleRate * 0.45 / 5, 10000);
    const minFundamental = Math.max(f0 * 1.25, 30);
    if (maxFundamental <= minFundamental) return [];
    const points = [];
    const count = 72;
    for (let i = 0; i < count; i++) {
      const f = minFundamental * Math.pow(maxFundamental / minFundamental, i / (count - 1));
      const a1 = estimateTrackingAmplitude(recordedSweep, sampleRate, f0, f1, duration, timeScale, peakIndex, f, 1);
      if (!(a1 > 1e-8)) continue;
      let harmonicPower = 0;
      for (let h = 2; h <= 5; h++) {
        if (h * f >= sampleRate * 0.48) break;
        const ah = estimateTrackingAmplitude(recordedSweep, sampleRate, f0, f1, duration, timeScale, peakIndex, f, h);
        harmonicPower += ah * ah;
      }
      const ratio = Math.sqrt(harmonicPower) / a1;
      points.push({ f, percent: ratio * 100, db: db20(ratio) });
    }
    return points;
  }

  function countClipping(samples, threshold = 0.995) {
    let count = 0;
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const value = Math.abs(samples[i]);
      if (value >= threshold) count++;
      if (value > peak) peak = value;
    }
    return { count, percent: count * 100 / Math.max(1, samples.length), peak };
  }

  function analyzeMeasurement(recordedInput, sampleRate, config, progress = () => {}) {
    const recorded = removeDc(recordedInput);
    const startMarker = generateMarker(sampleRate, config.markerLevel, 'start');
    const endMarker = generateMarker(sampleRate, config.markerLevel, 'end');

    progress(0.05, '開始マーカーを相互相関で検出しています…');
    const startSearchEnd = Math.min(recorded.length, Math.round(sampleRate * 4.5));
    const startDetection = normalizedCrossCorrelation(recorded, startMarker, {
      searchStart: 0,
      searchEnd: startSearchEnd
    });
    if (!startDetection || startDetection.score < 0.055) {
      throw new Error('開始マーカーを十分な確度で検出できませんでした。出力音量、周囲騒音、スピーカーとの接続を確認してください。');
    }

    const expectedMarkerInterval = (
      startMarker.length / sampleRate +
      Number(config.markerGap) +
      Number(config.sweepDuration) +
      Number(config.responseTail)
    );
    const predictedEnd = startDetection.startSample + expectedMarkerInterval * sampleRate;
    const endWindow = Math.round(sampleRate * 1.35);

    progress(0.12, '終了マーカーを検出し、クロック差を推定しています…');
    const endDetection = normalizedCrossCorrelation(recorded, endMarker, {
      searchStart: Math.max(0, predictedEnd - endWindow),
      searchEnd: Math.min(recorded.length, predictedEnd + endWindow + endMarker.length)
    });

    let timeScale = 1;
    let driftPpm = null;
    if (endDetection && endDetection.score >= 0.045) {
      const observed = endDetection.startSample - startDetection.startSample;
      const expected = expectedMarkerInterval * sampleRate;
      timeScale = clamp(observed / expected, 0.995, 1.005);
      driftPpm = (timeScale - 1) * 1e6;
    }

    const sweepStartFloat = startDetection.startSample + (
      startMarker.length / sampleRate + Number(config.markerGap)
    ) * sampleRate * timeScale;
    const sweepStart = Math.max(0, Math.round(sweepStartFloat));
    const sweepCount = Math.round(Number(config.sweepDuration) * sampleRate * timeScale);
    const tailCount = Math.round(Number(config.responseTail) * sampleRate * timeScale);
    const recordedSweepEnd = Math.min(recorded.length, sweepStart + sweepCount + tailCount);
    if (recordedSweepEnd - sweepStart < sweepCount + Math.round(sampleRate * 0.25)) {
      throw new Error('スイープ後半または残響区間が不足しています。録音が途中で停止した可能性があります。');
    }

    const recordedSweep = recorded.slice(sweepStart, recordedSweepEnd);
    const referenceSweep = generateLogSweep(
      sampleRate,
      Number(config.startFreq),
      Number(config.endFreq),
      Number(config.sweepDuration),
      Number(config.level),
      timeScale
    );

    progress(0.22, '正則化デコンボリューションを実行しています…');
    const deconvolved = deconvolve(
      recordedSweep,
      referenceSweep,
      sampleRate,
      Number(config.startFreq),
      Number(config.endFreq),
      Number(config.regularizationDb ?? -100)
    );
    const peak = findMainImpulse(deconvolved.impulse, sampleRate, 0.28);

    progress(0.55, 'インパルス応答へ時間窓を適用しています…');
    const gated = makeGatedImpulse(
      deconvolved.impulse,
      sampleRate,
      peak.index,
      config.gateMs,
      Number(config.responseTail) * timeScale
    );
    const spectrum = fftImpulse(gated.samples);

    progress(0.72, '振幅・位相特性を算出しています…');
    const response = sampleFrequencyResponse(
      spectrum,
      sampleRate,
      Number(config.startFreq),
      Math.min(Number(config.endFreq), sampleRate * 0.47),
      Number(config.smoothing),
      Array.isArray(config.calibration) ? config.calibration : [],
      peak.index
    );
    let normalizationOffset = 0;
    if (config.normalize !== false) {
      normalizationOffset = normalizeMagnitude(
        response.magnitude,
        Number(config.normalizeLow ?? 500),
        Number(config.normalizeHigh ?? 2000)
      );
    }

    progress(0.84, '参考THDをトラッキング解析しています…');
    const thd = estimateThd(recordedSweep, sampleRate, { ...config, timeScale }, peak.index);

    const impulseSeries = makeImpulseSeries(deconvolved.impulse, sampleRate, peak.index, gated.effectiveGateMs);
    const noiseEnd = Math.max(0, Math.floor(startDetection.startSample - sampleRate * 0.08));
    const noiseStart = Math.max(0, noiseEnd - Math.round(sampleRate * 0.45));
    const noiseRms = rms(recorded, noiseStart, noiseEnd);
    const signalRms = rms(recordedSweep, 0, Math.min(recordedSweep.length, sweepCount));
    const clipping = countClipping(recorded);
    const peakPoint = response.magnitude.reduce((best, point) => point.db > best.db ? point : best, response.magnitude[0]);
    const latencyMs = (startDetection.startSample - Number(config.preRoll) * sampleRate) * 1000 / sampleRate;

    progress(0.96, '測定品質を評価しています…');
    return {
      version: '3.3.0',
      sampleRate,
      magnitude: response.magnitude,
      phase: response.phase,
      impulse: impulseSeries,
      thd,
      summary: {
        latencyMs,
        startMarkerScore: startDetection.score,
        endMarkerScore: endDetection?.score ?? null,
        driftPpm,
        timeScale,
        directArrivalMs: peak.index * 1000 / sampleRate,
        effectiveGateMs: gated.effectiveGateMs,
        noiseDbfs: db20(noiseRms),
        signalDbfs: db20(signalRms),
        snrDb: db20(signalRms) - db20(noiseRms),
        inputPeakDbfs: db20(clipping.peak),
        clippingPercent: clipping.percent,
        peakFrequency: peakPoint?.f ?? null,
        peakDb: peakPoint?.db ?? null,
        minus3Hz: findLowExtension(response.magnitude, -3),
        minus6Hz: findLowExtension(response.magnitude, -6),
        lowBandDb: averageDb(response.magnitude, 40, 200),
        midBandDb: averageDb(response.magnitude, 500, 2000),
        highBandDb: averageDb(response.magnitude, 4000, 12000),
        normalizationOffsetDb: normalizationOffset
      }
    };
  }

  return {
    clamp,
    nextPowerOfTwo,
    rms,
    db20,
    db10,
    logSweepPhase,
    generateLogSweep,
    generateMarker,
    buildMeasurementSignal,
    fft,
    normalizedCrossCorrelation,
    analyzeMeasurement
  };
});
