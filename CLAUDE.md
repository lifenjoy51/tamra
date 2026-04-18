# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

자세한 설계/배경은 `PROTOTYPE.md`를 먼저 읽을 것. 이 문서는 작업용 빠른 참조.

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

s-macke/VoxelSpace 기반 + 확장. Draw 루프 순서:

```
UpdateCamera → DrawBackground(sky gradient) → Render(bilinear VS)
  → FillSea는 현재 사용 안함 (Render가 수평선 위/아래 전부 담당)
  → DrawMinimap → DrawBoat(Flip + sprite)
```

- **Bilinear 4-이웃 샘플링**: `heightMeters` (occlusion 판정용) 선행 → 통과 픽셀만 color bilinear (앞단 비용 절약)
- **지구 곡률**: `drop_m(z) = (z·UNIT_M)² / (2R)`, `UNIT_M=400` (tile_index.json의 `pixel_deg=0.004167` ≈ 15 arc-sec/px, 한국 위도 기준)
- **projScale**: `(SCR_H · 0.0044) / z` — 세로 해상도에 비례해 수직 FOV 일관
- **deltaz**: 초기 0.5, step당 `+0.005` (근거리 세밀, 원거리 완만)
- **20fps cap**: `FRAME_INTERVAL=50ms` + `FRAME_EPSILON=8ms` — rAF 16.67ms의 정수배 근처에서 지터로 인한 fps 진동 방지
- **frame time EMA** (alpha=0.1): Draw 순수 계산 시간, cap 대기 시간 미포함

### 내부 해상도 & 캔버스

- 내부 렌더 `640x360` (16:9)
- `PX_SCALE`은 뷰포트에 맞춰 `floor(innerW/640)`·`floor(innerH/360)` 중 작은 값으로 정수배. `window.resize`로 갱신
- `image-rendering: pixelated`로 crisp pixel 유지

### 항해 물리

- **3x3 shore buffer**: 이동 대상 셀과 주변 8방향이 모두 바다여야 진입 허용 (해안선 인접 바다 1픽셀도 차단)
- **서브스텝 이동**: `SUBSTEPS = ceil(mvLen*4)` — 큰 `MOVE_STEP`에서도 중간 셀 체크 누락 방지
- **카메라 = 배에 snap**: smoothing/spring-arm 제거. `camera.x/y/angle = boat.*` 직접 대입 → 보이는 배 기준 뷰 고정
- **카메라 높이**: 기본 `65m`, 지형 위에서 `지형높이 + 20m`로 자동 상승
- **입력**: A/D/W/S는 1키=1스텝 이산. auto-repeat로 연속 효과 (`[`/`]` 회전속도, `,`/`.` 이동속도)

### 데이터 파이프라인

- `jeju_hires_1024.raw` (UInt16, 1024x1024) — generate_maps.py로 PNG 변환
- **구간별 선형 매핑(piecewise linear)**: -8000m~+5000m → Uint8 0~255. 해수면 부근(0~20m)에 정밀도 집중 (1 unit ≈ 0.42m), 극단은 거칠게 압축 (심해 325m, 고산 85m)
- 렌더 시 `heightMeters[256]` LUT로 Uint8 → 실제 미터 역변환 후 투영 (구간 무관 정확)
- **바다 평탄화**: `altitude[idx] = h <= SEA(64) ? SEA : h`. 해저 지형 3D 솟아오름 방지. colormap은 원본 깊이 기반으로 별도 생성

### 타일 시스템 (글로벌 좌표 + 링 버퍼)

- 전세계 `169 x 85` 타일(`512x512`, ~230km/tile). 해안선 주변만 생성 (strict coast + 5x5 버퍼 = 8,496 타일)
- **`tile_index.json`이 source of truth**: 여기 없는 타일은 로더에서 무시 (디스크 orphan PNG가 있어도 로드 안 함)
- **8x8 슬롯 버퍼(4096x4096)**: 타일 `(tx,ty)` → 슬롯 `(tx%8, ty%8)`. 글로벌 좌표 `& MASK` = 버퍼 위치
- 5x5 로드 범위(1280) > 렌더 거리(800) → 뒤쪽 오래된 타일 안 보임
- `ensureTilesLoaded()`가 배 주변 5x5 async 로드. 순수 바다 타일은 파일 없이 flat fill

### 핵심 상수 위치 (index.html)

| 상수 | 값 | 의미 |
|---|---|---|
| `SCR_W/H` | 640/360 | 내부 렌더 해상도 |
| `SEA` | 64 | 해수면 Uint8 값 |
| `UNIT_M` | 400 | 1 world unit = 400m (한국 위도) |
| `BASE_CAM_METERS` | 65 | 기본 카메라 높이 |
| `camera.distance` | 800 | 최대 렌더 거리 |
| `FRAME_INTERVAL` | 50 | 20fps cap |

## 코드 스타일 주의사항

- **Math.floor() 사용**: 맵 좌표 변환 시 `|0` 대신 (음수에서 정확)
- **asm.js 스타일 `|0` 힌트**: `DrawVerticalLine` 내부 정수 연산 경로에선 유지
- 이중 버퍼 패턴: `buf32` (Uint32Array) 쓰고 `imagedata.data.set(buf8)` + `putImageData`로 flip

## 작업 규칙 (`/Users/joey51/.claude/CLAUDE.md` 상속)

- 요청이 모호하면 질문 먼저. 추측 추가 작업 금지
- 코드 수정은 요청된 부분만. 자의적 리팩토링 금지
- 브랜치 `xyz/0000` 패턴이면 커밋 메시지 앞에 `[XYZ-0000]` prefix
  - 현재 브랜치 `claude/laughing-jones-89fe13` → `[JONES-89fe13]`... 실제 관측된 커밋은 `[JONES-89]` 형식 사용 중. 기존 로그와 맞추려면 `git log --oneline` 확인 후 prefix 결정

## 알려진 주의점

- `PROTOTYPE.md`의 "실행 방법"이 예전엔 `~/works/heightmap` 기준이었음 — 현재는 `~/works/tamra` + 포트 8089
- `tiles/`는 심볼릭 링크로 공용 타일 디렉토리를 참조. 삭제 시 실제 PNG 데이터 손실 주의
- 과거 `jeju_hires_1024` 단일 파일 렌더러에서 타일 스트리밍으로 전환됨. 미사용 상수/함수가 남아있을 수 있음
