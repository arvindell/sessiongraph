import { createGifEncoder } from './gif-encoder';

const encoder = createGifEncoder();
self.onmessage = (event: MessageEvent<{ rgba?: ArrayBuffer; width: number; height: number; finish?: boolean }>) => {
  try {
    if (event.data.finish) {
      const bytes = encoder.finish();
      self.postMessage({ bytes: bytes.buffer }, { transfer: [bytes.buffer] });
    } else {
      encoder.add(new Uint8Array(event.data.rgba!), event.data.width, event.data.height);
      self.postMessage({ ready: true });
    }
  } catch {
    self.postMessage({ error: 'GIF encoding failed. Please try again.' });
  }
};
