const video = document.querySelector('#product-video');
const poster = document.querySelector('#product-poster');
const toggle = document.querySelector('#demo-toggle');
const label = document.querySelector('#demo-label');
const demoStatus = document.querySelector('#demo-status');

function closeDemo() {
  video.pause();
  video.hidden = true;
  poster.hidden = false;
  toggle.setAttribute('aria-expanded', 'false');
  label.textContent = 'Watch demo';
}

if (video && toggle && poster && label && demoStatus) {
  toggle.hidden = false;
  toggle.addEventListener('click', async () => {
    if (!video.hidden) {
      closeDemo();
      return;
    }
    const source = video.querySelector('source');
    if (!source.hasAttribute('src')) {
      source.src = source.dataset.src;
      video.load();
    }
    poster.hidden = true;
    video.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    label.textContent = 'Close demo';
    demoStatus.textContent = '';
    try {
      await video.play();
    } catch (error) {
      if (error.name === 'AbortError') return;
      demoStatus.textContent = 'Use the video controls to play the demo.';
    }
  });
  video.addEventListener('error', () => {
    closeDemo();
    video.querySelector('source').removeAttribute('src');
    demoStatus.textContent = 'The demo could not load. You can try again.';
  });
  // Stop decoding while the demo is off screen; resume only on an explicit play.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) video.pause();
    }).observe(video);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) video.pause();
  });
}

const copy = document.querySelector('#copy-command');
const copyStatus = document.querySelector('#copy-status');
if (copy && copyStatus && navigator.clipboard) {
  copy.hidden = false;
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText('npx sessiongraph');
      copyStatus.textContent = 'Copied npx sessiongraph to your clipboard.';
      copy.setAttribute('aria-label', 'Command copied. Copy again');
      copy.dataset.copied = '';
      copy.innerHTML = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m4 10 4 4 8-8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    } catch {
      copyStatus.textContent = 'Select the command to copy it manually.';
    }
  });
}
