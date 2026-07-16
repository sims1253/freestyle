import { encodeWavFromFloat32 } from "./wav";

const TARGET_SAMPLE_RATE = 16_000;

/** Decode an audio file in the renderer and return Starling's PCM16 mono WAV. */
export async function decodeAudioFileToWav(file: File): Promise<Blob> {
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(
      (await file.arrayBuffer()).slice(0),
    );
  } finally {
    await context.close();
  }

  const mono = mixToMono(decoded);
  const resampled = await resample(mono, decoded.sampleRate);
  return new Blob([encodeWavFromFloat32(resampled, TARGET_SAMPLE_RATE)], {
    type: "audio/wav",
  });
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const samples = buffer.getChannelData(channel);
    for (let index = 0; index < buffer.length; index++) {
      mono[index] += samples[index] / buffer.numberOfChannels;
    }
  }
  return mono;
}

async function resample(
  samples: Float32Array,
  sourceSampleRate: number,
): Promise<Float32Array> {
  if (sourceSampleRate === TARGET_SAMPLE_RATE) return samples;
  const length = Math.ceil(
    (samples.length * TARGET_SAMPLE_RATE) / sourceSampleRate,
  );
  const context = new OfflineAudioContext(1, length, TARGET_SAMPLE_RATE);
  const buffer = context.createBuffer(1, samples.length, sourceSampleRate);
  buffer.getChannelData(0).set(samples);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  return (await context.startRendering()).getChannelData(0);
}
