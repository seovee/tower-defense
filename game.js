// ============================================================
// Tower Defense - Hyper-casual Browser Game
// ============================================================

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// ---- Responsive sizing ----
const COLS = 20;
const ROWS = 14;
const UI_ROWS = 3;
const TOTAL_ROWS = ROWS + UI_ROWS;

let TILE, W, H;
let isMobile = false;

const MIN_TILE = 36;
const MAX_TILE = 56;

function resize() {
    // 사용 가능한 화면 크기 계산 (여백 제외)
    const availW = window.innerWidth - 16;
    const availH = window.innerHeight - 60;

    // 내부 해상도용 TILE 계산 (MIN_TILE ~ MAX_TILE 범위)
    TILE = Math.floor(Math.min(availW / COLS, availH / TOTAL_ROWS));
    TILE = Math.max(MIN_TILE, Math.min(MAX_TILE, TILE));

    W = COLS * TILE;
    H = TOTAL_ROWS * TILE;

    // 내부 그리기 해상도 설정 (종이 크기)
    canvas.width = W;
    canvas.height = H;

    // CSS 표시 크기 설정 (액자 크기) - 화면보다 크면 축소
    const cssScale = Math.min(availW / W, availH / H, 1.0);
    const cssW = Math.floor(W * cssScale);
    const cssH = Math.floor(H * cssScale);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';

    // 모바일 판별 (터치 지원 + 좁은 화면)
    isMobile = ('ontouchstart' in window) && (window.innerWidth <= 768 || window.innerHeight <= 500);

    // Recalculate tower positions based on new TILE
    try {
        for (const t of towers) {
            t.x = t.col * TILE + TILE / 2;
            t.y = t.row * TILE + TILE / 2;
        }
    } catch(e) {}
}
resize();
window.addEventListener('resize', () => { resize(); });

// ---- Game State ----
let gold = 150;
let lives = 20;
let wave = 0;
let score = 0;
let gameOver = false;
let waveActive = false;
let waveTimer = 0;
let enemySpawnQueue = [];
let spawnTimer = 0;
let selectedTower = 0; // index into TOWER_TYPES
let hoveredTile = null;
let showUpgradeFor = null;
let showUpgradeTimer = 0;
let particles = [];
let floatingTexts = [];
let enemies = [];
let towers = [];
let projectiles = [];
let waveCountdown = 0;
let betweenWaves = true;
let autoStartTimer = 0;
let gameSpeed = 1; // 1x, 2x, 3x
const SPEED_OPTIONS = [1, 2, 3];
let bossWarningTimer = 0; // 보스 웨이브 경고 연출
let bossWave = false;

// ---- v2.0 New State ----
let screenShakeIntensity = 0;
let screenShakeTimer = 0;
let shockwaves = [];
let groundMarks = [];
let ambientParticles = [];
let grassBlades = [];
let pathDetails = [];
let prevGold = 150;
let prevLives = 20;
let goldFlashTimer = 0;
let livesFlashTimer = 0;
let waveTransitionTimer = 0;
let waveTransitionNum = 0;
let gameOverTimer = 0;
let mousePos = { x: -1, y: -1 };
let soundMuted = false;

// ---- SoundManager (Web Audio API — Procedural 8-bit Sound) ----
class SoundManager {
    constructor() {
        this.ctx = null;
        this.enabled = true;
        this.masterGain = null;
        this.lastPlayed = {};
        this.cooldown = 0.05;
    }
    init() {
        if (this.ctx) return;
        try {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            this.masterGain = this.ctx.createGain();
            this.masterGain.gain.value = 0.3;
            this.masterGain.connect(this.ctx.destination);
        } catch (e) { this.enabled = false; }
    }
    canPlay(name) {
        if (!this.enabled || !this.ctx || soundMuted) return false;
        const now = this.ctx.currentTime;
        if (this.lastPlayed[name] && now - this.lastPlayed[name] < this.cooldown) return false;
        this.lastPlayed[name] = now;
        return true;
    }
    osc(type, freq, dur, vol) {
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.type = type;
        o.frequency.value = freq;
        g.gain.value = vol || 0.3;
        o.connect(g);
        g.connect(this.masterGain);
        const t = this.ctx.currentTime;
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        o.start(t);
        o.stop(t + dur + 0.01);
        return { o, g, t };
    }
    noise(dur, vol) {
        const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * dur, this.ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        const g = this.ctx.createGain();
        g.gain.value = vol || 0.15;
        src.connect(g);
        g.connect(this.masterGain);
        const t = this.ctx.currentTime;
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        src.start(t);
        return { src, g, t };
    }
    arrowFire() {
        if (!this.canPlay('arrow')) return;
        const { o, g, t } = this.osc('square', 880, 0.08, 0.12);
        o.frequency.exponentialRampToValueAtTime(440, t + 0.08);
    }
    cannonFire() {
        if (!this.canPlay('cannon')) return;
        const { o, g, t } = this.osc('sine', 150, 0.2, 0.25);
        o.frequency.exponentialRampToValueAtTime(40, t + 0.2);
        this.noise(0.15, 0.12);
    }
    iceFire() {
        if (!this.canPlay('ice')) return;
        this.osc('sine', 1200, 0.12, 0.08);
        this.osc('sine', 1500, 0.12, 0.08);
    }
    lightningFire() {
        if (!this.canPlay('lightning')) return;
        this.noise(0.1, 0.1);
        const { o, g, t } = this.osc('sawtooth', 600, 0.1, 0.1);
        o.frequency.exponentialRampToValueAtTime(100, t + 0.1);
    }
    poisonFire() {
        if (!this.canPlay('poison')) return;
        const { o, g, t } = this.osc('sine', 200, 0.15, 0.1);
        o.frequency.setValueAtTime(200, t);
        o.frequency.linearRampToValueAtTime(300, t + 0.04);
        o.frequency.linearRampToValueAtTime(150, t + 0.08);
        o.frequency.linearRampToValueAtTime(250, t + 0.12);
    }
    enemyDeath() {
        if (!this.canPlay('edeath')) return;
        this.noise(0.12, 0.08);
        const { o, g, t } = this.osc('sine', 400, 0.15, 0.1);
        o.frequency.exponentialRampToValueAtTime(100, t + 0.15);
    }
    bossDeath() {
        if (!this.canPlay('bdeath')) return;
        this.noise(0.4, 0.15);
        this.noise(0.5, 0.1);
        const { o: o1 } = this.osc('sine', 200, 0.5, 0.15);
        o1.frequency.exponentialRampToValueAtTime(30, this.ctx.currentTime + 0.5);
        const { o: o2 } = this.osc('sine', 400, 0.3, 0.1);
        o2.frequency.exponentialRampToValueAtTime(60, this.ctx.currentTime + 0.3);
    }
    waveStart() {
        if (!this.canPlay('wstart')) return;
        const t = this.ctx.currentTime;
        [523.25, 659.25, 783.99].forEach((f, i) => {
            const o = this.ctx.createOscillator();
            const g = this.ctx.createGain();
            o.type = 'square';
            o.frequency.value = f;
            g.gain.value = 0.08;
            o.connect(g); g.connect(this.masterGain);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.08 * (i + 1) + 0.08);
            o.start(t + 0.08 * i);
            o.stop(t + 0.08 * (i + 1) + 0.09);
        });
    }
    bossWarning() {
        if (!this.canPlay('bwarn')) return;
        const { o, g, t } = this.osc('sawtooth', 55, 0.6, 0.2);
        this.osc('sine', 40, 0.6, 0.15);
    }
    towerPlace() {
        if (!this.canPlay('tplace')) return;
        this.osc('triangle', 200, 0.1, 0.12);
        this.osc('sine', 100, 0.1, 0.08);
    }
    towerUpgrade() {
        if (!this.canPlay('tupgrade')) return;
        const t = this.ctx.currentTime;
        [600, 800, 1000, 1300].forEach((f, i) => {
            const o = this.ctx.createOscillator();
            const g = this.ctx.createGain();
            o.type = 'sine';
            o.frequency.value = f;
            g.gain.value = 0.1;
            o.connect(g); g.connect(this.masterGain);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.06 * (i + 1) + 0.06);
            o.start(t + 0.06 * i);
            o.stop(t + 0.06 * (i + 1) + 0.07);
        });
    }
    towerSell() {
        if (!this.canPlay('tsell')) return;
        const t = this.ctx.currentTime;
        [1046.5, 1318.5].forEach((f, i) => {
            const o = this.ctx.createOscillator();
            const g = this.ctx.createGain();
            o.type = 'square';
            o.frequency.value = f;
            g.gain.value = 0.08;
            o.connect(g); g.connect(this.masterGain);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.06 * (i + 1) + 0.05);
            o.start(t + 0.05 * i);
            o.stop(t + 0.06 * (i + 1) + 0.06);
        });
    }
    lifeLost() {
        if (!this.canPlay('llost')) return;
        const { o, g, t } = this.osc('sawtooth', 440, 0.2, 0.15);
        o.frequency.exponentialRampToValueAtTime(220, t + 0.2);
    }
    gameOverSound() {
        if (!this.canPlay('gover')) return;
        const t = this.ctx.currentTime;
        [523.25, 392, 261.6, 130.8].forEach((f, i) => {
            const o = this.ctx.createOscillator();
            const g = this.ctx.createGain();
            o.type = 'square';
            o.frequency.value = f;
            g.gain.value = 0.12;
            o.connect(g); g.connect(this.masterGain);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.2 * (i + 1) + 0.15);
            o.start(t + 0.2 * i);
            o.stop(t + 0.2 * (i + 1) + 0.16);
        });
    }
    uiClick() {
        if (!this.canPlay('uiclick')) return;
        this.osc('sine', 800, 0.03, 0.06);
    }
}
const soundManager = new SoundManager();

// ---- Path Definition (snaking path) ----
// Grid: 0 = grass, 1 = path, 2 = entry, 3 = exit
const grid = [];
for (let r = 0; r < ROWS; r++) {
    grid[r] = [];
    for (let c = 0; c < COLS; c++) {
        grid[r][c] = 0;
    }
}

// Define a snaking path via waypoints (col, row)
const waypoints = [
    { x: -1, y: 2 },
    { x: 4, y: 2 },
    { x: 4, y: 5 },
    { x: 10, y: 5 },
    { x: 10, y: 2 },
    { x: 16, y: 2 },
    { x: 16, y: 7 },
    { x: 6, y: 7 },
    { x: 6, y: 10 },
    { x: 14, y: 10 },
    { x: 14, y: 12 },
    { x: 20, y: 12 },
];

// Carve path on grid
function carvePath() {
    for (let i = 0; i < waypoints.length - 1; i++) {
        const a = waypoints[i];
        const b = waypoints[i + 1];
        if (a.y === b.y) {
            const minC = Math.max(0, Math.min(a.x, b.x));
            const maxC = Math.min(COLS - 1, Math.max(a.x, b.x));
            for (let c = minC; c <= maxC; c++) grid[a.y][c] = 1;
        } else {
            const minR = Math.min(a.y, b.y);
            const maxR = Math.max(a.y, b.y);
            const col = Math.min(COLS - 1, Math.max(0, a.x));
            for (let r = minR; r <= maxR; r++) grid[r][col] = 1;
        }
    }
    // Mark entry/exit
    if (waypoints[0].y >= 0 && waypoints[0].y < ROWS) {
        const ec = Math.max(0, waypoints[0].x);
        grid[waypoints[0].y][ec] = 2;
    }
}
carvePath();

// Build pixel-level path for enemies to follow
function buildPathPixels() {
    const path = [];
    for (let i = 0; i < waypoints.length; i++) {
        path.push({
            x: waypoints[i].x * TILE + TILE / 2,
            y: waypoints[i].y * TILE + TILE / 2
        });
    }
    return path;
}
let enemyPath = buildPathPixels();

// ---- Ambient Generation ----
function generateGrassBlades() {
    grassBlades = [];
    const count = isMobile ? 1 : 3;
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            if (grid[r][c] !== 0) continue;
            for (let i = 0; i < count; i++) {
                grassBlades.push({
                    x: c * TILE + Math.random() * TILE,
                    y: r * TILE + Math.random() * TILE,
                    h: 4 + Math.random() * 6,
                    phase: Math.random() * Math.PI * 2,
                    color: `rgb(${50 + Math.floor(Math.random() * 30)},${100 + Math.floor(Math.random() * 40)},${40 + Math.floor(Math.random() * 20)})`,
                });
            }
        }
    }
}

function generatePathDetails() {
    pathDetails = [];
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            if (grid[r][c] !== 1 && grid[r][c] !== 2) continue;
            const n = 3 + Math.floor(Math.random() * 3);
            for (let i = 0; i < n; i++) {
                const type = Math.random() < 0.7 ? 'pebble' : 'crack';
                pathDetails.push({
                    x: c * TILE + 4 + Math.random() * (TILE - 8),
                    y: r * TILE + 4 + Math.random() * (TILE - 8),
                    size: 1 + Math.random() * 2.5,
                    type: type,
                    color: type === 'pebble'
                        ? `rgba(${130 + Math.floor(Math.random() * 30)},${110 + Math.floor(Math.random() * 20)},${70 + Math.floor(Math.random() * 20)},0.4)`
                        : `rgba(100,80,50,${0.15 + Math.random() * 0.15})`,
                    angle: Math.random() * Math.PI,
                });
            }
        }
    }
}

function updateAmbientParticles(dt) {
    // Spawn
    if (ambientParticles.length < 30 && Math.random() < 0.3) {
        const isFirefly = Math.random() < 0.3;
        // Random grass tile
        let rx, ry, attempts = 0;
        do {
            rx = Math.floor(Math.random() * COLS);
            ry = Math.floor(Math.random() * ROWS);
            attempts++;
        } while (grid[ry][rx] !== 0 && attempts < 20);
        if (grid[ry][rx] === 0) {
            ambientParticles.push({
                x: rx * TILE + Math.random() * TILE,
                y: ry * TILE + Math.random() * TILE,
                vx: (Math.random() - 0.5) * 0.3,
                vy: (Math.random() - 0.5) * 0.3 - (isFirefly ? 0.2 : 0),
                life: 2 + Math.random() * 3,
                maxLife: 5,
                size: isFirefly ? 2 : 1,
                isFirefly: isFirefly,
                phase: Math.random() * Math.PI * 2,
            });
        }
    }
    // Update
    for (const p of ambientParticles) {
        p.x += p.vx + Math.sin(p.phase + Date.now() / 1000) * 0.1;
        p.y += p.vy;
        p.life -= dt;
        p.vx *= 0.99;
        p.vy *= 0.99;
    }
    ambientParticles = ambientParticles.filter(p => p.life > 0);
}

generateGrassBlades();
generatePathDetails();

// ---- Tower Types ----
const TOWER_TYPES = [
    {
        name: '화살탑',
        shortName: '화살',
        cost: 50,
        damage: 8,
        range: 3,
        fireRate: 0.4,
        color: '#44bb44',
        colorDark: '#228822',
        projColor: '#bbff55',
        projSpeed: 8,
        splash: 0,
        slow: 0,
        poison: 0,
        desc: '빠른 공격',
        icon: 'arrow',
    },
    {
        name: '대포탑',
        shortName: '대포',
        cost: 100,
        damage: 30,
        range: 2.8,
        fireRate: 1.2,
        color: '#cc6633',
        colorDark: '#884422',
        projColor: '#ff8844',
        projSpeed: 5,
        splash: 1.2,
        slow: 0,
        poison: 0,
        desc: '범위 공격',
        icon: 'cannon',
    },
    {
        name: '냉기탑',
        shortName: '냉기',
        cost: 75,
        damage: 5,
        range: 2.5,
        fireRate: 0.6,
        color: '#4488cc',
        colorDark: '#225588',
        projColor: '#88ddff',
        projSpeed: 6,
        splash: 0.6,
        slow: 0.5,
        poison: 0,
        desc: '감속 효과',
        icon: 'ice',
    },
    {
        name: '번개탑',
        shortName: '번개',
        cost: 130,
        damage: 18,
        range: 3.5,
        fireRate: 0.8,
        color: '#cccc22',
        colorDark: '#888811',
        projColor: '#ffff88',
        projSpeed: 12,
        splash: 0,
        slow: 0,
        poison: 0,
        desc: '장거리',
        icon: 'lightning',
    },
    {
        name: '독타워',
        shortName: '독',
        cost: 90,
        damage: 4,
        range: 2.5,
        fireRate: 0.7,
        color: '#44aa44',
        colorDark: '#226622',
        projColor: '#66ff44',
        projSpeed: 5,
        splash: 0.8,
        slow: 0,
        poison: 1,
        poisonDmg: 5,
        poisonDur: 4,
        desc: '지속 독 피해',
        icon: 'poison',
    },
];

// ---- Tower class ----
class Tower {
    constructor(col, row, typeIndex) {
        this.col = col;
        this.row = row;
        this.x = col * TILE + TILE / 2;
        this.y = row * TILE + TILE / 2;
        this.typeIndex = typeIndex;
        this.level = 1;
        this.cooldown = 0;
        this.angle = 0;
        this.target = null;
        this.totalDamage = 0;
        this.muzzleFlash = 0;
    }
    get type() { return TOWER_TYPES[this.typeIndex]; }
    get damage() { return Math.floor(this.type.damage * (1 + (this.level - 1) * 0.5)); }
    get range() { return this.type.range + (this.level - 1) * 0.3; }
    get fireRate() { return this.type.fireRate * Math.pow(0.88, this.level - 1); }
    get upgradeCost() { return Math.floor(this.type.cost * 0.6 * this.level); }
    get sellValue() {
        let total = this.type.cost;
        for (let i = 1; i < this.level; i++) total += Math.floor(this.type.cost * 0.6 * i);
        return Math.floor(total * 0.6);
    }
}

// ---- Enemy class ----
class Enemy {
    constructor(hp, speed, goldValue, type) {
        this.maxHp = hp;
        this.hp = hp;
        this.baseSpeed = speed;
        this.speed = speed;
        this.goldValue = goldValue;
        this.type = type || 'normal'; // normal, fast, tank, boss
        this.pathIndex = 0;
        this.x = enemyPath[0].x;
        this.y = enemyPath[0].y;
        this.alive = true;
        this.reachedEnd = false;
        this.slowTimer = 0;
        this.slowAmount = 0;
        this.poisonTimer = 0;
        this.poisonDmg = 0;
        this.poisonTick = 0;
        this.size = Math.min(TILE * 0.35, 10 + hp * 0.02);
        this.hitFlash = 0;
        this.armor = 0;
    }
}

// ---- Projectile class ----
class Projectile {
    constructor(x, y, target, tower) {
        this.x = x;
        this.y = y;
        this.target = target;
        this.tower = tower;
        this.speed = tower.type.projSpeed;
        this.damage = tower.damage;
        this.splash = tower.type.splash * TILE;
        this.slow = tower.type.slow;
        this.poison = tower.type.poison || 0;
        this.poisonDmg = tower.type.poisonDmg || 0;
        this.poisonDur = tower.type.poisonDur || 0;
        this.towerTypeIndex = tower.typeIndex;
        this.color = tower.type.projColor;
        this.alive = true;
        this.trail = [];
    }
}

// ---- Particle class ----
class Particle {
    constructor(x, y, color, vx, vy, life, size) {
        this.x = x;
        this.y = y;
        this.color = color;
        this.vx = vx;
        this.vy = vy;
        this.life = life;
        this.maxLife = life;
        this.size = size || 3;
    }
}

// ---- Floating text ----
class FloatingText {
    constructor(x, y, text, color) {
        this.x = x;
        this.y = y;
        this.text = text;
        this.color = color;
        this.life = 1.0;
        this.vy = -1.5;
    }
}

// ---- Shockwave Ring ----
class ShockwaveRing {
    constructor(x, y, maxRadius, color, duration) {
        this.x = x;
        this.y = y;
        this.radius = 0;
        this.maxRadius = maxRadius;
        this.color = color || '#ff8844';
        this.life = duration || 0.4;
        this.maxLife = this.life;
    }
}

// ---- Ground Mark ----
class GroundMark {
    constructor(x, y, size, color) {
        this.x = x;
        this.y = y;
        this.size = size || 5;
        this.color = color || 'rgba(80,60,30,0.5)';
        this.life = 2.0;
        this.maxLife = 2.0;
    }
}

// ---- Screen Shake ----
function triggerScreenShake(intensity, duration) {
    screenShakeIntensity = Math.max(screenShakeIntensity, intensity);
    screenShakeTimer = Math.max(screenShakeTimer, duration);
}

// ---- Wave definitions ----
function getWaveEnemies(waveNum) {
    const enemies = [];
    const baseHp = 30 + waveNum * 15 + Math.pow(waveNum, 1.5) * 5;
    const count = 5 + Math.floor(waveNum * 1.5);
    const speed = 1.0 + waveNum * 0.03;
    const goldBase = 5 + Math.floor(waveNum * 0.5);

    for (let i = 0; i < count; i++) {
        enemies.push({
            hp: Math.floor(baseHp * (0.8 + Math.random() * 0.4)),
            speed: speed * (0.9 + Math.random() * 0.2),
            gold: goldBase + Math.floor(Math.random() * 3),
            type: 'normal'
        });
    }

    // Add fast enemies starting wave 3
    if (waveNum >= 3) {
        const fastCount = Math.floor(waveNum * 0.5);
        for (let i = 0; i < fastCount; i++) {
            enemies.push({
                hp: Math.floor(baseHp * 0.5),
                speed: speed * 1.6,
                gold: goldBase + 2,
                type: 'fast'
            });
        }
    }

    // Add tank enemies starting wave 5
    if (waveNum >= 5) {
        const tankCount = Math.max(1, Math.floor(waveNum * 0.3));
        for (let i = 0; i < tankCount; i++) {
            enemies.push({
                hp: Math.floor(baseHp * 2.5),
                speed: speed * 0.6,
                gold: goldBase + 5,
                type: 'tank'
            });
        }
    }

    // Boss every 5 waves - escalating bosses
    if (waveNum % 5 === 0 && waveNum > 0) {
        const bossLevel = Math.floor(waveNum / 5);
        const bossHpMult = 6 + bossLevel * 2; // 8, 10, 12...
        enemies.push({
            hp: Math.floor(baseHp * bossHpMult),
            speed: speed * 0.4,
            gold: goldBase * 5 + bossLevel * 10,
            type: 'boss',
            bossLevel: bossLevel,
        });
        // Boss minions (escorts)
        const minionCount = Math.min(bossLevel * 2, 8);
        for (let i = 0; i < minionCount; i++) {
            enemies.push({
                hp: Math.floor(baseHp * 1.5),
                speed: speed * 0.7,
                gold: goldBase + 3,
                type: 'tank'
            });
        }
    }

    // Shuffle
    for (let i = enemies.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [enemies[i], enemies[j]] = [enemies[j], enemies[i]];
    }

    return enemies;
}

// ---- Start wave ----
function startWave() {
    if (gameOver) return;
    wave++;
    bossWave = (wave % 5 === 0);
    if (bossWave) {
        bossWarningTimer = 2.5;
        soundManager.bossWarning();
    } else {
        soundManager.waveStart();
    }
    waveTransitionTimer = 1.5;
    waveTransitionNum = wave;
    waveActive = true;
    betweenWaves = false;
    enemySpawnQueue = getWaveEnemies(wave);
    spawnTimer = 0;
}

// ---- Place tower ----
function placeTower(col, row) {
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return false;
    if (grid[row][col] !== 0) return false;
    if (towers.some(t => t.col === col && t.row === row)) return false;
    const type = TOWER_TYPES[selectedTower];
    if (gold < type.cost) return false;

    gold -= type.cost;
    const tower = new Tower(col, row, selectedTower);
    towers.push(tower);
    soundManager.towerPlace();
    return true;
}

// ---- Upgrade tower ----
function upgradeTower(tower) {
    if (tower.level >= 5) return false;
    if (gold < tower.upgradeCost) return false;
    gold -= tower.upgradeCost;
    tower.level++;
    soundManager.towerUpgrade();
    // particles
    for (let i = 0; i < 12; i++) {
        const angle = (Math.PI * 2 / 12) * i;
        particles.push(new Particle(
            tower.x, tower.y, '#ffdd44',
            Math.cos(angle) * 2, Math.sin(angle) * 2, 0.6, 3
        ));
    }
    return true;
}

// ---- Sell tower ----
function sellTower(tower) {
    gold += tower.sellValue;
    floatingTexts.push(new FloatingText(tower.x, tower.y, `+${tower.sellValue}G`, '#ffdd44'));
    towers = towers.filter(t => t !== tower);
    showUpgradeFor = null;
    soundManager.towerSell();
}

// ---- Distance helper ----
function dist(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

// ---- Spawn particles on enemy death ----
function spawnDeathParticles(enemy) {
    const colors = {
        normal: ['#ff4444', '#ff8844', '#ffcc44'],
        fast: ['#44ff44', '#88ff44', '#ccff88'],
        tank: ['#8844ff', '#aa66ff', '#cc88ff'],
        boss: ['#ff4444', '#ff8800', '#ffcc00', '#ffffff'],
    };
    const c = colors[enemy.type] || colors.normal;
    const count = enemy.type === 'boss' ? 50 : 20;
    for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 1 + Math.random() * 4;
        particles.push(new Particle(
            enemy.x, enemy.y,
            c[Math.floor(Math.random() * c.length)],
            Math.cos(angle) * speed, Math.sin(angle) * speed,
            0.4 + Math.random() * 0.6,
            2 + Math.random() * 4
        ));
    }
    // Shockwave ring
    if (shockwaves.length < 10) {
        const ringColor = enemy.type === 'boss' ? '#ff4444' : enemy.type === 'tank' ? '#8844ff' : '#ff8844';
        const ringSize = enemy.type === 'boss' ? TILE * 3 : TILE * 1.5;
        shockwaves.push(new ShockwaveRing(enemy.x, enemy.y, ringSize, ringColor, enemy.type === 'boss' ? 0.6 : 0.35));
    }
}

// ---- Update logic ----
function update(dt) {
    if (gameOver) return;

    // Between waves countdown
    if (betweenWaves) {
        if (wave === 0) {
            // First wave requires manual start
            waveCountdown = 0;
        } else {
            autoStartTimer += dt;
            waveCountdown = Math.max(0, 5 - autoStartTimer);
            if (autoStartTimer >= 5) {
                startWave();
                autoStartTimer = 0;
            }
        }
        // Still update remaining enemies/projectiles from previous wave
    }

    // Spawn enemies
    if (waveActive && enemySpawnQueue.length > 0) {
        spawnTimer -= dt;
        if (spawnTimer <= 0) {
            const data = enemySpawnQueue.shift();
            const e = new Enemy(data.hp, data.speed, data.gold, data.type);
            if (data.type === 'tank') {
                e.armor = 2;
                e.size = Math.min(TILE * 0.42, e.size * 1.3);
            }
            if (data.type === 'boss') {
                e.size = Math.min(TILE * 0.48, TILE * 0.48);
                e.armor = 3;
            }
            if (data.type === 'fast') {
                e.size *= 0.8;
            }
            enemies.push(e);
            spawnTimer = 0.5 + Math.random() * 0.3;
        }
    }

    // Check wave complete
    if (waveActive && enemySpawnQueue.length === 0 && enemies.length === 0) {
        waveActive = false;
        betweenWaves = true;
        autoStartTimer = 0;
        // Wave clear bonus
        const bonus = 10 + wave * 5;
        gold += bonus;
        floatingTexts.push(new FloatingText(W / 2, TILE * 2, `웨이브 ${wave} 클리어! +${bonus}G`, '#88ccff'));
    }

    // Update enemies
    for (const enemy of enemies) {
        if (!enemy.alive) continue;

        // Slow effect
        if (enemy.slowTimer > 0) {
            enemy.slowTimer -= dt;
            enemy.speed = enemy.baseSpeed * (1 - enemy.slowAmount);
        } else {
            enemy.speed = enemy.baseSpeed;
        }

        // Poison effect
        if (enemy.poisonTimer > 0) {
            enemy.poisonTimer -= dt;
            enemy.poisonTick -= dt;
            if (enemy.poisonTick <= 0) {
                enemy.poisonTick = 0.5;
                const pdmg = Math.max(1, enemy.poisonDmg - (enemy.armor || 0));
                enemy.hp -= pdmg;
                // Poison drip particles
                particles.push(new Particle(
                    enemy.x + (Math.random() - 0.5) * enemy.size,
                    enemy.y + (Math.random() - 0.5) * enemy.size,
                    '#44ff22', (Math.random() - 0.5) * 1, Math.random() * 1.5, 0.5, 2
                ));
                if (enemy.hp <= 0 && enemy.alive) {
                    enemy.alive = false;
                    gold += enemy.goldValue;
                    score += enemy.goldValue * 2;
                    spawnDeathParticles(enemy);
                    floatingTexts.push(new FloatingText(
                        enemy.x, enemy.y - 15, `+${enemy.goldValue}G`, '#ffdd44'
                    ));
                }
            }
        }

        // Move along path
        if (enemy.pathIndex < enemyPath.length) {
            const target = enemyPath[enemy.pathIndex];
            const dx = target.x - enemy.x;
            const dy = target.y - enemy.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            const moveSpeed = enemy.speed * TILE * dt;

            if (d < moveSpeed) {
                enemy.x = target.x;
                enemy.y = target.y;
                enemy.pathIndex++;
            } else {
                enemy.x += (dx / d) * moveSpeed;
                enemy.y += (dy / d) * moveSpeed;
            }
        }

        // Reached end
        if (enemy.pathIndex >= enemyPath.length) {
            enemy.alive = false;
            enemy.reachedEnd = true;
            const livesLost = enemy.type === 'boss' ? 5 : 1;
            lives -= livesLost;
            floatingTexts.push(new FloatingText(enemy.x, enemy.y, `-${livesLost} HP`, '#ff4444'));
            soundManager.lifeLost();
            triggerScreenShake(4, 0.2);
            if (lives <= 0) {
                lives = 0;
                gameOver = true;
                gameOverTimer = 0;
                soundManager.gameOverSound();
            }
        }

        // Hit flash decay
        if (enemy.hitFlash > 0) enemy.hitFlash -= dt * 4;
    }

    // Update towers
    for (const tower of towers) {
        tower.cooldown -= dt;

        // Find target
        const rangePixels = tower.range * TILE;
        let bestTarget = null;
        let bestProgress = -1;

        for (const enemy of enemies) {
            if (!enemy.alive) continue;
            if (dist(tower, enemy) <= rangePixels) {
                // Prefer enemies closest to exit (highest pathIndex)
                const progress = enemy.pathIndex + (1 - dist(enemy, enemyPath[Math.min(enemy.pathIndex, enemyPath.length - 1)]) / TILE);
                if (progress > bestProgress) {
                    bestProgress = progress;
                    bestTarget = enemy;
                }
            }
        }

        tower.target = bestTarget;

        if (bestTarget) {
            tower.angle = Math.atan2(bestTarget.y - tower.y, bestTarget.x - tower.x);

            if (tower.cooldown <= 0) {
                tower.cooldown = tower.fireRate;
                tower.muzzleFlash = 0.1;
                // Fire projectile
                const proj = new Projectile(tower.x, tower.y, bestTarget, tower);
                projectiles.push(proj);
                // Tower-specific fire sound
                const fireSounds = [() => soundManager.arrowFire(), () => soundManager.cannonFire(), () => soundManager.iceFire(), () => soundManager.lightningFire(), () => soundManager.poisonFire()];
                if (fireSounds[tower.typeIndex]) fireSounds[tower.typeIndex]();
            }
        }
    }

    // Update projectiles
    for (const proj of projectiles) {
        if (!proj.alive) continue;

        // Store trail
        proj.trail.push({ x: proj.x, y: proj.y });
        if (proj.trail.length > 5) proj.trail.shift();

        if (!proj.target.alive) {
            proj.alive = false;
            continue;
        }

        const dx = proj.target.x - proj.x;
        const dy = proj.target.y - proj.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const moveSpeed = proj.speed * TILE * dt;

        if (d < moveSpeed + proj.target.size) {
            // Hit
            proj.alive = false;

            // Apply damage
            const dmg = Math.max(1, proj.damage - (proj.target.armor || 0));
            proj.target.hp -= dmg;
            proj.target.hitFlash = 1;
            proj.tower.totalDamage += dmg;

            // Slow
            if (proj.slow > 0) {
                proj.target.slowTimer = 2;
                proj.target.slowAmount = proj.slow;
            }

            // Poison
            if (proj.poison > 0) {
                proj.target.poisonTimer = proj.poisonDur;
                proj.target.poisonDmg = proj.poisonDmg;
                proj.target.poisonTick = 0;
            }

            // Splash damage
            if (proj.splash > 0) {
                for (const enemy of enemies) {
                    if (!enemy.alive || enemy === proj.target) continue;
                    if (dist(proj, enemy) <= proj.splash) {
                        const splashDmg = Math.max(1, Math.floor(proj.damage * 0.5) - (enemy.armor || 0));
                        enemy.hp -= splashDmg;
                        enemy.hitFlash = 1;
                        if (proj.slow > 0) {
                            enemy.slowTimer = 1.5;
                            enemy.slowAmount = proj.slow * 0.5;
                        }
                        if (proj.poison > 0) {
                            enemy.poisonTimer = proj.poisonDur * 0.6;
                            enemy.poisonDmg = proj.poisonDmg;
                            enemy.poisonTick = 0;
                        }
                    }
                }
                // Splash visual - type-specific
                const splashCount = proj.poison > 0 ? 10 : 6;
                const splashColor = proj.poison > 0 ? '#44ff22' : proj.color;
                for (let i = 0; i < splashCount; i++) {
                    const angle = Math.random() * Math.PI * 2;
                    const spd = proj.poison > 0 ? 1 + Math.random() * 1.5 : 2;
                    particles.push(new Particle(
                        proj.x, proj.y, splashColor,
                        Math.cos(angle) * spd, Math.sin(angle) * spd,
                        proj.poison > 0 ? 0.6 : 0.3,
                        proj.poison > 0 ? 3 : 2
                    ));
                }
            }

            // Hit particle
            particles.push(new Particle(proj.x, proj.y, proj.color, 0, 0, 0.2, 4));

            // Ground mark
            if (groundMarks.length < 50) {
                const markColors = ['rgba(80,60,30,0.4)', 'rgba(60,40,20,0.3)', 'rgba(100,80,50,0.3)'];
                groundMarks.push(new GroundMark(proj.x, proj.y, 3 + Math.random() * 4, markColors[Math.floor(Math.random() * markColors.length)]));
            }


            // Check enemy death
            if (proj.target.hp <= 0 && proj.target.alive) {
                proj.target.alive = false;
                gold += proj.target.goldValue;
                score += proj.target.goldValue * 2;
                spawnDeathParticles(proj.target);
                floatingTexts.push(new FloatingText(
                    proj.target.x, proj.target.y - 15,
                    `+${proj.target.goldValue}G`, '#ffdd44'
                ));
                if (proj.target.type === 'boss') {
                    soundManager.bossDeath();
                    triggerScreenShake(8, 0.4);
                } else {
                    soundManager.enemyDeath();
                }
            }
        } else {
            proj.x += (dx / d) * moveSpeed;
            proj.y += (dy / d) * moveSpeed;
        }
    }

    // Check remaining enemies for death from splash
    for (const enemy of enemies) {
        if (enemy.alive && enemy.hp <= 0) {
            enemy.alive = false;
            gold += enemy.goldValue;
            score += enemy.goldValue * 2;
            spawnDeathParticles(enemy);
            floatingTexts.push(new FloatingText(
                enemy.x, enemy.y - 15,
                `+${enemy.goldValue}G`, '#ffdd44'
            ));
            if (enemy.type === 'boss') {
                soundManager.bossDeath();
                triggerScreenShake(8, 0.4);
            } else {
                soundManager.enemyDeath();
            }
        }
    }

    // Cleanup
    enemies = enemies.filter(e => e.alive);
    projectiles = projectiles.filter(p => p.alive);

    // Update particles
    for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        p.life -= dt;
        p.vx *= 0.95;
        p.vy *= 0.95;
    }
    particles = particles.filter(p => p.life > 0);

    // Update floating texts
    for (const ft of floatingTexts) {
        ft.y += ft.vy;
        ft.life -= dt * 1.2;
    }
    floatingTexts = floatingTexts.filter(ft => ft.life > 0);

    // Update shockwaves
    for (const sw of shockwaves) {
        sw.life -= dt / gameSpeed; // real time
        sw.radius = sw.maxRadius * (1 - sw.life / sw.maxLife);
    }
    shockwaves = shockwaves.filter(sw => sw.life > 0);

    // Update ground marks
    for (const gm of groundMarks) {
        gm.life -= dt / gameSpeed;
    }
    groundMarks = groundMarks.filter(gm => gm.life > 0);

    // Update muzzle flash
    for (const tower of towers) {
        if (tower.muzzleFlash > 0) tower.muzzleFlash -= dt / gameSpeed;
    }

    // Ambient particles
    updateAmbientParticles(dt / gameSpeed);

    // Gold/Lives flash tracking
    if (gold !== prevGold) {
        goldFlashTimer = 0.4;
        prevGold = gold;
    }
    if (lives !== prevLives) {
        livesFlashTimer = 0.5;
        prevLives = lives;
    }
    if (goldFlashTimer > 0) goldFlashTimer -= dt / gameSpeed;
    if (livesFlashTimer > 0) livesFlashTimer -= dt / gameSpeed;

    // Particle limit
    if (particles.length > 200) particles = particles.slice(-200);

    // Upgrade panel timer (실제 시간 기준 — 배속 영향 없음)
    if (showUpgradeFor) {
        showUpgradeTimer -= dt / gameSpeed;
        if (showUpgradeTimer <= 0) showUpgradeFor = null;
    }
}

// ---- Drawing helpers ----
function drawRoundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

// ---- Draw ----
function draw() {
    ctx.clearRect(0, 0, W, H);

    const gameH = ROWS * TILE;

    // Screen shake — apply to game field only
    ctx.save();
    if (screenShakeTimer > 0) {
        const shakeX = (Math.random() - 0.5) * 2 * screenShakeIntensity;
        const shakeY = (Math.random() - 0.5) * 2 * screenShakeIntensity;
        ctx.translate(shakeX, shakeY);
    }

    // Draw grass background
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            const x = c * TILE;
            const y = r * TILE;

            if (grid[r][c] === 0) {
                // Grass with subtle pattern
                ctx.fillStyle = (r + c) % 2 === 0 ? '#2a5a2a' : '#2d5e2d';
                ctx.fillRect(x, y, TILE, TILE);
                // Small grass detail
                if ((r * 7 + c * 13) % 5 === 0) {
                    ctx.fillStyle = '#3a6a3a';
                    ctx.fillRect(x + TILE * 0.3, y + TILE * 0.3, 2, 2);
                }
            } else {
                // Path
                ctx.fillStyle = '#c4a86a';
                ctx.fillRect(x, y, TILE, TILE);
                // Path detail
                ctx.fillStyle = '#b89858';
                if ((r + c) % 3 === 0) {
                    ctx.fillRect(x + 2, y + 2, TILE - 4, TILE - 4);
                }
                // Path border
                ctx.strokeStyle = '#a08040';
                ctx.lineWidth = 0.5;
                ctx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
            }
        }
    }

    // Draw path details (pebbles, cracks)
    for (const pd of pathDetails) {
        ctx.fillStyle = pd.color;
        if (pd.type === 'pebble') {
            ctx.beginPath();
            ctx.arc(pd.x, pd.y, pd.size, 0, Math.PI * 2);
            ctx.fill();
        } else {
            ctx.save();
            ctx.translate(pd.x, pd.y);
            ctx.rotate(pd.angle);
            ctx.fillRect(-pd.size * 2, -0.5, pd.size * 4, 1);
            ctx.restore();
        }
    }

    // Draw grass blades (wind sway)
    const windTime = Date.now() / 800;
    for (const gb of grassBlades) {
        const sway = Math.sin(windTime + gb.phase) * 3;
        ctx.strokeStyle = gb.color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(gb.x, gb.y);
        ctx.lineTo(gb.x + sway, gb.y - gb.h);
        ctx.stroke();
    }

    // Draw ground marks (from projectile hits)
    for (const gm of groundMarks) {
        const alpha = gm.life / gm.maxLife;
        ctx.globalAlpha = alpha * 0.5;
        ctx.fillStyle = gm.color;
        ctx.beginPath();
        ctx.arc(gm.x, gm.y, gm.size, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Draw path direction arrows (subtle)
    ctx.globalAlpha = 0.15;
    ctx.fillStyle = '#604020';
    for (let i = 0; i < waypoints.length - 1; i++) {
        const a = waypoints[i];
        const b = waypoints[i + 1];
        const mx = ((a.x + b.x) / 2) * TILE + TILE / 2;
        const my = ((a.y + b.y) / 2) * TILE + TILE / 2;
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        ctx.save();
        ctx.translate(mx, my);
        ctx.rotate(angle);
        ctx.beginPath();
        ctx.moveTo(6, 0);
        ctx.lineTo(-4, -5);
        ctx.lineTo(-4, 5);
        ctx.fill();
        ctx.restore();
    }
    ctx.globalAlpha = 1;

    // Entry/Exit markers
    const entry = waypoints[0];
    const exitP = waypoints[waypoints.length - 1];
    ctx.fillStyle = '#44cc44';
    ctx.font = `bold ${Math.floor(TILE * 0.4)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText('IN', Math.max(TILE / 2, entry.x * TILE + TILE / 2), entry.y * TILE + TILE / 2 + TILE * 0.15);
    ctx.fillStyle = '#cc4444';
    ctx.fillText('OUT', Math.min(W - TILE / 2, exitP.x * TILE + TILE / 2), exitP.y * TILE + TILE / 2 + TILE * 0.15);

    // Draw tower range indicator when hovering
    if (hoveredTile && !showUpgradeFor) {
        const hc = hoveredTile.col;
        const hr = hoveredTile.row;
        if (hr < ROWS && grid[hr][hc] === 0 && !towers.some(t => t.col === hc && t.row === hr)) {
            const type = TOWER_TYPES[selectedTower];
            const rangePixels = type.range * TILE;
            const cx = hc * TILE + TILE / 2;
            const cy = hr * TILE + TILE / 2;

            // Range circle
            ctx.beginPath();
            ctx.arc(cx, cy, rangePixels, 0, Math.PI * 2);
            ctx.fillStyle = gold >= type.cost ? 'rgba(100,200,100,0.12)' : 'rgba(200,100,100,0.12)';
            ctx.fill();
            ctx.strokeStyle = gold >= type.cost ? 'rgba(100,200,100,0.4)' : 'rgba(200,100,100,0.4)';
            ctx.lineWidth = 1;
            ctx.stroke();

            // Ghost tower
            ctx.globalAlpha = 0.5;
            drawTowerAt(cx, cy, selectedTower, 1);
            ctx.globalAlpha = 1;
        }
    }

    // Draw towers
    for (const tower of towers) {
        // Tower shadow
        ctx.fillStyle = 'rgba(0,0,0,0.2)';
        ctx.beginPath();
        ctx.ellipse(tower.x + 1, tower.y + TILE * 0.3, TILE * 0.3, TILE * 0.12, 0, 0, Math.PI * 2);
        ctx.fill();

        drawTowerAt(tower.x, tower.y, tower.typeIndex, tower.level, tower.angle);

        // Muzzle flash glow
        if (tower.muzzleFlash > 0) {
            ctx.save();
            ctx.shadowColor = tower.type.projColor;
            ctx.shadowBlur = 15 * (tower.muzzleFlash / 0.1);
            ctx.fillStyle = tower.type.projColor;
            ctx.globalAlpha = tower.muzzleFlash / 0.1 * 0.6;
            const muzzleX = tower.x + Math.cos(tower.angle) * TILE * 0.4;
            const muzzleY = tower.y + Math.sin(tower.angle) * TILE * 0.4;
            ctx.beginPath();
            ctx.arc(muzzleX, muzzleY, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
            ctx.globalAlpha = 1;
            ctx.shadowBlur = 0;
        }

        // Level indicator
        if (tower.level > 1) {
            ctx.fillStyle = '#ffdd44';
            ctx.font = `bold ${Math.floor(TILE * 0.28)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('★'.repeat(Math.min(tower.level - 1, 4)),
                tower.x, tower.y + TILE * 0.42);
        }
    }

    // Draw selected tower range
    if (showUpgradeFor) {
        const t = showUpgradeFor;
        const rangePixels = t.range * TILE;
        ctx.beginPath();
        ctx.arc(t.x, t.y, rangePixels, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,100,0.08)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,100,0.3)';
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    // Draw enemies
    for (const enemy of enemies) {
        if (!enemy.alive) continue;
        drawEnemy(enemy);
    }

    // Draw projectiles (type-specific effects)
    for (const proj of projectiles) {
        if (!proj.alive) continue;
        const ti = proj.towerTypeIndex;

        if (ti === 0) {
            // Arrow - thin fast line
            const len = Math.min(proj.trail.length, 3);
            if (len > 0) {
                ctx.strokeStyle = proj.color;
                ctx.lineWidth = 2;
                ctx.globalAlpha = 0.6;
                ctx.beginPath();
                ctx.moveTo(proj.trail[Math.max(0, proj.trail.length - len)].x, proj.trail[Math.max(0, proj.trail.length - len)].y);
                for (let i = Math.max(0, proj.trail.length - len); i < proj.trail.length; i++) {
                    ctx.lineTo(proj.trail[i].x, proj.trail[i].y);
                }
                ctx.lineTo(proj.x, proj.y);
                ctx.stroke();
                ctx.globalAlpha = 1;
            }
            // Arrow head with glow
            ctx.save();
            ctx.shadowColor = '#bbff55';
            ctx.shadowBlur = 6;
            ctx.fillStyle = '#eeff88';
            ctx.beginPath();
            ctx.arc(proj.x, proj.y, 2.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();

        } else if (ti === 1) {
            // Cannon - big glowing ball with smoke trail
            for (let i = 0; i < proj.trail.length; i++) {
                const alpha = (i + 1) / proj.trail.length * 0.25;
                ctx.globalAlpha = alpha;
                ctx.fillStyle = '#888';
                const r = 3 - (i / proj.trail.length) * 2;
                ctx.beginPath();
                ctx.arc(proj.trail[i].x + (Math.random()-0.5)*2, proj.trail[i].y + (Math.random()-0.5)*2, r, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
            // Cannonball with glow
            ctx.save();
            ctx.shadowColor = '#ff8844';
            ctx.shadowBlur = 8;
            ctx.fillStyle = '#333';
            ctx.beginPath();
            ctx.arc(proj.x, proj.y, 4.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#ff8844';
            ctx.beginPath();
            ctx.arc(proj.x - 1, proj.y - 1, 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();

        } else if (ti === 2) {
            // Ice - crystalline snowflake trail
            for (let i = 0; i < proj.trail.length; i++) {
                const alpha = (i + 1) / proj.trail.length * 0.5;
                ctx.globalAlpha = alpha;
                ctx.fillStyle = '#aaeeff';
                const sz = 1.5 + Math.random();
                ctx.save();
                ctx.translate(proj.trail[i].x, proj.trail[i].y);
                ctx.rotate(i * 0.8);
                ctx.fillRect(-sz/2, -sz/2, sz, sz);
                ctx.restore();
            }
            ctx.globalAlpha = 1;
            // Ice shard
            ctx.fillStyle = '#88ddff';
            ctx.save();
            ctx.translate(proj.x, proj.y);
            ctx.rotate(Date.now() / 100);
            ctx.beginPath();
            ctx.moveTo(0, -4);
            ctx.lineTo(-3, 0);
            ctx.lineTo(0, 4);
            ctx.lineTo(3, 0);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = '#ccf0ff';
            ctx.beginPath();
            ctx.arc(0, 0, 1.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();

        } else if (ti === 3) {
            // Lightning - jagged electric bolt from tower to target
            ctx.strokeStyle = '#ffff44';
            ctx.lineWidth = 2;
            ctx.globalAlpha = 0.8;
            ctx.beginPath();
            ctx.moveTo(proj.x, proj.y);
            const tx = proj.target.alive ? proj.target.x : proj.x;
            const ty = proj.target.alive ? proj.target.y : proj.y;
            const segments = 4;
            for (let i = 1; i <= segments; i++) {
                const t = i / segments;
                const lx = proj.x + (tx - proj.x) * t * 0.3 + (Math.random() - 0.5) * 8;
                const ly = proj.y + (ty - proj.y) * t * 0.3 + (Math.random() - 0.5) * 8;
                ctx.lineTo(lx, ly);
            }
            ctx.stroke();
            // Secondary bolt (thinner)
            ctx.strokeStyle = '#ffffaa';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(proj.x + (Math.random()-0.5)*3, proj.y + (Math.random()-0.5)*3);
            for (let i = 1; i <= 3; i++) {
                const t = i / 3;
                ctx.lineTo(
                    proj.x + (Math.random() - 0.5) * 12,
                    proj.y + (Math.random() - 0.5) * 12
                );
            }
            ctx.stroke();
            ctx.globalAlpha = 1;
            // Electric orb with glow
            ctx.save();
            ctx.shadowColor = '#ffff44';
            ctx.shadowBlur = 10;
            ctx.fillStyle = '#ffff88';
            ctx.beginPath();
            ctx.arc(proj.x, proj.y, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();

        } else if (ti === 4) {
            // Poison - bubbly green blob trail
            for (let i = 0; i < proj.trail.length; i++) {
                const alpha = (i + 1) / proj.trail.length * 0.4;
                ctx.globalAlpha = alpha;
                ctx.fillStyle = '#44ff22';
                const r = 1.5 + Math.sin(i * 1.5) * 1;
                ctx.beginPath();
                ctx.arc(
                    proj.trail[i].x + Math.sin(i * 2) * 2,
                    proj.trail[i].y + Math.cos(i * 2) * 2,
                    r, 0, Math.PI * 2
                );
                ctx.fill();
            }
            ctx.globalAlpha = 1;
            // Poison glob with glow
            ctx.save();
            ctx.shadowColor = '#44ff22';
            ctx.shadowBlur = 8;
            ctx.fillStyle = '#33cc11';
            ctx.beginPath();
            ctx.arc(proj.x, proj.y, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#66ff44';
            ctx.beginPath();
            ctx.arc(proj.x - 1, proj.y - 1, 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
            // Drip bubble
            ctx.fillStyle = '#88ff66';
            ctx.globalAlpha = 0.6;
            ctx.beginPath();
            ctx.arc(proj.x + 2, proj.y + 3, 1.2, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;

        } else {
            // Fallback default
            for (let i = 0; i < proj.trail.length; i++) {
                const alpha = (i + 1) / proj.trail.length * 0.4;
                ctx.globalAlpha = alpha;
                ctx.fillStyle = proj.color;
                ctx.beginPath();
                ctx.arc(proj.trail[i].x, proj.trail[i].y, 2, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
            ctx.fillStyle = proj.color;
            ctx.beginPath();
            ctx.arc(proj.x, proj.y, 3, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // Draw particles
    for (const p of particles) {
        const alpha = p.life / p.maxLife;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Draw shockwave rings
    for (const sw of shockwaves) {
        const alpha = sw.life / sw.maxLife;
        ctx.strokeStyle = sw.color;
        ctx.lineWidth = 2 + alpha * 2;
        ctx.globalAlpha = alpha * 0.7;
        ctx.beginPath();
        ctx.arc(sw.x, sw.y, sw.radius, 0, Math.PI * 2);
        ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Draw ambient particles
    for (const ap of ambientParticles) {
        const alpha = Math.min(1, ap.life / ap.maxLife) * 0.6;
        ctx.globalAlpha = alpha;
        if (ap.isFirefly) {
            ctx.save();
            ctx.shadowColor = '#aaff44';
            ctx.shadowBlur = 6;
            ctx.fillStyle = '#ddff88';
            ctx.beginPath();
            ctx.arc(ap.x, ap.y, ap.size, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        } else {
            ctx.fillStyle = 'rgba(200,200,180,0.4)';
            ctx.beginPath();
            ctx.arc(ap.x, ap.y, ap.size, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;

    // Draw floating texts
    for (const ft of floatingTexts) {
        ctx.globalAlpha = ft.life;
        ctx.fillStyle = ft.color;
        ctx.font = `bold ${Math.floor(TILE * 0.35)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(ft.text, ft.x, ft.y);
    }
    ctx.globalAlpha = 1;

    // Wave transition overlay
    if (waveTransitionTimer > 0) {
        const wtt = waveTransitionTimer;
        let textAlpha, textX;
        if (wtt > 1.2) {
            // Slide in (1.5 -> 1.2)
            const t = (1.5 - wtt) / 0.3;
            textX = W * (-0.3 + t * 0.8);
            textAlpha = t;
        } else if (wtt > 0.5) {
            // Hold
            textX = W * 0.5;
            textAlpha = 1;
        } else {
            // Slide out (0.5 -> 0)
            const t = wtt / 0.5;
            textX = W * (0.5 + (1 - t) * 0.8);
            textAlpha = t;
        }
        ctx.globalAlpha = textAlpha * 0.8;
        ctx.fillStyle = '#88ccff';
        ctx.font = `bold ${Math.floor(TILE * 0.6)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`웨이브 ${waveTransitionNum}`, textX, ROWS * TILE * 0.45);
        ctx.globalAlpha = 1;
    }

    // Restore screen shake transform before UI
    ctx.restore();

    // ---- UI Panel (bottom) ----
    const uiY = ROWS * TILE;
    const uiGrad = ctx.createLinearGradient(0, uiY, 0, uiY + UI_ROWS * TILE);
    uiGrad.addColorStop(0, '#1e1e38');
    uiGrad.addColorStop(1, '#12121e');
    ctx.fillStyle = uiGrad;
    ctx.fillRect(0, uiY, W, UI_ROWS * TILE);

    // Top bar of UI
    const barGrad = ctx.createLinearGradient(0, uiY, 0, uiY + TILE * 0.8);
    barGrad.addColorStop(0, '#222244');
    barGrad.addColorStop(1, '#1a1a30');
    ctx.fillStyle = barGrad;
    ctx.fillRect(0, uiY, W, TILE * 0.8);
    // 하단 구분선
    ctx.strokeStyle = 'rgba(100,160,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, uiY + TILE * 0.8);
    ctx.lineTo(W, uiY + TILE * 0.8);
    ctx.stroke();

    // Stats — 개별 뱃지 컨테이너
    ctx.textBaseline = 'middle';
    const barH = TILE * 0.8;
    const badgePad = 4;
    const badgeH = barH - badgePad * 2;
    const badgeR = 4;
    const fontSize = Math.floor(TILE * 0.32);
    const iconSize = Math.floor(TILE * 0.3);
    const statY = uiY + barH / 2;

    const stats = [
        { icon: '🌊', label: `${wave}`, color: '#88ccff', bg: 'rgba(80,140,220,0.15)', border: 'rgba(80,140,220,0.35)' },
        { icon: '💰', label: `${gold}`, color: '#ffdd44', bg: 'rgba(220,180,40,0.15)', border: 'rgba(220,180,40,0.35)' },
        { icon: '❤️', label: `${lives}`, color: '#ff6666', bg: 'rgba(220,70,70,0.15)', border: 'rgba(220,70,70,0.35)' },
        { icon: '⭐', label: `${score}`, color: '#aaaadd', bg: 'rgba(150,150,200,0.15)', border: 'rgba(150,150,200,0.3)' },
    ];

    // 속도 버튼 공간 확보
    const speedReserved = TILE * 1.9 + 10;
    const availStatW = W - speedReserved - 8;
    const gap = 5;
    const badgeW = Math.floor((availStatW - gap * (stats.length - 1)) / stats.length);
    let bx = 6;

    for (let si = 0; si < stats.length; si++) {
        const st = stats[si];
        // 뱃지 배경
        drawRoundRect(bx, uiY + badgePad, badgeW, badgeH, badgeR);
        ctx.fillStyle = st.bg;
        ctx.fill();
        ctx.strokeStyle = st.border;
        ctx.lineWidth = 1;
        ctx.stroke();

        // Flash overlay (gold = index 1, lives = index 2)
        if (si === 1 && goldFlashTimer > 0) {
            ctx.globalAlpha = goldFlashTimer / 0.4 * 0.3;
            drawRoundRect(bx, uiY + badgePad, badgeW, badgeH, badgeR);
            ctx.fillStyle = '#ffdd44';
            ctx.fill();
            ctx.globalAlpha = 1;
        }
        if (si === 2 && livesFlashTimer > 0) {
            ctx.globalAlpha = livesFlashTimer / 0.5 * 0.35;
            drawRoundRect(bx, uiY + badgePad, badgeW, badgeH, badgeR);
            ctx.fillStyle = '#ff4444';
            ctx.fill();
            ctx.globalAlpha = 1;
        }

        // 아이콘
        ctx.font = `${iconSize}px sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillText(st.icon, bx + 5, statY + 1);

        // 값
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.fillStyle = st.color;
        ctx.textAlign = 'center';
        ctx.fillText(st.label, bx + badgeW / 2 + iconSize * 0.35, statY);

        bx += badgeW + gap;
    }

    // Volume button
    const volBtnW = TILE * 0.7;
    const volBtnH = TILE * 0.65;
    const volBtnX = W - TILE * 1.8 - 6 - volBtnW - 6;
    const volBtnY = uiY + (TILE * 0.8 - volBtnH) / 2;
    drawRoundRect(volBtnX, volBtnY, volBtnW, volBtnH, 5);
    ctx.fillStyle = soundMuted ? '#3a1a1a' : '#1e1e35';
    ctx.fill();
    ctx.strokeStyle = soundMuted ? '#cc4444' : '#556';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = soundMuted ? '#ff6644' : '#aab';
    ctx.font = `${Math.floor(TILE * 0.35)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(soundMuted ? '🔇' : '🔊', volBtnX + volBtnW / 2, volBtnY + volBtnH * 0.5 + 1);
    window._volBtn = { x: volBtnX, y: volBtnY, w: volBtnW, h: volBtnH };

    // Speed button (right side of top bar)
    const speedBtnW = TILE * 1.8;
    const speedBtnH = TILE * 0.65;
    const speedBtnX = W - speedBtnW - 6;
    const speedBtnY = uiY + (TILE * 0.8 - speedBtnH) / 2;
    drawRoundRect(speedBtnX, speedBtnY, speedBtnW, speedBtnH, 5);
    ctx.fillStyle = gameSpeed === 1 ? '#1e1e35' : gameSpeed === 2 ? '#1e2e1e' : '#3a1a1a';
    ctx.fill();
    ctx.strokeStyle = gameSpeed === 1 ? '#556' : gameSpeed === 2 ? '#88cc44' : '#ff6644';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    const speedLabels = ['▶ 보통', '▶▶ 빠르게', '▶▶▶ 최대'];
    const speedLabel = speedLabels[gameSpeed - 1];
    ctx.fillStyle = gameSpeed === 1 ? '#aab' : gameSpeed === 2 ? '#88ff44' : '#ff6644';
    ctx.font = `bold ${Math.floor(TILE * 0.3)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(isMobile ? speedLabel : `${speedLabel} [Q]`, speedBtnX + speedBtnW / 2, speedBtnY + speedBtnH * 0.5 + 1);
    // Store for click detection
    window._speedBtn = { x: speedBtnX, y: speedBtnY, w: speedBtnW, h: speedBtnH };

    // Boss warning overlay
    if (bossWarningTimer > 0) {
        const warnAlpha = Math.min(1, bossWarningTimer / 0.5) * (0.3 + Math.sin(Date.now() / 100) * 0.15);
        ctx.fillStyle = `rgba(180, 0, 0, ${warnAlpha})`;
        ctx.fillRect(0, 0, W, ROWS * TILE);

        ctx.fillStyle = '#ff2222';
        ctx.font = `bold ${Math.floor(TILE * 0.9)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.globalAlpha = Math.min(1, bossWarningTimer / 0.5);
        ctx.fillText('⚠ BOSS WAVE ⚠', W / 2, ROWS * TILE * 0.4);
        ctx.fillStyle = '#ffcc44';
        ctx.font = `bold ${Math.floor(TILE * 0.4)}px sans-serif`;
        ctx.fillText(`웨이브 ${wave} - 보스 출현!`, W / 2, ROWS * TILE * 0.55);
        ctx.globalAlpha = 1;
        ctx.textBaseline = 'alphabetic';
    }

    // Tower selection buttons
    const btnY = uiY + TILE * 0.95;
    const btnH = TILE * 1.5;
    const btnW = Math.floor((W - 10) / TOWER_TYPES.length) - 6;
    const btnStartX = 8;

    for (let i = 0; i < TOWER_TYPES.length; i++) {
        const type = TOWER_TYPES[i];
        const bx = btnStartX + i * (btnW + 6);
        const isSelected = i === selectedTower;
        const canAfford = gold >= type.cost;

        // Check hover
        const isHovered = mousePos.x >= bx && mousePos.x <= bx + btnW && mousePos.y >= btnY && mousePos.y <= btnY + btnH;

        // Button background
        drawRoundRect(bx, btnY, btnW, btnH, 6);
        ctx.fillStyle = isSelected ? '#2a3a5a' : isHovered ? '#222244' : '#1a1a30';
        ctx.fill();
        if (isSelected) {
            ctx.save();
            ctx.shadowColor = type.color;
            ctx.shadowBlur = 8;
            ctx.strokeStyle = type.color;
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.restore();
        } else {
            ctx.strokeStyle = isHovered ? '#444466' : '#333355';
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        // Tower icon
        const iconX = bx + btnW * 0.2;
        const iconY = btnY + btnH * 0.38;
        ctx.save();
        const iconScale = TILE * 0.015;
        drawTowerIcon(iconX, iconY, i, iconScale);
        ctx.restore();

        // Tower name
        ctx.fillStyle = canAfford ? '#ddd' : '#666';
        ctx.font = `bold ${Math.floor(TILE * 0.3)}px sans-serif`;
        ctx.textAlign = 'left';
        ctx.fillText(type.shortName, bx + btnW * 0.38, btnY + btnH * 0.3);

        // Cost
        ctx.fillStyle = canAfford ? '#ffdd44' : '#664422';
        ctx.font = `${Math.floor(TILE * 0.26)}px sans-serif`;
        ctx.fillText(`${type.cost}G`, bx + btnW * 0.38, btnY + btnH * 0.55);

        // Desc
        ctx.fillStyle = '#888';
        ctx.font = `${Math.floor(TILE * 0.22)}px sans-serif`;
        ctx.fillText(type.desc, bx + btnW * 0.38, btnY + btnH * 0.78);

        // Keyboard hint (모바일에서는 숨김)
        if (!isMobile) {
            ctx.fillStyle = '#444466';
            ctx.font = `${Math.floor(TILE * 0.22)}px sans-serif`;
            ctx.textAlign = 'right';
            ctx.fillText(`[${i + 1}]`, bx + btnW - 6, btnY + btnH * 0.85);
        }
    }

    // Upgrade panel
    if (showUpgradeFor) {
        const t = showUpgradeFor;
        const panelW = Math.min(W * 0.5, 220);
        const panelH = TILE * 2.8;
        let panelX = t.x - panelW / 2;
        let panelY = t.y - panelH - TILE * 0.6;
        if (panelY < 5) panelY = t.y + TILE * 0.6;
        if (panelX < 5) panelX = 5;
        if (panelX + panelW > W - 5) panelX = W - panelW - 5;

        // Panel bg
        drawRoundRect(panelX, panelY, panelW, panelH, 8);
        ctx.fillStyle = 'rgba(20,20,40,0.95)';
        ctx.fill();
        ctx.strokeStyle = t.type.color;
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        let py = panelY + 8;
        const px = panelX + 10;

        // Tower name and level
        ctx.fillStyle = t.type.color;
        ctx.font = `bold ${Math.floor(TILE * 0.35)}px sans-serif`;
        ctx.fillText(`${t.type.name} Lv.${t.level}`, px, py);
        py += TILE * 0.45;

        // Stats
        ctx.fillStyle = '#bbb';
        ctx.font = `${Math.floor(TILE * 0.26)}px sans-serif`;
        ctx.fillText(`공격력: ${t.damage}  사거리: ${t.range.toFixed(1)}`, px, py);
        py += TILE * 0.34;
        ctx.fillText(`공격속도: ${t.fireRate.toFixed(2)}s  총 데미지: ${t.totalDamage}`, px, py);
        py += TILE * 0.42;

        // Upgrade button
        if (t.level < 5) {
            const ubw = panelW * 0.44;
            const ubh = TILE * 0.65;
            const ubx = px;
            const uby = py;
            const canUp = gold >= t.upgradeCost;

            drawRoundRect(ubx, uby, ubw, ubh, 4);
            ctx.fillStyle = canUp ? '#2a4a2a' : '#2a2a2a';
            ctx.fill();
            ctx.strokeStyle = canUp ? '#44bb44' : '#444';
            ctx.lineWidth = 1;
            ctx.stroke();

            ctx.fillStyle = canUp ? '#88ff88' : '#666';
            ctx.font = `bold ${Math.floor(TILE * 0.26)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillText(`업그레이드 ${t.upgradeCost}G`, ubx + ubw / 2, uby + ubh * 0.25);

            // Store button position for click detection
            t._upgradeBtn = { x: ubx, y: uby, w: ubw, h: ubh };
        } else {
            ctx.fillStyle = '#ffdd44';
            ctx.font = `bold ${Math.floor(TILE * 0.28)}px sans-serif`;
            ctx.textAlign = 'left';
            ctx.fillText('MAX LEVEL', px, py);
            t._upgradeBtn = null;
        }

        // Sell button
        const sbw = panelW * 0.38;
        const sbh = TILE * 0.65;
        const sbx = panelX + panelW - sbw - 10;
        const sby = py;

        drawRoundRect(sbx, sby, sbw, sbh, 4);
        ctx.fillStyle = '#4a2a2a';
        ctx.fill();
        ctx.strokeStyle = '#cc4444';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#ff8888';
        ctx.font = `bold ${Math.floor(TILE * 0.26)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(`판매 ${t.sellValue}G`, sbx + sbw / 2, sby + sbh * 0.25);

        t._sellBtn = { x: sbx, y: sby, w: sbw, h: sbh };
    }

    // Wave countdown / start prompt
    if (betweenWaves && !gameOver) {
        const countdown = Math.ceil(waveCountdown);
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        drawRoundRect(W / 2 - 100, TILE * 0.3, 200, TILE * 1.2, 8);
        ctx.fill();

        ctx.fillStyle = '#88ccff';
        ctx.font = `bold ${Math.floor(TILE * 0.38)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        if (wave === 0) {
            ctx.fillText(isMobile ? '탭으로 시작' : '스페이스바 / 탭으로 시작', W / 2, TILE * 0.9);
        } else {
            ctx.fillText(`다음 웨이브: ${countdown}초`, W / 2, TILE * 0.7);
            ctx.font = `${Math.floor(TILE * 0.26)}px sans-serif`;
            ctx.fillStyle = '#aaa';
            ctx.fillText(isMobile ? '탭으로 스킵' : '스페이스바 / 탭으로 스킵', W / 2, TILE * 1.15);
        }
    }

    // Game over overlay (animated)
    if (gameOver) {
        const got = gameOverTimer;
        // Darken
        const darkAlpha = Math.min(0.75, got * 1.5);
        ctx.fillStyle = `rgba(0,0,0,${darkAlpha})`;
        ctx.fillRect(0, 0, W, H);

        if (got > 0.5) {
            // GAME OVER text - scale in
            const textT = Math.min(1, (got - 0.5) / 0.3);
            const scale = 0.5 + textT * 0.5;
            ctx.save();
            ctx.translate(W / 2, H * 0.32);
            ctx.scale(scale, scale);
            ctx.fillStyle = '#ff4444';
            ctx.font = `bold ${Math.floor(TILE * 0.85)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.globalAlpha = textT;
            ctx.fillText('GAME OVER', 0, 0);
            ctx.restore();
            ctx.globalAlpha = 1;
        }

        if (got > 1.2) {
            // Score count-up
            const scoreT = Math.min(1, (got - 1.2) / 0.8);
            const displayScore = Math.floor(score * scoreT);
            ctx.fillStyle = '#ddd';
            ctx.font = `${Math.floor(TILE * 0.4)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`웨이브: ${wave}  점수: ${displayScore}`, W / 2, H * 0.43);

            // High score
            const hs = localStorage.getItem('td_highscore') || 0;
            if (score > hs) {
                localStorage.setItem('td_highscore', score);
                ctx.fillStyle = '#ffdd44';
                ctx.font = `bold ${Math.floor(TILE * 0.32)}px sans-serif`;
                ctx.fillText('🏆 새 최고 점수!', W / 2, H * 0.5);
            } else {
                ctx.fillStyle = '#888';
                ctx.font = `${Math.floor(TILE * 0.28)}px sans-serif`;
                ctx.fillText(`최고 점수: ${hs}`, W / 2, H * 0.5);
            }
        }

        if (got > 2.0) {
            ctx.fillStyle = '#88ccff';
            ctx.font = `${Math.floor(TILE * 0.35)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const blink = Math.sin(Date.now() / 400) * 0.3 + 0.7;
            ctx.globalAlpha = blink;
            ctx.fillText(isMobile ? '탭하여 다시 시작' : '클릭하여 다시 시작', W / 2, H * 0.58);
            ctx.globalAlpha = 1;
        }
    }
}

// ---- Draw tower at position ----
function drawTowerAt(x, y, typeIndex, level, angle) {
    const type = TOWER_TYPES[typeIndex];
    const s = TILE * 0.38;
    const a = angle || 0;

    ctx.save();
    ctx.translate(x, y);

    // Base
    ctx.fillStyle = type.colorDark;
    ctx.beginPath();
    ctx.arc(0, 0, s, 0, Math.PI * 2);
    ctx.fill();

    // Tower body
    ctx.fillStyle = type.color;

    if (typeIndex === 0) {
        // Arrow tower - triangle on circle
        ctx.beginPath();
        ctx.arc(0, 0, s * 0.75, 0, Math.PI * 2);
        ctx.fill();
        // Turret
        ctx.save();
        ctx.rotate(a);
        ctx.fillStyle = '#66dd66';
        ctx.fillRect(-2, -s * 0.9, 4, s * 0.9);
        ctx.fillStyle = '#88ff88';
        ctx.beginPath();
        ctx.moveTo(0, -s);
        ctx.lineTo(-4, -s * 0.6);
        ctx.lineTo(4, -s * 0.6);
        ctx.fill();
        ctx.restore();
    } else if (typeIndex === 1) {
        // Cannon tower - square-ish
        drawRoundRect(-s * 0.65, -s * 0.65, s * 1.3, s * 1.3, 3);
        ctx.fill();
        // Barrel
        ctx.save();
        ctx.rotate(a);
        ctx.fillStyle = '#dd8844';
        ctx.fillRect(-3, -s * 1.0, 6, s * 0.7);
        ctx.fillStyle = '#333';
        ctx.beginPath();
        ctx.arc(0, -s * 1.0, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    } else if (typeIndex === 2) {
        // Ice tower - hexagonal
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
            const ang = (Math.PI * 2 / 6) * i - Math.PI / 6;
            const px = Math.cos(ang) * s * 0.8;
            const py = Math.sin(ang) * s * 0.8;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        // Crystal
        ctx.fillStyle = '#88ddff';
        ctx.beginPath();
        ctx.moveTo(0, -s * 0.5);
        ctx.lineTo(-s * 0.3, 0);
        ctx.lineTo(0, s * 0.5);
        ctx.lineTo(s * 0.3, 0);
        ctx.closePath();
        ctx.fill();
        // Glow
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = '#aaeeff';
        ctx.beginPath();
        ctx.arc(0, 0, s * 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
    } else if (typeIndex === 3) {
        // Lightning tower - star shape
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
            const ang = (Math.PI * 2 / 8) * i - Math.PI / 2;
            const r = i % 2 === 0 ? s * 0.85 : s * 0.45;
            const px = Math.cos(ang) * r;
            const py = Math.sin(ang) * r;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        // Center orb
        ctx.fillStyle = '#ffff88';
        ctx.beginPath();
        ctx.arc(0, 0, s * 0.25, 0, Math.PI * 2);
        ctx.fill();
        // Lightning bolt indicator
        ctx.save();
        ctx.rotate(a);
        ctx.strokeStyle = '#ffff44';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, -s * 0.15);
        ctx.lineTo(s * 0.15, -s * 0.55);
        ctx.lineTo(-s * 0.05, -s * 0.4);
        ctx.lineTo(s * 0.1, -s * 0.85);
        ctx.stroke();
        ctx.restore();
    } else if (typeIndex === 4) {
        // Poison tower - bubbling cauldron
        ctx.beginPath();
        ctx.arc(0, 0, s * 0.75, 0, Math.PI * 2);
        ctx.fill();
        // Cauldron body
        ctx.fillStyle = '#226622';
        ctx.beginPath();
        ctx.arc(0, s * 0.1, s * 0.55, 0, Math.PI);
        ctx.fill();
        // Poison liquid
        ctx.fillStyle = '#44ff22';
        ctx.beginPath();
        ctx.ellipse(0, s * 0.05, s * 0.45, s * 0.2, 0, 0, Math.PI * 2);
        ctx.fill();
        // Bubbles
        ctx.fillStyle = '#88ff66';
        ctx.globalAlpha = 0.6 + Math.sin(Date.now() / 200) * 0.3;
        ctx.beginPath();
        ctx.arc(-s * 0.15, -s * 0.05 + Math.sin(Date.now() / 300) * 2, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(s * 0.15, -s * 0.1 + Math.sin(Date.now() / 250 + 1) * 2, 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
    }

    // Level ring
    if (level > 1) {
        ctx.strokeStyle = '#ffdd44';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, 0, s + 2, 0, Math.PI * 2 * ((level - 1) / 4));
        ctx.stroke();
    }

    ctx.restore();
}

// ---- Draw tower icon for UI buttons ----
function drawTowerIcon(x, y, typeIndex, scale) {
    const s = 12 * (scale || 1);
    ctx.save();
    ctx.translate(x, y);

    const type = TOWER_TYPES[typeIndex];
    ctx.fillStyle = type.colorDark;
    ctx.beginPath();
    ctx.arc(0, 0, s, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = type.color;
    ctx.beginPath();
    ctx.arc(0, 0, s * 0.75, 0, Math.PI * 2);
    ctx.fill();

    if (typeIndex === 0) {
        ctx.fillStyle = '#88ff88';
        ctx.beginPath();
        ctx.moveTo(0, -s * 0.8);
        ctx.lineTo(-4, -s * 0.3);
        ctx.lineTo(4, -s * 0.3);
        ctx.fill();
    } else if (typeIndex === 1) {
        ctx.fillStyle = '#333';
        ctx.beginPath();
        ctx.arc(0, -s * 0.5, 3, 0, Math.PI * 2);
        ctx.fill();
    } else if (typeIndex === 2) {
        ctx.fillStyle = '#88ddff';
        ctx.beginPath();
        ctx.moveTo(0, -s * 0.4);
        ctx.lineTo(-s * 0.3, 0);
        ctx.lineTo(0, s * 0.4);
        ctx.lineTo(s * 0.3, 0);
        ctx.closePath();
        ctx.fill();
    } else if (typeIndex === 3) {
        ctx.strokeStyle = '#ffff44';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(2, -s * 0.1);
        ctx.lineTo(s * 0.2, -s * 0.6);
        ctx.lineTo(-s * 0.05, -s * 0.35);
        ctx.lineTo(s * 0.1, -s * 0.8);
        ctx.stroke();
    } else if (typeIndex === 4) {
        // Poison icon - droplet
        ctx.fillStyle = '#44ff22';
        ctx.beginPath();
        ctx.moveTo(0, -s * 0.6);
        ctx.quadraticCurveTo(s * 0.4, -s * 0.1, 0, s * 0.3);
        ctx.quadraticCurveTo(-s * 0.4, -s * 0.1, 0, -s * 0.6);
        ctx.fill();
    }

    ctx.restore();
}

// ---- Draw enemy ----
function drawEnemy(enemy) {
    const x = enemy.x;
    const y = enemy.y;
    const s = enemy.size;

    ctx.save();

    // Slow visual
    if (enemy.slowTimer > 0) {
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = '#88ddff';
        ctx.beginPath();
        ctx.arc(x, y, s + 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
    }

    // Poison visual
    if (enemy.poisonTimer > 0) {
        ctx.globalAlpha = 0.25 + Math.sin(Date.now() / 150) * 0.1;
        ctx.fillStyle = '#44ff22';
        ctx.beginPath();
        ctx.arc(x, y, s + 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        // Poison bubbles around enemy
        ctx.fillStyle = '#66ff44';
        ctx.globalAlpha = 0.5;
        const bubbleAngle = Date.now() / 400;
        ctx.beginPath();
        ctx.arc(x + Math.cos(bubbleAngle) * (s + 2), y + Math.sin(bubbleAngle) * (s + 2), 1.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x + Math.cos(bubbleAngle + 2) * (s + 3), y + Math.sin(bubbleAngle + 2) * (s + 3), 1, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
    }

    // Body color based on type
    let bodyColor, borderColor;
    switch (enemy.type) {
        case 'fast':
            bodyColor = '#44cc44';
            borderColor = '#228822';
            break;
        case 'tank':
            bodyColor = '#8844cc';
            borderColor = '#552288';
            break;
        case 'boss':
            bodyColor = '#cc2222';
            borderColor = '#881111';
            break;
        default:
            bodyColor = '#dd6644';
            borderColor = '#993322';
    }

    // Hit flash
    if (enemy.hitFlash > 0) {
        bodyColor = '#ffffff';
    }

    // Shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(x + 1, y + 2, s, s * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();

    // Body
    ctx.fillStyle = bodyColor;
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 2;

    if (enemy.type === 'tank') {
        // Armored brute - square with spikes
        drawRoundRect(x - s, y - s, s * 2, s * 2, 3);
        ctx.fill();
        ctx.stroke();
        // Armor plates
        ctx.fillStyle = borderColor;
        drawRoundRect(x - s * 0.6, y - s * 0.7, s * 1.2, s * 0.4, 2);
        ctx.fill();
        // Corner spikes
        ctx.fillStyle = '#9966dd';
        const spkS = s * 0.35;
        [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([dx,dy]) => {
            ctx.beginPath();
            ctx.moveTo(x + dx * s, y + dy * s);
            ctx.lineTo(x + dx * (s + spkS), y + dy * (s - spkS * 0.5));
            ctx.lineTo(x + dx * (s - spkS * 0.5), y + dy * (s + spkS));
            ctx.fill();
        });
    } else if (enemy.type === 'boss') {
        // Demon boss - pentagon with horns and aura
        // Pulsing aura
        const auraPhase = Math.sin(Date.now() / 200) * 0.15;
        ctx.globalAlpha = 0.15 + auraPhase;
        ctx.fillStyle = '#ff4444';
        ctx.beginPath();
        ctx.arc(x, y, s * 1.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        // Body
        ctx.fillStyle = bodyColor;
        ctx.beginPath();
        for (let i = 0; i < 5; i++) {
            const ang = (Math.PI * 2 / 5) * i - Math.PI / 2;
            const px = x + Math.cos(ang) * s;
            const py = y + Math.sin(ang) * s;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // Horns
        ctx.fillStyle = '#441111';
        ctx.beginPath();
        ctx.moveTo(x - s * 0.5, y - s * 0.6);
        ctx.lineTo(x - s * 0.9, y - s * 1.4);
        ctx.lineTo(x - s * 0.15, y - s * 0.7);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(x + s * 0.5, y - s * 0.6);
        ctx.lineTo(x + s * 0.9, y - s * 1.4);
        ctx.lineTo(x + s * 0.15, y - s * 0.7);
        ctx.fill();
        // Crown/crest
        ctx.fillStyle = '#ff8800';
        ctx.beginPath();
        ctx.moveTo(x, y - s * 0.8);
        ctx.lineTo(x - s * 0.15, y - s * 1.1);
        ctx.lineTo(x + s * 0.15, y - s * 1.1);
        ctx.fill();
    } else if (enemy.type === 'fast') {
        // Swift blade - diamond with tail
        ctx.beginPath();
        ctx.moveTo(x, y - s * 1.1);
        ctx.lineTo(x + s * 0.8, y);
        ctx.lineTo(x, y + s * 0.6);
        ctx.lineTo(x - s * 0.8, y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // Speed lines
        ctx.strokeStyle = '#88ff88';
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.4;
        for (let i = 0; i < 3; i++) {
            const ly = y - s * 0.3 + i * s * 0.3;
            ctx.beginPath();
            ctx.moveTo(x - s * 1.2 - i * 3, ly);
            ctx.lineTo(x - s * 0.6, ly);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
        // Blade tip
        ctx.fillStyle = '#aaffaa';
        ctx.beginPath();
        ctx.moveTo(x, y - s * 1.1);
        ctx.lineTo(x - s * 0.15, y - s * 0.7);
        ctx.lineTo(x + s * 0.15, y - s * 0.7);
        ctx.fill();
    } else {
        // Normal - menacing circle with spikes
        ctx.beginPath();
        ctx.arc(x, y, s, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // Small spikes around body
        ctx.fillStyle = borderColor;
        for (let i = 0; i < 6; i++) {
            const ang = (Math.PI * 2 / 6) * i + Date.now() / 2000;
            ctx.beginPath();
            ctx.moveTo(x + Math.cos(ang) * s * 0.85, y + Math.sin(ang) * s * 0.85);
            ctx.lineTo(x + Math.cos(ang) * s * 1.3, y + Math.sin(ang) * s * 1.3);
            ctx.lineTo(x + Math.cos(ang + 0.2) * s * 0.85, y + Math.sin(ang + 0.2) * s * 0.85);
            ctx.fill();
        }
    }

    // Eyes and face (type-specific, only when not flashing)
    if (enemy.hitFlash <= 0) {
        if (enemy.type === 'boss') {
            // Glowing red eyes
            ctx.fillStyle = '#ff0000';
            ctx.shadowColor = '#ff0000';
            ctx.shadowBlur = 6;
            ctx.beginPath();
            ctx.arc(x - s * 0.3, y - s * 0.1, s * 0.18, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(x + s * 0.3, y - s * 0.1, s * 0.18, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;
            // Slit pupils
            ctx.fillStyle = '#440000';
            ctx.fillRect(x - s * 0.32, y - s * 0.2, s * 0.04, s * 0.2);
            ctx.fillRect(x + s * 0.28, y - s * 0.2, s * 0.04, s * 0.2);
            // Fanged mouth
            ctx.strokeStyle = '#ff6644';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(x - s * 0.3, y + s * 0.2);
            ctx.lineTo(x - s * 0.15, y + s * 0.35);
            ctx.lineTo(x, y + s * 0.2);
            ctx.lineTo(x + s * 0.15, y + s * 0.35);
            ctx.lineTo(x + s * 0.3, y + s * 0.2);
            ctx.stroke();
        } else if (enemy.type === 'tank') {
            // Angry slit eyes
            ctx.fillStyle = '#ddaaff';
            ctx.beginPath();
            ctx.ellipse(x - s * 0.3, y - s * 0.1, s * 0.22, s * 0.1, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.ellipse(x + s * 0.3, y - s * 0.1, s * 0.22, s * 0.1, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#220044';
            ctx.beginPath();
            ctx.arc(x - s * 0.28, y - s * 0.1, s * 0.08, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(x + s * 0.32, y - s * 0.1, s * 0.08, 0, Math.PI * 2);
            ctx.fill();
            // Angry brow line
            ctx.strokeStyle = '#552288';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x - s * 0.5, y - s * 0.35);
            ctx.lineTo(x - s * 0.15, y - s * 0.2);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(x + s * 0.5, y - s * 0.35);
            ctx.lineTo(x + s * 0.15, y - s * 0.2);
            ctx.stroke();
        } else if (enemy.type === 'fast') {
            // Sharp narrow eyes
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.ellipse(x - s * 0.2, y - s * 0.15, s * 0.18, s * 0.08, -0.2, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.ellipse(x + s * 0.2, y - s * 0.15, s * 0.18, s * 0.08, 0.2, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#002200';
            ctx.beginPath();
            ctx.arc(x - s * 0.18, y - s * 0.15, s * 0.06, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(x + s * 0.22, y - s * 0.15, s * 0.06, 0, Math.PI * 2);
            ctx.fill();
        } else {
            // Normal - menacing eyes + jagged mouth
            ctx.fillStyle = '#ffcc00';
            ctx.beginPath();
            ctx.arc(x - s * 0.25, y - s * 0.15, s * 0.2, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(x + s * 0.25, y - s * 0.15, s * 0.2, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#331100';
            ctx.beginPath();
            ctx.arc(x - s * 0.22, y - s * 0.15, s * 0.1, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(x + s * 0.28, y - s * 0.15, s * 0.1, 0, Math.PI * 2);
            ctx.fill();
            // Jagged mouth
            ctx.strokeStyle = '#331100';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x - s * 0.25, y + s * 0.15);
            ctx.lineTo(x - s * 0.1, y + s * 0.25);
            ctx.lineTo(x, y + s * 0.12);
            ctx.lineTo(x + s * 0.1, y + s * 0.25);
            ctx.lineTo(x + s * 0.25, y + s * 0.15);
            ctx.stroke();
        }
    }

    ctx.restore();

    // Health bar
    const hpRatio = enemy.hp / enemy.maxHp;
    const barW = s * 2;
    const barH = 3;
    const barX = x - barW / 2;
    const barY = y - s - 6;

    ctx.fillStyle = '#333';
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = hpRatio > 0.5 ? '#44cc44' : hpRatio > 0.25 ? '#cccc44' : '#cc4444';
    ctx.fillRect(barX, barY, barW * hpRatio, barH);

    // Armor indicator for tanks/bosses
    if (enemy.armor > 0) {
        ctx.strokeStyle = '#aaaadd';
        ctx.lineWidth = 1;
        ctx.strokeRect(barX - 1, barY - 1, barW + 2, barH + 2);
    }
}

// ---- Input handling ----
function getCanvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    let clientX, clientY;
    if (e.touches) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    } else {
        clientX = e.clientX;
        clientY = e.clientY;
    }
    return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY
    };
}

function handleClick(pos) {
    // Init audio on first interaction (browser policy)
    soundManager.init();

    if (gameOver) {
        if (gameOverTimer > 2.0) restartGame();
        return;
    }

    // Volume button click
    if (window._volBtn) {
        const vb = window._volBtn;
        if (pos.x >= vb.x && pos.x <= vb.x + vb.w && pos.y >= vb.y && pos.y <= vb.y + vb.h) {
            soundMuted = !soundMuted;
            soundManager.uiClick();
            return;
        }
    }

    // Speed button click
    if (window._speedBtn) {
        const sb = window._speedBtn;
        if (pos.x >= sb.x && pos.x <= sb.x + sb.w && pos.y >= sb.y && pos.y <= sb.y + sb.h) {
            const idx = SPEED_OPTIONS.indexOf(gameSpeed);
            gameSpeed = SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length];
            soundManager.uiClick();
            return;
        }
    }

    const col = Math.floor(pos.x / TILE);
    const row = Math.floor(pos.y / TILE);

    // Check upgrade panel buttons
    if (showUpgradeFor) {
        const t = showUpgradeFor;

        // Check upgrade button
        if (t._upgradeBtn) {
            const b = t._upgradeBtn;
            if (pos.x >= b.x && pos.x <= b.x + b.w && pos.y >= b.y && pos.y <= b.y + b.h) {
                upgradeTower(t);
                showUpgradeTimer = 4;
                return;
            }
        }

        // Check sell button
        if (t._sellBtn) {
            const b = t._sellBtn;
            if (pos.x >= b.x && pos.x <= b.x + b.w && pos.y >= b.y && pos.y <= b.y + b.h) {
                sellTower(t);
                return;
            }
        }
    }

    // Check tower selection UI buttons
    const uiY = ROWS * TILE;
    const btnY = uiY + TILE * 0.95;
    const btnH = TILE * 1.5;
    const btnW = Math.floor((W - 10) / TOWER_TYPES.length) - 6;
    const btnStartX = 8;

    if (pos.y >= btnY && pos.y <= btnY + btnH) {
        for (let i = 0; i < TOWER_TYPES.length; i++) {
            const bx = btnStartX + i * (btnW + 6);
            if (pos.x >= bx && pos.x <= bx + btnW) {
                selectedTower = i;
                showUpgradeFor = null;
                soundManager.uiClick();
                return;
            }
        }
    }

    // Skip wave timer
    if (pos.y < TILE * 1.5 && betweenWaves) {
        startWave();
        autoStartTimer = 0;
        return;
    }

    // Click on game grid
    if (row >= 0 && row < ROWS && col >= 0 && col < COLS) {
        // Check if clicking on existing tower
        const existingTower = towers.find(t => t.col === col && t.row === row);
        if (existingTower) {
            if (showUpgradeFor === existingTower) {
                showUpgradeFor = null;
            } else {
                showUpgradeFor = existingTower;
                showUpgradeTimer = 6;
            }
            return;
        }

        // Place new tower
        showUpgradeFor = null;
        if (placeTower(col, row)) {
            // Success particles
            const t = towers[towers.length - 1];
            for (let i = 0; i < 8; i++) {
                const angle = (Math.PI * 2 / 8) * i;
                particles.push(new Particle(
                    t.x, t.y, t.type.color,
                    Math.cos(angle) * 1.5, Math.sin(angle) * 1.5, 0.4, 2
                ));
            }
        }
    }
}

function handleMove(pos) {
    const col = Math.floor(pos.x / TILE);
    const row = Math.floor(pos.y / TILE);
    if (col >= 0 && col < COLS && row >= 0 && row < ROWS) {
        hoveredTile = { col, row };
    } else {
        hoveredTile = null;
    }
}

canvas.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handleClick(getCanvasPos(e));
});

canvas.addEventListener('mousemove', (e) => {
    const pos = getCanvasPos(e);
    mousePos = pos;
    handleMove(pos);
});

canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const pos = getCanvasPos(e);
    handleMove(pos);
    handleClick(pos);
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    handleMove(getCanvasPos(e));
}, { passive: false });

// Keyboard
document.addEventListener('keydown', (e) => {
    if (e.key === '1') selectedTower = 0;
    if (e.key === '2') selectedTower = 1;
    if (e.key === '3') selectedTower = 2;
    if (e.key === '4') selectedTower = 3;
    if (e.key === '5') selectedTower = 4;
    if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (gameOver) {
            restartGame();
        } else if (betweenWaves) {
            startWave();
            autoStartTimer = 0;
        }
    }
    if (e.key === 'Escape') {
        showUpgradeFor = null;
    }
    if (e.key === 'q' || e.key === 'Q') {
        const idx = SPEED_OPTIONS.indexOf(gameSpeed);
        gameSpeed = SPEED_OPTIONS[(idx + 1) % SPEED_OPTIONS.length];
    }
    if (e.key === 'u' || e.key === 'U') {
        if (showUpgradeFor) upgradeTower(showUpgradeFor);
    }
    if (e.key === 's' || e.key === 'S') {
        if (showUpgradeFor) sellTower(showUpgradeFor);
    }
    if (e.key === 'm' || e.key === 'M') {
        soundMuted = !soundMuted;
    }
});

// ---- Restart ----
function restartGame() {
    gold = 150;
    lives = 20;
    wave = 0;
    score = 0;
    gameOver = false;
    waveActive = false;
    betweenWaves = true;
    autoStartTimer = 0;
    enemies = [];
    towers = [];
    projectiles = [];
    particles = [];
    floatingTexts = [];
    enemySpawnQueue = [];
    showUpgradeFor = null;
    selectedTower = 0;
    // v2.0
    screenShakeIntensity = 0;
    screenShakeTimer = 0;
    shockwaves = [];
    groundMarks = [];
    ambientParticles = [];
    prevGold = 150;
    prevLives = 20;
    goldFlashTimer = 0;
    livesFlashTimer = 0;
    waveTransitionTimer = 0;
    gameOverTimer = 0;
    generateGrassBlades();
    generatePathDetails();
}

// ---- Game Loop ----
let lastTime = performance.now();
function gameLoop(time) {
    const rawDt = Math.min((time - lastTime) / 1000, 0.05);
    lastTime = time;
    const dt = rawDt * gameSpeed;

    // Recalculate path on resize
    enemyPath = buildPathPixels();

    // Boss warning timer (runs at real time)
    if (bossWarningTimer > 0) bossWarningTimer -= rawDt;

    // Screen shake decay (real time)
    if (screenShakeTimer > 0) {
        screenShakeTimer -= rawDt;
        screenShakeIntensity *= 0.9;
        if (screenShakeTimer <= 0) {
            screenShakeIntensity = 0;
            screenShakeTimer = 0;
        }
    }

    // Wave transition timer (real time)
    if (waveTransitionTimer > 0) waveTransitionTimer -= rawDt;

    // Game over timer (real time)
    if (gameOver) gameOverTimer += rawDt;

    update(dt);
    draw();
    requestAnimationFrame(gameLoop);
}

// Initial draw so the game renders immediately
draw();
requestAnimationFrame(gameLoop);
