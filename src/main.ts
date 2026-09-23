import { Application, Container, Graphics, Ticker } from 'pixi.js';

// Все настраиваемые числа игры. Углы — в градусах, скорости — в единицах/сек, время — в секундах.
// Размеры и скорости в px заданы для S = 1 (меньшая сторона экрана 600 px)
// и умножаются на S = min(innerWidth, innerHeight) / 600.
const CONFIG = {
  scene: {
    background: 0x0a0a12,
    baseSize: 600, // меньшая сторона экрана, при которой S = 1
  },
  core: {
    radius: 42,
    color: 0x00e5ff,
  },
  shield: {
    radius: 150,
    thickness: 18,
    arcLength: 70, // градусы
    speed: 180, // градусы/сек
    color: 0xff2d95,
  },
  projectile: {
    radius: 14,
    color: 0xffffff,
    speed: 200, // px/сек
    spawnInterval: 0.75, // сек
    maxActive: 4, // максимум снарядов в воздухе одновременно
    spawnMargin: 50, // px экрана за половиной диагонали
  },
  // Визуальный и тактильный фидбек. На механику не влияет.
  JUICE: {
    deflect: {
      flashStartRadius: 8,
      flashEndRadius: 30,
      flashDuration: 0.15,
      shardCount: 6,
      shardRadius: 3,
      shardSpeedMin: 150,
      shardSpeedMax: 250,
      shardLife: 0.4,
      shardSpread: 180, // градусы, веер вокруг внешней нормали
      shakeAmplitude: 4,
      shakeDuration: 0.08,
      shieldGlowDuration: 0.1,
      shieldGlowAlpha: 0.8, // сила белой подсветки щита
    },
    direction: {
      trailCopies: 5,
      trailDelay: 0.025, // сек между копиями
      trailDuration: 0.2, // сколько живёт след после смены направления
      trailAlphaStart: 0.4, // прозрачность ближайшей копии, дальняя → 0
      easeDuration: 0.06, // разгон вращения (ease-out)
    },
    gameOver: {
      hitStop: 0.12,
      shakeAmplitude: 12,
      shakeDuration: 0.3,
      particleCount: 20,
      particleRadius: 4,
      particleSpeedMin: 100,
      particleSpeedMax: 320,
      particleLife: 0.7,
      screenFlashDuration: 0.05,
    },
    coreBreath: {
      amplitude: 2, // px
      period: 2, // сек
    },
    projectileTrail: {
      duration: 0.12, // длина следа во времени
      alpha: 0.35, // прозрачность самой свежей точки следа
    },
    // Vibration API (Android). iOS Safari его не поддерживает.
    haptics: {
      deflect: 15, // мс
      direction: 8,
      gameOver: [40, 30, 80],
    },
  },
};

const DEG = Math.PI / 180;

interface TrailPoint {
  x: number;
  y: number;
  t: number;
}

interface Projectile {
  gfx: Graphics;
  trail: Graphics;
  history: TrailPoint[];
  x: number; // относительно центра
  y: number;
  vx: number;
  vy: number;
}

interface Particle {
  gfx: Graphics;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
}

interface Flash {
  gfx: Graphics;
  t: number;
}

/** Приводит угол к диапазону [-PI, PI]. */
function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function vibrate(pattern: number | number[]): void {
  if (typeof navigator.vibrate === 'function') navigator.vibrate(pattern);
}

async function main(): Promise<void> {
  const J = CONFIG.JUICE;
  const app = new Application();
  // resolution = devicePixelRatio: буфер canvas = innerWidth * dpr, отрисовка масштабируется на dpr.
  // Размер canvas на странице задаёт CSS (100vw x 100vh).
  await app.init({
    width: window.innerWidth,
    height: window.innerHeight,
    resolution: window.devicePixelRatio || 1,
    background: CONFIG.scene.background,
    antialias: true,
  });
  document.body.appendChild(app.canvas);

  // Всё игровое поле — с началом координат в центре экрана, в единицах CONFIG (S = 1).
  // Масштаб контейнера = S, поэтому все размеры и скорости из CONFIG умножаются на S.
  // Тряска сдвигает этот контейнер.
  const world = new Container();
  app.stage.addChild(world);
  let centerX = 0;
  let centerY = 0;
  let spawnDistance = 0; // в единицах CONFIG

  const core = new Graphics().circle(0, 0, CONFIG.core.radius).fill(CONFIG.core.color);
  world.addChild(core);

  // Дуга нарисована симметрично относительно угла 0; вращаем через rotation.
  const halfArc = (CONFIG.shield.arcLength * DEG) / 2;
  function makeArc(color: number): Graphics {
    return new Graphics()
      .moveTo(Math.cos(-halfArc) * CONFIG.shield.radius, Math.sin(-halfArc) * CONFIG.shield.radius)
      .arc(0, 0, CONFIG.shield.radius, -halfArc, halfArc)
      .stroke({ width: CONFIG.shield.thickness, color, cap: 'butt' });
  }

  // Копии дуги для следа при смене направления (под щитом).
  const shieldGhosts: Graphics[] = [];
  for (let i = 0; i < J.direction.trailCopies; i++) {
    const ghost = makeArc(CONFIG.shield.color);
    ghost.visible = false;
    world.addChild(ghost);
    shieldGhosts.push(ghost);
  }

  // Щит и его белая подсветка вращаются вместе.
  const shield = new Container();
  const shieldGlow = makeArc(0xffffff);
  shieldGlow.alpha = 0;
  shield.addChild(makeArc(CONFIG.shield.color), shieldGlow);
  world.addChild(shield);

  const projectileLayer = new Container();
  const effectsLayer = new Container();
  world.addChild(projectileLayer, effectsLayer);

  // Вспышка всего экрана — вне world, чтобы тряска её не сдвигала.
  const screenFlash = new Graphics();
  screenFlash.alpha = 0;
  app.stage.addChild(screenFlash);

  function layout(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    app.renderer.resize(w, h, window.devicePixelRatio || 1);
    const S = Math.min(w, h) / CONFIG.scene.baseSize;
    centerX = w / 2;
    centerY = h / 2;
    world.scale.set(S);
    world.position.set(centerX, centerY);
    // Окружность спавна в px экрана переводим в единицы CONFIG.
    spawnDistance = (Math.hypot(w, h) / 2 + CONFIG.projectile.spawnMargin) / S;
    screenFlash.clear().rect(0, 0, w, h).fill(0xffffff);
  }
  layout();
  window.addEventListener('resize', layout);
  window.addEventListener('orientationchange', layout);

  // --- Игровое состояние ---
  let projectiles: Projectile[] = [];
  let shieldAngle = 0; // радианы
  let direction = 1; // 1 — по часовой, -1 — против
  let spawnTimer = 0;

  // --- Состояние эффектов ---
  const fullSpeed = CONFIG.shield.speed * DEG;
  let angularVel = fullSpeed; // текущая скорость щита, рад/сек
  let easeFrom = fullSpeed;
  let easeTime = J.direction.easeDuration; // >= easeDuration — разгон завершён
  let gameTime = 0; // игровое время (стоит во время hit-stop)
  let realTime = 0;
  const angleHistory: { t: number; angle: number }[] = [];
  let ghostTimer = 0;
  let shieldGlowTimer = 0;
  let shakeTimer = 0;
  let shakeDuration = 0;
  let shakeAmplitude = 0;
  let hitStopTimer = 0;
  let pendingReset = false;
  let screenFlashTimer = 0;
  const particles: Particle[] = [];
  const flashes: Flash[] = [];

  function reset(): void {
    for (const p of projectiles) {
      p.gfx.destroy();
      p.trail.destroy();
    }
    projectiles = [];
    shieldAngle = 0;
    direction = 1;
    spawnTimer = 0;
    angularVel = fullSpeed;
    easeTime = J.direction.easeDuration;
    angleHistory.length = 0;
    ghostTimer = 0;
    core.visible = true;
  }

  function spawnProjectile(): void {
    const angle = Math.random() * Math.PI * 2;
    const x = Math.cos(angle) * spawnDistance;
    const y = Math.sin(angle) * spawnDistance;
    const trail = new Graphics();
    const gfx = new Graphics()
      .circle(0, 0, CONFIG.projectile.radius)
      .fill(CONFIG.projectile.color);
    gfx.position.set(x, y);
    projectileLayer.addChild(trail, gfx);
    projectiles.push({
      gfx,
      trail,
      history: [],
      x,
      y,
      vx: -Math.cos(angle) * CONFIG.projectile.speed,
      vy: -Math.sin(angle) * CONFIG.projectile.speed,
    });
  }

  function removeProjectile(i: number): void {
    const p = projectiles[i];
    p.gfx.destroy();
    p.trail.destroy();
    projectiles.splice(i, 1);
  }

  /** Касается ли снаряд дуги щита (кольцевой сектор, расширенный на радиус снаряда). */
  function hitsShield(p: Projectile): boolean {
    const r = CONFIG.projectile.radius;
    const dist = Math.hypot(p.x, p.y);
    const half = CONFIG.shield.thickness / 2;
    if (dist < CONFIG.shield.radius - half - r || dist > CONFIG.shield.radius + half + r) {
      return false;
    }
    // Угловой запас, чтобы учитывать размер снаряда у краёв дуги.
    const pad = Math.asin(Math.min(1, r / dist));
    const diff = wrapAngle(Math.atan2(p.y, p.x) - shieldAngle);
    return Math.abs(diff) <= halfArc + pad;
  }

  function hitsCore(p: Projectile): boolean {
    return Math.hypot(p.x, p.y) <= CONFIG.core.radius + CONFIG.projectile.radius;
  }

  // --- Эффекты ---

  function shake(amplitude: number, duration: number): void {
    // Более сильная тряска не перебивается более слабой.
    if (shakeTimer > 0 && shakeAmplitude * (shakeTimer / shakeDuration) > amplitude) return;
    shakeAmplitude = amplitude;
    shakeDuration = duration;
    shakeTimer = duration;
  }

  function spawnParticle(
    x: number, y: number, angle: number, speed: number,
    radius: number, color: number, life: number,
  ): void {
    const gfx = new Graphics().circle(0, 0, radius).fill(color);
    gfx.position.set(x, y);
    effectsLayer.addChild(gfx);
    particles.push({ gfx, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life, maxLife: life });
  }

  function onDeflect(p: Projectile): void {
    const D = J.deflect;
    // Точка контакта — на внешней кромке щита по направлению на снаряд.
    const normal = Math.atan2(p.y, p.x);
    const contactR = CONFIG.shield.radius + CONFIG.shield.thickness / 2;
    const cx = Math.cos(normal) * contactR;
    const cy = Math.sin(normal) * contactR;

    const flash = new Graphics().circle(0, 0, 1).fill(0xffffff);
    flash.position.set(cx, cy);
    flash.scale.set(D.flashStartRadius);
    effectsLayer.addChild(flash);
    flashes.push({ gfx: flash, t: 0 });

    const spread = D.shardSpread * DEG;
    for (let i = 0; i < D.shardCount; i++) {
      const a = normal + rand(-spread / 2, spread / 2);
      spawnParticle(cx, cy, a, rand(D.shardSpeedMin, D.shardSpeedMax),
        D.shardRadius, CONFIG.projectile.color, D.shardLife);
    }

    shake(D.shakeAmplitude, D.shakeDuration);
    shieldGlowTimer = D.shieldGlowDuration;
    vibrate(J.haptics.deflect);
  }

  function onGameOver(): void {
    const G = J.gameOver;
    console.log('GAME OVER');
    for (let i = 0; i < G.particleCount; i++) {
      const a = (i / G.particleCount) * Math.PI * 2 + rand(-0.15, 0.15);
      const r = rand(0, CONFIG.core.radius * 0.6);
      spawnParticle(Math.cos(a) * r, Math.sin(a) * r, a,
        rand(G.particleSpeedMin, G.particleSpeedMax),
        G.particleRadius, CONFIG.core.color, G.particleLife);
    }
    core.visible = false;
    hitStopTimer = G.hitStop;
    pendingReset = true;
    shake(G.shakeAmplitude, G.shakeDuration);
    screenFlashTimer = G.screenFlashDuration;
    vibrate(J.haptics.gameOver);
  }

  function toggleDirection(): void {
    if (pendingReset) return;
    direction = -direction;
    easeFrom = angularVel;
    easeTime = 0;
    ghostTimer = J.direction.trailDuration;
    vibrate(J.haptics.direction);
  }

  /** Угол щита в прошлом (ближайший сохранённый кадр). */
  function angleAt(t: number): number {
    for (let i = angleHistory.length - 1; i >= 0; i--) {
      if (angleHistory[i].t <= t) return angleHistory[i].angle;
    }
    return angleHistory.length ? angleHistory[0].angle : shieldAngle;
  }

  app.canvas.addEventListener('pointerdown', toggleDirection);
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    e.preventDefault();
    if (!e.repeat) toggleDirection();
  });

  // --- Обновление ---

  function updateGame(dt: number): void {
    gameTime += dt;

    // Плавный разгон к целевой скорости после смены направления.
    const target = direction * fullSpeed;
    if (easeTime < J.direction.easeDuration) {
      easeTime = Math.min(J.direction.easeDuration, easeTime + dt);
      angularVel = easeFrom + (target - easeFrom) * easeOutCubic(easeTime / J.direction.easeDuration);
    } else {
      angularVel = target;
    }
    shieldAngle = wrapAngle(shieldAngle + angularVel * dt);
    shield.rotation = shieldAngle;

    const historyWindow = J.direction.trailCopies * J.direction.trailDelay + 0.1;
    angleHistory.push({ t: gameTime, angle: shieldAngle });
    while (angleHistory.length && angleHistory[0].t < gameTime - historyWindow) angleHistory.shift();

    spawnTimer += dt;
    while (spawnTimer >= CONFIG.projectile.spawnInterval) {
      if (projectiles.length >= CONFIG.projectile.maxActive) {
        // Лимит достигнут — следующий снаряд появится, как только освободится место.
        spawnTimer = CONFIG.projectile.spawnInterval;
        break;
      }
      spawnTimer -= CONFIG.projectile.spawnInterval;
      spawnProjectile();
    }

    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.gfx.position.set(p.x, p.y);
      p.history.push({ x: p.x, y: p.y, t: gameTime });

      if (hitsShield(p)) {
        onDeflect(p);
        removeProjectile(i);
        continue;
      }
      if (hitsCore(p)) {
        onGameOver();
        return;
      }
    }
  }

  function updateParticles(dt: number): void {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        p.gfx.destroy();
        particles.splice(i, 1);
        continue;
      }
      p.gfx.x += p.vx * dt;
      p.gfx.y += p.vy * dt;
      p.gfx.alpha = p.life / p.maxLife;
    }

    const D = J.deflect;
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i];
      f.t += dt;
      const k = f.t / D.flashDuration;
      if (k >= 1) {
        f.gfx.destroy();
        flashes.splice(i, 1);
        continue;
      }
      f.gfx.scale.set(D.flashStartRadius + (D.flashEndRadius - D.flashStartRadius) * easeOutCubic(k));
      f.gfx.alpha = 1 - k;
    }
  }

  function renderVisuals(dt: number): void {
    // Дыхание ядра — только визуально, коллизия по CONFIG.core.radius.
    const B = J.coreBreath;
    const r = CONFIG.core.radius + B.amplitude * Math.sin((realTime / B.period) * Math.PI * 2);
    core.scale.set(r / CONFIG.core.radius);

    // Подсветка щита.
    shieldGlowTimer = Math.max(0, shieldGlowTimer - dt);
    shieldGlow.alpha = J.deflect.shieldGlowAlpha * (shieldGlowTimer / J.deflect.shieldGlowDuration);

    // След щита после смены направления.
    const T = J.direction;
    ghostTimer = Math.max(0, ghostTimer - dt);
    const fade = ghostTimer / T.trailDuration;
    for (let i = 0; i < shieldGhosts.length; i++) {
      const g = shieldGhosts[i];
      g.visible = fade > 0;
      if (!g.visible) continue;
      g.rotation = angleAt(gameTime - (i + 1) * T.trailDelay);
      g.alpha = T.trailAlphaStart * (1 - i / shieldGhosts.length) * fade;
    }

    // След снарядов.
    const PT = J.projectileTrail;
    for (const p of projectiles) {
      while (p.history.length && p.history[0].t < gameTime - PT.duration) p.history.shift();
      p.trail.clear();
      for (const h of p.history) {
        const k = 1 - (gameTime - h.t) / PT.duration; // 1 — свежая точка, 0 — старая
        p.trail
          .circle(h.x, h.y, CONFIG.projectile.radius * k)
          .fill({ color: CONFIG.projectile.color, alpha: PT.alpha * k });
      }
    }

    // Тряска экрана с затуханием.
    shakeTimer = Math.max(0, shakeTimer - dt);
    const amp = shakeTimer > 0 ? shakeAmplitude * (shakeTimer / shakeDuration) : 0;
    world.position.set(centerX + rand(-amp, amp), centerY + rand(-amp, amp));

    // Вспышка экрана.
    screenFlashTimer = Math.max(0, screenFlashTimer - dt);
    screenFlash.alpha = screenFlashTimer / J.gameOver.screenFlashDuration;
  }

  app.ticker.add((ticker: Ticker) => {
    const dt = ticker.deltaMS / 1000;
    realTime += dt;

    if (hitStopTimer > 0) {
      // Hit-stop: игра и частицы заморожены, тряска и вспышка идут.
      hitStopTimer -= dt;
      if (hitStopTimer <= 0 && pendingReset) {
        pendingReset = false;
        reset();
      }
    } else {
      updateGame(dt);
      updateParticles(dt);
    }

    renderVisuals(dt);
  });
}

main();
