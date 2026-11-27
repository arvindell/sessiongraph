import { HalfFloatType, WebGLRenderTarget, type WebGLRenderer } from 'three';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { TexturePass } from 'three/addons/postprocessing/TexturePass.js';

/** Resolve geometry antialiasing once; fullscreen effects need no MSAA/depth. */
export class SceneRenderPass extends RenderPass {
  private target = new WebGLRenderTarget(1, 1, { type: HalfFloatType });
  private copy = new TexturePass(this.target.texture);

  setSamples(samples: number) {
    if (this.target.samples === samples) return;
    this.target.samples = samples;
    this.target.dispose();
  }

  override setSize(width: number, height: number) { this.target.setSize(width, height); }

  override render(renderer: WebGLRenderer, writeBuffer: WebGLRenderTarget, readBuffer: WebGLRenderTarget, delta: number, mask: boolean) {
    // Performance mode needs neither an intermediate scene target nor a copy.
    if (!this.target.samples) {
      super.render(renderer, writeBuffer, readBuffer, delta, mask);
      return;
    }
    super.render(renderer, writeBuffer, this.target, delta, mask);
    this.copy.render(renderer, writeBuffer, readBuffer, delta, mask);
  }

  override dispose() { this.copy.dispose(); this.target.dispose(); }
}
