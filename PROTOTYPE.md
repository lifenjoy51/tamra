# 고대 항해 시뮬레이터 프로토타입

## 목적

제주도를 중심으로 한 9세기 이전 고대 항해 체험 시뮬레이터.
대항해시대와의 핵심 차이점: **플레이어는 "지도 위의 점"이 아니라 "배 위의 사람"**.

- 미니맵 없음, 좌표 없음, 고정된 방위 없음
- 태양/별/바람/해류/새 등 고대 항해술로만 방향을 판단
- 배가 중심에 고정되고 세계가 회전하는 구조

## 기술 스택

- **렌더링**: Voxel Space (1992년 Comanche 방식, [s-macke/VoxelSpace](https://github.com/s-macke/VoxelSpace) 참조)
- **구현**: 단일 HTML 파일 (Canvas 2D, 3D 모델/WebGL 불필요)
- **데이터**: 전세계 DEM heightmap → 512x512 world tiles 추출

## 데이터 파이프라인

### 원본 데이터

| 파일 | 해상도 | 크기 |
|---|---|---|
| `final_heightmap.raw` | 86400x43200 (~450m/pixel) | 7.0GB |

- 형식: ENVI RAW, Int16, WGS-84
- 좌표계: 전세계 (-180~+180 경도, -90~+90 위도)
- 고도 범위: -10,922m ~ +8,375m

### 타일 추출

원본에서 제주도 중심 1024x1024 영역 추출:

```bash
gdal_translate -of ENVI -ot UInt16 \
    -scale -8000 8000 0 65535 \
    -srcwin 73060 13084 1024 1024 \
    final_heightmap.raw jeju_hires_1024.raw
```

- 커버 범위: 124.4°E~128.7°E, 31.2°N~35.5°N
- 포함 지역: 제주도, 한반도 남해안
- 파일 크기: 2MB (UInt16)

### PNG 생성

UInt16 raw → 8-bit PNG (heightmap + colormap):

```bash
python3 generate_maps.py
```

- `jeju_hires_1024.png` — heightmap (8-bit grayscale, 205KB). 구간별 선형 매핑 적용 완료.
- `jeju_colormap_1024.png` — colormap (RGB, 361KB). 높이 기반 색상 + 디더링 노이즈.
- 입력: `jeju_hires_1024.raw` (UInt16, 2MB)
- `index.html`은 PNG만 로드하며, raw 파일은 불필요

### 높이 매핑: 구간별 선형 (Piecewise Linear)

8-bit (0~255)에 전세계 해안선을 효율적으로 담기 위한 비균일 매핑.
해수면 부근에 정밀도를 집중하고, 극단(심해/고산)은 거칠게 압축.

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

#### 왜 이 방식인가

1. **선형 매핑의 문제**: -8000~+8000m를 0~255에 넣으면 1 unit=62.5m → 해안선 디테일 소멸
2. **감마(power) 매핑의 문제**: 해수면(0)에서 미분값 무한대 → Uint8 양자화 시 값 건너뜀 → 절벽 발생
3. **구간별 선형의 장점**: 각 구간 내에서 선형이라 값 건너뜀 없음, 구간 경계만 기울기 변화

#### 렌더링 시 구간별 scale 보정

구간마다 1 unit이 나타내는 실제 미터가 다르므로, 렌더링 시 Uint8 값을 미터로 역변환 후 투영:

```javascript
// Uint8 → 미터 역변환 LUT (256 entries)
var heightMeters = new Float32Array(256);

// 렌더링: 미터 기준 투영 → 구간 무관하게 정확한 비율
var terMeters = heightMeters[altitude[mapoffset]];
var heightonscreen = (camMeters - terMeters) * projScale + horizon;
```

## Voxel Space 렌더러

### 알고리즘 (s-macke/VoxelSpace 동일)

1. 카메라에서 수평선 방향으로 광선 발사
2. 가까운 곳부터 먼 곳까지 순회 (front-to-back)
3. 각 거리에서 heightmap 샘플링 → 화면 Y좌표로 투영
4. `hiddeny[]` 배열로 가려짐(occlusion) 처리
5. `DrawVerticalLine()`으로 세로 선 그리기

### 레퍼런스 구현에서 가져온 핵심 요소

- **`Math.floor()`**: 맵 좌표 변환 시 `|0` 대신 사용 (음수에서 정확)
- **Delta time**: `(current - time) * 0.03`으로 프레임률 무관 부드러운 이동
- **별도 ArrayBuffer + `Flip()`**: 더블 버퍼 패턴
- **On-demand 렌더링**: 키 입력 시에만 `requestAnimationFrame` 호출
- **asm.js 스타일 `|0` 힌트**: DrawVerticalLine 내부 정수 연산 최적화

### 바다 처리

- **바다 평탄화**: `altitude[idx] = h <= SEA ? SEA : h`
  - 해저 지형이 3D로 솟아오르는 문제 방지
  - colormap은 실제 깊이 기반으로 별도 생성 (깊이별 색상 차별화 유지)

### 안개 (Fog)

실제 대기 원근감을 재현하기 위해 육지/바다에 다른 fog 적용:

- **바다** → 하늘색(160,185,210)으로 수렴 (수평선에 자연스럽게 녹음)
- **육지** → 어두운 회색(90,100,120)으로 수렴 (마라도 사진처럼 어두운 실루엣)

### 항해 물리

- 육지 진입 차단 (배는 바다만 이동 가능)
- 카메라 높이 해수면 고정 (~10m, 배 위 시점)

## 조작법

| 키 | 동작 |
|---|---|
| W / ↑ | 전진 |
| S / ↓ | 후진 |
| A / ← | 좌회전 |
| D / → | 우회전 |
| Q | 시선 위로 |
| E | 시선 아래로 |

## 실행 방법

```bash
cd ~/works/heightmap
python3 -m http.server 8080
# 브라우저에서 http://localhost:8080 접속
```

## 파일 구조

```
tamra/
├── index.html                ← 프로토타입 (단일 파일)
├── generate_maps.py          ← PNG 생성 스크립트 (raw → heightmap + colormap)
├── generate_world_tiles.py   ← 전세계 해안선 타일 배치 파이프라인
├── jeju_hires_1024.raw       ← 원본 heightmap (1024x1024, UInt16, 2MB)
├── jeju_hires_1024.png       ← heightmap (8-bit grayscale, 205KB)
├── jeju_colormap_1024.png    ← colormap (RGB, 361KB)
├── tiles/                    ← 전세계 타일 출력 폴더
│   ├── classification.json   ← 분류 캐시 / 통계
│   ├── tile_index.json       ← 현재 생성 대상으로 인정되는 타일 목록
│   ├── h_XX_YY.png           ← heightmap 타일
│   ├── c_XX_YY.png           ← colormap 타일
│   ├── world_overview_color_16.png
│   └── world_overview_height_16.png
└── PROTOTYPE.md              ← 이 문서
```

원본 DEM 데이터는 `~/works/heightmap/final_heightmap.raw` (86400x43200, 7GB)에 별도 보관.

## 전세계 해안선 타일 파이프라인

### 개요

원본 DEM(86400x43200, 7GB)에서 해안선 주변 타일만 추출하는 배치 파이프라인.
현재 기준은 **`512 x 512` 타일 + `5 x 5` 버퍼(반경 2타일)** 이다.
순수 바다(태평양 등)와 순수 내륙은 제외하고, 해안 타일 + 5x5 버퍼만 생성한다.

핵심 조건:

- **`sea`는 단순한 water가 아니라 `ocean-connected water`만 인정**
- **`ocean-connected water`에는 바다에 열린 강/하구/수로도 포함**
- **호수/내해/폐쇄 수역은 strict coast 판정에서 제외**
- **단, strict coast와 맞닿은 5x5 범위 안에 들어온 타일은 완전 육지라도 생성 유지**

### 타일 그리드

- 그리드: 169열 x 85행 = 14,365 타일 (`512x512`, ~230km/tile)
- 타일 좌표 → 지리: lon = -180 + tx × 2.133°, lat = 90 - ty × 2.133°
- 제주도 중심권: 타일 `(143, 26)` 부근

### 스크립트: `generate_world_tiles.py`

```bash
python3 generate_world_tiles.py                 # 전체 실행
python3 generate_world_tiles.py --classify-only # 분류 통계만 출력
python3 generate_world_tiles.py --tile 143,26   # 단일 타일 (디버그)
python3 generate_world_tiles.py --verify        # 제주 타일 기존 PNG와 비교
```

### 처리 단계

#### Phase 1: 분류 (Classification)

7GB 파일을 행 단위로 1회 스캔. 타일별 `has_land`/`has_water`와 타일 경계 물 마스크를 기록.

1. 타일 내부에 **육지(>0m)** 가 있는지 기록
2. 타일 내부에 **물(<=0m)** 이 있는지 기록
3. 타일의 북/남/동/서 경계에서 물인 픽셀 위치를 저장
4. 북극/남극 경계에서 시작해, 타일 경계의 물 픽셀이 맞닿는 이웃으로 BFS 전파
5. 이렇게 연결된 물만 `ocean-connected water`로 인정

분류 기준:

- **river-connected water**: 강이라도 바다와 실제로 이어져 있으면 `ocean-connected water`로 취급
- **ocean only**: ocean-connected water and not land → 파일 생성 안함
- **dry land only**: land and not water → 파일 생성 안함
- **inland water mixed**: land and water, but not ocean-connected → strict coast 아님
- **inland water only**: water only, but not ocean-connected → strict coast 아님
- **strict coast**: land and ocean-connected water → 생성 대상

경도 방향은 wrap 처리 (col 0 ↔ col 168).

메모리: 타일 분류 마스크 + 경계 water mask. 소요시간: ~10-15초.

#### Phase 2: 확장 (5x5 Buffer)

strict coast 타일 주변 반경 2타일, 총 `5x5` 범위로 확장. 경도 방향 wrap (col 0 ↔ col 168).

- 이 단계에서 **완전 육지 타일이라도** strict coast의 5x5 범위 안에 들어오면 생성 대상에 포함
- 즉, 최종 생성 대상은 `strict coast ∪ 5x5 neighbors`

| 분류 | 현재 관측치 |
|---|---|
| ocean only | 7,715 |
| dry land only | 3,702 |
| inland water mixed | 199 |
| inland water only | 3 |
| strict coast | 2,746 |
| **생성 대상 합계 (5x5 포함)** | **8,496** |

#### Phase 3: 타일 생성 (Row-Band 스트리밍)

타일 행(ty) 단위로 원본 읽기 (`514행 x 86400열`, 약 `89MB` — hillshading용 1px 오버랩 포함).

타일별 처리:
1. `514x514` 영역 추출 (hillshading 경계용 1px 오버랩)
2. Int16 → Uint8 변환 (LUT 65536개, 구간별 선형 매핑)
3. Hillshade 계산 (`514x514 -> crop 512x512`)
4. Colormap 생성 (elevation 색상 + hillshading + 글로벌 좌표 디더링)
5. PNG 저장: `tiles/h_XX_YY.png`, `tiles/c_XX_YY.png`

디더링은 글로벌 좌표 사용 (타일 경계 연속성 보장).
이미 존재하는 PNG는 스킵 (이어하기 지원).

검증 메모:

- `--verify`는 기존 `jeju_hires_1024.raw -> PNG` 경로와 현재 매핑 로직이 일치하는지 확인
- 원본 `final_heightmap.raw`에서 제주 윈도를 직접 잘라 비교하면, 높이는 최대 1 level 차이, 색상은 hillshade/노이즈 차이로 일부 픽셀 차이가 날 수 있음

#### Phase 4: 타일 인덱스

`tiles/tile_index.json` — 현재 생성 대상으로 인정되는 타일 목록.

- **인덱스에 없는 타일은 로더에서 무시**
- 과거 분류 기준으로 만들어진 PNG가 폴더에 남아 있을 수 있음
- 따라서 **`tiles/` 디렉토리 자체보다 `tile_index.json`이 source of truth**

```json
{
  "grid": { "cols": 169, "rows": 85, "tile_size": 512, "buffer_radius": 2 },
  "geo": { "origin_lon": -180.0, "origin_lat": 90.0, "deg_per_tile": 2.133 },
  "tiles": { "143_26": "generated", "144_26": "generated" }
}
```

### 현재 결과

| 항목 | 값 |
|---|---|
| 생성 타일 수 | 8,496타일 (`tile_index.json` 기준) |
| 실제 PNG 파일 수 | 8,496쌍 (`16,992` PNG files) |
| 디스크 용량 | ~1.3GB |
| 피크 메모리 | ~100MB (1 row-band 기준) |
| 분류 시간 | ~9.8초 |
| 생성 시간 | 수 분대 후반 ~ 10분대 |

잔여 파일 메모:

- orphan PNG 삭제 완료
- 현재 `tiles/`와 `tile_index.json`은 1:1로 일치
- 렌더러/로더는 계속 `tile_index.json`을 기준으로 판단

### 렌더러 연동 (향후)

- 5x5 타일 스트리밍: 카메라 위치 기준 주변 25타일 로드/해제
- 순수 바다 타일: 파일 로드 없이 코드에서 flat sea 생성
- 타일 경계 이동 시 비동기 로드 + 이동 방향 기반 프리페치

## 향후 과제

- [ ] 더 높은 해상도 DEM (3 arc-second ~90m) 적용 → 가파도/마라도 등 소규모 섬 표현
- [ ] 다중 타일 로딩 (항해 범위 확장)
- [ ] 낮/밤 주기 (태양 위치 → 방향 판단)
- [ ] 별자리 항법 (밤하늘 렌더링)
- [ ] 바람/해류 시스템
- [ ] 고대 항구/포구 배치
- [ ] 교역 시스템
