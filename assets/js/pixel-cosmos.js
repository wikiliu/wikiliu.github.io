(() => {
  "use strict";

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = window.matchMedia("(pointer: fine)").matches;
  const root = document.documentElement;

  const starCanvas = document.createElement("canvas");
  starCanvas.id = "pixel-starfield";
  starCanvas.setAttribute("aria-hidden", "true");
  document.body.prepend(starCanvas);

  const starCtx = starCanvas.getContext("2d");
  const palette = ["#55f4ff", "#ff75d8", "#9a87ff", "#ffe36e", "#7dffc5", "#f5f7ff"];
  let width = 0;
  let height = 0;
  let dpr = 1;
  let stars = [];
  let pulses = [];
  let sparks = [];
  let shots = [];
  let lastTime = performance.now();

  const pointer = {
    x: window.innerWidth * 0.5,
    y: window.innerHeight * 0.42,
    previousX: window.innerWidth * 0.5,
    previousY: window.innerHeight * 0.42,
    aimX: 1,
    aimY: 0,
    active: false
  };

  function makeStar(index) {
    const x = Math.random() * width;
    const y = Math.random() * height;
    return {
      x,
      y,
      homeX: x,
      homeY: y,
      vx: (Math.random() - 0.5) * 0.05,
      vy: (Math.random() - 0.5) * 0.05,
      size: index % 11 === 0 ? 2 : 1,
      phase: Math.random() * Math.PI * 2,
      color: palette[index % palette.length],
      alive: true
    };
  }

  function updateStarCount() {
    starCanvas.dataset.starCount = String(stars.filter((star) => star.alive).length);
  }

  function resize() {
    width = window.innerWidth;
    height = window.innerHeight;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    starCanvas.width = Math.floor(width * dpr);
    starCanvas.height = Math.floor(height * dpr);
    starCanvas.style.width = width + "px";
    starCanvas.style.height = height + "px";
    starCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const desired = Math.max(110, Math.min(240, Math.round((width * height) / 7800)));
    stars = Array.from({ length: desired }, (_, index) => makeStar(index));
    updateStarCount();
  }

  function addPulse(x, y, strong, color = "85, 244, 255") {
    pulses.push({
      x,
      y,
      radius: 4,
      alpha: strong ? 0.95 : 0.5,
      speed: strong ? 5.5 : 3.2,
      color
    });
  }

  function addSparks(x, y, angle, impact = false) {
    const amount = impact ? 34 : 15;
    for (let index = 0; index < amount; index += 1) {
      const direction = impact
        ? Math.random() * Math.PI * 2
        : angle + (Math.random() - 0.5) * 1.25;
      const speed = (impact ? 1.2 : 1.5) + Math.random() * (impact ? 5.8 : 3.8);
      sparks.push({
        x,
        y,
        vx: Math.cos(direction) * speed,
        vy: Math.sin(direction) * speed,
        life: 1,
        color: palette[index % palette.length],
        size: index % 4 === 0 ? 3 : 2
      });
    }
  }

  function nearestStar() {
    let nearest = null;
    let nearestDistance = Infinity;

    stars.forEach((star) => {
      if (!star.alive) return;
      const distance = Math.hypot(star.x - pointer.x, star.y - pointer.y);
      if (distance < nearestDistance) {
        nearest = star;
        nearestDistance = distance;
      }
    });

    return nearest;
  }

  function shoot() {
    if (!finePointer) return;

    const target = nearestStar();
    if (!target) return;

    const aimX = target.x - pointer.x;
    const aimY = target.y - pointer.y;
    const length = Math.hypot(aimX, aimY) || 1;
    pointer.aimX = aimX / length;
    pointer.aimY = aimY / length;

    shots.push({
      x: pointer.x,
      y: pointer.y,
      target,
      progress: 0
    });
    addPulse(pointer.x, pointer.y, true);
    addSparks(pointer.x, pointer.y, Math.atan2(aimY, aimX));
    window.dispatchEvent(new CustomEvent("pixel-ranger-shoot"));
  }

  function updatePointer(event) {
    pointer.previousX = event.clientX;
    pointer.previousY = event.clientY;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.active = !event.target.closest(".archive__item, .page__inner-wrap, .sidebar, .masthead, .page__footer, .page__related, .pagination");
  }

  function drawPixelStar(star, time) {
    const twinkle = 0.58 + Math.sin(time * 0.002 + star.phase) * 0.34;
    starCtx.globalAlpha = twinkle;
    starCtx.fillStyle = star.color;
    const size = star.size;
    const x = Math.round(star.x);
    const y = Math.round(star.y);
    starCtx.fillRect(x - size, y, size * 2 + 1, 1);
    starCtx.fillRect(x, y - size, 1, size * 2 + 1);
  }

  function destroyStar(star) {
    if (!star.alive) return;
    star.alive = false;
    addPulse(star.x, star.y, true, "255, 117, 216");
    addSparks(star.x, star.y, 0, true);
    updateStarCount();
  }

  function animateStars(time) {
    const delta = Math.min(2, (time - lastTime) / 16.67);
    lastTime = time;
    starCtx.clearRect(0, 0, width, height);

    stars.forEach((star) => {
      if (!star.alive) return;

      star.vx += (star.homeX - star.x) * 0.00045 * delta;
      star.vy += (star.homeY - star.y) * 0.00045 * delta;

      if (pointer.active && !reducedMotion) {
        const dx = pointer.x - star.x;
        const dy = pointer.y - star.y;
        const distance = Math.hypot(dx, dy);
        const radius = 320;

        if (distance > 1 && distance < radius) {
          const force = Math.pow(1 - distance / radius, 2) * 0.046 * delta;
          star.vx += (dx / distance) * force;
          star.vy += (dy / distance) * force;

          if (distance < 145) {
            starCtx.beginPath();
            starCtx.moveTo(star.x, star.y);
            starCtx.lineTo(pointer.x, pointer.y);
            starCtx.strokeStyle = "rgba(85, 244, 255, " + ((1 - distance / 145) * 0.2) + ")";
            starCtx.lineWidth = 1;
            starCtx.stroke();
          }
        }
      }

      star.vx *= 0.965;
      star.vy *= 0.965;
      star.x += star.vx * delta;
      star.y += star.vy * delta;
      drawPixelStar(star, time);
    });

    pulses = pulses.filter((pulse) => {
      pulse.radius += pulse.speed * delta;
      pulse.alpha *= 0.92;
      starCtx.beginPath();
      starCtx.arc(pulse.x, pulse.y, pulse.radius, 0, Math.PI * 2);
      starCtx.strokeStyle = "rgba(" + pulse.color + ", " + pulse.alpha + ")";
      starCtx.lineWidth = pulse.radius < 22 ? 2 : 1;
      starCtx.stroke();
      return pulse.alpha > 0.03;
    });

    shots = shots.filter((shot) => {
      if (!shot.target.alive) return false;

      shot.progress = Math.min(1, shot.progress + 0.075 * delta);
      const eased = 1 - Math.pow(1 - shot.progress, 3);
      const endX = shot.x + (shot.target.x - shot.x) * eased;
      const endY = shot.y + (shot.target.y - shot.y) * eased;
      const trailStart = Math.max(0, eased - 0.18);
      const trailX = shot.x + (shot.target.x - shot.x) * trailStart;
      const trailY = shot.y + (shot.target.y - shot.y) * trailStart;

      starCtx.beginPath();
      starCtx.moveTo(trailX, trailY);
      starCtx.lineTo(endX, endY);
      starCtx.strokeStyle = "rgba(255, 227, 110, " + (1 - shot.progress * 0.35) + ")";
      starCtx.lineWidth = 3;
      starCtx.stroke();
      starCtx.globalAlpha = 1;
      starCtx.fillStyle = "#fff";
      starCtx.fillRect(Math.round(endX) - 2, Math.round(endY) - 2, 5, 5);

      if (shot.progress >= 1) {
        destroyStar(shot.target);
        return false;
      }
      return true;
    });

    sparks = sparks.filter((spark) => {
      spark.x += spark.vx * delta;
      spark.y += spark.vy * delta;
      spark.vx *= 0.95;
      spark.vy *= 0.95;
      spark.life -= 0.035 * delta;
      starCtx.globalAlpha = Math.max(0, spark.life);
      starCtx.fillStyle = spark.color;
      starCtx.fillRect(Math.round(spark.x), Math.round(spark.y), spark.size, spark.size);
      return spark.life > 0;
    });

    starCtx.globalAlpha = 1;
    window.requestAnimationFrame(animateStars);
  }

  function createRanger() {
    if (!finePointer || reducedMotion) return;

    const ranger = document.createElement("canvas");
    ranger.id = "pixel-ranger";
    ranger.width = 96;
    ranger.height = 64;
    ranger.style.width = "48px";
    ranger.style.height = "32px";
    ranger.setAttribute("aria-hidden", "true");
    document.body.append(ranger);
    root.classList.add("pixel-cursor-enabled");

    const ctx = ranger.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.scale(2, 2);
    let rangerX = pointer.x;
    let rangerY = pointer.y;
    let shotUntil = 0;

    const block = (color, x, y, w, h) => {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
    };

    function drawRanger(time) {
      rangerX += (pointer.x - rangerX) * 0.38;
      rangerY += (pointer.y - rangerY) * 0.38;
      ranger.style.transform = "translate3d(" + (rangerX - 35) + "px," + (rangerY - 16) + "px,0)";
      ctx.clearRect(0, 0, 48, 32);

      const bob = Math.sin(time * 0.012) > 0 ? 0 : 1;

      // Red-cap pixel plumber with blue overalls and a tiny sci-fi blaster.
      block("#e53935", 5, 3 + bob, 14, 3);
      block("#e53935", 3, 6 + bob, 20, 3);
      block("#5d3628", 4, 9 + bob, 4, 8);
      block("#ffc49f", 8, 9 + bob, 13, 8);
      block("#1a1113", 16, 10 + bob, 2, 2);
      block("#4b2f25", 14, 14 + bob, 9, 2);
      block("#e53935", 6, 17 + bob, 17, 6);
      block("#1976d2", 9, 20 + bob, 12, 8);
      block("#ffe36e", 10, 21 + bob, 2, 2);
      block("#ffe36e", 17, 21 + bob, 2, 2);
      block("#ffc49f", 21, 18 + bob, 5, 4);
      block("#6d4c41", 6, 27 + bob, 8, 3);
      block("#6d4c41", 17, 27 + bob, 8, 3);

      block("#d8e7ff", 24, 17 + bob, 10, 4);
      block("#55f4ff", 31, 16 + bob, 8, 2);
      block("#ffe36e", 37, 15 + bob, 4, 4);
      block("#657399", 26, 21 + bob, 4, 3);

      ctx.strokeStyle = "rgba(85,244,255,.72)";
      ctx.lineWidth = 1;
      ctx.strokeRect(41, 12, 6, 6);
      block("#55f4ff", 44, 10, 1, 10);
      block("#55f4ff", 39, 15, 10, 1);

      if (time < shotUntil) {
        block("#fff", 39, 14 + bob, 3, 3);
        block("#ffe36e", 42, 12 + bob, 5, 7);
      }

      window.requestAnimationFrame(drawRanger);
    }

    window.addEventListener("pixel-ranger-shoot", () => {
      shotUntil = performance.now() + 140;
    });

    window.requestAnimationFrame(drawRanger);
  }

  window.addEventListener("resize", resize, { passive: true });
  window.addEventListener("pointermove", updatePointer, { passive: true });
  window.addEventListener("pointerdown", shoot, { passive: true });
  window.addEventListener("blur", () => {
    pointer.active = false;
  });

  resize();
  createRanger();
  if (reducedMotion) {
    pointer.active = false;
  }
  window.requestAnimationFrame(animateStars);
})();
