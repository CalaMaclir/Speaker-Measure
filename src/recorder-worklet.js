class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.chunkSize = 4096;
    this.buffer = new Float32Array(this.chunkSize);
    this.offset = 0;
    this.port.onmessage = (event) => {
      const type = event.data?.type;
      if (type === 'start') {
        this.offset = 0;
        this.recording = true;
        this.port.postMessage({ type: 'started' });
      } else if (type === 'stop') {
        this.flush();
        this.recording = false;
        this.port.postMessage({ type: 'stopped' });
      } else if (type === 'reset') {
        this.offset = 0;
      }
    };
  }

  flush() {
    if (!this.offset) return;
    const chunk = this.buffer.slice(0, this.offset);
    this.port.postMessage({ type: 'chunk', chunk }, [chunk.buffer]);
    this.offset = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!this.recording || !channel) return true;
    let sourceOffset = 0;
    while (sourceOffset < channel.length) {
      const writable = Math.min(this.chunkSize - this.offset, channel.length - sourceOffset);
      this.buffer.set(channel.subarray(sourceOffset, sourceOffset + writable), this.offset);
      this.offset += writable;
      sourceOffset += writable;
      if (this.offset === this.chunkSize) this.flush();
    }
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
