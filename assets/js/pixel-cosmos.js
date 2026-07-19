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
      size: index % 13 === 0 ? 2 : 1,
      phase: Math.random() * Math.PI * 2,
      color: palette[index % palette.length]
    };
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

    const desired = Math.max(55, Math.min(130, Math.round((width * height) / 14500)));
    stars = Array.from({ length: desired }, (_, index) => makeStar(index));
  }

  function addPulse(x, y, strong) {
    pulses.push({ x, y, radius: 4, alpha: strong ? 0.9 : 0.5, speed: strong ? 5.5 : 3.2 });
  }

  function addSparks(x, y, angle) {
    for (let index = 0; index < 22; index += 1) {
      const spread = (Math.random() - 0.5) * 1.4;
      const speed = 1.5 + Math.random() * 4.5;
      sparks.push({
        x,
        y,
        vx: Math.cos(angle + spread) * speed,
        vy: Math.sin(angle + spread) * speed,
        life: 1,
        color: palette[index % palette.length],
        size: index % 4 === 0 ? 3 : 2
      });
    }
  }

  function shoot() {
    if (!finePointer) return;

    let aimX = pointer.aimX;
    let aimY = pointer.aimY;
    const length = Math.hypot(aimX, aimY) || 1;
    aimX /= length;
    aimY /= length;
    pointer.aimX = aimX;
    pointer.aimY = aimY;

    const angle = Math.atan2(aimY, aimX);
    shots.push({
      x: pointer.x,
      y: pointer.y,
      aimX,
      aimY,
      life: 1
    });
    addPulse(pointer.x, pointer.y, true);
    addSparks(pointer.x, pointer.y, angle);
    window.dispatchEvent(new CustomEvent("pixel-ranger-shoot"));
  }

  function updatePointer(event) {
    const dx = event.clientX - pointer.previousX;
    const dy = event.clientY - pointer.previousY;
    if (Math.hypot(dx, dy) > 1.5) {
      pointer.aimX = dx;
      pointer.aimY = dy;
    }
    pointer.previousX = event.clientX;
    pointer.previousY = event.clientY;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.active = true;
  }

  function drawPixelStar(star, time) {
    const twinkle = 0.55 + Math.sin(time * 0.002 + star.phase) * 0.32;
    starCtx.globalAlpha = twinkle;
    starCtx.fillStyle = star.color;
    const size = star.size;
    const x = Math.round(star.x);
    const y = Math.round(star.y);
    starCtx.fillRect(x - size, y, size * 2 + 1, 1);
    starCtx.fillRect(x, y - size, 1, size * 2 + 1);
  }

  function animateStars(time) {
    const delta = Math.min(2, (time - lastTime) / 16.67);
    lastTime = time;
    starCtx.clearRect(0, 0, width, height);

    stars.forEach((star) => {
      star.vx += (star.homeX - star.x) * 0.00045 * delta;
      star.vy += (star.homeY - star.y) * 0.00045 * delta;

      if (pointer.active && !reducedMotion) {
        const dx = pointer.x - star.x;
        const dy = pointer.y - star.y;
        const distance = Math.hypot(dx, dy);
        const radius = 270;

        if (distance > 1 && distance < radius) {
          const force = Math.pow(1 - distance / radius, 2) * 0.042 * delta;
          star.vx += (dx / distance) * force;
          star.vy += (dy / distance) * force;

          if (distance < 125) {
            starCtx.beginPath();
            starCtx.moveTo(star.x, star.y);
            starCtx.lineTo(pointer.x, pointer.y);
            starCtx.strokeStyle = "rgba(85, 244, 255, " + ((1 - distance / 125) * 0.18) + ")";
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
      starCtx.strokeStyle = "rgba(85, 244, 255, " + pulse.alpha + ")";
      starCtx.lineWidth = pulse.radius < 22 ? 2 : 1;
      starCtx.stroke();
      return pulse.alpha > 0.03;
    });

    shots = shots.filter((shot) => {
      const beamLength = 55 + (1 - shot.life) * 110;
      const endX = shot.x + shot.aimX * beamLength;
      const endY = shot.y + shot.aimY * beamLength;
      starCtx.beginPath();
      starCtx.moveTo(shot.x, shot.y);
      starCtx.lineTo(endX, endY);
      starCtx.strokeStyle = "rgba(255, 227, 110, " + shot.life + ")";
      starCtx.lineWidth = 3;
      starCtx.stroke();
      starCtx.fillStyle = "#fff";
      starCtx.globalAlpha = shot.life;
      starCtx.fillRect(Math.round(endX) - 2, Math.round(endY) - 2, 5, 5);
      shot.life -= 0.085 * delta;
      return shot.life > 0;
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
    ranger.width = 132;
    ranger.height = 88;
    ranger.style.width = "66px";
    ranger.style.height = "44px";
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
      rangerX += (pointer.x - rangerX) * 0.34;
      rangerY += (pointer.y - rangerY) * 0.34;
      ranger.style.transform = "translate3d(" + (rangerX - 50) + "px," + (rangerY - 22) + "px,0)";
      ctx.clearRect(0, 0, 66, 44);

      const bob = Math.sin(time * 0.012) > 0 ? 0 : 1;

      // Original pixel ranger: coral helmet, cyan visor, tiny backpack and ray blaster.
      block("#ff75d8", 8, 7 + bob, 17, 4);
      block("#ff75d8", 6, 11 + bob, 22, 5);
      block("#ffd0b8", 10, 16 + bob, 16, 8);
      block("#55f4ff", 16, 16 + bob, 11, 4);
      block("#070914", 20, 17 + bob, 5, 2);
      block("#9a87ff", 8, 24 + bob, 18, 9);
      block("#7dffc5", 11, 26 + bob, 5, 5);
      block("#182143", 4, 23 + bob, 5, 10);
      block("#ffe36e", 6, 25 + bob, 3, 3);
      block("#9a87ff", 10, 33 + bob, 6, 5);
      block("#9a87ff", 20, 33 + bob, 6, 5);
      block("#55f4ff", 8, 38 + bob, 9, 3);
      block("#55f4ff", 20, 38 + bob, 9, 3);

      // Ray blaster and crosshair.
      block("#c9d3ee", 26, 24 + bob, 14, 5);
      block("#55f4ff", 35, 22 + bob, 12, 3);
      block("#ffe36e", 45, 21 + bob, 5, 5);
      ctx.strokeStyle = "rgba(85,244,255,.8)";
      ctx.lineWidth = 1;
      ctx.strokeRect(51, 18, 9, 9);
      block("#55f4ff", 55, 16, 1, 13);
      block("#55f4ff", 49, 22, 13, 1);

      if (time < shotUntil) {
        block("#fff", 50, 20 + bob, 5, 5);
        block("#ffe36e", 55, 18 + bob, 7, 9);
        block("#ff75d8", 62, 20 + bob, 4, 5);
      }

      window.requestAnimationFrame(drawRanger);
    }

    window.addEventListener("pixel-ranger-shoot", () => {
      shotUntil = performance.now() + 130;
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
