class WavRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.port.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === "start") {
        this.recording = true;
      } else if (message.type === "stop") {
        this.recording = false;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    const frameCount =
      (output[0] && output[0].length) ||
      (input[0] && input[0].length) ||
      128;

    for (let channel = 0; channel < output.length; channel += 1) {
      const out = output[channel];
      const source = input[channel] || input[0];
      if (source) {
        out.set(source);
      } else {
        out.fill(0);
      }
    }

    if (this.recording) {
      const mono = new Float32Array(frameCount);
      if (input.length > 0) {
        for (let i = 0; i < frameCount; i += 1) {
          let sum = 0;
          for (let channel = 0; channel < input.length; channel += 1) {
            sum += input[channel][i] || 0;
          }
          mono[i] = sum / input.length;
        }
      }
      this.port.postMessage({ type: "pcm", samples: mono }, [mono.buffer]);
    }

    return true;
  }
}

registerProcessor("wav-recorder-processor", WavRecorderProcessor);
