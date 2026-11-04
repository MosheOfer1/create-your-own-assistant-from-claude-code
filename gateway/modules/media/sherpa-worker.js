import { parentPort, workerData } from 'node:worker_threads';

// Runs in a worker thread (see sherpaTranscriber in transcribe.js): loads the model once, then
// turns 16 kHz float32 samples into text, one job after the other.
const { files, threads, modelType } = workerData;
let recognizer = null;
let fatal = null;
try {
  // A dynamic import: sherpa-onnx-node is an optional dependency, so a missing package is a
  // message here, not a crash of the gateway.
  const { default: sherpa } = await import('sherpa-onnx-node');
  recognizer = new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
      tokens: files.tokens,
      modelType,
      numThreads: threads,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
  });
} catch (e) {
  fatal = e.message;
  parentPort.postMessage({ fatal });
}

parentPort.on('message', ({ id, samples }) => {
  if (fatal) return parentPort.postMessage({ id, error: `sherpa could not load: ${fatal}`, setup: true });
  try {
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate: 16000 });
    // 1.5 s of silence flushes the last chunk of a streaming model.
    stream.acceptWaveform({ samples: new Float32Array(24000), sampleRate: 16000 });
    stream.inputFinished();
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    parentPort.postMessage({ id, text: recognizer.getResult(stream).text.trim() });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
