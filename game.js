// ============================================================
// Tower Defense - Hyper-casual Browser Game
// ============================================================

// ---- Poki SDK ----
let pokiReady = false;
let pokiGameplayActive = false;
let adInProgress = false;
let showRewardedAdOption = false; // 게임오버 시 보상형 광고 버튼 표시 여부
let rewardedAdUsed = false; // 이번 게임에서 보상형 광고 사용 여부

function pokiInit() {
    if (typeof PokiSDK === 'undefined') return;
    PokiSDK.init().then(() => {
        pokiReady = true;
        PokiSDK.gameLoadingFinished();
    }).catch(() => {
        // SDK 실패해도 게임은 정상 진행
    });
}

function pokiGameplayStart() {
    if (!pokiReady || pokiGameplayActive) return;
    pokiGameplayActive = true;
    PokiSDK.gameplayStart();
}

function pokiGameplayStop() {
    if (!pokiReady || !pokiGameplayActive) return;
    pokiGameplayActive = false;
    PokiSDK.gameplayStop();
}

function pokiCommercialBreak() {
    return new Promise((resolve) => {
        if (!pokiReady) { resolve(); return; }
        adInProgress = true;
        soundMuted_backup = soundMuted;
        soundMuted = true;
        PokiSDK.commercialBreak().then(() => {
            soundMuted = soundMuted_backup;
            adInProgress = false;
            resolve();
        });
    });
}

function pokiRewardedBreak() {
    return new Promise((resolve) => {
        if (!pokiReady) { resolve(false); return; }
        adInProgress = true;
        soundMuted_backup = soundMuted;
        soundMuted = true;
        PokiSDK.rewardedBreak().then((success) => {
            soundMuted = soundMuted_backup;
            adInProgress = false;
            resolve(success);
        });
    });
}

let soundMuted_backup = false;

// Poki 요구사항: 화살표/스페이스 키 브라우저 스크롤 방지
window.addEventListener('keydown', (ev) => {
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', ' '].includes(ev.key)) {
        ev.preventDefault();
    }
});

pokiInit();

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// ---- Responsive sizing ----
const COLS = 20;
const ROWS = 14;
const UI_ROWS = 3;
const TOTAL_ROWS = ROWS + UI_ROWS;

let TILE, W, H;
let isMobile = false;
let showRotateOverlay = false;
let backgroundCache = null;

const MIN_TILE = 32;
const MAX_TILE = 96;
let DPR = 1;

function resize() {
    const isTouchDevice = 'ontouchstart' in window;
    const shortSide = Math.min(window.innerWidth, window.innerHeight);
    const isPortrait = window.innerHeight > window.innerWidth;
    const isLandscapeMobile = isTouchDevice && !isPortrait && shortSide <= 500;

    // 여백 계산 (타이틀 제거로 데스크톱도 최소화)
    const marginW = isLandscapeMobile ? 2 : (isTouchDevice ? 6 : 24);
    const marginH = isLandscapeMobile ? 4 : (isTouchDevice ? 12 : 24);
    const availW = window.innerWidth - marginW;
    const availH = window.innerHeight - marginH;

    // TILE = 화면에 꽉 차는 크기 (MAX 제한 있지만 큼직함)
    TILE = Math.floor(Math.min(availW / COLS, availH / TOTAL_ROWS));
    TILE = Math.max(MIN_TILE, Math.min(MAX_TILE, TILE));

    W = COLS * TILE;
    H = TOTAL_ROWS * TILE;

    // DPR 적용: 내부 해상도를 물리 픽셀 단위로 높여서 선명하게
    // 상한 1.5로 제한 — Retina(DPR=2)에서 픽셀 수 44% 감소, 성능 우선
    DPR = Math.max(1, Math.min(window.devicePixelRatio || 1, 1.5));
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';

    // 모든 draw 코드는 논리좌표(CSS px) 기반 → DPR로 스케일
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    // 기본은 스무딩 ON (UI/배경 부드럽게) — drawSprite 내부에서만 픽셀 모드로 전환
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 배경 캐시 무효화 (resize 때마다 재생성)
    backgroundCache = null;

    // 모바일 판별
    isMobile = isTouchDevice && (window.innerWidth <= 768 || window.innerHeight <= 500);
    showRotateOverlay = isTouchDevice && shortSide <= 500 && isPortrait;

    // 타워 좌표 재계산
    try {
        for (const t of towers) {
            t.x = t.col * TILE + TILE / 2;
            t.y = t.row * TILE + TILE / 2;
        }
    } catch(e) {}
}
resize();
window.addEventListener('resize', () => { resize(); });
if (screen.orientation) screen.orientation.addEventListener('change', resize);
window.addEventListener('orientationchange', resize);

// ---- Game State ----
let gold = 150;
let lives = 20;
let wave = 0;
let score = 0;
let gameOver = false;
let waveActive = false;
let waveTimer = 0;
let enemySpawnQueue = [];
let waveTotalEnemies = 0;
let spawnTimer = 0;
let selectedTower = -1; // -1 = 선택 없음 (건설 모드 꺼짐)
let buildIdleTimer = 0; // 타워 건설 후 N초 미사용 시 자동 선택 해제 (남은 초)
let showHelp = false;   // H 키로 토글되는 단축키 도움말 오버레이

// 숫자 천단위 콤마 포맷 (정수만 — 소수점 값은 호출 측에서 toFixed 처리)
function fmt(n) {
    if (typeof n !== 'number' || !isFinite(n)) return String(n);
    return Math.floor(n).toLocaleString('en-US');
}

// hex 색을 amount만큼 밝게 (FloatingText 그라디언트용)
function lightenHex(hex, amount) {
    if (!hex || hex[0] !== '#' || hex.length < 7) return hex;
    const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + amount);
    const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + amount);
    const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + amount);
    return `rgb(${r},${g},${b})`;
}

// 클릭 가능 영역 hotspot — 매 프레임 draw()에서 reset 후 그리는 시점에 push
let pointerHotspots = [];
function addPointerHotspot(x, y, w, h) {
    pointerHotspots.push({ x: x, y: y, w: w, h: h });
}
function isOverHotspot(px, py) {
    for (let i = 0; i < pointerHotspots.length; i++) {
        const r = pointerHotspots[i];
        if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return true;
    }
    return false;
}

const CURSOR_CROSSHAIR = (function () {
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'>
<circle cx='16' cy='16' r='11' fill='none' stroke='%23000' stroke-width='4' opacity='0.45'/>
<circle cx='16' cy='16' r='11' fill='none' stroke='%23ffd84a' stroke-width='2'/>
<circle cx='16' cy='16' r='7' fill='none' stroke='%23ffd84a' stroke-width='1' opacity='0.6'/>
<path d='M16 2 L18 11 L16 9 L14 11 Z' fill='%23ffd84a' stroke='%23000' stroke-width='0.6'/>
<path d='M16 30 L14 21 L16 23 L18 21 Z' fill='%23ffd84a' stroke='%23000' stroke-width='0.6'/>
<path d='M2 16 L11 14 L9 16 L11 18 Z' fill='%23ffd84a' stroke='%23000' stroke-width='0.6'/>
<path d='M30 16 L21 18 L23 16 L21 14 Z' fill='%23ffd84a' stroke='%23000' stroke-width='0.6'/>
<circle cx='16' cy='16' r='1.8' fill='%23ff4020'/>
</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, crosshair`;
})();
let _lastCursor = '';
// 마우스 위치 + selectedTower + hotspot 상태에 따라 커서 결정
function updateCursor() {
    if (!canvas) return;
    let target;
    if (typeof mousePos !== 'undefined' && isOverHotspot(mousePos.x, mousePos.y)) {
        target = 'pointer';
    } else if (selectedTower >= 0) {
        target = CURSOR_CROSSHAIR;
    } else {
        target = 'default';
    }
    if (_lastCursor !== target) {
        _lastCursor = target;
        canvas.style.cursor = target;
    }
}
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
let waveType = 'normal'; // 'normal' | 'rush' | 'heavy' | 'boss'

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

// ---- v2.1 New State ----
let chainLightnings = [];
let lang = (navigator.language || 'ko').startsWith('ko') ? 'ko' : 'en';

// ---- Localization ----
const L = {
    ko: {
        towerNames: ['화살탑', '대포탑', '번개탑', '냉기탑', '독타워'],
        towerShort: ['화살', '대포', '번개', '냉기', '독'],
        towerDesc: ['빠른 공격, 치명타', '범위 공격', '장거리 연쇄', '감속 효과', '지속 독 피해'],
        waveClear: (w, g) => `웨이브 ${fmt(w)} 클리어! +${fmt(g)}G`,
        waveNum: (w) => `웨이브 ${fmt(w)}`,
        bossAppear: (w) => `웨이브 ${fmt(w)} - 보스 출현!`,
        nextWave: (s) => `다음 웨이브: ${fmt(s)}초`,
        startPrompt: '스페이스바 / 탭으로 시작',
        startPromptMobile: '탭으로 시작',
        skipPrompt: '스페이스바 / 탭으로 스킵',
        skipPromptMobile: '탭으로 스킵',
        restart: '클릭하여 다시 시작',
        restartMobile: '탭하여 다시 시작',
        restartBtn: '다시 시작',
        gameOver: 'GAME OVER',
        waveScore: (w, s) => `웨이브: ${fmt(w)}  점수: ${fmt(s)}`,
        newHighScore: '🏆 새 최고 점수!',
        highScore: (s) => `최고 점수: ${fmt(s)}`,
        reviveAd: '🎬 광고 보고 부활 (+5 HP)',
        speedLabels: ['×1', '×2', '×3'],
        upgrade: (cost) => `업그레이드 ${fmt(cost)}G`,
        sell: (val) => `판매 ${fmt(val)}G`,
        maxLevel: 'MAX LEVEL',
        atk: '공격력',
        range: '사거리',
        atkSpeed: '공격속도',
        totalDmg: '총 데미지',
        shieldBreak: '방어막 파괴!',
        summon: '소환!',
        speedBurst: '가속!',
        crit: 'CRITICAL!',
        bossWarn: '⚠ 보스 웨이브 ⚠',
        rushWarn: '⚡ 적들이 빠르게 몰려와요! ⚡',
        heavyWarn: '🛡 거대한 적들이 몰려옵니다! 🛡',
        swarmWarn: '🦠 작은 적들이 떼지어 몰려옵니다! 🦠',
        rotatePlease: '화면을 가로로 돌려주세요',
        langLabel: '한/EN',
    },
    en: {
        towerNames: ['Arrow', 'Cannon', 'Lightning', 'Ice', 'Poison'],
        towerShort: ['Arrow', 'Cannon', 'Zap', 'Ice', 'Toxic'],
        towerDesc: ['Fast, Critical', 'Splash', 'Long Chain', 'Slow 50%', 'DOT Poison'],
        waveClear: (w, g) => `Wave ${fmt(w)} Clear! +${fmt(g)}G`,
        waveNum: (w) => `Wave ${fmt(w)}`,
        bossAppear: (w) => `Wave ${fmt(w)} - Boss Incoming!`,
        nextWave: (s) => `Next Wave: ${fmt(s)}s`,
        startPrompt: 'Space / Tap to Start',
        startPromptMobile: 'Tap to Start',
        skipPrompt: 'Space / Tap to Skip',
        skipPromptMobile: 'Tap to Skip',
        restart: 'Click to Restart',
        restartMobile: 'Tap to Restart',
        restartBtn: 'Restart',
        gameOver: 'GAME OVER',
        waveScore: (w, s) => `Wave: ${fmt(w)}  Score: ${fmt(s)}`,
        newHighScore: '🏆 New High Score!',
        highScore: (s) => `High Score: ${fmt(s)}`,
        reviveAd: '🎬 Watch Ad to Revive (+5 HP)',
        speedLabels: ['×1', '×2', '×3'],
        upgrade: (cost) => `Upgrade ${fmt(cost)}G`,
        sell: (val) => `Sell ${fmt(val)}G`,
        maxLevel: 'MAX LEVEL',
        atk: 'ATK',
        range: 'Range',
        atkSpeed: 'Rate',
        totalDmg: 'Total DMG',
        shieldBreak: 'Shield Down!',
        summon: 'Summon!',
        speedBurst: 'Rush!',
        crit: 'CRITICAL!',
        bossWarn: '⚠ BOSS WAVE ⚠',
        rushWarn: '⚡ Enemies are rushing in! ⚡',
        heavyWarn: '🛡 Heavy enemies incoming! 🛡',
        swarmWarn: '🦠 A swarm of small enemies! 🦠',
        rotatePlease: 'Please rotate to landscape',
        langLabel: '한/EN',
    },
};
function txt() { return L[lang]; }

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
    canPlay(name, customCd) {
        if (!this.enabled || !this.ctx || soundMuted) return false;
        const cd = (customCd != null) ? customCd : this.cooldown;
        const now = this.ctx.currentTime;
        if (this.lastPlayed[name] && now - this.lastPlayed[name] < cd) return false;
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
    // 대역 통과 노이즈 — 더 자연스러운 효과음 합성용
    filteredNoise(dur, vol, filterType, freq, q) {
        const buf = this.ctx.createBuffer(1, this.ctx.sampleRate * dur, this.ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        const filter = this.ctx.createBiquadFilter();
        filter.type = filterType || 'bandpass';
        filter.frequency.value = freq || 1000;
        filter.Q.value = q || 1;
        const g = this.ctx.createGain();
        g.gain.value = vol || 0.15;
        src.connect(filter);
        filter.connect(g);
        g.connect(this.masterGain);
        const t = this.ctx.currentTime;
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        src.start(t);
        return { src, filter, g, t };
    }
    // 화살 — 작고 짧은 활시위 + 옅은 휘이익. 다른 발사음의 1/3 볼륨대
    arrowFire() {
        if (!this.canPlay('arrow')) return;
        const t = this.ctx.currentTime;
        // 활시위 - 짧고 옅은 트라이앵글 sweep
        const { o } = this.osc('triangle', 1100, 0.05, 0.035);
        o.frequency.exponentialRampToValueAtTime(420, t + 0.05);
        // 꼬리 휘이익 - 고대역 노이즈 매우 옅게
        this.filteredNoise(0.04, 0.025, 'highpass', 2200, 0.7);
    }
    // 대포 — 자극 완화 (게인/노이즈 추가 ↓, 펑 컷오프 낮춤)
    cannonFire() {
        if (!this.canPlay('cannon')) return;
        const t = this.ctx.currentTime;
        // 임팩트 - 저주파 sweep (vol 0.28 → 0.2)
        const { o: o1 } = this.osc('sine', 170, 0.2, 0.2);
        o1.frequency.exponentialRampToValueAtTime(40, t + 0.2);
        // 펑 - 노이즈 (vol 0.16 → 0.1, lowpass 1400 → 1000Hz로 더 둔하게)
        this.filteredNoise(0.07, 0.1, 'lowpass', 1000, 0.6);
        // 잔향 (게인 0.12 → 0.085)
        const o2 = this.ctx.createOscillator();
        const g2 = this.ctx.createGain();
        o2.type = 'sine';
        o2.frequency.value = 60;
        g2.gain.setValueAtTime(0.0001, t);
        g2.gain.linearRampToValueAtTime(0.085, t + 0.03);
        g2.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
        o2.connect(g2);
        g2.connect(this.masterGain);
        o2.start(t);
        o2.stop(t + 0.23);
    }
    // 얼음 — 거의 안 들리는 배경음 수준. 단일 sine, 노이즈 제거, vol 0.012
    iceFire() {
        if (!this.canPlay('ice', 0.1)) return;
        const t = this.ctx.currentTime;
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.type = 'sine';
        o.frequency.value = 1800;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.012, t + 0.004);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
        o.connect(g);
        g.connect(this.masterGain);
        o.start(t);
        o.stop(t + 0.12);
    }
    // 번개 — 저음 "찌리리" (triangle 320→200Hz로 한 옥타브 더 ↓, vibrato 폭/볼륨 완화).
    lightningFire() {
        if (!this.canPlay('lightning')) return;
        const t = this.ctx.currentTime;
        const dur = 0.18;

        // Carrier — triangle 200Hz (저음 베이스 영역)
        const carrier = this.ctx.createOscillator();
        carrier.type = 'triangle';
        carrier.frequency.value = 200;

        // Vibrato — 22Hz로 떨리되 폭 60→40으로 완화
        const modulator = this.ctx.createOscillator();
        modulator.type = 'sine';
        modulator.frequency.value = 22;
        const modGain = this.ctx.createGain();
        modGain.gain.value = 40;
        modulator.connect(modGain);
        modGain.connect(carrier.frequency);

        // gain envelope 두 펄스 (볼륨 0.05/0.04 → 0.038/0.03)
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.038, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.005, t + 0.075);
        g.gain.linearRampToValueAtTime(0.03, t + 0.09);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);

        carrier.connect(g);
        g.connect(this.masterGain);
        carrier.start(t);
        carrier.stop(t + dur + 0.02);
        modulator.start(t);
        modulator.stop(t + dur + 0.02);

        // 노이즈 더 옅게 (1500→1200Hz highpass, vol 0.014→0.01)
        this.filteredNoise(0.035, 0.01, 'highpass', 1200, 1.0);
    }
    // 독 — 보글보글: 저주파 다단 진동 + 미세 거품 노이즈
    poisonFire() {
        if (!this.canPlay('poison')) return;
        const t = this.ctx.currentTime;
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(180, t);
        o.frequency.linearRampToValueAtTime(290, t + 0.04);
        o.frequency.linearRampToValueAtTime(150, t + 0.09);
        o.frequency.linearRampToValueAtTime(245, t + 0.14);
        o.frequency.linearRampToValueAtTime(170, t + 0.19);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.13, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
        o.connect(g);
        g.connect(this.masterGain);
        o.start(t);
        o.stop(t + 0.24);
        // 미세 거품 - 저대역 노이즈 옅게
        this.filteredNoise(0.1, 0.045, 'lowpass', 600, 0.5);
    }
    // 적 사망 — 부드러운 lowpass puff만 (sine pop 제거 → "뿅" 톤 누적 방지).
    // cooldown 0.18s로 늘려 다수 사망 시에도 끊임없이 쌓이지 않게.
    enemyDeath() {
        if (!this.canPlay('edeath', 0.18)) return;
        this.filteredNoise(0.04, 0.018, 'lowpass', 600, 0.4);
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
    arrowCrit() {
        if (!this.canPlay('acrit')) return;
        const { o, g, t } = this.osc('square', 1200, 0.12, 0.15);
        o.frequency.exponentialRampToValueAtTime(600, t + 0.12);
        this.osc('sine', 1800, 0.08, 0.1);
    }
    lightningChain() {
        if (!this.canPlay('lchain')) return;
        this.noise(0.08, 0.08);
        const { o, g, t } = this.osc('sawtooth', 800, 0.12, 0.08);
        o.frequency.exponentialRampToValueAtTime(200, t + 0.12);
    }
    bossShield() {
        if (!this.canPlay('bshield')) return;
        this.osc('sine', 600, 0.2, 0.12);
        this.osc('sine', 900, 0.15, 0.08);
    }
    bossSummon() {
        if (!this.canPlay('bsummon')) return;
        const { o, g, t } = this.osc('sawtooth', 100, 0.3, 0.12);
        o.frequency.exponentialRampToValueAtTime(300, t + 0.3);
        this.noise(0.2, 0.06);
    }
    bossSpeedBurst() {
        if (!this.canPlay('bburst')) return;
        const { o, g, t } = this.osc('square', 300, 0.15, 0.1);
        o.frequency.exponentialRampToValueAtTime(900, t + 0.15);
    }
    uiClick() {
        if (!this.canPlay('uiclick')) return;
        this.osc('sine', 800, 0.03, 0.06);
    }
}
const soundManager = new SoundManager();

// ---- Path Definition ----
// Grid: 0 = grass, 1 = path, 2 = entry, 3 = exit
const grid = [];
for (let r = 0; r < ROWS; r++) {
    grid[r] = [];
    for (let c = 0; c < COLS; c++) {
        grid[r][c] = 0;
    }
}

// 3가지 맵 정의 (col, row 기준, COLS=20 / ROWS=14)
const MAPS = [
    // 0: 구불구불 S자 (기본) — 원본
    {
        name: 'S-Curve',
        waypoints: [
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
        ],
    },
    // 1: 지그재그 (좌우로 길게 왔다갔다)
    {
        name: 'Zigzag',
        waypoints: [
            { x: -1, y: 1 },
            { x: 18, y: 1 },
            { x: 18, y: 4 },
            { x: 2, y: 4 },
            { x: 2, y: 7 },
            { x: 18, y: 7 },
            { x: 18, y: 10 },
            { x: 2, y: 10 },
            { x: 2, y: 12 },
            { x: 20, y: 12 },
        ],
    },
    // 2: 미로 루프 (ㄷ자 경로 3개 연결 — 중앙 추가 꼬임으로 단조로움 해소)
    {
        name: 'Loop',
        waypoints: [
            { x: -1, y: 1 },
            { x: 6, y: 1 },
            { x: 6, y: 6 },
            { x: 1, y: 6 },
            { x: 1, y: 11 },
            { x: 7, y: 11 },
            { x: 7, y: 8 },   // ← 중앙 위쪽 작은 ㄷ자 시작
            { x: 10, y: 8 },
            { x: 10, y: 11 }, // ← 중앙 ㄷ자 끝
            { x: 13, y: 11 },
            { x: 13, y: 3 },
            { x: 18, y: 3 },
            { x: 18, y: 12 },
            { x: 20, y: 12 },
        ],
    },
];

let currentMapIndex = Math.floor(Math.random() * MAPS.length);
let waypoints = MAPS[currentMapIndex].waypoints;

function carvePath() {
    // 그리드 리셋
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) grid[r][c] = 0;
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
    if (waypoints[0].y >= 0 && waypoints[0].y < ROWS) {
        const ec = Math.max(0, waypoints[0].x);
        grid[waypoints[0].y][ec] = 2;
    }
}
carvePath();

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

// 맵 변경 (게임 리셋 시 호출)
function changeMap(idx) {
    currentMapIndex = (idx !== undefined) ? idx : Math.floor(Math.random() * MAPS.length);
    waypoints = MAPS[currentMapIndex].waypoints;
    carvePath();
    enemyPath = buildPathPixels();
    backgroundCache = null;  // 배경 재생성
    // 잔디/경로 디테일 재생성
    if (typeof generateGrassBlades === 'function') generateGrassBlades();
    if (typeof generatePathDetails === 'function') generatePathDetails();
}

// ---- Ambient Generation ----
function generateGrassBlades() {
    grassBlades = [];
    const count = isMobile ? 1 : 2;
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
    // 전투 중(적 많음)엔 스폰 중단 → 기존 파티클만 자연 감소
    const heavyCombat = enemies.length > 20;
    const spawnCap = heavyCombat ? 0 : 20;
    // Spawn
    if (ambientParticles.length < spawnCap && Math.random() < 0.3) {
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

// ============================================================
// ---- Pixel Art Sprite System ----
// 각 스프라이트는 문자열 배열로 정의. '.' = 투명, 나머지는 팔레트 키.
// createSprite()로 오프스크린 캔버스에 프리렌더 → drawSprite()로 확대 렌더.
// ============================================================
function createSprite(data, palette) {
    const h = data.length;
    const w = data[0].length;
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const octx = off.getContext('2d');
    octx.imageSmoothingEnabled = false;
    for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
            const ch = data[r][c];
            if (ch === '.' || ch === ' ') continue;
            const color = palette[ch];
            if (!color) continue;
            octx.fillStyle = color;
            octx.fillRect(c, r, 1, 1);
        }
    }
    return off;
}

function drawSprite(sprite, cx, cy, pxSize, rotation) {
    const w = sprite.width;
    const h = sprite.height;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.translate(Math.round(cx), Math.round(cy));
    if (rotation) ctx.rotate(rotation);
    ctx.drawImage(sprite, -Math.round(w * pxSize / 2), -Math.round(h * pxSize / 2),
                  Math.round(w * pxSize), Math.round(h * pxSize));
    ctx.restore();
}

// ============================================================
// ---- Background Cache (그리드 배경 한 번만 렌더링 후 재사용) ----
// ============================================================
function generateBackgroundCache() {
    const off = document.createElement('canvas');
    off.width = Math.round(W * DPR);
    off.height = Math.round(ROWS * TILE * DPR);
    const octx = off.getContext('2d');
    octx.scale(DPR, DPR);
    octx.imageSmoothingEnabled = true;

    // 잔디 베이스 (수직 그라디언트)
    const grassGrad = octx.createLinearGradient(0, 0, 0, ROWS * TILE);
    grassGrad.addColorStop(0, '#4a8a3c');
    grassGrad.addColorStop(0.5, '#3d7a36');
    grassGrad.addColorStop(1, '#2f6030');
    octx.fillStyle = grassGrad;
    octx.fillRect(0, 0, W, ROWS * TILE);

    // 잔디 질감 — 부드러운 스팟 (큰 원 몇 개)
    octx.globalAlpha = 0.1;
    octx.fillStyle = '#5a9a48';
    for (let i = 0; i < 30; i++) {
        const x = (i * 137.5) % W;
        const y = (i * 89.3) % (ROWS * TILE);
        const r = 12 + ((i * 17) % 20);
        octx.beginPath();
        octx.arc(x, y, r, 0, Math.PI * 2);
        octx.fill();
    }
    octx.fillStyle = '#2a5a28';
    for (let i = 0; i < 25; i++) {
        const x = (i * 193.7) % W;
        const y = (i * 113.1) % (ROWS * TILE);
        const r = 8 + ((i * 13) % 15);
        octx.beginPath();
        octx.arc(x, y, r, 0, Math.PI * 2);
        octx.fill();
    }
    octx.globalAlpha = 1;

    // 경로: waypoints 따라 두꺼운 stroke 라인으로 그려서 자연스러운 둥근 모서리.
    // 4겹: (1) 어두운 그림자 외곽 → (2) 진한 흙 띠 → (3) 메인 흙 → (4) 가운데 밝은 하이라이트
    function strokeWaypoints(width, color, alpha) {
        octx.globalAlpha = alpha == null ? 1 : alpha;
        octx.strokeStyle = color;
        octx.lineWidth = width;
        octx.lineCap = 'round';
        octx.lineJoin = 'round';
        octx.beginPath();
        for (let i = 0; i < waypoints.length; i++) {
            const wp = waypoints[i];
            const px = wp.x * TILE + TILE / 2;
            const py = wp.y * TILE + TILE / 2;
            if (i === 0) octx.moveTo(px, py);
            else octx.lineTo(px, py);
        }
        octx.stroke();
        octx.globalAlpha = 1;
    }
    // (1) 어두운 외곽 띠 (전체 윤곽 그림자)
    strokeWaypoints(TILE * 1.06, '#2c1d0c', 0.85);
    // (2) 진한 흙 가장자리 (외곽 약간 안쪽 — 깊이감)
    strokeWaypoints(TILE * 0.98, '#5a3d1c');
    // (3) 메인 흙 색
    strokeWaypoints(TILE * 0.86, '#8d6a3c');
    // (4) 가운데 밝은 하이라이트 (좁은 띠, 살짝 투명)
    strokeWaypoints(TILE * 0.42, '#a98558', 0.55);
    // (5) 중앙 미세 광택 — 진행 방향감
    strokeWaypoints(TILE * 0.18, '#c19868', 0.35);

    // 부드러운 진한 흙 얼룩 (경로 위 랜덤 점들 — grid path 셀 안에서만)
    octx.globalAlpha = 0.22;
    const muddyColors = ['#4a3018', '#6a4828', '#3d2410'];
    for (let i = 0; i < 60; i++) {
        const c = Math.floor((i * 17) % COLS);
        const r = Math.floor((i * 29) % ROWS);
        if (grid[r][c] === 0) continue;
        const x = c * TILE + ((i * 7) % TILE);
        const y = r * TILE + ((i * 11) % TILE);
        const rs = 2 + ((i * 3) % 5);
        octx.fillStyle = muddyColors[i % muddyColors.length];
        octx.beginPath();
        octx.arc(x, y, rs, 0, Math.PI * 2);
        octx.fill();
    }
    octx.globalAlpha = 1;

    // 경로 디테일 (조약돌/균열) — 정적이므로 배경 캐시에 포함
    if (typeof pathDetails !== 'undefined') {
        for (const pd of pathDetails) {
            octx.fillStyle = pd.color;
            if (pd.type === 'pebble') {
                octx.beginPath();
                octx.arc(pd.x, pd.y, pd.size, 0, Math.PI * 2);
                octx.fill();
            } else {
                octx.save();
                octx.translate(pd.x, pd.y);
                octx.rotate(pd.angle);
                octx.fillRect(-pd.size * 2, -0.5, pd.size * 4, 1);
                octx.restore();
            }
        }
    }

    return off;
}

// ---- Sprite Definitions ----
const SPRITES = {};

// === Enemy: Normal (고블린, 24×24) ===
// 팔레트: H=하이라이트, O=주황밝, o=주황중, d=주황어둠, D=외곽선, K=검정, W=이빨, E=눈흰자, P=동공, R=볼터치
SPRITES.enemyNormal = createSprite([
    '........................',
    '........................',
    '.....D............D.....',  // 뿔 끝
    '....DKD..........DKD....',
    '....DdD..........DdD....',
    '...DdoD..........DodD...',
    '...DdooDDDDDDDDDDooDD...',  // 뿔 밑동 + 두상 윤곽
    '..DdoOOOOOOOOOOOOOOoDD..',
    '..DoOOHHOOOOOOOOHHOOoD..',  // 두상 하이라이트 좌우
    '.DdOOOOOOOOOOOOOOOOOOdD.',
    '.DdOOKKKOOOOOOOKKKOOOdD.',  // 눈 구멍
    '.DoOOKEPKOOOOOOKEPKOOOD.',  // 눈 (흰자 E, 동공 P)
    '.DoOOKEEKOOOOOOKEEKOOOD.',
    '.DoOOKKKOOOOOOOKKKOOOoD.',
    '.DoOORRROOOOOOOORRROOoD.',  // 볼터치
    '.DdoOOOOOODDDDDOOOOOoOD.',
    '..DdooOOODWWWKWDOOOooD..',  // 입 윗부분
    '..DdoooDKWWKWWWKDooodD..',  // 이빨
    '..DDdoooDKWWWWWKDoodDD..',
    '...DDdoooDDDDDDDDoodD...',
    '....DDddooooooooooodD...',  // 턱
    '.....DDdddooooooodddD...',
    '.......DDDdddddDDDD.....',  // 바닥
    '........................',
], {
    O: '#ff9d54', o: '#e67a30', d: '#a84814', D: '#3a1a08',
    H: '#ffc088', K: '#140804', W: '#fff0d0', E: '#ffffff', P: '#c01818', R: '#ff6040'
});

// === Enemy: Fast (박쥐/임프, 24×24) ===
// 가로로 긴 실루엣 + 날개. G=초록밝, g=초록중, d=초록어둠, D=외곽선, K=검정, H=하이라이트, E=눈, Y=노란눈, W=송곳니
SPRITES.enemyFast = createSprite([
    '........................',
    '........................',
    '....D..............D....',  // 귀 끝
    '....D.DD........DD.D....',
    'D...DD.DD......DD.DD...D',
    'DD...DgD.DDDDDD.DgD...DD',  // 귀 안쪽
    'DDD..DggDDGGGGDDggD..DDD',
    '.DDDDDggGGGGGGGGggDDDDD.',  // 날개 상단
    '..DDDggGGHHGGGHHGGggDD..',  // 날개 밝은 부분
    '..DggGGGHHGGGGGHHGGgD...',
    '.DgGGGKKKGGGGGGKKKGGgD..',  // 눈 구멍
    'DgGGGKEYEKGGGGKEYEKGGGgD',  // 노란 눈
    'DgGGGKEYEKGGGGKEYEKGGGgD',
    'DgGGGKKKKGGGGGGKKKKGGgD.',
    '.DgGGGGGGGWKKKWGGGGGGgD.',  // 입 시작
    '..DgGGGGGDKWWWKDGGGGgD..',
    '..DDGGGGGGDKWKDGGGGGGDD.',  // 송곳니
    '...DDggGGGGDDDGGGGggDD..',
    '.....DDggGGGGGGGggDD....',
    '......DDDggGGGggDDD.....',
    '.........DDggggDD.......',
    '...........DggD.........',  // 꼬리
    '............DD..........',
    '........................',
], {
    G: '#6bd84a', g: '#3a9028', d: '#1a4a12', D: '#0a2008',
    H: '#9cf07a', K: '#000000', W: '#fff0d0', E: '#000000', Y: '#ffd820'
});

// === Enemy: Tank (중장갑 오크, 28×28) ===
// P=피부밝, p=피부중, d=피부어둠, D=외곽선, M=금속밝, m=금속중, k=금속어둠, K=검정, W=이빨, E=눈, Y=노란눈
SPRITES.enemyTank = createSprite([
    '............................',
    '............................',
    '.......D..............D.....',  // 어깨 뿔 끝
    '......DKD............DKD....',
    '......DMD............DMD....',
    '.....DMmD............DmMD...',  // 뿔 밑동
    '.....DMmDDDDDDDDDDDDDmMD....',
    '....DMmmmPPPPPPPPPPmmmMD....',  // 머리/헬름 상단
    '....DMmmPPpppppppppPmmMD....',
    '...DMmmppDDKKKKDKKKDDppmMD..',  // 눈구멍 바이저
    '...DMmmpPDKEYEKDKEYEKDPpmMD.',  // 노란 눈
    '...DMmmpPDKKKKDKKKKKKDPpmMD.',
    '...DMmmpPPPPPPPPPPPPPPPpmMD.',
    '....DmmpppDWDDDDDWDDDpppmD..',  // 입 윤곽
    '.....DmppppKWWKKWWWKppppD...',  // 이빨
    '......DppppDKWWKWKDppppD....',
    '.....DDMMDDDDDDDDDDDMMDD....',  // 어깨 경계
    '....DMmmDDmmmmmmmmmDDmmMD...',  // 어깨 갑옷
    '...DMmmDDmMMMMMMMMMmDDmmMD..',
    '..DMmmDDMMkkkkkkkkkMMDDmmMD.',  // 가슴판
    '..DMmmDMMkKKKKKKKKKkMMDmmMD.',  // 벨트 K
    '..DMmmDMMkkkkkkkkkkkMMDmmMD.',
    '..DMmmDMMpppppppppppMMDmmMD.',
    '...DMmDDDDpPPPPPPPPpDDDDmMD.',  // 허리
    '....DmmmDDpPPPPPPPPpDDmmmD..',  // 다리 분리
    '....DDMmmDmmmmmmmmmmDmmMDD..',
    '.....DDMMDDDDDDDDDDDDMMDD...',  // 발
    '......DDDD......DDDDDDD.....',
], {
    P: '#bc80e8', p: '#8248c0', d: '#4a208a', D: '#1a0828',
    M: '#a0a0b8', m: '#606080', k: '#303048', K: '#000000',
    W: '#fff0d0', E: '#ffffff', Y: '#ffd820'
});

// === Enemy: Boss (악마 왕, 40×40) ===
SPRITES.enemyBoss = createSprite([
    '........................................',
    '........................................',
    '........D....................D..........',  // 뿔 끝
    '.......DKD..................DKD.........',
    '.......DRD..................DRD.........',
    '......DRRD..................DRRD........',
    '......DRrD..................DrRD........',
    '.....DRrrD..................DrrRD.......',
    '....DRrrrD..................DrrrRD......',
    '...DRrrrrDDDDDDDDDDDDDDDDDDDDrrrrRD.....',  // 뿔 밑동 + 왕관 윤곽
    '...DRrrrDGGGGGGGGGGGGGGGGGGGGGDrrrRD....',  // 왕관 상단
    '...DRrrDGGgYgYgYgYgYgYgYgYgYgGGDrrRD....',  // 보석들
    '....DRrDGggggggggggggggggggggggDDrRD....',
    '.....DRDGgggGgGgGgGgGgGgGgGgGgggDRD.....',
    '.....DRDDDDDDDDDDDDDDDDDDDDDDDDDDRD.....',  // 왕관 하단
    '....DRRDrrRRRRRRRRRRRRRRRRRRRRrrRRRD....',
    '...DRRRrrRRRRRRRRRRRRRRRRRRRRRRrrRRD....',  // 머리 상단
    '..DRRRrRRRRRRRRRRRRRRRRRRRRRRRRRrRRD....',
    '..DRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRD....',
    '..DRRRRRRRKKKKKKKRRRRRKKKKKKKRRRRRRD....',  // 눈구멍 상단
    '..DRRRRRKKEEEEEKKRRRRRKKEEEEEKKRRRRD....',  // 눈 (빨간빛)
    '..DRRRRKKYEEEEYKKRRRRRKKYEEEEYKKRRRD....',
    '..DRRRRKKYEEEEYKKRRRRRKKYEEEEYKKRRRD....',
    '..DRRRRRKKEEEEEKKRRRRRKKEEEEEKKRRRRD....',
    '..DRRRRRRKKKKKKKRRRRRRKKKKKKKRRRRRRD....',  // 눈 하단
    '...DRRRRRrrrrrrrRRKRRRrrrrrrrRRRRRRD....',  // 코
    '...DRRRRRrrrrrrrRKKKRrrrrrrrrRRRRRRD....',
    '....DRRRRrrrrrDKKKKKKKDrrrrrrRRRRRD.....',  // 입 상단
    '.....DRRRrrrDKKWWKWWKWKKDrrrrRRRRD......',  // 이빨
    '......DRRrrDKWWKWWKWKWWKDrrrrRRD........',
    '.......DRrrDKWKWKWKWKWKKDrrrrRD.........',
    '........DRrDDKKKKKKKKKKDDrrrRD..........',  // 턱
    '.........DRrrDDDDDDDDDDDrrrRD...........',
    '..........DRrrrrrrrrrrrrrRRD............',
    '...........DDRRRRRRRRRRRRDD.............',
    '............DDRRRRRRRRRDD...............',  // 아래 턱
    '..............DDDDDDDDD.................',
    '...............D......D.................',
    '........................................',
    '........................................',
], {
    R: '#e84040', r: '#a82020', d: '#6a1010', D: '#1a0404',
    K: '#080000', G: '#ffe050', g: '#b89020', Y: '#ffcc20',
    E: '#ff3030', W: '#fff0d0'
});

// 피격 플래시용 흰색 실루엣 (source-in 합성으로 스프라이트 알파 유지)
function createWhiteSilhouette(sprite) {
    const off = document.createElement('canvas');
    off.width = sprite.width;
    off.height = sprite.height;
    const octx = off.getContext('2d');
    octx.imageSmoothingEnabled = false;
    octx.drawImage(sprite, 0, 0);
    octx.globalCompositeOperation = 'source-in';
    octx.fillStyle = '#ffffff';
    octx.fillRect(0, 0, sprite.width, sprite.height);
    return off;
}
SPRITES.enemyNormalWhite = createWhiteSilhouette(SPRITES.enemyNormal);
SPRITES.enemyFastWhite = createWhiteSilhouette(SPRITES.enemyFast);
SPRITES.enemyTankWhite = createWhiteSilhouette(SPRITES.enemyTank);
SPRITES.enemyBossWhite = createWhiteSilhouette(SPRITES.enemyBoss);

// ============================================================
// ---- Tower Sprite Definitions ----
// 타워는 base(고정) + turret(회전) 분리
// ============================================================

// === Tower: Arrow (나무 탑 + 회전 활) 16×16 ===
// W=나무밝, w=나무중, d=나무어둠, D=외곽선, S=돌밝, s=돌어둠, K=검정, H=하이라이트
SPRITES.towerArrowBase = createSprite([
    '................',
    '......DDDD......',
    '.....DsSSsD.....',  // 지붕 꼭대기
    '....DsSSSSsD....',
    '...DsSSSSSSsD...',
    '..DsSSsSSsSSsD..',
    '..DDDDDDDDDDDD..',  // 지붕 경계
    '..DWwwwwwwwwWD..',  // 나무 몸체 상단
    '..DWwHwwwwwHwWD.',
    '..DWwwwKKwwwwWD.',  // 창문
    '..DWwwwKKwwwwWD.',
    '..DWwHwwwwwHwWD.',
    '..DWwwwwwwwwWD..',
    '..DdddddddddDd..',
    '..DSssSssSssSD..',  // 돌 기단
    '..DDDDDDDDDDDD..',
], {
    W: '#d9985c', w: '#a87238', d: '#5a3812', D: '#2a1a04',
    S: '#a0a0a0', s: '#6a6a6a', K: '#1a0a00', H: '#ffc080'
});

SPRITES.towerArrowTurret = createSprite([
    '..W..',
    '.WwW.',  // 활 상단
    'WwwW.',
    'W.aw.',  // 화살대
    'W.aH.',  // 하이라이트
    'W.a..',
    'W.a..',
    'W.aw.',
    'WwwW.',
    '.WwW.',
    '..W..',
], { W: '#5a3812', w: '#8a5828', a: '#d9985c', H: '#ffc080' });

// === Tower: Cannon (돌 요새 + 회전 포신) 16×16 ===
SPRITES.towerCannonBase = createSprite([
    '................',
    '..DDDDDDDDDDDD..',
    '..DKKKKKKKKKKD..',  // 총안 라인
    '..DSsSsSsSsSsD..',  // 흉벽
    '..DSSHSSSSHSSD..',  // 하이라이트
    '..DSsSsKKSsSsD..',  // 중앙 창
    '..DSSSSKKSSSSD..',
    '..DSsSsSsSsSsD..',
    '..DSSHSSSSHSSD..',
    '..DSsSsSsSsSsD..',
    '..DSSSSSSSSSSD..',
    '..DsssssssssD...',  // 경계
    '..DkkkkkkkkkD...',  // 어두운 베이스
    '..DkKKKKKKKkD...',
    '..DkkkkkkkkkD...',
    '..DDDDDDDDDDD...',
], {
    S: '#b8b8c8', s: '#707080', k: '#404050', K: '#1a1a28',
    D: '#0a0a14', H: '#e0e0f0'
});

SPRITES.towerCannonTurret = createSprite([
    '.DDDDD.',
    'DkkkkkD',
    'DkIIIkD',  // 포신 상단
    'DkIHIkD',
    'DkIIIkD',
    'DkIIIkD',
    'DkIIIkD',
    'DkkkkkD',
    '.DDDDD.',
], { D: '#0a0a14', k: '#303040', I: '#5a5a70', H: '#8a8aa0' });

// === Tower: Ice (얼음 오벨리스크) 16×16 ===
SPRITES.towerIceBase = createSprite([
    '................',
    '.......DD.......',
    '......DCCD......',  // 크리스털 꼭대기
    '.....DCHHCD.....',
    '....DCcHHcCD....',
    '...DCcccccCD....',
    '...DCccccccCD...',
    '...DdcccccccD...',  // 크리스털 바닥
    '...DdDDDDDDDD...',
    '..DSssssssSSD...',  // 얼음 기단 상단
    '..DSsHHHHHHsD...',
    '..DSssssssssD...',
    '..DSssssssSSD...',
    '..DdssssssSDd...',
    '..DDkkkkkkDDd...',
    '..DDDDDDDDDD....',
], {
    C: '#b0ecff', c: '#60b0dc', d: '#2a5070', D: '#0a1a2a',
    S: '#a0c8e0', s: '#5080a0', k: '#304858', H: '#ffffff'
});

SPRITES.towerIceTurret = createSprite([
    '.DWD.',
    'DCHCD',  // 회전 결정
    'WCHCW',
    'DCHCD',
    '.DWD.',
], { W: '#d0e8ff', C: '#60b0dc', D: '#0a2a4a', H: '#ffffff' });

// === Tower: Lightning (테슬라 코일) 16×16 ===
SPRITES.towerLightningBase = createSprite([
    '................',
    '.....DMMMMD.....',  // 코일 꼭대기
    '....DMkkkkMD....',
    '...DMKKKKKKMD...',
    '..DMyyYYYYyyMD..',  // 전도체 상단
    '..DMYYYHYYYYMD..',  // 하이라이트
    '..DMyyyyyyyyMD..',
    '..DMYYYYYYHYMD..',
    '..DMyyYYYYyyMD..',
    '..DMKKKKKKKKMD..',
    '..DMkkkkkkkkMD..',
    '..DMkkKKKKkkMD..',
    '...DDdddddddDD..',
    '...DddddddddD...',
    '...DDDDDDDDDD...',
    '................',
], {
    Y: '#ffee55', y: '#c09020', d: '#3a2a08', D: '#0a0a14',
    M: '#b0b0c0', K: '#202020', k: '#4a4a58', H: '#ffffff'
});

SPRITES.towerLightningTurret = createSprite([
    '.Y.',
    'YHY',  // 중앙 하이라이트
    '.Y.',
], { Y: '#ffee55', H: '#ffffff' });

// === Tower: Poison (가마솥) 16×16 ===
SPRITES.towerPoisonBase = createSprite([
    '................',
    '...DDDDDDDDDD...',  // 가마솥 테두리
    '..DkkkkkkkkkkD..',
    '.DkggggggggggkD.',  // 내벽
    '.DkgGGGGGGGGgkD.',  // 독액 표면
    '.DkGGGBgggGGGkD.',  // 거품
    '.DkGggggBgGGgkD.',
    '.DkgGGGGGGGgkkD.',
    '.DkkggggggggkkD.',
    '..DkkKKKKKKkkD..',  // 아래쪽
    '..DkkkkkkkkkkD..',
    '...DDDDDDDDDD...',
    '....DK....KD....',  // 다리 시작
    '....DkD..DkD....',
    '....DMD..DMD....',  // 다리
    '....DDD..DDD....',
], {
    G: '#6fff4a', g: '#2fa028', B: '#c0ff98', K: '#0a2a0a',
    M: '#3a3a3a', k: '#2a2a2a', D: '#050a05'
});

// Poison은 회전 없음

// === Tile Sprites (잔디/경로 패턴용) ===
// g=잔디밝, G=잔디중, k=잔디어둠, f=꽃, b=풀잎
SPRITES.tileGrass = createSprite([
    'gGgGgGgGgGgGgGgG',
    'GgGgGbGgGgGgGgGg',
    'gGgGgGgGgGgfGgGg',
    'GgGbGgGgGgGgGgGg',
    'gGgGgGgGgkGgGgGg',
    'GgGgGgGbGgGgGgGg',
    'gGgGfGgGgGgGgbGg',
    'GgGgGgGgGgGgGgGg',
    'gGgGgGgGgGgGgGgG',
    'GgGgGgGgGgbGgGgg',
    'gGgGgGgfGgGgGgGg',
    'GgGgGbGgGgGgGgGg',
    'gGgGgGgGgkGgfGgG',
    'GgGbGgGgGgGgGgGg',
    'gGgGgGgGgGgGgGgg',
    'GgGgGgGgGgGgGgGg',
], { g: '#3a7a38', G: '#326a32', k: '#224a22', b: '#5a9a48', f: '#f8d048' });

SPRITES.tilePath = createSprite([
    'sSsSsSsSsSsSsSsS',
    'SsSsSsSsSsSsSsSs',
    'sSsSsPsSsSsSsSsS',  // P=자갈
    'SsSsSsSsSsSsSPSs',
    'sSsSsSsSsSsSsSsS',
    'SsSpSsSsSsSsSsSs',
    'sSsSsSsSsSsSsSsS',
    'SsSsSsSsSsSsSsSs',
    'sSsSsSsSsPsSsSsS',
    'SsSsSsSsSsSsSsSs',
    'sSsSsSsSsSsSsSsS',
    'SsSsSpSsSsSsSsSs',
    'sSsSsSsSsSsSPsSS',
    'SsSsSsSsSsSsSsSs',
    'sSsSsSsSsSsSsSsS',
    'SsSsSsSsSsSsSsSs',
], { S: '#a08858', s: '#806838', P: '#584828', p: '#302818' });

// ---- Tower Types ----
const TOWER_TYPES = [
    {
        nameKey: 0,
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
        critChance: 0.2,
        critMult: 2.5,
        icon: 'arrow',
    },
    {
        nameKey: 1,
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
        icon: 'cannon',
    },
    {
        nameKey: 2,
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
        chain: 3,
        chainRange: 2.5,
        chainDecay: 0.7,
        icon: 'lightning',
    },
    {
        nameKey: 3,
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
        icon: 'ice',
    },
    {
        nameKey: 4,
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
    get upgradeCost() { return Math.floor(this.type.cost * 0.7 * Math.pow(1.5, this.level - 1)); }
    get sellValue() {
        let total = this.type.cost;
        for (let i = 1; i < this.level; i++) total += Math.floor(this.type.cost * 0.7 * Math.pow(1.5, i - 1));
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
        // 각 적마다 다른 위상 — 출렁임/꼬리 흔들림 등 애니메이션 비동기화
        this.animPhase = Math.random() * Math.PI * 2;
        // Boss abilities
        this.shield = 0;
        this.maxShield = 0;
        this.shieldCooldown = 0;
        this.summonCooldown = 0;
        this.speedBurstTimer = 0;
        this.speedBurstCooldown = 0;
        this.speedBurstActive = false;
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
        // Arrow crit
        this.isCrit = tower.typeIndex === 0 && Math.random() < (tower.type.critChance || 0);
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
    constructor(x, y, text, color, style) {
        this.x = x;
        this.y = y;
        this.text = text;
        this.color = color;
        this.style = style || 'normal'; // 'normal' | 'crit' | 'dmg'
        if (this.style === 'crit') {
            this.life = 1.4; this.vy = -1.1;
        } else if (this.style === 'dmg') {
            this.life = 0.6; this.vy = -1.3;
        } else {
            this.life = 1.0; this.vy = -1.5;
        }
        this.maxLife = this.life;
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
// 난이도 곡선: 초반은 완만, 6웨이브부터 지수 가속
function getWaveEnemies(waveNum) {
    const enemies = [];
    const baseHp = 30 + waveNum * 18 + Math.pow(waveNum, 1.78) * 6.5;
    // 적 수 증가 (지루하지 않게)
    const count = 7 + Math.floor(waveNum * 2.2) + Math.floor(waveNum / 6) * 4;
    const speed = 1.0 + waveNum * 0.04 + Math.floor(waveNum / 10) * 0.06;
    const goldBase = 5 + Math.floor(waveNum * 0.55);

    const isBossWave = (waveNum % 5 === 0 && waveNum > 0);
    const isRushWave = !isBossWave && waveNum >= 7 && waveNum % 3 === 1;
    const isHeavyWave = !isBossWave && waveNum >= 9 && waveNum % 3 === 0;
    const isSwarmWave = !isBossWave && !isRushWave && !isHeavyWave && waveNum >= 4 && waveNum % 3 === 2; // 5(보스X),8,11,14...

    if (isRushWave) {
        // 러시 — Fast 대량 + 스와름 섞음
        const rushCount = count + Math.floor(waveNum * 0.5);
        for (let i = 0; i < rushCount; i++) {
            enemies.push({
                hp: Math.floor(baseHp * 0.45),
                speed: speed * 1.65,
                gold: goldBase + 1,
                type: 'fast',
                fastArmor: waveNum >= 18 ? 1 : 0,
            });
        }
        // 스와름 떼 섞음 (12~20마리)
        const swarmCount = 12 + Math.floor(waveNum * 0.5);
        for (let i = 0; i < swarmCount; i++) {
            enemies.push({
                hp: Math.max(8, Math.floor(baseHp * 0.18)),
                speed: speed * 1.4,
                gold: 2,
                type: 'swarm',
            });
        }
        const tankCount = Math.max(1, Math.floor(waveNum * 0.2));
        for (let i = 0; i < tankCount; i++) {
            enemies.push({
                hp: Math.floor(baseHp * 2.0),
                speed: speed * 0.6,
                gold: goldBase + 4,
                type: 'tank'
            });
        }
    } else if (isHeavyWave) {
        // 헤비 — 탱크 중심 + 약간의 일반
        const normalCount = Math.floor(count * 0.5);
        for (let i = 0; i < normalCount; i++) {
            enemies.push({
                hp: Math.floor(baseHp * (0.9 + Math.random() * 0.3)),
                speed: speed * (0.9 + Math.random() * 0.2),
                gold: goldBase + Math.floor(Math.random() * 3),
                type: 'normal'
            });
        }
        const tankCount = Math.floor(waveNum * 0.5);
        for (let i = 0; i < tankCount; i++) {
            enemies.push({
                hp: Math.floor(baseHp * 2.5),
                speed: speed * 0.55,
                gold: goldBase + 6,
                type: 'tank'
            });
        }
    } else if (isSwarmWave) {
        // 스와름 웨이브 — 작은 세균 대량
        const swarmCount = 25 + Math.floor(waveNum * 1.2);
        for (let i = 0; i < swarmCount; i++) {
            enemies.push({
                hp: Math.max(8, Math.floor(baseHp * 0.18)),
                speed: speed * (1.3 + Math.random() * 0.3),
                gold: 2,
                type: 'swarm',
            });
        }
        // 일반 몇마리 섞음
        const normalCount = Math.floor(count * 0.4);
        for (let i = 0; i < normalCount; i++) {
            enemies.push({
                hp: Math.floor(baseHp * (0.8 + Math.random() * 0.4)),
                speed: speed * (0.9 + Math.random() * 0.2),
                gold: goldBase + Math.floor(Math.random() * 2),
                type: 'normal'
            });
        }
    } else {
        // 일반 웨이브
        for (let i = 0; i < count; i++) {
            enemies.push({
                hp: Math.floor(baseHp * (0.8 + Math.random() * 0.4)),
                speed: speed * (0.9 + Math.random() * 0.2),
                gold: goldBase + Math.floor(Math.random() * 3),
                type: 'normal'
            });
        }
        // 스와름 소량 항상 섞음 (지루하지 않게) — 웨이브 3부터
        if (waveNum >= 3) {
            const swarmCount = 4 + Math.floor(waveNum * 0.5);
            for (let i = 0; i < swarmCount; i++) {
                enemies.push({
                    hp: Math.max(8, Math.floor(baseHp * 0.18)),
                    speed: speed * 1.35,
                    gold: 2,
                    type: 'swarm',
                });
            }
        }
        if (waveNum >= 2) {
            const fastCount = Math.floor(waveNum * 0.7);
            for (let i = 0; i < fastCount; i++) {
                enemies.push({
                    hp: Math.floor(baseHp * 0.5),
                    speed: speed * 1.6,
                    gold: goldBase + 2,
                    type: 'fast',
                    fastArmor: waveNum >= 18 ? 2 : waveNum >= 10 ? 1 : 0,
                });
            }
        }
        if (waveNum >= 4) {
            const tankCount = Math.max(1, Math.floor(waveNum * 0.4));
            for (let i = 0; i < tankCount; i++) {
                enemies.push({
                    hp: Math.floor(baseHp * 2.5),
                    speed: speed * 0.6,
                    gold: goldBase + 5,
                    type: 'tank'
                });
            }
        }
        // Phase 2 신규 적 (일반 웨이브에 자연스럽게 섞임)
        if (waveNum >= 5) {
            const bearCount = Math.max(1, Math.floor(waveNum * 0.25));
            for (let i = 0; i < bearCount; i++) {
                enemies.push({
                    hp: Math.floor(baseHp * 1.4),
                    speed: speed * 0.85,
                    gold: goldBase + 3,
                    type: 'bear'
                });
            }
        }
        if (waveNum >= 6) {
            const spiderCount = 1 + Math.floor(waveNum / 6);
            for (let i = 0; i < spiderCount; i++) {
                enemies.push({
                    hp: Math.floor(baseHp * 0.7),
                    speed: speed * 1.0,
                    gold: goldBase + 2,
                    type: 'spider'
                });
            }
        }
        if (waveNum >= 7) {
            const bomberCount = 1 + Math.floor(waveNum / 7);
            for (let i = 0; i < bomberCount; i++) {
                enemies.push({
                    hp: Math.floor(baseHp * 0.6),
                    speed: speed * 0.95,
                    gold: goldBase + 4,
                    type: 'bomber'
                });
            }
        }
        if (waveNum >= 8) {
            const healerCount = 1 + Math.floor(waveNum / 9);
            for (let i = 0; i < healerCount; i++) {
                enemies.push({
                    hp: Math.floor(baseHp * 1.0),
                    speed: speed * 0.8,
                    gold: goldBase + 5,
                    type: 'healer'
                });
            }
        }
    }

    // Boss every 5 waves (완화 2차)
    if (isBossWave) {
        const bossLevel = Math.floor(waveNum / 5);
        const bossHpMult = 4.8 + bossLevel * 1.4;
        enemies.push({
            hp: Math.floor(baseHp * bossHpMult),
            speed: speed * 0.42,
            gold: goldBase * 5 + bossLevel * 10,
            type: 'boss',
            bossLevel: bossLevel,
        });
        const minionCount = Math.min(bossLevel * 2, 6);
        for (let i = 0; i < minionCount; i++) {
            enemies.push({
                hp: Math.floor(baseHp * 1.3),
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
    if (gameOver || adInProgress) return;
    // Poki: 첫 웨이브 또는 재개 시 gameplayStart
    pokiGameplayStart();
    wave++;
    bossWave = (wave % 5 === 0);
    // 웨이브 타입 결정 (getWaveEnemies와 동일 규칙)
    if (bossWave) waveType = 'boss';
    else if (wave >= 7 && wave % 3 === 1) waveType = 'rush';
    else if (wave >= 9 && wave % 3 === 0) waveType = 'heavy';
    else if (wave >= 4 && wave % 3 === 2) waveType = 'swarm';
    else waveType = 'normal';

    if (bossWave) {
        bossWarningTimer = 2.5;
        soundManager.bossWarning();
    } else if (waveType === 'rush' || waveType === 'heavy' || waveType === 'swarm') {
        bossWarningTimer = 1.8;
        soundManager.waveStart();
    } else {
        soundManager.waveStart();
    }
    waveTransitionTimer = 1.5;
    waveTransitionNum = wave;
    waveActive = true;
    betweenWaves = false;
    enemySpawnQueue = getWaveEnemies(wave);
    waveTotalEnemies = enemySpawnQueue.length;
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

// ---- Distance helpers ----
function dist(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
}
function distSq(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return dx * dx + dy * dy;
}

// ---- Spawn particles on enemy death ----
function spawnDeathParticles(enemy) {
    // Phase 2: 자폭병 사망 시 추가 폭발 효과 + 라이프 -1
    if (enemy.type === 'bomber') {
        // 큰 폭발 파티클 (오렌지/노랑)
        for (let i = 0; i < 30; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 2 + Math.random() * 5;
            const c = ['#ff4020', '#ff8020', '#ffcc20', '#ffffff'][Math.floor(Math.random() * 4)];
            particles.push(new Particle(enemy.x, enemy.y, c,
                Math.cos(angle) * speed, Math.sin(angle) * speed,
                0.5 + Math.random() * 0.5, 3 + Math.random() * 5));
        }
        // 큰 충격파
        if (shockwaves.length < 12) {
            shockwaves.push(new ShockwaveRing(enemy.x, enemy.y, TILE * 2.2, '#ff6020', 0.5));
        }
        // 라이프 -1 (0 이하로 안 가게, 게임오버 트리거 안 함)
        if (lives > 1) {
            lives -= 1;
            livesFlashTimer = 0.5;
            screenShakeIntensity = 8;
            screenShakeTimer = 0.3;
            floatingTexts.push(new FloatingText(enemy.x, enemy.y - 25, '💥 -1 HP', '#ff4040', 'crit'));
        }
    }
    const colors = {
        normal: ['#88ff88', '#44dd44', '#ccffcc'],  // 슬라임 녹색
        swarm: ['#aa9988', '#8a7060', '#ccbbaa'],   // 쥐 회색
        fast: ['#aaaaaa', '#888888', '#cccccc'],    // 늑대 회색
        tank: ['#888888', '#666666', '#aaaaaa'],    // 모아이 돌
        boss: ['#ff4444', '#ff8800', '#ffcc00', '#ffffff'],
        spider: ['#1a1a1a', '#cc1010', '#444444'],
        bear: ['#7a5430', '#a07848', '#3a2818'],
        bomber: ['#ff4020', '#ffcc20', '#ffffff'],
        healer: ['#aaffaa', '#cc88ff', '#7a5898'],
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

// ---- Damage helper (shield absorption) ----
function applyDamageToEnemy(enemy, dmg) {
    if (enemy.shield > 0) {
        enemy.shield -= dmg;
        if (enemy.shield <= 0) {
            enemy.hp += enemy.shield; // overflow damage (shield is negative)
            enemy.shield = 0;
            enemy.shieldCooldown = 12 + Math.random() * 5;
            floatingTexts.push(new FloatingText(enemy.x, enemy.y - 20, txt().shieldBreak, '#88ccff'));
            soundManager.bossShield();
        }
    } else {
        enemy.hp -= dmg;
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
                // Boss abilities
                e.maxShield = Math.floor(e.maxHp * 0.15);
                e.shieldCooldown = 5 + Math.random() * 3;
                e.summonCooldown = 8 + Math.random() * 4;
                e.speedBurstCooldown = 12 + Math.random() * 5;
            }
            if (data.type === 'fast') {
                e.size *= 0.8;
                if (data.fastArmor) e.armor = data.fastArmor;
            }
            // Phase 2 신규 적 ----
            if (data.type === 'spider') {
                e.size *= 0.85;
                e.webCooldown = 1.5 + Math.random();  // 거미줄 부여 쿨다운
            }
            if (data.type === 'bear') {
                e.size = Math.min(TILE * 0.4, e.size * 1.2);
                e.armor = 1;
            }
            if (data.type === 'bomber') {
                e.size *= 0.9;
                e.bombDamage = 1;  // 폭발 시 라이프 -1
                e.bombSplash = TILE * 1.0;  // 주변 1타일 적 데미지 (사용 안 함, 시각만)
            }
            if (data.type === 'healer') {
                e.size *= 0.95;
                e.healCooldown = 0.4 + Math.random() * 0.2;
                e.armor = 1;
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
        floatingTexts.push(new FloatingText(W / 2, TILE * 2, txt().waveClear(wave, bonus), '#88ccff'));
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
                applyDamageToEnemy(enemy, pdmg);
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

        // Boss abilities
        if (enemy.type === 'boss' && enemy.alive) {
            // Shield
            if (enemy.shield <= 0 && enemy.shieldCooldown > 0) {
                enemy.shieldCooldown -= dt;
                if (enemy.shieldCooldown <= 0) {
                    enemy.shield = enemy.maxShield;
                    soundManager.bossShield();
                }
            }
            // Summon
            if (enemy.summonCooldown > 0) {
                enemy.summonCooldown -= dt;
                if (enemy.summonCooldown <= 0 && enemies.length < 100) {
                    const summonCount = 2 + Math.floor(Math.random() * 3);
                    for (let si = 0; si < summonCount; si++) {
                        const minion = new Enemy(
                            Math.floor(enemy.maxHp * 0.03),
                            enemy.baseSpeed * 1.4,
                            Math.floor(enemy.goldValue * 0.1),
                            'fast'
                        );
                        minion.pathIndex = enemy.pathIndex;
                        minion.x = enemy.x + (Math.random() - 0.5) * TILE;
                        minion.y = enemy.y + (Math.random() - 0.5) * TILE;
                        minion.size *= 0.7;
                        enemies.push(minion);
                    }
                    floatingTexts.push(new FloatingText(enemy.x, enemy.y - 25, txt().summon, '#ff8844'));
                    soundManager.bossSummon();
                    enemy.summonCooldown = 10 + Math.random() * 5;
                }
            }
            // Speed Burst
            if (!enemy.speedBurstActive && enemy.speedBurstCooldown > 0) {
                enemy.speedBurstCooldown -= dt;
                if (enemy.speedBurstCooldown <= 0) {
                    enemy.speedBurstActive = true;
                    enemy.speedBurstTimer = 2;
                    floatingTexts.push(new FloatingText(enemy.x, enemy.y - 25, txt().speedBurst, '#ff4444'));
                    soundManager.bossSpeedBurst();
                }
            }
            if (enemy.speedBurstActive) {
                enemy.speedBurstTimer -= dt;
                enemy.speed = enemy.baseSpeed * 2.5;
                if (enemy.speedBurstTimer <= 0) {
                    enemy.speedBurstActive = false;
                    enemy.speedBurstCooldown = 12 + Math.random() * 5;
                }
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
                pokiGameplayStop();
                // 이번 게임에서 보상형 광고 아직 안 썼으면 옵션 표시
                showRewardedAdOption = !rewardedAdUsed && pokiReady;
            }
        }

        // Hit flash decay
        if (enemy.hitFlash > 0) enemy.hitFlash -= dt * 4;

        // Phase 2: 거미 — 주기적으로 가장 가까운 다른 적에게 슬로우 면역 4초 부여
        if (enemy.type === 'spider' && enemy.alive) {
            enemy.webCooldown -= dt;
            if (enemy.webCooldown <= 0) {
                let nearest = null, nearestD = Infinity;
                for (const o of enemies) {
                    if (!o.alive || o === enemy) continue;
                    const dd = (o.x - enemy.x) ** 2 + (o.y - enemy.y) ** 2;
                    if (dd < nearestD) { nearestD = dd; nearest = o; }
                }
                if (nearest && nearestD < (TILE * 2.5) ** 2) {
                    nearest.slowImmuneTimer = 4;
                    // 거미줄 효과 floating text
                    floatingTexts.push(new FloatingText(nearest.x, nearest.y - 18, '🕸', '#ccccff'));
                }
                enemy.webCooldown = 2 + Math.random();
            }
        }
        // 슬로우 면역 타이머 감소 + 면역 중이면 슬로우 무시
        if (enemy.slowImmuneTimer > 0) {
            enemy.slowImmuneTimer -= dt;
            enemy.slowTimer = 0;
            enemy.slowAmount = 0;
        }

        // Phase 2: 사제 — 주기적으로 주변 1타일 적 HP 회복
        if (enemy.type === 'healer' && enemy.alive) {
            enemy.healCooldown -= dt;
            if (enemy.healCooldown <= 0) {
                const radSq = (TILE * 1.0) ** 2;
                let healed = false;
                for (const o of enemies) {
                    if (!o.alive || o === enemy) continue;
                    if (o.hp >= o.maxHp) continue;
                    const dd = (o.x - enemy.x) ** 2 + (o.y - enemy.y) ** 2;
                    if (dd <= radSq) {
                        o.hp = Math.min(o.maxHp, o.hp + o.maxHp * 0.025);
                        healed = true;
                    }
                }
                if (healed) {
                    // 회복 글로우 마크 (오브 펄스 효과는 시각이 처리)
                    floatingTexts.push(new FloatingText(enemy.x, enemy.y - 22, '✚', '#88ff88'));
                }
                enemy.healCooldown = 0.6 + Math.random() * 0.2;
            }
        }
    }

    // Update towers
    for (const tower of towers) {
        tower.cooldown -= dt;

        // Find target (squared distance + 0.2초마다만 전체 재탐색)
        const rangePixels = tower.range * TILE;
        const rangeSq = rangePixels * rangePixels;
        tower.targetRecheck = (tower.targetRecheck || 0) - dt;

        // 현재 타겟이 유효하면 일단 유지
        let currentValid = false;
        if (tower.target && tower.target.alive && distSq(tower, tower.target) <= rangeSq) {
            currentValid = true;
        }

        if (!currentValid || tower.targetRecheck <= 0) {
            tower.targetRecheck = 0.2;
            let bestTarget = null;
            let bestProgress = -1;
            for (const enemy of enemies) {
                if (!enemy.alive) continue;
                if (distSq(tower, enemy) <= rangeSq) {
                    // pathIndex만으로도 진행도 비교 충분 (fractional 제거)
                    const progress = enemy.pathIndex;
                    if (progress > bestProgress) {
                        bestProgress = progress;
                        bestTarget = enemy;
                    }
                }
            }
            tower.target = bestTarget;
        }

        const bestTarget = tower.target;

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

            // Apply damage (with crit)
            let baseDmg = proj.damage;
            if (proj.isCrit) baseDmg = Math.floor(baseDmg * (TOWER_TYPES[0].critMult || 1));
            const dmg = Math.max(1, baseDmg - (proj.target.armor || 0));
            applyDamageToEnemy(proj.target, dmg);
            proj.target.hitFlash = 1;
            proj.tower.totalDamage += dmg;

            // Crit effects (사운드 제거: 치명타 처치 시 enemyDeath와 누적되며 "뿅" 톤 거슬림)
            if (proj.isCrit) {
                floatingTexts.push(new FloatingText(proj.target.x, proj.target.y - 28, txt().crit, '#ffdd44', 'crit'));
                for (let ci = 0; ci < 8; ci++) {
                    const ca = Math.random() * Math.PI * 2;
                    particles.push(new Particle(proj.target.x, proj.target.y, '#ffdd44',
                        Math.cos(ca) * 2.5, Math.sin(ca) * 2.5, 0.5, 3));
                }
            }

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
                        applyDamageToEnemy(enemy, splashDmg);
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


            // Chain lightning (번개 = 인덱스 2)
            if (proj.towerTypeIndex === 2 && proj.target.alive) {
                const chainType = TOWER_TYPES[2];
                const chainRange = chainType.chainRange * TILE;
                let chainDamage = proj.damage * chainType.chainDecay;
                let lastTarget = proj.target;
                const hitTargets = new Set([proj.target]);

                for (let bounce = 0; bounce < chainType.chain; bounce++) {
                    let nearest = null;
                    let nearestDist = Infinity;
                    for (const ce of enemies) {
                        if (!ce.alive || hitTargets.has(ce)) continue;
                        const cd = dist(lastTarget, ce);
                        if (cd <= chainRange && cd < nearestDist) {
                            nearest = ce;
                            nearestDist = cd;
                        }
                    }
                    if (!nearest) break;

                    const chainHitDmg = Math.max(1, Math.floor(chainDamage) - (nearest.armor || 0));
                    applyDamageToEnemy(nearest, chainHitDmg);
                    nearest.hitFlash = 1;
                    hitTargets.add(nearest);

                    if (chainLightnings.length < 10) {
                        chainLightnings.push({
                            x1: lastTarget.x, y1: lastTarget.y,
                            x2: nearest.x, y2: nearest.y,
                            life: 0.25
                        });
                    }

                    if (nearest.hp <= 0 && nearest.alive) {
                        nearest.alive = false;
                        gold += nearest.goldValue;
                        score += nearest.goldValue * 2;
                        spawnDeathParticles(nearest);
                        floatingTexts.push(new FloatingText(nearest.x, nearest.y - 15, `+${nearest.goldValue}G`, '#ffdd44'));
                        soundManager.enemyDeath();
                    }

                    lastTarget = nearest;
                    chainDamage *= chainType.chainDecay;
                }
                // 사운드 호출 제거: 체인 바운스마다 누적되어 거슬림. 시각 효과(지그재그)만 유지.
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

    // Update chain lightnings
    for (const cl of chainLightnings) {
        cl.life -= dt / gameSpeed;
    }
    chainLightnings = chainLightnings.filter(cl => cl.life > 0);

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
    // r = scalar (모두 동일) 또는 { tl, tr, bl, br }
    let tl, tr, br, bl;
    if (typeof r === 'object' && r !== null) {
        tl = r.tl || 0; tr = r.tr || 0; br = r.br || 0; bl = r.bl || 0;
    } else {
        tl = tr = br = bl = r;
    }
    ctx.beginPath();
    ctx.moveTo(x + tl, y);
    ctx.lineTo(x + w - tr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + tr);
    ctx.lineTo(x + w, y + h - br);
    ctx.quadraticCurveTo(x + w, y + h, x + w - br, y + h);
    ctx.lineTo(x + bl, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - bl);
    ctx.lineTo(x, y + tl);
    ctx.quadraticCurveTo(x, y, x + tl, y);
    ctx.closePath();
}

// ---- Draw ----
function draw() {
    ctx.clearRect(0, 0, W, H);

    // 매 프레임 hotspot 리셋 — 그리는 시점에 push되어 mousemove hit-test에 사용
    pointerHotspots.length = 0;

    const gameH = ROWS * TILE;

    // Screen shake — apply to game field only
    ctx.save();
    if (screenShakeTimer > 0) {
        const shakeX = (Math.random() - 0.5) * 2 * screenShakeIntensity;
        const shakeY = (Math.random() - 0.5) * 2 * screenShakeIntensity;
        ctx.translate(shakeX, shakeY);
    }

    // Draw grass/path background (오프스크린 캐시 → 정적이므로 한 번만 생성)
    if (!backgroundCache) {
        backgroundCache = generateBackgroundCache();
    }
    ctx.drawImage(backgroundCache, 0, 0, W, ROWS * TILE);

    // (경로 디테일은 backgroundCache에 포함되어 있음 — 매 프레임 그리지 않음)

    // Draw grass blades (wind sway) — 단일 path로 합쳐서 stroke 1회 (성능)
    const windTime = Date.now() / 800;
    ctx.strokeStyle = 'rgba(80,150,70,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const gb of grassBlades) {
        const sway = Math.sin(windTime + gb.phase) * 3;
        ctx.moveTo(gb.x, gb.y);
        ctx.lineTo(gb.x + sway, gb.y - gb.h);
    }
    ctx.stroke();

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

    // Entry / Exit markers — 아이콘 (중앙 정렬, 맥박 애니메이션)
    const entry = waypoints[0];
    const exitP = waypoints[waypoints.length - 1];
    const pulse = 0.85 + Math.sin(Date.now() / 400) * 0.15;
    const entryCX = Math.max(TILE / 2, entry.x * TILE + TILE / 2);
    const entryCY = entry.y * TILE + TILE / 2;
    const exitCX = Math.min(W - TILE / 2, exitP.x * TILE + TILE / 2);
    const exitCY = exitP.y * TILE + TILE / 2;

    // Entry: 오른쪽으로 향하는 초록 화살표 (▶)
    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.shadowColor = '#44ff66';
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#44dd55';
    const arrowR = TILE * 0.28;
    ctx.beginPath();
    ctx.moveTo(entryCX - arrowR * 0.6, entryCY - arrowR * 0.9);
    ctx.lineTo(entryCX + arrowR * 0.9, entryCY);
    ctx.lineTo(entryCX - arrowR * 0.6, entryCY + arrowR * 0.9);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    // Exit: 과녁/타겟 아이콘 (◎)
    ctx.save();
    ctx.globalAlpha = pulse;
    ctx.shadowColor = '#ff4444';
    ctx.shadowBlur = 12;
    const tgR = TILE * 0.3;
    // 외곽 링
    ctx.strokeStyle = '#ee4444';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(exitCX, exitCY, tgR, 0, Math.PI * 2);
    ctx.stroke();
    // 중앙 점
    ctx.fillStyle = '#ff6666';
    ctx.beginPath();
    ctx.arc(exitCX, exitCY, tgR * 0.35, 0, Math.PI * 2);
    ctx.fill();
    // 십자 표시
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(exitCX - tgR * 0.6, exitCY);
    ctx.lineTo(exitCX - tgR * 0.3, exitCY);
    ctx.moveTo(exitCX + tgR * 0.3, exitCY);
    ctx.lineTo(exitCX + tgR * 0.6, exitCY);
    ctx.moveTo(exitCX, exitCY - tgR * 0.6);
    ctx.lineTo(exitCX, exitCY - tgR * 0.3);
    ctx.moveTo(exitCX, exitCY + tgR * 0.3);
    ctx.lineTo(exitCX, exitCY + tgR * 0.6);
    ctx.stroke();
    ctx.restore();

    // Draw tower range indicator when hovering
    if (hoveredTile && !showUpgradeFor && selectedTower >= 0) {
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
        // 타워 셀은 클릭 가능 (업그레이드 패널 열기)
        addPointerHotspot(tower.col * TILE, tower.row * TILE, TILE, TILE);

        // Tower shadow
        ctx.fillStyle = 'rgba(0,0,0,0.2)';
        ctx.beginPath();
        ctx.ellipse(tower.x + 1, tower.y + TILE * 0.3, TILE * 0.3, TILE * 0.12, 0, 0, Math.PI * 2);
        ctx.fill();

        drawTowerAt(tower.x, tower.y, tower.typeIndex, tower.level, tower.angle);

        // Muzzle flash (shadowBlur 대신 3중 원)
        if (tower.muzzleFlash > 0) {
            const mt = tower.muzzleFlash / 0.1;
            const muzzleX = tower.x + Math.cos(tower.angle) * TILE * 0.4;
            const muzzleY = tower.y + Math.sin(tower.angle) * TILE * 0.4;
            ctx.fillStyle = tower.type.projColor;
            ctx.globalAlpha = mt * 0.25;
            ctx.beginPath();
            ctx.arc(muzzleX, muzzleY, 9, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = mt * 0.5;
            ctx.beginPath();
            ctx.arc(muzzleX, muzzleY, 5.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = mt * 0.85;
            ctx.beginPath();
            ctx.arc(muzzleX, muzzleY, 3, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
        }

        // (레벨은 타워 자체 진화로 표시됨 — 별 제거)
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
            // Arrow - 큼직한 회전 화살 + 진한 꼬리
            const angle = Math.atan2(
                proj.target.alive ? proj.target.y - proj.y : (proj.trail.length > 0 ? proj.y - proj.trail[proj.trail.length - 1].y : 0),
                proj.target.alive ? proj.target.x - proj.x : (proj.trail.length > 0 ? proj.x - proj.trail[proj.trail.length - 1].x : 1)
            );
            const critColor = proj.isCrit ? '#ffe066' : '#cfff66';
            const glowColor = proj.isCrit ? '#ffaa00' : '#66dd33';
            // 진한 꼬리 (2겹: 외곽 글로우 + 내부 코어)
            const len = Math.min(proj.trail.length, 6);
            if (len > 1) {
                ctx.save();
                ctx.lineCap = 'round';
                // 외곽 두꺼운 글로우
                ctx.strokeStyle = glowColor;
                ctx.lineWidth = proj.isCrit ? 7 : 5;
                ctx.globalAlpha = 0.35;
                ctx.beginPath();
                const start = proj.trail.length - len;
                ctx.moveTo(proj.trail[start].x, proj.trail[start].y);
                for (let i = start + 1; i < proj.trail.length; i++) {
                    ctx.lineTo(proj.trail[i].x, proj.trail[i].y);
                }
                ctx.lineTo(proj.x, proj.y);
                ctx.stroke();
                // 내부 선명한 코어
                ctx.strokeStyle = critColor;
                ctx.lineWidth = proj.isCrit ? 3 : 2.2;
                ctx.globalAlpha = 1;
                ctx.stroke();
                ctx.restore();
            }
            // 화살촉 (크게)
            ctx.save();
            ctx.translate(proj.x, proj.y);
            ctx.rotate(angle);
            const size = proj.isCrit ? 11 : 8;
            if (proj.isCrit) {
                ctx.shadowColor = glowColor;
                ctx.shadowBlur = 14;
            }
            // 화살대 (두껍게)
            ctx.strokeStyle = proj.isCrit ? '#aa6a00' : '#3f5e15';
            ctx.lineWidth = 2;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(-size * 0.85, 0);
            ctx.lineTo(-size * 2.1, 0);
            ctx.stroke();
            // 화살촉 (진한 색 외곽 + 밝은 내부로 명확하게)
            ctx.fillStyle = '#3a2000';
            ctx.beginPath();
            ctx.moveTo(size * 1.05, 0);
            ctx.lineTo(-size * 0.45, -size * 0.65);
            ctx.lineTo(-size * 0.15, 0);
            ctx.lineTo(-size * 0.45, size * 0.65);
            ctx.closePath();
            ctx.fill();
            ctx.fillStyle = critColor;
            ctx.beginPath();
            ctx.moveTo(size * 0.85, 0);
            ctx.lineTo(-size * 0.3, -size * 0.5);
            ctx.lineTo(-size * 0.1, 0);
            ctx.lineTo(-size * 0.3, size * 0.5);
            ctx.closePath();
            ctx.fill();
            if (proj.isCrit) ctx.shadowBlur = 0;
            // 하이라이트 점
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(size * 0.2, -size * 0.18, size * 0.25, 0, Math.PI * 2);
            ctx.fill();
            // 깃털 (큼직하게)
            ctx.fillStyle = proj.isCrit ? '#ffd044' : '#66cc33';
            ctx.beginPath();
            ctx.moveTo(-size * 1.95, -size * 0.5);
            ctx.lineTo(-size * 1.5, 0);
            ctx.lineTo(-size * 1.95, size * 0.5);
            ctx.lineTo(-size * 2.35, 0);
            ctx.closePath();
            ctx.fill();
            ctx.restore();

        } else if (ti === 1) {
            // Cannon - 큼직한 포탄 + 진한 연기 꼬리
            // 연기 꼬리 (뒤쪽은 불꽃)
            for (let i = 0; i < proj.trail.length; i++) {
                const t = i / proj.trail.length;
                ctx.globalAlpha = t * 0.55;
                ctx.fillStyle = t > 0.6 ? '#ff7a33' : '#777';
                const r1 = 3 + t * 4;
                ctx.beginPath();
                ctx.arc(proj.trail[i].x, proj.trail[i].y, r1, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
            // 포탄 몸체
            ctx.save();
            ctx.translate(proj.x, proj.y);
            ctx.rotate(Date.now() / 80);
            const rCan = 8;
            // 화염 할로 (큰 반투명 원)
            ctx.globalAlpha = 0.55;
            ctx.fillStyle = '#ff6a22';
            ctx.beginPath();
            ctx.arc(0, 0, rCan + 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 0.7;
            ctx.fillStyle = '#ffaa44';
            ctx.beginPath();
            ctx.arc(0, 0, rCan + 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            // 외곽 + 금속 밴드 (두껍게)
            ctx.fillStyle = '#0d0d0d';
            ctx.beginPath();
            ctx.arc(0, 0, rCan, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#666';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(0, 0, rCan - 2, 0, Math.PI * 2);
            ctx.stroke();
            // 하이라이트 (크게)
            ctx.fillStyle = '#ffaa66';
            ctx.beginPath();
            ctx.arc(-rCan * 0.35, -rCan * 0.35, rCan * 0.4, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(-rCan * 0.42, -rCan * 0.42, rCan * 0.22, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();

        } else if (ti === 3) {
            // Ice - 큼직한 얼음 결정
            // 서리 꼬리
            for (let i = 0; i < proj.trail.length; i++) {
                const alpha = (i + 1) / proj.trail.length * 0.55;
                ctx.globalAlpha = alpha;
                ctx.fillStyle = '#bbeeff';
                const sz = 2.5;
                ctx.save();
                ctx.translate(proj.trail[i].x, proj.trail[i].y);
                ctx.rotate(i * 0.8);
                ctx.fillRect(-sz/2, -sz/2, sz, sz);
                ctx.restore();
            }
            ctx.globalAlpha = 1;
            // 얼음 결정 본체 (크게)
            ctx.save();
            ctx.translate(proj.x, proj.y);
            ctx.rotate(Date.now() / 100);
            // 바깥 할로
            ctx.globalAlpha = 0.4;
            ctx.fillStyle = '#88ddff';
            ctx.beginPath();
            ctx.arc(0, 0, 9, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            // 다이아몬드 외곽 (진한 파랑 테두리)
            ctx.fillStyle = '#2a6890';
            ctx.beginPath();
            ctx.moveTo(0, -8);
            ctx.lineTo(-6, 0);
            ctx.lineTo(0, 8);
            ctx.lineTo(6, 0);
            ctx.closePath();
            ctx.fill();
            // 내부 (밝은 크리스털)
            ctx.fillStyle = '#aae6ff';
            ctx.beginPath();
            ctx.moveTo(0, -6);
            ctx.lineTo(-4.5, 0);
            ctx.lineTo(0, 6);
            ctx.lineTo(4.5, 0);
            ctx.closePath();
            ctx.fill();
            // 중심 하이라이트
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(-1, -1.5, 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();

        } else if (ti === 2) {
            // Lightning - 더 두꺼운 번개 + 큰 구체
            const tx = proj.target.alive ? proj.target.x : proj.x;
            const ty = proj.target.alive ? proj.target.y : proj.y;
            // 외곽 글로우 번개
            ctx.strokeStyle = 'rgba(255,255,100,0.4)';
            ctx.lineWidth = 5;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(proj.x, proj.y);
            const segments = 4;
            const pts = [];
            for (let i = 1; i <= segments; i++) {
                const t = i / segments;
                const lx = proj.x + (tx - proj.x) * t * 0.3 + (Math.random() - 0.5) * 10;
                const ly = proj.y + (ty - proj.y) * t * 0.3 + (Math.random() - 0.5) * 10;
                pts.push([lx, ly]);
                ctx.lineTo(lx, ly);
            }
            ctx.stroke();
            // 내부 밝은 번개
            ctx.strokeStyle = '#ffffaa';
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.moveTo(proj.x, proj.y);
            for (const [lx, ly] of pts) ctx.lineTo(lx, ly);
            ctx.stroke();
            // 코어 라인 (가장 밝음)
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            ctx.stroke();
            // 전기 구체 (3중 원)
            ctx.globalAlpha = 0.35;
            ctx.fillStyle = '#ffff44';
            ctx.beginPath();
            ctx.arc(proj.x, proj.y, 10, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 0.7;
            ctx.beginPath();
            ctx.arc(proj.x, proj.y, 6, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(proj.x, proj.y, 3, 0, Math.PI * 2);
            ctx.fill();

        } else if (ti === 4) {
            // Poison - 큼직한 독 방울 + 진한 꼬리
            for (let i = 0; i < proj.trail.length; i++) {
                const alpha = (i + 1) / proj.trail.length * 0.5;
                ctx.globalAlpha = alpha;
                ctx.fillStyle = '#44ff22';
                const r = 2 + Math.sin(i * 1.5) * 1.2;
                ctx.beginPath();
                ctx.arc(
                    proj.trail[i].x + Math.sin(i * 2) * 2,
                    proj.trail[i].y + Math.cos(i * 2) * 2,
                    r, 0, Math.PI * 2
                );
                ctx.fill();
            }
            ctx.globalAlpha = 1;
            // 독 방울 본체 (크게, 할로 + 외곽 + 내부 + 하이라이트)
            // 할로
            ctx.globalAlpha = 0.4;
            ctx.fillStyle = '#66ff44';
            ctx.beginPath();
            ctx.arc(proj.x, proj.y, 9, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            // 외곽 진한 초록
            ctx.fillStyle = '#1f7010';
            ctx.beginPath();
            ctx.arc(proj.x, proj.y, 6.5, 0, Math.PI * 2);
            ctx.fill();
            // 내부
            ctx.fillStyle = '#44dd22';
            ctx.beginPath();
            ctx.arc(proj.x, proj.y, 5, 0, Math.PI * 2);
            ctx.fill();
            // 하이라이트
            ctx.fillStyle = '#aaff88';
            ctx.beginPath();
            ctx.arc(proj.x - 1.5, proj.y - 1.5, 2, 0, Math.PI * 2);
            ctx.fill();
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

    // Draw chain lightnings
    for (const cl of chainLightnings) {
        const clAlpha = cl.life / 0.25;
        ctx.globalAlpha = clAlpha * 0.8;
        const cdx = cl.x2 - cl.x1;
        const cdy = cl.y2 - cl.y1;
        // Main bolt
        ctx.strokeStyle = '#ffff44';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cl.x1, cl.y1);
        for (let si = 1; si < 5; si++) {
            const st = si / 5;
            ctx.lineTo(
                cl.x1 + cdx * st + (Math.random() - 0.5) * 10,
                cl.y1 + cdy * st + (Math.random() - 0.5) * 10
            );
        }
        ctx.lineTo(cl.x2, cl.y2);
        ctx.stroke();
        // Secondary bolt
        ctx.strokeStyle = '#ffffaa';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cl.x1, cl.y1);
        for (let si = 1; si < 5; si++) {
            const st = si / 5;
            ctx.lineTo(
                cl.x1 + cdx * st + (Math.random() - 0.5) * 14,
                cl.y1 + cdy * st + (Math.random() - 0.5) * 14
            );
        }
        ctx.lineTo(cl.x2, cl.y2);
        ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Draw ambient particles (반딧불 글로우는 적 적을 때만)
    const fireflyGlowOk = enemies.length < 15;
    for (const ap of ambientParticles) {
        const alpha = Math.min(1, ap.life / ap.maxLife) * 0.6;
        ctx.globalAlpha = alpha;
        if (ap.isFirefly) {
            if (fireflyGlowOk) {
                ctx.save();
                ctx.shadowColor = '#aaff44';
                ctx.shadowBlur = 6;
                ctx.fillStyle = '#ddff88';
                ctx.beginPath();
                ctx.arc(ap.x, ap.y, ap.size, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            } else {
                // 많을 땐 글로우 생략
                ctx.fillStyle = '#ddff88';
                ctx.beginPath();
                ctx.arc(ap.x, ap.y, ap.size, 0, Math.PI * 2);
                ctx.fill();
            }
        } else {
            ctx.fillStyle = 'rgba(200,200,180,0.4)';
            ctx.beginPath();
            ctx.arc(ap.x, ap.y, ap.size, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    ctx.globalAlpha = 1;

    // Draw floating texts (통일된 디자인: 900 weight + Segoe UI + 외곽선 + 그라디언트 + 글로우 + 등장 펄스)
    for (const ft of floatingTexts) {
        const isCrit = ft.style === 'crit';
        const elapsed = ft.maxLife - ft.life;

        // 등장 시 스케일 펄스 — crit은 더 크고 길게
        const popDur = isCrit ? 0.12 : 0.08;
        const popT = Math.min(1, elapsed / popDur);
        const scale = isCrit ? (1.5 - 0.5 * popT) : (1.25 - 0.25 * popT);
        const tilt = isCrit ? Math.sin(elapsed * 14) * 0.04 : 0;
        const fade = isCrit ? Math.min(1, ft.life * 1.6) : Math.min(1, ft.life * 1.4);

        const fontSize = Math.floor(TILE * 0.36);
        const font = `900 ${fontSize}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        const strokeColor = isCrit ? '#2a0404' : '#1a1a22';
        const strokeW = isCrit ? 5 : 3;
        const glowBlur = isCrit ? 20 : 7;
        const glowColor = isCrit ? '#ff2020' : ft.color;

        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(ft.x, ft.y);
        if (tilt) ctx.rotate(tilt);
        ctx.scale(scale, scale);
        ctx.font = font;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // 외곽선 + 글로우
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = glowBlur;
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = strokeW;
        ctx.lineJoin = 'round';
        ctx.strokeText(ft.text, 0, 0);
        ctx.shadowBlur = 0;

        // 그라디언트 채우기 (위 밝게 → 아래 원색)
        const grad = ctx.createLinearGradient(0, -fontSize * 0.55, 0, fontSize * 0.55);
        if (isCrit) {
            // 황금→빨강: 골드(노랑) FloatingText와 명확히 구분
            grad.addColorStop(0, '#ffe080');
            grad.addColorStop(0.4, '#ff5028');
            grad.addColorStop(1, '#cc0808');
        } else {
            grad.addColorStop(0, lightenHex(ft.color, 70));
            grad.addColorStop(1, ft.color);
        }
        ctx.fillStyle = grad;
        ctx.fillText(ft.text, 0, 0);

        // 상단 광택 띠 (crit 전용 — normal은 생략해 덜 화려하게)
        if (isCrit) {
            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            ctx.beginPath();
            const w = ctx.measureText(ft.text).width;
            ctx.rect(-w / 2, -fontSize * 0.45, w, fontSize * 0.2);
            ctx.clip();
            ctx.fillText(ft.text, 0, 0);
        }
        ctx.restore();
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
        ctx.globalAlpha = textAlpha * 0.9;
        ctx.font = `900 ${Math.floor(TILE * 0.6)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // 외곽선 + 글로우
        ctx.shadowColor = 'rgba(40,80,140,0.85)';
        ctx.shadowBlur = 14;
        ctx.strokeStyle = '#0e1a30';
        ctx.lineWidth = 5;
        ctx.lineJoin = 'round';
        ctx.strokeText(txt().waveNum(waveTransitionNum), textX, ROWS * TILE * 0.45);
        ctx.shadowBlur = 0;
        // 그라디언트 채우기
        const wtg = ctx.createLinearGradient(0, ROWS * TILE * 0.45 - TILE * 0.3, 0, ROWS * TILE * 0.45 + TILE * 0.3);
        wtg.addColorStop(0, '#dceeff');
        wtg.addColorStop(1, '#5aa8ff');
        ctx.fillStyle = wtg;
        ctx.fillText(txt().waveNum(waveTransitionNum), textX, ROWS * TILE * 0.45);
        ctx.globalAlpha = 1;
    }

    // Restore screen shake transform before UI
    ctx.restore();

    // ---- 상단 우측 웨이브 뱃지 (영구 표시) ----
    {
        const pillPad = Math.max(8, Math.floor(TILE * 0.25));
        const pillH = Math.max(28, Math.floor(TILE * 0.55));
        // 웨이브 진행도 (활성 적 + 소환 대기)
        const aliveCount = enemies.reduce((n, e) => n + (e.alive ? 1 : 0), 0);
        const remaining = aliveCount + enemySpawnQueue.length;
        const hasProgress = waveActive && waveTotalEnemies > 0;

        // 텍스트 측정 (두 세그먼트 분리)
        const mainFont = `bold ${Math.floor(TILE * 0.3)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        const progFont = `bold ${Math.floor(TILE * 0.25)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        const mainLabel = txt().waveNum(Math.max(1, wave));
        const progLabel = `${fmt(remaining)} / ${fmt(waveTotalEnemies)}`;
        ctx.font = mainFont;
        const mainW = ctx.measureText(mainLabel).width;
        ctx.font = progFont;
        const progW = hasProgress ? ctx.measureText(progLabel).width : 0;
        const sepGap = hasProgress ? Math.max(10, Math.floor(TILE * 0.18)) : 0;
        const sepW = hasProgress ? 2 : 0; // 구분선 두께
        const iconW = Math.floor(TILE * 0.3);

        const pillW = iconW + 6 + mainW + sepGap + sepW + sepGap + progW + pillPad * 2;
        const pillX = W - pillW - Math.max(8, Math.floor(TILE * 0.2));
        const pillY = Math.max(8, Math.floor(TILE * 0.2));
        const pillR = pillH / 2;

        // 배경
        ctx.save();
        ctx.shadowColor = 'rgba(100,180,255,0.4)';
        ctx.shadowBlur = 10;
        drawRoundRect(pillX, pillY, pillW, pillH, pillR);
        const pillGrad = ctx.createLinearGradient(pillX, pillY, pillX, pillY + pillH);
        pillGrad.addColorStop(0, 'rgba(40,50,85,0.92)');
        pillGrad.addColorStop(1, 'rgba(20,25,50,0.92)');
        ctx.fillStyle = pillGrad;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(120,180,255,0.45)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.restore();

        // 보스 웨이브면 빨강 틴트
        if (wave > 0 && wave % 5 === 0) {
            ctx.save();
            drawRoundRect(pillX, pillY, pillW, pillH, pillR);
            ctx.fillStyle = 'rgba(220,60,60,0.18)';
            ctx.fill();
            ctx.restore();
        }

        const centerY = pillY + pillH / 2;
        const mainFs = Math.floor(TILE * 0.3);
        const progFs = Math.floor(TILE * 0.25);
        // alphabetic baseline 기반 텍스트 시각 중심: baseline = boxCenter + fontSize × 0.34
        const textBaselineY = centerY + mainFs * 0.34;
        const iconCy = centerY;

        // 아이콘 — 두 검 X자 (vector, emoji 폰트 의존 없는 정확한 정렬)
        ctx.save();
        const iconCx = pillX + pillPad + iconW / 2;
        const iconColor = wave > 0 && wave % 5 === 0 ? '#ff8888' : '#88ccff';
        ctx.strokeStyle = iconColor;
        ctx.lineWidth = Math.max(2, Math.floor(TILE * 0.045));
        ctx.lineCap = 'round';
        const iconR = mainFs * 0.42;  // 텍스트 폰트 사이즈 기반 (시각 높이 매칭)
        ctx.beginPath();
        ctx.moveTo(iconCx - iconR, iconCy - iconR);
        ctx.lineTo(iconCx + iconR, iconCy + iconR);
        ctx.moveTo(iconCx + iconR, iconCy - iconR);
        ctx.lineTo(iconCx - iconR, iconCy + iconR);
        ctx.stroke();
        ctx.restore();

        // 메인 라벨 (웨이브 번호) — alphabetic baseline + 시각 중심 보정
        ctx.fillStyle = wave > 0 && wave % 5 === 0 ? '#ffd0d0' : '#ffffff';
        ctx.font = mainFont;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        const mainX = pillX + pillPad + iconW + 6;
        ctx.fillText(mainLabel, mainX, textBaselineY);

        // 구분선 + 진행도 (완전히 다른 톤)
        if (hasProgress) {
            const sepX = mainX + mainW + sepGap;
            // 세로 구분선
            ctx.strokeStyle = 'rgba(160,180,220,0.4)';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(sepX, pillY + pillH * 0.25);
            ctx.lineTo(sepX, pillY + pillH * 0.75);
            ctx.stroke();
            // 진행도 (작고 노란색 톤) — 같은 baseline 보정 비율
            ctx.font = progFont;
            ctx.fillStyle = wave > 0 && wave % 5 === 0 ? '#ffaa80' : '#ffcc55';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(progLabel, sepX + sepGap, centerY + progFs * 0.34);
        }
    }

    // ---- 보스 HP 바 (보스 등장 시 상단 중앙) ----
    {
        const boss = enemies.find(e => e.alive && e.type === 'boss');
        if (boss) {
            const bx1 = W * 0.25;
            const bw = W * 0.5;
            const bh = Math.max(18, Math.floor(TILE * 0.36));
            const by = Math.max(6, Math.floor(TILE * 0.2));
            const ratio = Math.max(0, boss.hp / boss.maxHp);
            // 배경
            ctx.fillStyle = 'rgba(10,10,20,0.85)';
            drawRoundRect(bx1, by, bw, bh, bh / 2);
            ctx.fill();
            ctx.strokeStyle = 'rgba(200,40,40,0.7)';
            ctx.lineWidth = 2;
            ctx.stroke();
            // HP 그라디언트 바
            const hpColor = ratio > 0.5 ? '#ff4040' : ratio > 0.25 ? '#ffaa40' : '#ff2020';
            const hpGrad = ctx.createLinearGradient(bx1, by, bx1, by + bh);
            hpGrad.addColorStop(0, hpColor);
            hpGrad.addColorStop(1, ratio > 0.5 ? '#a01010' : '#6a0808');
            ctx.fillStyle = hpGrad;
            drawRoundRect(bx1 + 2, by + 2, Math.max(0, (bw - 4) * ratio), bh - 4, (bh - 4) / 2);
            ctx.fill();
            // 상단 광택
            ctx.fillStyle = 'rgba(255,255,255,0.2)';
            drawRoundRect(bx1 + 2, by + 2, Math.max(0, (bw - 4) * ratio), (bh - 4) * 0.4, { tl: (bh - 4) / 2, tr: (bh - 4) / 2, bl: 0, br: 0 });
            ctx.fill();
            // 텍스트 (이름 + HP 숫자)
            ctx.fillStyle = '#ffffff';
            ctx.font = `bold ${Math.floor(TILE * 0.25)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0,0,0,0.8)';
            ctx.shadowBlur = 3;
            const bossLabel = (lang === 'ko' ? '보스' : 'BOSS') + ` · ${fmt(Math.ceil(boss.hp))} / ${fmt(boss.maxHp)}`;
            ctx.fillText(bossLabel, bx1 + bw / 2, by + bh / 2 + 1);
            ctx.shadowBlur = 0;
            // 실드 바 (작게)
            if (boss.maxShield > 0 && boss.shield > 0) {
                const sbY = by + bh + 3;
                ctx.fillStyle = 'rgba(10,10,20,0.7)';
                ctx.fillRect(bx1, sbY, bw, 5);
                ctx.fillStyle = '#4488ff';
                ctx.fillRect(bx1, sbY, bw * (boss.shield / boss.maxShield), 5);
            }
        }
    }

    // ---- UI Panel (bottom) ----
    const uiY = ROWS * TILE;
    const uiGrad = ctx.createLinearGradient(0, uiY, 0, uiY + UI_ROWS * TILE);
    uiGrad.addColorStop(0, '#1e1e38');
    uiGrad.addColorStop(1, '#12121e');
    ctx.fillStyle = uiGrad;
    ctx.fillRect(0, uiY, W, UI_ROWS * TILE);

    // Top bar of UI (모던 그라디언트 + 글로우 라인)
    const barGrad = ctx.createLinearGradient(0, uiY, 0, uiY + TILE * 0.8);
    barGrad.addColorStop(0, '#262645');
    barGrad.addColorStop(0.6, '#1d1d35');
    barGrad.addColorStop(1, '#15152a');
    ctx.fillStyle = barGrad;
    ctx.fillRect(0, uiY, W, TILE * 0.8);
    // 상단 하이라이트 (미세한 광택)
    ctx.fillStyle = 'rgba(120,180,255,0.08)';
    ctx.fillRect(0, uiY, W, 1);
    // 하단 구분 네온 라인
    ctx.strokeStyle = 'rgba(100,180,255,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, uiY + TILE * 0.8);
    ctx.lineTo(W, uiY + TILE * 0.8);
    ctx.stroke();

    // 통일 메트릭 — 좌우 패딩과 모든 gap을 동일 값으로 통일
    const itemGap = Math.max(8, Math.floor(TILE * 0.16));
    const UI_PAD = itemGap;
    const barH = TILE * 0.8;
    const itemH = Math.floor(TILE * 0.65);  // 스탯/버튼 공통 높이
    const itemY = uiY + Math.floor((barH - itemH) / 2);

    // Stats — 개별 뱃지 (gold / lives / score 3개)
    ctx.textBaseline = 'middle';
    const badgeH = itemH;
    const badgeR = 8;
    const fontSize = Math.floor(TILE * 0.3);
    const iconSize = Math.floor(TILE * 0.28);
    const statY = itemY + itemH / 2;

    const stats = [
        { icon: '💰', label: fmt(gold), color: '#ffdd44', glow: 'rgba(255,212,68,0.25)',
          bgA: 'rgba(80,60,20,0.45)', bgB: 'rgba(50,40,10,0.45)', border: 'rgba(255,212,68,0.35)' },
        { icon: '❤', label: fmt(lives), color: '#ff8080', glow: 'rgba(255,90,90,0.25)',
          bgA: 'rgba(80,25,30,0.45)', bgB: 'rgba(50,15,20,0.45)', border: 'rgba(255,100,100,0.35)' },
        { icon: '★', label: fmt(score), color: '#cfd3ff', glow: 'rgba(170,180,240,0.25)',
          bgA: 'rgba(45,50,80,0.45)', bgB: 'rgba(25,30,55,0.45)', border: 'rgba(160,170,230,0.3)' },
    ];

    // 오른쪽 버튼 영역 (높이/gap 통일)
    const btnGap = itemGap;
    const uniformBtnW = Math.max(Math.floor(TILE * 1.7), 92);
    const btnH = itemH;
    const btnY = itemY;
    const rightBtnsW = uniformBtnW * 3 + btnGap * 2;

    // 왼쪽 스탯 뱃지 (gap 통일)
    const gap = itemGap;
    const badgeW = Math.max(Math.floor(TILE * 1.95), 100);
    const statsTotalW = badgeW * stats.length + gap * (stats.length - 1);
    let bx = UI_PAD;

    for (let si = 0; si < stats.length; si++) {
        const st = stats[si];
        const badgeY = itemY;

        // 뱃지 배경 (세로 그라디언트)
        const badgeGrad = ctx.createLinearGradient(0, badgeY, 0, badgeY + badgeH);
        badgeGrad.addColorStop(0, st.bgA);
        badgeGrad.addColorStop(1, st.bgB);
        drawRoundRect(bx, badgeY, badgeW, badgeH, badgeR);
        ctx.fillStyle = badgeGrad;
        ctx.fill();
        // 상단 광택
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        drawRoundRect(bx, badgeY, badgeW, badgeH * 0.5, { tl: badgeR, tr: badgeR, bl: 0, br: 0 });
        ctx.fill();
        ctx.strokeStyle = st.border;
        ctx.lineWidth = 1;
        drawRoundRect(bx, badgeY, badgeW, badgeH, badgeR);
        ctx.stroke();

        // Flash overlay (gold = 0, lives = 1)
        if (si === 0 && goldFlashTimer > 0) {
            ctx.globalAlpha = goldFlashTimer / 0.4 * 0.35;
            drawRoundRect(bx, badgeY, badgeW, badgeH, badgeR);
            ctx.fillStyle = '#ffdd44';
            ctx.fill();
            ctx.globalAlpha = 1;
        }
        if (si === 1 && livesFlashTimer > 0) {
            ctx.globalAlpha = livesFlashTimer / 0.5 * 0.4;
            drawRoundRect(bx, badgeY, badgeW, badgeH, badgeR);
            ctx.fillStyle = '#ff4444';
            ctx.fill();
            ctx.globalAlpha = 1;
        }

        // 아이콘 (색상 통일, 글로우)
        ctx.save();
        ctx.shadowColor = st.glow;
        ctx.shadowBlur = 6;
        ctx.font = `bold ${iconSize}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        ctx.fillStyle = st.color;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(st.icon, bx + Math.floor(badgeW * 0.13), statY + 1);
        ctx.restore();

        // 값 (뱃지 우측에 우측정렬)
        ctx.font = `bold ${fontSize}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(st.label, bx + badgeW - Math.floor(badgeW * 0.12), statY + 1);

        bx += badgeW + gap;
    }

    // (스탯 ↔ 버튼 세로 divider 제거 — 사용자 요청)

    // ---- Right-side buttons (모두 동일 너비) ----
    // 공통 버튼 렌더링 헬퍼
    function drawIconBtn(bx, by, bw, bh, opts) {
        // opts: { bgA, bgB, border, icon, iconColor, iconFont, glow, active }
        const r = 8;
        // 그림자
        if (opts.active) {
            ctx.shadowColor = opts.glow || 'rgba(100,180,255,0.4)';
            ctx.shadowBlur = 10;
        }
        drawRoundRect(bx, by, bw, bh, r);
        const g = ctx.createLinearGradient(0, by, 0, by + bh);
        g.addColorStop(0, opts.bgA);
        g.addColorStop(1, opts.bgB);
        ctx.fillStyle = g;
        ctx.fill();
        ctx.shadowBlur = 0;
        // 상단 하이라이트
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        drawRoundRect(bx, by, bw, bh * 0.5, { tl: r, tr: r, bl: 0, br: 0 });
        ctx.fill();
        // 테두리
        ctx.strokeStyle = opts.border;
        ctx.lineWidth = 1.5;
        drawRoundRect(bx, by, bw, bh, r);
        ctx.stroke();
        // 아이콘
        ctx.fillStyle = opts.iconColor;
        ctx.font = opts.iconFont;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(opts.icon, bx + bw / 2, by + bh / 2 + 1);
    }

    let btnRight = W - UI_PAD;

    // Speed button (가장 오른쪽)
    const speedLabels = txt().speedLabels;
    const speedLabel = speedLabels[gameSpeed - 1];
    const speedBtnX = btnRight - uniformBtnW;
    const speedActive = gameSpeed > 1;
    drawIconBtn(speedBtnX, btnY, uniformBtnW, btnH, {
        bgA: gameSpeed === 1 ? 'rgba(40,45,75,0.9)' : gameSpeed === 2 ? 'rgba(45,80,40,0.9)' : 'rgba(100,35,35,0.9)',
        bgB: gameSpeed === 1 ? 'rgba(25,30,55,0.9)' : gameSpeed === 2 ? 'rgba(25,50,25,0.9)' : 'rgba(60,20,20,0.9)',
        border: gameSpeed === 1 ? 'rgba(120,140,180,0.45)' : gameSpeed === 2 ? 'rgba(136,204,68,0.6)' : 'rgba(255,100,70,0.6)',
        icon: speedLabel,
        iconColor: gameSpeed === 1 ? '#b4c0e0' : gameSpeed === 2 ? '#a8ff60' : '#ffa080',
        iconFont: `bold ${Math.floor(TILE * 0.3)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`,
        glow: speedActive ? (gameSpeed === 2 ? 'rgba(136,204,68,0.4)' : 'rgba(255,100,70,0.4)') : null,
        active: speedActive
    });
    window._speedBtn = { x: speedBtnX, y: btnY, w: uniformBtnW, h: btnH };
    addPointerHotspot(speedBtnX, btnY, uniformBtnW, btnH);
    btnRight = speedBtnX - btnGap;

    // Volume button
    const volBtnX = btnRight - uniformBtnW;
    drawIconBtn(volBtnX, btnY, uniformBtnW, btnH, {
        bgA: soundMuted ? 'rgba(90,35,35,0.9)' : 'rgba(40,45,75,0.9)',
        bgB: soundMuted ? 'rgba(55,20,20,0.9)' : 'rgba(25,30,55,0.9)',
        border: soundMuted ? 'rgba(255,100,70,0.6)' : 'rgba(120,140,180,0.45)',
        icon: soundMuted ? '🔇' : '🔊',
        iconColor: soundMuted ? '#ff8066' : '#b4c0e0',
        iconFont: `${Math.floor(TILE * 0.35)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`,
        glow: soundMuted ? 'rgba(255,100,70,0.4)' : null,
        active: soundMuted
    });
    window._volBtn = { x: volBtnX, y: btnY, w: uniformBtnW, h: btnH };
    addPointerHotspot(volBtnX, btnY, uniformBtnW, btnH);
    btnRight = volBtnX - btnGap;

    // Language button
    const langBtnX = btnRight - uniformBtnW;
    drawIconBtn(langBtnX, btnY, uniformBtnW, btnH, {
        bgA: 'rgba(40,45,75,0.9)',
        bgB: 'rgba(25,30,55,0.9)',
        border: 'rgba(120,140,180,0.45)',
        icon: txt().langLabel,
        iconColor: '#b4c0e0',
        iconFont: `bold ${Math.floor(TILE * 0.28)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`,
        glow: null,
        active: false
    });
    window._langBtn = { x: langBtnX, y: btnY, w: uniformBtnW, h: btnH };
    addPointerHotspot(langBtnX, btnY, uniformBtnW, btnH);

    // Wave warning overlay (boss / rush / heavy)
    if (bossWarningTimer > 0 && waveType !== 'normal') {
        let overlayColor, textColor, warnText;
        if (waveType === 'boss') {
            overlayColor = 'rgba(180, 0, 0,';
            textColor = '#ff2222';
            warnText = txt().bossWarn;
        } else if (waveType === 'rush') {
            overlayColor = 'rgba(220, 180, 0,';
            textColor = '#ffdd33';
            warnText = txt().rushWarn;
        } else if (waveType === 'heavy') {
            overlayColor = 'rgba(120, 60, 180,';
            textColor = '#cc88ff';
            warnText = txt().heavyWarn;
        } else { // swarm
            overlayColor = 'rgba(40, 180, 80,';
            textColor = '#88ff88';
            warnText = txt().swarmWarn;
        }
        const warnAlpha = Math.min(1, bossWarningTimer / 0.5) * (0.25 + Math.sin(Date.now() / 100) * 0.12);
        ctx.fillStyle = `${overlayColor} ${warnAlpha})`;
        ctx.fillRect(0, 0, W, ROWS * TILE);

        // 문장이 길어진 경우 가로 화면(90%)에 맞춰 폰트 자동 축소
        let warnFs = Math.floor(TILE * 0.85);
        const warnMaxW = W * 0.9;
        ctx.font = `900 ${warnFs}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        while (ctx.measureText(warnText).width > warnMaxW && warnFs > 18) {
            warnFs -= 2;
            ctx.font = `900 ${warnFs}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        }
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.globalAlpha = Math.min(1, bossWarningTimer / 0.5);
        // 외곽선 + 글로우
        ctx.shadowColor = textColor;
        ctx.shadowBlur = 18;
        ctx.strokeStyle = '#1a0606';
        ctx.lineWidth = Math.max(4, Math.floor(warnFs * 0.08));
        ctx.lineJoin = 'round';
        ctx.strokeText(warnText, W / 2, ROWS * TILE * 0.4);
        ctx.shadowBlur = 0;
        ctx.fillStyle = textColor;
        ctx.fillText(warnText, W / 2, ROWS * TILE * 0.4);
        if (waveType === 'boss') {
            ctx.font = `900 ${Math.floor(TILE * 0.4)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
            ctx.strokeStyle = '#3a2a00';
            ctx.lineWidth = 4;
            ctx.strokeText(txt().bossAppear(wave), W / 2, ROWS * TILE * 0.55);
            ctx.fillStyle = '#ffcc44';
            ctx.fillText(txt().bossAppear(wave), W / 2, ROWS * TILE * 0.55);
        }
        ctx.globalAlpha = 1;
        ctx.textBaseline = 'alphabetic';
    }

    // Tower selection buttons — UI_PAD 패딩, 동일 너비/간격, 모던 스타일
    const tBtnY = uiY + TILE * 0.95;
    const tBtnH = TILE * 1.5;
    const tBtnGap = Math.max(6, Math.floor(TILE * 0.12));
    const tBtnAvail = W - UI_PAD * 2 - tBtnGap * (TOWER_TYPES.length - 1);
    const btnW = Math.floor(tBtnAvail / TOWER_TYPES.length);
    const btnStartX = UI_PAD;
    const innerPad = Math.max(12, Math.floor(TILE * 0.22));

    for (let i = 0; i < TOWER_TYPES.length; i++) {
        const type = TOWER_TYPES[i];
        const bx = btnStartX + i * (btnW + tBtnGap);
        const isSelected = i === selectedTower;
        const canAfford = gold >= type.cost;
        addPointerHotspot(bx, tBtnY, btnW, tBtnH);

        // Check hover
        const isHovered = mousePos.x >= bx && mousePos.x <= bx + btnW && mousePos.y >= tBtnY && mousePos.y <= tBtnY + tBtnH;

        // Button background (그라디언트 + 테두리)
        if (isSelected) {
            ctx.save();
            ctx.shadowColor = type.color;
            ctx.shadowBlur = 14;
            drawRoundRect(bx, tBtnY, btnW, tBtnH, 8);
            const selGrad = ctx.createLinearGradient(0, tBtnY, 0, tBtnY + tBtnH);
            selGrad.addColorStop(0, 'rgba(60,75,120,0.95)');
            selGrad.addColorStop(1, 'rgba(30,40,70,0.95)');
            ctx.fillStyle = selGrad;
            ctx.fill();
            ctx.restore();
            ctx.strokeStyle = type.color;
            ctx.lineWidth = 2;
            drawRoundRect(bx, tBtnY, btnW, tBtnH, 8);
            ctx.stroke();
        } else {
            drawRoundRect(bx, tBtnY, btnW, tBtnH, 8);
            const bgGrad = ctx.createLinearGradient(0, tBtnY, 0, tBtnY + tBtnH);
            if (isHovered) {
                bgGrad.addColorStop(0, 'rgba(50,55,90,0.9)');
                bgGrad.addColorStop(1, 'rgba(30,35,65,0.9)');
            } else {
                bgGrad.addColorStop(0, 'rgba(35,40,65,0.85)');
                bgGrad.addColorStop(1, 'rgba(22,25,48,0.85)');
            }
            ctx.fillStyle = bgGrad;
            ctx.fill();
            ctx.strokeStyle = isHovered ? 'rgba(120,140,180,0.5)' : 'rgba(70,80,110,0.45)';
            ctx.lineWidth = 1;
            ctx.stroke();
        }
        // 상단 광택
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        drawRoundRect(bx, tBtnY, btnW, tBtnH * 0.35, { tl: 8, tr: 8, bl: 0, br: 0 });
        ctx.fill();

        // 타워 아이콘 — 좌측 고정 너비 영역 (30%)
        const iconZoneW = Math.floor(btnW * 0.3);
        const iconX = bx + innerPad + iconZoneW / 2 - innerPad / 2;
        const iconY = tBtnY + tBtnH * 0.5;
        ctx.save();
        const iconScale = Math.max(0.7, TILE * 0.018);
        drawTowerIcon(iconX, iconY - tBtnH * 0.1, i, iconScale);
        ctx.restore();

        // 텍스트 영역 (좌측 아이콘 다음부터 우측 패딩까지)
        const textX = bx + innerPad + iconZoneW + innerPad / 2;
        const textMaxW = bx + btnW - innerPad - textX;

        // 타워 이름
        ctx.fillStyle = canAfford ? '#ffffff' : '#556';
        ctx.font = `bold ${Math.floor(TILE * 0.3)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        // 이름이 길면 폰트 축소
        let nameText = txt().towerShort[type.nameKey];
        let nfs = Math.floor(TILE * 0.3);
        while (ctx.measureText(nameText).width > textMaxW && nfs > 10) {
            nfs -= 1;
            ctx.font = `bold ${nfs}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        }
        ctx.fillText(nameText, textX, tBtnY + tBtnH * 0.3);

        // 비용 (골드 아이콘 + 숫자)
        ctx.fillStyle = canAfford ? '#ffdd44' : '#664422';
        ctx.font = `bold ${Math.floor(TILE * 0.26)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.fillText(`${fmt(type.cost)}G`, textX, tBtnY + tBtnH * 0.55);

        // 설명
        ctx.fillStyle = canAfford ? '#9aa3c0' : '#556';
        ctx.font = `${Math.floor(TILE * 0.2)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        let descText = txt().towerDesc[type.nameKey];
        let dfs = Math.floor(TILE * 0.2);
        while (ctx.measureText(descText).width > textMaxW && dfs > 8) {
            dfs -= 1;
            ctx.font = `${dfs}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        }
        ctx.fillText(descText, textX, tBtnY + tBtnH * 0.78);

        // 키보드 힌트 — 우측 상단 키 캡 박스 (데스크톱만)
        if (!isMobile) {
            const keyTxt = `${i + 1}`;
            const keyFs = Math.max(11, Math.floor(TILE * 0.26));
            ctx.font = `900 ${keyFs}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
            const keyW = Math.max(keyFs + 14, ctx.measureText(keyTxt).width + 16);
            const keyH = keyFs + 12;  // 위아래 패딩 더 넉넉히
            const keyX = bx + btnW - innerPad - keyW;
            const keyY = tBtnY + Math.max(8, Math.floor(TILE * 0.16));
            // 키캡 배경
            drawRoundRect(keyX, keyY, keyW, keyH, 4);
            ctx.fillStyle = isSelected ? 'rgba(255,255,255,0.18)' : 'rgba(60,70,100,0.55)';
            ctx.fill();
            ctx.strokeStyle = isSelected ? 'rgba(255,255,255,0.45)' : 'rgba(140,160,200,0.5)';
            ctx.lineWidth = 1;
            ctx.stroke();
            // 키 라벨 — alphabetic baseline + 표준 폰트 비율(0.34)로 박스 정중앙
            ctx.fillStyle = isSelected ? '#ffffff' : '#cfd8ec';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(keyTxt, keyX + keyW / 2, keyY + keyH / 2 + keyFs * 0.34);
        }
    }
    ctx.textBaseline = 'alphabetic';

    // Upgrade panel — 넉넉한 너비 + 좌우 패딩 + 오버플로 방지
    if (showUpgradeFor) {
        const t = showUpgradeFor;
        const panelPad = Math.max(12, Math.floor(TILE * 0.25));
        const rowGap = Math.max(6, Math.floor(TILE * 0.12));
        const lineH = Math.floor(TILE * 0.34);
        const btnH = Math.max(32, Math.floor(TILE * 0.7));

        // 텍스트 폭 측정해서 패널 너비 결정 (최소/최대 한계)
        ctx.font = `bold ${Math.floor(TILE * 0.36)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        const titleStr = `${txt().towerNames[t.type.nameKey]} · Lv.${t.level}`;
        const titleW = ctx.measureText(titleStr).width;

        ctx.font = `${Math.floor(TILE * 0.26)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        const atkLine = `${txt().atk} ${fmt(t.damage)}`;
        const rngLine = `${txt().range} ${t.range.toFixed(1)}`;
        const rateLine = `${txt().atkSpeed} ${t.fireRate.toFixed(2)}s`;
        const dmgLine = `${txt().totalDmg} ${fmt(t.totalDamage)}`;
        const row1W = Math.max(ctx.measureText(atkLine).width, ctx.measureText(rateLine).width);
        const row2W = Math.max(ctx.measureText(rngLine).width, ctx.measureText(dmgLine).width);
        const statsW = row1W + row2W + Math.max(14, Math.floor(TILE * 0.3));

        // 버튼 라벨 측정: 모든 가능한 라벨(업그레이드, MAX LEVEL, 판매)의 최대 너비 기준
        const btnFontSize = Math.floor(TILE * 0.26);
        ctx.font = `bold ${btnFontSize}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        const upLabel = t.level < 5 ? txt().upgrade(t.upgradeCost) : txt().maxLevel;
        const sellLabel = txt().sell(t.sellValue);
        const allLabels = [upLabel, sellLabel, txt().maxLevel];
        const maxLabelW = Math.max(...allLabels.map(l => ctx.measureText(l).width));
        const btnPadH = Math.max(24, Math.floor(TILE * 0.5));
        const btnMinW = Math.ceil(maxLabelW + btnPadH * 2);  // 좌우 패딩 대칭
        const btnsRowW = btnMinW * 2 + Math.max(10, Math.floor(TILE * 0.2));

        // 최종 패널 너비: 내용 최대 + 패딩. 화면의 85%까지 허용
        const contentW = Math.max(titleW, statsW, btnsRowW);
        const panelW = Math.min(W - 16, contentW + panelPad * 2);
        const panelH = Math.floor(TILE * 0.55) + lineH * 3 + btnH + rowGap * 3 + panelPad * 2;

        let panelX = t.x - panelW / 2;
        let panelY = t.y - panelH - TILE * 0.6;
        if (panelY < 6) panelY = t.y + TILE * 0.6;
        if (panelX < 6) panelX = 6;
        if (panelX + panelW > W - 6) panelX = W - panelW - 6;

        // 그림자
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.6)';
        ctx.shadowBlur = 20;
        ctx.shadowOffsetY = 4;
        drawRoundRect(panelX, panelY, panelW, panelH, 12);
        const bgGrad = ctx.createLinearGradient(0, panelY, 0, panelY + panelH);
        bgGrad.addColorStop(0, 'rgba(30,35,58,0.97)');
        bgGrad.addColorStop(1, 'rgba(18,20,38,0.97)');
        ctx.fillStyle = bgGrad;
        ctx.fill();
        ctx.restore();
        // 테두리 (타워 색상 악센트)
        ctx.strokeStyle = t.type.color;
        ctx.lineWidth = 2;
        drawRoundRect(panelX, panelY, panelW, panelH, 12);
        ctx.stroke();
        // 상단 라인 악센트
        ctx.fillStyle = t.type.color;
        ctx.globalAlpha = 0.3;
        drawRoundRect(panelX, panelY, panelW, 3, { tl: 12, tr: 12, bl: 0, br: 0 });
        ctx.fill();
        ctx.globalAlpha = 1;

        // 타이틀
        let py = panelY + panelPad;
        ctx.textBaseline = 'top';
        ctx.textAlign = 'left';
        ctx.fillStyle = t.type.color;
        ctx.font = `bold ${Math.floor(TILE * 0.36)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        ctx.fillText(titleStr, panelX + panelPad, py);
        py += Math.floor(TILE * 0.5) + rowGap;

        // 구분선
        ctx.strokeStyle = 'rgba(120,180,255,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(panelX + panelPad, py - rowGap / 2);
        ctx.lineTo(panelX + panelW - panelPad, py - rowGap / 2);
        ctx.stroke();

        // 스탯 (2열 그리드)
        const col1X = panelX + panelPad;
        const col2X = panelX + panelW - panelPad - row2W;
        ctx.font = `${Math.floor(TILE * 0.26)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        ctx.fillStyle = '#aab4d0';
        ctx.fillText(txt().atk + ' ', col1X, py);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(fmt(t.damage), col1X + ctx.measureText(txt().atk + ' ').width, py);
        ctx.fillStyle = '#aab4d0';
        ctx.fillText(txt().range + ' ', col2X, py);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(t.range.toFixed(1), col2X + ctx.measureText(txt().range + ' ').width, py);
        py += lineH;

        ctx.fillStyle = '#aab4d0';
        ctx.fillText(txt().atkSpeed + ' ', col1X, py);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(t.fireRate.toFixed(2) + 's', col1X + ctx.measureText(txt().atkSpeed + ' ').width, py);
        ctx.fillStyle = '#aab4d0';
        ctx.fillText(txt().totalDmg + ' ', col2X, py);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(fmt(t.totalDamage), col2X + ctx.measureText(txt().totalDmg + ' ').width, py);
        py += lineH + rowGap;

        // 버튼 영역 (업그레이드 + 판매) — 모두 동일 너비, 동일 패딩
        const availBtnW = panelW - panelPad * 2;
        const btnGap2 = Math.max(10, Math.floor(TILE * 0.2));
        const oneBtnW = Math.floor((availBtnW - btnGap2) / 2);
        const upBtnX = panelX + panelPad;
        const sellBtnX = upBtnX + oneBtnW + btnGap2;
        const btnsY = py;

        // 공통 버튼 렌더링 (업그레이드/판매/MAX LEVEL 동일 스타일)
        function drawActionBtn(bx, by, bw, bh, variant, label, enabled) {
            // variant: 'upgrade' | 'sell' | 'max'
            let bgA, bgB, borderColor, textColor, glowColor;
            if (variant === 'upgrade') {
                bgA = enabled ? 'rgba(80,180,90,0.9)' : 'rgba(60,60,70,0.85)';
                bgB = enabled ? 'rgba(45,130,60,0.9)' : 'rgba(40,40,50,0.85)';
                borderColor = enabled ? 'rgba(140,255,150,0.7)' : 'rgba(100,100,110,0.5)';
                textColor = enabled ? '#ffffff' : '#888';
                glowColor = enabled ? 'rgba(80,220,90,0.4)' : null;
            } else if (variant === 'sell') {
                bgA = 'rgba(200,70,70,0.85)';
                bgB = 'rgba(130,35,35,0.85)';
                borderColor = 'rgba(255,120,120,0.6)';
                textColor = '#ffffff';
                glowColor = null;
            } else { // max
                bgA = 'rgba(220,180,40,0.28)';
                bgB = 'rgba(160,120,20,0.22)';
                borderColor = 'rgba(255,220,68,0.55)';
                textColor = '#ffdd66';
                glowColor = 'rgba(255,200,60,0.35)';
            }
            // 버튼 배경
            if (glowColor) {
                ctx.save();
                ctx.shadowColor = glowColor;
                ctx.shadowBlur = 10;
            }
            drawRoundRect(bx, by, bw, bh, 8);
            const g = ctx.createLinearGradient(0, by, 0, by + bh);
            g.addColorStop(0, bgA);
            g.addColorStop(1, bgB);
            ctx.fillStyle = g;
            ctx.fill();
            if (glowColor) ctx.restore();
            // 테두리
            ctx.strokeStyle = borderColor;
            ctx.lineWidth = 1.5;
            drawRoundRect(bx, by, bw, bh, 8);
            ctx.stroke();
            // 상단 광택
            ctx.fillStyle = 'rgba(255,255,255,0.15)';
            drawRoundRect(bx, by, bw, bh * 0.5, { tl: 8, tr: 8, bl: 0, br: 0 });
            ctx.fill();
            // 라벨 (동일 폰트, 동일 좌우 패딩, 넘치면 자동 축소)
            ctx.fillStyle = textColor;
            let fs = btnFontSize;
            ctx.font = `bold ${fs}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
            const innerW = bw - btnPadH * 2;
            while (ctx.measureText(label).width > innerW && fs > 10) {
                fs -= 1;
                ctx.font = `bold ${fs}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
            }
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, bx + bw / 2, by + bh / 2 + 1);
        }

        // Upgrade / MAX LEVEL 버튼
        if (t.level < 5) {
            const canUp = gold >= t.upgradeCost;
            drawActionBtn(upBtnX, btnsY, oneBtnW, btnH, 'upgrade', upLabel, canUp);
            t._upgradeBtn = { x: upBtnX, y: btnsY, w: oneBtnW, h: btnH };
            addPointerHotspot(upBtnX, btnsY, oneBtnW, btnH);
        } else {
            drawActionBtn(upBtnX, btnsY, oneBtnW, btnH, 'max', upLabel, true);
            t._upgradeBtn = null;
        }

        // Sell 버튼
        drawActionBtn(sellBtnX, btnsY, oneBtnW, btnH, 'sell', sellLabel, true);
        t._sellBtn = { x: sellBtnX, y: btnsY, w: oneBtnW, h: btnH };
        addPointerHotspot(sellBtnX, btnsY, oneBtnW, btnH);

        // baseline 복원
        ctx.textBaseline = 'alphabetic';
    }

    // Wave countdown / start prompt — 모던 CTA 스타일
    if (betweenWaves && !gameOver) {
        const countdown = Math.ceil(waveCountdown);
        const isStart = wave === 0;

        // 메인 라벨 / 힌트 분리
        let mainLabel, hintLabel;
        if (isStart) {
            mainLabel = (lang === 'ko' ? '시작' : 'Start');
            hintLabel = isMobile ? (lang === 'ko' ? '탭하세요' : 'Tap to begin')
                                  : (lang === 'ko' ? 'Space / Tap' : 'Space / Tap');
        } else {
            mainLabel = (lang === 'ko' ? `웨이브 ${fmt(wave + 1)} · ${countdown}초` : `Wave ${fmt(wave + 1)} · ${countdown}s`);
            hintLabel = isMobile ? (lang === 'ko' ? '탭하여 스킵' : 'Tap to skip')
                                 : (lang === 'ko' ? 'Space / Tap to skip' : 'Space / Tap to skip');
        }

        // 측정
        const mainFS = Math.floor(TILE * 0.42);
        const hintFS = Math.floor(TILE * 0.22);
        ctx.font = `bold ${mainFS}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        const mainW = ctx.measureText(mainLabel).width;
        ctx.font = `${hintFS}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        const hintW = ctx.measureText(hintLabel).width;
        const innerW = Math.max(mainW, hintW);

        // 아이콘 공간 + 그룹 (아이콘 + 메인 라벨)을 박스 중앙에 배치
        const iconW = Math.floor(TILE * 0.55);
        const iconLabelGap = 14;
        const boxPad = Math.max(22, Math.floor(TILE * 0.5));
        const groupW = iconW + iconLabelGap + mainW;
        // 박스 width: 그룹 + 좌우 패딩 + 여유 (가운데 정렬용 숨 통)
        const boxW = Math.max(groupW + boxPad * 2 + 40, hintW + boxPad * 2 + 40);
        const boxH = Math.floor(TILE * 1.35);
        const boxX = Math.floor(W / 2 - boxW / 2);
        // 첫 시작은 화면(게임 영역) 정중앙, 다음 웨이브 카운트다운은 상단
        const boxY = isStart
            ? Math.floor((ROWS * TILE - boxH) / 2)
            : Math.floor(TILE * 0.35);
        addPointerHotspot(boxX, boxY, boxW, boxH);
        window._startCtaBtn = { x: boxX, y: boxY, w: boxW, h: boxH };

        // 맥박 (scale + alpha)
        const pulseT = 0.5 + Math.sin(Date.now() / 400) * 0.5;

        // 외곽 글로우
        ctx.save();
        ctx.shadowColor = isStart ? 'rgba(100,200,140,0.8)' : 'rgba(100,180,255,0.7)';
        ctx.shadowBlur = 20 + pulseT * 10;
        drawRoundRect(boxX, boxY, boxW, boxH, boxH / 2);
        const bg = ctx.createLinearGradient(0, boxY, 0, boxY + boxH);
        if (isStart) {
            bg.addColorStop(0, 'rgba(60,140,85,0.95)');
            bg.addColorStop(1, 'rgba(30,90,50,0.95)');
        } else {
            bg.addColorStop(0, 'rgba(50,80,140,0.95)');
            bg.addColorStop(1, 'rgba(25,45,90,0.95)');
        }
        ctx.fillStyle = bg;
        ctx.fill();
        ctx.restore();

        // 상단 하이라이트 (광택)
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        drawRoundRect(boxX, boxY, boxW, boxH * 0.4, { tl: boxH / 2, tr: boxH / 2, bl: 0, br: 0 });
        ctx.fill();

        // 외곽 테두리 (부드러운 액센트)
        ctx.strokeStyle = isStart ? 'rgba(160,255,180,0.6)' : 'rgba(150,200,255,0.55)';
        ctx.lineWidth = 1.5;
        drawRoundRect(boxX, boxY, boxW, boxH, boxH / 2);
        ctx.stroke();

        // 그룹(아이콘 + 메인 라벨)을 박스 중앙 정렬
        const groupStartX = boxX + boxW / 2 - groupW / 2;
        const iconCX = groupStartX + iconW / 2;
        const iconCY = boxY + boxH * 0.42;
        ctx.save();
        const tr = iconW * 0.4;
        ctx.beginPath();
        ctx.moveTo(iconCX - tr * 0.5, iconCY - tr * 0.9);
        ctx.lineTo(iconCX + tr, iconCY);
        ctx.lineTo(iconCX - tr * 0.5, iconCY + tr * 0.9);
        ctx.closePath();
        // 외곽선 + 글로우 (메인 라벨과 통일)
        ctx.shadowColor = isStart ? 'rgba(0,40,15,0.9)' : 'rgba(10,25,55,0.9)';
        ctx.shadowBlur = 6;
        ctx.strokeStyle = isStart ? '#0c2a14' : '#0a1a2e';
        ctx.lineWidth = 4;
        ctx.lineJoin = 'round';
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.restore();

        // 메인 라벨 (그룹의 우측 부분 — left-align, 외곽선 + 글로우)
        const textX = groupStartX + iconW + iconLabelGap;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = `900 ${mainFS}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        ctx.shadowColor = isStart ? 'rgba(0,40,15,0.9)' : 'rgba(10,25,55,0.9)';
        ctx.shadowBlur = 6;
        ctx.strokeStyle = isStart ? '#0c2a14' : '#0a1a2e';
        ctx.lineWidth = 4;
        ctx.lineJoin = 'round';
        ctx.strokeText(mainLabel, textX, boxY + boxH * 0.42);
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(mainLabel, textX, boxY + boxH * 0.42);

        // 힌트 라벨 (박스 중앙 하단 — center-align)
        ctx.fillStyle = isStart ? 'rgba(200,255,220,0.75)' : 'rgba(200,220,255,0.75)';
        ctx.font = `${hintFS}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(hintLabel, boxX + boxW / 2, boxY + boxH * 0.78);

        ctx.textBaseline = 'alphabetic';
    }

    // Game over overlay — 모던 UI
    if (gameOver) {
        const got = gameOverTimer;
        // 부드러운 라디얼 어둠 (중앙은 살짝 어둡고, 가장자리 더 진함)
        const darkAlpha = Math.min(0.78, got * 1.4);
        const vignette = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.2, W / 2, H / 2, Math.max(W, H) * 0.7);
        vignette.addColorStop(0, `rgba(5,8,20,${darkAlpha * 0.75})`);
        vignette.addColorStop(1, `rgba(0,0,5,${darkAlpha})`);
        ctx.fillStyle = vignette;
        ctx.fillRect(0, 0, W, H);

        // 중앙 모달 패널 크기/위치 계산
        const panelW = Math.min(W * 0.85, TILE * 10);
        const panelH = Math.min(H * 0.7, TILE * 7.5);
        const panelX = W / 2 - panelW / 2;
        const panelY = H / 2 - panelH / 2;

        // 패널 Fade-in
        const panelT = Math.min(1, got / 0.6);
        if (got > 0.3) {
            ctx.save();
            ctx.globalAlpha = panelT;
            // 패널 그림자
            ctx.shadowColor = 'rgba(0,0,0,0.8)';
            ctx.shadowBlur = 30;
            drawRoundRect(panelX, panelY, panelW, panelH, 18);
            const panelGrad = ctx.createLinearGradient(0, panelY, 0, panelY + panelH);
            panelGrad.addColorStop(0, 'rgba(30,34,60,0.98)');
            panelGrad.addColorStop(1, 'rgba(15,18,38,0.98)');
            ctx.fillStyle = panelGrad;
            ctx.fill();
            ctx.restore();

            // 테두리 + 상단 액센트
            ctx.save();
            ctx.globalAlpha = panelT;
            ctx.strokeStyle = 'rgba(255,80,80,0.5)';
            ctx.lineWidth = 2;
            drawRoundRect(panelX, panelY, panelW, panelH, 18);
            ctx.stroke();
            // 상단 빨간 라인
            ctx.fillStyle = 'rgba(255,70,70,0.65)';
            drawRoundRect(panelX, panelY, panelW, 4, { tl: 18, tr: 18, bl: 0, br: 0 });
            ctx.fill();
            // 상단 광택
            ctx.fillStyle = 'rgba(255,255,255,0.04)';
            drawRoundRect(panelX, panelY, panelW, panelH * 0.35, { tl: 18, tr: 18, bl: 0, br: 0 });
            ctx.fill();
            ctx.restore();
        }

        // GAME OVER 타이틀 (scale-in + 글로우 + 그라디언트)
        if (got > 0.5) {
            const textT = Math.min(1, (got - 0.5) / 0.35);
            const scale = 0.55 + textT * 0.45;
            ctx.save();
            ctx.translate(W / 2, panelY + panelH * 0.16);
            ctx.scale(scale, scale);
            ctx.globalAlpha = textT;
            ctx.shadowColor = '#ff4040';
            ctx.shadowBlur = 30;
            // 빨강→진빨강 그라디언트
            const titleGrad = ctx.createLinearGradient(0, -TILE * 0.5, 0, TILE * 0.5);
            titleGrad.addColorStop(0, '#ff6060');
            titleGrad.addColorStop(1, '#cc2828');
            ctx.fillStyle = titleGrad;
            ctx.font = `900 ${Math.floor(TILE * 0.85)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(txt().gameOver, 0, 0);
            ctx.restore();
            ctx.globalAlpha = 1;
        }

        // 점수 카드
        if (got > 1.0) {
            const cardT = Math.min(1, (got - 1.0) / 0.4);
            const scoreT = Math.min(1, (got - 1.2) / 0.8);
            const displayScore = Math.floor(score * scoreT);

            // 점수 카드 (패널 안 중앙)
            const cardW = panelW * 0.75;
            const cardH = TILE * 1.7;
            const cardX = W / 2 - cardW / 2;
            const cardY = panelY + panelH * 0.32;

            ctx.save();
            ctx.globalAlpha = cardT;
            drawRoundRect(cardX, cardY, cardW, cardH, 12);
            const cardGrad = ctx.createLinearGradient(0, cardY, 0, cardY + cardH);
            cardGrad.addColorStop(0, 'rgba(50,55,90,0.6)');
            cardGrad.addColorStop(1, 'rgba(25,30,55,0.6)');
            ctx.fillStyle = cardGrad;
            ctx.fill();
            ctx.strokeStyle = 'rgba(120,160,220,0.3)';
            ctx.lineWidth = 1;
            drawRoundRect(cardX, cardY, cardW, cardH, 12);
            ctx.stroke();

            // 카드 내부 2분할: 웨이브 / 점수
            const half = cardW / 2;
            const labelColor = '#aab4d0';
            const valueColor = '#ffffff';

            // 웨이브
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = labelColor;
            ctx.font = `${Math.floor(TILE * 0.22)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
            ctx.fillText(lang === 'ko' ? '웨이브' : 'WAVE', cardX + half * 0.5, cardY + cardH * 0.3);
            ctx.fillStyle = '#88ccff';
            ctx.font = `bold ${Math.floor(TILE * 0.55)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
            ctx.fillText(fmt(wave), cardX + half * 0.5, cardY + cardH * 0.65);

            // 세로 구분선
            ctx.strokeStyle = 'rgba(120,160,220,0.25)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(cardX + half, cardY + cardH * 0.2);
            ctx.lineTo(cardX + half, cardY + cardH * 0.8);
            ctx.stroke();

            // 점수
            ctx.fillStyle = labelColor;
            ctx.font = `${Math.floor(TILE * 0.22)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
            ctx.fillText(lang === 'ko' ? '점수' : 'SCORE', cardX + half + half * 0.5, cardY + cardH * 0.3);
            ctx.fillStyle = '#ffdd44';
            ctx.font = `bold ${Math.floor(TILE * 0.55)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
            ctx.fillText(fmt(displayScore), cardX + half + half * 0.5, cardY + cardH * 0.65);
            ctx.restore();

            // 최고 점수 (카드 아래 작은 뱃지)
            let hs = 0;
            try { hs = parseInt(localStorage.getItem('td_highscore') || '0', 10); } catch(e) {}
            const isNewHigh = score > hs;
            if (isNewHigh && scoreT > 0.9) {
                try { localStorage.setItem('td_highscore', score); } catch(e) {}
            }
            const hsY = cardY + cardH + TILE * 0.3;
            ctx.save();
            ctx.globalAlpha = cardT;
            if (isNewHigh) {
                ctx.shadowColor = '#ffcc44';
                ctx.shadowBlur = 10 + Math.sin(Date.now() / 200) * 5;
                ctx.fillStyle = '#ffdd55';
                ctx.font = `bold ${Math.floor(TILE * 0.32)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
                ctx.textAlign = 'center';
                ctx.fillText('🏆 ' + txt().newHighScore.replace(/🏆\s*/, ''), W / 2, hsY);
            } else {
                ctx.fillStyle = '#8890a8';
                ctx.font = `${Math.floor(TILE * 0.26)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
                ctx.textAlign = 'center';
                ctx.fillText(txt().highScore(hs), W / 2, hsY);
            }
            ctx.restore();
        }

        // 버튼 영역
        if (got > 1.8) {
            const btnsT = Math.min(1, (got - 1.8) / 0.4);
            const btnW = panelW * 0.75;
            const btnH = Math.max(44, Math.floor(TILE * 0.9));
            const btnX = W / 2 - btnW / 2;
            const btnsY = panelY + panelH * 0.68;
            const btnGapV = Math.max(10, Math.floor(TILE * 0.18));

            ctx.save();
            ctx.globalAlpha = btnsT;

            // 공통 CTA 버튼 렌더링
            function drawCTA(bx, by, bw, bh, variant, icon, label, pulse) {
                let bgA, bgB, borderColor, textColor, glow;
                if (variant === 'revive') {
                    bgA = 'rgba(70,160,80,0.95)';
                    bgB = 'rgba(40,110,50,0.95)';
                    borderColor = 'rgba(140,255,150,0.7)';
                    textColor = '#ffffff';
                    glow = 'rgba(70,220,100,0.5)';
                } else {
                    bgA = 'rgba(55,90,150,0.95)';
                    bgB = 'rgba(30,55,100,0.95)';
                    borderColor = 'rgba(140,200,255,0.65)';
                    textColor = '#ffffff';
                    glow = 'rgba(100,180,255,0.45)';
                }
                // 그림자 + 글로우
                ctx.save();
                ctx.shadowColor = glow;
                ctx.shadowBlur = 14 + (pulse ? Math.sin(Date.now() / 300) * 6 : 0);
                drawRoundRect(bx, by, bw, bh, bh / 2);
                const g = ctx.createLinearGradient(0, by, 0, by + bh);
                g.addColorStop(0, bgA);
                g.addColorStop(1, bgB);
                ctx.fillStyle = g;
                ctx.fill();
                ctx.restore();
                // 테두리
                ctx.strokeStyle = borderColor;
                ctx.lineWidth = 1.5;
                drawRoundRect(bx, by, bw, bh, bh / 2);
                ctx.stroke();
                // 상단 하이라이트
                ctx.fillStyle = 'rgba(255,255,255,0.18)';
                drawRoundRect(bx, by, bw, bh * 0.45, { tl: bh / 2, tr: bh / 2, bl: 0, br: 0 });
                ctx.fill();
                // 아이콘 + 라벨 (중앙)
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = textColor;
                ctx.font = `bold ${Math.floor(TILE * 0.32)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
                const fullText = (icon ? icon + '  ' : '') + label;
                ctx.fillText(fullText, bx + bw / 2, by + bh / 2 + 1);
            }

            if (showRewardedAdOption) {
                // 부활 CTA (위, 맥박)
                drawCTA(btnX, btnsY, btnW, btnH, 'revive', '🎬',
                    lang === 'ko' ? '광고 보고 부활 +5HP' : 'Watch Ad · +5 HP', true);
                window._rewardedAdBtn = { x: btnX, y: btnsY, w: btnW, h: btnH };
                addPointerHotspot(btnX, btnsY, btnW, btnH);

                // 재시작 CTA (아래)
                const rstY = btnsY + btnH + btnGapV;
                drawCTA(btnX, rstY, btnW, btnH, 'restart', '↻', txt().restartBtn, false);
                window._restartBtn = { x: btnX, y: rstY, w: btnW, h: btnH };
                addPointerHotspot(btnX, rstY, btnW, btnH);
            } else {
                window._rewardedAdBtn = null;
                // 재시작만 (맥박)
                drawCTA(btnX, btnsY, btnW, btnH, 'restart', '↻', txt().restartBtn, true);
                window._restartBtn = { x: btnX, y: btnsY, w: btnW, h: btnH };
                addPointerHotspot(btnX, btnsY, btnW, btnH);
            }
            ctx.restore();
        }
    }

    // Pause 오버레이
    if (paused && !gameOver) {
        ctx.fillStyle = 'rgba(5,8,20,0.5)';
        ctx.fillRect(0, 0, W, H);
        ctx.font = `900 ${Math.floor(TILE * 0.7)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const pauseLabel = '⏸  ' + (lang === 'ko' ? '일시정지' : 'PAUSED');
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 12;
        ctx.strokeStyle = '#1a1a22';
        ctx.lineWidth = 5;
        ctx.lineJoin = 'round';
        ctx.strokeText(pauseLabel, W / 2, H * 0.4);
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(pauseLabel, W / 2, H * 0.4);
        ctx.font = `bold ${Math.floor(TILE * 0.28)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        ctx.fillStyle = '#aab4d0';
        ctx.fillText(lang === 'ko' ? 'P 키로 재개' : 'Press P to resume', W / 2, H * 0.48);
    }

    // 단축키 도움말 오버레이 (H 키)
    if (showHelp) {
        const isKo = lang === 'ko';
        const rows = [
            ['1 - 5', isKo ? '타워 선택 / 토글' : 'Select / toggle tower'],
            ['0  /  `', isKo ? '선택 해제' : 'Deselect'],
            ['Q', isKo ? '게임 속도 변경 (×1/×2/×3)' : 'Cycle game speed'],
            ['Space  /  Enter', isKo ? '시작 / 다음 웨이브 스킵' : 'Start / skip wave'],
            ['P', isKo ? '일시정지' : 'Pause'],
            ['U', isKo ? '선택 타워 업그레이드' : 'Upgrade selected tower'],
            ['S', isKo ? '선택 타워 판매' : 'Sell selected tower'],
            ['M', isKo ? '음소거' : 'Mute / unmute'],
            ['L', isKo ? '언어 전환 (한 / EN)' : 'Toggle language'],
            ['Esc  /  우클릭', isKo ? '선택 해제 / 패널 닫기' : 'Cancel / close'],
            ['H  /  ?', isKo ? '단축키 도움말 토글' : 'Toggle this help'],
        ];

        // 라디얼 비네트 (어둡게)
        const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.15, W / 2, H / 2, Math.max(W, H) * 0.7);
        vg.addColorStop(0, 'rgba(5,8,20,0.7)');
        vg.addColorStop(1, 'rgba(0,0,5,0.85)');
        ctx.fillStyle = vg;
        ctx.fillRect(0, 0, W, H);

        // 측정 → 패널 크기 결정
        const titleFs = Math.floor(TILE * 0.42);
        const rowFs = Math.floor(TILE * 0.26);
        const keyFont = `900 ${rowFs}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        const labelFont = `${rowFs}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        ctx.font = keyFont;
        let maxKeyW = 0;
        for (const r of rows) maxKeyW = Math.max(maxKeyW, ctx.measureText(r[0]).width);
        ctx.font = labelFont;
        let maxLabelW = 0;
        for (const r of rows) maxLabelW = Math.max(maxLabelW, ctx.measureText(r[1]).width);
        const colGap = Math.max(20, Math.floor(TILE * 0.4));
        const rowH = rowFs + 12;
        const panelPad = Math.max(20, Math.floor(TILE * 0.5));
        const panelW = Math.min(W * 0.9, maxKeyW + colGap + maxLabelW + panelPad * 2);
        const panelH = panelPad * 2 + titleFs + 14 + rows.length * rowH + 30;
        const panelX = W / 2 - panelW / 2;
        const panelY = H / 2 - panelH / 2;

        // 패널 배경 + 테두리 (Game Over 모달 톤)
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 30;
        drawRoundRect(panelX, panelY, panelW, panelH, 18);
        const pgrad = ctx.createLinearGradient(0, panelY, 0, panelY + panelH);
        pgrad.addColorStop(0, 'rgba(30,34,60,0.97)');
        pgrad.addColorStop(1, 'rgba(15,18,38,0.97)');
        ctx.fillStyle = pgrad;
        ctx.fill();
        ctx.restore();
        ctx.strokeStyle = 'rgba(120,180,255,0.5)';
        ctx.lineWidth = 2;
        drawRoundRect(panelX, panelY, panelW, panelH, 18);
        ctx.stroke();
        // 상단 액센트 라인
        ctx.fillStyle = 'rgba(120,180,255,0.55)';
        drawRoundRect(panelX, panelY, panelW, 4, { tl: 18, tr: 18, bl: 0, br: 0 });
        ctx.fill();

        // 타이틀
        ctx.fillStyle = '#ffffff';
        ctx.font = `900 ${titleFs}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.shadowColor = 'rgba(120,180,255,0.6)';
        ctx.shadowBlur = 10;
        ctx.fillText(isKo ? '단축키' : 'Shortcuts', W / 2, panelY + panelPad);
        ctx.shadowBlur = 0;

        // 행 그리기
        const rowStartY = panelY + panelPad + titleFs + 18;
        const keyColX = panelX + panelPad;
        const labelColX = keyColX + maxKeyW + colGap;
        ctx.textBaseline = 'middle';
        for (let ri = 0; ri < rows.length; ri++) {
            const ry = rowStartY + ri * rowH + rowH / 2;
            // 키 (강조)
            ctx.font = keyFont;
            ctx.fillStyle = '#ffd84a';
            ctx.textAlign = 'left';
            ctx.fillText(rows[ri][0], keyColX, ry);
            // 라벨
            ctx.font = labelFont;
            ctx.fillStyle = '#cfd8ec';
            ctx.fillText(rows[ri][1], labelColX, ry);
        }

        // 닫기 안내
        ctx.font = `${Math.floor(TILE * 0.22)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(170,180,210,0.7)';
        ctx.textAlign = 'center';
        ctx.fillText(isKo ? 'H / Esc / 클릭으로 닫기' : 'Press H / Esc / click to close',
            W / 2, panelY + panelH - panelPad * 0.6);

        ctx.textBaseline = 'alphabetic';

        // 패널 영역을 클릭 가능 hotspot으로 등록 (커서 pointer)
        addPointerHotspot(panelX, panelY, panelW, panelH);
    }

    // Rotate overlay (portrait mobile)
    if (showRotateOverlay) {
        ctx.fillStyle = 'rgba(0,0,0,0.85)';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#88ccff';
        ctx.font = `${Math.floor(Math.min(W, H) * 0.12)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('📱', W / 2, H * 0.38);
        ctx.font = `bold ${Math.floor(Math.min(W, H) * 0.045)}px "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`;
        ctx.fillText(txt().rotatePlease, W / 2, H * 0.53);
    }

    // 그리기 완료 후 hotspot 변화 반영 (예: 패널 열림/닫힘)
    updateCursor();
}

// ---- Draw tower body (레벨별 진화 시각) ----
function drawTowerBody(x, y, s, typeIndex, angle, level) {
    level = level || 1;
    const isMax = level >= 5;

    // Lv5 최종진화 오라 (몸체보다 먼저, 뒤쪽)
    if (isMax) {
        const auraColors = ['#ffd84a', '#ff6a22', '#88e0ff', '#ffee55', '#66ff44'];
        const auraColor = auraColors[typeIndex];
        const pulse = 0.7 + Math.sin(Date.now() / 250) * 0.3;
        ctx.globalAlpha = 0.15 * pulse;
        ctx.fillStyle = auraColor;
        ctx.beginPath();
        ctx.arc(x, y, s * 1.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.25 * pulse;
        ctx.beginPath();
        ctx.arc(x, y, s * 1.0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
    }

    // (공통 돌 베이스 제거 — 타워별 받침대로만 표현)

    if (typeIndex === 0) {
        // === 석궁 타워 (Crossbow) ===
        // 돌 받침대
        ctx.fillStyle = '#555560';
        ctx.strokeStyle = '#1a1a22';
        ctx.lineWidth = Math.max(2, s * 0.07);
        drawRoundRect(x - s * 0.4, y + s * 0.05, s * 0.8, s * 0.45, s * 0.08);
        ctx.fill();
        ctx.stroke();
        // 받침대 하이라이트
        ctx.fillStyle = '#7a7a88';
        ctx.fillRect(x - s * 0.36, y + s * 0.09, s * 0.72, s * 0.08);
        // Lv4+ 돌 기단 추가 레이어
        if (level >= 4) {
            ctx.fillStyle = '#40404a';
            ctx.fillRect(x - s * 0.48, y + s * 0.42, s * 0.96, s * 0.1);
            ctx.strokeStyle = '#1a1a22';
            ctx.lineWidth = 1;
            ctx.strokeRect(x - s * 0.48, y + s * 0.42, s * 0.96, s * 0.1);
        }

        // 석궁 본체 (회전)
        ctx.save();
        ctx.translate(x, y - s * 0.1);
        ctx.rotate(angle);

        // Stock 색상
        const stockBody = isMax ? '#d6a050' : level >= 3 ? '#a87238' : '#8a5830';
        const stockEdge = isMax ? '#6a4010' : '#3a1a08';

        // Lv5 스톡 보석 베이스 글로우
        if (isMax) {
            ctx.fillStyle = 'rgba(255,216,74,0.2)';
            ctx.beginPath();
            ctx.ellipse(0, 0, s * 0.55, s * 0.2, 0, 0, Math.PI * 2);
            ctx.fill();
        }

        // Stock (수평 나무 몸체)
        ctx.fillStyle = stockBody;
        ctx.strokeStyle = stockEdge;
        ctx.lineWidth = Math.max(2, s * 0.07);
        drawRoundRect(-s * 0.4, -s * 0.1, s * 0.7, s * 0.2, s * 0.04);
        ctx.fill();
        ctx.stroke();
        // Stock 홈 (볼트 가이드)
        ctx.strokeStyle = stockEdge;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(-s * 0.35, 0);
        ctx.lineTo(s * 0.25, 0);
        ctx.stroke();

        // Lv4+ 금속 보강 (스톡 중앙 띠)
        if (level >= 4) {
            ctx.fillStyle = isMax ? '#ffd84a' : '#80808a';
            ctx.fillRect(-s * 0.18, -s * 0.12, s * 0.1, s * 0.24);
            ctx.strokeStyle = stockEdge;
            ctx.lineWidth = 1;
            ctx.strokeRect(-s * 0.18, -s * 0.12, s * 0.1, s * 0.24);
        }

        // 트리거 (뒤쪽 하단)
        ctx.fillStyle = '#2a2a30';
        ctx.beginPath();
        ctx.moveTo(-s * 0.25, s * 0.1);
        ctx.lineTo(-s * 0.18, s * 0.22);
        ctx.lineTo(-s * 0.12, s * 0.1);
        ctx.closePath();
        ctx.fill();

        // 프로드 (활 부분) — 앞쪽에 수직으로 큰 C자
        const prodR = level >= 4 ? s * 0.42 : level >= 2 ? s * 0.38 : s * 0.34;
        const prodLW = Math.max(3, s * (level >= 4 ? 0.14 : level >= 2 ? 0.12 : 0.1));
        const prodX = s * 0.15;

        // Lv5 프로드 외곽 금색 글로우
        if (isMax) {
            ctx.strokeStyle = '#ffd84a';
            ctx.lineWidth = prodLW + 3;
            ctx.lineCap = 'round';
            ctx.globalAlpha = 0.4;
            ctx.beginPath();
            ctx.moveTo(prodX - s * 0.05, -prodR);
            ctx.quadraticCurveTo(prodX + s * 0.22, 0, prodX - s * 0.05, prodR);
            ctx.stroke();
            ctx.globalAlpha = 1;
        }

        // 프로드 본체
        ctx.strokeStyle = isMax ? '#6a4010' : level >= 3 ? '#2a0a00' : '#3a1a08';
        ctx.lineWidth = prodLW;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(prodX - s * 0.05, -prodR);
        ctx.quadraticCurveTo(prodX + s * 0.22, 0, prodX - s * 0.05, prodR);
        ctx.stroke();
        // 프로드 하이라이트
        if (isMax) {
            ctx.strokeStyle = '#ffd84a';
            ctx.lineWidth = prodLW * 0.4;
            ctx.beginPath();
            ctx.moveTo(prodX - s * 0.05, -prodR);
            ctx.quadraticCurveTo(prodX + s * 0.22, 0, prodX - s * 0.05, prodR);
            ctx.stroke();
        }

        // 활줄 (당겨진 상태 — V자)
        ctx.strokeStyle = '#f0e8c0';
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(prodX - s * 0.05, -prodR);
        ctx.lineTo(-s * 0.1, 0);
        ctx.lineTo(prodX - s * 0.05, prodR);
        ctx.stroke();

        // 볼트(화살) — Lv4+ 더블 볼트
        const boltCount = level >= 4 ? 2 : 1;
        for (let bi = 0; bi < boltCount; bi++) {
            const yOff = boltCount === 2 ? (bi === 0 ? -s * 0.07 : s * 0.07) : 0;
            // 볼트 대
            ctx.strokeStyle = '#c89058';
            ctx.lineWidth = Math.max(1.8, s * 0.06);
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(-s * 0.25, yOff);
            ctx.lineTo(s * 0.42, yOff);
            ctx.stroke();
            // 깃털 (꼬리)
            ctx.fillStyle = isMax ? '#ffd84a' : level >= 3 ? '#aaffaa' : '#c0c0c8';
            ctx.beginPath();
            ctx.moveTo(-s * 0.3, yOff);
            ctx.lineTo(-s * 0.22, yOff - s * 0.06);
            ctx.lineTo(-s * 0.18, yOff);
            ctx.lineTo(-s * 0.22, yOff + s * 0.06);
            ctx.closePath();
            ctx.fill();
            // 촉 (뾰족한 삼각)
            ctx.fillStyle = isMax ? '#ff4040' : level >= 3 ? '#aaff88' : '#cfff66';
            ctx.strokeStyle = isMax ? '#8a0000' : '#2a5a10';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(s * 0.55, yOff);
            ctx.lineTo(s * 0.4, yOff - s * 0.09);
            ctx.lineTo(s * 0.4, yOff + s * 0.09);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        }

        ctx.restore();

        // Lv5 석궁 보석 (받침대 중앙)
        if (isMax) {
            ctx.fillStyle = '#ff2020';
            ctx.beginPath();
            ctx.arc(x, y + s * 0.27, s * 0.06, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(x - s * 0.015, y + s * 0.255, s * 0.022, 0, Math.PI * 2);
            ctx.fill();
        }

    } else if (typeIndex === 1) {
        // === 대포 타워 (둥근 클래식) ===
        // Lv1: 작은 둥근 대포. Lv2-3: 밴드/길이 ↑. Lv4: 2중 포신. Lv5: 황금 + 화염 포구
        const mountColor = isMax ? '#6a4a20' : '#3a3a48';
        const mountEdge = isMax ? '#2a1000' : '#1a1a22';
        // 마운트 받침 (원형) — 타워 중심과 동심
        ctx.fillStyle = mountColor;
        ctx.strokeStyle = mountEdge;
        ctx.lineWidth = Math.max(2, s * 0.08);
        ctx.beginPath();
        ctx.arc(x, y, s * 0.55, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // 받침 상단 하이라이트 (살짝 위쪽으로 올림)
        ctx.fillStyle = isMax ? '#b08040' : '#5a5a68';
        ctx.beginPath();
        ctx.ellipse(x, y - s * 0.08, s * 0.5, s * 0.14, 0, 0, Math.PI * 2);
        ctx.fill();
        // Lv4+ 받침 리벳 (장식) — 중심 기준 방사형
        if (level >= 4) {
            ctx.fillStyle = isMax ? '#ffd84a' : '#80808a';
            for (let i = 0; i < 4; i++) {
                const ang = (i / 4) * Math.PI * 2 + Math.PI / 4;
                ctx.beginPath();
                ctx.arc(x + Math.cos(ang) * s * 0.43, y + Math.sin(ang) * s * 0.43, s * 0.045, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // 대포 본체 (회전)
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);

        const barrelCount = level >= 4 ? 2 : 1;
        const bLen = level >= 3 ? s * 0.8 : level >= 2 ? s * 0.7 : s * 0.6;
        const bRad = level >= 3 ? s * 0.22 : level >= 2 ? s * 0.2 : s * 0.18;

        for (let bi = 0; bi < barrelCount; bi++) {
            const yOff = barrelCount === 2 ? (bi === 0 ? -s * 0.22 : s * 0.22) : 0;

            // 둥근 대포 몸체 — 뒷부분 큰 원 + 앞쪽 포신 원통
            const backR = bRad * 1.35;
            // 뒷부분 (큰 원)
            ctx.fillStyle = isMax ? '#3a2810' : '#1a1a22';
            ctx.strokeStyle = isMax ? '#8a5400' : '#0a0a10';
            ctx.lineWidth = Math.max(2, s * 0.07);
            ctx.beginPath();
            ctx.arc(0, yOff, backR, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            // 포신 (둥근 사각 원통)
            ctx.fillStyle = isMax ? '#3a2810' : '#2a2a32';
            drawRoundRect(0, yOff - bRad, bLen, bRad * 2, bRad * 0.3);
            ctx.fill();
            ctx.stroke();
            // 포신 상단 하이라이트
            ctx.fillStyle = isMax ? '#8a5418' : '#4a4a55';
            ctx.fillRect(0, yOff - bRad + 1, bLen, bRad * 0.35);
            // 밴드 (금속 띠)
            ctx.strokeStyle = isMax ? '#ffd84a' : '#80808a';
            ctx.lineWidth = Math.max(1.5, s * 0.04);
            const bandN = level >= 3 ? 3 : level >= 2 ? 2 : 1;
            for (let bd = 0; bd < bandN; bd++) {
                const bx = bLen * (0.25 + bd * (0.55 / Math.max(1, bandN - 1)));
                ctx.beginPath();
                ctx.moveTo(bx, yOff - bRad);
                ctx.lineTo(bx, yOff + bRad);
                ctx.stroke();
            }

            // 포구 (앞쪽)
            if (isMax) {
                // Lv5: 화염 분출 + 황금 테두리
                ctx.fillStyle = '#ffaa44';
                ctx.beginPath();
                ctx.arc(bLen, yOff, bRad * 1.2, -Math.PI / 2, Math.PI / 2);
                ctx.fill();
                ctx.fillStyle = '#ff4020';
                ctx.beginPath();
                ctx.arc(bLen, yOff, bRad * 0.85, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#0a0000';
                ctx.beginPath();
                ctx.arc(bLen, yOff, bRad * 0.5, 0, Math.PI * 2);
                ctx.fill();
                // 황금 링
                ctx.strokeStyle = '#ffd84a';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(bLen, yOff, bRad * 0.95, 0, Math.PI * 2);
                ctx.stroke();
            } else {
                // 일반 포구 (검은 구멍)
                ctx.fillStyle = '#40404a';
                ctx.beginPath();
                ctx.arc(bLen, yOff, bRad * 0.9, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = mountEdge;
                ctx.lineWidth = 1.5;
                ctx.stroke();
                ctx.fillStyle = '#0a0a0a';
                ctx.beginPath();
                ctx.arc(bLen, yOff, bRad * 0.55, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // 포신 기저 (중앙 허브)
        ctx.fillStyle = isMax ? '#ffd84a' : '#3a3a48';
        ctx.strokeStyle = mountEdge;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(0, 0, s * 0.15, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (isMax) {
            ctx.fillStyle = '#ff4020';
            ctx.beginPath();
            ctx.arc(0, 0, s * 0.07, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.restore();

    } else if (typeIndex === 3) {
        // === 얼음 타워 ===
        // Lv1: 기본 크리스털. Lv2-3: 기둥 커짐. Lv4: 궤도 조각. Lv5: 왕관 결정 + 빛 오라
        // 바닥 얼음 링
        ctx.fillStyle = isMax ? '#a8d0f0' : '#5080a8';
        ctx.beginPath();
        ctx.ellipse(x, y + s * 0.4, s * 0.7, s * 0.2, 0, 0, Math.PI * 2);
        ctx.fill();
        // Lv4+ 궤도 얼음 조각 (4~6개)
        if (level >= 4) {
            const shardCount = level >= 5 ? 6 : 4;
            const orbitPh = Date.now() / 1500;
            ctx.fillStyle = isMax ? '#e0f0ff' : '#a0d0e8';
            ctx.strokeStyle = '#2a5080';
            ctx.lineWidth = 1;
            for (let si = 0; si < shardCount; si++) {
                const a = (si / shardCount) * Math.PI * 2 + orbitPh;
                const ox = x + Math.cos(a) * s * 0.9;
                const oy = y + Math.sin(a) * s * 0.9 * 0.5; // 납작 궤도
                ctx.beginPath();
                ctx.moveTo(ox, oy - s * 0.08);
                ctx.lineTo(ox - s * 0.05, oy);
                ctx.lineTo(ox, oy + s * 0.08);
                ctx.lineTo(ox + s * 0.05, oy);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
            }
        }
        // 크리스털 기둥 (6각)
        const crystalColor = isMax ? '#a8e0ff' : level >= 3 ? '#7ac0e8' : '#6ab0dc';
        ctx.fillStyle = crystalColor;
        ctx.strokeStyle = isMax ? '#3a6090' : '#1a4060';
        ctx.lineWidth = Math.max(2, s * 0.07);
        const pillarTop = level >= 3 ? -s * 0.55 : -s * 0.45;
        ctx.beginPath();
        ctx.moveTo(x - s * 0.3, y + s * 0.4);
        ctx.lineTo(x - s * 0.4, y);
        ctx.lineTo(x - s * 0.25, y + pillarTop);
        ctx.lineTo(x + s * 0.25, y + pillarTop);
        ctx.lineTo(x + s * 0.4, y);
        ctx.lineTo(x + s * 0.3, y + s * 0.4);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // 크리스털 면 하이라이트
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath();
        ctx.moveTo(x - s * 0.25, y + pillarTop);
        ctx.lineTo(x - s * 0.3, y + s * 0.2);
        ctx.lineTo(x - s * 0.1, y + s * 0.3);
        ctx.lineTo(x - s * 0.1, y + pillarTop);
        ctx.closePath();
        ctx.fill();
        // 기둥 눈송이 (Lv2+)
        if (level >= 2) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.2;
            ctx.lineCap = 'round';
            const snowY = y + (pillarTop + s * 0.4) / 2;
            for (let si = 0; si < 3; si++) {
                const a = (si / 3) * Math.PI;
                ctx.beginPath();
                ctx.moveTo(x + Math.cos(a) * s * 0.08, snowY + Math.sin(a) * s * 0.08);
                ctx.lineTo(x - Math.cos(a) * s * 0.08, snowY - Math.sin(a) * s * 0.08);
                ctx.stroke();
            }
        }
        // 상단 결정 (레벨 따라 커짐)
        const topR = isMax ? s * 0.35 : level >= 3 ? s * 0.28 : s * 0.22;
        const topY = y + pillarTop - topR * 0.3;
        ctx.save();
        ctx.translate(x, topY);
        ctx.rotate(angle);
        // Lv5 = 왕관 결정 (여러 뿔)
        if (isMax) {
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = '#3a6090';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(0, -topR);
            ctx.lineTo(-topR * 0.8, -topR * 0.2);
            ctx.lineTo(-topR * 0.5, 0);
            ctx.lineTo(-topR * 0.3, topR * 0.5);
            ctx.lineTo(0, topR);
            ctx.lineTo(topR * 0.3, topR * 0.5);
            ctx.lineTo(topR * 0.5, 0);
            ctx.lineTo(topR * 0.8, -topR * 0.2);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            // 중앙 파랑 코어
            ctx.fillStyle = '#4aa8ff';
            ctx.beginPath();
            ctx.arc(0, 0, topR * 0.3, 0, Math.PI * 2);
            ctx.fill();
        } else {
            // 다이아몬드 결정
            ctx.fillStyle = '#b0e8ff';
            ctx.strokeStyle = '#2a5080';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(0, -topR);
            ctx.lineTo(-topR * 0.7, 0);
            ctx.lineTo(0, topR);
            ctx.lineTo(topR * 0.7, 0);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.moveTo(0, -topR * 0.7);
            ctx.lineTo(-topR * 0.3, 0);
            ctx.lineTo(0, topR * 0.2);
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();

    } else if (typeIndex === 2) {
        // === 번개 타워 — 레벨마다 극적 변화 ===
        const pulse = 0.7 + Math.sin(Date.now() / 150) * 0.3;

        if (level === 1) {
            // Lv1: 단순 금속 막대 + 작은 오브
            // 얇은 기둥
            ctx.fillStyle = '#707080';
            ctx.strokeStyle = '#1a1a22';
            ctx.lineWidth = 2;
            ctx.fillRect(x - s * 0.12, y - s * 0.3, s * 0.24, s * 0.7);
            ctx.strokeRect(x - s * 0.12, y - s * 0.3, s * 0.24, s * 0.7);
            // 상단 전극
            ctx.fillStyle = '#a0a0b0';
            drawRoundRect(x - s * 0.18, y - s * 0.38, s * 0.36, s * 0.12, 3);
            ctx.fill();
            ctx.stroke();
            // 작은 오브
            ctx.globalAlpha = 0.4 * pulse;
            ctx.fillStyle = '#ffff88';
            ctx.beginPath();
            ctx.arc(x, y - s * 0.5, s * 0.2, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.fillStyle = '#ffffcc';
            ctx.beginPath();
            ctx.arc(x, y - s * 0.5, s * 0.12 * pulse, 0, Math.PI * 2);
            ctx.fill();

        } else if (level === 2) {
            // Lv2: 테슬라 코일 (가로 링 3개 + 중간 오브)
            // 베이스 코일 몸체
            ctx.fillStyle = '#909098';
            ctx.strokeStyle = '#1a1a22';
            ctx.lineWidth = 2;
            drawRoundRect(x - s * 0.3, y - s * 0.2, s * 0.6, s * 0.7, s * 0.1);
            ctx.fill();
            ctx.stroke();
            // 코일 링 3개 (가로 타원)
            for (let i = 0; i < 3; i++) {
                const yy = y - s * 0.1 + i * s * 0.2;
                ctx.fillStyle = '#606068';
                ctx.beginPath();
                ctx.ellipse(x, yy, s * 0.32, s * 0.06, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#80808a';
                ctx.beginPath();
                ctx.ellipse(x, yy - 1, s * 0.3, s * 0.04, 0, 0, Math.PI * 2);
                ctx.fill();
            }
            // 상단 오브
            ctx.globalAlpha = 0.4 * pulse;
            ctx.fillStyle = '#ffff88';
            ctx.beginPath();
            ctx.arc(x, y - s * 0.5, s * 0.3, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 0.8;
            ctx.beginPath();
            ctx.arc(x, y - s * 0.5, s * 0.2, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(x, y - s * 0.5, s * 0.1 * pulse, 0, Math.PI * 2);
            ctx.fill();

        } else if (level === 3) {
            // Lv3: 쌍기둥 + 가운데 아크 + 큰 오브
            // 좌우 2개 기둥
            ctx.fillStyle = '#707080';
            ctx.strokeStyle = '#1a1a22';
            ctx.lineWidth = 2;
            ctx.fillRect(x - s * 0.45, y - s * 0.2, s * 0.18, s * 0.7);
            ctx.strokeRect(x - s * 0.45, y - s * 0.2, s * 0.18, s * 0.7);
            ctx.fillRect(x + s * 0.27, y - s * 0.2, s * 0.18, s * 0.7);
            ctx.strokeRect(x + s * 0.27, y - s * 0.2, s * 0.18, s * 0.7);
            // 기둥 상단 캡
            ctx.fillStyle = '#ffcc44';
            ctx.beginPath();
            ctx.arc(x - s * 0.36, y - s * 0.2, s * 0.08, 0, Math.PI * 2);
            ctx.arc(x + s * 0.36, y - s * 0.2, s * 0.08, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            // 기둥 사이 아크 (수평 지그재그)
            ctx.strokeStyle = 'rgba(255,255,140,0.8)';
            ctx.lineWidth = 1.5;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(x - s * 0.32, y - s * 0.2);
            for (let i = 1; i < 4; i++) {
                const t = i / 4;
                ctx.lineTo(x - s * 0.32 + t * s * 0.64 + (Math.random() - 0.5) * 4, y - s * 0.2 + (Math.random() - 0.5) * 4);
            }
            ctx.lineTo(x + s * 0.32, y - s * 0.2);
            ctx.stroke();
            // 중앙 기둥 받침
            ctx.fillStyle = '#40404a';
            drawRoundRect(x - s * 0.2, y + s * 0.3, s * 0.4, s * 0.2, 3);
            ctx.fill();
            ctx.strokeStyle = '#1a1a22';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            // 큰 중앙 오브 (기둥 사이 상단)
            ctx.globalAlpha = 0.35 * pulse;
            ctx.fillStyle = '#ffff88';
            ctx.beginPath();
            ctx.arc(x, y - s * 0.4, s * 0.36, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 0.7 * pulse;
            ctx.beginPath();
            ctx.arc(x, y - s * 0.4, s * 0.24, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(x, y - s * 0.4, s * 0.14 * pulse, 0, Math.PI * 2);
            ctx.fill();

        } else if (level === 4) {
            // Lv4: 삼각 크라운 + 3개 전극 + 중앙 오브
            // 베이스 (돌 받침)
            ctx.fillStyle = '#5a5a68';
            ctx.strokeStyle = '#1a1a22';
            ctx.lineWidth = 2;
            drawRoundRect(x - s * 0.35, y + s * 0.2, s * 0.7, s * 0.28, s * 0.06);
            ctx.fill();
            ctx.stroke();
            // 중앙 기둥
            ctx.fillStyle = '#808090';
            ctx.fillRect(x - s * 0.1, y - s * 0.1, s * 0.2, s * 0.35);
            ctx.strokeRect(x - s * 0.1, y - s * 0.1, s * 0.2, s * 0.35);
            // 3개 전극 크라운 (상단 방사형)
            const electrodeAngles = [-Math.PI / 2, -Math.PI / 2 - 0.7, -Math.PI / 2 + 0.7];
            for (const ea of electrodeAngles) {
                const ex = x + Math.cos(ea) * s * 0.4;
                const ey = y - s * 0.1 + Math.sin(ea) * s * 0.4;
                ctx.strokeStyle = '#909098';
                ctx.lineWidth = Math.max(3, s * 0.09);
                ctx.lineCap = 'round';
                ctx.beginPath();
                ctx.moveTo(x, y - s * 0.1);
                ctx.lineTo(ex, ey);
                ctx.stroke();
                // 전극 끝 (작은 오브)
                ctx.fillStyle = '#ffcc44';
                ctx.beginPath();
                ctx.arc(ex, ey, s * 0.09, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.arc(ex - 1, ey - 1, s * 0.04, 0, Math.PI * 2);
                ctx.fill();
            }
            // 중앙 오브 (큰)
            const orbY4 = y - s * 0.1;
            ctx.globalAlpha = 0.35 * pulse;
            ctx.fillStyle = '#ffff88';
            ctx.beginPath();
            ctx.arc(x, orbY4, s * 0.32, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 0.7 * pulse;
            ctx.beginPath();
            ctx.arc(x, orbY4, s * 0.22, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(x, orbY4, s * 0.11 * pulse, 0, Math.PI * 2);
            ctx.fill();
            // 중앙→전극 아크 (간헐적)
            if (Math.sin(Date.now() / 120) > 0.3) {
                ctx.strokeStyle = 'rgba(255,255,160,0.7)';
                ctx.lineWidth = 1.5;
                for (const ea of electrodeAngles) {
                    const ex = x + Math.cos(ea) * s * 0.4;
                    const ey = y - s * 0.1 + Math.sin(ea) * s * 0.4;
                    ctx.beginPath();
                    ctx.moveTo(x, orbY4);
                    ctx.lineTo(ex + (Math.random() - 0.5) * 3, ey + (Math.random() - 0.5) * 3);
                    ctx.stroke();
                }
            }

        } else {
            // Lv5: 폭풍 오벨리스크 — 8각 기둥 + 거대 상단 오브 + 궤도 오브 + 지속 아크
            // 거대 외곽 오라
            ctx.globalAlpha = 0.18 * pulse;
            ctx.fillStyle = '#ffee55';
            ctx.beginPath();
            ctx.arc(x, y - s * 0.3, s * 1.1, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            // 8각 오벨리스크 (끝이 뾰족)
            ctx.fillStyle = '#8a6020';
            ctx.strokeStyle = '#3a1a00';
            ctx.lineWidth = Math.max(2.5, s * 0.08);
            ctx.beginPath();
            ctx.moveTo(x, y - s * 0.7);   // 꼭대기
            ctx.lineTo(x + s * 0.28, y - s * 0.45);
            ctx.lineTo(x + s * 0.35, y + s * 0.45);
            ctx.lineTo(x - s * 0.35, y + s * 0.45);
            ctx.lineTo(x - s * 0.28, y - s * 0.45);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            // 오벨리스크 중앙 하이라이트 라인
            ctx.fillStyle = '#ffd84a';
            ctx.fillRect(x - s * 0.05, y - s * 0.5, s * 0.1, s * 0.95);
            // 오벨리스크 룬 (가로 홈 3개)
            ctx.strokeStyle = '#3a1a00';
            ctx.lineWidth = 1.5;
            for (let i = 0; i < 3; i++) {
                const yy = y - s * 0.25 + i * s * 0.25;
                ctx.beginPath();
                ctx.moveTo(x - s * 0.2, yy);
                ctx.lineTo(x + s * 0.2, yy);
                ctx.stroke();
            }
            // 상단 거대 오브 (오벨리스크 꼭대기)
            const bigR = s * 0.38;
            ctx.globalAlpha = 0.3 * pulse;
            ctx.fillStyle = '#ffff88';
            ctx.beginPath();
            ctx.arc(x, y - s * 0.8, bigR * 1.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 0.7 * pulse;
            ctx.beginPath();
            ctx.arc(x, y - s * 0.8, bigR, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(x, y - s * 0.8, bigR * 0.5 * pulse, 0, Math.PI * 2);
            ctx.fill();
            // 궤도 위성 오브 4개
            const satPh = Date.now() / 500;
            for (let si = 0; si < 4; si++) {
                const sa = (si / 4) * Math.PI * 2 + satPh;
                const sox = x + Math.cos(sa) * s * 0.7;
                const soy = y - s * 0.4 + Math.sin(sa) * s * 0.25;
                ctx.globalAlpha = 0.7;
                ctx.fillStyle = '#ffcc44';
                ctx.beginPath();
                ctx.arc(sox, soy, s * 0.12, 0, Math.PI * 2);
                ctx.fill();
                ctx.globalAlpha = 1;
                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.arc(sox, soy, s * 0.06, 0, Math.PI * 2);
                ctx.fill();
                // 아크
                ctx.strokeStyle = 'rgba(255,255,180,0.6)';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(x, y - s * 0.8);
                ctx.lineTo(
                    x + (sox - x) * 0.5 + (Math.random() - 0.5) * 4,
                    y - s * 0.8 + (soy - (y - s * 0.8)) * 0.5 + (Math.random() - 0.5) * 4
                );
                ctx.lineTo(sox, soy);
                ctx.stroke();
            }
        }

    } else if (typeIndex === 4) {
        // === 독 타워 ===
        // Lv1: 기본 가마솥. Lv2-3: 거품 증가. Lv4: 해골 장식. Lv5: 녹색 불꽃 + 뼈 장식
        // 받침대 다리
        ctx.fillStyle = '#2a2a30';
        ctx.fillRect(x - s * 0.4, y + s * 0.25, s * 0.12, s * 0.3);
        ctx.fillRect(x + s * 0.28, y + s * 0.25, s * 0.12, s * 0.3);
        // Lv5 녹색 불꽃 (솥 아래)
        if (isMax) {
            const fPh = Date.now() / 150;
            ctx.fillStyle = 'rgba(80,255,40,0.7)';
            for (let fi = 0; fi < 3; fi++) {
                const fx = x - s * 0.2 + fi * s * 0.2;
                const fh = s * 0.2 + Math.sin(fPh + fi) * s * 0.06;
                ctx.beginPath();
                ctx.moveTo(fx - s * 0.06, y + s * 0.55);
                ctx.quadraticCurveTo(fx, y + s * 0.55 - fh, fx + s * 0.06, y + s * 0.55);
                ctx.closePath();
                ctx.fill();
            }
            ctx.fillStyle = 'rgba(160,255,100,0.6)';
            for (let fi = 0; fi < 3; fi++) {
                const fx = x - s * 0.2 + fi * s * 0.2;
                const fh = s * 0.12 + Math.sin(fPh + fi + 1) * s * 0.04;
                ctx.beginPath();
                ctx.moveTo(fx - s * 0.03, y + s * 0.55);
                ctx.quadraticCurveTo(fx, y + s * 0.55 - fh, fx + s * 0.03, y + s * 0.55);
                ctx.closePath();
                ctx.fill();
            }
        }
        // 솥 몸체
        ctx.fillStyle = isMax ? '#30202a' : '#1a1a22';
        ctx.strokeStyle = isMax ? '#8a3a90' : '#0a0a10';
        ctx.lineWidth = Math.max(2, s * 0.08);
        ctx.beginPath();
        ctx.arc(x, y, s * 0.55, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // Lv4+ 해골 장식 (솥 정면)
        if (level >= 4) {
            const skullY = y + s * 0.1;
            ctx.fillStyle = '#e8e0cc';
            ctx.beginPath();
            ctx.arc(x, skullY, s * 0.1, 0, Math.PI * 2);
            ctx.fill();
            // 눈구멍
            ctx.fillStyle = '#000';
            ctx.beginPath();
            ctx.arc(x - s * 0.04, skullY - s * 0.01, s * 0.022, 0, Math.PI * 2);
            ctx.arc(x + s * 0.04, skullY - s * 0.01, s * 0.022, 0, Math.PI * 2);
            ctx.fill();
            // 코
            ctx.fillStyle = '#000';
            ctx.fillRect(x - s * 0.01, skullY + s * 0.02, s * 0.02, s * 0.025);
        }
        // 솥 테두리
        ctx.fillStyle = isMax ? '#60306a' : '#40404a';
        ctx.strokeStyle = isMax ? '#2a0030' : '#0a0a10';
        ctx.lineWidth = Math.max(1.5, s * 0.06);
        ctx.beginPath();
        ctx.ellipse(x, y - s * 0.4, s * 0.6, s * 0.14, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // 독액
        ctx.fillStyle = isMax ? '#40d020' : '#2ea028';
        ctx.beginPath();
        ctx.ellipse(x, y - s * 0.4, s * 0.48, s * 0.1, 0, 0, Math.PI * 2);
        ctx.fill();
        // 거품 (레벨에 따라 수 증가)
        const bPh = Date.now() / 250;
        const bubbleCount = level >= 3 ? 5 : 3;
        const allBubbles = [
            { dx: -0.2, dy: -0.42, r: 0.08, phase: 0 },
            { dx: 0.1, dy: -0.44, r: 0.06, phase: 1.5 },
            { dx: 0.25, dy: -0.4, r: 0.05, phase: 3 },
            { dx: -0.05, dy: -0.42, r: 0.07, phase: 2.2 },
            { dx: 0.18, dy: -0.44, r: 0.05, phase: 0.8 },
        ];
        ctx.fillStyle = isMax ? '#ccffaa' : '#8aff50';
        for (let bi = 0; bi < bubbleCount; bi++) {
            const b = allBubbles[bi];
            const pop = (Math.sin(bPh + b.phase) + 1) * 0.5;
            ctx.globalAlpha = 0.5 + pop * 0.5;
            ctx.beginPath();
            ctx.arc(x + b.dx * s, y + b.dy * s - pop * s * 0.08, s * b.r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
        // Lv5 뼈 장식 (솥 위 교차 뼈)
        if (isMax) {
            ctx.strokeStyle = '#e8e0cc';
            ctx.lineWidth = Math.max(2, s * 0.06);
            ctx.lineCap = 'round';
            // 왼쪽 뼈
            ctx.beginPath();
            ctx.moveTo(x - s * 0.48, y - s * 0.32);
            ctx.lineTo(x - s * 0.3, y - s * 0.52);
            ctx.stroke();
            // 오른쪽 뼈
            ctx.beginPath();
            ctx.moveTo(x + s * 0.48, y - s * 0.32);
            ctx.lineTo(x + s * 0.3, y - s * 0.52);
            ctx.stroke();
            // 뼈 끝 (원형)
            ctx.fillStyle = '#e8e0cc';
            ctx.beginPath();
            ctx.arc(x - s * 0.5, y - s * 0.3, s * 0.04, 0, Math.PI * 2);
            ctx.arc(x - s * 0.28, y - s * 0.54, s * 0.04, 0, Math.PI * 2);
            ctx.arc(x + s * 0.5, y - s * 0.3, s * 0.04, 0, Math.PI * 2);
            ctx.arc(x + s * 0.28, y - s * 0.54, s * 0.04, 0, Math.PI * 2);
            ctx.fill();
        }
        // 독 증기 (레벨에 따라 진해짐)
        const vaporAlpha = isMax ? 0.45 : level >= 3 ? 0.3 : 0.25;
        ctx.fillStyle = `rgba(120,255,80,${vaporAlpha})`;
        ctx.beginPath();
        ctx.arc(x - s * 0.1, y - s * 0.7 + Math.sin(bPh) * 3, s * 0.1, 0, Math.PI * 2);
        ctx.arc(x + s * 0.1, y - s * 0.75 + Math.sin(bPh + 1) * 3, s * 0.08, 0, Math.PI * 2);
        ctx.fill();
    }
}

// ---- Draw tower at position ----
function drawTowerAt(x, y, typeIndex, level, angle) {
    const s = TILE * 0.62;
    const a = angle || 0;

    // 배치 하이라이트 (살짝 밝은 원)
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.beginPath();
    ctx.arc(x, y, s * 1.0, 0, Math.PI * 2);
    ctx.fill();

    // 타워 본체 (레벨별 진화)
    drawTowerBody(x, y, s, typeIndex, a, level);
}

// ---- Draw tower icon for UI buttons ----
function drawTowerIcon(x, y, typeIndex, scale) {
    const s = 18 * (scale || 1);
    drawTowerBody(x, y, s, typeIndex, -Math.PI / 4, 1);
}

// ---- Draw enemy shape (세균/바이러스 테마 — 무서운 실루엣) ----
function drawEnemyShape(cx, cy, s, type, flash, phase) {
    phase = phase || 0;
    if (type === 'normal') {
        // 슬라임 — 젤리 방울 몸 + 균등 scale 펄스(0.95~1.10, 객체별 위상)
        const tPh = Date.now() / 700 + phase;
        const scale = 1.025 + Math.sin(tPh) * 0.075;  // 0.95 ~ 1.10
        const ss = s * scale;
        // 슬라임 몸 path — 메타몽 스타일 둥근 모양 (펄스 + 살짝 가로 타원)
        const drawBody = () => {
            ctx.beginPath();
            ctx.ellipse(cx, cy, ss * 0.92, ss * 0.85, 0, 0, Math.PI * 2);
        };
        if (flash) {
            ctx.fillStyle = '#ffffff';
            drawBody();
            ctx.fill();
            return;
        }
        // 몸통 (라디얼 그라디언트로 입체감, 펄스 적용)
        const bodyGrad = ctx.createRadialGradient(
            cx - ss * 0.25, cy - ss * 0.3, ss * 0.1,
            cx, cy, ss * 1.0
        );
        bodyGrad.addColorStop(0, '#a8e878');
        bodyGrad.addColorStop(0.6, '#4ea838');
        bodyGrad.addColorStop(1, '#235818');
        ctx.fillStyle = bodyGrad;
        ctx.strokeStyle = '#1a4010';
        ctx.lineWidth = Math.max(2, ss * 0.07);
        drawBody();
        ctx.fill();
        ctx.stroke();
        // 광택 하이라이트 (왼쪽 위)
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.beginPath();
        ctx.ellipse(cx - ss * 0.32, cy - ss * 0.4, ss * 0.14, ss * 0.24, -0.4, 0, Math.PI * 2);
        ctx.fill();
        // 눈 흰자 (한 path 다중 arc)
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(cx - ss * 0.25, cy - ss * 0.05, ss * 0.18, 0, Math.PI * 2);
        ctx.arc(cx + ss * 0.25, cy - ss * 0.05, ss * 0.18, 0, Math.PI * 2);
        ctx.fill();
        // 동공 (검정)
        ctx.fillStyle = '#1a1a1a';
        ctx.beginPath();
        ctx.arc(cx - ss * 0.22, cy - ss * 0.02, ss * 0.09, 0, Math.PI * 2);
        ctx.arc(cx + ss * 0.28, cy - ss * 0.02, ss * 0.09, 0, Math.PI * 2);
        ctx.fill();
        // 동공 하이라이트
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(cx - ss * 0.2, cy - ss * 0.05, ss * 0.035, 0, Math.PI * 2);
        ctx.arc(cx + ss * 0.3, cy - ss * 0.05, ss * 0.035, 0, Math.PI * 2);
        ctx.fill();
        // 헤벌쭉 미소 (호)
        ctx.strokeStyle = '#1a3010';
        ctx.lineWidth = Math.max(2, ss * 0.06);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(cx, cy + ss * 0.22, ss * 0.18, 0.15, Math.PI - 0.15);
        ctx.stroke();

    } else if (type === 'swarm') {
        // 쥐 — 향상된 디자인: 주둥이 분리 + 그라디언트 몸 + 눈 디테일 + 발 + 정돈된 수염
        const fur = flash ? '#ffffff' : '#7a6d62';
        const furDark = flash ? '#ccc' : '#3a302a';
        const furLight = flash ? '#fff' : '#a89a8c';
        const pink = flash ? '#fcc' : '#d68088';
        const tPh = Date.now() / 220;
        // 꼬리 (곡선, 흔들림 + 끝부분 얇아짐)
        ctx.strokeStyle = pink;
        ctx.lineWidth = Math.max(2, s * 0.13);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.55, cy + s * 0.3);
        ctx.quadraticCurveTo(
            cx - s * 1.15, cy + Math.sin(tPh) * s * 0.12,
            cx - s * 1.4, cy + s * 0.25
        );
        ctx.stroke();
        // 꼬리 끝 (얇은 stroke)
        ctx.lineWidth = Math.max(1, s * 0.07);
        ctx.beginPath();
        ctx.moveTo(cx - s * 1.3, cy + s * 0.25);
        ctx.lineTo(cx - s * 1.55, cy + s * 0.3);
        ctx.stroke();
        if (flash) {
            // 플래시: 단순 실루엣 (몸 + 주둥이)
            ctx.fillStyle = fur;
            ctx.beginPath();
            ctx.ellipse(cx - s * 0.1, cy, s * 0.85, s * 0.6, 0, 0, Math.PI * 2);
            ctx.ellipse(cx + s * 0.55, cy + s * 0.1, s * 0.4, s * 0.3, 0, 0, Math.PI * 2);
            ctx.fill();
            return;
        }
        // 발 4개 (몸 아래, 한 path)
        ctx.fillStyle = pink;
        ctx.beginPath();
        ctx.arc(cx - s * 0.45, cy + s * 0.55, s * 0.1, 0, Math.PI * 2);
        ctx.arc(cx - s * 0.15, cy + s * 0.6, s * 0.1, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.2, cy + s * 0.6, s * 0.1, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.5, cy + s * 0.55, s * 0.1, 0, Math.PI * 2);
        ctx.fill();
        // 몸통 (라디얼 그라디언트 — 한 번)
        const bodyGrad = ctx.createRadialGradient(
            cx - s * 0.25, cy - s * 0.25, s * 0.1,
            cx - s * 0.1, cy, s * 0.95
        );
        bodyGrad.addColorStop(0, furLight);
        bodyGrad.addColorStop(1, fur);
        ctx.fillStyle = bodyGrad;
        ctx.strokeStyle = furDark;
        ctx.lineWidth = Math.max(1.5, s * 0.07);
        ctx.beginPath();
        ctx.ellipse(cx - s * 0.1, cy, s * 0.85, s * 0.6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // 배 (옅은 밝은 타원)
        ctx.fillStyle = 'rgba(255,240,220,0.3)';
        ctx.beginPath();
        ctx.ellipse(cx - s * 0.1, cy + s * 0.2, s * 0.55, s * 0.28, 0, 0, Math.PI * 2);
        ctx.fill();
        // 두 귀 외곽 (어두운 색, 한 path)
        ctx.fillStyle = furDark;
        ctx.beginPath();
        ctx.arc(cx - s * 0.45, cy - s * 0.5, s * 0.22, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.05, cy - s * 0.55, s * 0.22, 0, Math.PI * 2);
        ctx.fill();
        // 귀 내부 (분홍, 한 path)
        ctx.fillStyle = pink;
        ctx.beginPath();
        ctx.arc(cx - s * 0.43, cy - s * 0.47, s * 0.12, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.07, cy - s * 0.52, s * 0.12, 0, Math.PI * 2);
        ctx.fill();
        // 주둥이 (앞쪽 튀어나온 작은 타원, 밝은 톤)
        ctx.fillStyle = furLight;
        ctx.strokeStyle = furDark;
        ctx.lineWidth = Math.max(1, s * 0.05);
        ctx.beginPath();
        ctx.ellipse(cx + s * 0.55, cy + s * 0.1, s * 0.38, s * 0.3, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // 눈 흰자 (한 path)
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(cx - s * 0.18, cy - s * 0.08, s * 0.11, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.27, cy - s * 0.13, s * 0.11, 0, Math.PI * 2);
        ctx.fill();
        // 동공
        ctx.fillStyle = '#1a0808';
        ctx.beginPath();
        ctx.arc(cx - s * 0.16, cy - s * 0.06, s * 0.06, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.29, cy - s * 0.11, s * 0.06, 0, Math.PI * 2);
        ctx.fill();
        // 하이라이트
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(cx - s * 0.14, cy - s * 0.08, s * 0.022, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.31, cy - s * 0.13, s * 0.022, 0, Math.PI * 2);
        ctx.fill();
        // 코 (분홍 점, 주둥이 끝)
        ctx.fillStyle = '#d24858';
        ctx.beginPath();
        ctx.arc(cx + s * 0.88, cy + s * 0.05, s * 0.08, 0, Math.PI * 2);
        ctx.fill();
        // 입 선 (코 아래 갈라짐)
        ctx.strokeStyle = '#3a1a1a';
        ctx.lineWidth = Math.max(1, s * 0.03);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx + s * 0.88, cy + s * 0.13);
        ctx.lineTo(cx + s * 0.72, cy + s * 0.22);
        ctx.lineTo(cx + s * 0.55, cy + s * 0.18);
        ctx.stroke();
        // 수염 (좌우 4개, 한 path)
        ctx.strokeStyle = '#3a2a20';
        ctx.lineWidth = Math.max(1, s * 0.022);
        ctx.beginPath();
        ctx.moveTo(cx + s * 0.4, cy + s * 0.08);  ctx.lineTo(cx + s * 0.05, cy + s * 0.15);
        ctx.moveTo(cx + s * 0.4, cy + s * 0.13);  ctx.lineTo(cx + s * 0.05, cy + s * 0.25);
        ctx.moveTo(cx + s * 0.85, cy + s * 0.18); ctx.lineTo(cx + s * 1.2, cy + s * 0.25);
        ctx.moveTo(cx + s * 0.85, cy + s * 0.23); ctx.lineTo(cx + s * 1.2, cy + s * 0.38);
        ctx.stroke();

    } else if (type === 'fast') {
        // 늑대 — 그라디언트 몸 + 갈기 + 주둥이 분리 + 귀 안쪽 + 눈 3겹 + 발 + 송곳니
        const fur = flash ? '#ffffff' : '#888';
        const furDark = flash ? '#ddd' : '#3a3438';
        const furLight = flash ? '#fff' : '#aaa6a8';
        const earPink = flash ? '#fcc' : '#a85868';
        const tPh = Date.now() / 200;
        // 꼬리 (메인 곡선, 흔들림)
        const tailWag = Math.sin(tPh) * 0.2;
        ctx.strokeStyle = furDark;
        ctx.lineWidth = Math.max(2, s * 0.18);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.7, cy);
        ctx.quadraticCurveTo(
            cx - s * 1.15, cy - s * (0.3 + tailWag),
            cx - s * 1.4, cy - s * (0.55 + tailWag)
        );
        ctx.stroke();
        // 꼬리 끝 (가는 stroke)
        ctx.lineWidth = Math.max(1, s * 0.1);
        ctx.beginPath();
        ctx.moveTo(cx - s * 1.32, cy - s * (0.5 + tailWag));
        ctx.lineTo(cx - s * 1.5, cy - s * (0.7 + tailWag));
        ctx.stroke();
        // 다리 4개 (달리는 흔들림) — 한 path stroke
        ctx.strokeStyle = furDark;
        ctx.lineWidth = Math.max(2, s * 0.13);
        const legPh = tPh * 0.6;
        const legSwings = [];
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
            const lx = cx + (i < 2 ? -s * 0.5 : s * 0.5);
            const baseY = cy + s * 0.35;
            const swing = Math.sin(legPh + i * Math.PI * 0.5) * s * 0.18;
            legSwings.push({ x: lx + swing, y: baseY + s * 0.32 });
            ctx.moveTo(lx, baseY);
            ctx.lineTo(lx + swing, baseY + s * 0.32);
        }
        ctx.stroke();
        // 발 4개 (다리 끝 둥근)
        ctx.fillStyle = furDark;
        ctx.beginPath();
        for (const ls of legSwings) ctx.arc(ls.x, ls.y, s * 0.07, 0, Math.PI * 2);
        ctx.fill();
        if (flash) {
            ctx.fillStyle = fur;
            ctx.beginPath();
            ctx.ellipse(cx, cy, s * 1.0, s * 0.5, 0, 0, Math.PI * 2);
            ctx.arc(cx + s * 0.7, cy - s * 0.1, s * 0.5, 0, Math.PI * 2);
            ctx.fill();
            return;
        }
        // 몸통 (라디얼 그라디언트로 입체감)
        const bodyGrad = ctx.createRadialGradient(
            cx - s * 0.2, cy - s * 0.3, s * 0.1,
            cx, cy, s * 1.1
        );
        bodyGrad.addColorStop(0, furLight);
        bodyGrad.addColorStop(1, fur);
        ctx.fillStyle = bodyGrad;
        ctx.strokeStyle = furDark;
        ctx.lineWidth = Math.max(2, s * 0.07);
        ctx.beginPath();
        ctx.ellipse(cx, cy, s * 1.0, s * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // 배 (옅은 밝은 띠)
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.beginPath();
        ctx.ellipse(cx, cy + s * 0.18, s * 0.7, s * 0.22, 0, 0, Math.PI * 2);
        ctx.fill();
        // 갈기 (목 부분 어두운 털)
        ctx.fillStyle = furDark;
        ctx.beginPath();
        ctx.ellipse(cx + s * 0.32, cy - s * 0.25, s * 0.3, s * 0.16, -0.3, 0, Math.PI * 2);
        ctx.fill();
        // 머리 (앞쪽, 그라디언트)
        ctx.fillStyle = bodyGrad;
        ctx.strokeStyle = furDark;
        ctx.lineWidth = Math.max(2, s * 0.07);
        ctx.beginPath();
        ctx.arc(cx + s * 0.7, cy - s * 0.1, s * 0.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // 주둥이 (앞쪽 어두운 타원)
        ctx.fillStyle = furDark;
        ctx.beginPath();
        ctx.ellipse(cx + s * 1.05, cy + s * 0.08, s * 0.22, s * 0.16, 0, 0, Math.PI * 2);
        ctx.fill();
        // 귀 외곽 (두 개, 한 path)
        ctx.fillStyle = furDark;
        ctx.beginPath();
        ctx.moveTo(cx + s * 0.5, cy - s * 0.45);
        ctx.lineTo(cx + s * 0.4, cy - s * 0.85);
        ctx.lineTo(cx + s * 0.62, cy - s * 0.55);
        ctx.closePath();
        ctx.moveTo(cx + s * 0.85, cy - s * 0.45);
        ctx.lineTo(cx + s * 0.95, cy - s * 0.85);
        ctx.lineTo(cx + s * 0.73, cy - s * 0.55);
        ctx.closePath();
        ctx.fill();
        // 귀 안쪽 (분홍, 한 path)
        ctx.fillStyle = earPink;
        ctx.beginPath();
        ctx.moveTo(cx + s * 0.48, cy - s * 0.55);
        ctx.lineTo(cx + s * 0.46, cy - s * 0.78);
        ctx.lineTo(cx + s * 0.58, cy - s * 0.6);
        ctx.closePath();
        ctx.moveTo(cx + s * 0.87, cy - s * 0.55);
        ctx.lineTo(cx + s * 0.89, cy - s * 0.78);
        ctx.lineTo(cx + s * 0.77, cy - s * 0.6);
        ctx.closePath();
        ctx.fill();
        // 눈 흰자 (한 path)
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(cx + s * 0.55, cy - s * 0.2, s * 0.1, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.85, cy - s * 0.2, s * 0.1, 0, Math.PI * 2);
        ctx.fill();
        // 눈 동공 (노랑 — 늑대 황금 눈)
        ctx.fillStyle = '#ffaa20';
        ctx.beginPath();
        ctx.arc(cx + s * 0.55, cy - s * 0.18, s * 0.07, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.85, cy - s * 0.18, s * 0.07, 0, Math.PI * 2);
        ctx.fill();
        // 동공 (검정 + 하이라이트)
        ctx.fillStyle = '#1a0a0a';
        ctx.beginPath();
        ctx.arc(cx + s * 0.55, cy - s * 0.17, s * 0.035, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.85, cy - s * 0.17, s * 0.035, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(cx + s * 0.57, cy - s * 0.2, s * 0.018, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.87, cy - s * 0.2, s * 0.018, 0, Math.PI * 2);
        ctx.fill();
        // 코 (검정 점)
        ctx.fillStyle = '#1a0a0a';
        ctx.beginPath();
        ctx.arc(cx + s * 1.22, cy + s * 0.0, s * 0.09, 0, Math.PI * 2);
        ctx.fill();
        // 입 라인 (코 아래 갈라짐)
        ctx.strokeStyle = '#1a0a0a';
        ctx.lineWidth = Math.max(1, s * 0.03);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx + s * 1.22, cy + s * 0.08);
        ctx.lineTo(cx + s * 1.05, cy + s * 0.18);
        ctx.lineTo(cx + s * 0.92, cy + s * 0.13);
        ctx.stroke();
        // 송곳니 두 개 (한 path)
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.moveTo(cx + s * 0.96, cy + s * 0.13);
        ctx.lineTo(cx + s * 1.0, cy + s * 0.28);
        ctx.lineTo(cx + s * 1.05, cy + s * 0.13);
        ctx.closePath();
        ctx.moveTo(cx + s * 1.07, cy + s * 0.13);
        ctx.lineTo(cx + s * 1.11, cy + s * 0.28);
        ctx.lineTo(cx + s * 1.16, cy + s * 0.13);
        ctx.closePath();
        ctx.fill();

    } else if (type === 'tank') {
        // 모아이 석상 — 단순화: 둥근 직사각 머리 + 깊은 눈 + 큰 코 + 굳은 입
        const stone = flash ? '#ffffff' : '#9a948c';
        const stoneDark = flash ? '#ccc' : '#3a3530';
        const stoneShadow = flash ? '#aaa' : '#1a1410';
        // 머리 (둥근 모서리 직사각형 — 모아이 정면 실루엣)
        const left = cx - s * 0.7;
        const right = cx + s * 0.7;
        const top = cy - s * 0.95;
        const bottom = cy + s * 0.95;
        const cR = s * 0.15;
        const drawHead = () => {
            ctx.beginPath();
            ctx.moveTo(left + cR, top);
            ctx.lineTo(right - cR, top);
            ctx.quadraticCurveTo(right, top, right, top + cR);
            ctx.lineTo(right, bottom - cR);
            ctx.quadraticCurveTo(right, bottom, right - cR, bottom);
            ctx.lineTo(left + cR, bottom);
            ctx.quadraticCurveTo(left, bottom, left, bottom - cR);
            ctx.lineTo(left, top + cR);
            ctx.quadraticCurveTo(left, top, left + cR, top);
            ctx.closePath();
        };
        if (flash) {
            ctx.fillStyle = '#ffffff';
            drawHead();
            ctx.fill();
            return;
        }
        ctx.fillStyle = stone;
        ctx.strokeStyle = stoneDark;
        ctx.lineWidth = Math.max(2.5, s * 0.08);
        drawHead();
        ctx.fill();
        ctx.stroke();
        // 깊은 눈 두 개 (검정 가로 사각형 그늘)
        ctx.fillStyle = stoneShadow;
        ctx.fillRect(cx - s * 0.45, cy - s * 0.3, s * 0.3, s * 0.18);
        ctx.fillRect(cx + s * 0.15, cy - s * 0.3, s * 0.3, s * 0.18);
        // 큰 코 (사다리꼴)
        ctx.fillStyle = stoneDark;
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.1, cy - s * 0.05);
        ctx.lineTo(cx + s * 0.1, cy - s * 0.05);
        ctx.lineTo(cx + s * 0.18, cy + s * 0.4);
        ctx.lineTo(cx - s * 0.18, cy + s * 0.4);
        ctx.closePath();
        ctx.fill();
        // 입 (굳게 다문 가로 직선)
        ctx.strokeStyle = stoneShadow;
        ctx.lineWidth = Math.max(2, s * 0.08);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.3, cy + s * 0.65);
        ctx.lineTo(cx + s * 0.3, cy + s * 0.65);
        ctx.stroke();

    } else if (type === 'boss') {
        // 드래곤 — 빨간 몸 + 뿔 2개 + 송곳니 + 빛나는 눈 + 등 가시 + 날개
        const body = flash ? '#ffffff' : '#9a1818';
        const dark = flash ? '#ddd' : '#2a0404';
        const wing = flash ? '#aaa' : '#5a0a0a';
        const tPh = Date.now() / 400;
        // 날개 (양쪽 펼침, 펄럭임)
        const flap = Math.sin(tPh * 1.5) * 0.2;
        ctx.fillStyle = wing;
        ctx.strokeStyle = dark;
        ctx.lineWidth = Math.max(3, s * 0.08);
        // 왼쪽 날개
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.4, cy - s * 0.2);
        ctx.quadraticCurveTo(cx - s * 1.5, cy - s * (0.7 + flap), cx - s * 1.65, cy - s * 0.05);
        ctx.quadraticCurveTo(cx - s * 1.4, cy + s * 0.4, cx - s * 0.4, cy + s * 0.2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // 오른쪽 날개
        ctx.beginPath();
        ctx.moveTo(cx + s * 0.4, cy - s * 0.2);
        ctx.quadraticCurveTo(cx + s * 1.5, cy - s * (0.7 + flap), cx + s * 1.65, cy - s * 0.05);
        ctx.quadraticCurveTo(cx + s * 1.4, cy + s * 0.4, cx + s * 0.4, cy + s * 0.2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // 등 가시 5개 (위쪽)
        ctx.fillStyle = dark;
        for (let i = 0; i < 5; i++) {
            const sx = cx + (i - 2) * s * 0.32;
            const h = i === 2 ? s * 0.55 : s * (0.35 + (2 - Math.abs(i - 2)) * 0.06);
            ctx.beginPath();
            ctx.moveTo(sx - s * 0.1, cy - s * 0.5);
            ctx.lineTo(sx, cy - s * 0.5 - h);
            ctx.lineTo(sx + s * 0.1, cy - s * 0.5);
            ctx.closePath();
            ctx.fill();
        }
        // 몸통 (큰 둥근, 박동)
        const pulse = 1 + Math.sin(Date.now() / 300) * 0.04;
        ctx.fillStyle = body;
        ctx.strokeStyle = dark;
        ctx.lineWidth = Math.max(4, s * 0.1);
        ctx.beginPath();
        ctx.arc(cx, cy, s * 0.85 * pulse, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (flash) return;
        // 비늘 패턴 (작은 V자)
        ctx.strokeStyle = dark;
        ctx.lineWidth = Math.max(1, s * 0.04);
        for (let i = 0; i < 3; i++) {
            const sy = cy - s * 0.15 + i * s * 0.25;
            for (let j = 0; j < 3; j++) {
                const sx = cx - s * 0.3 + j * s * 0.3;
                ctx.beginPath();
                ctx.moveTo(sx - s * 0.1, sy);
                ctx.lineTo(sx, sy + s * 0.08);
                ctx.lineTo(sx + s * 0.1, sy);
                ctx.stroke();
            }
        }
        // 뿔 2개 (위)
        ctx.fillStyle = '#ccbb88';
        ctx.strokeStyle = dark;
        ctx.lineWidth = Math.max(2, s * 0.05);
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.45, cy - s * 0.55);
        ctx.lineTo(cx - s * 0.7, cy - s * 1.05);
        ctx.lineTo(cx - s * 0.3, cy - s * 0.4);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx + s * 0.45, cy - s * 0.55);
        ctx.lineTo(cx + s * 0.7, cy - s * 1.05);
        ctx.lineTo(cx + s * 0.3, cy - s * 0.4);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // 빛나는 눈 두 개 (노랑 + 빨강 동공)
        ctx.fillStyle = '#ffe040';
        ctx.beginPath();
        ctx.arc(cx - s * 0.28, cy - s * 0.15, s * 0.16, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.28, cy - s * 0.15, s * 0.16, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ff1010';
        ctx.beginPath();
        ctx.arc(cx - s * 0.28, cy - s * 0.13, s * 0.09, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.28, cy - s * 0.13, s * 0.09, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(cx - s * 0.28, cy - s * 0.13, s * 0.04, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.28, cy - s * 0.13, s * 0.04, 0, Math.PI * 2);
        ctx.fill();
        // 입 (어두운 타원 + 송곳니)
        ctx.fillStyle = '#0a0000';
        ctx.beginPath();
        ctx.ellipse(cx, cy + s * 0.35, s * 0.4, s * 0.15, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        for (let f = 0; f < 4; f++) {
            const fx = cx - s * 0.27 + f * s * 0.18;
            ctx.beginPath();
            ctx.moveTo(fx - s * 0.04, cy + s * 0.3);
            ctx.lineTo(fx, cy + s * 0.45);
            ctx.lineTo(fx + s * 0.04, cy + s * 0.3);
            ctx.closePath();
            ctx.fill();
        }

    } else if (type === 'spider') {
        // 거미 — 둥근 검은 몸 + 8개 다리 + 빨간 등 표식 + 빛나는 눈 4개
        const body = flash ? '#ffffff' : '#1a1818';
        const dark = flash ? '#ccc' : '#0a0808';
        const tPh = Date.now() / 200;
        // 다리 8개 (4 좌 + 4 우, 살짝 흔들림)
        ctx.strokeStyle = dark;
        ctx.lineWidth = Math.max(2, s * 0.08);
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
            const side = i < 4 ? -1 : 1;
            const idx = i % 4;
            const baseAngle = (idx - 1.5) * 0.35;  // 다리 각도 분포
            const swing = Math.sin(tPh + i) * 0.08;
            const ang = baseAngle + swing;
            const sx = cx + side * s * 0.4 * Math.cos(ang * 0.5);
            const sy = cy + s * 0.1 + side * s * 0.2 * Math.sin(ang);
            const knee = cx + side * s * 0.85 * Math.cos(ang * 0.3);
            const kneeY = cy - s * 0.2 + Math.sin(ang) * s * 0.1;
            const tipX = cx + side * s * 1.25 * Math.cos(ang * 0.2);
            const tipY = cy + s * 0.3 + side * s * 0.4 * Math.sin(ang);
            ctx.moveTo(sx, sy);
            ctx.lineTo(knee, kneeY);
            ctx.lineTo(tipX, tipY);
        }
        ctx.stroke();
        if (flash) {
            ctx.fillStyle = body;
            ctx.beginPath();
            ctx.ellipse(cx, cy, s * 0.7, s * 0.55, 0, 0, Math.PI * 2);
            ctx.arc(cx, cy - s * 0.4, s * 0.35, 0, Math.PI * 2);
            ctx.fill();
            return;
        }
        // 몸통 (가로 타원, 광택 있음)
        ctx.fillStyle = body;
        ctx.strokeStyle = dark;
        ctx.lineWidth = Math.max(1.5, s * 0.06);
        ctx.beginPath();
        ctx.ellipse(cx, cy, s * 0.7, s * 0.55, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // 등 빨간 표식 (공포의 빨간 모래시계)
        ctx.fillStyle = '#cc1010';
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.12, cy - s * 0.15);
        ctx.lineTo(cx + s * 0.12, cy - s * 0.15);
        ctx.lineTo(cx + s * 0.04, cy);
        ctx.lineTo(cx + s * 0.12, cy + s * 0.15);
        ctx.lineTo(cx - s * 0.12, cy + s * 0.15);
        ctx.lineTo(cx - s * 0.04, cy);
        ctx.closePath();
        ctx.fill();
        // 머리 (작은 둥근, 위쪽)
        ctx.fillStyle = body;
        ctx.strokeStyle = dark;
        ctx.lineWidth = Math.max(1.5, s * 0.06);
        ctx.beginPath();
        ctx.arc(cx, cy - s * 0.45, s * 0.32, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // 빛나는 눈 4개 (빨강, 한 path)
        ctx.fillStyle = '#ff3030';
        ctx.beginPath();
        ctx.arc(cx - s * 0.18, cy - s * 0.5, s * 0.06, 0, Math.PI * 2);
        ctx.arc(cx - s * 0.06, cy - s * 0.55, s * 0.05, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.06, cy - s * 0.55, s * 0.05, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.18, cy - s * 0.5, s * 0.06, 0, Math.PI * 2);
        ctx.fill();
        // 눈 하이라이트
        ctx.fillStyle = '#ffeeaa';
        ctx.beginPath();
        ctx.arc(cx - s * 0.17, cy - s * 0.51, s * 0.018, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.19, cy - s * 0.51, s * 0.018, 0, Math.PI * 2);
        ctx.fill();
        // 송곳니 두 개 (입 아래, 짧은 직선)
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = Math.max(1, s * 0.04);
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.07, cy - s * 0.2);
        ctx.lineTo(cx - s * 0.05, cy - s * 0.1);
        ctx.moveTo(cx + s * 0.07, cy - s * 0.2);
        ctx.lineTo(cx + s * 0.05, cy - s * 0.1);
        ctx.stroke();

    } else if (type === 'bear') {
        // 곰 — 큰 갈색 둥근 몸 + 둥근 귀 + 주둥이 + 작은 눈
        const fur = flash ? '#ffffff' : '#7a5430';
        const furDark = flash ? '#ddd' : '#3a2818';
        const furLight = flash ? '#fff' : '#a07848';
        const muzzle = flash ? '#ccc' : '#d8b888';
        // 다리 4개 (몸 아래)
        ctx.fillStyle = furDark;
        ctx.beginPath();
        ctx.ellipse(cx - s * 0.5, cy + s * 0.7, s * 0.15, s * 0.12, 0, 0, Math.PI * 2);
        ctx.ellipse(cx - s * 0.18, cy + s * 0.78, s * 0.15, s * 0.12, 0, 0, Math.PI * 2);
        ctx.ellipse(cx + s * 0.18, cy + s * 0.78, s * 0.15, s * 0.12, 0, 0, Math.PI * 2);
        ctx.ellipse(cx + s * 0.5, cy + s * 0.7, s * 0.15, s * 0.12, 0, 0, Math.PI * 2);
        ctx.fill();
        if (flash) {
            ctx.fillStyle = fur;
            ctx.beginPath();
            ctx.arc(cx, cy + s * 0.1, s * 0.85, 0, Math.PI * 2);
            ctx.arc(cx, cy - s * 0.55, s * 0.55, 0, Math.PI * 2);
            ctx.fill();
            return;
        }
        // 몸통 (큰 둥근, 그라디언트)
        const bodyGrad = ctx.createRadialGradient(
            cx - s * 0.25, cy - s * 0.1, s * 0.1,
            cx, cy + s * 0.1, s * 1.0
        );
        bodyGrad.addColorStop(0, furLight);
        bodyGrad.addColorStop(1, fur);
        ctx.fillStyle = bodyGrad;
        ctx.strokeStyle = furDark;
        ctx.lineWidth = Math.max(2, s * 0.07);
        ctx.beginPath();
        ctx.arc(cx, cy + s * 0.1, s * 0.85, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // 배 (옅은 영역)
        ctx.fillStyle = 'rgba(255,240,210,0.25)';
        ctx.beginPath();
        ctx.ellipse(cx, cy + s * 0.4, s * 0.5, s * 0.35, 0, 0, Math.PI * 2);
        ctx.fill();
        // 귀 두 개 (둥근, 어두운)
        ctx.fillStyle = furDark;
        ctx.beginPath();
        ctx.arc(cx - s * 0.4, cy - s * 0.85, s * 0.2, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.4, cy - s * 0.85, s * 0.2, 0, Math.PI * 2);
        ctx.fill();
        // 귀 안쪽 (분홍 갈색)
        ctx.fillStyle = '#9a6840';
        ctx.beginPath();
        ctx.arc(cx - s * 0.4, cy - s * 0.83, s * 0.1, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.4, cy - s * 0.83, s * 0.1, 0, Math.PI * 2);
        ctx.fill();
        // 머리 (몸 위쪽 둥근)
        ctx.fillStyle = bodyGrad;
        ctx.strokeStyle = furDark;
        ctx.lineWidth = Math.max(2, s * 0.07);
        ctx.beginPath();
        ctx.arc(cx, cy - s * 0.55, s * 0.55, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // 주둥이 (밝은 색 타원)
        ctx.fillStyle = muzzle;
        ctx.strokeStyle = furDark;
        ctx.lineWidth = Math.max(1.5, s * 0.05);
        ctx.beginPath();
        ctx.ellipse(cx, cy - s * 0.32, s * 0.32, s * 0.22, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // 코 (검정, 주둥이 위쪽)
        ctx.fillStyle = '#0a0606';
        ctx.beginPath();
        ctx.ellipse(cx, cy - s * 0.42, s * 0.1, s * 0.07, 0, 0, Math.PI * 2);
        ctx.fill();
        // 입 (코 아래 작은 V)
        ctx.strokeStyle = '#1a0a0a';
        ctx.lineWidth = Math.max(1, s * 0.04);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx, cy - s * 0.34);
        ctx.lineTo(cx, cy - s * 0.22);
        ctx.moveTo(cx - s * 0.08, cy - s * 0.22);
        ctx.lineTo(cx + s * 0.08, cy - s * 0.22);
        ctx.stroke();
        // 눈 두 개 (작은 동그란 검정 + 하이라이트)
        ctx.fillStyle = '#1a0808';
        ctx.beginPath();
        ctx.arc(cx - s * 0.2, cy - s * 0.65, s * 0.07, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.2, cy - s * 0.65, s * 0.07, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(cx - s * 0.18, cy - s * 0.67, s * 0.022, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.22, cy - s * 0.67, s * 0.022, 0, Math.PI * 2);
        ctx.fill();

    } else if (type === 'bomber') {
        // 자폭병 — 작은 고블린 + 등 폭탄 + 도화선 불꽃
        const skin = flash ? '#ffffff' : '#5a8030';
        const skinDark = flash ? '#ddd' : '#2a4818';
        const cloth = flash ? '#aaa' : '#5a3818';
        const tPh = Date.now() / 100;
        // 폭탄 (몸 뒤쪽 검정 구체)
        ctx.fillStyle = '#1a1a1a';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = Math.max(1.5, s * 0.05);
        ctx.beginPath();
        ctx.arc(cx - s * 0.1, cy - s * 0.45, s * 0.45, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // 폭탄 하이라이트
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.beginPath();
        ctx.arc(cx - s * 0.25, cy - s * 0.6, s * 0.1, 0, Math.PI * 2);
        ctx.fill();
        // 도화선 (위쪽 흔들림)
        const fuseWag = Math.sin(tPh * 0.15) * 0.05;
        ctx.strokeStyle = '#8a6020';
        ctx.lineWidth = Math.max(1, s * 0.04);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.1, cy - s * 0.85);
        ctx.quadraticCurveTo(cx + s * (0.05 + fuseWag), cy - s * 1.05, cx + s * 0.15, cy - s * 1.2);
        ctx.stroke();
        // 도화선 끝 불꽃 (점멸)
        const fireSize = 0.08 + Math.abs(Math.sin(tPh * 0.3)) * 0.06;
        ctx.fillStyle = '#ffaa00';
        ctx.beginPath();
        ctx.arc(cx + s * 0.15, cy - s * 1.2, s * fireSize, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ff4020';
        ctx.beginPath();
        ctx.arc(cx + s * 0.15, cy - s * 1.2, s * fireSize * 0.6, 0, Math.PI * 2);
        ctx.fill();
        if (flash) {
            ctx.fillStyle = skin;
            ctx.beginPath();
            ctx.ellipse(cx + s * 0.1, cy + s * 0.1, s * 0.55, s * 0.5, 0, 0, Math.PI * 2);
            ctx.arc(cx + s * 0.2, cy - s * 0.4, s * 0.35, 0, Math.PI * 2);
            ctx.fill();
            return;
        }
        // 몸 (앞쪽 살짝 치우친 둥근)
        ctx.fillStyle = skin;
        ctx.strokeStyle = skinDark;
        ctx.lineWidth = Math.max(2, s * 0.07);
        ctx.beginPath();
        ctx.ellipse(cx + s * 0.1, cy + s * 0.1, s * 0.55, s * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // 머리 (앞쪽 위, 작은 둥근)
        ctx.fillStyle = skin;
        ctx.strokeStyle = skinDark;
        ctx.beginPath();
        ctx.arc(cx + s * 0.2, cy - s * 0.4, s * 0.35, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // 가죽 멜빵 (가슴 가로)
        ctx.fillStyle = cloth;
        ctx.fillRect(cx - s * 0.4, cy + s * 0.1, s * 0.95, s * 0.1);
        // 큰 귀 두 개 (고블린 톡 튀어나옴)
        ctx.fillStyle = skin;
        ctx.strokeStyle = skinDark;
        ctx.lineWidth = Math.max(1, s * 0.04);
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.05, cy - s * 0.38);
        ctx.lineTo(cx - s * 0.25, cy - s * 0.55);
        ctx.lineTo(cx - s * 0.05, cy - s * 0.55);
        ctx.closePath();
        ctx.moveTo(cx + s * 0.45, cy - s * 0.38);
        ctx.lineTo(cx + s * 0.65, cy - s * 0.55);
        ctx.lineTo(cx + s * 0.45, cy - s * 0.55);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // 눈 (크고 노랑 광기)
        ctx.fillStyle = '#ffaa20';
        ctx.beginPath();
        ctx.arc(cx + s * 0.1, cy - s * 0.42, s * 0.08, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.32, cy - s * 0.42, s * 0.08, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(cx + s * 0.1, cy - s * 0.4, s * 0.04, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.32, cy - s * 0.4, s * 0.04, 0, Math.PI * 2);
        ctx.fill();
        // 광기의 미소 (뾰족 이빨)
        ctx.fillStyle = '#1a0a0a';
        ctx.beginPath();
        ctx.ellipse(cx + s * 0.22, cy - s * 0.2, s * 0.13, s * 0.06, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.moveTo(cx + s * 0.13, cy - s * 0.21);
        ctx.lineTo(cx + s * 0.16, cy - s * 0.13);
        ctx.lineTo(cx + s * 0.19, cy - s * 0.21);
        ctx.closePath();
        ctx.moveTo(cx + s * 0.25, cy - s * 0.21);
        ctx.lineTo(cx + s * 0.28, cy - s * 0.13);
        ctx.lineTo(cx + s * 0.31, cy - s * 0.21);
        ctx.closePath();
        ctx.fill();

    } else if (type === 'healer') {
        // 사제 — 보라색 로브 + 후드 + 마법 오브 + 빛나는 손
        const robe = flash ? '#ffffff' : '#5a3878';
        const robeDark = flash ? '#ccc' : '#2a1838';
        const robeLight = flash ? '#fff' : '#7a5898';
        const orbColor = '#aaffaa';
        const tPh = Date.now() / 600;
        const orbPulse = 0.85 + Math.sin(tPh + (phase || 0)) * 0.15;
        // 로브 (긴 사다리꼴, 아래 넓음)
        const drawRobe = () => {
            ctx.beginPath();
            ctx.moveTo(cx - s * 0.45, cy - s * 0.7);
            ctx.lineTo(cx + s * 0.45, cy - s * 0.7);
            ctx.lineTo(cx + s * 0.85, cy + s * 0.95);
            ctx.lineTo(cx - s * 0.85, cy + s * 0.95);
            ctx.closePath();
        };
        if (flash) {
            ctx.fillStyle = robe;
            drawRobe();
            ctx.fill();
            return;
        }
        // 로브 (그라디언트로 입체감)
        const robeGrad = ctx.createLinearGradient(0, cy - s, 0, cy + s);
        robeGrad.addColorStop(0, robeLight);
        robeGrad.addColorStop(1, robe);
        ctx.fillStyle = robeGrad;
        ctx.strokeStyle = robeDark;
        ctx.lineWidth = Math.max(2, s * 0.06);
        drawRobe();
        ctx.fill();
        ctx.stroke();
        // 로브 중앙 띠 (수직)
        ctx.fillStyle = robeDark;
        ctx.fillRect(cx - s * 0.05, cy - s * 0.65, s * 0.1, s * 1.55);
        // 골드 십자 패턴 (가슴)
        ctx.fillStyle = '#ffcc44';
        ctx.fillRect(cx - s * 0.08, cy + s * 0.05, s * 0.16, s * 0.06);
        ctx.fillRect(cx - s * 0.03, cy - s * 0.0, s * 0.06, s * 0.16);
        // 후드 (위쪽 둥근, 어두움)
        ctx.fillStyle = robeDark;
        ctx.strokeStyle = robeDark;
        ctx.lineWidth = Math.max(1.5, s * 0.05);
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.55, cy - s * 0.45);
        ctx.quadraticCurveTo(cx, cy - s * 1.0, cx + s * 0.55, cy - s * 0.45);
        ctx.lineTo(cx + s * 0.45, cy - s * 0.5);
        ctx.lineTo(cx + s * 0.45, cy - s * 0.7);
        ctx.lineTo(cx - s * 0.45, cy - s * 0.7);
        ctx.lineTo(cx - s * 0.45, cy - s * 0.5);
        ctx.closePath();
        ctx.fill();
        // 후드 안쪽 그늘 (얼굴 어두움)
        ctx.fillStyle = '#0a0010';
        ctx.beginPath();
        ctx.ellipse(cx, cy - s * 0.55, s * 0.28, s * 0.22, 0, 0, Math.PI * 2);
        ctx.fill();
        // 빛나는 눈 두 개 (보라 빛)
        ctx.fillStyle = '#cc88ff';
        ctx.beginPath();
        ctx.arc(cx - s * 0.1, cy - s * 0.55, s * 0.05, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.1, cy - s * 0.55, s * 0.05, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(cx - s * 0.09, cy - s * 0.56, s * 0.018, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.11, cy - s * 0.56, s * 0.018, 0, Math.PI * 2);
        ctx.fill();
        // 마법 오브 (앞에 떠있는 녹색 회복 빛, 펄스)
        const orbX = cx + s * 0.55;
        const orbY = cy + s * 0.25;
        const orbR = s * 0.25 * orbPulse;
        // 외곽 글로우
        ctx.fillStyle = 'rgba(170,255,170,0.25)';
        ctx.beginPath();
        ctx.arc(orbX, orbY, orbR * 1.6, 0, Math.PI * 2);
        ctx.fill();
        // 본체
        const orbGrad = ctx.createRadialGradient(orbX - orbR * 0.3, orbY - orbR * 0.3, orbR * 0.1, orbX, orbY, orbR);
        orbGrad.addColorStop(0, '#eeffee');
        orbGrad.addColorStop(0.6, orbColor);
        orbGrad.addColorStop(1, '#40a040');
        ctx.fillStyle = orbGrad;
        ctx.beginPath();
        ctx.arc(orbX, orbY, orbR, 0, Math.PI * 2);
        ctx.fill();
        // 십자 (오브 안)
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(orbX - orbR * 0.5, orbY - orbR * 0.12, orbR, orbR * 0.24);
        ctx.fillRect(orbX - orbR * 0.12, orbY - orbR * 0.5, orbR * 0.24, orbR);
    }
}

// ---- Draw enemy ----
function drawEnemy(enemy) {
    const x = enemy.x;
    const y = enemy.y;
    // 시각 크기 (스프라이트 표시 크기와 맞춤)
    // 웨이브별 크기 스케일 (강해질수록 시각적으로 커짐, 최대 +35%)
    const waveScale = 1 + Math.min(0.35, (wave - 1) * 0.015);
    const baseVs = enemy.type === 'boss' ? TILE * 1.0 :
                   enemy.type === 'tank' ? TILE * 0.65 :
                   enemy.type === 'swarm' ? TILE * 0.3 : TILE * 0.5;
    const vs = baseVs * waveScale;

    ctx.save();

    // Slow visual
    if (enemy.slowTimer > 0) {
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = '#88ddff';
        ctx.beginPath();
        ctx.arc(x, y, vs + 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
    }

    // Poison visual
    if (enemy.poisonTimer > 0) {
        ctx.globalAlpha = 0.25 + Math.sin(Date.now() / 150) * 0.1;
        ctx.fillStyle = '#44ff22';
        ctx.beginPath();
        ctx.arc(x, y, vs + 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        // Poison bubbles around enemy
        ctx.fillStyle = '#66ff44';
        ctx.globalAlpha = 0.6;
        const bubbleAngle = Date.now() / 400;
        ctx.beginPath();
        ctx.arc(x + Math.cos(bubbleAngle) * (vs + 2), y + Math.sin(bubbleAngle) * (vs + 2), 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x + Math.cos(bubbleAngle + 2) * (vs + 3), y + Math.sin(bubbleAngle + 2) * (vs + 3), 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
    }

    // Shield visual (boss) — 육각 헥스
    if (enemy.shield > 0) {
        ctx.globalAlpha = 0.35 + Math.sin(Date.now() / 300) * 0.12;
        ctx.strokeStyle = '#4488ff';
        ctx.lineWidth = 2;
        ctx.shadowColor = '#4488ff';
        ctx.shadowBlur = 8;
        ctx.beginPath();
        for (let hi = 0; hi < 6; hi++) {
            const hang = (Math.PI * 2 / 6) * hi + Date.now() / 2000;
            const hpx = x + Math.cos(hang) * (vs + 8);
            const hpy = y + Math.sin(hang) * (vs + 8);
            if (hi === 0) ctx.moveTo(hpx, hpy);
            else ctx.lineTo(hpx, hpy);
        }
        ctx.closePath();
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(68,136,255,0.15)';
        ctx.fill();
        ctx.globalAlpha = 1;
    }

    // Speed burst visual (boss) — 뒤쪽으로 뻗는 속도선
    if (enemy.speedBurstActive) {
        ctx.strokeStyle = '#ff4444';
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.6;
        for (let sli = 0; sli < 4; sli++) {
            const sly = y - vs * 0.4 + sli * vs * 0.25;
            ctx.beginPath();
            ctx.moveTo(x - vs * 1.8 - sli * 5, sly);
            ctx.lineTo(x - vs * 0.8, sly);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }

    // (그림자 완전 제거 — 성능 + 깔끔함)

    // Boss 오라 (광원) — shadowBlur 대신 2중 원
    if (enemy.type === 'boss') {
        const auraPhase = Math.sin(Date.now() / 200) * 0.15;
        ctx.globalAlpha = 0.2 + auraPhase;
        ctx.fillStyle = '#ff3030';
        ctx.beginPath();
        ctx.arc(x, y, vs * 1.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.3 + auraPhase;
        ctx.beginPath();
        ctx.arc(x, y, vs * 1.05, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
    }

    // 벡터 실루엣 드로잉 (타입별 확실한 형체) + 객체별 애니메이션 위상
    drawEnemyShape(x, y, vs, enemy.type, enemy.hitFlash > 0, enemy.animPhase || 0);

    ctx.restore();

    // Health bar (둥근 모던 스타일)
    const hpRatio = enemy.hp / enemy.maxHp;
    const barW = vs * 1.2;
    const barH = Math.max(3, Math.floor(TILE / 14));
    const barX = x - barW / 2;
    const barY = y - vs * 0.85 - barH - 3;

    // 배경
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    drawRoundRect(barX - 1, barY - 1, barW + 2, barH + 2, barH * 0.5 + 1);
    ctx.fill();
    // HP 바
    ctx.fillStyle = hpRatio > 0.5 ? '#5ade5a' : hpRatio > 0.25 ? '#e6d040' : '#e64a4a';
    drawRoundRect(barX, barY, Math.max(0, barW * hpRatio), barH, barH * 0.5);
    ctx.fill();
    // 하이라이트
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    drawRoundRect(barX, barY, Math.max(0, barW * hpRatio), barH * 0.5, barH * 0.3);
    ctx.fill();

    // Armor indicator for tanks/bosses
    if (enemy.armor > 0) {
        ctx.strokeStyle = '#aaaadd';
        ctx.lineWidth = 1;
        ctx.strokeRect(barX - 1, barY - 1, barW + 2, barH + 2);
    }

    // Shield bar (boss)
    if (enemy.maxShield > 0) {
        const shieldRatio = enemy.shield / enemy.maxShield;
        const sBarY = barY + barH + 2;
        ctx.fillStyle = '#222';
        ctx.fillRect(barX, sBarY, barW, 2);
        if (enemy.shield > 0) {
            ctx.fillStyle = '#4488ff';
            ctx.fillRect(barX, sBarY, barW * shieldRatio, 2);
        }
    }
}

// ---- Input handling ----
function getCanvasPos(e) {
    const rect = canvas.getBoundingClientRect();
    // 게임 로직은 CSS px 좌표(W,H) 기준으로 동작 → rect 기준으로 변환
    const scaleX = W / rect.width;
    const scaleY = H / rect.height;
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
    // 광고 진행 중에는 입력 무시
    if (adInProgress) return;

    // Init audio on first interaction (browser policy)
    soundManager.init();

    // 도움말 오버레이 표시 중이면 어디든 클릭 시 닫기
    if (showHelp) {
        showHelp = false;
        return;
    }

    if (gameOver) {
        if (gameOverTimer > 2.0) {
            // 보상형 광고 버튼 클릭 체크
            if (showRewardedAdOption && window._rewardedAdBtn) {
                const rb = window._rewardedAdBtn;
                if (pos.x >= rb.x && pos.x <= rb.x + rb.w && pos.y >= rb.y && pos.y <= rb.y + rb.h) {
                    pokiRewardedBreak().then((success) => {
                        if (success) {
                            gameOver = false;
                            lives = 5;
                            gameOverTimer = 0;
                            showRewardedAdOption = false;
                            rewardedAdUsed = true;
                            pokiGameplayStart();
                        } else {
                            showRewardedAdOption = false;
                        }
                    });
                    return;
                }
            }
            // 재시작 버튼 영역만 감지 (버튼 외 클릭 무시)
            if (window._restartBtn) {
                const rb = window._restartBtn;
                if (pos.x >= rb.x && pos.x <= rb.x + rb.w && pos.y >= rb.y && pos.y <= rb.y + rb.h) {
                    restartGame();
                    pokiGameplayStart();
                }
            }
        }
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

    // Language button click
    if (window._langBtn) {
        const lb = window._langBtn;
        if (pos.x >= lb.x && pos.x <= lb.x + lb.w && pos.y >= lb.y && pos.y <= lb.y + lb.h) {
            lang = lang === 'ko' ? 'en' : 'ko';
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
                // 같은 버튼 다시 누르면 선택 해제 (토글)
                selectedTower = (selectedTower === i) ? -1 : i;
                showUpgradeFor = null;
                buildIdleTimer = 0;
                updateCursor();
                soundManager.uiClick();
                return;
            }
        }
    }

    // 시작/스킵 CTA 박스 클릭 (박스 영역 정확히 매칭)
    if (betweenWaves && window._startCtaBtn) {
        const cb = window._startCtaBtn;
        if (pos.x >= cb.x && pos.x <= cb.x + cb.w && pos.y >= cb.y && pos.y <= cb.y + cb.h) {
            startWave();
            autoStartTimer = 0;
            return;
        }
    }
    // 호환: 상단 영역 클릭으로도 스킵 (다음 웨이브 카운트다운 시)
    if (pos.y < TILE * 1.5 && betweenWaves && wave > 0) {
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

        // 선택 안 된 상태로 잔디 클릭 → 아무 것도 하지 않음 (잘못 지어지는 실수 방지)
        if (selectedTower < 0) {
            showUpgradeFor = null;
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
            // 건설 후 10초간 추가 건설이 없으면 자동으로 선택 해제
            buildIdleTimer = 10;
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
    if (e.button === 2) {
        // 우클릭 → 선택 해제
        selectedTower = -1;
        showUpgradeFor = null;
        buildIdleTimer = 0;
        updateCursor();
        return;
    }
    handleClick(getCanvasPos(e));
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('mousemove', (e) => {
    const pos = getCanvasPos(e);
    mousePos = pos;
    handleMove(pos);
    updateCursor();
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
    const keyToTower = { '1': 0, '2': 1, '3': 2, '4': 3, '5': 4 };
    if (keyToTower.hasOwnProperty(e.key)) {
        const i = keyToTower[e.key];
        selectedTower = (selectedTower === i) ? -1 : i;
        buildIdleTimer = 0;
        updateCursor();
    }
    if (e.key === '0' || e.key === '`') {
        // 명시적 선택 해제
        selectedTower = -1;
        buildIdleTimer = 0;
        updateCursor();
    }
    if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (adInProgress) return;
        if (gameOver) {
            if (gameOverTimer > 2.0) {
                pokiCommercialBreak().then(() => {
                    restartGame();
                    pokiGameplayStart();
                });
            }
        } else if (betweenWaves) {
            startWave();
            autoStartTimer = 0;
        }
    }
    if (e.key === 'Escape') {
        // 우선순위: 도움말 → 업그레이드 패널 → 타워 선택 → 일시정지 토글
        if (showHelp) {
            showHelp = false;
        } else if (showUpgradeFor) {
            showUpgradeFor = null;
        } else if (selectedTower >= 0) {
            selectedTower = -1;
            buildIdleTimer = 0;
            updateCursor();
        } else if (!gameOver && !betweenWaves) {
            paused = !paused;
        }
    }
    if (e.key === 'p' || e.key === 'P') {
        if (!gameOver && !betweenWaves) paused = !paused;
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
    if (e.key === 'l' || e.key === 'L') {
        lang = lang === 'ko' ? 'en' : 'ko';
    }
    if (e.key === 'h' || e.key === 'H' || e.key === '?') {
        showHelp = !showHelp;
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
    selectedTower = -1;
    buildIdleTimer = 0;
    updateCursor();
    // v2.0
    screenShakeIntensity = 0;
    screenShakeTimer = 0;
    shockwaves = [];
    groundMarks = [];
    chainLightnings = [];
    ambientParticles = [];
    prevGold = 150;
    prevLives = 20;
    goldFlashTimer = 0;
    livesFlashTimer = 0;
    waveTransitionTimer = 0;
    gameOverTimer = 0;
    // Poki
    showRewardedAdOption = false;
    rewardedAdUsed = false;
    // 맵 랜덤 선택 (잔디/경로 재생성 포함)
    changeMap();
}

// ---- Game Loop ----
let lastTime = performance.now();
let paused = false;
function gameLoop(time) {
    const rawDt = Math.min((time - lastTime) / 1000, 0.05);
    lastTime = time;

    // 광고 진행 중에는 게임 일시정지
    if (adInProgress) {
        requestAnimationFrame(gameLoop);
        return;
    }

    const dt = (paused && !gameOver) ? 0 : rawDt * gameSpeed;

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

    // 건설 후 자동 선택 해제 카운트다운 (실시간)
    if (buildIdleTimer > 0 && selectedTower >= 0) {
        buildIdleTimer -= rawDt;
        if (buildIdleTimer <= 0) {
            buildIdleTimer = 0;
            selectedTower = -1;
            updateCursor();
        }
    }

    if (!showRotateOverlay) {
        update(dt);
    }
    draw();
    requestAnimationFrame(gameLoop);
}

// Initial draw so the game renders immediately
draw();
requestAnimationFrame(gameLoop);
