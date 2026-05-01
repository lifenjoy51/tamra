# 해안선 정교화 계획 — 해상도 증가 *없이*

> 현재 해안선이 거친 문제의 원인 진단과 *DEM 해상도를 올리지 않고* 해결하는 방법들의 비교·우선순위. 게임 기획 우선순위는 [ROADMAP.md](ROADMAP.md) Tier 5.1(타일 경계 이음새)과 별개의 *지형 품질* 안건이다. 타일 빌드 파이프라인 전반은 [PIPELINE.md](PIPELINE.md) 참조.

---

## 1. 문제 진단

현재 DEM 해상도 ~450m/px 에서 다음이 누적되어 해안선이 *각진 stair-step* 으로 보인다:

1. **Nyquist 한계** — 1 km 미만의 만·곶·작은 섬·암초는 *원천적으로* 표현 불가. 보간으로 만들 수 없는 정보.
2. **이진 임계** — `altitude[idx] = h <= SEA(64) ? SEA : h` ([src/tiles.ts](../src/tiles.ts) / [src/terrain.ts](../src/terrain.ts)) 가 sea/land 를 *binary* 로 가르므로 경계가 픽셀 사각형.
3. **Bilinear 한계** — `Render()` ([src/render/voxel.ts](../src/render/voxel.ts)) 의 4-이웃 bilinear 는 *이미 있는 정보를 부드럽게* 할 뿐, 없는 디테일을 못 만든다. allSea fast path 가 4 이웃 SEA 일 때 보간조차 스킵.

→ **해상도 외 해법은 ① 새 정보 주입 / ② 합성 디테일 / ③ 렌더 시점 AA** 의 3 갈래.

---

## 2. 갈래 A — 새 정보 주입 (가장 큰 효과)

DEM 외부에서 *실제 해안선 데이터*를 가져와 sea/land 마스크를 갈음. 내륙 고도는 기존 DEM 유지.

### A1. OSM coastline 벡터 오버레이 ★ 추천 1순위

- **출처**: OpenStreetMap `natural=coastline` 폴리곤. 위성 이미지 기반 *수동 트레이싱* 이라 사실상 무한 해상도.
- **배포본**: [osmdata.openstreetmap.de/data/coastlines.html](https://osmdata.openstreetmap.de/data/coastlines.html) 직배포 shapefile (수십~수백 MB), 또는 `osmcoastline` 도구로 직접 빌드.
- **라이선스**: ODbL. 게임 내 어딘가 attribution 1줄 필요 (메뉴/크레딧).
- **파이프라인 통합**: `generate_world_tiles.py` 에 단계 추가:
  1. 타일 (`tx,ty`) bbox 안의 OSM 폴리곤 클립
  2. 2x~4x 서브샘플 그리드(1024 또는 2048)에 rasterize → sea/land mask
  3. mask 다운샘플 시 *coverage(0~255)* 보존 → 새 채널 또는 SEA 임계 부근의 *연속값 fading*
  4. 기존 DEM 의 내륙 고도는 그대로, *해안 ± 2px 만* mask 로 갈음
- **비용**: 中. 빌드 타임 1회 처리. 런타임 코드는 `terrain.ts` 의 SEA 임계 처리에 *coverage 채널* 1줄 추가 정도.
- **효과**: ~1 km 미만 만·소도서가 *살아남*. 해안선 자체 모양이 사실적.

### A2. Natural Earth 1:10m 해안선

- A1 보다 디테일 낮지만 *훨씬 가벼움* (수 MB). 단순 라이선스(Public Domain).
- 같은 파이프라인 사용. 효과는 A1 의 ~60~70%. *입문/대안* 위치.

### A3. Sentinel-2 / Landsat 위성 sea mask

- A1 과 동급 디테일이지만 raster 라 처리량 큼. NDWI(정규수분지수) 임계로 sea/land 산출.
- A1 보유 시 보통 불필요. *연중 변동 해역(갯벌·하구)* 정밀도가 필요할 때 보조.

---

## 3. 갈래 B — 합성으로 디테일 생성 (데이터 추가 없이)

DEM 이 가진 정보로만 경계를 자연스럽게. **없는 만/섬이 새로 생기진 않는다.**

### B1. 결정적 noise 로 해안선 변위 ★ 추천 차순위

- 현재 sea/land 임계 픽셀의 좌표 `(gx, gy)` 에 *Perlin/value noise* 를 더해 경계를 *주름*. 같은 좌표 → 항상 같은 모양 (재현성 보장).
- 효과: 사각형 stair-step → *들쭉날쭉한 자연스러운 경계*.
- **구현 위치**: `tiles.ts` colormap 생성 단계 또는 `terrain.ts` 의 SEA 임계 직전.
- **noise 파라미터**:
  - 주파수: ~50~150m 단위 (1 ~ 2 글로벌 px). 더 크면 인공적, 더 작으면 노이즈성.
  - 진폭: SEA 임계 ±1~2 unit 정도. 너무 크면 내륙에 *없는 호수* 가 생김.
- **비용**: 小. 빌드 타임 1 패스. 런타임 비용 0.
- **결정성 주의**: `(gx, gy)` 좌표만 입력으로 — 타일 단위 시드를 쓰면 타일 경계에 솔기.

### B2. 간이 침식 시뮬

- 해안 1 px 폭에 *물의 침식* 1~3 iteration (Sobel 기반 erosion 또는 cellular automaton).
- B1 보다 *부드럽고 굴곡진* 경계 (반도가 자연스럽게 가늘어지는 등). 단 결정적 재현성 까다로움 — 동일 결과를 위해 iteration 수·이웃 정의 고정 필요.
- **비용**: 中. 빌드 타임만.

---

## 4. 갈래 C — 렌더 시점 AA (순수 그래픽 개선)

데이터/빌드 변경 없음. *없는 디테일은 못 만들고*, 기존 sea/land 경계의 *시각적 거칠기*만 완화.

### C1. Signed Distance Field (SDF) 렌더

- 빌드 시 각 픽셀의 *해안선까지 거리* 를 사전 계산해 채널로 저장 (또는 런타임 첫 로드 시 1회).
- `Render()` 에서 SDF 값을 *subpixel coverage* 로 사용 → 부드러운 경계.
- **비용**: 中. SDF 채널 추가(타일 용량 +33%) + `Render()` hot path 수정. 50ms cap 안에 들어가야.
- **효과**: 같은 해안선이 *부드럽게* 보임. 디테일 추가는 없음.

### C2. Coverage-based AA ★ 추천 — 위 옵션과 묶어서

- bilinear 4-이웃을 *sea fraction* (0~1) 까지 확장. fraction 을 alpha 로 SEA 색과 land 색 블렌드.
- 현재 `Render()` 의 *allSea fast path* 와 대칭으로 *partialSea path* 1 개 추가하면 된다. 4 이웃 중 일부만 SEA 일 때 fraction 계산 → 색·높이 가중평균.
- **비용**: 小. hot loop 안 분기 1 단 추가. 50ms cap 안전.
- **효과**: stair-step 픽셀 경계가 anti-aliased.

### C3. 거리 기반 detail 블렌드

- 카메라가 해안 가까울 때만 high-freq noise 를 alpha 합성. 멀면 기존 그대로.
- B1 + 거리 페이드. 효과는 *근경 디테일* 강화에 특화.
- **비용**: 中.

---

## 5. 추천 조합 — 비용/효과 매트릭스

| 조합 | 디테일 추가 | 경계 부드러움 | 빌드 비용 | 런타임 비용 | 데이터 의존 |
|---|---|---|---|---|---|
| **A1 + C2** ★ | 매우 큼 | 큼 | 中(1회) | 거의 0 | OSM(ODbL) |
| **B1 + C2** | 없음(주름만) | 큼 | 小 | 거의 0 | 없음 |
| **A2 + C2** | 큼 | 큼 | 小 | 거의 0 | NE(PD) |
| **C1 단독** | 없음 | 매우 큼 | 中 | 中 | 없음 |
| **A1 + B1 + C2** | 최대 | 최대 | 中 | 거의 0 | OSM |

**1순위 추천**: **A1 + C2**.
- A1 이 *없던 만·소도서를 살림* (가장 큰 시각 변화).
- C2 가 남은 stair-step 을 부드럽게 마감.
- 둘 다 *런타임 비용 0 에 가깝고* 50ms cap 안전.
- ODbL attribution 1 줄만 부담.

**데이터 의존을 피하고 싶다면**: **B1 + C2**.
- 없는 디테일은 못 만들지만 *사각형 윤곽은 확실히 사라짐*.
- 비용 가장 작고 외부 의존 0.

---

## 6. 구현 시 주의

### 파이프라인 영향 ([PIPELINE.md](PIPELINE.md))

- A1/A2 채택 시 `generate_world_tiles.py` 에 **OSM/NE 클립·rasterize 단계** 추가. 빌드 시간 증가는 GPU 없이 CPU rasterize(GDAL/Shapely) 기준 *전세계 ~수십 분* 수준.
- 타일 PNG 포맷은 *그대로 유지* 가능 — sea/land mask 가 결국 altitude 의 SEA(64) 임계로 환원되므로 채널 추가 불필요.
- C1 채택 시에만 *추가 채널 (SDF)* 필요 → 타일 용량 ~33% 증가, `tile_index.json` 포맷·로더 양쪽 변경.

### 호환성 / 회귀 방지

- **타일 슬롯 링버퍼와 8x8 wrap 불변**: A/B/C 어떤 갈래도 *타일 차원/포맷 자체는 안 바꾸는 것*이 안전. (CLAUDE.md "WORLD_TILES = BUF_TILES 의 배수" 규칙)
- **3x3 shore buffer ([src/render/camera.ts](../src/render/camera.ts) `moveBoat`)**: sea/land 마스크가 더 정교해지면 *기존엔 통과되던 경로가 막힐* 수 있음. 시나리오 1.1 항로 (TRADE_NETWORK.md) 의 출발/도착점 셀이 여전히 바다로 분류되는지 회귀 검증 필요.
- **렌더 성능 회귀**: 현재 `Render()` 2.33 ms / 50 ms cap. C2 partialSea path 추가는 hot loop 안 분기 1 단이지만, 다음 항목으로 검증:
  - allSea fast path hit 율 (이미 적용됨, 4 이웃 SEA 시 스킵). partialSea 도입 후에도 *전 컬럼 평균* 시간 증가가 *0.5 ms 이내*인지 측정.
  - `frameStats.drawMs` EMA 로 회귀 확인.

### 결정성 (B1 / B2)

- noise 시드는 *전세계 글로벌 좌표* 만 입력. 타일 단위 시드는 경계 솔기 발생.
- noise 함수 변경 시 *기존 세이브의 항로 재현 불가능* — 게임 데이터 영향. 진입 전 `__seed` 같은 디버그 hook 으로 비교 우선.

### 가드레일

- **내륙 고도 변경 금지**: 어떤 갈래도 *해안 ± 2 px 안에서만* 작동. 내륙 산악 고도는 DEM 그대로 (B2 침식이 내륙으로 번지면 안 됨).
- **antimeridian 안전**: A1/A2 의 폴리곤 클립이 ±180° 경계 끊김 처리. 일부 OSM 배포본은 이미 분할 적용됨.
- **데이터 라이선스**: A1 ODbL — 게임 어딘가에 *"© OpenStreetMap contributors"* attribution. A2 NE 는 PD, 무관.

---

## 7. 검증 방법

### 시각 검증

1. *제주 북부 산지천 일대* — 기존 빌드와 신규 빌드의 해안선 픽셀 단위 diff 이미지.
2. *영산강 하구·김해* (TRADE_NETWORK.md 의 1·2순위 시나리오 도착지) — 새로 생긴 만/소도서가 사료의 *5세기 해안선 추정* 과 양립하는지 (정확 일치는 불가능).
3. *흑산도* — 단거리 입문 시나리오의 도착 셀이 여전히 *근접 가능* 한 형태인가.

### 정량 검증

- 빌드 시간: A1 채택 시 *전세계 빌드 시간 < 30 분* 목표.
- 런타임: `frameStats.drawMs` 평균이 변경 전 대비 *+0.5 ms 이내*.
- 타일 용량: A/B 갈래는 *변화 없음* (PNG 포맷 유지). C1 만 +33%.

### 회귀 검증

- 기존 시나리오 후보 출발/도착점이 여전히 sea 셀로 분류되는지 — `data/ports.json` (ROADMAP 4.2) 후보 좌표 일괄 체크 스크립트.
- `python3 generate_world_tiles.py --verify` (제주 비교) 출력의 sea/land 픽셀 수 변화율 < 5%.

---

## 8. 다음 단계 (실행 시)

ROADMAP 에 정식 Tier 항목으로 편입할지는 별도 결정. 본 문서는 *기술 옵션 분석* 까지의 범위.

- 갈래·조합 선택 시 본 문서에 *결정 사유*를 추가 (어떤 갈래·왜 거부됐는지 포함).
- A1 채택 시 [PIPELINE.md](PIPELINE.md) 에 OSM 단계 추가, README 크레딧 1줄.
- B1 채택 시 noise 함수·시드를 [DESIGN.md](../DESIGN.md) "결정적 합성 디테일" 항목으로 박제.
- C2 채택 시 [CLAUDE.md](../CLAUDE.md) "Render() 최적화 메모" 에 *partialSea path* 추가 기록.
