'use strict';
importScripts('./dsp-core.js?v=4.1.0');

self.onmessage = (event) => {
  try {
    const { recorded, sampleRate, config } = event.data;
    if (!recorded || !sampleRate || !config) throw new Error('解析データが不足しています。');
    const samples = recorded instanceof Float32Array ? recorded : new Float32Array(recorded);
    const result = self.SpeakerDSP.analyzeMeasurement(samples, sampleRate, config, (value, message) => {
      self.postMessage({ type: 'progress', value, message });
    });
    self.postMessage({ type: 'result', result });
  } catch (error) {
    self.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : ''
    });
  }
};
