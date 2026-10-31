import { BufferTarget, canEncodeVideo, Mp4OutputFormat, Output, Quality, VideoSample, VideoSampleSource } from 'mediabunny';
import { SHARE_FPS, SHARE_FRAMES } from './playback';

let output: Output<Mp4OutputFormat, BufferTarget> | undefined, source: VideoSampleSource | undefined;
let frame = 0;
const unsupported = 'MP4 encoding is unavailable here. Choose GIF or try an up-to-date browser.';

self.onmessage = async (event: MessageEvent<{ init?: boolean; rgba?: ArrayBuffer; width: number; height: number; finish?: boolean }>) => {
  try {
    const { width, height, rgba } = event.data;
    if (event.data.init) {
      const config = { codec: 'avc' as const, fullCodecString: 'avc1.42001f', quality: new Quality({ bitrate: 6_000_000 }), latencyMode: 'quality' as const };
      if (!await canEncodeVideo('avc', { ...config, width, height, frameRate: SHARE_FPS })) throw new Error(unsupported);
      output = new Output({ format: new Mp4OutputFormat({ fastStart: 'reserve' }), target: new BufferTarget() });
      source = new VideoSampleSource(config);
      output.addVideoTrack(source, { frameRate: SHARE_FPS, maximumPacketCount: SHARE_FRAMES });
      await output.start();
      self.postMessage({ ready: true });
    } else if (event.data.finish) {
      if (!output || frame !== SHARE_FRAMES) throw new Error('Incomplete MP4 animation.');
      await output.finalize();
      const bytes = output.target.buffer;
      if (!bytes) throw new Error('MP4 encoding produced no video.');
      self.postMessage({ bytes }, { transfer: [bytes] });
    } else {
      if (!source || !rgba || rgba.byteLength !== width * height * 4) throw new Error('Incomplete MP4 frame.');
      const sample = new VideoSample(rgba, {
        format: 'RGBA', codedWidth: width, codedHeight: height, timestamp: frame / SHARE_FPS, duration: 1 / SHARE_FPS,
        colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true },
      });
      // Await encoder backpressure and release every raw frame before accepting another.
      try { await source.add(sample); } finally { sample.close(); }
      frame++;
      self.postMessage({ ready: true });
    }
  } catch (error) {
    self.postMessage({ error: error instanceof Error && error.message === unsupported ? unsupported : 'MP4 encoding failed. Try again or choose GIF.' });
    await output?.cancel().catch(() => {});
  }
};
