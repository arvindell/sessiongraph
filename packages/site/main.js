import { animateGraphBackground } from './graph-background.js';

const background = document.querySelector('.graph-background');
if (background) animateGraphBackground(background).catch(() => {}); // The static SVG remains if canvas is unavailable.

const video = document.querySelector('#product-video');

if (video) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let inView = !('IntersectionObserver' in window);
  // Keep the poster as a quiet fallback for reduced motion or blocked autoplay.
  // Playback only consumes resources while the demo is actually visible.
  video.autoplay = false;
  video.muted = true;
  const updatePlayback = () => {
    if (reducedMotion.matches || document.hidden || !inView) video.pause();
    else video.play().catch(() => {});
  };
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      updatePlayback();
    }, { threshold: 0 }).observe(video);
  }
  reducedMotion.addEventListener('change', updatePlayback);
  document.addEventListener('visibilitychange', updatePlayback);
  updatePlayback();
}

const copyStatus = document.querySelector('#copy-status');
for (const copy of document.querySelectorAll('[data-copy-command]')) {
  const command = copy.closest('.command-box').querySelector('code');
  const icon = copy.querySelector('[data-copy-icon]'), originalIcon = icon.innerHTML;
  const hint = copy.querySelector('.command-copy-hint');
  let reset;
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(command.textContent);
      if (copyStatus) copyStatus.textContent = 'Copied npx sessiongraph to your clipboard. Paste it into your terminal to get started.';
      copy.setAttribute('aria-label', 'Command copied. Copy again');
      copy.dataset.copied = '';
      icon.innerHTML = '<path d="m4 10 4 4 8-8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
      hint.textContent = 'Copied!';
      clearTimeout(reset);
      reset = setTimeout(() => {
        copy.setAttribute('aria-label', 'Copy npx sessiongraph');
        delete copy.dataset.copied;
        icon.innerHTML = originalIcon;
        hint.textContent = 'Copy command';
      }, 2000);
    } catch {
      const selection = window.getSelection(), range = document.createRange();
      range.selectNodeContents(command); selection?.removeAllRanges(); selection?.addRange(range);
      if (copyStatus) copyStatus.textContent = 'Command selected. Copy it and paste it into your terminal.';
    }
  });
}
