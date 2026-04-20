# PIPELINE.md — DEM → 전세계 타일 빌드

이 문서는 원본 DEM(7GB)에서 시뮬레이터가 사용하는 8,836개 해안선 타일을 추출하는 배치 파이프라인을 설명한다. **빌드 운영자/데이터 갱신 담당** 대상.

## 원본 데이터

| 파일 | 해상도 | 크기 |
|---|---|---|
| `final_heightmap.raw` (원본) | 86400×43200 (~450m/pixel) | 7.0GB |
| `final_heightmap_176x88.raw` (업스케일) | 90112×45056 (~443m/pixel) | 8.1GB |

- 형식: ENVI RAW, Int16, WGS-84
- 좌표계: 전세계 (-180~+180 경도, -90~+90 위도)
- 고도 범위: -10,922m ~ +8,375m
- 위치: `~/works/heightmap/` (저장소 외부)

**업스케일 이유**: 원본 `86400×43200` 은 타일 크기 512 로 나누면 `168.75 × 84.375` — BUF_TILES=8 링버퍼와 서로소(169%8=1, 85%8=5)라 antimeridian/고위도에서 slot 충돌이 발생했다. `upscale_heightmap.py` 로 512 배수 `90112×45056` (가로 176 × 세로 88 타일) 으로 한 번 업스케일하면 `176%8=0, 88%8=0` 으로 wrap 이 구조적으로 정합. equirectangular 2:1 비율 유지, bilinear smoothing ±1 unit 허용, 1회성 처리 ~90초.

## 높이 매핑: 구간별 선형 (Piecewise Linear)

8-bit (0~255)에 전세계 해안선을 효율적으로 담기 위한 비균일 매핑.

```
해수면 아래 1/4 (0~64), 해수면 위 3/4 (64~255)

  구간             | 실제 범위       | 할당      | 1 unit
  심해             | -8000 ~ -200m  | 0~24     | 325m
  얕은바다         | -200 ~ -10m    | 24~48    | 7.9m
  해안선(수중)     | -10 ~ 0m       | 48~64    | 0.63m
  해안선(지상) ★   | 0 ~ +20m       | 64~112   | 0.42m  ← 최고 정밀
  저지대           | +20 ~ +200m    | 112~160  | 3.75m
  중산지           | +200 ~ +1000m  | 160~208  | 16.7m
  고산             | +1000 ~ +5000m | 208~255  | 85m
```

설계 근거는 [DESIGN.md "높이 매핑"](../DESIGN.md#높이-매핑-왜-piecewise-linear인가) 참조.

## 타일 그리드

- 그리드: **176열 × 88행 = 15,488 타일** (`512x512`, ~227km/tile)
- 타일 좌표 → 지리: `lon = -180 + tx × 2.045°`, `lat = 90 - ty × 2.045°`
- 제주도 중심권: 타일 `(149, 27)` 부근 (업스케일 후 좌표, 이전 `143,26`)

## 스크립트

```bash
python3 upscale_heightmap.py                    # 1회성: 원본 → 90112×45056 업스케일
python3 generate_world_tiles.py                 # 전체 실행
python3 generate_world_tiles.py --classify-only # 분류 통계만 출력
python3 generate_world_tiles.py --tile 149,27   # 단일 타일 (디버그)
python3 generate_world_tiles.py --verify        # 제주 타일 기존 PNG와 비교
```

## 처리 단계

### Phase 1: 분류 (Classification)

7GB 파일을 행 단위로 1회 스캔. 타일별 `has_land`/`has_water`와 타일 경계 물 마스크를 기록.

핵심: **`sea`는 단순한 water가 아니라 `ocean-connected water`만 인정**.
- 호수/내해/폐쇄 수역은 strict coast 판정에서 제외
- 강이라도 바다와 실제로 이어져 있으면 `ocean-connected water`로 취급

알고리즘:
1. 타일 내부에 **육지(>0m)** 가 있는지 기록
2. 타일 내부에 **물(<=0m)** 이 있는지 기록
3. 타일의 북/남/동/서 경계에서 물인 픽셀 위치를 저장
4. 북극/남극 경계에서 시작해, 타일 경계의 물 픽셀이 맞닿는 이웃으로 BFS 전파
5. 이렇게 연결된 물만 `ocean-connected water`로 인정

분류 결과:

| 분류 | 관측치 |
|---|---|
| ocean only | 7,715 |
| dry land only | 3,702 |
| inland water mixed | 199 |
| inland water only | 3 |
| **strict coast** | **2,746** |

경도 방향은 wrap 처리 (col 0 ↔ col 175). 메모리: 타일 분류 마스크 + 경계 water mask. 소요시간: ~10초.

업스케일(176×88) 이전에는 `86400 / 512 = 168.75` 로 partial wrap 타일(WRAP_WIDTH=128)이 있어 east+west 연결 특수 처리가 필요했다. 현재는 `90112 = 176×512` 로 wrap partial 이 없어 `WRAP_WIDTH > 0` 분기가 자동 skip된다.

### Phase 2: 5×5 버퍼 확장

strict coast 타일 주변 반경 2타일, 총 `5×5` 범위로 확장. **완전 육지 타일이라도** strict coast의 5×5 범위 안에 들어오면 생성 대상에 포함.

- 최종 생성 대상: `strict coast ∪ 5×5 neighbors` = **8,496 타일**
- 5×5 로드 범위(1280px) > 렌더 거리(800px) 이므로 시야 가장자리에서 다음 타일이 미리 보장됨

### Phase 3: 타일 생성 (Row-Band 스트리밍)

타일 행(ty) 단위로 업스케일 raw 읽기 (`514행 × 90112열`, 약 93MB — hillshading용 1px 오버랩 포함).

타일별 처리:
1. `514×514` 영역 추출 (hillshading 경계용 1px 오버랩)
2. Int16 → Uint8 변환 (LUT 65536개, 구간별 선형 매핑)
3. Hillshade 계산 (`514×514 → crop 512×512`)
4. Colormap 생성 (elevation 색상 + hillshading + 글로벌 좌표 디더링)
5. PNG 저장: `tiles/h_XX_YY.png`, `tiles/c_XX_YY.png`

디더링은 글로벌 좌표 사용 (타일 경계 연속성 보장). 이미 존재하는 PNG는 스킵 (이어하기 지원).

### Phase 4: 타일 인덱스

`tiles/tile_index.json` — 현재 생성 대상으로 인정되는 타일 목록.

- **인덱스에 없는 타일은 로더에서 무시**
- 과거 분류 기준으로 만들어진 PNG가 폴더에 남아 있을 수 있으므로, **`tile_index.json`이 source of truth**

```json
{
  "grid": { "cols": 176, "rows": 88, "tile_size": 512, "buffer_radius": 2 },
  "geo": { "origin_lon": -180.0, "origin_lat": 90.0, "deg_per_tile": 2.0455 },
  "tiles": { "149_27": "generated", "150_27": "generated" }
}
```

## 결과

| 항목 | 값 |
|---|---|
| 생성 타일 수 | 8,836 (`tile_index.json` 기준) |
| 실제 PNG 파일 수 | 17,672 (h + c 각각) |
| 디스크 용량 | ~1.4GB |
| 피크 메모리 | ~100MB (1 row-band 기준) |
| 분류 시간 | ~10초 |
| 생성 시간 | 수 분 ~ 10분대 |

## 검증

`--verify`는 기존 `jeju_hires_1024.raw → PNG` 경로와 현재 매핑 로직이 일치하는지 확인.
원본 `final_heightmap.raw`에서 제주 윈도를 직접 잘라 비교하면, 높이는 최대 1 level 차이, 색상은 hillshade/노이즈 차이로 일부 픽셀 차이가 날 수 있음.

## 렌더러 연동 (참고)

이 파이프라인의 산출물을 시뮬레이터가 어떻게 소비하는지는 [CLAUDE.md "타일 시스템"](../CLAUDE.md) 섹션 참조.

- 5×5 타일 스트리밍: 카메라 위치 기준 주변 25타일 async 로드
- 순수 바다 타일: 파일 로드 없이 코드에서 flat sea 생성
- 8×8 슬롯 링버퍼로 타일 메모리 재사용

## Legacy 산출물

`generate_maps.py` 와 `jeju_hires_1024.{raw,png}` 는 타일 시스템 이전의 단일 윈도우 PNG 산출물. 현재는 `--verify` 비교용으로만 사용한다.

```bash
python3 generate_maps.py     # raw → heightmap + colormap PNG (제주 1024 윈도우)
```

## 주의

- `tiles/`는 심볼릭 링크로 공용 타일 디렉토리를 참조. **삭제 시 실제 PNG 데이터 손실 주의**
- 원본 DEM은 저장소 밖(`~/works/heightmap/`)에 별도 보관 — 7GB라 git에 못 들어감
