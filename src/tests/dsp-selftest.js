'use strict';

const path = require('path');
const dsp = require(path.join(__dirname, '..', 'dsp-core.js'));

const SAMPLE_RATE = 48000;
const CONFIG = {
  startFreq: 20,
  endFreq: 20000,
  sweepDuration: 8,
  level: 0.22,
  markerLevel: 0.275,
  smoothing: 12,
  gateMs: 'full',
  windowType: 'blackman-harris',
  regularizationDb: -96,
  normalize: true,
  normalizeLow: 500,
  normalizeHigh: 2000,
  preRoll: 0.65,
  markerGap: 0.75,
  responseTail: 2.2,
  endMarkerGuard: 0.55,
  postRoll: 0.45,
  calibration: []
};

function nearest(points, frequency) {
  return points.reduce((best, point) => Math.abs(point.f - frequency) < Math.abs(best.f - frequency) ? point : best, points[0]);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delayedRecording(samples, delaySeconds, gain = 0.7) {
  const delay = Math.round(delaySeconds * SAMPLE_RATE);
  const output = new Float32Array(samples.length + delay + Math.round(SAMPLE_RATE * 0.2));
  for (let i = 0; i < samples.length; i++) output[i + delay] = samples[i] * gain;
  return output;
}

function runFlatTest() {
  const signal = dsp.buildMeasurementSignal(SAMPLE_RATE, CONFIG);
  const recording = delayedRecording(signal.samples, 0.187);
  const result = dsp.analyzeMeasurement(recording, SAMPLE_RATE, CONFIG);
  const values = [20, 100, 1000, 10000, 18000, 20000].map((f) => nearest(result.magnitude, f).db);
  const span = Math.max(...values) - Math.min(...values);
  assert(span < 0.8, `直結特性の偏差が大きすぎます: ${span.toFixed(3)} dB`);
  assert(nearest(result.magnitude, 20000).db < 1.0, '20 kHz端点が異常上昇しています。');
  assert(result.summary.markerLeakageScore < 0.08, '終了マーカーが解析区間へ混入しています。');
  return { spanDb: span, end20kDb: nearest(result.magnitude, 20000).db };
}

function runFilterTest() {
  const signal = dsp.buildMeasurementSignal(SAMPLE_RATE, CONFIG);
  const input = signal.samples;
  const filtered = new Float32Array(input.length);
  const highPass = Math.exp(-2 * Math.PI * 70 / SAMPLE_RATE);
  const lowPass = Math.exp(-2 * Math.PI * 14000 / SAMPLE_RATE);
  let hpState = 0;
  let previous = 0;
  let lpState = 0;
  for (let i = 0; i < input.length; i++) {
    hpState = highPass * (hpState + input[i] - previous);
    previous = input[i];
    lpState = (1 - lowPass) * hpState + lowPass * lpState;
    filtered[i] = lpState;
  }
  const recording = delayedRecording(filtered, 0.203, 0.75);
  const result = dsp.analyzeMeasurement(recording, SAMPLE_RATE, CONFIG);
  const low20 = nearest(result.magnitude, 20).db;
  const mid1k = nearest(result.magnitude, 1000).db;
  const end20k = nearest(result.magnitude, 20000).db;
  assert(low20 < mid1k - 3, '疑似ハイパス特性を検出できません。');
  assert(end20k < 4, 'フィルター試験で20 kHz端点が異常上昇しています。');
  return { low20Db: low20, mid1kDb: mid1k, end20kDb: end20k };
}

function runBandLimitTest() {
  const band441 = dsp.computeExcitationBand(44100, 20, 20000);
  assert(band441.safeEnd < 19500, '44.1 kHz時の安全上限が高すぎます。');
  const band480 = dsp.computeExcitationBand(48000, 20, 20000);
  assert(band480.safeEnd === 20000, '48 kHz時に20 kHzまで有効になりません。');
  return { safeEnd44100: band441.safeEnd, safeEnd48000: band480.safeEnd };
}

const results = {
  flat: runFlatTest(),
  filtered: runFilterTest(),
  bandLimit: runBandLimitTest()
};

console.log('Speaker Measure Pro 4.0 DSP self-test: PASS');
console.log(JSON.stringify(results, null, 2));
