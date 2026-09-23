import { Application, Container, Graphics, Ticker } from 'pixi.js';

// Все настраиваемые числа игры. Углы — в градусах, скорости — в единицах/сек.
const CONFIG = {
  scene: {
    width: 800,
    height: 600,
    background: 0x0a0a12,
  },
  core: {
    radius: 30,
    color: 0x00e5ff,
  },
  shield: {
    radius: 90,
    thickness: 10,
    arcLength: 70, // градусы
    speed: 180, // градусы/сек
    color: 0xff2d95,
  },
  projectile: {
    radius: 8,
    color: 0xffffff,
    speed: 200, // px/сек
    spawnInterval: 1.2, // сек
    spawnMargin: 20, // px за пределами экрана
  },
};

const DEG = Math.PI / 180;
const CX = CONFIG.scene.width / 2;
const CY = CONFIG.scene.height / 2;
// Радиус окружности, гарантированно лежащей за краями экрана.
const SPAWN_DISTANCE = Math.hypot(CX, CY) + CONFIG.projectile.radius + CONFIG.projectile.spawnMargin;

interface Projectile {
  gfx: Graphics;
  x: number; // относительно центра
  y: number;
  vx: number;
  vy: number;
}

/** Приводит угол к диапазону [-PI, PI]. */
function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

async function main(): Promise<void> {
  const app = new Application();
  await app.init({
    width: CONFIG.scene.width,
    height: CONFIG.scene.height,
    background: CONFIG.scene.background,
    antialias: true,
  });
  document.body.appendChild(app.canvas);

  // Всё игровое поле — с началом координат в центре экрана.
  const world = new Container();
  world.position.set(CX, CY);
  app.stage.addChild(world);

  const core = new Graphics().circle(0, 0, CONFIG.core.radius).fill(CONFIG.core.color);
  world.addChild(core);

  // Дуга нарисована симметрично относительно угла 0; вращаем через rotation.
  const halfArc = (CONFIG.shield.arcLength * DEG) / 2;
  const shield = new Graphics()
    .moveTo(Math.cos(-halfArc) * CONFIG.shield.radius, Math.sin(-halfArc) * CONFIG.shield.radius)
    .arc(0, 0, CONFIG.shield.radius, -halfArc, halfArc)
    .stroke({ width: CONFIG.shield.thickness, color: CONFIG.shield.color, cap: 'butt' });
  world.addChild(shield);

  const projectileLayer = new Container();
  world.addChild(projectileLayer);

  let projectiles: Projectile[] = [];
  let shieldAngle = 0; // радианы
  let direction = 1; // 1 — по часовой, -1 — против
  let spawnTimer = 0;

  function reset(): void {
    for (const p of projectiles) p.gfx.destroy();
    projectiles = [];
    shieldAngle = 0;
    direction = 1;
    spawnTimer = 0;
  }

  function spawnProjectile(): void {
    const angle = Math.random() * Math.PI * 2;
    const x = Math.cos(angle) * SPAWN_DISTANCE;
    const y = Math.sin(angle) * SPAWN_DISTANCE;
    const gfx = new Graphics()
      .circle(0, 0, CONFIG.projectile.radius)
      .fill(CONFIG.projectile.color);
    gfx.position.set(x, y);
    projectileLayer.addChild(gfx);
    projectiles.push({
      gfx,
      x,
      y,
      vx: -Math.cos(angle) * CONFIG.projectile.speed,
      vy: -Math.sin(angle) * CONFIG.projectile.speed,
    });
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

  function toggleDirection(): void {
    direction = -direction;
  }

  app.canvas.addEventListener('pointerdown', toggleDirection);
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    e.preventDefault();
    if (!e.repeat) toggleDirection();
  });

  app.ticker.add((ticker: Ticker) => {
    const dt = ticker.deltaMS / 1000;

    shieldAngle = wrapAngle(shieldAngle + direction * CONFIG.shield.speed * DEG * dt);
    shield.rotation = shieldAngle;

    spawnTimer += dt;
    while (spawnTimer >= CONFIG.projectile.spawnInterval) {
      spawnTimer -= CONFIG.projectile.spawnInterval;
      spawnProjectile();
    }

    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.gfx.position.set(p.x, p.y);

      if (hitsShield(p)) {
        p.gfx.destroy();
        projectiles.splice(i, 1);
        continue;
      }
      if (hitsCore(p)) {
        console.log('GAME OVER');
        reset();
        return;
      }
    }
  });
}

main();
