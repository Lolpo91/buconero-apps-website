(function () {
  'use strict';

  const INTRO_DURATION = 3200;
  const intro = document.getElementById('intro');
  const main = document.getElementById('main');
  const canvas = document.getElementById('buconero-canvas');
  const ctx = canvas.getContext('2d');

  let particles = [];
  let animationId;
  let startTime = null;

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function initParticles(count) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cx = w / 2;
    const cy = h / 2;
    particles = [];

    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 80 + Math.random() * Math.max(w, h) * 0.6;
      particles.push({
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
        size: 0.5 + Math.random() * 2,
        speed: 0.02 + Math.random() * 0.04,
        alpha: 0.3 + Math.random() * 0.7,
        trail: [],
      });
    }
  }

  function drawBuconero(timestamp) {
    if (!startTime) startTime = timestamp;
    const elapsed = timestamp - startTime;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const cx = w / 2;
    const cy = h / 2;

    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.fillRect(0, 0, w, h);

    const pull = Math.min(1, elapsed / INTRO_DURATION);
    const eventHorizon = 40 + pull * 20;

    particles.forEach((p) => {
      const dx = cx - p.x;
      const dy = cy - p.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;

      const force = (p.speed + pull * 0.08) * (1 + 200 / dist);
      p.x += (dx / dist) * force;
      p.y += (dy / dist) * force;

      p.trail.push({ x: p.x, y: p.y });
      if (p.trail.length > 8) p.trail.shift();

      if (dist < eventHorizon) {
        const angle = Math.random() * Math.PI * 2;
        const respawn = 100 + Math.random() * Math.max(w, h) * 0.5;
        p.x = cx + Math.cos(angle) * respawn;
        p.y = cy + Math.sin(angle) * respawn;
        p.trail = [];
      }

      for (let t = 0; t < p.trail.length - 1; t++) {
        const a = (t / p.trail.length) * p.alpha * 0.4;
        ctx.strokeStyle = `rgba(200, 200, 220, ${a})`;
        ctx.lineWidth = p.size * 0.5;
        ctx.beginPath();
        ctx.moveTo(p.trail[t].x, p.trail[t].y);
        ctx.lineTo(p.trail[t + 1].x, p.trail[t + 1].y);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(230, 230, 240, ${p.alpha})`;
      ctx.fill();
    });

    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, eventHorizon + 30);
    grad.addColorStop(0, 'rgba(0, 0, 0, 1)');
    grad.addColorStop(0.4, 'rgba(0, 0, 0, 0.6)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    animationId = requestAnimationFrame(drawBuconero);
  }

  function endIntro() {
    cancelAnimationFrame(animationId);
    intro.classList.add('fade-out');
    main.classList.remove('hidden');
    main.classList.add('visible');
    document.body.style.overflow = '';

    setTimeout(() => {
      intro.remove();
    }, 900);
  }

  function startIntro() {
    document.body.style.overflow = 'hidden';
    resizeCanvas();
    initParticles(window.innerWidth < 640 ? 80 : 140);
    animationId = requestAnimationFrame(drawBuconero);

    setTimeout(endIntro, INTRO_DURATION);
  }

  window.addEventListener('resize', () => {
    if (intro && !intro.classList.contains('fade-out')) {
      resizeCanvas();
    }
  });

  if (intro && canvas && ctx) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startIntro);
    } else {
      startIntro();
    }
  } else if (main) {
    main.classList.remove('hidden');
    main.classList.add('visible');
  }
})();
