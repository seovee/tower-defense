# Tower Defense - 코드 구조 & 개념 가이드

## 전체 구조 한눈에 보기

```
game.js (약 5679줄)
│
├── [1~71]      Poki SDK 연동
├── [73~138]    캔버스 초기화 & 반응형 (DPR 상한 1.5, 마진 24)
├── [140~210]   게임 상태 (selectedTower, buildIdleTimer, pointerHotspots, CURSOR_CROSSHAIR, paused 등)
├── [190~267]   로컬라이제이션 (rushWarn/heavyWarn/swarmWarn)
├── [269~476]   SoundManager (Web Audio 20종)
├── [478~580]   ★ 3 맵 시스템 (MAPS 배열 + currentMapIndex + changeMap + carvePath + buildPathPixels)
├── [582~663]   앰비언트 시스템 (잔디/경로/먼지·반딧불이 — 전투 중 스폰 중단)
├── [665~790]   배경 캐시 (generateBackgroundCache — 경로 디테일 포함 프리렌더)
├── [792~955]   (구) 픽셀 스프라이트 시스템 — v3.3에서 미사용 (createSprite/drawSprite는 아직 존재하지만 호출 안 됨)
├── [957~1041] TOWER_TYPES 정의
├── [1043~1180] Tower/Enemy/Projectile 등 클래스 (upgradeCost 지수 1.5)
├── [1186~1350] getWaveEnemies (v3.3: swarm 타입 추가, 스와름 웨이브 신규)
├── [1354~1413] startWave(waveTotalEnemies 설정) + placeTower + upgradeTower + sellTower
├── [1415~1450] dist + distSq + spawnDeathParticles + applyDamageToEnemy
├── [1460~1950] ★ update() - 게임 로직 (타겟팅 distSq + 0.2초 재탐색 캐싱)
├── [1968~2200] ★ draw() 시작 — 배경/경로/IN·OUT 아이콘/적/투사체
│                   v3.3: 화살/대포/얼음/번개/독 투사체 크기 대폭 상향
├── [2202~2280] drawRoundRect (코너별 반경 지원)
├── [2280~2870] UI Panel (웨이브 뱃지·HUD 스탯 3·우측 버튼 3·divider·타워 선택 버튼)
├── [2900~3050] 웨이브 뱃지 (2세그먼트 가독성: 메인 + 구분선 + 진행도 노랑)
├── [3050~3100] 보스 HP 바 (상단 중앙)
├── [3100~3430] 시작/웨이브 프롬프트 CTA + Game Over 모달 + 일시정지 오버레이
├── [3875~4550] ★ drawTowerBody — 타워 5종 × Lv1~5 벡터 진화 (석궁/둥근 대포/얼음/번개/독)
├── [4550~4595] drawTowerAt + drawTowerIcon (레벨 티어 pip/크라운 제거됨)
├── [4600~4930] ★ drawEnemyShape — 세균/바이러스 테마 5종 (일반/스와름/Fast/Tank/Boss)
├── [4935~5040] drawEnemy (상태 오버레이 + 벡터 실루엣)
├── [5045~5400] 입력 처리 + updateCursor (중세풍 크로스헤어)
└── [5400~5643] 게임 리셋 (changeMap 호출) + 게임 루프 (paused 플래그)
```

---

## 1. 게임 루프 (심장)

**위치:** `game.js:3482~3521`

```
gameLoop() 호출 (60fps)
    ├── update(dt)   ← 모든 계산 (위치, 충돌, AI)
    ├── draw()        ← 화면에 그리기
    └── requestAnimationFrame(gameLoop)  ← 다음 프레임 예약
```

### 핵심 개념: `dt` (Delta Time)

```js
const rawDt = Math.min((time - lastTime) / 1000, 0.05);
const dt = rawDt * gameSpeed;
```

- 이전 프레임과 현재 프레임 사이의 **경과 시간 (초)**
- 60fps면 dt ≈ 0.016초
- 모든 이동/타이머에 dt를 곱해서 **프레임 속도에 독립적**으로 동작
- 느린 컴퓨터든 빠른 컴퓨터든 같은 속도로 게임 진행

---

## 2. 맵 & 경로 시스템

**위치:** `game.js:478~538`

### 격자(Grid)

```
20칸(가로) x 14칸(세로) 격자
각 칸의 값:
  0 = 잔디 (타워 배치 가능)
  1 = 길 (적이 지나가는 곳)
  2 = 입구
  3 = 출구
```

### 경로(Waypoints)

```js
const waypoints = [
  { x: -1, y: 2 }, // 왼쪽 밖에서 시작
  { x: 4, y: 2 }, // →  오른쪽으로
  { x: 4, y: 5 }, // ↓  아래로
  { x: 10, y: 5 }, // →  오른쪽으로
  { x: 10, y: 2 }, // ↑  위로
  { x: 16, y: 2 }, // →  오른쪽으로
  { x: 16, y: 7 }, // ↓  아래로
  { x: 6, y: 7 }, // ←  왼쪽으로
  { x: 6, y: 10 }, // ↓  아래로
  { x: 14, y: 10 }, // →  오른쪽으로
  { x: 14, y: 12 }, // ↓  아래로
  { x: 20, y: 12 }, // →  오른쪽 밖으로 (출구)
];
```

S자 형태로 꺾이는 경로. 적은 이 좌표들을 순서대로 따라감.

### 경로를 격자에 새기는 원리 (carvePath)

두 waypoint 사이를 잇는 직선을 격자에 1로 표시:

- 같은 y좌표면 → 가로로 칸을 채움
- 같은 x좌표면 → 세로로 칸을 채움

### 업그레이드 팁

경로를 바꾸고 싶으면 `waypoints` 배열만 수정하면 됨!
더 복잡한 경로 = 타워 배치 전략이 다양해짐

---

## 3. 타워 시스템

**위치:** `game.js:912~1023` (TOWER_TYPES + Tower 클래스)

### 타워 종류 5가지

| 속성     | 화살                | 대포           | 얼음     | 번개              | 독         |
| -------- | ------------------- | -------------- | -------- | ----------------- | ---------- |
| 비용     | 50G                 | 100G           | 75G      | 130G              | 90G        |
| 데미지   | 8                   | 30             | 5        | 18                | 4          |
| 사거리   | 3.0칸               | 2.8칸          | 2.5칸    | 3.5칸             | 2.5칸      |
| 공격속도 | 0.4초               | 1.2초          | 0.6초    | 0.8초             | 0.7초      |
| 특수효과 | 치명타 20%×2.5      | 범위(스플래시) | 감속 50% | 연쇄 3회(70%감쇄) | 독 DOT 4초 |
| 총알속도 | 8                   | 5              | 6        | 12                | 5          |
| 투사체   | 화살선(금색=치명타) | 포탄+연기      | 얼음결정 | 전기줄기+연쇄번개 | 독방울     |

### 타워 클래스 핵심 속성

```js
class Tower {
    col, row          // 격자 위치
    x, y              // 픽셀 위치 (격자 중앙)
    level             // 현재 레벨 (1~5)
    cooldown          // 다음 발사까지 남은 시간
    angle             // 포탑이 바라보는 각도
    target            // 현재 조준 중인 적
    totalDamage       // 누적 데미지 (통계용)
}
```

### 업그레이드 공식 (v3.0)

```
레벨업 할 때마다:
  데미지  = 기본 × (1 + (레벨-1) × 0.5)           → 레벨5면 3배
  사거리  = 기본 + (레벨-1) × 0.3칸                 → 레벨5면 +1.2칸
  공격속도 = 기본 × 0.88^(레벨-1)                  → 레벨5면 약 60%로 빨라짐
  업그레이드 비용 = floor(기본비용 × 0.7 × 1.7^(레벨-1))   ← v3.0 지수화
  판매가 = 총 투자금 × 60%
```

레벨별 업그레이드 비용 배율: Lv1→2 = ×0.7, Lv2→3 ≈ ×1.19, Lv3→4 ≈ ×2.02, Lv4→5 ≈ ×3.44
→ 후반 만렙 투자 비용이 크게 상승하여 타워 선택 전략이 중요해짐

### 타워 AI (타겟 선정)

**위치:** `game.js:1582~1619`

```
1. 사거리 안의 모든 적을 검색
2. "출구에 가장 가까운 적"을 우선 공격
   → pathIndex(경로 진행도)가 높은 적 선택
3. 타겟을 향해 포탑 각도를 회전
4. 쿨다운이 0이 되면 발사
```

이 전략을 "가장 진행된 적 우선(First/Furthest)" 이라고 함.
다른 전략: 가장 가까운 적, HP 가장 낮은 적, HP 가장 높은 적 등

---

## 4. 적(Enemy) 시스템

**위치:** `game.js:1025~1056`

### 적 클래스 핵심 속성

```js
class Enemy {
    hp, maxHp         // 체력
    speed, baseSpeed  // 이동속도
    goldValue         // 처치 시 골드 보상
    type              // 'normal', 'fast', 'tank', 'boss'
    pathIndex         // 현재 따라가는 경로 인덱스
    x, y              // 현재 위치
    armor             // 방어력 (받는 데미지에서 차감)
    slowTimer         // 감속 남은 시간
    slowAmount        // 감속 비율 (0.5 = 50% 감속)
    poisonTimer       // 독 남은 시간
    poisonDmg         // 독 틱당 데미지
    poisonTick        // 다음 독 틱까지 남은 시간 (0.5초 간격)
    hitFlash          // 피격 시 흰색 반짝임
    size              // 그리기 크기
}
```

### 적 이동 원리

**위치:** `game.js:1487~1503`

```
매 프레임:
  1. 현재 목표 waypoint를 가져옴 (enemyPath[pathIndex])
  2. 목표까지의 거리(dx, dy)를 계산
  3. 방향을 정규화 (dx/d, dy/d) → 단위 벡터
  4. 이동속도만큼 그 방향으로 전진
  5. 목표에 도착하면 pathIndex++ → 다음 waypoint로
  6. 마지막 waypoint 도착 = 출구 도달 → 생명 감소
```

정규화(normalize)란?

```
거리 d = √(dx² + dy²)
방향 = (dx/d, dy/d)  ← 길이가 항상 1인 벡터
이동 = 방향 × 속도 × dt
```

이렇게 하면 어느 방향이든 동일한 속도로 이동.

### 적 종류별 특성

| 종류   | 등장      | HP 배율 | 속도 배율 | 특수                                            |
| ------ | --------- | ------- | --------- | ----------------------------------------------- |
| normal | 웨이브 1~ | ×1.0    | ×1.0      | -                                               |
| fast   | 웨이브 2~ | ×0.5    | ×1.6      | 크기 작음, 웨이브 10+ armor 1, 18+ armor 2      |
| tank   | 웨이브 4~ | ×2.5    | ×0.6      | 방어력 2                                        |
| boss   | 5의 배수  | ×6.0    | ×0.45     | 방어력 3, 방어막/소환/가속돌진, 통과 시 생명 -5 |

---

## 5. 투사체(Projectile) 시스템

**위치:** `game.js:1058~1079`(클래스), `game.js:1621~1789`(업데이트 로직)

### 동작 원리

```
발사 → 매 프레임 적 추적 → 충돌 → 데미지 처리

1. 타워 위치에서 생성
2. 매 프레임: 타겟 적을 향해 이동 (유도 미사일처럼)
3. 적과의 거리 < 충돌 거리면 → 명중!
4. 명중 시:
   - 데미지 적용 (데미지 - 방어력, 최소 1)
   - 스플래시면 주변 적에게도 50% 데미지
   - 감속 효과가 있으면 적에게 감속 부여
   - 독 효과가 있으면 적에게 DOT(지속 피해) 부여
   - 적 HP ≤ 0이면 사망 처리 + 골드 획득
```

### 독(Poison) DOT 시스템

```
명중 시 → enemy.poisonTimer = 4초, poisonDmg = 5
    ↓
매 0.5초마다 독 데미지 적용 (방어력 감산)
    ↓
초록 기포 파티클 + 독 오라 이펙트
    ↓
4초 후 해제 (재감염 가능)
```

- 스플래시로 주변 적도 독 감염 (지속시간 60%)
- 독 데미지는 레벨업 시 기본 공식에 따라 증가

### 타워별 투사체 이펙트

| 타워 | 투사체 스타일                        |
| ---- | ------------------------------------ |
| 화살 | 얇은 직선 궤적 + 작은 화살촉         |
| 대포 | 큰 포탄 + 연기 잔상                  |
| 얼음 | 회전하는 다이아몬드 결정 + 사각 파편 |
| 번개 | 지그재그 전기 줄기 (2중) + 전기 구체 |
| 독   | 물결치는 독방울 + 초록 드립          |

### 잔상(Trail) 효과

```js
proj.trail.push({ x: proj.x, y: proj.y }); // 현재 위치 저장
if (proj.trail.length > 5) proj.trail.shift(); // 최대 5개만 유지
```

과거 5프레임의 위치를 저장해서 점점 투명하게 그리면 → 꼬리처럼 보임

---

## 6. 웨이브 & 난이도 시스템

**위치:** `game.js:1138~1263`

### 난이도 상승 공식 (v3.0 재조정)

```js
baseHp   = 30 + wave × 18 + wave^1.95 × 8       // 후반부 급가속 (지수 1.95)
count    = 5 + floor(wave × 1.8) + floor(wave/6) × 4  // 6웨이브마다 추가 투입
speed    = 1.0 + wave × 0.05 + floor(wave/8) × 0.08  // 8웨이브마다 속도 붐
goldBase = 5 + floor(wave × 0.5)                // 골드 보상 소폭 하향
```

| 웨이브 | baseHp | 총 적 수 | 타입 | 구성 비고                                        |
| ------ | ------ | -------- | ---- | ------------------------------------------------ |
| 1      | ~56    | 6        | 일반 | 일반 6                                           |
| 3      | ~152   | 10       | 일반 | 일반 + 빠른                                      |
| 5      | ~304   | 22       | 보스 | 일반 + 빠른 + 탱크 + **보스** + 호위병 2         |
| 7      | ~512   | 28       | 러시 | Fast 대량(26) + 탱크(2)                          |
| 9      | ~773   | 18       | 헤비 | 일반(12) + 탱크(6)                               |
| 10     | ~923   | 41       | 보스 | 일반(27) + 빠른(6) + 탱크(3) + 보스 + 호위병(4)  |
| 20     | ~3145  | 81       | 보스 | 일반(53) + 빠른(12) + 탱크(7) + 보스 + 호위병(8) |

※ baseHp에 타입별 계수(일반 0.8~1.2, Fast 0.45~0.5, Tank 2.2~2.8, Boss `6 + lv×2.2`) × 난수배율이 추가로 곱해져 실제 적 HP가 결정됨.

### 빠른 적 방어력

- 웨이브 10+: armor 1
- 웨이브 18+: armor 2

### 웨이브 흐름

```
웨이브 사이 5초 대기 (스킵 가능)
    ↓
startWave() → 적 목록 생성 (getWaveEnemies)
    ↓
0.5~0.8초 간격으로 적을 하나씩 스폰
    ↓
모든 적 처치 또는 통과
    ↓
웨이브 클리어 보너스 (10 + wave × 5 골드)
    ↓
다음 웨이브 대기...
```

---

## 7. 충돌 감지

### 거리 계산 함수

```js
function dist(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}
```

두 점 사이의 거리 = 피타고라스 정리

### 사거리 판정

```
dist(타워, 적) ≤ 타워사거리 × 타일크기  →  사거리 안에 있음!
```

### 투사체 명중 판정

```
dist(투사체, 적) < 이동속도 + 적크기  →  명중!
```

### 스플래시 판정

```
명중 지점에서 dist(투사체, 다른적) ≤ 스플래시 범위  →  범위 피해!
```

---

## 8. 파티클 & 이펙트 시스템

**위치:** `game.js:1081~1130`(클래스), `game.js:1345~1372`(적 사망 파티클), `game.js:1815~1830`(업데이트)

### 파티클 구조

```js
class Particle {
    x, y       // 위치
    vx, vy     // 속도 (방향 + 크기)
    life       // 남은 수명 (0이 되면 제거)
    maxLife    // 최초 수명 (투명도 계산용)
    color      // 색상
    size       // 크기
}
```

### 파티클 업데이트 (매 프레임)

```js
p.x += p.vx; // 이동
p.y += p.vy;
p.life -= dt; // 수명 감소
p.vx *= 0.95; // 마찰력 (점점 느려짐)
p.vy *= 0.95;
```

### 파티클 그리기

```js
ctx.globalAlpha = p.life / p.maxLife; // 수명에 따라 투명해짐
ctx.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2); // 크기도 줄어듦
```

### 사용처

- **피격**: 작은 파티클 1개 (투사체 색상)
- **스플래시 히트**: 방사형 파티클 6개
- **적 사망**: 12~30개 폭발 (적 종류별 색상)
- **떠오르는 텍스트**: "+5G", "웨이브 클리어!" 등

---

## 9. 입력 처리

**위치:** `game.js:3192~3440`

### 마우스

```
mousemove → hoveredTile 업데이트 (어느 칸 위에 있는지)
click →
  1. UI 패널 영역? → 타워 선택 / 업그레이드 / 판매
  2. 기존 타워 위? → 업그레이드 패널 표시
  3. 빈 잔디 칸? → 타워 배치 (골드 충분하면)
```

### 터치

마우스와 동일한 로직, `touchstart`/`touchmove`/`touchend` 사용

### 키보드

```
1~5: 타워 선택 (5=독 타워)
Space/Enter: 웨이브 시작
U: 선택된 타워 업그레이드
S: 선택된 타워 판매
Q: 게임 속도 전환 (x1 → x2 → x3 → x1)
M: 사운드 음소거/해제
Escape: 선택 해제
```

---

## 10. 게임 속도 시스템

```js
let gameSpeed = 1; // 1, 2, 3
const dt = rawDt * gameSpeed; // 모든 로직에 배속 적용
```

- Q키 또는 UI 버튼 클릭으로 전환
- x1: 기본 속도 / x2: 2배속 / x3: 3배속
- `rawDt`(실제 시간)에 배속을 곱해서 모든 이동/타이머에 적용
- 보스 경고 연출은 실제 시간(rawDt)으로 동작 (배속 영향 없음)

---

## 11. 보스 이벤트 시스템

### 5웨이브마다 보스 출현

```
웨이브 5, 10, 15, 20...
  ↓
빨간 경고 화면 2.5초 ("⚠ BOSS WAVE ⚠")
  ↓
보스 + 호위병(탱크) 함께 출현
```

### 보스 스케일링

```
보스 레벨 = 웨이브 / 5
HP 배율 = 6 + 보스레벨 × 2.2  (Lv1=8.2배, Lv2=10.4배, Lv3=12.6배...)
호위병 수 = 보스레벨 × 2 (최대 8, type='tank')
호위병 HP = baseHp × 1.5
보상 = goldBase × 5 + 보스레벨 × 10
```

### 보스 특수능력 (v2.1)

| 능력     | 첫 발동 | 재사용  | 효과                                                  |
| -------- | ------- | ------- | ----------------------------------------------------- |
| 방어막   | 5~8초   | 12~17초 | maxHP×15% 실드, 파란 육각형 배리어                    |
| 소환     | 8~12초  | 10~15초 | 소형 적 2~4마리 (HP=보스maxHP×3%, 속도×1.4, 크기×0.7) |
| 가속돌진 | 12~17초 | 12~17초 | 2초간 속도×2.5 (감속 무시), 빨간 속도선               |

- `applyDamageToEnemy()` 헬퍼가 모든 데미지를 중앙 처리 (직접히트, 스플래시, 독틱, 체인)
- 실드 활성 중 데미지는 실드에서 먼저 차감, 초과분은 HP에 적용
- 실드 파괴 시 "방어막 파괴!" 텍스트 + 사운드

### 보스 비주얼

- 붉은 맥동 오라 (1.6배 크기)
- 양쪽 뿔 + 왕관
- 빛나는 빨간 눈 (shadowBlur 효과)
- 세로 슬릿 동공
- 톱니 이빨
- 파란 육각형 방어막 (shield > 0일 때)
- 빨간 속도선 (가속돌진 중)
- HP바 아래 실드바 (파란색)

---

## 12. 렌더링 순서 (draw 함수)

그리는 순서가 곧 **레이어 순서** (먼저 그린 것이 아래에 깔림). 1~19는 스크린쉐이크 transform 내부에서 렌더 → ctx.restore → UI 레이어(20~).

```
1. 잔디/길 모던 배경                          ← 가장 아래 (v3.1: 오프스크린 backgroundCache drawImage)
2. 경로 디테일 (조약돌/균열)
3. 잔디 블레이드 (바람 흔들림)
4. 지면 충돌 마크 (투사체 히트 잔흔)
5. 경로 방향 화살표 (반투명)
6. 입구/출구 마커 (IN, OUT)
7. 타워 사거리 미리보기 + 고스트 타워 (hover 시)
8. 타워들 (그림자 + 베이스+터렛 스프라이트)
9. 머즐 플래시 글로우
10. 타워 레벨 별표 (픽셀 스타일 ★)
11. 선택된 타워 사거리 원
12. 적들 (상태 오버레이 + 픽셀 스프라이트 + HP바 + 실드바)
13. 투사체 (타워별 고유 이펙트)
14. 파티클 이펙트
15. 충격파 링 (Shockwave)
16. 체인 번개 줄기
17. 앰비언트 파티클 (먼지/반딧불이)
18. 떠오르는 텍스트 (+5G, CRIT! 등)
19. 웨이브 전환 오버레이 (Wave N 슬라이드)
— 스크린쉐이크 restore —
20. HUD 패널 (하단 그라디언트) + 스탯 뱃지 + 속도/볼륨/언어 버튼
21. 경고 오버레이 (BOSS/RUSH/HEAVY, 게임 필드 위)
22. 타워 선택 버튼 5개
23. 업그레이드 팝업
24. 시작 프롬프트 / 카운트다운 박스
25. 게임오버 연출 (어두워지기 → GAME OVER → 점수 → 재시작 버튼)
26. 세로모드 회전 오버레이        ← 가장 위
```

---

## 업그레이드 아이디어

코드 구조를 이해했으니, 추가할 수 있는 것들:

### 쉬운 난이도

- [x] **새 타워 종류** (독 타워 — v1.1)
- [x] **새 적 종류** (스와름 — v3.3)
- [ ] **추가 적 타입** (공중 유닛 / 분열 / 치유사)
- [ ] **경로 변경** → `MAPS` 배열 수정
- [ ] **타워 최대 레벨 올리기** → 현재 5 → 원하는 만큼
- [x] **타워 레벨 티어 시각화** (v3.2 pip/크라운 → v3.3 타워 자체 진화)

### 중간 난이도

- [x] **타워 특수능력** (독 DOT, 화살 치명타, 번개 연쇄)
- [x] **적 특수능력** (보스: 방어막, 소환, 가속돌진)
- [x] **특수 웨이브** (러시/헤비/스와름)
- [x] **여러 맵** (v3.3 — S-Curve/Zigzag/Loop 랜덤 선택)
- [x] **일시정지** (v3.3 — P 키)
- [x] **중세풍 커서 + 선택 해제** (v3.3)
- [ ] **스킬/마법** (화면 탭으로 범위 폭발, 시간 정지, 골드 러시)
- [ ] **자동 타깃팅 모드** (타워별: 가장 먼 / 가장 약한 / 가장 강한)
- [ ] **타워 드래그 이동** (재배치 시스템)
- [ ] **다음 웨이브 미리보기** (구성 아이콘 힌트)
- [ ] **타워 배치 고스트 프리뷰**
- [ ] **맵별 특수 보너스** (Loop=골드↑ 등)

### 도전적

- [x] **UI 모던 리워크** (v3.2)
- [x] **투사체 이펙트 강화** (v3.2)
- [x] **벡터 그래픽 전면 전환** (v3.3)
- [x] **타워 레벨별 시각 진화** (v3.3 — Lv1~Lv5 별도 디자인)
- [x] **세균/바이러스 테마 적** (v3.3)
- [x] **보스 HP 바 + 웨이브 진행도** (v3.3)
- [x] **성능 최적화** (v3.2~v3.3 — filter 제거, DPR 캡, 타겟팅 캐싱)
- [ ] **타워 조합 시스템** (두 타워를 합쳐서 새 타워)
- [ ] **멀티 경로** (적이 두 갈래로 나뉘어 진입)
- [ ] **메타 진행 시스템** (판마다 영구 업그레이드 포인트)
- [ ] **무한 모드 + 리더보드 (Poki API)**
- [ ] **BGM** (프로시저럴 생성, 메인/웨이브/보스 3종)
- [ ] **서포트 타워 (6번째)** — 인접 버프
- [ ] **궁극기 시스템** (1회용 핵/시간정지/골드러시)

---

## 13. 모바일 반응형 시스템 (v3.0 재작성)

**위치:** `game.js:82~136`, `index.html` `@media` 쿼리

### 핵심 원리: TILE = CSS 크기, DPR = 물리 해상도 배율

v3.0부터 cssScale 상한 제거 + devicePixelRatio 적용으로 변경.

```
1. availW/availH = 화면 크기 - 최소 여백
2. TILE = floor(min(availW/COLS, availH/TOTAL_ROWS))  (MIN_TILE=32, MAX_TILE=96)
3. W, H = COLS×TILE, TOTAL_ROWS×TILE  (CSS 좌표 = 게임 로직 좌표)
4. canvas.width = W × DPR, canvas.height = H × DPR  (물리 픽셀)
5. canvas.style.width = W + 'px'  (CSS 픽셀)
6. ctx.setTransform(DPR, 0, 0, DPR, 0, 0)  (모든 draw 코드를 DPR 배율로)
7. ctx.imageSmoothingEnabled = false  (픽셀 아트 보간 비활성)
```

### 모바일 여백 최소화

- 모바일 가로: `marginW=2, marginH=4` (제목/안내 CSS에서 숨김)
- 모바일 세로: `marginW=6, marginH=28`
- 데스크톱: `marginW=16, marginH=60`

### CSS 미디어 쿼리 (index.html)

`@media (max-width: 768px), (max-height: 500px)`:

- body `position: fixed` + `padding: 0`
- h1, #info 완전 숨김
- canvas border-radius 제거, box-shadow 제거
- `image-rendering: pixelated` **제거** (v3.1: HUD 이모지 깨짐 방지, 스프라이트만 `imageSmoothingEnabled=false`로 선명 유지)

### 터치 좌표 변환

`getCanvasPos()`가 `W / rect.width` 비율로 게임 로직 좌표(CSS px)로 변환.
물리 픽셀이 아닌 CSS 좌표 기반이므로 DPR과 무관하게 정확.

### isMobile 플래그

```js
isMobile = "ontouchstart" in window && (innerWidth <= 768 || innerHeight <= 500);
```

이 플래그로 다음을 조건부 처리:

- 키보드 단축키 힌트 `[1]`, `[Q]` 숨김
- "스페이스바 / 탭으로 시작" → "탭으로 시작"
- "클릭하여 다시 시작" → "탭하여 다시 시작"
- 잔디 블레이드 수 감소 (3개→1개/타일)

---

## 14. 사운드 시스템 (v2.0)

**위치:** `game.js:269~476`

### 핵심 원리: Web Audio API 프로시저럴 합성

외부 음원 파일(.mp3) 없이 `OscillatorNode`로 실시간 파형 생성.

```
AudioContext → OscillatorNode → GainNode → masterGain → destination
                (파형 생성)      (볼륨/엔벨로프)  (마스터 볼륨)   (스피커)
```

### 파형 종류

| 파형     | 음색            | 용도                   |
| -------- | --------------- | ---------------------- |
| sine     | 부드러운 순음   | 얼음, 독, 업그레이드   |
| square   | 8bit 레트로     | 화살, 게임오버, UI     |
| sawtooth | 거친 톱날음     | 보스 경고, 라이프 감소 |
| triangle | 부드러운 중간음 | 타워 배치              |

### 주요 합성 기법

- **주파수 스윕**: `frequency.exponentialRampToValueAtTime()`으로 음높이 변화 → "pew" 효과
- **화이트 노이즈**: `AudioBuffer`에 랜덤값 채워서 "쉬~" 질감 → 폭발/전기
- **(v3.3.1) 대역통과 필터 노이즈** (`filteredNoise(dur, vol, type, freq, q)`): `BiquadFilterNode`로 highpass/lowpass/bandpass 적용 → 자연스러운 휘이익(highpass)·둠(lowpass)·크랙 등을 합성. white noise 단독보다 훨씬 톤감 있음
- **(v3.3.1) FM Vibrato**: modulator OscillatorNode → GainNode(진동 폭) → carrier `frequency` AudioParam에 connect. carrier 음정이 LFO(저주파 발진기)에 따라 ±N Hz로 떨림 → "지리링" 전류 느낌(번개탑) 합성에 사용
- **맥놀이(Beat)**: 미세하게 다른 두 주파수 동시 재생 → 크리스탈/종소리 (얼음탑)
- **아르페지오**: 시간차를 두고 여러 음 순차 재생 → 웨이브 시작 팡파레
- **다층 어택+감쇠 엔벨로프**: `linearRampToValueAtTime(peak, t+attack)` → `exponentialRampToValueAtTime(0.001, t+release)`. v3.3.1 대포 잔향(0.55s)·얼음 다중 결정 등에 사용
- **엔벨로프**: `gain.exponentialRampToValueAtTime(0.001, endTime)` → 자연스러운 소멸

### 사운드 목록 (20종)

| 사운드           | 트리거      | 합성 방식                       |
| ---------------- | ----------- | ------------------------------- |
| Arrow fire       | 화살탑 발사 | (v3.3.1) **작은 볼륨**: triangle 1100→420Hz + 고대역 휘이익 노이즈 (vol≈0.035) |
| Cannon fire      | 대포탑 발사 | (v3.3.1 최종) **자극 완화**: sine 170→40Hz 0.2s 임팩트(vol 0.2) + lowpass **1000Hz** 0.07s 펑(vol 0.1) + sine 60Hz 0.2s 잔향(vol 0.085) |
| Ice fire         | 냉기탑 발사 | (v3.3.1 최종) **배경음 수준** — 단일 sine 1800Hz, vol 0.012, 노이즈 제거, 0.1s, cooldown 0.1s |
| Lightning fire   | 번개탑 발사 | (v3.3.1 최종) **저음 "찌리리"** — triangle **200Hz** carrier + 22Hz vibrato(±40Hz FM) + envelope 두 펄스(0.038/0.03) 0.18s + 1200Hz highpass 노이즈(0.01) |
| Poison fire      | 독탑 발사   | (v3.3.1) 180→290→150→245→170Hz 저주파 5단 진동 + 저대역 거품 노이즈 |
| Enemy death      | 적 사망     | (v3.3.1) **톤 제거 + 누적 방지**: lowpass 600Hz puff 0.04s only (vol≈0.018, cooldown 0.18s). sine pop 제거 — "뿅" 누적 거슬림 해소 |
| Boss death       | 보스 사망   | noise×2 + sine×2                |
| Wave start       | 웨이브 시작 | C5→E5→G5 아르페지오             |
| Boss warning     | 보스 웨이브 | sawtooth 55Hz 럼블              |
| Tower place      | 배치        | triangle 200 + sine 100Hz       |
| Tower upgrade    | 업그레이드  | sine 600→800→1000→1300Hz        |
| Tower sell       | 판매        | square C6→E6                    |
| Life lost        | 라이프 감소 | sawtooth 440→220Hz              |
| Game over        | 게임오버    | square C5→G4→C4→C3 하강         |
| Arrow crit       | 치명타 히트 | (v3.3.1) **호출 제거** — 치명타 처치 시 enemyDeath와 동시 재생되며 "뿅" 톤이 거슬려서 사운드 미사용. 시각 이펙트(금색 파편 + 치명타! 텍스트)는 유지 |
| Lightning chain  | 연쇄번개    | (v3.3.1) **호출 제거** — 체인 바운스마다 lightningFire와 누적되어 거슬림. 시각 효과(지그재그 번개)만 유지. 메서드 정의 보존 |
| Boss shield      | 보스 방어막 | sine 600 + 900Hz                |
| Boss summon      | 보스 소환   | sawtooth 100→300Hz + noise      |
| Boss speed burst | 보스 가속   | square 300→900Hz                |
| UI click         | UI 클릭     | sine 800Hz, 0.03s               |

### 브라우저 정책

첫 클릭/터치 시 `soundManager.init()`을 호출하여 `AudioContext`를 생성.
브라우저는 사용자 상호작용 없이 오디오 재생을 차단하므로 이 패턴이 필수.

---

## 15. 앰비언트 시스템 (v2.0)

**위치:** `game.js:541~621`

### 정적 데코레이션 (1회 생성)

- **잔디 블레이드**: 잔디 타일마다 1~3개, `Math.sin()` 기반 바람 흔들림
- **경로 디테일**: 경로 타일마다 3~5개 조약돌/균열, 반투명 렌더링

### 동적 파티클 (매 프레임)

- **먼지/반딧불이**: 잔디 위에 랜덤 스폰, 최대 30개
- 반딧불이는 `shadowBlur` 글로우 + 위로 떠오름
- 먼지는 작고 반투명, 미세한 드리프트

---

## 16. 스크린쉐이크 & 충격파 (v2.0)

### 스크린쉐이크

```
ctx.save() → ctx.translate(randomX, randomY) → [게임 렌더링] → ctx.restore() → [UI 렌더링]
```

UI 패널은 흔들리지 않도록 `restore()` 후에 그림.

| 트리거        | 강도 | 지속  |
| ------------- | ---- | ----- |
| 보스 사망     | 8px  | 0.4s  |
| 대포 스플래시 | 3px  | 0.15s |
| 라이프 감소   | 4px  | 0.2s  |

### 충격파 링 (ShockwaveRing)

반지름 0→maxRadius 확장 + 투명도 감소. 적 사망 시 생성.
보스는 TILE×3 크기, 일반 적은 TILE×1.5. 최대 10개 동시.

---

## 17. UI 폴리시 (v2.0)

- **패널 그라디언트**: `createLinearGradient()`로 위→아래 밝음→어두움
- **버튼 호버 글로우**: `mousePos` 추적, 호버 시 밝은 배경 + 선택 시 `shadowBlur`
- **골드/라이프 플래시**: 값 변경 시 뱃지에 색상 오버레이 (0.4~0.5s)
- **웨이브 전환**: 텍스트 슬라이드인→정지→슬라이드아웃 (1.5s)
- **게임오버 연출**: 어두워지기(0.5s) → GAME OVER 스케일인 → 점수 카운트업 → 최고점수 → 재시작 안내 깜빡임
- **볼륨 버튼**: 🔊/🔇 토글, M키 단축키

---

## 18. 타워 특수능력 (v2.1)

### 화살탑 치명타

- 20% 확률로 치명타 발동 (Projectile 생성 시 결정)
- 치명타 데미지 = 기본 데미지 × 2.5
- 금색 "치명타!" FloatingText + 금색 파티클 8개
- 투사체 렌더링: 금색 글로우, 더 큰 화살촉

### 번개탑 연쇄공격

- 직접 히트 후 주변 적에게 최대 3회 체인
- 체인 사거리: 2.5 타일, 데미지 감쇄: 70% (0.7^n)
- 이미 맞은 적은 재히트 불가
- 지그재그 번개 줄기 시각효과 (0.25초 페이드)
- 체인으로 인한 사망 처리 포함

---

## 19. 모바일 가로모드 최적화 (v2.1)

### 세로 모드 감지

- 터치기기 + 짧은 변 ≤500px + 세로 → "화면을 가로로 돌려주세요" 오버레이
- 오버레이 중 update() 일시정지

### 가로 모드 최적화

- 여백 축소: 모바일 가로일 때 `marginW=2, marginH=4` (데스크톱 16/60 대비 대폭 축소)
- MIN_TILE=32, MAX_TILE=96 (v3.0부터 DPR로 선명도 확보 → TILE 상향 가능)
- CSS: `@media (max-height: 500px) and (orientation: landscape)` → h1, #info 숨김

### 방향 변경 감지

- `screen.orientation.change` + `orientationchange` 이벤트로 resize() 재호출

---

## 20. UI 개선 (v2.1.1 → v3.2에서 재설계)

> ⚠️ 이 섹션의 상세 내용은 **v3.2 UI 리워크로 대체**됨. 아래 `## 23. v3.2 UI 리워크` 참고.
> v2.1.1의 핵심 발상(동적 너비 계산, 클릭 히트박스 저장, restartBtn 로컬라이제이션)은 유지되었으나 레이아웃/스타일은 완전히 재작성되었음.

### v2.1.1에서 해결한 근본 문제 (여전히 유효)

- `window._speedBtn / _volBtn / _langBtn / _upgradeBtn / _sellBtn / _restartBtn / _rewardedAdBtn` 히트박스 전역 저장 패턴
- `measureText()` 기반 텍스트 오버플로 방지
- `restartBtn` 로컬라이제이션 키 (`'다시 시작' / 'Restart'`)

---

## 21. 픽셀 캐릭터 + 모던 UI 하이브리드 (v3.1)

**위치:** 스프라이트 시스템 `game.js:623~910` / 배경 캐시 `game.js` 내 `generateBackgroundCache`

### 설계 철학

- **캐릭터/타워** = 픽셀 스프라이트 (레트로 감성, 정수 배율로 선명 유지)
- **UI/배경/HP바** = 모던 클린 (그라디언트, 둥근 모서리, 부드러운 그림자)
- 두 스타일이 충돌하지 않도록 `imageSmoothingEnabled`는 기본 ON이고 `drawSprite` 내부에서만 OFF

### 픽셀 모드 격리

```js
// resize() 끝부분
ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
ctx.imageSmoothingEnabled = true;
ctx.imageSmoothingQuality = "high";

// drawSprite() 내부
ctx.save();
ctx.imageSmoothingEnabled = false; // 이 그리기만 픽셀 퍼펙트
// drawImage ...
ctx.restore(); // 자동으로 smoothing=true 복원
```

CSS에는 `image-rendering: pixelated` **적용하지 않음** — HUD 텍스트/이모지가 깨지기 때문.

### 핵심 API

```js
createSprite(dataArray, palette); // 문자열 2D 배열 → 오프스크린 캔버스
drawSprite(sprite, cx, cy, pxSize, rotation); // 정수 배율 확대 + 회전
generateBackgroundCache(); // 잔디/경로 정적 배경 → 오프스크린 캔버스
```

### 스프라이트 목록 (v3.1 해상도 상향)

| 이름                      | 크기         | 디테일                                                |
| ------------------------- | ------------ | ----------------------------------------------------- |
| enemyNormal               | 24×24        | 고블린 — 뿔+하이라이트+볼터치+이빨+외곽선             |
| enemyFast                 | 24×24        | 초록 박쥐 — 날개 펼침+노란 눈+송곳니+꼬리             |
| enemyTank                 | 28×28        | 중장갑 오크 — 헬름 바이저+어깨 뿔+벨트+다리 분리      |
| enemyBoss                 | 40×40        | 악마왕 — 왕관 보석+큰 뿔+빨간 눈+이빨 2단             |
| towerArrowBase/Turret     | 16×16 / 5×11 | 나무 탑(창문+하이라이트) + 돌 기단 + 회전 활          |
| towerCannonBase/Turret    | 16×16 / 7×9  | 돌 요새(총안+흉벽) + 철 포신 하이라이트               |
| towerIceBase/Turret       | 16×16 / 5×5  | 얼음 오벨리스크(크리스털+기단) + 회전 결정            |
| towerLightningBase/Turret | 16×16 / 3×3  | 테슬라 코일(전도체+베이스) + 노란 점                  |
| towerPoisonBase           | 16×16        | 가마솥 + 다리, 거품 애니메이션은 별도 원으로 오버레이 |

### 표시 크기 계산 (v3.1)

TILE 기반으로 고정 비율, 정수 pxSize로 반올림 → 보간 없이 선명.

```js
// 적 타입별 표시 폭
targetDisplay = { normal: TILE * 1.0, fast: TILE * 1.0, tank: TILE * 1.35, boss: TILE * 2.0 }[type];
displayScale = max(1, round(targetDisplay / sprite.width));

// 타워 베이스
basePx = max(1, round((TILE * 0.95) / 16));
```

### 배경 캐시 (v3.1 신규)

잔디/경로는 정적이므로 오프스크린 캔버스에 한 번만 렌더:

```js
let backgroundCache = null;
// resize() 끝에서 backgroundCache = null (무효화)
// draw() 첫 호출 시 generateBackgroundCache()로 채워지고 이후 drawImage()로만 그림
```

- DPR 적용: `off.width = W * DPR`, `octx.scale(DPR, DPR)`
- 수직 그라디언트 잔디 + 랜덤 스팟 60개 (밝은/어두운) + 라디얼 경로 타일 + 경로 외곽선 단일 패스 stroke + 흙 얼룩 점

### 부드러운 그림자 (v3.1)

캐릭터/타워 그림자는 `ctx.filter = 'blur(2px)'`로 자연스럽게 번지게 렌더.

### 피격 플래시

적 피격 시 `ctx.filter = 'brightness(3)'`로 스프라이트 전체를 흰색처럼 렌더.
iOS Safari 14+ / Chrome 52+ / Firefox 49+ 지원.

---

## 22. 밸런스 조정 (v3.2 완화)

**위치:** `game.js:1243~1247`(업그레이드 비용), `game.js:1140~1265`(웨이브 공식/특수 웨이브)

### HP/수량/속도 공식 (v3.2 최종)

v3.0(너무 쉬움→너무 어려움 양극단) 후 v3.2에서 중도 지점으로 재조정.

```js
// v3.2 최종
baseHp = (30 + w * 18 + w) ^ (1.78 * 6.5);
count = 5 + w * 1.8 + floor(w / 7) * 3;
speed = 1.0 + w * 0.04 + floor(w / 10) * 0.06;
goldBase = 5 + floor(w * 0.55);

// 변화표 (v2.1 → v3.0 → v3.2)
// 웨이브 10 HP: 511 → 923 → 720  (중반 체감 +40%)
// 웨이브 20 HP: 2916 → 1860       (후반 완화)
```

### 업그레이드 비용 (v3.2 완화)

```js
upgradeCost = (cost * 0.7 * 1.5) ^ (level - 1);
```

레벨별 배율: Lv1→2 = 0.7×, Lv2→3 = 1.05×, Lv3→4 = 1.575×, Lv4→5 = 2.36×
(v3.0의 1.7^ 지수에서 1.5^로 완화해 만렙 투자가 합리적 수준)

### 특수 웨이브 (러시/헤비)

`getWaveEnemies()`에서 웨이브 번호에 따라 패턴 결정:

- **보스**: `w % 5 === 0` (w=5,10,15...) — 보스 HP = baseHp × (4.8 + bossLevel × 1.4)
- **러시**: `w >= 7 && w % 3 === 1` (w=7,13,19...) — Fast 대량(count + w×0.4) + 탱크 소수
- **헤비**: `w >= 9 && w % 3 === 0` (w=9,12,18...) — 일반 절반 + 탱크 중심 (w×0.5)
- **일반**: 나머지

보스는 호위병 minions를 최대 6마리까지 동반 (`bossLevel × 2`, 최대 6).

---

## 23. v3.2 UI 리워크

**위치:** `game.js:2200~2770`(HUD), `game.js:2772~2980`(타워 버튼), `game.js:2982~3200`(업그레이드 패널), `game.js:3202~3320`(웨이브 프롬프트), `game.js:3320~3555`(게임오버)

### HUD 레이아웃 원칙

```
┌────────── 좌우 UI_PAD=max(10, TILE×0.22) ──────────┐
│ [골드] [하트] [별]   │   [한/EN] [🔊] [속도]       │
│  badgeW = TILE×1.95   dividerX   uniformBtnW=TILE×1.5│
└──────────────────────────────────────────────────────┘
```

- **왼쪽 스탯 3개**: 고정 폭 `TILE×1.95` (최소 100px). 컨텐츠 크기 기반, 늘어나지 않음.
- **오른쪽 버튼 3개**: 동일 폭 `TILE×1.5` (최소 76px). `drawIconBtn` 헬퍼로 통일 렌더.
- **세로 divider**: 스탯과 버튼 사이. 중앙 진한 그라디언트(위아래 페이드).
- **상단 우측 웨이브 뱃지**: 게임 필드 위 영구 표시. `⚔ Wave N`. 보스 웨이브면 빨강 틴트.
- **IN/OUT 마커**: 텍스트 → 아이콘. ▶ 초록 화살표(입구) / ◎ 빨강 과녁(출구). 맥박 애니메이션.

### drawIconBtn 헬퍼 (버튼 통일 렌더)

```js
function drawIconBtn(bx, by, bw, bh, opts)
// opts: { bgA, bgB, border, icon, iconColor, iconFont, glow, active }
```

- 세로 그라디언트 배경 + 둥근 모서리 8px
- 상단 45% 영역 화이트 광택 (`tl/tr`만 둥글게)
- `active: true`면 외곽 글로우 shadow
- 모든 옵션 버튼(속도/볼륨/언어)이 동일 스타일

### drawRoundRect 확장 (v3.2)

```js
drawRoundRect(x, y, w, h, r);
// r = 스칼라 → 4 코너 동일
// r = { tl, tr, bl, br } → 코너별 반경 (상단만 둥글게 등)
```

상단 광택 오버레이(`{tl, tr, 0, 0}`) 그릴 때 유용.

### 타워 업그레이드 패널

- `drawActionBtn(bx, by, bw, bh, variant, label, enabled)` 공통 헬퍼
- **variant**: `'upgrade'`(초록) / `'sell'`(빨강) / `'max'`(황금)
- **라벨 overflow 방지**: 가능한 모든 라벨(업그레이드/MAX LEVEL/판매)의 최대 너비를 측정해 `btnMinW = maxLabelW + btnPadH×2`로 설정
- **폰트 자동 축소**: 라벨이 버튼 내부 너비를 초과하면 `ctx.font` 크기를 1px씩 줄이는 while 루프
- 패널 너비: `max(title, statsRow, btnsRow) + panelPad×2`, 최대 `W-16`

### 타워 선택 버튼 (하단)

- 동일 `btnW`, 동일 `tBtnGap = max(6, TILE×0.12)`
- **좌측 아이콘 영역 30% 고정** + 우측 텍스트 영역 `maxWidth` 적용
- 이름/설명 모두 폰트 자동 축소 루프
- 선택 상태: 타워 고유 색으로 `shadowBlur=14` 글로우 + 2px 테두리
- 호버 상태: 그라디언트 한 단계 밝아짐
- 상단 광택 오버레이 35% 높이

### 웨이브 프롬프트 (시작/대기) — 알약형 CTA

기존 "스페이스바 / 탭으로 시작" 녹색 박스 → 현대적 CTA 버튼 스타일.

```
┌─────────────────────────┐
│ ▶  시작                 │
│    Space / Tap          │
└─────────────────────────┘
```

- 알약(pill) 형태 (`r = boxH/2`)
- **시작**: 초록 그라디언트 + 초록 글로우
- **웨이브 대기**: 파랑 그라디언트 + 파랑 글로우
- ▶ 화이트 삼각 아이콘 (왼쪽 고정) + 메인 라벨(bold) + 힌트 라벨(2단)
- 외곽 글로우 맥박 (`shadowBlur` 사인파로 진동)

### Game Over 오버레이

모던 모달 스타일로 전면 재작성.

1. **라디얼 비네트**: 중앙은 살짝 어둡고, 가장자리 더 진하게
2. **모달 패널**: 중앙 그라디언트 패널, 빨강 상단 라인 액센트, 상단 광택
3. **타이틀**: GAME OVER + 빨강 그라디언트 + 섀도우 글로우, scale-in(0.55→1.0)
4. **점수 카드**: 웨이브 / 점수 2분할, 세로 divider, 파랑(웨이브)/노랑(점수) 색 구분, 점수는 count-up 애니메이션
5. **최고점수 뱃지**: 신기록 시 `🏆 + 맥박 글로우`, 기존이면 회색 작은 텍스트
6. **CTA 버튼 2개** (`drawCTA` 헬퍼):
   - **부활 (보상형 광고)**: 초록 알약 + `🎬` + "광고 보고 부활 +5HP" + 맥박
   - **재시작**: 파랑 알약 + `↻` + "다시 시작"
7. 전체 fade-in + 타이밍 시퀀스 (타이틀 0.5s → 점수 1.0s → 버튼 1.8s)

---

## 24. v3.2 투사체 이펙트 강화

**위치:** `game.js:2420~2620` (projectile 렌더링)

### 화살 (Arrow Tower)

기존 "얇은 직선 + 작은 원"에서 완전 재작성:

- **방향 회전**: `Math.atan2(타겟 방향)`으로 스프라이트 자세 계산
- **2겹 빛줄기**: 외곽 글로우(lineWidth=3.5, alpha=0.25) + 내부 코어(lineWidth=1.5, alpha=0.85)
- **화살촉 삼각형**: 끝이 뾰족한 4점 다이아몬드, 그림자 블러 적용
- **화살대 선**: 촉 뒤로 얇은 갈색 라인
- **깃털 꼬리**: 뒤끝 4점 다이아몬드 깃털
- **치명타**: 금색(#ffe066) + 사이즈 40% 확대 + 글로우 14px

### 대포 (Cannon Tower)

- **자체 회전 포탄** (`Date.now()/80`)
- **금속 밴드** 1px 원형 선
- **하이라이트 원** 좌측 상단 오렌지 + 화이트 반사점
- **2층 연기 꼬리**: 외곽 회색 연기 원 + 내부 어두운 코어 + 뒤쪽 붉은 불꽃 (trail 60% 이후 구간)
- **불꽃 3개**: 포탄 주위 랜덤 위치에 작은 점 3개(빨강/오렌지/노랑)

---

## 25. v3.2 타워 레벨 티어 시각화

**위치:** `game.js:3558~3648` 내 "레벨 뱃지" 블록

레벨별 색상으로 한눈에 티어 구분 (이전 모두 황금 별 → 색 구분):

| Lv  | 티어명    | 색상                 | 형태                       |
| --- | --------- | -------------------- | -------------------------- |
| 1   | Basic     | 표시 없음            | -                          |
| 2   | Ranked    | **파랑** (`#7fd3ff`) | 다이아몬드 pip 1개         |
| 3   | Elite     | **초록** (`#7fffb5`) | 다이아몬드 pip 2개         |
| 4   | Epic      | **보라** (`#d07bff`) | 다이아몬드 pip 3개         |
| 5   | Legendary | **황금** (`#ffd84a`) | ♛ **크라운** + 맥박 글로우 |

Lv5는 특별 취급: 3개 보석이 박힌 왕관 모양 + `shadowBlur = 12 + sin(Date.now()/200)*4` 맥박.
각 pip는 화이트 하이라이트 점 포함, 글로우 shadow 적용.

---

## 26. v3.2 렌더링 최적화 / 개선

### HTML 타이틀 제거

`<h1>TOWER DEFENSE</h1>`, `#info` 삭제로 화면 세로 공간 확보.
`resize()`의 `marginH` 데스크톱 `60 → 24`로 단축.

### 배경 캐시 무효화

`resize()` 끝에 `backgroundCache = null` 설정 → 다음 `draw()`에서 재생성.
DPR 변경 / 창 크기 변경 시 자동 갱신.

### 좌우 공통 패딩 `UI_PAD`

```js
const UI_PAD = Math.max(10, Math.floor(TILE * 0.22));
```

HUD 스탯, 우측 버튼, 타워 선택 버튼 모두 동일 좌우 패딩 적용 → 가독성/일관성 확보.

전역 `waveType = 'boss'|'rush'|'heavy'|'normal'`로 경고 오버레이 색상/텍스트 결정.

### 경고 오버레이 색상

| 타입  | 배경                 | 텍스트    | 텍스트 내용         |
| ----- | -------------------- | --------- | ------------------- |
| boss  | `rgba(180,0,0,α)`    | `#ff2222` | ⚠ BOSS WAVE ⚠       |
| rush  | `rgba(220,180,0,α)`  | `#ffdd33` | ⚡ 러시 웨이브 ⚡   |
| heavy | `rgba(120,60,180,α)` | `#cc88ff` | 🛡 헤비 웨이브 🛡   |
| swarm | `rgba(40,180,80,α)`  | `#88ff88` | 🦠 스와름 웨이브 🦠 |

---

## 27. v3.3 벡터 그래픽 전환 + 세균 테마 (대규모 리워크)

**위치:** `game.js:3875~4930`(drawTowerBody, drawEnemyShape)

### 방향 전환: 픽셀 → 벡터

- 스프라이트 시스템은 v3.1~v3.2의 하이브리드였으나 v3.3부터 **모든 적/타워를 벡터 도형으로**만 드로잉
- `drawSprite()`/`createSprite()` 호출 제거 → DPR 의존도 소멸 + 성능 일정화
- 선명도는 `ctx.stroke()` + 해상도 독립 path로 해결

### 적 세균/바이러스 테마 (`drawEnemyShape(cx, cy, s, type, flash)`)

| 타입         | 실루엣          | 핵심 특징                                                       |
| ------------ | --------------- | --------------------------------------------------------------- |
| normal       | 가시 바이러스   | 회전 가시 8개 + 혈관 호 + 중앙 핵 눈                            |
| swarm (신규) | 마이크로 세균   | 작은 가시 6개 + 단일 빨간 외눈                                  |
| fast         | 아메바 박테리아 | 꼬리 채찍 + 촉수 3개 + 외눈                                     |
| tank         | 메가 포자       | 굵은 가시 6개 + 내부 노듈 + 후드 슬릿 눈                        |
| boss         | 초병원체        | 박동 덩어리 + 촉수 8개 + 다중 눈 4개 + 세로 균열 입 + 이빨 10개 |

모두 `flash=true` 시 흰색 실루엣 (`createWhiteSilhouette` 프리렌더 대체).

### 적 크기 웨이브별 스케일

```js
const waveScale = 1 + Math.min(0.35, (wave - 1) * 0.015);
const baseVs = { boss: TILE * 1.0, tank: TILE * 0.65, swarm: TILE * 0.3, default: TILE * 0.5 };
const vs = baseVs * waveScale;
```

20웨이브 이상 진행 시 모든 적이 약 30% 커져 위압감 증가.

### 타워 5종 × Lv1~Lv5 진화 (`drawTowerBody(x, y, s, typeIndex, angle, level)`)

공통 규칙:

- 타워 크기 `s = TILE × 0.62` (v3.2의 0.5에서 +24%)
- 공통 돌 베이스 제거, 타워별 고유 받침대만
- `isMax = level >= 5` 시 외곽 오라 맥박 + 받침대 황금 트림
- 하단 pip/크라운 뱃지 완전 제거 → 타워 자체 모양으로 레벨 표시

#### 화살 → 석궁 (Crossbow)

- 가로 Stock(나무 몸체) + 수직 Prod(활) + V자 활줄 + 중앙 볼트
- Lv2: 깃털 색 업그레이드
- Lv3: 민트 촉
- Lv4: 금속 보강 띠 + **더블 볼트**
- Lv5: 황금 프로드 + 빨간 빛 보석

#### 대포 (둥근 클래식)

- 마운트 받침(원) + 회전 뒷부분 원 + 원통 포신 — **모두 타워 중심 동심원**
- Lv2: 포신 길이↑
- Lv3: 밴드 3개
- Lv4: 리벳 장식 + **트윈 포신**
- Lv5: 화염 용포구 + 황금 링

#### 얼음 (크리스털 오벨리스크)

- 6각 기둥 + 회전 상단 다이아 결정
- Lv2: 눈송이 표식
- Lv3: 기둥 커짐
- Lv4: **궤도 얼음 조각 4개** (회전)
- Lv5: 궤도 조각 6개 + **왕관 결정**(여러 뿔) + 파랑 코어

#### 번개 — 레벨마다 완전히 다른 실루엣

- Lv1: 단순 금속 막대 + 작은 오브
- Lv2: 테슬라 코일 (가로 링 3개)
- Lv3: **쌍기둥** + 중앙 아크 + 큰 오브
- Lv4: **3전극 크라운** + 중앙 오브
- Lv5: **8각 오벨리스크** + 거대 상단 오브 + 궤도 위성 4개 + 지속 아크

#### 독 (가마솥)

- 받침대 다리 2개 + 검은 솥 + 독액 + 거품 애니메이션
- Lv2: 동일
- Lv3: 거품 5개
- Lv4: **해골 장식** (솥 정면)
- Lv5: **녹색 불꽃** (솥 아래) + **교차 뼈** (솥 위)

---

## 28. v3.3 3 맵 시스템

**위치:** `game.js:478~580`

```js
const MAPS = [
    { name: 'S-Curve', waypoints: [...] },   // 기본 구불구불
    { name: 'Zigzag', waypoints: [...] },    // 좌우로 길게
    { name: 'Loop', waypoints: [...] },      // ㄷ자 루프 3개 (v3.3.1: 중앙 ㄷ자 추가 꼬임)
];
let currentMapIndex = Math.floor(Math.random() * MAPS.length);
let waypoints = MAPS[currentMapIndex].waypoints;
```

**(v3.3.1) Loop 맵 강화**: 기존엔 좌측 ㄷ자(y=1~6) → 중앙 가로 길게(y=11) → 우측 ㄷ자(y=3~12) 구조라 중앙이 단조로웠음. `(7,11) → (7,8) → (10,8) → (10,11)` 작은 ㄷ자를 중앙(y=8)에 추가해 위로 한 번 꼬임. 좌측·우측 ㄷ자와 y 좌표가 겹치지 않아 시각적 충돌 없음.

`changeMap(idx?)` 함수가 맵 변경 + 경로 카브 + 엔티티 경로 재빌드 + 배경 캐시 무효화 + 잔디/경로 디테일 재생성까지 한 번에 처리.

`restartGame()` 호출 시 자동으로 랜덤 맵 선택.

---

## 29. v3.3 QoL 기능

### 중세풍 커서 (`updateCursor()`) — v3.3.1 hotspot 통합

3-state 우선순위로 커서가 결정된다:

```js
function updateCursor() {
    if (isOverHotspot(mousePos.x, mousePos.y)) target = "pointer";
    else if (selectedTower >= 0) target = CURSOR_CROSSHAIR;
    else target = "default";
    if (_lastCursor !== target) canvas.style.cursor = target;
}
```

- **버튼 위 → `pointer`** (HUD 버튼·타워 선택 버튼·업그레이드/판매·시작 CTA·Game Over CTA·기존 타워 셀)
- **타워 선택 중 → 황금 크로스헤어**
- **그 외 → 기본 화살표**

매 `draw()` 시작 시 `pointerHotspots.length = 0`으로 리셋, 각 버튼 그리기 위치에서 `addPointerHotspot(x, y, w, h)` 호출. `mousemove` 이벤트와 `draw()` 끝에서 `updateCursor()` 호출 → hotspot 변화(패널 열림/닫힘) 반영.

### 선택 해제 시스템

`selectedTower = -1` = 선택 없음 (건설 모드 꺼짐). 트리거:

- 같은 타워 버튼 재클릭 (토글)
- `Escape` 키
- 마우스 **우클릭**
- `0` 또는 `` ` `` 키
- 게임 리셋
- **(v3.3.1) 타워 건설 후 10초간 추가 건설 없음 → 자동 해제**

선택 없이 잔디 클릭 → 아무 동작 없음 (잘못 짓기 방지).

### v3.3.1 자동 선택 해제 (`buildIdleTimer`)

```js
let buildIdleTimer = 0; // 남은 초 (real time)

// placeTower 성공 직후
buildIdleTimer = 10;

// gameLoop 안 (rawDt 기반, 게임 속도/일시정지 무관)
if (buildIdleTimer > 0 && selectedTower >= 0) {
    buildIdleTimer -= rawDt;
    if (buildIdleTimer <= 0) {
        selectedTower = -1;
        updateCursor();
    }
}
```

명시적 선택 변경(타워 버튼·키 1~5·`0`/`` ` ``·`Escape`·우클릭·재시작) 시 `buildIdleTimer = 0`으로 카운트다운을 즉시 취소 → 사용자가 의도한 다음 선택은 영구 유지된다. 즉 "한 번 짓고 안 짓는다"는 흐름에서만 자동 해제가 발동.

### 일시정지 (P 키)

```js
let paused = false;
// gameLoop 안:
const dt = paused && !gameOver ? 0 : rawDt * gameSpeed;
```

- 일시정지 중엔 `update(dt=0)` 으로 모든 시스템 정지 (투사체 이동, 쿨다운, 적 이동 등)
- `draw()`는 계속 실행 → "⏸ 일시정지" 오버레이 표시
- 다시 P 누르면 재개

### 웨이브 진행도

```js
let waveTotalEnemies = 0;
// startWave() 시 waveTotalEnemies = enemySpawnQueue.length;
const remaining = enemies.filter((e) => e.alive).length + enemySpawnQueue.length;
```

상단 우측 웨이브 뱃지에 "웨이브 5 │ 12 / 30" 형식으로 표시.
가독성을 위해:

- 메인 웨이브 라벨: 흰색 bold
- 세로 구분선 (회색 반투명)
- 진행도: 노랑색 + 작은 폰트

### 보스 HP 바

```js
const boss = enemies.find((e) => e.alive && e.type === "boss");
if (boss) {
  /* 상단 중앙에 큰 HP 바 + 실드 바 */
}
```

보스 등장 시 화면 상단 중앙에 `W * 0.5` 너비의 빨간 HP 바 + 실드 바 (있을 경우).

---

## 30. v3.3 성능 최적화 (추가)

v3.2 최적화 기반 위에 더 공격적으로 정리:

### 제거/교체

- `ctx.filter = 'blur(2px)'` — 적/타워 그림자 완전 제거 (v3.3에서 아예 그림자 없음)
- `ctx.filter = 'brightness(3)'` — 피격 플래시는 `drawEnemyShape(..., flash=true)` 파라미터로 (사전 렌더 흰색 스프라이트도 불필요)
- DPR 상한 `3 → 1.5` — Retina 픽셀 수 44% ↓
- `Math.sqrt` 타워 타겟팅 → `distSq` (제곱 거리 비교)
- 타워 타겟팅: 매 프레임 재탐색 → **0.2초마다만** 전체 O(n) 재탐색 (`tower.targetRecheck`)
- 화살/번개 투사체 `shadowBlur` 제거 → 다층 반투명 원 할로로 대체
- 대포 투사체 연기 꼬리 3겹 → 1겹 + 뒤쪽 불꽃 색만 변경
- 경로 디테일 매 프레임 그리기 → `backgroundCache`에 프리렌더 포함
- 잔디 블레이드 개별 `stroke()` → 단일 `beginPath()` + `stroke()` 1회
- 앰비언트 파티클: 적 > 20마리 시 스폰 중단, > 15마리 시 반딧불 글로우 생략

### 결과

- 웨이브 26+ 기준 프레임당 GPU 필터 호출 100+ → 0
- drawcall 약 60~70% 감소
- 고사양 맥/레티나에서 쿨러 소음 대폭 감소

---

## 31. v3.3 UX 개선

- **타이틀/인포 HTML 제거** — 화면 세로 공간 확보, 캔버스 꽉 참
- **웨이브 뱃지 2세그먼트** — 메인 번호(흰색 굵게) │ 진행도(노랑 dim) 톤/크기 분리로 가독성↑
- **대포 동심원 정렬** — 마운트 받침/포신 기저/뒷부분 원이 모두 타워 중심 동심원 → 회전해도 어색하지 않음
- **IN/OUT 아이콘** — ▶ 초록 화살표 / ◎ 빨강 과녁, 맥박 애니메이션
- **커서 피드백** — 건설 모드만 크로스헤어, 일반 상태는 기본 화살표로 모호함 제거

---

## 32. v3.3.1 보완 패치 (커서 / 패딩 / 자동 해제 / 경로 / 숫자 포맷)

### 1) 커서 3-state (pointer / crosshair / default)

위 §29의 `updateCursor()` 참고. 버튼 hit-test가 다른 두 상태보다 우선.

### 2) 버튼 좌우 패딩 전반 확대

| 위치 | 변수 | 변경 |
|------|------|------|
| HUD 좌우 패딩·모든 gap | `UI_PAD = gap = btnGap = itemGap` | 통일 `max(8, TILE × 0.16)` (v3.3.1 폴리시) |
| HUD 스탯/버튼 높이 | `itemH` | `TILE × 0.65` 동일, `itemY` 공통 vertical center (v3.3.1 폴리시) |
| HUD 우측 (속도/볼륨/언어) | `uniformBtnW` | `TILE × 1.5 / 76` → `TILE × 1.7 / 92` |
| 타워 선택 버튼 내부 | `innerPad` | `max(8, TILE × 0.15)` → `max(12, TILE × 0.22)` |
| 업그레이드 패널 (업그레이드/판매) | `btnPadH` | `max(18, TILE × 0.35)` → `max(24, TILE × 0.5)` |
| 시작/스킵 CTA 박스 | `boxPad` | `max(16, TILE × 0.35)` → `max(22, TILE × 0.5)` |

### 3) 건설 후 10초 자동 해제

`buildIdleTimer`. 위 §29 참조.

### 4) 경로 둥근 모서리 + 흙톤 강화

`generateBackgroundCache()` 안의 경로 렌더링을 격자 단위 `fillRect` + 격자 외곽선 stroke 방식에서 **waypoints stroke 5겹**으로 교체.

```js
function strokeWaypoints(width, color, alpha) {
    octx.lineCap = 'round';
    octx.lineJoin = 'round';
    octx.beginPath();
    waypoints.forEach((wp, i) => {
        const px = wp.x * TILE + TILE / 2;
        const py = wp.y * TILE + TILE / 2;
        i === 0 ? octx.moveTo(px, py) : octx.lineTo(px, py);
    });
    octx.stroke();
}

strokeWaypoints(TILE * 1.06, '#2c1d0c', 0.85); // (1) 어두운 그림자 외곽
strokeWaypoints(TILE * 0.98, '#5a3d1c');       // (2) 진한 흙 가장자리
strokeWaypoints(TILE * 0.86, '#8d6a3c');       // (3) 메인 흙
strokeWaypoints(TILE * 0.42, '#a98558', 0.55); // (4) 가운데 밝은 하이라이트
strokeWaypoints(TILE * 0.18, '#c19868', 0.35); // (5) 중앙 미세 광택
```

- `lineCap='round'` + `lineJoin='round'` → 코너에서 자연스럽게 둥근 모서리
- 5겹 스택 → 외곽 어두움(진한 흙) → 중앙 밝음(부드러운 표면) 그라디언트 효과
- 흙 얼룩 다양화: 단일 색 → `['#4a3018', '#6a4828', '#3d2410']` 3톤 점 60개로 증가
- 격자 단위 fillRect/외곽선/라디얼 그라디언트는 모두 제거
- 정적 `backgroundCache`에 한 번만 그려지므로 **런타임 성능 영향 0**
- 흙 얼룩과 조약돌/균열은 grid path 셀 안에서만 그리도록 유지

### 5) 천단위 콤마 포맷 (`fmt()`)

```js
function fmt(n) {
    if (typeof n !== 'number' || !isFinite(n)) return String(n);
    return Math.floor(n).toLocaleString('en-US');
}
```

모든 정수 표시에 일괄 적용:

| 위치 | 변경 |
|------|------|
| HUD 스탯 | `${gold}` / `${lives}` / `${score}` → `fmt(...)` |
| 타워 선택 버튼 | `${type.cost}G` → `${fmt(type.cost)}G` |
| 업그레이드 패널 | `t.damage` / `t.totalDamage` → `fmt(...)` (`range` / `fireRate`는 소수점이라 `toFixed` 그대로) |
| 보스 HP 라벨 | `Math.ceil(boss.hp) / boss.maxHp` → `fmt(...)` |
| 진행도 뱃지 | `remaining / total` → `fmt(...)` |
| 시작/스킵 CTA | `웨이브 ${wave+1}` → `웨이브 ${fmt(wave+1)}` |
| Game Over 카드 | `wave` / `displayScore` → `fmt(...)` |
| 로컬라이제이션 함수 | `waveClear` / `waveNum` / `bossAppear` / `nextWave` / `waveScore` / `highScore` / `upgrade` / `sell` 안의 모든 숫자 인자를 `fmt()`로 감쌈 (한국어/영어 양쪽) |

예: 1,000,000G·웨이브 1,234·HP 12,345 / 99,999 식으로 가독성 확보. `toLocaleString('en-US')`로 로케일 무관 콤마 사용.

### 6) 타워 발사 사운드 재디자인

`SoundManager.filteredNoise(dur, vol, type, freq, q)` 헬퍼 신규 추가 (BiquadFilterNode 기반). 5종 타워 발사음을 모두 재합성:

- **화살** — 작은 볼륨(다른 타워의 1/3 수준): triangle 1100→420Hz 0.05s + 2200Hz highpass 휘이익. "**크게 안 들려도 됨**" 의도 반영
- **대포** — 묵직한 임팩트: sine 170→40Hz 0.2s + lowpass **1000Hz** 0.07s 펑 + sine 60Hz 0.2s 잔향. 게인 단계적 ↓: 임팩트 0.3→0.28→**0.2**, 펑 0.18→0.16→**0.1**(컷오프 1400→1000Hz), 잔향 0.18→0.12→**0.085**
- **얼음** — 크리스털: (1차) 1480/1850/2380Hz 3중주 → (2차) 게인 절반 → (3차) 2중주(1600/2000Hz) + cooldown 0.1s → (**최종, 배경음 수준**) 얼음은 게임 비중 낮은 보조 타워이므로 거의 들리지 않게 정리: **단일 sine 1800Hz**, vol 0.012, 노이즈 완전 제거, 0.1s, cooldown 0.1s 유지
- **번개** — (1~7차 변천 후 3차 복귀) → "찌리리" → (**최종, 저음 "찌리리"**) carrier triangle **200Hz** (320→200으로 추가 ↓), vibrato 22Hz 유지/폭 60→**40**(자극 완화), 볼륨 0.05/0.04→**0.038/0.03**, 노이즈 1500→1200Hz highpass + vol 0.014→0.01, 0.18s
- **독** — 보글보글: 180→290→150→245→170Hz 저주파 5단 진동 + lowpass 600Hz 거품 노이즈
- **적 사망** — 톤 제거: lowpass 600Hz puff 0.04s만 (vol≈0.018) + 사운드별 커스텀 cooldown 0.18s(`canPlay(name, customCd)`). sine pop을 빼서 다수 사망 시 "뿅" 누적이 사라짐
- **치명타 사운드 호출 제거** — 화살탑 치명타가 마지막 데미지로 적을 처치하면 `arrowCrit()` + `enemyDeath()`가 같은 프레임에 겹쳐 "뿅"이 들렸음. 호출만 제거(메서드 정의는 보존), 시각 이펙트는 그대로 유지
- **연쇄번개 사운드 호출 제거** — 번개탑 체인 바운스마다 `lightningChain()`이 재생되어 한 발사에 최대 4번 누적되며 새 발사음("스윽~")과 톤도 어긋남. 호출만 제거, 지그재그 번개 시각 효과는 그대로 유지

### 7) FloatingText 통일 디자인 + CRITICAL 강조

모든 floating text(골드 보상·라이프 손실·소환·가속·방어막 파괴·웨이브 클리어·CRITICAL)를 같은 디자인 시스템으로 통일.

**공통 (`'normal'`)**:
- 폰트: `900 weight, "Segoe UI", TILE × 0.36px`
- 외곽선: `lineWidth 3, '#1a1a22'`, `lineJoin: 'round'`
- 글로우: `shadowBlur 7`, 색상은 텍스트 색
- 그라디언트 채우기: 위 밝게(`lightenHex(color, 70)`) → 아래 원색 (`lightenHex` 헬퍼: hex → +amount RGB clamp 255)
- 등장 시 스케일 펄스: 1.25 → 1.0 (0.08s)

**CRITICAL (`'crit'`)** — 통일 톤 위에서 더 강한 변형:
- 폰트: `900 weight, TILE × 0.36px` (골드 등 일반 FloatingText와 **동일 사이즈**, 등장 펄스/효과로만 차별화)
- 외곽선: `lineWidth 5, '#2a0404'` (진한 검정-빨강)
- 글로우: `shadowBlur 20`, `#ff2020` (빨강 — 골드 #ffdd44와 색 분리)
- 그라디언트: `#ffe080 → #ff5028 → #cc0808` (황금→빨강 — 골드 FloatingText와 명확히 구분)
- 등장 펄스: 1.5 → 1.0 (0.12s) + `sin(elapsed × 14) × 0.04 rad` 살짝 좌우 흔들림
- 상단 광택 띠: clip rect로 흰색 띠 한 줄
- life 1.4s, vy −1.1 (일반 1.0s/−1.5보다 천천히 더 길게)

`txt().crit`은 한/영 모두 **'CRITICAL!'** 로 통일.

### 8) 폰트 패밀리 한글 fallback 추가 (게임 전체)

기존 `"Segoe UI", system-ui, sans-serif` 35곳 + `sans-serif` 단독 7곳(웨이브 전환 큰 텍스트·웨이브 뱃지 ⚔·속도 버튼·BOSS/RUSH 경고·boss appear·rotate overlay 📱/안내) = **총 42곳** 모두 `"Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", "Pretendard", system-ui, sans-serif`로 통일. 메뉴/HUD/패널/CTA/오버레이의 한글이 OS별 양질의 한글 글꼴(macOS=Apple SD Gothic Neo·Windows=Malgun Gothic·Pretendard 설치 시 우선)로 렌더.

### 8b) 큰 한글 텍스트 외곽선 + 글로우 통일 (CRITICAL 톤)

큰 임팩트 텍스트들에 CRITICAL 스타일과 같은 톤 적용 (외곽선 stroke + 글로우 shadowBlur + 색상 fill). 폰트 weight도 `bold`(700) → `900`로 올려 통일감. 적용 위치:

| 위치 | 외곽선 색 / 폭 | 글로우 색 / blur | 채우기 |
|------|---|---|---|
| 웨이브 전환 "웨이브 N" | `#0e1a30` / 5 | 푸른 `rgba(40,80,140,0.85)` / 14 | 파란 그라디언트(#dceeff→#5aa8ff) |
| BOSS/RUSH/HEAVY/SWARM 경고 | `#1a0606` / fontSize×0.08 비례 | textColor / 18 | textColor |
| bossAppear "웨이브 N - 보스 출현!" | `#3a2a00` / 4 | 위와 같음 | `#ffcc44` |
| 시작/스킵 CTA 메인 라벨 | start=`#0c2a14`, skip=`#0a1a2e` / 4 | 어두운 동색 / 6 | `#ffffff` |
| 일시정지 "⏸ 일시정지" | `#1a1a22` / 5 | `rgba(0,0,0,0.8)` / 12 | `#ffffff` |

작은 텍스트(스탯 숫자·메뉴 버튼·진행도·힌트)는 외곽선 미적용 — 가독성 저해 방지. CRITICAL/FloatingText는 §7 별도 시스템.

### 9-bis) 단축키 도움말 (`H` 키)

`let showHelp = false` 토글. **H** / **?** / **Esc** / 화면 어디든 **클릭** 으로 닫힘. 게임 시간엔 영향 없음(렌더 오버레이만).

오버레이 구성: 라디얼 비네트로 어둡게 + 중앙 패널(그라디언트 + 상단 파랑 액센트) + 타이틀("단축키"/"Shortcuts") + 11행 표 (왼쪽 황금색 키, 오른쪽 회색 라벨). 행: 1–5 / 0·` / Q / Space·Enter / P / U / S / M / L / Esc·우클릭 / H·?.

타워 선택 버튼 우상단 단축키 표시(데스크톱 한정)는 작은 텍스트 → **키캡 박스**(`900 weight TILE×0.26`, 라운드 박스 `keyH = keyFs + 12` 위아래 패딩 넉넉, 테두리 + 선택 시 흰색 강조, 위쪽 여백 `max(8, TILE×0.16)`, 텍스트는 middle baseline + 폰트 metric 미세 보정 `+keyFs*0.06`으로 박스 정중앙).

### 9) 시작/스킵 CTA 가운데 정렬 + width 확장

기존엔 아이콘+메인 라벨이 박스 좌측 패딩 시작점에 left-align, 힌트 라벨도 같은 좌측에 정렬되어 박스가 비대칭. 변경:

- `groupW = iconW + iconLabelGap + mainW`로 그룹 너비 계산
- `groupStartX = boxX + boxW/2 - groupW/2`로 그룹을 박스 중앙 정렬
- 힌트 라벨은 `textAlign='center'` + `boxX + boxW/2` 중앙 정렬
- `boxW = max(groupW, hintW) + boxPad×2 + 40`으로 좌우 여유 +20px씩 확보 (이전 +10 → +40)
- 메인 라벨 vertical center도 `boxH × 0.38 → 0.42`로 살짝 조정해 힌트와 균형

§14 사운드 목록 표 v3.3.1 행에 합성 방식 갱신.
