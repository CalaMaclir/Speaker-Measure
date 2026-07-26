/* Speaker Measure Pro 4.0 DSP core - dependency free */
(function attachSpeakerDSP(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SpeakerDSP = api;
})(typeof self !== 'undefined' ? self : globalThis, function createSpeakerDSP() {
  'use strict';

  const TAU = Math.PI * 2;
  const EPS = 1e-24;
  const BARKER_7 = [1, 1, 1, -1, -1, 1, -1];

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

  function raisedCosineIn(position) {
    return 0.5 - 0.5 * Math.cos(Math.PI * clamp(position, 0, 1));
  }

  function generateLogSweep(sampleRate, f0, f1, duration, level = 0.25, timeScale = 1, options = {}) {
    if (!(sampleRate > 0 && f0 > 0 && f1 > f0 && duration > 0 && timeScale > 0)) {
      throw new Error('スイープ信号の設定値が不正です。');
    }
    const count = Math.max(1, Math.round(sampleRate * duration * timeScale));
    const output = new Float32Array(count);
    const fadeInSeconds = Number(options.fadeInSeconds ?? 0.085);
    const fadeOutSeconds = Number(options.fadeOutSeconds ?? 0.11);
    const fadeIn = Math.max(1, Math.round(sampleRate * fadeInSeconds * timeScale));
    const fadeOut = Math.max(1, Math.round(sampleRate * fadeOutSeconds * timeScale));
    for (let i = 0; i < count; i++) {
      const nominalTime = i / (sampleRate * timeScale);
      let envelope = 1;
      if (i < fadeIn) envelope *= raisedCosineIn(i / fadeIn);
      if (i >= count - fadeOut) envelope *= raisedCosineIn((count - 1 - i) / fadeOut);
      output[i] = Math.sin(logSweepPhase(nominalTime, f0, f1, duration)) * level * envelope;
    }
    return output;
  }

  function fillLogChirp(target, offset, sampleRate, f0, f1, duration, level, polarity = 1) {
    const count = Math.min(target.length - offset, Math.round(sampleRate * duration));
    if (count <= 0) return 0;
    const fade = Math.max(1, Math.round(sampleRate * Math.min(0.004, duration * 0.18)));
    const logRatio = Math.log(f1 / f0);
    const L = duration / logRatio;
    const K = TAU * f0 * L;
    for (let i = 0; i < count; i++) {
      const t = i / sampleRate;
      let envelope = 1;
      if (i < fade) envelope *= raisedCosineIn(i / fade);
      if (i >= count - fade) envelope *= raisedCosineIn((count - 1 - i) / fade);
      target[offset + i] = polarity * level * envelope * Math.sin(K * (Math.exp(t / L) - 1));
    }
    return count;
  }

  function generateMarker(sampleRate, level = 0.30, variant = 'start') {
    // Barker-coded chirp packets provide a sharp correlation peak while keeping
    // marker energy well below the 20 kHz analysis edge.
    const chipDuration = 0.025;
    const chipGap = 0.003;
    const chipSamples = Math.round(sampleRate * chipDuration);
    const gapSamples = Math.round(sampleRate * chipGap);
    const total = BARKER_7.length * chipSamples + (BARKER_7.length - 1) * gapSamples;
    const output = new Float32Array(total);
    const code = variant === 'start' ? BARKER_7 : [...BARKER_7].reverse().map((v, i) => i % 2 ? -v : v);
    for (let chip = 0; chip < code.length; chip++) {
      const offset = chip * (chipSamples + gapSamples);
      const alternate = chip % 2 === 1;
      let f0;
      let f1;
      if (variant === 'start') {
        f0 = alternate ? 2850 : 720;
        f1 = alternate ? 980 : 3180;
      } else {
        f0 = alternate ? 7900 : 4050;
        f1 = alternate ? 4550 : 8250;
      }
      fillLogChirp(output, offset, sampleRate, f0, f1, chipDuration, level, code[chip]);
    }
    return output;
  }

  function computeExcitationBand(sampleRate, displayStart, displayEnd) {
    const nyquist = sampleRate / 2;
    const excitationStart = Math.max(8, displayStart / 1.30);
    const excitationEnd = Math.min(sampleRate * 0.455, displayEnd * 1.10);
    const safeStart = Math.max(displayStart, excitationStart * 1.16);
    const safeEnd = Math.min(displayEnd, excitationEnd / 1.06, sampleRate * 0.44);
    return {
      displayStart,
      displayEnd,
      excitationStart,
      excitationEnd,
      safeStart,
      safeEnd,
      nyquist,
      hasUpperGuard: excitationEnd >= displayEnd * 1.055,
      hasLowerGuard: excitationStart <= displayStart / 1.12
    };
  }

  function buildMeasurementSignal(sampleRate, config) {
    const preRoll = Number(config.preRoll ?? 0.65);
    const markerGap = Number(config.markerGap ?? 0.75);
    const responseTail = Number(config.responseTail ?? 2.2);
    const endMarkerGuard = Number(config.endMarkerGuard ?? 0.55);
    const postRoll = Number(config.postRoll ?? 0.45);
    const level = Number(config.level ?? 0.25);
    const markerLevel = clamp(Math.max(level * 1.25, 0.18), 0.12, 0.50);
    const band = computeExcitationBand(sampleRate, Number(config.startFreq), Number(config.endFreq));
    if (!(band.excitationEnd > band.excitationStart * 1.2)) {
      throw new Error('サンプリング周波数に対して終了周波数が高すぎます。');
    }

    const startMarker = generateMarker(sampleRate, markerLevel, 'start');
    const endMarker = generateMarker(sampleRate, markerLevel, 'end');
    const sweep = generateLogSweep(
      sampleRate,
      band.excitationStart,
      band.excitationEnd,
      Number(config.sweepDuration),
      level,
      1,
      { fadeInSeconds: 0.085, fadeOutSeconds: 0.035 }
    );

    const preSamples = Math.round(preRoll * sampleRate);
    const gapSamples = Math.round(markerGap * sampleRate);
    const tailSamples = Math.round(responseTail * sampleRate);
    const guardSamples = Math.round(endMarkerGuard * sampleRate);
    const postSamples = Math.round(postRoll * sampleRate);
    const startMarkerOffset = preSamples;
    const sweepOffset = startMarkerOffset + startMarker.length + gapSamples;
    const analysisEndOffset = sweepOffset + sweep.length + tailSamples;
    const endMarkerOffset = analysisEndOffset + guardSamples;
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
      band,
      offsets: {
        startMarker: startMarkerOffset,
        sweep: sweepOffset,
        analysisEnd: analysisEndOffset,
        endMarker: endMarkerOffset
      },
      durations: {
        preRoll,
        marker: startMarker.length / sampleRate,
        markerGap,
        sweep: sweep.length / sampleRate,
        responseTail,
        endMarkerGuard,
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
    const minimumWindowEnergy = Math.max(EPS, markerEnergy * 1e-8);
    for (let k = 0; k <= last; k++) {
      const energy = prefix[k + marker.length] - prefix[k];
      if (!(energy > minimumWindowEnergy)) {
        scores[k] = 0;
        continue;
      }
      const denom = Math.sqrt(markerEnergy * energy);
      const score = clamp(ar[k + marker.length - 1] / denom, -1, 1);
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
      const denominator = y1 - 2 * y2 + y3;
      if (Math.abs(denominator) > 1e-12) fraction = clamp(0.5 * (y1 - y3) / denominator, -0.5, 0.5);
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

  function sinc(value) {
    if (Math.abs(value) < 1e-12) return 1;
    const x = Math.PI * value;
    return Math.sin(x) / x;
  }

  function resampleClockCorrected(samples, outputLength, timeScale, startOffset = 0, lobes = 6) {
    const output = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i++) {
      const position = startOffset + i * timeScale;
      const center = Math.floor(position);
      let sum = 0;
      let weightSum = 0;
      const first = center - lobes + 1;
      const last = center + lobes;
      for (let sourceIndex = first; sourceIndex <= last; sourceIndex++) {
        if (sourceIndex < 0 || sourceIndex >= samples.length) continue;
        const distance = position - sourceIndex;
        if (Math.abs(distance) >= lobes) continue;
        const weight = sinc(distance) * sinc(distance / lobes);
        sum += samples[sourceIndex] * weight;
        weightSum += weight;
      }
      output[i] = Math.abs(weightSum) > EPS ? sum / weightSum : 0;
    }
    return output;
  }

  function cosineBandWeight(frequency, low0, low1, high0, high1) {
    if (frequency <= low0 || frequency >= high1) return 0;
    if (frequency < low1) return raisedCosineIn((frequency - low0) / Math.max(EPS, low1 - low0));
    if (frequency <= high0) return 1;
    return raisedCosineIn((high1 - frequency) / Math.max(EPS, high1 - high0));
  }

  function deconvolve(recordedSweep, referenceSweep, sampleRate, band, regularizationDb = -96) {
    const n = nextPowerOfTwo(recordedSweep.length);
    if (referenceSweep.length >= n) throw new Error('解析FFT長が不足しています。残響収録時間を増やしてください。');
    const xr = new Float64Array(n);
    const xi = new Float64Array(n);
    const yr = new Float64Array(n);
    const yi = new Float64Array(n);
    for (let i = 0; i < referenceSweep.length; i++) xr[i] = referenceSweep[i];
    for (let i = 0; i < recordedSweep.length; i++) yr[i] = recordedSweep[i];
    fft(xr, xi, false);
    fft(yr, yi, false);

    const half = n >> 1;
    let maxPower = 0;
    for (let k = 0; k <= half; k++) {
      const power = xr[k] * xr[k] + xi[k] * xi[k];
      if (power > maxPower) maxPower = power;
    }
    const regularization = maxPower * Math.pow(10, regularizationDb / 10);
    const referenceSupportDb = new Float32Array(half + 1);
    for (let k = 0; k <= half; k++) {
      const power = xr[k] * xr[k] + xi[k] * xi[k];
      referenceSupportDb[k] = db10(power / Math.max(EPS, maxPower));
    }

    const nyquist = sampleRate / 2;
    const low0 = Math.max(1, band.excitationStart * 0.70);
    const low1 = band.excitationStart;
    const high0 = band.excitationEnd;
    const high1 = Math.min(nyquist * 0.995, band.excitationEnd * 1.055);

    for (let k = 0; k < n; k++) {
      const folded = k <= half ? k : n - k;
      const frequency = folded * sampleRate / n;
      const xPower = xr[k] * xr[k] + xi[k] * xi[k];
      const denominator = xPower + regularization;
      let hr = (yr[k] * xr[k] + yi[k] * xi[k]) / denominator;
      let hi = (yi[k] * xr[k] - yr[k] * xi[k]) / denominator;
      const weight = cosineBandWeight(frequency, low0, low1, high0, high1);
      hr *= weight;
      hi *= weight;
      yr[k] = hr;
      yi[k] = hi;
    }
    fft(yr, yi, true);
    return { impulse: yr, fftSize: n, referenceSupportDb };
  }

  function findMainImpulse(impulse, sampleRate, maxSearchSeconds = 0.45) {
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

  function fullWindowValue(type, x) {
    x = clamp(x, 0, 1);
    if (type === 'hann') return 0.5 - 0.5 * Math.cos(TAU * x);
    if (type === 'blackman-harris') {
      const a0 = 0.35875;
      const a1 = 0.48829;
      const a2 = 0.14128;
      const a3 = 0.01168;
      return a0 - a1 * Math.cos(TAU * x) + a2 * Math.cos(2 * TAU * x) - a3 * Math.cos(3 * TAU * x);
    }
    // Tukey-like cosine edge.
    return 0.5 - 0.5 * Math.cos(TAU * x);
  }

  function halfWindowIn(type, position) {
    return fullWindowValue(type, 0.5 * clamp(position, 0, 1));
  }

  function halfWindowOut(type, position) {
    return fullWindowValue(type, 0.5 + 0.5 * clamp(position, 0, 1));
  }

  function makeGatedImpulse(impulse, sampleRate, peakIndex, gateMs, responseTailSeconds, windowType = 'blackman-harris') {
    const n = impulse.length;
    const output = new Float64Array(n);
    const preSamples = Math.max(1, Math.round(sampleRate * 0.004));
    const start = Math.max(0, peakIndex - preSamples);
    const requestedEnd = gateMs === 'full' || gateMs === 0
      ? peakIndex + Math.round(responseTailSeconds * sampleRate)
      : peakIndex + Math.round(Number(gateMs) * sampleRate / 1000);
    const end = Math.min(n, Math.max(start + 16, requestedEnd));
    const leftFade = Math.max(1, peakIndex - start);
    const rightFade = Math.min(
      Math.max(1, Math.round(sampleRate * 0.080)),
      Math.max(1, Math.round((end - peakIndex) * 0.20))
    );
    for (let i = start; i < end; i++) {
      let weight = 1;
      if (i < peakIndex) weight *= halfWindowIn(windowType, (i - start) / Math.max(1, leftFade));
      if (i >= end - rightFade) weight *= halfWindowOut(windowType, (i - (end - rightFade)) / Math.max(1, rightFade - 1));
      output[i] = impulse[i] * weight;
    }
    return {
      samples: output,
      start,
      end,
      effectiveGateMs: (end - peakIndex) * 1000 / sampleRate,
      windowType
    };
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
    const ratio = (Math.log(frequency) - Math.log(a.f)) / (Math.log(b.f) - Math.log(a.f));
    return a.db + (b.db - a.db) * ratio;
  }

  function unwrapAngles(wrappedAngles) {
    const result = new Float64Array(wrappedAngles.length);
    if (!wrappedAngles.length) return result;
    result[0] = wrappedAngles[0];
    for (let i = 1; i < wrappedAngles.length; i++) {
      let angle = wrappedAngles[i];
      const previous = result[i - 1];
      while (angle - previous > Math.PI) angle -= TAU;
      while (angle - previous < -Math.PI) angle += TAU;
      result[i] = angle;
    }
    return result;
  }

  function localLinearSlope(xs, ys, center, radius, validMask) {
    const start = Math.max(0, center - radius);
    const end = Math.min(xs.length - 1, center + radius);
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    for (let i = start; i <= end; i++) {
      if (validMask && !validMask[i]) continue;
      sumX += xs[i];
      sumY += ys[i];
      count++;
    }
    if (count < 3) return NaN;
    const meanX = sumX / count;
    const meanY = sumY / count;
    let numerator = 0;
    let denominator = 0;
    for (let i = start; i <= end; i++) {
      if (validMask && !validMask[i]) continue;
      const dx = xs[i] - meanX;
      numerator += dx * (ys[i] - meanY);
      denominator += dx * dx;
    }
    return denominator > EPS ? numerator / denominator : NaN;
  }

  function medianSmooth(points, key, radius = 2) {
    const values = points.map((point) => point[key]);
    return points.map((point, index) => {
      const local = [];
      for (let i = Math.max(0, index - radius); i <= Math.min(points.length - 1, index + radius); i++) {
        if (Number.isFinite(values[i])) local.push(values[i]);
      }
      local.sort((a, b) => a - b);
      const value = local.length ? local[Math.floor(local.length / 2)] : NaN;
      return { ...point, [key]: value };
    });
  }

  function sampleFrequencyResponse(spectrum, referenceSupportDb, sampleRate, band, smoothing, calibration, peakIndex) {
    const n = spectrum.real.length;
    const half = n >> 1;
    const binHz = sampleRate / n;
    const count = 420;
    const magnitude = [];
    const wrappedRadians = [];
    const angularFrequencies = [];
    const validMask = [];
    const halfOctave = smoothing > 0 ? 1 / (2 * smoothing) : 0;

    for (let i = 0; i < count; i++) {
      const frequency = band.displayStart * Math.pow(band.displayEnd / band.displayStart, i / (count - 1));
      let lo;
      let hi;
      if (smoothing > 0) {
        lo = Math.max(1, Math.floor((frequency / Math.pow(2, halfOctave)) / binHz));
        hi = Math.min(half - 1, Math.ceil((frequency * Math.pow(2, halfOctave)) / binHz));
      } else {
        const center = Math.round(frequency / binHz);
        lo = Math.max(1, center - 1);
        hi = Math.min(half - 1, center + 1);
      }
      let power = 0;
      let supportPower = 0;
      let validBins = 0;
      for (let k = lo; k <= hi; k++) {
        const re = spectrum.real[k];
        const im = spectrum.imag[k];
        power += re * re + im * im;
        supportPower += Math.pow(10, referenceSupportDb[k] / 10);
        validBins++;
      }
      let db = db10(power / Math.max(1, validBins));
      db += interpolateCalibration(calibration, frequency);
      const supportDb = db10(supportPower / Math.max(1, validBins));
      const valid = frequency >= band.safeStart && frequency <= band.safeEnd && supportDb > -58;
      magnitude.push({ f: frequency, db, valid, supportDb });
      validMask.push(valid);

      const exactBin = clamp(Math.round(frequency / binHz), 1, half - 1);
      const re = spectrum.real[exactBin];
      const im = spectrum.imag[exactBin];
      const delayCorrection = TAU * frequency * peakIndex / sampleRate;
      let angle = Math.atan2(im, re) + delayCorrection;
      angle = ((angle + Math.PI) % TAU + TAU) % TAU - Math.PI;
      wrappedRadians.push(angle);
      angularFrequencies.push(TAU * frequency);
    }

    const unwrappedRadians = unwrapAngles(wrappedRadians);
    const phase = magnitude.map((point, index) => ({
      f: point.f,
      deg: wrappedRadians[index] * 180 / Math.PI,
      unwrappedDeg: unwrappedRadians[index] * 180 / Math.PI,
      valid: point.valid
    }));

    let groupDelay = magnitude.map((point, index) => {
      const slope = localLinearSlope(angularFrequencies, unwrappedRadians, index, 4, validMask);
      return { f: point.f, ms: Number.isFinite(slope) ? -slope * 1000 : NaN, valid: point.valid };
    });
    groupDelay = medianSmooth(groupDelay, 'ms', 2);

    return { magnitude, phase, groupDelay };
  }

  function normalizeMagnitude(points, low, high) {
    const band = points.filter((point) => point.valid !== false && point.f >= low && point.f <= high);
    if (!band.length) return 0;
    let sum = 0;
    for (const point of band) sum += Math.pow(10, point.db / 10);
    const offset = db10(sum / band.length);
    for (const point of points) point.db -= offset;
    return offset;
  }

  function averageDb(points, low, high) {
    const values = points.filter((point) => point.valid !== false && point.f >= low && point.f <= high);
    if (!values.length) return null;
    let sum = 0;
    for (const point of values) sum += Math.pow(10, point.db / 10);
    return db10(sum / values.length);
  }

  function findLowExtension(points, thresholdDb) {
    const candidates = points.filter((point) => point.valid !== false && point.f <= 500 && point.db >= thresholdDb);
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

  function makeStepSeries(gatedImpulse, sampleRate, peakIndex, effectiveGateMs) {
    const start = Math.max(0, peakIndex - Math.round(sampleRate * 0.005));
    const end = Math.min(gatedImpulse.length, peakIndex + Math.round(sampleRate * Math.min(500, Math.max(100, effectiveGateMs)) / 1000));
    let baseline = 0;
    const baselineEnd = Math.max(start + 1, peakIndex - Math.round(sampleRate * 0.001));
    for (let i = start; i < baselineEnd; i++) baseline += gatedImpulse[i];
    baseline /= Math.max(1, baselineEnd - start);
    const cumulative = new Float64Array(end - start);
    let value = 0;
    let maxAbs = 0;
    for (let i = start; i < end; i++) {
      value += gatedImpulse[i] - baseline;
      cumulative[i - start] = value;
      maxAbs = Math.max(maxAbs, Math.abs(value));
    }
    const targetCount = 1600;
    const stride = Math.max(1, Math.floor(cumulative.length / targetCount));
    const output = [];
    for (let i = 0; i < cumulative.length; i += stride) {
      output.push({
        tMs: (start + i - peakIndex) * 1000 / sampleRate,
        value: maxAbs > EPS ? cumulative[i] / maxAbs : 0
      });
    }
    return output;
  }

  function estimateTrackingAmplitude(samples, sampleRate, f0, f1, duration, timeScale, peakDelaySamples, targetFrequency, harmonic) {
    const logRatio = Math.log(f1 / f0);
    const L = duration / logRatio;
    const nominalCenterTime = L * Math.log(targetFrequency / f0);
    const center = peakDelaySamples + nominalCenterTime * sampleRate * timeScale;
    const windowSeconds = clamp(16 / Math.max(20, targetFrequency), 0.024, 0.36);
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
      const weight = 0.5 - 0.5 * Math.cos(TAU * relative);
      const phase = harmonic * logSweepPhase(sourceTime, f0, f1, duration);
      real += samples[i] * weight * Math.cos(phase);
      imag -= samples[i] * weight * Math.sin(phase);
      weightSum += weight;
    }
    return weightSum > 0 ? 2 * Math.hypot(real, imag) / weightSum : 0;
  }

  function estimateTrackedMagnitude(recordedSweepObserved, sampleRate, config, band, timeScale, delayObservedSamples, calibration, smoothing, supportTemplate) {
    const count = supportTemplate.length;
    const raw = [];
    for (let i = 0; i < count; i++) {
      const frequency = supportTemplate[i].f;
      const amplitude = estimateTrackingAmplitude(
        recordedSweepObserved,
        sampleRate,
        band.excitationStart,
        band.excitationEnd,
        Number(config.sweepDuration),
        timeScale,
        delayObservedSamples,
        frequency,
        1
      );
      raw.push({
        f: frequency,
        power: amplitude * amplitude,
        valid: supportTemplate[i].valid,
        supportDb: supportTemplate[i].supportDb
      });
    }
    const halfOctave = smoothing > 0 ? 1 / (2 * smoothing) : 0;
    return raw.map((point, index) => {
      let power = point.power;
      if (smoothing > 0) {
        const low = point.f / Math.pow(2, halfOctave);
        const high = point.f * Math.pow(2, halfOctave);
        let sum = 0;
        let countInBand = 0;
        for (let j = 0; j < raw.length; j++) {
          if (raw[j].f < low || raw[j].f > high) continue;
          sum += raw[j].power;
          countInBand++;
        }
        if (countInBand) power = sum / countInBand;
      }
      return {
        f: point.f,
        db: db10(power) + interpolateCalibration(calibration, point.f),
        valid: point.valid,
        supportDb: point.supportDb
      };
    });
  }

  function estimateThd(recordedSweep, sampleRate, config, peakIndex, safeBand) {
    const f0 = Number(config.excitationStartFreq);
    const f1 = Number(config.excitationEndFreq);
    const duration = Number(config.sweepDuration);
    const timeScale = Number(config.timeScale ?? 1);
    const maxFundamental = Math.min(safeBand.safeEnd / 5, f1 / 5, sampleRate * 0.45 / 5, 10000);
    const minFundamental = Math.max(safeBand.safeStart, f0 * 1.25, 30);
    if (maxFundamental <= minFundamental) return [];
    const points = [];
    const count = 76;
    for (let i = 0; i < count; i++) {
      const frequency = minFundamental * Math.pow(maxFundamental / minFundamental, i / (count - 1));
      const fundamental = estimateTrackingAmplitude(recordedSweep, sampleRate, f0, f1, duration, timeScale, peakIndex, frequency, 1);
      if (!(fundamental > 1e-8)) continue;
      const harmonics = {};
      let harmonicPower = 0;
      for (let harmonic = 2; harmonic <= 5; harmonic++) {
        if (harmonic * frequency >= sampleRate * 0.47) {
          harmonics[`h${harmonic}`] = null;
          continue;
        }
        const amplitude = estimateTrackingAmplitude(recordedSweep, sampleRate, f0, f1, duration, timeScale, peakIndex, frequency, harmonic);
        const ratio = amplitude / fundamental;
        harmonics[`h${harmonic}`] = ratio * 100;
        harmonicPower += amplitude * amplitude;
      }
      const totalRatio = Math.sqrt(harmonicPower) / fundamental;
      points.push({
        f: frequency,
        percent: totalRatio * 100,
        db: db20(totalRatio),
        h2: harmonics.h2,
        h3: harmonics.h3,
        h4: harmonics.h4,
        h5: harmonics.h5
      });
    }
    return points;
  }

  function computeDecayMap(impulse, sampleRate, peakIndex, band, effectiveGateMs) {
    const fftSize = sampleRate >= 46000 ? 8192 : 8192;
    const windowMs = fftSize * 1000 / sampleRate;
    const availableMs = Math.max(0, Math.min(500, effectiveGateMs - windowMs * 0.55));
    const maxTimeMs = Math.max(80, availableMs);
    const timeCount = 48;
    const frequencyCount = 96;
    const timesMs = [];
    const frequencies = [];
    for (let i = 0; i < timeCount; i++) timesMs.push(maxTimeMs * i / (timeCount - 1));
    for (let i = 0; i < frequencyCount; i++) {
      frequencies.push(band.safeStart * Math.pow(band.safeEnd / band.safeStart, i / (frequencyCount - 1)));
    }

    const raw = Array.from({ length: timeCount }, () => new Float32Array(frequencyCount));
    const binHz = sampleRate / fftSize;
    for (let timeIndex = 0; timeIndex < timeCount; timeIndex++) {
      const start = peakIndex + Math.round(timesMs[timeIndex] * sampleRate / 1000);
      const real = new Float64Array(fftSize);
      const imag = new Float64Array(fftSize);
      for (let i = 0; i < fftSize; i++) {
        const sourceIndex = start + i;
        const sample = sourceIndex < impulse.length ? impulse[sourceIndex] : 0;
        const window = 0.5 - 0.5 * Math.cos(TAU * i / Math.max(1, fftSize - 1));
        real[i] = sample * window;
      }
      fft(real, imag, false);
      for (let frequencyIndex = 0; frequencyIndex < frequencyCount; frequencyIndex++) {
        const center = clamp(Math.round(frequencies[frequencyIndex] / binHz), 1, fftSize / 2 - 1);
        const low = Math.max(1, center - 1);
        const high = Math.min(fftSize / 2 - 1, center + 1);
        let power = 0;
        for (let k = low; k <= high; k++) power += real[k] * real[k] + imag[k] * imag[k];
        raw[timeIndex][frequencyIndex] = db10(power / (high - low + 1));
      }
    }

    const valuesDb = Array.from({ length: timeCount }, () => new Float32Array(frequencyCount));
    for (let frequencyIndex = 0; frequencyIndex < frequencyCount; frequencyIndex++) {
      let maximum = -Infinity;
      for (let timeIndex = 0; timeIndex < timeCount; timeIndex++) maximum = Math.max(maximum, raw[timeIndex][frequencyIndex]);
      for (let timeIndex = 0; timeIndex < timeCount; timeIndex++) {
        valuesDb[timeIndex][frequencyIndex] = clamp(raw[timeIndex][frequencyIndex] - maximum, -60, 0);
      }
    }

    return {
      timesMs,
      frequencies,
      valuesDb: valuesDb.map((row) => Array.from(row)),
      floorDb: -60,
      ceilingDb: 0,
      windowMs
    };
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
    const markerLevel = Number(config.markerLevel);
    const startMarker = generateMarker(sampleRate, markerLevel, 'start');
    const endMarker = generateMarker(sampleRate, markerLevel, 'end');
    const band = computeExcitationBand(sampleRate, Number(config.startFreq), Number(config.endFreq));

    progress(0.04, '開始マーカーを符号化相互相関で検出しています…');
    const startSearchEnd = Math.min(recorded.length, Math.round(sampleRate * 5.0));
    const startDetection = normalizedCrossCorrelation(recorded, startMarker, {
      searchStart: 0,
      searchEnd: startSearchEnd
    });
    if (!startDetection || startDetection.score < 0.055) {
      throw new Error('開始マーカーを十分な確度で検出できませんでした。出力レベル、周囲騒音、スピーカー接続を確認してください。');
    }

    const expectedMarkerIntervalSeconds = (
      startMarker.length / sampleRate +
      Number(config.markerGap) +
      Number(config.sweepDuration) +
      Number(config.responseTail) +
      Number(config.endMarkerGuard)
    );
    const predictedEnd = startDetection.startSample + expectedMarkerIntervalSeconds * sampleRate;
    const endWindow = Math.round(sampleRate * 1.5);

    progress(0.10, '終了マーカーを検出して録音クロック差を推定しています…');
    const endDetection = normalizedCrossCorrelation(recorded, endMarker, {
      searchStart: Math.max(0, predictedEnd - endWindow),
      searchEnd: Math.min(recorded.length, predictedEnd + endWindow + endMarker.length)
    });

    let timeScale = 1;
    let driftPpm = null;
    if (endDetection && endDetection.score >= 0.045) {
      const observed = endDetection.startSample - startDetection.startSample;
      const expected = expectedMarkerIntervalSeconds * sampleRate;
      timeScale = clamp(observed / expected, 0.995, 1.005);
      driftPpm = (timeScale - 1) * 1e6;
    }

    const sweepStartFloat = startDetection.startSample + (
      startMarker.length / sampleRate + Number(config.markerGap)
    ) * sampleRate * timeScale;
    const sweepStart = Math.max(0, Math.floor(sweepStartFloat));
    const fractionalStartSamples = sweepStartFloat - sweepStart;
    const sweepCount = Math.round(Number(config.sweepDuration) * sampleRate * timeScale);
    const tailCount = Math.round(Number(config.responseTail) * sampleRate * timeScale);
    const nominalAnalysisEnd = sweepStart + sweepCount + tailCount;
    const safeBeforeMarker = endDetection
      ? Math.floor(endDetection.startSample - Math.max(sampleRate * 0.12, Number(config.endMarkerGuard) * sampleRate * timeScale * 0.35))
      : recorded.length;
    const analysisEnd = Math.min(recorded.length, nominalAnalysisEnd, safeBeforeMarker);
    if (analysisEnd - sweepStart < sweepCount + Math.round(sampleRate * 0.25)) {
      throw new Error('スイープ後半または残響区間が不足しています。録音が途中で停止した可能性があります。');
    }

    const recordedSweepObserved = recorded.slice(sweepStart, analysisEnd);
    const nominalResponseLength = Math.round((Number(config.sweepDuration) + Number(config.responseTail)) * sampleRate);
    progress(0.15, '開始・終了マーカーから録音クロック差を補間補正しています…');
    const recordedSweep = resampleClockCorrected(
      recordedSweepObserved,
      nominalResponseLength,
      timeScale,
      fractionalStartSamples,
      6
    );
    const referenceSweep = generateLogSweep(
      sampleRate,
      band.excitationStart,
      band.excitationEnd,
      Number(config.sweepDuration),
      Number(config.level),
      1,
      { fadeInSeconds: 0.085, fadeOutSeconds: 0.035 }
    );

    progress(0.22, 'ガード帯域付き正則化デコンボリューションを実行しています…');
    const deconvolved = deconvolve(
      recordedSweep,
      referenceSweep,
      sampleRate,
      band,
      Number(config.regularizationDb ?? -96)
    );
    const peak = findMainImpulse(deconvolved.impulse, sampleRate, 0.45);

    progress(0.43, 'インパルス応答へ低漏洩時間窓を適用しています…');
    const gated = makeGatedImpulse(
      deconvolved.impulse,
      sampleRate,
      peak.index,
      config.gateMs,
      Number(config.responseTail) * timeScale,
      String(config.windowType || 'blackman-harris')
    );
    const spectrum = fftImpulse(gated.samples);

    progress(0.58, '振幅・位相・群遅延を算出しています…');
    const response = sampleFrequencyResponse(
      spectrum,
      deconvolved.referenceSupportDb,
      sampleRate,
      band,
      Number(config.smoothing),
      Array.isArray(config.calibration) ? config.calibration : [],
      peak.index
    );
    // Magnitude is estimated by coherent ESS tracking rather than by the
    // inverse-filter edge bins. This keeps the 20 kHz display endpoint away
    // from marker leakage and inverse-spectrum amplification.
    const trackingDelayObservedSamples = fractionalStartSamples + peak.index * timeScale;
    response.magnitude = estimateTrackedMagnitude(
      recordedSweepObserved,
      sampleRate,
      config,
      band,
      timeScale,
      trackingDelayObservedSamples,
      Array.isArray(config.calibration) ? config.calibration : [],
      Number(config.smoothing),
      response.magnitude
    );
    let normalizationOffset = 0;
    if (config.normalize !== false) {
      normalizationOffset = normalizeMagnitude(
        response.magnitude,
        Number(config.normalizeLow ?? 500),
        Number(config.normalizeHigh ?? 2000)
      );
    }

    progress(0.70, 'ステップ応答と時間周波数減衰を生成しています…');
    const impulseSeries = makeImpulseSeries(deconvolved.impulse, sampleRate, peak.index, gated.effectiveGateMs);
    const stepSeries = makeStepSeries(gated.samples, sampleRate, peak.index, gated.effectiveGateMs);
    const decay = computeDecayMap(deconvolved.impulse, sampleRate, peak.index, band, gated.effectiveGateMs);

    progress(0.84, '第2～第5高調波とTHDを追従解析しています…');
    const thd = estimateThd(recordedSweep, sampleRate, {
      ...config,
      timeScale: 1,
      excitationStartFreq: band.excitationStart,
      excitationEndFreq: band.excitationEnd
    }, peak.index, band);

    const noiseEnd = Math.max(0, Math.floor(startDetection.startSample - sampleRate * 0.08));
    const noiseStart = Math.max(0, noiseEnd - Math.round(sampleRate * 0.45));
    const noiseRms = rms(recorded, noiseStart, noiseEnd);
    const signalRms = rms(recordedSweep, 0, Math.min(recordedSweep.length, Math.round(Number(config.sweepDuration) * sampleRate)));
    const clipping = countClipping(recorded);
    const validMagnitude = response.magnitude.filter((point) => point.valid);
    const peakPoint = validMagnitude.length
      ? validMagnitude.reduce((best, point) => point.db > best.db ? point : best, validMagnitude[0])
      : null;
    const latencyMs = (startDetection.startSample - Number(config.preRoll) * sampleRate) * 1000 / sampleRate;
    const analysisMarginMs = endDetection ? (endDetection.startSample - analysisEnd) * 1000 / sampleRate : null;

    progress(0.94, '終了マーカー混入と測定信頼帯域を検証しています…');
    const leakageSearchStart = Math.max(0, recordedSweepObserved.length - Math.round(sampleRate * 0.75));
    const leakageDetection = recordedSweepObserved.length - leakageSearchStart > endMarker.length
      ? normalizedCrossCorrelation(recordedSweepObserved, endMarker, {
          searchStart: leakageSearchStart,
          searchEnd: recordedSweepObserved.length
        })
      : null;

    return {
      version: '4.1.0',
      sampleRate,
      magnitude: response.magnitude,
      phase: response.phase,
      groupDelay: response.groupDelay,
      impulse: impulseSeries,
      step: stepSeries,
      decay,
      thd,
      summary: {
        latencyMs,
        startMarkerScore: startDetection.score,
        endMarkerScore: endDetection?.score ?? null,
        markerLeakageScore: leakageDetection?.score ?? null,
        analysisMarginMs,
        driftPpm,
        timeScale,
        fractionalStartSamples,
        magnitudeEngine: 'coherent-ess-tracking',
        directArrivalMs: peak.index * 1000 / sampleRate,
        effectiveGateMs: gated.effectiveGateMs,
        windowType: gated.windowType,
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
        normalizationOffsetDb: normalizationOffset,
        excitationStartHz: band.excitationStart,
        excitationEndHz: band.excitationEnd,
        reliableStartHz: band.safeStart,
        reliableEndHz: band.safeEnd,
        upperGuardAvailable: band.hasUpperGuard,
        lowerGuardAvailable: band.hasLowerGuard,
        endFrequencyLimited: band.safeEnd < band.displayEnd * 0.995
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
    computeExcitationBand,
    buildMeasurementSignal,
    fft,
    normalizedCrossCorrelation,
    resampleClockCorrected,
    analyzeMeasurement
  };
});
