const VERSION = '4.1.1';
const DB_NAME = 'speaker-measure-pro';
const DB_VERSION = 1;
const STORE_NAME = 'measurements';
const COLORS = ['#38bdf8', '#a3e635', '#facc15', '#c084fc', '#fb7185', '#2dd4bf', '#f97316', '#818cf8'];
const MAGNITUDE_DISPLAY_FLOOR_DB = -36;
const REPORT_PAGE_WIDTH = 1400;
const REPORT_PAGE_HEIGHT = 990;
const REPORT_VIEWS = ['magnitude', 'phase', 'groupDelay', 'impulse', 'step', 'decay', 'thd'];
const SPEAKER_TYPE_LABELS = {
  'bass-reflex': '自作バスレフ',
  sealed: '密閉型',
  'transmission-line': 'TL / MTL',
  'open-baffle': '平面バッフル',
  commercial: '市販スピーカー',
  other: 'その他'
};
const WINDOW_TYPE_LABELS = {
  'blackman-harris': 'Blackman-Harris 4-term',
  hann: 'Hann',
  tukey: 'Tukey / cosine edge'
};
const VIEW_LABELS = {
  magnitude: 'ガード帯域補正済み相対周波数特性',
  phase: '直接音遅延を除去したラップ位相',
  groupDelay: '直接音基準の相対群遅延',
  impulse: 'インパルス応答のエネルギー時間曲線（ETC）',
  step: '帯域制限済みステップ応答',
  decay: '時間周波数減衰（周波数ごとに0 dB正規化）',
  thd: 'ログスイープ追従解析によるTHD・第2～第5高調波'
};
const $ = (id) => document.getElementById(id);

const ui = {
  secureBadge: $('secureBadge'),
  startFreq: $('startFreq'), endFreq: $('endFreq'), duration: $('duration'),
  level: $('level'), levelOut: $('levelOut'), smoothing: $('smoothing'), gateMs: $('gateMs'),
  distanceCm: $('distanceCm'), speakerType: $('speakerType'), measurementName: $('measurementName'),
  regularizationDb: $('regularizationDb'), windowType: $('windowType'), normalizeMode: $('normalizeMode'), magnitudeRange: $('magnitudeRange'),
  calibrationFile: $('calibrationFile'), calibrationStatus: $('calibrationStatus'), clearCalibrationBtn: $('clearCalibrationBtn'),
  prepareBtn: $('prepareBtn'), testBtn: $('testBtn'), markerBtn: $('markerBtn'), measureBtn: $('measureBtn'), abortBtn: $('abortBtn'),
  status: $('status'), progressTrack: $('progressTrack'), progressBar: $('progressBar'), progressText: $('progressText'),
  meterTrack: $('meterTrack'), meter: $('meter'), meterText: $('meterText'), qualityBadge: $('qualityBadge'), deviceInfo: $('deviceInfo'),
  outputAudio: $('outputAudio'), canvas: $('responseCanvas'), graphSubtitle: $('graphSubtitle'), legend: $('legend'), summary: $('resultSummary'),
  saveBtn: $('saveBtn'), pdfBtn: $('pdfBtn'), graphPngBtn: $('graphPngBtn'), csvBtn: $('csvBtn'), jsonBtn: $('jsonBtn'), wavBtn: $('wavBtn'),
  referenceSelect: $('referenceSelect'), savedList: $('savedList'), deleteAllBtn: $('deleteAllBtn')
};

let audioContext = null;
let stream = null;
let micSource = null;
let recorderNode = null;
let silentGain = null;
let analyser = null;
let meterFrame = null;
let workletLoaded = false;
let recordingChunks = [];
let recorderStopResolve = null;
let activeAudioUrl = null;
let activePlaybackCancel = null;
let busy = false;
let abortRequested = false;
let analysisWorker = null;
let currentResult = null;
let currentConfig = null;
let lastRecording = null;
let calibration = [];
let calibrationName = '';
let savedMeasurements = [];
let selectedSavedIds = new Set();
let currentView = 'magnitude';

init();

async function init() {
  bindEvents();
  ui.levelOut.value = `${Math.round(Number(ui.level.value) * 100)}%`;
  ui.secureBadge.textContent = window.isSecureContext ? 'HTTPS / secure' : 'HTTPSが必要';
  ui.secureBadge.style.color = window.isSecureContext ? '#a3e635' : '#fb7185';
  updateAudioDiagnostics();
  drawGraph();
  try {
    savedMeasurements = await dbList();
    savedMeasurements.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch (error) {
    setStatus(`保存領域の初期化に失敗しました：${error.message}`, true);
  }
  renderSaved();
  refreshReferenceOptions();
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register(`./sw.js?v=${VERSION}`).catch(() => {});
  }
}

function bindEvents() {
  ui.level.addEventListener('input', () => ui.levelOut.value = `${Math.round(Number(ui.level.value) * 100)}%`);
  ui.prepareBtn.addEventListener('click', prepareAudio);
  ui.testBtn.addEventListener('click', playTestTone);
  ui.markerBtn.addEventListener('click', playMarker);
  ui.measureBtn.addEventListener('click', measure);
  ui.abortBtn.addEventListener('click', abortMeasurement);
  ui.saveBtn.addEventListener('click', saveCurrent);
  ui.pdfBtn.addEventListener('click', exportPdfReport);
  ui.graphPngBtn.addEventListener('click', exportGraphPng);
  ui.csvBtn.addEventListener('click', exportCsv);
  ui.jsonBtn.addEventListener('click', exportJson);
  ui.wavBtn.addEventListener('click', exportWav);
  ui.deleteAllBtn.addEventListener('click', deleteAllSaved);
  ui.calibrationFile.addEventListener('change', loadCalibrationFile);
  ui.clearCalibrationBtn.addEventListener('click', clearCalibration);
  ui.referenceSelect.addEventListener('change', drawGraph);
  ui.magnitudeRange.addEventListener('change', drawGraph);
  window.addEventListener('resize', drawGraph);
  document.querySelectorAll('.view-tab').forEach((button) => {
    button.addEventListener('click', () => setView(button.dataset.view));
  });
  for (const eventName of ['playing', 'pause', 'stalled', 'error', 'emptied', 'ended']) {
    ui.outputAudio.addEventListener(eventName, updateAudioDiagnostics);
  }
  navigator.audioSession?.addEventListener?.('statechange', updateAudioDiagnostics);
}

async function prepareAudio() {
  if (busy) return;
  try {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('マイクはHTTPSまたはlocalhostからのみ利用できます。');
    }
    setBusy(true, false);
    setStatus('音声処理を準備しています…');
    setAudioSessionType('play-and-record');
    await ensureAudioContext();

    if (!workletLoaded) {
      await audioContext.audioWorklet.addModule(`./recorder-worklet.js?v=${VERSION}`);
      workletLoaded = true;
    }

    setStatus('マイク使用許可を確認しています…');
    stream ||= await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: { ideal: false },
        noiseSuppression: { ideal: false },
        autoGainControl: { ideal: false },
        channelCount: { ideal: 1 },
        sampleRate: { ideal: audioContext.sampleRate },
        sampleSize: { ideal: 24 }
      },
      video: false
    });

    const track = stream.getAudioTracks()[0];
    if (track && 'contentHint' in track) {
      try { track.contentHint = 'music'; } catch {}
    }

    if (!micSource) {
      micSource = audioContext.createMediaStreamSource(stream);
      recorderNode = new AudioWorkletNode(audioContext, 'recorder-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      });
      silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.25;
      micSource.connect(analyser);
      micSource.connect(recorderNode).connect(silentGain).connect(audioContext.destination);
      recorderNode.port.onmessage = handleRecorderMessage;
      startMeter();
    }

    // HTMLAudioによるスピーカー再生経路を優先する。
    setAudioSessionType('playback');
    ui.prepareBtn.textContent = 'マイク準備済み';
    ui.measureBtn.disabled = false;
    setStatus('準備完了。マイク準備後にも「テスト音」がスピーカーから出ることを確認してください。');
    updateAudioDiagnostics();
  } catch (error) {
    setStatus(`準備エラー：${error.message}`, true);
  } finally {
    setBusy(false, false);
  }
}

async function ensureAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error('Web Audio APIに対応していません。');
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContextClass({ latencyHint: 'interactive' });
    audioContext.addEventListener?.('statechange', updateAudioDiagnostics);
  }
  await audioContext.resume();
}

function setAudioSessionType(type) {
  if (!navigator.audioSession) return false;
  try {
    navigator.audioSession.type = type;
    return navigator.audioSession.type === type;
  } catch {
    return false;
  } finally {
    updateAudioDiagnostics();
  }
}

function handleRecorderMessage(event) {
  const message = event.data;
  if (message?.type === 'chunk' && message.chunk) {
    recordingChunks.push(new Float32Array(message.chunk));
  } else if (message?.type === 'stopped') {
    const resolve = recorderStopResolve;
    recorderStopResolve = null;
    resolve?.();
  }
}

function startMeter() {
  cancelAnimationFrame(meterFrame);
  const values = new Float32Array(analyser.fftSize);
  const tick = () => {
    if (!analyser) return;
    analyser.getFloatTimeDomainData(values);
    let sum = 0;
    let peak = 0;
    for (const value of values) {
      sum += value * value;
      peak = Math.max(peak, Math.abs(value));
    }
    const level = Math.sqrt(sum / values.length);
    const rmsDb = 20 * Math.log10(Math.max(level, 1e-6));
    const peakDb = 20 * Math.log10(Math.max(peak, 1e-6));
    const displayDb = Math.max(rmsDb, peakDb);
    const normalized = Math.max(0, Math.min(1, (displayDb + 60) / 60));
    ui.meter.style.width = `${normalized * 100}%`;
    ui.meterText.value = `RMS ${formatMeterDb(rmsDb)} / Peak ${formatMeterDb(peakDb)}`;
    ui.meterTrack.setAttribute('aria-valuenow', String(Math.max(-60, Math.min(0, peakDb)).toFixed(1)));
    ui.meterTrack.setAttribute('aria-valuetext', `RMS ${formatMeterDb(rmsDb)}、ピーク ${formatMeterDb(peakDb)}`);
    meterFrame = requestAnimationFrame(tick);
  };
  tick();
}

function formatMeterDb(value) {
  if (!Number.isFinite(value) || value <= -60) return '−60以下 dBFS';
  return `${value.toFixed(1).replace('-', '−')} dBFS`;
}

function generateTone(sampleRate, frequency = 1000, duration = 0.65, level = 0.18) {
  const count = Math.round(sampleRate * duration);
  const output = new Float32Array(count);
  const fade = Math.round(sampleRate * 0.025);
  for (let i = 0; i < count; i++) {
    let env = 1;
    if (i < fade) env *= 0.5 - 0.5 * Math.cos(Math.PI * i / fade);
    if (i >= count - fade) env *= 0.5 - 0.5 * Math.cos(Math.PI * (count - 1 - i) / fade);
    output[i] = Math.sin(2 * Math.PI * frequency * i / sampleRate) * level * env;
  }
  return output;
}

async function playTestTone() {
  if (busy) return;
  try {
    setAudioSessionType('playback');
    const sampleRate = audioContext?.sampleRate || 48000;
    setStatus('1 kHzのテスト音を再生しています…');
    await playPcmSamples(generateTone(sampleRate), sampleRate);
    setStatus('テスト音を再生しました。スピーカーから聞こえたか確認してください。');
  } catch (error) {
    setStatus(`テスト音エラー：${error.message}`, true);
  }
}

async function playMarker() {
  if (busy) return;
  try {
    setAudioSessionType('playback');
    const sampleRate = audioContext?.sampleRate || 48000;
    const marker = window.SpeakerDSP.generateMarker(sampleRate, 0.25, 'start');
    const padded = new Float32Array(marker.length + Math.round(sampleRate * 0.18));
    padded.set(marker, Math.round(sampleRate * 0.08));
    setStatus('開始マーカー（Barker符号化チャープ）を再生しています…');
    await playPcmSamples(padded, sampleRate);
    setStatus('マーカー確認が完了しました。');
  } catch (error) {
    setStatus(`マーカー再生エラー：${error.message}`, true);
  }
}

function readConfig() {
  const startFreq = Number(ui.startFreq.value);
  const endFreq = Number(ui.endFreq.value);
  const sweepDuration = Number(ui.duration.value);
  const level = Number(ui.level.value);
  if (!(startFreq >= 20 && endFreq > startFreq && endFreq <= 22000)) throw new Error('開始・終了周波数を確認してください。');
  if (!(sweepDuration >= 4 && sweepDuration <= 15)) throw new Error('スイープ時間は4～15秒にしてください。');
  if (!(level >= 0.05 && level <= 0.65)) throw new Error('出力レベルが範囲外です。');
  const markerLevel = window.SpeakerDSP.clamp(Math.max(level * 1.25, 0.18), 0.12, 0.50);
  return {
    startFreq,
    endFreq,
    sweepDuration,
    level,
    markerLevel,
    smoothing: Number(ui.smoothing.value),
    gateMs: ui.gateMs.value === 'full' ? 'full' : Number(ui.gateMs.value),
    windowType: ui.windowType.value,
    distanceCm: Number(ui.distanceCm.value),
    speakerType: ui.speakerType.value,
    name: ui.measurementName.value.trim() || `測定 ${new Date().toLocaleString('ja-JP')}`,
    regularizationDb: Number(ui.regularizationDb.value),
    normalize: ui.normalizeMode.value === 'on',
    normalizeLow: 500,
    normalizeHigh: 2000,
    preRoll: 0.65,
    markerGap: 0.75,
    responseTail: 2.2,
    endMarkerGuard: 0.55,
    postRoll: 0.45,
    calibration,
    calibrationName
  };
}

async function measure() {
  if (busy || !recorderNode || !audioContext) return;
  let signal;
  try {
    currentConfig = readConfig();
    signal = window.SpeakerDSP.buildMeasurementSignal(audioContext.sampleRate, currentConfig);
  } catch (error) {
    setStatus(`設定エラー：${error.message}`, true);
    return;
  }

  abortRequested = false;
  currentResult = null;
  lastRecording = null;
  recordingChunks = [];
  updateResultButtons();
  setBusy(true, true);
  setProgress(0.05, '録音・再生中');
  setAudioSessionType('playback');
  setStatus(`録音開始。開始マーカーの後、${currentConfig.sweepDuration}秒のスイープを再生します…`);

  try {
    recorderNode.port.postMessage({ type: 'start' });
    const playback = playPcmSamples(signal.samples, audioContext.sampleRate);
    await playback;
    if (abortRequested) throw new Error('測定を中止しました。');
    setProgress(0.35, '録音確定中');
    setStatus('出力終了。録音を確定しています…');
    await sleep(180);
    await stopRecorder();
    lastRecording = mergeChunks(recordingChunks);
    if (lastRecording.length < audioContext.sampleRate) throw new Error('録音データが短すぎます。');
    setProgress(0.40, '解析準備中');
    setStatus('録音完了。開始マーカーを基準に解析しています…');
    await analyzeRecording(lastRecording, audioContext.sampleRate, currentConfig);
  } catch (error) {
    try { await stopRecorder(); } catch {}
    if (!abortRequested) setStatus(`測定エラー：${error.message}`, true);
  } finally {
    setBusy(false, false);
  }
}

function analyzeRecording(recorded, sampleRate, config) {
  return new Promise((resolve, reject) => {
    analysisWorker?.terminate();
    analysisWorker = new Worker(`./analyzer-worker.js?v=${VERSION}`);
    analysisWorker.onmessage = (event) => {
      const message = event.data;
      if (message.type === 'progress') {
        setProgress(0.40 + message.value * 0.60, '解析中');
        setStatus(message.message);
      } else if (message.type === 'result') {
        currentResult = {
          ...message.result,
          id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`,
          name: config.name,
          createdAt: new Date().toISOString(),
          config: { ...config, calibration: undefined }
        };
        setProgress(1, '完了');
        setStatus('解析が完了しました。マーカー分離、信頼帯域、周波数特性、群遅延、時間応答を確認してください。');
        renderSummary();
        updateQualityBadge();
        updateResultButtons();
        drawGraph();
        analysisWorker.terminate();
        analysisWorker = null;
        resolve(currentResult);
      } else if (message.type === 'error') {
        analysisWorker.terminate();
        analysisWorker = null;
        reject(new Error(message.message));
      }
    };
    analysisWorker.onerror = (event) => {
      analysisWorker?.terminate();
      analysisWorker = null;
      reject(new Error(event.message || '解析Workerでエラーが発生しました。'));
    };
    analysisWorker.postMessage({ recorded, sampleRate, config });
  });
}

function abortMeasurement() {
  if (!busy) return;
  abortRequested = true;
  stopMediaPlayback();
  analysisWorker?.terminate();
  analysisWorker = null;
  recorderNode?.port.postMessage({ type: 'stop' });
  setStatus('測定を中止しました。', true);
  setProgress(0, '中止');
  setBusy(false, false);
}

function stopRecorder() {
  if (!recorderNode) return Promise.resolve();
  if (recorderStopResolve) return Promise.resolve();
  return new Promise((resolve) => {
    recorderStopResolve = resolve;
    recorderNode.port.postMessage({ type: 'stop' });
    setTimeout(() => {
      if (recorderStopResolve) {
        const fallback = recorderStopResolve;
        recorderStopResolve = null;
        fallback();
      }
    }, 1200);
  });
}

function mergeChunks(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function playPcmSamples(samples, sampleRate) {
  stopMediaPlayback();
  const blob = encodeWav16(samples, sampleRate);
  activeAudioUrl = URL.createObjectURL(blob);
  ui.outputAudio.srcObject = null;
  ui.outputAudio.src = activeAudioUrl;
  ui.outputAudio.playsInline = true;
  ui.outputAudio.autoplay = false;
  ui.outputAudio.muted = false;
  ui.outputAudio.volume = 1;
  ui.outputAudio.currentTime = 0;
  ui.outputAudio.load();

  const endedPromise = new Promise((resolve, reject) => {
    const cleanup = () => {
      ui.outputAudio.removeEventListener('ended', onEnded);
      ui.outputAudio.removeEventListener('error', onError);
      if (activePlaybackCancel === cancel) activePlaybackCancel = null;
    };
    const onEnded = () => { cleanup(); resolve(); };
    const onError = () => {
      cleanup();
      reject(new Error(ui.outputAudio.error?.message || 'HTML Audioの再生に失敗しました。'));
    };
    const cancel = (error) => { cleanup(); reject(error || new Error('再生を中止しました。')); };
    activePlaybackCancel = cancel;
    ui.outputAudio.addEventListener('ended', onEnded, { once: true });
    ui.outputAudio.addEventListener('error', onError, { once: true });
  });

  const playPromise = ui.outputAudio.play();
  updateAudioDiagnostics();
  return Promise.all([playPromise, endedPromise]).finally(() => {
    activePlaybackCancel = null;
    if (activeAudioUrl) {
      URL.revokeObjectURL(activeAudioUrl);
      activeAudioUrl = null;
    }
    updateAudioDiagnostics();
  });
}

function stopMediaPlayback() {
  const cancel = activePlaybackCancel;
  activePlaybackCancel = null;
  cancel?.(new Error('再生を中止しました。'));
  try { ui.outputAudio.pause(); } catch {}
  ui.outputAudio.removeAttribute('src');
  try { ui.outputAudio.load(); } catch {}
  if (activeAudioUrl) {
    URL.revokeObjectURL(activeAudioUrl);
    activeAudioUrl = null;
  }
}

function encodeWav16(samples, sampleRate) {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset, value) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0, offset = 44; i < samples.length; i++, offset += 2) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, value < 0 ? Math.round(value * 32768) : Math.round(value * 32767), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function updateAudioDiagnostics() {
  const track = stream?.getAudioTracks?.()[0];
  const settings = track?.getSettings?.() || {};
  const values = [
    audioContext ? `${audioContext.sampleRate} Hz` : '—',
    boolText(settings.echoCancellation),
    boolText(settings.noiseSuppression),
    boolText(settings.autoGainControl),
    audioContext?.state || '未作成',
    navigator.audioSession ? `${navigator.audioSession.type} / ${navigator.audioSession.state || 'state不明'}` : '未対応',
    ui.outputAudio.paused ? '停止中' : 'WAV / HTML Audio再生中',
    track?.contentHint || '未指定'
  ];
  [...ui.deviceInfo.querySelectorAll('dd')].forEach((dd, index) => dd.textContent = values[index] ?? '—');
}

function boolText(value) {
  if (value === false) return 'OFF';
  if (value === true) return 'ON（測定に影響）';
  return '不明';
}

function setBusy(value, allowAbort) {
  busy = value;
  const disable = value;
  ui.prepareBtn.disabled = disable;
  ui.testBtn.disabled = disable;
  ui.markerBtn.disabled = disable;
  ui.measureBtn.disabled = disable || !recorderNode;
  ui.abortBtn.disabled = !(value && allowAbort);
  [ui.startFreq, ui.endFreq, ui.duration, ui.level, ui.smoothing, ui.gateMs, ui.distanceCm, ui.speakerType,
    ui.measurementName, ui.regularizationDb, ui.windowType, ui.normalizeMode, ui.calibrationFile].forEach((element) => element.disabled = disable);
}

function setStatus(message, isError = false) {
  ui.status.textContent = message;
  ui.status.classList.toggle('error', isError);
}

function setProgress(value, label = '') {
  const normalized = Math.max(0, Math.min(1, value));
  const percent = Math.round(normalized * 100);
  ui.progressBar.style.width = `${percent}%`;
  ui.progressText.value = label || (percent === 0 ? '待機中' : percent >= 100 ? '完了' : `${percent}%`);
  ui.progressTrack.setAttribute('aria-valuenow', String(percent));
  ui.progressTrack.setAttribute('aria-valuetext', `${ui.progressText.value}、${percent}%`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadCalibrationFile() {
  const file = ui.calibrationFile.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const points = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const columns = line.split(/[;,\t ]+/).filter(Boolean);
      if (columns.length < 2) continue;
      const f = Number(columns[0]);
      const db = Number(columns[1]);
      if (Number.isFinite(f) && f > 0 && Number.isFinite(db)) points.push({ f, db });
    }
    points.sort((a, b) => a.f - b.f);
    if (points.length < 2) throw new Error('周波数と補正dBの組を2点以上読み込めませんでした。');
    calibration = points;
    calibrationName = file.name;
    ui.calibrationStatus.textContent = `${file.name}（${points.length}点）`;
    ui.clearCalibrationBtn.disabled = false;
    setStatus('マイク校正データを読み込みました。次回測定から適用します。');
  } catch (error) {
    setStatus(`校正ファイルエラー：${error.message}`, true);
    ui.calibrationFile.value = '';
  }
}

function clearCalibration() {
  calibration = [];
  calibrationName = '';
  ui.calibrationFile.value = '';
  ui.calibrationStatus.textContent = '未適用';
  ui.clearCalibrationBtn.disabled = true;
  setStatus('マイク校正を解除しました。');
}

function setView(view) {
  currentView = view;
  document.querySelectorAll('.view-tab').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  ui.graphSubtitle.textContent = VIEW_LABELS[view];
  drawGraph();
}

function updateResultButtons() {
  const hasResult = Boolean(currentResult);
  ui.saveBtn.disabled = !hasResult;
  ui.pdfBtn.disabled = !hasResult;
  ui.graphPngBtn.disabled = collectSeries().length === 0;
  ui.csvBtn.disabled = !hasResult;
  ui.jsonBtn.disabled = !hasResult;
  ui.wavBtn.disabled = !lastRecording;
}

function renderSummary() {
  if (!currentResult) {
    ui.summary.textContent = 'まだ測定結果がありません。';
    return;
  }
  const s = currentResult.summary;
  const reliableBand = `${formatFrequency(Math.round(s.reliableStartHz || currentResult.config.startFreq))}～${formatFrequency(Math.round(s.reliableEndHz || currentResult.config.endFreq))} Hz`;
  const cards = [
    ['総遅延', formatNumber(s.latencyMs, 1, ' ms')],
    ['開始マーカー', formatNumber(s.startMarkerScore, 3)],
    ['終了マーカー', s.endMarkerScore == null ? '未検出' : formatNumber(s.endMarkerScore, 3)],
    ['マーカー混入', s.markerLeakageScore == null ? '検査不能' : `${formatNumber(s.markerLeakageScore, 3)}（低いほど良好）`],
    ['解析区間余白', s.analysisMarginMs == null ? '終了マーカー未検出' : formatNumber(s.analysisMarginMs, 0, ' ms')],
    ['クロック差', s.driftPpm == null ? '終了マーカー未検出' : `${s.driftPpm >= 0 ? '+' : ''}${formatNumber(s.driftPpm, 0)} ppm`],
    ['同期後残差', formatNumber(s.directArrivalMs, 2, ' ms')],
    ['信頼帯域', reliableBand],
    ['実励振帯域', `${formatFrequency(Math.round(s.excitationStartHz))}～${formatFrequency(Math.round(s.excitationEndHz))} Hz`],
    ['振幅解析', s.magnitudeEngine === 'coherent-ess-tracking' ? 'ESS同期追従' : '—'],
    ['IR窓', `${escapeHtml(String(s.windowType || '—'))} / ${formatNumber(s.effectiveGateMs, 0, ' ms')}`],
    ['S/N（参考）', formatNumber(s.snrDb, 1, ' dB')],
    ['入力ピーク', formatNumber(s.inputPeakDbfs, 1, ' dBFS')],
    ['クリッピング', formatNumber(s.clippingPercent, 3, ' %')],
    ['低域 −3 dB', s.minus3Hz ? formatNumber(s.minus3Hz, 0, ' Hz') : '範囲外'],
    ['低域 −6 dB', s.minus6Hz ? formatNumber(s.minus6Hz, 0, ' Hz') : '範囲外'],
    ['40–200 Hz平均', formatNumber(s.lowBandDb, 1, ' dB')],
    ['4–12 kHz平均', formatNumber(s.highBandDb, 1, ' dB')]
  ];
  const warnings = [];
  if (s.endFrequencyLimited) warnings.push(`入力サンプルレートのため、${formatFrequency(Math.round(s.reliableEndHz))} Hzより上は信頼帯域外として非表示です。`);
  if (s.markerLeakageScore > 0.08) warnings.push('終了マーカーに似た成分が解析区間内に検出されました。再測定または出力音量の見直しを推奨します。');
  if (s.analysisMarginMs != null && s.analysisMarginMs < 120) warnings.push('解析区間と終了マーカーの余白が小さすぎます。');
  ui.summary.innerHTML = `<div class="summary-grid">${cards.map(([label, value]) => `<div class="summary-card"><small>${escapeHtml(label)}</small><strong>${value}</strong></div>`).join('')}</div>
    ${warnings.length ? `<div class="analysis-warning">${warnings.map((item) => `<p>${escapeHtml(item)}</p>`).join('')}</div>` : ''}
    <p class="summary-note">測定名：${escapeHtml(currentResult.name)} ／ 距離：${escapeHtml(String(currentResult.config.distanceCm))} cm ／ 校正：${escapeHtml(currentResult.config.calibrationName || 'なし')}</p>`;
}

function assessMeasurementQuality(result) {
  if (!result?.summary) return { level: 'neutral', text: '未測定' };
  const s = result.summary;
  if (s.clippingPercent > 0.02 || s.startMarkerScore < 0.08 || s.snrDb < 18 || s.markerLeakageScore > 0.12) {
    return { level: 'bad', text: '再測定推奨' };
  }
  if (s.clippingPercent > 0 || s.startMarkerScore < 0.14 || s.snrDb < 28 || s.endMarkerScore == null || s.markerLeakageScore > 0.07 || (s.analysisMarginMs != null && s.analysisMarginMs < 150)) {
    return { level: 'warn', text: '要確認' };
  }
  return { level: 'good', text: '良好' };
}

function getMeasurementWarnings(result) {
  if (!result?.summary) return [];
  const s = result.summary;
  const warnings = [];
  if (s.endFrequencyLimited) warnings.push(`入力サンプルレートのため、${formatFrequency(Math.round(s.reliableEndHz))} Hzより上は信頼帯域外として非表示です。`);
  if (s.markerLeakageScore > 0.08) warnings.push('終了マーカーに似た成分が解析区間内に検出されました。再測定または出力音量の見直しを推奨します。');
  if (s.analysisMarginMs != null && s.analysisMarginMs < 120) warnings.push('解析区間と終了マーカーの余白が小さすぎます。');
  if (s.clippingPercent > 0.02) warnings.push('入力クリッピングが検出されています。出力レベルまたはマイク入力レベルを下げてください。');
  if (s.snrDb < 18) warnings.push('S/Nが低いため、静かな環境または高い測定レベルでの再測定を推奨します。');
  return warnings;
}

function updateQualityBadge() {
  if (!currentResult) {
    ui.qualityBadge.className = 'quality-badge neutral';
    ui.qualityBadge.textContent = '待機中';
    return;
  }
  const quality = assessMeasurementQuality(currentResult);
  ui.qualityBadge.className = `quality-badge ${quality.level}`;
  ui.qualityBadge.textContent = quality.text;
}

function formatNumber(value, digits = 1, suffix = '') {
  return Number.isFinite(value) ? `${Number(value).toFixed(digits)}${suffix}` : '—';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
}

function interpolateMagnitude(points, frequency) {
  if (!points?.length) return null;
  if (frequency <= points[0].f) return points[0].db;
  if (frequency >= points[points.length - 1].f) return points[points.length - 1].db;
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].f <= frequency) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const x = (Math.log(frequency) - Math.log(a.f)) / (Math.log(b.f) - Math.log(a.f));
  return a.db + (b.db - a.db) * x;
}

function applyReference(points) {
  const referenceId = ui.referenceSelect.value;
  if (!referenceId || currentView !== 'magnitude') return points;
  const reference = savedMeasurements.find((item) => item.id === referenceId)?.result;
  if (!reference?.magnitude) return points;
  return points.map((point) => ({ ...point, db: point.db - interpolateMagnitude(reference.magnitude, point.f) }));
}

function drawGraph() {
  const canvas = ui.canvas;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const width = rect.width;
  const height = rect.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#020713';
  ctx.fillRect(0, 0, width, height);

  const margin = { left: width < 480 ? 48 : 62, right: currentView === 'decay' ? 48 : 18, top: 24, bottom: 46 };
  const plot = { x: margin.left, y: margin.top, w: width - margin.left - margin.right, h: height - margin.top - margin.bottom };
  const series = collectSeries();
  if (currentView === 'decay') {
    const decay = series[0]?.result?.decay;
    drawDecayHeatmap(ctx, plot, decay);
    drawLegend(decay ? series : []);
    ui.graphPngBtn.disabled = !decay;
    return;
  }
  const axis = makeAxis(series);
  drawAxes(ctx, plot, axis);
  drawReliabilityShading(ctx, plot, axis);
  for (const item of series) drawSeries(ctx, plot, axis, item);
  drawLegend(series);
  ui.graphPngBtn.disabled = series.length === 0;
}

function robustRange(values, fallbackMin, fallbackMax, lowQuantile = 0.03, highQuantile = 0.97, minimumSpan = 1) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return [fallbackMin, fallbackMax];
  const low = sorted[Math.floor((sorted.length - 1) * lowQuantile)];
  const high = sorted[Math.ceil((sorted.length - 1) * highQuantile)];
  const center = (low + high) / 2;
  const span = Math.max(minimumSpan, (high - low) * 1.25);
  return [center - span / 2, center + span / 2];
}

function drawReliabilityShading(ctx, plot, axis, theme = null) {
  if (!axis.type?.startsWith('log-frequency') || !currentResult?.summary) return;
  const low = currentResult.summary.reliableStartHz;
  const high = currentResult.summary.reliableEndHz;
  ctx.save();
  ctx.fillStyle = theme?.unreliableFill || 'rgba(251, 113, 133, 0.10)';
  if (Number.isFinite(low) && low > axis.xMin) {
    const x = mapLog(low, axis.xMin, axis.xMax, plot.x, plot.x + plot.w);
    ctx.fillRect(plot.x, plot.y, Math.max(0, x - plot.x), plot.h);
  }
  if (Number.isFinite(high) && high < axis.xMax) {
    const x = mapLog(high, axis.xMin, axis.xMax, plot.x, plot.x + plot.w);
    ctx.fillRect(x, plot.y, Math.max(0, plot.x + plot.w - x), plot.h);
  }
  ctx.restore();
}

function decayColor(valueDb) {
  const t = Math.max(0, Math.min(1, (valueDb + 60) / 60));
  const stops = [
    [0.00, [2, 7, 19]],
    [0.20, [20, 44, 86]],
    [0.42, [20, 120, 155]],
    [0.64, [69, 180, 122]],
    [0.82, [241, 196, 73]],
    [1.00, [248, 250, 252]]
  ];
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) { a = stops[i - 1]; b = stops[i]; break; }
  }
  const u = (t - a[0]) / Math.max(1e-9, b[0] - a[0]);
  const rgb = a[1].map((v, i) => Math.round(v + (b[1][i] - v) * u));
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

function drawDecayHeatmap(ctx, plot, decay, theme = null) {
  const borderColor = theme?.border || '#4b607d';
  const axisTextColor = theme?.axisText || '#8292a8';
  const gridColor = theme?.decayGrid || 'rgba(130,146,168,0.35)';
  ctx.strokeStyle = borderColor;
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
  if (!decay?.valuesDb?.length) {
    ctx.fillStyle = axisTextColor;
    ctx.textAlign = 'center';
    ctx.fillText('時間周波数減衰データがありません', plot.x + plot.w / 2, plot.y + plot.h / 2);
    return;
  }
  const rows = decay.valuesDb.length;
  const cols = decay.frequencies.length;
  for (let row = 0; row < rows; row++) {
    const y0 = plot.y + row / rows * plot.h;
    const y1 = plot.y + (row + 1) / rows * plot.h;
    for (let col = 0; col < cols; col++) {
      const x0 = mapLog(decay.frequencies[col], decay.frequencies[0], decay.frequencies[cols - 1], plot.x, plot.x + plot.w);
      const nextFrequency = col + 1 < cols ? decay.frequencies[col + 1] : decay.frequencies[col] * (decay.frequencies[col] / decay.frequencies[col - 1]);
      const x1 = mapLog(nextFrequency, decay.frequencies[0], decay.frequencies[cols - 1], plot.x, plot.x + plot.w);
      ctx.fillStyle = decayColor(decay.valuesDb[row][col]);
      ctx.fillRect(x0, y0, Math.max(1, x1 - x0 + 0.5), Math.max(1, y1 - y0 + 0.5));
    }
  }
  ctx.strokeStyle = gridColor;
  ctx.fillStyle = axisTextColor;
  ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
  const freqTicks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  for (const f of freqTicks) {
    if (f < decay.frequencies[0] || f > decay.frequencies[cols - 1]) continue;
    const x = mapLog(f, decay.frequencies[0], decay.frequencies[cols - 1], plot.x, plot.x + plot.w);
    ctx.beginPath(); ctx.moveTo(x, plot.y); ctx.lineTo(x, plot.y + plot.h); ctx.stroke();
    ctx.textAlign = 'center'; ctx.fillText(formatFrequency(f), x, plot.y + plot.h + 20);
  }
  const timeMax = decay.timesMs[decay.timesMs.length - 1];
  for (let i = 0; i <= 5; i++) {
    const t = timeMax * i / 5;
    const y = plot.y + t / timeMax * plot.h;
    ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(`${Math.round(t)}`, plot.x - 8, y);
  }
  ctx.textAlign = 'left'; ctx.fillText('ms', 8, plot.y - 10);
  const legendX = plot.x + plot.w + 14;
  const gradient = ctx.createLinearGradient(0, plot.y + plot.h, 0, plot.y);
  for (let i = 0; i <= 6; i++) gradient.addColorStop(i / 6, decayColor(-60 + i * 10));
  ctx.fillStyle = gradient;
  ctx.fillRect(legendX, plot.y, 12, plot.h);
  ctx.fillStyle = axisTextColor;
  ctx.textAlign = 'left';
  ctx.fillText('0', legendX + 17, plot.y + 4);
  ctx.fillText('−60', legendX + 17, plot.y + plot.h - 4);
}

function collectSeries() {
  if (currentView === 'thd') {
    const output = [];
    if (currentResult?.thd?.length) {
      const harmonicSeries = [
        ['THD', 'percent', '#f8fafc', 2.5],
        ['H2', 'h2', '#38bdf8', 1.6],
        ['H3', 'h3', '#a3e635', 1.6],
        ['H4', 'h4', '#facc15', 1.4],
        ['H5', 'h5', '#c084fc', 1.4]
      ];
      for (const [label, key, color, width] of harmonicSeries) {
        const points = currentResult.thd
          .filter((point) => Number.isFinite(point[key]))
          .map((point) => ({ f: point.f, value: point[key] }));
        if (points.length) output.push({ result: currentResult, name: `${currentResult.name} ${label}`, color, width, points });
      }
    }
    let colorIndex = 0;
    for (const item of savedMeasurements) {
      if (!selectedSavedIds.has(item.id) || !item.result?.thd?.length) continue;
      output.push({
        result: item.result,
        name: `${item.name} THD`,
        color: COLORS[colorIndex++ % COLORS.length],
        width: 1.4,
        points: item.result.thd.map((point) => ({ f: point.f, value: point.percent }))
      });
    }
    return output;
  }

  const output = [];
  if (currentResult) output.push({ result: currentResult, name: `${currentResult.name}（現在）`, color: '#f8fafc', width: 2.5 });
  let colorIndex = 0;
  if (currentView !== 'decay') {
    for (const item of savedMeasurements) {
      if (!selectedSavedIds.has(item.id)) continue;
      output.push({ result: item.result, name: item.name, color: COLORS[colorIndex++ % COLORS.length], width: 1.7 });
    }
  }
  return output.map((item) => {
    let points = [];
    if (currentView === 'magnitude') points = applyReference(item.result.magnitude || []).map((p) => ({ ...p, value: p.db }));
    else if (currentView === 'phase') points = (item.result.phase || []).map((p) => ({ f: p.f, value: p.deg, valid: p.valid }));
    else if (currentView === 'groupDelay') points = (item.result.groupDelay || []).map((p) => ({ f: p.f, value: p.ms, valid: p.valid }));
    else if (currentView === 'impulse') points = (item.result.impulse || []).map((p) => ({ x: p.tMs, value: p.etcDb }));
    else if (currentView === 'step') points = (item.result.step || []).map((p) => ({ x: p.tMs, value: p.value }));
    else if (currentView === 'decay' && item.result.decay) points = [{ decay: item.result.decay }];
    return { ...item, points };
  }).filter((item) => item.points.length);
}

function makeAxis(series) {
  if (currentView === 'magnitude') {
    const range = Number(ui.magnitudeRange.value);
    return { type: 'log-frequency', xMin: Number(ui.startFreq.value), xMax: Number(ui.endFreq.value), yMin: -range * 2 / 3, yMax: range / 3, yLabel: 'dB' };
  }
  if (currentView === 'phase') return { type: 'log-frequency', xMin: Number(ui.startFreq.value), xMax: Number(ui.endFreq.value), yMin: -180, yMax: 180, yLabel: 'deg' };
  if (currentView === 'groupDelay') {
    const values = series.flatMap((item) => item.points.filter((p) => p.valid !== false && Number.isFinite(p.value)).map((p) => p.value));
    const [low, high] = robustRange(values, -10, 50, 0.03, 0.97, 8);
    const yMin = Math.max(-30, Math.min(140, low));
    const yMax = Math.max(yMin + 5, Math.min(150, high));
    return { type: 'log-frequency', xMin: Number(ui.startFreq.value), xMax: Number(ui.endFreq.value), yMin, yMax, yLabel: 'ms' };
  }
  if (currentView === 'thd') return { type: 'log-frequency-log-y', xMin: Math.max(30, Number(ui.startFreq.value)), xMax: Math.min(10000, Number(ui.endFreq.value) / 5), yMin: 0.1, yMax: 100, yLabel: '%' };
  if (currentView === 'step') {
    let xMax = 200;
    for (const item of series) if (item.points.length) xMax = Math.max(xMax, item.points[item.points.length - 1].x || 0);
    return { type: 'linear-time', xMin: -5, xMax: Math.min(500, xMax), yMin: -1.15, yMax: 1.15, yLabel: 'relative' };
  }
  if (currentView === 'decay') return { type: 'heatmap' };
  let xMax = 200;
  for (const item of series) if (item.points.length) xMax = Math.max(xMax, item.points[item.points.length - 1].x || 0);
  xMax = Math.min(600, xMax);
  return { type: 'linear-time', xMin: -5, xMax, yMin: -80, yMax: 0, yLabel: 'ETC dB' };
}

function drawAxes(ctx, plot, axis, theme = null) {
  ctx.strokeStyle = theme?.grid || '#26364d';
  ctx.fillStyle = theme?.axisText || '#8292a8';
  ctx.lineWidth = 1;
  ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textBaseline = 'middle';

  if (axis.type.startsWith('log-frequency')) {
    const ticks = [20, 30, 50, 70, 100, 200, 300, 500, 700, 1000, 2000, 3000, 5000, 7000, 10000, 20000];
    for (const f of ticks) {
      if (f < axis.xMin || f > axis.xMax) continue;
      const x = mapLog(f, axis.xMin, axis.xMax, plot.x, plot.x + plot.w);
      ctx.beginPath(); ctx.moveTo(x, plot.y); ctx.lineTo(x, plot.y + plot.h); ctx.stroke();
      if ([20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].includes(f)) {
        ctx.textAlign = 'center';
        ctx.fillText(formatFrequency(f), x, plot.y + plot.h + 20);
      }
    }
  } else {
    const step = axis.xMax <= 100 ? 10 : axis.xMax <= 250 ? 25 : 50;
    for (let xValue = Math.ceil(axis.xMin / step) * step; xValue <= axis.xMax; xValue += step) {
      const x = mapLinear(xValue, axis.xMin, axis.xMax, plot.x, plot.x + plot.w);
      ctx.beginPath(); ctx.moveTo(x, plot.y); ctx.lineTo(x, plot.y + plot.h); ctx.stroke();
      ctx.textAlign = 'center'; ctx.fillText(`${xValue}`, x, plot.y + plot.h + 20);
    }
    ctx.fillText('ms', plot.x + plot.w, plot.y + plot.h + 37);
  }

  const yTicks = axis.type === 'log-frequency-log-y'
    ? [0.1, 0.3, 1, 3, 10, 30, 100]
    : makeLinearTicks(axis.yMin, axis.yMax, 6);
  for (const value of yTicks) {
    const y = axis.type === 'log-frequency-log-y'
      ? mapLog(value, axis.yMin, axis.yMax, plot.y + plot.h, plot.y)
      : mapLinear(value, axis.yMin, axis.yMax, plot.y + plot.h, plot.y);
    ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(Number.isInteger(value) ? `${value}` : `${value}`, plot.x - 9, y);
  }
  ctx.textAlign = 'left';
  ctx.fillText(axis.yLabel, 8, plot.y - 10);
  ctx.strokeStyle = theme?.border || '#4b607d';
  ctx.strokeRect(plot.x, plot.y, plot.w, plot.h);
}

function drawSeries(ctx, plot, axis, item) {
  ctx.strokeStyle = item.color;
  ctx.lineWidth = item.width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  let started = false;
  for (const point of item.points) {
    const xValue = (currentView === 'impulse' || currentView === 'step') ? point.x : point.f;
    const yValue = currentView === 'magnitude' ? point.db : point.value;
    const belowMagnitudeFloor = currentView === 'magnitude' && yValue <= MAGNITUDE_DISPLAY_FLOOR_DB;
    if (point.valid === false || belowMagnitudeFloor || !Number.isFinite(xValue) || !Number.isFinite(yValue) || xValue < axis.xMin || xValue > axis.xMax) {
      // −36 dB以下は描画せず、前後の線もつながない。
      started = false;
      continue;
    }
    const x = axis.type.startsWith('log-frequency') ? mapLog(xValue, axis.xMin, axis.xMax, plot.x, plot.x + plot.w) : mapLinear(xValue, axis.xMin, axis.xMax, plot.x, plot.x + plot.w);
    const y = axis.type === 'log-frequency-log-y'
      ? mapLog(Math.max(axis.yMin, yValue), axis.yMin, axis.yMax, plot.y + plot.h, plot.y)
      : mapLinear(yValue, axis.yMin, axis.yMax, plot.y + plot.h, plot.y);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawLegend(series) {
  ui.legend.innerHTML = series.map((item) => `<span class="legend-item"><span class="legend-swatch" style="background:${item.color}"></span>${escapeHtml(item.name)}</span>`).join('');
}

function makeLinearTicks(min, max, count) {
  const values = [];
  const step = (max - min) / count;
  for (let i = 0; i <= count; i++) values.push(Math.round((min + step * i) * 100) / 100);
  return values;
}

function mapLinear(value, inMin, inMax, outMin, outMax) {
  return outMin + (value - inMin) / (inMax - inMin) * (outMax - outMin);
}

function mapLog(value, inMin, inMax, outMin, outMax) {
  return outMin + (Math.log(value) - Math.log(inMin)) / (Math.log(inMax) - Math.log(inMin)) * (outMax - outMin);
}

function formatFrequency(value) {
  return value >= 1000 ? `${value / 1000}k` : `${value}`;
}

async function saveCurrent() {
  if (!currentResult) return;
  try {
    const record = {
      id: currentResult.id,
      name: currentResult.name,
      createdAt: currentResult.createdAt,
      config: currentResult.config,
      result: currentResult
    };
    await dbPut(record);
    const index = savedMeasurements.findIndex((item) => item.id === record.id);
    if (index >= 0) savedMeasurements[index] = record;
    else savedMeasurements.unshift(record);
    renderSaved();
    refreshReferenceOptions();
    setStatus('測定結果を端末内へ保存しました。');
  } catch (error) {
    setStatus(`保存エラー：${error.message}`, true);
  }
}

function renderSaved() {
  if (!savedMeasurements.length) {
    ui.savedList.innerHTML = '<div class="empty">保存された測定はありません。</div>';
    return;
  }
  ui.savedList.innerHTML = '';
  for (const item of savedMeasurements) {
    const row = document.createElement('div');
    row.className = 'saved-item';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedSavedIds.has(item.id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedSavedIds.add(item.id);
      else selectedSavedIds.delete(item.id);
      drawGraph();
    });
    const info = document.createElement('div');
    const created = new Date(item.createdAt).toLocaleString('ja-JP');
    info.innerHTML = `<strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(created)} ／ ${escapeHtml(String(item.config?.distanceCm ?? '—'))} cm ／ ${escapeHtml(item.config?.speakerType ?? '')}</small>`;
    const remove = document.createElement('button');
    remove.textContent = '削除';
    remove.addEventListener('click', async () => {
      await dbDelete(item.id);
      savedMeasurements = savedMeasurements.filter((entry) => entry.id !== item.id);
      selectedSavedIds.delete(item.id);
      renderSaved();
      refreshReferenceOptions();
      drawGraph();
    });
    row.append(checkbox, info, remove);
    ui.savedList.append(row);
  }
}

function refreshReferenceOptions() {
  const selected = ui.referenceSelect.value;
  ui.referenceSelect.innerHTML = '<option value="">なし</option>' + savedMeasurements.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
  if (savedMeasurements.some((item) => item.id === selected)) ui.referenceSelect.value = selected;
}

async function deleteAllSaved() {
  if (!savedMeasurements.length) return;
  if (!confirm('保存した測定をすべて削除しますか？')) return;
  await dbClear();
  savedMeasurements = [];
  selectedSavedIds.clear();
  renderSaved();
  refreshReferenceOptions();
  drawGraph();
}


function exportPdfReport() {
  if (!currentResult) return;
  if (!window.SpeakerPdf?.buildRasterPdf) {
    setStatus('PDF作成モジュールを読み込めませんでした。ページを再読み込みしてください。', true);
    return;
  }

  ui.pdfBtn.disabled = true;
  setStatus('設定、解析概要、全グラフをPDFレポートへまとめています…');

  try {
    const totalPages = REPORT_VIEWS.length + 1;
    const pages = [];
    let pageCanvas = renderReportSummaryPage(1, totalPages);
    pages.push({
      jpegBytes: canvasToJpegBytes(pageCanvas, 0.90),
      pixelWidth: pageCanvas.width,
      pixelHeight: pageCanvas.height
    });
    pageCanvas.width = 1;
    pageCanvas.height = 1;

    for (let index = 0; index < REPORT_VIEWS.length; index++) {
      pageCanvas = renderReportGraphPage(REPORT_VIEWS[index], index + 2, totalPages);
      pages.push({
        jpegBytes: canvasToJpegBytes(pageCanvas, 0.90),
        pixelWidth: pageCanvas.width,
        pixelHeight: pageCanvas.height
      });
      pageCanvas.width = 1;
      pageCanvas.height = 1;
    }
    const pdfBytes = window.SpeakerPdf.buildRasterPdf(pages, {
      version: VERSION,
      createdAt: new Date()
    });
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const filename = `${safeFilename(currentResult.name)}-measurement-report.pdf`;

    if (typeof File === 'function' && navigator.share && navigator.canShare) {
      const file = new File([blob], filename, { type: 'application/pdf' });
      let fileShareSupported = false;
      try {
        fileShareSupported = navigator.canShare({ files: [file] });
      } catch {
        fileShareSupported = false;
      }
      if (fileShareSupported) {
        navigator.share({
          files: [file],
          title: `${currentResult.name} 測定レポート`,
          text: 'Speaker Measure Proの測定設定・解析結果PDF'
        }).then(() => {
          setStatus('PDFレポートを共有しました。');
        }).catch((error) => {
          if (error?.name === 'AbortError') {
            setStatus('PDFレポートの共有をキャンセルしました。');
            return;
          }
          downloadBlob(blob, filename);
          setStatus('共有機能を利用できなかったため、PDFをダウンロードしました。');
        });
        return;
      }
    }

    downloadBlob(blob, filename);
    setStatus(`全${totalPages}ページのPDFレポートを保存しました。`);
  } catch (error) {
    setStatus(`PDFレポートの作成に失敗しました：${error.message}`, true);
  } finally {
    updateResultButtons();
  }
}

function renderReportSummaryPage(pageNumber, totalPages) {
  const canvas = document.createElement('canvas');
  canvas.width = REPORT_PAGE_WIDTH;
  canvas.height = REPORT_PAGE_HEIGHT;
  const ctx = canvas.getContext('2d');
  const result = currentResult;
  const config = result.config || {};
  const summary = result.summary || {};
  const quality = assessMeasurementQuality(result);
  const warnings = getMeasurementWarnings(result);

  // PDFレポートは印刷を前提に白背景で描画する。
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, REPORT_PAGE_WIDTH, REPORT_PAGE_HEIGHT);

  ctx.fillStyle = '#0369a1';
  ctx.font = '700 18px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('SPEAKER ACOUSTIC MEASUREMENT REPORT', 54, 48);
  ctx.fillStyle = '#111827';
  ctx.font = '800 38px -apple-system, BlinkMacSystemFont, sans-serif';
  drawFittedText(ctx, result.name || 'Speaker measurement', 54, 95, 960, 38, 25);
  ctx.fillStyle = '#475569';
  ctx.font = '18px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText(`${new Date(result.createdAt).toLocaleString('ja-JP')}  /  Speaker Measure Pro ${VERSION}`, 56, 126);

  const qualityColors = { good: '#15803d', warn: '#a16207', bad: '#b91c1c', neutral: '#4b5563' };
  const badgeWidth = 190;
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = qualityColors[quality.level] || qualityColors.neutral;
  ctx.lineWidth = 2;
  ctx.fillRect(REPORT_PAGE_WIDTH - badgeWidth - 54, 61, badgeWidth, 54);
  ctx.strokeRect(REPORT_PAGE_WIDTH - badgeWidth - 54, 61, badgeWidth, 54);
  ctx.fillStyle = qualityColors[quality.level] || qualityColors.neutral;
  ctx.font = '700 22px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(quality.text, REPORT_PAGE_WIDTH - badgeWidth / 2 - 54, 96);

  const settings = [
    ['測定日時', new Date(result.createdAt).toLocaleString('ja-JP')],
    ['スピーカー種別', SPEAKER_TYPE_LABELS[config.speakerType] || config.speakerType || '—'],
    ['測定距離', formatNumber(config.distanceCm, 0, ' cm')],
    ['測定周波数', `${formatFrequency(config.startFreq)}～${formatFrequency(config.endFreq)} Hz`],
    ['スイープ時間', formatNumber(config.sweepDuration, 1, ' 秒')],
    ['出力レベル', Number.isFinite(config.level) ? `${Math.round(config.level * 100)} %` : '—'],
    ['平滑化', config.smoothing ? `1/${config.smoothing} octave` : 'なし'],
    ['時間窓', config.gateMs === 'full' ? '全残響' : formatNumber(config.gateMs, 0, ' ms')],
    ['IR窓関数', WINDOW_TYPE_LABELS[config.windowType] || config.windowType || '—'],
    ['正則化', formatNumber(config.regularizationDb, 0, ' dB')],
    ['正規化', config.normalize === false ? 'なし' : '500 Hz～2 kHz平均を0 dB'],
    ['マイク校正', config.calibrationName || 'なし'],
    ['サンプルレート', formatNumber(result.sampleRate, 0, ' Hz')],
    ['比較表示', selectedSavedIds.size ? `${selectedSavedIds.size}件を重ね表示` : 'なし']
  ];
  const results = [
    ['総遅延', formatNumber(summary.latencyMs, 1, ' ms')],
    ['開始マーカー', formatNumber(summary.startMarkerScore, 3)],
    ['終了マーカー', summary.endMarkerScore == null ? '未検出' : formatNumber(summary.endMarkerScore, 3)],
    ['マーカー混入', summary.markerLeakageScore == null ? '検査不能' : formatNumber(summary.markerLeakageScore, 3)],
    ['解析区間余白', summary.analysisMarginMs == null ? '—' : formatNumber(summary.analysisMarginMs, 0, ' ms')],
    ['クロック差', summary.driftPpm == null ? '—' : `${summary.driftPpm >= 0 ? '+' : ''}${formatNumber(summary.driftPpm, 0, ' ppm')}`],
    ['同期後残差', formatNumber(summary.directArrivalMs, 2, ' ms')],
    ['信頼帯域', `${formatFrequency(Math.round(summary.reliableStartHz || config.startFreq))}～${formatFrequency(Math.round(summary.reliableEndHz || config.endFreq))} Hz`],
    ['実励振帯域', `${formatFrequency(Math.round(summary.excitationStartHz))}～${formatFrequency(Math.round(summary.excitationEndHz))} Hz`],
    ['S/N（参考）', formatNumber(summary.snrDb, 1, ' dB')],
    ['入力ピーク', formatNumber(summary.inputPeakDbfs, 1, ' dBFS')],
    ['クリッピング', formatNumber(summary.clippingPercent, 3, ' %')],
    ['低域 −3 dB', summary.minus3Hz ? formatNumber(summary.minus3Hz, 0, ' Hz') : '範囲外'],
    ['低域 −6 dB', summary.minus6Hz ? formatNumber(summary.minus6Hz, 0, ' Hz') : '範囲外'],
    ['40～200 Hz平均', formatNumber(summary.lowBandDb, 1, ' dB')],
    ['4～12 kHz平均', formatNumber(summary.highBandDb, 1, ' dB')],
    ['振幅解析', summary.magnitudeEngine === 'coherent-ess-tracking' ? 'ESS同期追従' : '—'],
    ['差分基準', getReferenceName() || 'なし']
  ];

  drawReportPanel(ctx, 48, 160, 636, 548, '測定条件', settings, 2);
  drawReportPanel(ctx, 716, 160, 636, 548, '解析概要', results, 2);

  ctx.fillStyle = warnings.length ? '#fffbeb' : '#f0fdf4';
  ctx.strokeStyle = warnings.length ? '#d97706' : '#16a34a';
  ctx.lineWidth = 1.5;
  ctx.fillRect(48, 734, 1304, 184);
  ctx.strokeRect(48, 734, 1304, 184);
  ctx.fillStyle = warnings.length ? '#92400e' : '#166534';
  ctx.font = '700 21px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(warnings.length ? '測定上の注意' : '測定品質', 72, 770);
  const noteLines = warnings.length ? warnings : ['解析上の重大な警告は検出されていません。グラフの信頼帯域外、測定環境、マイク特性を考慮して評価してください。'];
  ctx.fillStyle = '#1f2937';
  ctx.font = '17px -apple-system, BlinkMacSystemFont, sans-serif';
  let noteY = 805;
  for (const note of noteLines.slice(0, 4)) {
    const lines = wrapCanvasText(ctx, `• ${note}`, 1230);
    for (const line of lines.slice(0, 2)) {
      ctx.fillText(line, 76, noteY);
      noteY += 25;
      if (noteY > 895) break;
    }
    if (noteY > 895) break;
  }

  drawReportPageNumber(ctx, pageNumber, totalPages);
  return canvas;
}

function drawReportPanel(ctx, x, y, width, height, title, items, columns = 2) {
  ctx.fillStyle = '#f8fafc';
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1.5;
  ctx.fillRect(x, y, width, height);
  ctx.strokeRect(x, y, width, height);
  ctx.fillStyle = '#111827';
  ctx.font = '700 24px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(title, x + 24, y + 39);
  ctx.strokeStyle = '#7dd3fc';
  ctx.beginPath();
  ctx.moveTo(x + 24, y + 56);
  ctx.lineTo(x + width - 24, y + 56);
  ctx.stroke();

  const perColumn = Math.ceil(items.length / columns);
  const innerWidth = width - 48;
  const columnWidth = innerWidth / columns;
  const rowHeight = Math.min(51, (height - 80) / perColumn);
  for (let index = 0; index < items.length; index++) {
    const column = Math.floor(index / perColumn);
    const row = index % perColumn;
    const itemX = x + 24 + column * columnWidth;
    const itemY = y + 86 + row * rowHeight;
    const [label, value] = items[index];
    ctx.fillStyle = '#475569';
    ctx.font = '15px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.fillText(label, itemX, itemY);
    ctx.fillStyle = '#0f172a';
    ctx.font = '600 18px -apple-system, BlinkMacSystemFont, sans-serif';
    drawFittedText(ctx, value, itemX, itemY + 23, columnWidth - 20, 18, 12);
  }
}

function drawFittedText(ctx, text, x, y, maxWidth, initialSize, minimumSize) {
  const value = String(text ?? '—');
  let size = initialSize;
  const weight = /700|800/.test(ctx.font) ? '700' : '600';
  while (size > minimumSize && ctx.measureText(value).width > maxWidth) {
    size -= 1;
    ctx.font = `${weight} ${size}px -apple-system, BlinkMacSystemFont, sans-serif`;
  }
  if (ctx.measureText(value).width <= maxWidth) {
    ctx.fillText(value, x, y);
    return;
  }
  let clipped = value;
  while (clipped.length > 1 && ctx.measureText(`${clipped}…`).width > maxWidth) clipped = clipped.slice(0, -1);
  ctx.fillText(`${clipped}…`, x, y);
}

function wrapCanvasText(ctx, text, maxWidth) {
  const characters = Array.from(String(text));
  const lines = [];
  let line = '';
  for (const character of characters) {
    const candidate = line + character;
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = character;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function renderReportGraphPage(view, pageNumber, totalPages) {
  const canvas = document.createElement('canvas');
  canvas.width = REPORT_PAGE_WIDTH;
  canvas.height = REPORT_PAGE_HEIGHT;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const graphCanvas = document.createElement('canvas');
  graphCanvas.width = 1250;
  graphCanvas.height = 900;
  const graphCtx = graphCanvas.getContext('2d');
  graphCtx.scale(1.25, 1.25);
  const previousView = currentView;
  const previousStartFreq = ui.startFreq.value;
  const previousEndFreq = ui.endFreq.value;
  try {
    currentView = view;
    if (Number.isFinite(currentResult?.config?.startFreq)) ui.startFreq.value = String(currentResult.config.startFreq);
    if (Number.isFinite(currentResult?.config?.endFreq)) ui.endFreq.value = String(currentResult.config.endFreq);
    const series = collectSeries();
    renderExportGraph(graphCtx, 1000, 720, series, { printMode: true });
  } finally {
    currentView = previousView;
    ui.startFreq.value = previousStartFreq;
    ui.endFreq.value = previousEndFreq;
  }

  const targetHeight = REPORT_PAGE_HEIGHT;
  const targetWidth = graphCanvas.width / graphCanvas.height * targetHeight;
  ctx.drawImage(graphCanvas, (REPORT_PAGE_WIDTH - targetWidth) / 2, 0, targetWidth, targetHeight);
  drawReportPageNumber(ctx, pageNumber, totalPages);
  return canvas;
}

function drawReportPageNumber(ctx, pageNumber, totalPages) {
  const boxWidth = 84;
  const boxHeight = 36;
  const x = REPORT_PAGE_WIDTH - boxWidth - 22;
  const y = REPORT_PAGE_HEIGHT - boxHeight - 18;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
  ctx.fillRect(x, y, boxWidth, boxHeight);
  ctx.strokeStyle = '#cbd5e1';
  ctx.strokeRect(x, y, boxWidth, boxHeight);
  ctx.fillStyle = '#475569';
  ctx.font = '600 16px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`${pageNumber} / ${totalPages}`, x + boxWidth / 2, y + 24);
}

function canvasToJpegBytes(canvas, quality = 0.90) {
  return dataUrlToBytes(canvas.toDataURL('image/jpeg', quality));
}

function dataUrlToBytes(dataUrl) {
  const encoded = dataUrl.split(',')[1] || '';
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}


function exportGraphPng() {
  const series = collectSeries();
  if (!series.length) return;

  try {
    const scale = 2;
    const logicalWidth = 1000;
    const logicalHeight = 720;
    const canvas = document.createElement('canvas');
    canvas.width = logicalWidth * scale;
    canvas.height = logicalHeight * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    renderExportGraph(ctx, logicalWidth, logicalHeight, series);

    const dataUrl = canvas.toDataURL('image/png');
    const blob = dataUrlToBlob(dataUrl);
    const viewSlug = { magnitude: 'frequency', phase: 'phase', groupDelay: 'group-delay', impulse: 'impulse-etc', step: 'step-response', decay: 'decay-map', thd: 'thd-harmonics' }[currentView] || 'graph';
    const baseName = currentResult?.name || series[0]?.name || 'speaker-measurement';
    const filename = `${safeFilename(baseName)}-${viewSlug}.png`;

    if (typeof File === 'function' && navigator.share && navigator.canShare) {
      const file = new File([blob], filename, { type: 'image/png' });
      let fileShareSupported = false;
      try {
        fileShareSupported = navigator.canShare({ files: [file] });
      } catch {
        fileShareSupported = false;
      }
      if (fileShareSupported) {
        navigator.share({
          files: [file],
          title: `${baseName}：${VIEW_LABELS[currentView]}`,
          text: 'Speaker Measure Proの測定グラフ'
        }).then(() => {
          setStatus('グラフ画像を共有しました。');
        }).catch((error) => {
          if (error?.name === 'AbortError') {
            setStatus('グラフ画像の共有をキャンセルしました。');
            return;
          }
          downloadBlob(blob, filename);
          setStatus('共有機能を利用できなかったため、PNGをダウンロードしました。');
        });
        return;
      }
    }

    downloadBlob(blob, filename);
    setStatus('現在のグラフをPNG画像として保存しました。');
  } catch (error) {
    setStatus(`グラフ画像の作成に失敗しました：${error.message}`, true);
  }
}

function renderExportGraph(ctx, width, height, series, options = {}) {
  const printMode = options.printMode === true;
  const theme = printMode ? {
    background: '#ffffff',
    text: '#111827',
    muted: '#475569',
    footer: '#64748b',
    grid: '#d1d5db',
    border: '#6b7280',
    axisText: '#374151',
    decayGrid: 'rgba(55, 65, 81, 0.22)',
    unreliableFill: 'rgba(190, 24, 93, 0.08)'
  } : {
    background: '#020713',
    text: '#f8fafc',
    muted: '#9fb0c7',
    footer: '#73849c',
    grid: '#26364d',
    border: '#4b607d',
    axisText: '#8292a8',
    decayGrid: 'rgba(130,146,168,0.35)',
    unreliableFill: 'rgba(251, 113, 133, 0.10)'
  };

  const exportSeries = printMode
    ? series.map((item) => ({ ...item, color: printSeriesColor(item.color) }))
    : series;

  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);

  const title = currentResult?.name || exportSeries[0]?.name || 'Speaker measurement';
  ctx.fillStyle = theme.text;
  ctx.font = '700 26px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(title, 56, 48);

  ctx.fillStyle = theme.muted;
  ctx.font = '15px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText(VIEW_LABELS[currentView], 56, 76);

  const metaParts = [];
  const sourceResult = currentResult || exportSeries[0]?.result;
  if (sourceResult?.createdAt) metaParts.push(new Date(sourceResult.createdAt).toLocaleString('ja-JP'));
  if (sourceResult?.config?.distanceCm != null) metaParts.push(`距離 ${sourceResult.config.distanceCm} cm`);
  if (sourceResult?.config?.speakerType) metaParts.push(sourceResult.config.speakerType);
  if (currentView === 'magnitude' && sourceResult?.config?.smoothing) metaParts.push(`平滑化 1/${sourceResult.config.smoothing} oct`);
  if (sourceResult?.summary?.reliableEndHz) metaParts.push(`信頼上限 ${formatFrequency(Math.round(sourceResult.summary.reliableEndHz))} Hz`);
  const referenceName = getReferenceName();
  if (referenceName && currentView === 'magnitude') metaParts.push(`差分基準 ${referenceName}`);
  ctx.fillText(metaParts.join('  ／  '), 56, 100);

  const plot = { x: 76, y: 126, w: width - (currentView === 'decay' ? 150 : 112), h: 466 };
  if (currentView === 'decay') {
    drawDecayHeatmap(ctx, plot, sourceResult?.decay, theme);
  } else {
    const axis = makeAxis(exportSeries);
    drawAxes(ctx, plot, axis, theme);
    drawReliabilityShading(ctx, plot, axis, theme);
    for (const item of exportSeries) drawSeries(ctx, plot, axis, item);
    drawExportLegend(ctx, exportSeries, 76, 622, width - 112, theme);
  }

  ctx.fillStyle = theme.footer;
  ctx.font = '13px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(`Speaker Measure Pro ${VERSION}`, width - 56, height - 24);
}

function printSeriesColor(color) {
  const normalized = String(color || '').toLowerCase();
  const replacements = {
    '#f8fafc': '#111827',
    '#38bdf8': '#0369a1',
    '#a3e635': '#4d7c0f',
    '#facc15': '#a16207',
    '#c084fc': '#7e22ce',
    '#fb7185': '#be123c',
    '#2dd4bf': '#0f766e',
    '#f97316': '#c2410c',
    '#818cf8': '#4338ca'
  };
  return replacements[normalized] || color || '#111827';
}

function drawExportLegend(ctx, series, startX, startY, maxWidth, theme = null) {
  ctx.font = '14px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textBaseline = 'middle';
  let x = startX;
  let y = startY;
  for (const item of series) {
    const label = item.name;
    const itemWidth = 28 + ctx.measureText(label).width + 24;
    if (x > startX && x + itemWidth > startX + maxWidth) {
      x = startX;
      y += 28;
    }
    ctx.strokeStyle = item.color;
    ctx.lineWidth = Math.max(2, item.width);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + 20, y);
    ctx.stroke();
    ctx.fillStyle = theme?.text || '#dbe7f5';
    ctx.textAlign = 'left';
    ctx.fillText(label, x + 28, y);
    x += itemWidth;
  }
}

function getReferenceName() {
  const referenceId = ui.referenceSelect.value;
  if (!referenceId) return '';
  return savedMeasurements.find((item) => item.id === referenceId)?.name || '';
}

function dataUrlToBlob(dataUrl) {
  const header = dataUrl.split(',')[0];
  const mime = header.match(/data:([^;]+)/)?.[1] || 'application/octet-stream';
  return new Blob([dataUrlToBytes(dataUrl)], { type: mime });
}

function exportCsv() {
  if (!currentResult) return;
  const s = currentResult.summary;
  const lines = [
    `# Speaker Measure Pro ${VERSION}`,
    `# name,${csvEscape(currentResult.name)}`,
    `# created_at,${currentResult.createdAt}`,
    `# sample_rate,${currentResult.sampleRate}`,
    `# latency_ms,${s.latencyMs}`,
    `# start_marker_score,${s.startMarkerScore}`,
    `# end_marker_score,${s.endMarkerScore ?? ''}`,
    `# marker_leakage_score,${s.markerLeakageScore ?? ''}`,
    `# drift_ppm,${s.driftPpm ?? ''}`,
    `# reliable_band_hz,${s.reliableStartHz},${s.reliableEndHz}`,
    `# excitation_band_hz,${s.excitationStartHz},${s.excitationEndHz}`,
    '',
    '[frequency_response]',
    'frequency_hz,magnitude_db,valid,reference_support_db,phase_deg,phase_unwrapped_deg,group_delay_ms,thd_percent,h2_percent,h3_percent,h4_percent,h5_percent'
  ];
  const thd = currentResult.thd || [];
  for (let i = 0; i < currentResult.magnitude.length; i++) {
    const mag = currentResult.magnitude[i];
    const phase = currentResult.phase[i];
    const gd = currentResult.groupDelay?.[i];
    const nearestThd = thd.length ? thd.reduce((best, p) => Math.abs(Math.log(p.f / mag.f)) < Math.abs(Math.log(best.f / mag.f)) ? p : best, thd[0]) : null;
    lines.push(`${mag.f},${mag.db},${mag.valid !== false},${mag.supportDb ?? ''},${phase?.deg ?? ''},${phase?.unwrappedDeg ?? ''},${gd?.ms ?? ''},${nearestThd?.percent ?? ''},${nearestThd?.h2 ?? ''},${nearestThd?.h3 ?? ''},${nearestThd?.h4 ?? ''},${nearestThd?.h5 ?? ''}`);
  }
  lines.push('', '[impulse_etc]', 'time_ms,normalized_impulse,etc_db');
  for (const point of currentResult.impulse || []) lines.push(`${point.tMs},${point.value},${point.etcDb}`);
  lines.push('', '[step_response]', 'time_ms,normalized_step');
  for (const point of currentResult.step || []) lines.push(`${point.tMs},${point.value}`);
  downloadBlob(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }), `${safeFilename(currentResult.name)}.csv`);
}

function exportJson() {
  if (!currentResult) return;
  downloadBlob(new Blob([JSON.stringify(currentResult, null, 2)], { type: 'application/json' }), `${safeFilename(currentResult.name)}.json`);
}

function exportWav() {
  if (!lastRecording || !audioContext) return;
  downloadBlob(encodeWav16(lastRecording, audioContext.sampleRate), `${safeFilename(currentResult?.name || 'recording')}-raw.wav`);
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function safeFilename(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'measurement';
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDBを開けませんでした。'));
  });
}

async function dbPut(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function dbList() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

async function dbDelete(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function dbClear() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
