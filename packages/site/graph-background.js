/** Animate the same paths as the static SVG, so the fallback and moving trails stay aligned. */
export async function animateGraphBackground(canvas) {
  const context = canvas.getContext('2d');
  if (!context) return;
  // Keep this fetch same-origin under the production Content Security Policy.
  const response = await fetch(new URL('./assets/graph-field.svg?no-inline', import.meta.url));
  if (!response.ok) return;
  const svg = new DOMParser().parseFromString(await response.text(), 'image/svg+xml');
  const trails = [...svg.querySelectorAll('path')].map((path, index) => {
    const length = path.getTotalLength(), steps = Math.ceil(length / 3);
    return {
      points: Array.from({ length: steps + 1 }, (_, step) => path.getPointAtLength(step / steps * length)),
      length, speed: 24 + index % 4 * 5, phase: index * .618 % 1,
      color: path.parentElement.getAttribute('stroke') === 'url(#lilac)' ? '210, 181, 212' : '169, 223, 206',
    };
  });
  if (!trails.length) return;

  // Cache small glow sprites instead of blurring the full canvas on every frame.
  const glows = new Map(trails.map(({ color }) => [color, null]));
  for (const color of glows.keys()) {
    const sprite = document.createElement('canvas');
    sprite.width = sprite.height = 64;
    const brush = sprite.getContext('2d');
    if (!brush) return;
    const glow = brush.createRadialGradient(32, 32, 0, 32, 32, 32);
    glow.addColorStop(0, `rgba(${color}, .6)`);
    glow.addColorStop(.2, `rgba(${color}, .2)`);
    glow.addColorStop(1, `rgba(${color}, 0)`);
    brush.fillStyle = glow;
    brush.fillRect(0, 0, 64, 64);
    glows.set(color, sprite);
  }

  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  animatePageField(canvas, glows, motion);
  let width = 0, height = 0, ratio = 1, scale = 1, offset = 0;
  let frame = 0, elapsed = 0, previousTime = 0;
  let inView = !('IntersectionObserver' in window);

  const position = (trail, distance) => {
    const sample = Math.max(0, Math.min(1, distance / trail.length)) * (trail.points.length - 1);
    const index = Math.min(Math.floor(sample), trail.points.length - 2), mix = sample - index;
    const a = trail.points[index], b = trail.points[index + 1];
    return { x: a.x + (b.x - a.x) * mix, y: a.y + (b.y - a.y) * mix };
  };
  // Match the SVG's elliptical fade; keep the area behind the headline quiet.
  const opacity = ({ x, y }) => {
    const distance = Math.hypot((x - 800) / 1000, (y - 460) / 650);
    return distance < .15 ? .12 : distance < .65 ? .12 + (distance - .15) / .5 * .88 : Math.max(0, (1 - distance) / .35);
  };
  const clear = () => {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
  };
  const draw = () => {
    clear();
    context.setTransform(ratio * scale, 0, 0, ratio * scale, ratio * offset, 0);
    context.lineCap = 'round';
    trails.forEach((trail, index) => {
      const distance = (elapsed * trail.speed + trail.phase * trail.length) % trail.length;
      const point = position(trail, distance);
      const fade = Math.min(1, distance / 30, (trail.length - distance) / 35);
      context.strokeStyle = `rgb(${trail.color})`;
      context.lineWidth = 1.2;
      // A short, fading comet tail follows each branch without moving the graph itself.
      for (let step = 1; step <= 18; step++) {
        if (distance - step * 3 < 0) break;
        const a = position(trail, distance - step * 3), b = position(trail, distance - (step - 1) * 3);
        context.globalAlpha = opacity(a) * fade * (1 - step / 19) * .6;
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.stroke();
      }
      context.globalAlpha = opacity(point) * fade * .8;
      context.drawImage(glows.get(trail.color), point.x - 14, point.y - 14, 28, 28);
      context.fillStyle = `rgb(${trail.color})`;
      context.beginPath();
      context.arc(point.x, point.y, 1.7, 0, Math.PI * 2);
      context.fill();

      const end = trail.points[trail.points.length - 1];
      const pulse = .35 + .2 * Math.sin(elapsed * .9 + index);
      context.globalAlpha = opacity(end) * pulse;
      context.drawImage(glows.get(trail.color), end.x - 12, end.y - 12, 24, 24);
    });
    context.globalAlpha = 1;
  };
  const tick = time => {
    elapsed += previousTime ? Math.min((time - previousTime) / 1000, .1) : 0;
    previousTime = time;
    draw();
    frame = requestAnimationFrame(tick);
  };
  const update = () => {
    const active = inView && !document.hidden && !motion.matches && width > 0;
    if (active && !frame) frame = requestAnimationFrame(tick);
    else if (!active) {
      cancelAnimationFrame(frame);
      frame = previousTime = 0;
    }
    if (motion.matches) clear();
  };
  const resize = () => {
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    // Keep this in sync with the CSS background-size for the SVG underneath.
    const sceneWidth = Math.max(900, width);
    scale = sceneWidth / 1600;
    offset = (width - sceneWidth) / 2;
    if (!motion.matches) draw();
    update();
  };
  new ResizeObserver(resize).observe(canvas);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; update(); }).observe(canvas);
  }
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', update);
  motion.addEventListener('change', update);
  resize();
}

/** Keep the lower canvas viewport-sized, even when the source list expands. */
function animatePageField(hero, glows, motion) {
  const canvas = document.createElement('canvas');
  canvas.className = 'graph-page-field';
  canvas.setAttribute('aria-hidden', 'true');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  hero.after(canvas);

  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const colors = [...glows.keys()];
  const lanes = Array.from({ length: 8 }, (_, i) => ({
    i, color: colors[i % colors.length], spacing: 290 + (i * 67) % 180, speed: 36 + (i * 11) % 33,
  }));
  let width = 0, height = 0, ratio = 1, frame = 0, elapsed = 0, previousTime = 0;
  let geometry, start = 0;
  const xAt = (i, y) => {
    const band = Math.min(width * .30, 350);
    const sway = .46 + .24 * Math.sin(y / (250 + i * 23) + i * 2.4) + .13 * Math.sin(y / 117 - i * .85);
    const x = band * (sway + ((i >> 1) - 1.5) * .17);
    return i % 2 ? width - x : x;
  };

  function visiblePaths(scroll) {
    const first = Math.floor(scroll / 240) * 240 - 24;
    if (geometry?.first === first) return geometry.paths;
    const paths = lanes.map(({ i }) => {
      const path = new Path2D();
      path.moveTo(xAt(i, first), first);
      for (let y = first + 12; y <= first + height + 288; y += 12) path.lineTo(xAt(i, y), y);
      return path;
    });
    geometry = { first, paths };
    return paths;
  }

  function paint() {
    const scroll = window.scrollY;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (scroll + height <= start) return;
    const fade = ctx.createLinearGradient(0, start - scroll, 0, start + 330 - scroll);
    fade.addColorStop(0, 'transparent');
    fade.addColorStop(1, '#fff');
    const paths = visiblePaths(scroll);
    ctx.translate(0, -scroll);
    ctx.lineWidth = 1;
    for (const { i, color, spacing, speed } of lanes) {
      ctx.strokeStyle = `rgb(${color})`;
      ctx.globalAlpha = .08 + (i % 3) * .027;
      ctx.stroke(paths[i]);
      if (motion.matches) continue;
      const offset = (elapsed * speed + i * 113) % spacing;
      for (let y = Math.floor((scroll - offset - 14) / spacing) * spacing + offset; y < scroll + height + 14; y += spacing) {
        const x = xAt(i, y);
        ctx.globalAlpha = .48 + .15 * Math.sin(y / 130 + i);
        ctx.drawImage(glows.get(color), x - 11, y - 11, 22, 22);
        ctx.fillStyle = `rgb(${color})`;
        ctx.beginPath(); ctx.arc(x, y, 1.2, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    if (scroll < start + 330) {
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = fade;
      ctx.fillRect(0, 0, width, height);
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  function tick(time) {
    frame = 0;
    if (!document.hidden && !motion.matches && window.scrollY + height > start) {
      elapsed += previousTime ? clamp((time - previousTime) / 1000, 0, .05) : 0;
      previousTime = time;
      frame = requestAnimationFrame(tick);
    } else previousTime = 0;
    paint();
  }
  function update() {
    if (!frame && !document.hidden) frame = requestAnimationFrame(tick);
  }
  function resize() {
    width = canvas.clientWidth; height = canvas.clientHeight;
    ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    start = hero.offsetTop + hero.clientHeight * .63;
    geometry = undefined; update();
  }
  new ResizeObserver(resize).observe(canvas);
  window.addEventListener('scroll', update, { passive: true });
  document.addEventListener('visibilitychange', update);
  motion.addEventListener('change', update);
  resize();
}
