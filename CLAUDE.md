# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

설계 결정 배경은 [DESIGN.md](DESIGN.md), 사용자/실행 안내는 [README.md](README.md), 타일 빌드는 [docs/PIPELINE.md](docs/PIPELINE.md), 용어/참고문헌은 [docs/GLOSSARY.md](docs/GLOSSARY.md). 이 문서는 코드 작업용 빠른 참조.

## 프로젝트 개요

제주도를 중심으로 한 **5세기 후반(476년 전후) 고대 항해 체험 시뮬레이터**. 시대 앵커는 476년 탐라가 백제에 조공하며 국제 해상 네트워크에 공식 편입된 사건(『삼국사기』). **핵심 컨셉**: 플레이어는 "지도 위의 점"이 아니라 "배 위의 사람" (미니맵/좌표/고정 방위 없음, 태양·별·바람·해류로만 방향 판단).

Vite + TypeScript(Canvas 2D) 런타임 + Python 타일 빌드. 테스트 프레임워크 없음.

## 자주 쓰는 명령

```bash
# 프로토타입 실행 (포트 8089)
cd ~/works/tamra
npm install        # 최초 1회
npm run dev        # HMR dev 서버 → http://localhost:8089

# 프로덕션 빌드
npm run build      # dist/ 만 — tiles 미포함, ~150ms
npx vite preview   # 번들 미리보기 (포트 8089)
npm run lint:deps  # state.ts zero-import 회귀 검사

# 배포 번들 (Caddy 서브패스 /tamra 기준)
npm run release          # release/tamra/ = dist + tiles(WebP) + boat.png, rsync 증분
npm run release:zip      # release/tamra.zip (~63KB, tiles 제외) — 재배포 기본
npm run release:tile:zip # release/tamra-tile.zip (~207MB, tiles 포함) — 초기/타일 변경
npm run release:clean    # release/ 정리
# 상세 배포 절차: docs/DEPLOY.md

# 전세계 타일 파이프라인 (프로덕션)
python3 generate_world_tiles.py                 # 전체 실행
python3 generate_world_tiles.py --classify-only # 분류 통계만
python3 generate_world_tiles.py --tile 143,26   # 단일 타일 디버그
python3 generate_world_tiles.py --verify        # 제주 타일 비교

# Legacy: 제주 1024×1024 단일 PNG 생성 (--verify 비교용만, 신규 작업엔 사용 X)
python3 generate_maps.py
```

원본 DEM(`final_heightmap.raw`, 7GB)은 `~/works/heightmap/`에 별도 보관. `tiles/`와 `boat.png`는 `vite.config.ts` middleware 가 레포 루트에서 직접 서빙하므로 **이동 금지** (Vite asset graph 밖 → hash rename·dist 복사 둘 다 회피).

## 아키텍처 핵심

### 모듈 구조 (`src/`)

| 경로 | 책임 |
|---|---|
| `main.ts` | 엔트리, 초기화 orchestration, Draw RAF 루프 |
| `config.ts` | 상수 (SCR_W, SEA, TILE_SIZE, WORLD_* 등) |
| `state.ts` | mutable 싱글톤 모음 (boat/ship/camera/wind/sail/current/wave/weather/sun/moonState/timeRef/frameStats/uiFlags) |
| `canvas.ts` | canvas/ctx/buf32/buf8/imagedata + fitCanvas + PX_SCALE |
| `tiles.ts` | 타일 로더, altitude/colormap 링버퍼, slotTiles |
| `terrain.ts` | generateColormap + piecewise heightMeters LUT |
| `physics/wind.ts` | Hadley/Ferrel/Polar + ITCZ + 몬순 |
| `physics/sail.ts` | polarFor, computeSail, updateShipSpeed |
| `physics/current.ts` | 적도류·쿠로시오·동호주 |
| `physics/waves.ts` | swell + mid + ripple (wind/current 기반) |
| `physics/weather.ts` | cloudiness/visibility/precipitation (+ `__cloudOverride`) |
| `astronomy/sun.ts` | dayOfYear + δ/H → alt/az |
| `astronomy/stars.ts` | STARS, updateStars(→ planets/moon 호출) |
| `astronomy/planets.ts` | PLANETS + Meeus J2000 + Kepler |
| `astronomy/moon.ts` | Meeus 간이식 → λ/β → alt/az + phase |
| `sky.ts` | skyRow/skyGlowX/Y/skyGlow + updateSky + cloud mask |
| `render/voxel.ts` | **HOT PATH** — DrawVerticalLine + Render (bilinear 4-이웃) |
| `render/background.ts` | DrawBackground (sky/구름/별/행성/달/태양 halo) |
| `render/camera.ts` | UpdateCamera + moveBoat (3x3 shore buffer + 서브스텝) |
| `render/effects.ts` | drawNearFog / drawPrecipitation / drawLightning |
| `render/minimap.ts` | DrawMinimap + mmState.stride |
| `render/boat-sprite.ts` | DrawBoat + boatSprite.img |
| `render/skymap.ts` | DrawSkyMap (K 토글, polar azimuthal) |
| `input.ts` | initInput + inputState.{rotStep, moveStep} |
| `audio.ts` | Web Audio 절차생성 (audio 싱글톤, initAudio/resumeAudio/setMuted/updateAudio/flapBurst/uiBlip) |
| `debug.ts` | initDebugHooks (window.__* 전부 여기에) |

의존성 규칙: `state.ts` 는 zero-import (순수 데이터). 다른 모듈은 state 쪽으로만 흐른다 → 순환 불가. Hot loop (`render/voxel.ts` `Render()`) 은 함수 진입 시 state 프로퍼티를 local 변수로 캐싱 (ESM property access 인라인 유도).

### 렌더 파이프라인

s-macke/VoxelSpace 기반 + 확장. Draw 루프 순서 ([src/main.ts](src/main.ts) 의 `Draw()`):

```
UpdateCamera → DrawBackground(sky glow + 구름 + 별 + 행성 + 달 + 태양)
  → Render(bilinear VS, 수평선 위/아래 전부 담당)
  → drawNearFog(저시정 veil) → drawPrecipitation(비/눈) → drawLightning(뇌전 flash)
  → DrawMinimap → DrawBoat(buf → canvas flip + sprite)
  → DrawSkyMap(K키일 때 polar azimuthal 오버레이)
```

- **Bilinear 4-이웃 샘플링**: `heightMeters` (occlusion 판정용) 선행 → 통과 픽셀만 color bilinear
- **allSea fast path**: 4 이웃이 모두 SEA 이면 bilinear 스킵, 색·높이 상수 1회 ([src/render/voxel.ts](src/render/voxel.ts) `Render()` 내부)
- **지구 곡률**: `drop_m(z) = (z·UNIT_M)² / (2R)`, `UNIT_M=400` (한국 위도 기준 ~400m/px)
- **projScale**: `(SCR_H · 0.0044) / z` — 세로 해상도에 비례해 수직 FOV 일관
- **deltaz**: 초기 0.5, step당 `+0.005`. 모든 컬럼이 occlusion 닫히면 z 루프 early break (`openCount`)
- **20fps cap**: `FRAME_INTERVAL=50ms` + `FRAME_EPSILON=8ms` — rAF 16.67ms 정수배 근처 지터 방지
- **frame time EMA** (alpha=0.1): Draw 순수 계산 시간, cap 대기 시간 미포함

### 내부 해상도 & 캔버스

- 내부 렌더 `640x360` (16:9)
- `PX_SCALE`은 뷰포트에 맞춰 `floor(innerW/640)`·`floor(innerH/360)` 중 작은 값으로 정수배. `window.resize`로 갱신
- `image-rendering: pixelated`로 crisp pixel 유지

### 항해 시스템 (sail-based propulsion)

배는 돛으로 추진된다. **W/S로 돛을 내리고/올리면** `boat.sailUp` 토글, 매 프레임 자동 추진. A/D는 키 1회=1 step 회전.

- **돛 polar curve** ([src/physics/sail.ts](src/physics/sail.ts) `polarFor`): IRONS(0.05) / CLOSE(0.55) / BEAM(1.00) / BROAD(1.20) / RUN(0.90)
- **추진 속도** (`computeSail` + `updateShipSpeed`): `BASE_SAIL_SPEED(4 m/s) × polar × windFactor(wind/8, clamp 0.3~1.8)`
- **해류 drift**: 돛 추진 벡터 + 해류 벡터 = `ship.groundMS` / `ship.groundDirRad`
- **3x3 shore buffer**: 이동 대상 셀과 주변 8방향이 모두 바다여야 진입 허용
- **서브스텝 이동**: `SUBSTEPS = ceil(mvLen*4)` — 큰 step에서도 중간 셀 체크 누락 방지
- **카메라 = 배에 snap**: smoothing/spring-arm 제거. `camera.x/y/angle = boat.*` 직접 대입
- **카메라 높이**: 기본 `50m`, 지형 위에서 `지형높이 + 20m`로 자동 상승

### 환경 시스템 (전부 매 프레임 갱신)

| 시스템 | 함수 | 모델 |
|---|---|---|
| **시간/태양** | `astronomy/sun.ts` computeSun | 위/경도 + dayOfYear → δ/H → alt/az. 게임 정오부터 시작 |
| **바람** | `physics/wind.ts` computeWind | Hadley/Ferrel/Polar + ITCZ + 아시아 몬순 + 결정적 noise |
| **해류** | `physics/current.ts` computeCurrent | 적도류·아열대·편서풍 + 쿠로시오(110~150°E,20~45°N) + 동호주 |
| **파도** | `physics/waves.ts` computeWaves | swell(←해류) + mid/ripple(←바람), 진폭=wind.speedMS/8 |
| **별** | `STARS`, `starState` 실시간 alt/az, `starTwinkle*` | J2000 + GMST → LST → hour angle + 대기 굴절 twinkle |
| **행성** | `PLANETS` (수금화목토천해), `updatePlanets` | Meeus J2000 평균 궤도요소 + Kepler Newton's method |
| **달** | `updateMoon`, `moonState` 위상·halo | Meeus 간이식 → λ/β. cloudiness > 0.3 시 halo 가산 |
| **날씨** | `computeWeather` | ITCZ + 중위도 storm + 아열대 고기압 + 노이즈 → cloudiness, visibilityCoef, precipitation(>0.6 임계), precipType(위도 기반 rain/snow) |
| **대기광 / Halo** | `skyGlowX/Y` (separable), 태양 halo profile | 황혼 비대칭 붉은 띠(방위별), 태양 halo 고도별 반경·색 |
| **구름** | `updateCloudMask`, `cloudAlphaAt`, `cloudFull` | 64×18 value noise → bilinear 업샘플 → `SCR_W×200` 풀버퍼(30s 게임시간마다 1회). `cloudi<0.15`면 sky fill 빠른 경로 |
| **비/눈** | `drawPrecipitation`, `precipX/Y` | 300 스크린 공간 파티클, 바람 driftX + 중력 fallY. precipitation으로 active 수 조절 |
| **근거리 안개** | `drawNearFog` | visibilityCoef < 0.7 시 buf32 전체에 연회색/남청 veil 블렌드 (낮/밤 색 분기) |
| **뇌전** | `drawLightning` | cloudiness>0.85 + `gameTime/30000` bucket hash prob gate, real time 0~120ms flash, 쿨다운 1.5s |

**디버그 override** (window에서 직접): `__cloudOverride`(cloudiness), `__precipOverride`(precipitation 0~1), `__precipTypeOverride`('rain'|'snow').

### 오디오 (Web Audio, 절차생성)

- `initAudio()`: AudioContext + pink-ish noise 버퍼(4s) + waves(lowpass)·wind(bandpass) 루프 소스 + master gain
- 첫 키/포인터 제스처에서 `resumeAudio()` 호출 (iOS Safari suspended 대응)
- `updateAudio()`: 매 프레임 훅 — wind.speedMS 기반으로 waves gain/cutoff, wind gain/freq smoothing(`setTargetAtTime`)
- `flapBurst()`: 돛 올림 + sail.mode==='RUN'에서 1.2~3초 랜덤 간격 burst (bandpass noise, 250ms envelope)
- `uiBlip(freq)`: 돛 토글·시간가속 변경 시 짧은 sine AD envelope(100ms). 돛UP=520Hz·DOWN=340Hz, T=440·Y=660
- `setMuted()` / M 키: master gain smoothstep 0↔0.3, `localStorage['tamra_muted']` 영속
- `window.__audio` 디버그 노출 (ctx, master, waves/wind gain 등)

### 시간 가속

- `gameTime` (ms 단위), `TIME_SPEED` (초기 120배속)
- 디버그: `window.__advanceHours(h)`, `window.__setTimeSpeed(s)` — 콘솔에서 시간 점프/속도 조작 (검증 편의)
- T/Y 키로 ÷2/×2 (범위 1~7200). 하늘보기(K) 켜진 동안 시간 정지.

### 하늘보기 (K키)

[src/render/skymap.ts](src/render/skymap.ts) `DrawSkyMap`. polar azimuthal 정사영, **배 진행 방향이 화면 위쪽**. 시간 정지. 태양·달·행성·별 모두 표시 (낮/밤 가시성 자동 — `sun.altDeg < 0`이어야 별/행성/달 보임).

### 데이터 파이프라인

- `jeju_hires_1024.raw` (UInt16, 1024x1024) — generate_maps.py로 PNG 변환
- **구간별 선형 매핑(piecewise linear)**: -8000m~+5000m → Uint8 0~255. 해수면 부근(0~20m)에 정밀도 집중 (1 unit ≈ 0.42m), 극단은 거칠게 압축
- 렌더 시 `heightMeters[256]` LUT로 Uint8 → 실제 미터 역변환 후 투영
- **바다 평탄화**: `altitude[idx] = h <= SEA(64) ? SEA : h`. 해저 지형 3D 솟아오름 방지

### 타일 시스템 (글로벌 좌표 + 링 버퍼)

- 전세계 `176 x 88` 타일(`512x512`, ~227km/tile). 해안선 주변만 생성 (strict coast + 5x5 버퍼 = 8,836 타일)
- **`tile_index.json`이 source of truth**: 여기 없는 타일은 로더에서 무시
- **8x8 슬롯 버퍼(4096x4096)**: 타일 `(tx,ty)` → 슬롯 `(tx%8, ty%8)`. 글로벌 좌표 `& MASK` = 버퍼 위치
- `WORLD_TILES_X=176`, `WORLD_TILES_Y=88` 둘 다 BUF_TILES=8 의 배수 → antimeridian 포함 어느 지점에서도 slot 충돌 없음 (원본 DEM 을 1회 업스케일해 512 배수로 맞춘 결과 — `upscale_heightmap.py`, [docs/PIPELINE.md](docs/PIPELINE.md) 참조)
- 5x5 로드 범위(1280) > 렌더 거리(800) → 뒤쪽 오래된 타일 안 보임
- `ensureTilesLoaded()`가 배 주변 5x5 async 로드. 순수 바다 타일은 파일 없이 flat fill

### 핵심 상수 위치

[src/config.ts](src/config.ts) 에 상수, [src/state.ts](src/state.ts) 에 초기값 (`timeRef.TIME_SPEED`, `camera.distance` 등).

| 상수 | 값 | 의미 |
|---|---|---|
| `SCR_W/H` | 640/360 | 내부 렌더 해상도 |
| `SEA` | 64 | 해수면 Uint8 값 |
| `UNIT_M` | 400 | 1 world unit = 400m (한국 위도) |
| `BASE_CAM_METERS` | 50 | 기본 카메라 높이 |
| `camera.distance` | 800 | 최대 렌더 거리 |
| `FRAME_INTERVAL` | 50 | 20fps cap |
| `BASE_SAIL_SPEED` | 4 m/s | 돛 100% + windFactor 1 기준 |
| `timeRef.TIME_SPEED` | 120 (초기) | 시간 가속 (T/Y로 1~7200) |

### Render() 최적화 메모 ([src/render/voxel.ts](src/render/voxel.ts))

이미 적용된 것 (3.72ms → 2.33ms, 37% 절감):

- `hiddeny`를 함수 밖 Uint32Array로 빼고 `fill(SCR_H)` 재사용 (GC 부담 제거)
- 컬럼별 early skip: `if (hiddeny[i] <= 0) continue`
- z 루프 early termination: `openCount === 0 → break`
- allSea fast path: 4 이웃 SEA면 bilinear 스킵, color/height 상수 1회
- 파도 sin 거리별 단계 드롭(`waveStage` 0/1/2/3): 원거리는 swell만, 근거리는 3개 sin
- Hot loop 내부 `Math.floor` → `| 0` (좌표가 양수 영역이라 안전)

## 코드 스타일 주의사항

- **Math.floor() 사용**: 맵 좌표 변환 시 `|0` 대신 (음수에서 정확). 단, Render() hot loop 내부는 `|0` 적용됨 (양수 보장)
- **asm.js 스타일 `|0` 힌트**: `DrawVerticalLine` 내부 정수 연산 경로에선 유지
- 이중 버퍼 패턴: `buf32` (Uint32Array) 쓰고 `imagedata.data.set(buf8)` + `putImageData`로 flip
- **파도 sin 좌표는 카메라 상대값** (`wx = plx - camera.x`): 절대 월드좌표(73000+)에 작은 dx 곱하면 위상이 점프해 깜박임 발생

## 커밋 prefix

이 저장소의 기존 커밋은 모두 `[JONES-89]` prefix 사용 중. 동일 형식 유지.

## 알려진 주의점

- `tiles/`는 심볼릭 링크로 공용 타일 디렉토리를 참조. 삭제 시 실제 PNG 데이터 손실 주의
- 과거 `jeju_hires_1024` 단일 파일 렌더러에서 타일 스트리밍으로 전환됨. 미사용 상수/함수가 남아있을 수 있음
- 별·행성·달은 모두 `sun.altDeg < 0` 일 때만 그려진다 (낮에는 태양빛에 묻혀야 자연스러움)
