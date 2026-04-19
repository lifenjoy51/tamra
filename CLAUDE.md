# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

설계 결정 배경은 [DESIGN.md](DESIGN.md), 사용자/실행 안내는 [README.md](README.md), 타일 빌드는 [docs/PIPELINE.md](docs/PIPELINE.md), 용어/참고문헌은 [docs/GLOSSARY.md](docs/GLOSSARY.md). 이 문서는 코드 작업용 빠른 참조.

## 프로젝트 개요

제주도를 중심으로 한 9세기 이전 고대 항해 체험 시뮬레이터. **핵심 컨셉**: 플레이어는 "지도 위의 점"이 아니라 "배 위의 사람" (미니맵/좌표/고정 방위 없음, 태양·별·바람·해류로만 방향 판단).

단일 HTML 파일(Canvas 2D) + Python 빌드 스크립트 2개로 구성. 빌드 시스템/테스트 프레임워크 없음.

## 자주 쓰는 명령

```bash
# 프로토타입 실행 (.claude/launch.json 기준 포트 8089)
cd ~/works/tamra && python3 -m http.server 8089
# → http://localhost:8089

# PNG 재생성 (raw → heightmap + colormap)
python3 generate_maps.py

# 전세계 타일 파이프라인
python3 generate_world_tiles.py                 # 전체 실행
python3 generate_world_tiles.py --classify-only # 분류 통계만
python3 generate_world_tiles.py --tile 143,26   # 단일 타일 디버그
python3 generate_world_tiles.py --verify        # 제주 타일 비교
```

원본 DEM(`final_heightmap.raw`, 7GB)은 `~/works/heightmap/`에 별도 보관.

## 아키텍처 핵심

### 렌더 파이프라인 (index.html)

s-macke/VoxelSpace 기반 + 확장. Draw 루프 순서 (`index.html:1834`):

```
UpdateCamera → DrawBackground(sky + 별 + 행성 + 달 + 태양)
  → Render(bilinear VS, 수평선 위/아래 전부 담당)
  → DrawMinimap → DrawBoat(buf → canvas flip + sprite)
  → DrawSkyMap(K키일 때 polar azimuthal 오버레이)
```

- **Bilinear 4-이웃 샘플링**: `heightMeters` (occlusion 판정용) 선행 → 통과 픽셀만 color bilinear
- **allSea fast path**: 4 이웃이 모두 SEA 이면 bilinear 스킵, 색·높이 상수 1회 (`Render` L1415 부근)
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

- **돛 polar curve** (`polarFor` L460): IRONS(0.05) / CLOSE(0.55) / BEAM(1.00) / BROAD(1.20) / RUN(0.90)
- **추진 속도** (`computeSail` L470 + `updateShipSpeed` L485): `BASE_SAIL_SPEED(4 m/s) × polar × windFactor(wind/8, clamp 0.3~1.8)`
- **해류 drift**: 돛 추진 벡터 + 해류 벡터 = `ship.groundMS` / `ship.groundDirRad`
- **3x3 shore buffer**: 이동 대상 셀과 주변 8방향이 모두 바다여야 진입 허용
- **서브스텝 이동**: `SUBSTEPS = ceil(mvLen*4)` — 큰 step에서도 중간 셀 체크 누락 방지
- **카메라 = 배에 snap**: smoothing/spring-arm 제거. `camera.x/y/angle = boat.*` 직접 대입
- **카메라 높이**: 기본 `50m`, 지형 위에서 `지형높이 + 20m`로 자동 상승

### 환경 시스템 (전부 매 프레임 갱신)

| 시스템 | 함수 | 모델 |
|---|---|---|
| **시간/태양** | `computeSun` L927 | 위/경도 + dayOfYear → δ/H → alt/az. 게임 정오부터 시작 |
| **바람** | `computeWind` L971 | Hadley/Ferrel/Polar + ITCZ + 아시아 몬순 + 결정적 noise |
| **해류** | `computeCurrent` L506 | 적도류·아열대·편서풍 + 쿠로시오(110~150°E,20~45°N) + 동호주 |
| **파도** | `computeWaves` L539 | swell(←해류) + mid/ripple(←바람), 진폭=wind.speedMS/8 |
| **별** | `STARS` L560 (~70개), `starState` 실시간 alt/az | J2000 + GMST → LST → hour angle |
| **행성** | `PLANETS` L696 (수금화목토천해), `updatePlanets` | Meeus J2000 평균 궤도요소 + Kepler Newton's method |
| **달** | `updateMoon` L776, `moonState` 위상 | Meeus 간이식 (L', D, M, M', F) → λ/β |
| **날씨** | `computeWeather` L831 | ITCZ + 중위도 storm + 아열대 고기압 + 노이즈 → cloudiness, visibilityCoef |

### 시간 가속

- `gameTime` (L916, ms 단위), `TIME_SPEED` (L113, 초기 120배속)
- T/Y 키로 ÷2/×2 (범위 1~7200). 하늘보기(K) 켜진 동안 시간 정지.

### 하늘보기 (K키)

`DrawSkyMap` (L1639 부근). polar azimuthal 정사영, **배 진행 방향이 화면 위쪽**. 시간 정지. 태양·달·행성·별 모두 표시 (낮/밤 가시성 자동 — `sun.altDeg < 0`이어야 별/행성/달 보임).

### 데이터 파이프라인

- `jeju_hires_1024.raw` (UInt16, 1024x1024) — generate_maps.py로 PNG 변환
- **구간별 선형 매핑(piecewise linear)**: -8000m~+5000m → Uint8 0~255. 해수면 부근(0~20m)에 정밀도 집중 (1 unit ≈ 0.42m), 극단은 거칠게 압축
- 렌더 시 `heightMeters[256]` LUT로 Uint8 → 실제 미터 역변환 후 투영
- **바다 평탄화**: `altitude[idx] = h <= SEA(64) ? SEA : h`. 해저 지형 3D 솟아오름 방지

### 타일 시스템 (글로벌 좌표 + 링 버퍼)

- 전세계 `169 x 85` 타일(`512x512`, ~230km/tile). 해안선 주변만 생성 (strict coast + 5x5 버퍼 = 8,496 타일)
- **`tile_index.json`이 source of truth**: 여기 없는 타일은 로더에서 무시
- **8x8 슬롯 버퍼(4096x4096)**: 타일 `(tx,ty)` → 슬롯 `(tx%8, ty%8)`. 글로벌 좌표 `& MASK` = 버퍼 위치
- 5x5 로드 범위(1280) > 렌더 거리(800) → 뒤쪽 오래된 타일 안 보임
- `ensureTilesLoaded()`가 배 주변 5x5 async 로드. 순수 바다 타일은 파일 없이 flat fill

### 핵심 상수 위치 (index.html)

| 상수 | 값 | 의미 |
|---|---|---|
| `SCR_W/H` | 640/360 | 내부 렌더 해상도 |
| `SEA` | 64 | 해수면 Uint8 값 |
| `UNIT_M` | 400 | 1 world unit = 400m (한국 위도) |
| `BASE_CAM_METERS` | 50 | 기본 카메라 높이 |
| `camera.distance` | 800 | 최대 렌더 거리 |
| `FRAME_INTERVAL` | 50 | 20fps cap |
| `BASE_SAIL_SPEED` | 4 m/s | 돛 100% + windFactor 1 기준 |
| `TIME_SPEED` | 120 (초기) | 시간 가속 (T/Y로 1~7200) |

### Render() 최적화 메모 (`index.html:1318`)

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
