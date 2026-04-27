# GLOSSARY.md — 용어 + 참고문헌

코드와 문서에 등장하는 도메인 용어를 분류별로 정리. 정밀 정의가 아니라 **이 프로젝트에서 쓰이는 의미** 기준.

## 항해 (Sailing)

- **돛 (Sail)** — 바람을 받아 추진력을 만드는 천. 코드에선 `boat.sailUp` 불리언. 실제 범선의 다중 돛(스풀·메인·짚)은 모델링 안 함.
- **선수 방향 (Heading)** — 배가 향하고 있는 방향. `boat.angle` (0=북, CCW). 진행 방향(course)과 다를 수 있음 — 해류 drift 때문.
- **풍각 / AoA (Angle of Attack)** — 풍향과 선수 방향 사이의 각도. 0°=정면 역풍, 180°=정후풍.
- **Points of Sail** — AoA에 따른 항행 모드. polar curve 5단계로 근사:
  - **IRONS** (0~30°) — 정면 역풍. 추진 거의 0. 멈춤
  - **CLOSE-hauled** (30~60°) — 벌이. 효율 ~55%
  - **BEAM reach** (60~120°) — 측풍. 효율 100% (최적)
  - **BROAD reach** (120~160°) — 빗후풍. 효율 ~120% (가장 빠름)
  - **RUN** (160~180°) — 정후풍. 효율 ~90% (의외로 손실)
- **Polar curve** — AoA → 추진 효율 함수. 실제 범선은 매끈한 곡선이지만 본 프로젝트는 5단 step 근사
- **Drift** — 바람·해류로 의도치 않게 옆/뒤로 밀리는 성분. `ship.groundDirRad ≠ boat.angle` 의 차이로 나타남
- **Ground speed / Sail speed** — `ship.groundMS` (실제 진행 속도) vs `ship.sailMS` (돛 추진만의 속도). 차이 = 해류

## 기상 (Atmospheric)

- **대기 대순환** — 위도대별 정상 풍계. 본 프로젝트는 3-cell 모델 사용:
  - **Hadley cell** (0~30°) — 적도에서 상승, 30°에서 하강. 지표는 **무역풍**(NE in 북반구, SE in 남반구)
  - **Ferrel cell** (30~60°) — 중위도. 지표는 **편서풍** (W→E)
  - **Polar cell** (60~90°) — 극지방. 지표는 **극동풍** (E→W)
- **ITCZ** (Inter-Tropical Convergence Zone) — 적도수렴대. 양반구 무역풍이 만나는 띠. 계절에 따라 ±5° 이동, 강한 대류·구름 발생 → cloudiness +0.5
- **무풍대 / Doldrums** — ITCZ 부근 약풍 영역. 본 프로젝트는 무역풍 약화로 표현
- **Horse latitudes** — 30° 부근 아열대 고기압대. 약풍 + 맑은 하늘 → cloudiness -0.15
- **몬순 (Monsoon)** — 계절풍. 동아시아 영역에서 여름 SW(240°) / 겨울 NE(45°). 한국·일본 항해에 결정적 영향
- **해륙풍 (Sea/Land breeze)** — 일중 기온차로 발생하는 국지풍. 본 프로젝트는 약하게 모델

## 해양 (Oceanographic)

- **쿠로시오 (Kuroshio)** — 일본 동안을 따라 북상하는 강한 난류. 본 프로젝트는 110~150°E, 20~45°N 영역에서 NE 방향, 1.2 m/s. "남쪽으로 가려는데 북쪽으로 떠밀리는" 한국 근해 체감의 원인
- **적도 반류 (Equatorial counter-current)** — 적도 부근 동→서 흐름
- **아열대 환류** — 30° 부근 시계 방향(북) / 반시계(남) 환류
- **편서풍 표류** (West Wind Drift) — 중위도 동향 흐름

## 천문 (Astronomical)

- **DEM** (Digital Elevation Model) — 표고 데이터. 본 프로젝트는 86400×43200 grid, ~450m/px, Int16, WGS-84
- **WGS-84** — GPS·Google Maps에서 쓰는 측지계. lat/lon 그대로 사용
- **J2000** — 천체 위치 계산 기준 epoch (2000년 1월 1일 12:00 TT). 별·행성 모두 J2000 좌표로 카탈로그
- **RA / Dec** (Right Ascension / Declination) — 천구 적도좌표. RA는 시간(0~24h), Dec는 도(-90~+90°)
- **Hour Angle (H)** — 천체가 자오선을 통과한 후 지난 시간(각). `H = LST - RA`
- **GMST** (Greenwich Mean Sidereal Time) — 그리니치 항성시. UT → GMST → LST 변환 체인
- **LST** (Local Sidereal Time) — 관측지 항성시. `LST = GMST + lon/15` (시간 단위)
- **Altitude / Azimuth (alt/az)** — 지평좌표. alt=수평선 위 각도, az=북에서 시계방향 각도. 화면 렌더에 직접 사용
- **Declination (δ)** — 태양 적위. 계절 변화 핵심 (`δ = 23.44° · sin(2π·(N-81)/365)`)
- **Ecliptic (황도)** — 태양이 천구상에 그리는 경로. 행성·달 위치 계산의 기준 평면
- **Kepler 방정식** — `M = E - e·sin(E)`. 평균근점이각 M에서 이심근점이각 E를 푸는 방정식. 해석해 없음 → Newton's method 4회 반복
- **궤도요소** (Orbital elements) — 6개 파라미터 (a, e, i, Ω, ω, M)로 행성 궤도 결정
- **Heliocentric / Geocentric** — 태양 중심 / 지구 중심 좌표. 행성 위치는 helio → geo → equatorial → alt/az 변환 체인
- **Magnitude** — 별·행성 등급. 1등성 차이 = 밝기 약 2.5배. 작을수록 밝음 (시리우스 -1.46, 금성 -4.6)
- **Elongation (D)** — 달과 태양의 황경 차. 달 위상 결정 (D=0 신월, D=π 보름)
- **Lunar phase / Illumination** — 달 위상 (-π~π) / 조도 (0~1). `illumination = (1 - cos(D))/2`

## 그래픽 / 렌더 (Graphics)

- **Voxel Space** — 1992년 NovaLogic *Comanche*에서 사용한 raymarch 렌더링. heightmap+colormap 두 장으로 지형을 그림
- **Raymarch** — 카메라에서 광선을 쏴 가까운 곳부터 먼 곳까지 일정 step으로 진행하며 충돌 체크
- **Occlusion** — 가려짐. `hiddeny[]` 배열로 컬럼별 첫 충돌 y 캐시
- **Bilinear interpolation** — 4-이웃 가중평균. 정수 grid 데이터를 부드럽게 샘플링
- **Hillshade** — 가상 광원으로 지형 음영 계산. 평면 colormap에 입체감 부여
- **Fog (대기 원근)** — 거리에 따라 색을 평균색으로 수렴. 본 프로젝트는 바다=하늘색, 육지=회색으로 분리 적용
- **projScale** — 카메라 거리 z에 반비례하는 화면 투영 배율. `projScale = (SCR_H · 0.0044) / z`
- **deltaz** — raymarch step 크기. 가까울수록 작게(`0.5`), 멀수록 크게(`+0.005/step`)
- **Polar azimuthal projection** — 천구 전체를 한 원반에 투영. 천정=중심, 지평선=원주. 하늘보기(K)에 사용
- **Piecewise linear mapping** — 구간별 선형. Uint8(256단계)에 -8000~+5000m를 비균일 매핑
- **Curvature drop** — 지구 곡률에 의한 거리별 침하. `drop_m(z) = (z·UNIT_M)² / (2R)`

## 데이터 / 시스템 (Data systems)

- **타일 스트리밍** — 전세계 8,496 타일 중 카메라 주변 5×5만 메모리 로드
- **링버퍼 슬롯** — 8×8 = 64 슬롯. 글로벌 좌표 `& MASK` 로 슬롯 위치 즉시 결정
- **MASK / SHIFT** — 비트 연산용 상수. `MASK = 4095 = 2^12 - 1` (4096 wrap), `SHIFT = 12`
- **글로벌 좌표** — 타일 무관한 전세계 픽셀 좌표. 배 위치는 항상 글로벌 (예: `gx=73000`)
- **Source of truth** — 진실의 출처. 본 프로젝트에선 `tile_index.json` (디스크 PNG가 아니라)
- **EMA** (Exponential Moving Average) — 지수이동평균. frame time 측정에 alpha=0.1 사용
- **Frame cap** — `FRAME_INTERVAL` (ms)로 상한 fps 제한. 본 프로젝트 50ms = 20fps

---

## 참고문헌

### 알고리즘 / 코드

- **s-macke/VoxelSpace** — Voxel Space 레퍼런스 구현. 본 프로젝트의 Render() 출발점.
  https://github.com/s-macke/VoxelSpace
- **NovaLogic, *Comanche: Maximum Overkill*** (1992) — Voxel Space 최초 상용 사례.

### 천문

- **Meeus, Jean. *Astronomical Algorithms*, 2nd ed.** (Willmann-Bell, 1998)
  태양·달·행성 위치 계산의 표준 참고서. 본 프로젝트는:
  - Ch.22 — 태양 위치
  - Ch.31 — 행성 위치 (J2000 평균 궤도요소)
  - Ch.47 — 달 위치 (간이식)
- **IAU SOFA** — 시간/좌표 변환 표준. 본 프로젝트는 정밀도 요구 낮아 직접 사용 안 함.

### 기상 / 해양

- **3-cell atmospheric circulation model** — 표준 기후학 교과서.
- **Kuroshio current** — 일본 해양학 / NOAA 데이터.
- 본 프로젝트의 위도대 풍계·해류는 **체감 정확도** 기준 수동 모델링 (실측 GFS/ECMWF 데이터 미사용).

### 데이터

- **DEM 원본** (`final_heightmap.raw`, 7GB, 86400×43200, Int16, WGS-84)
  외부 보관 (`~/works/heightmap/`). 출처는 SRTM·GEBCO 등에서 합성된 것으로 추정 (정확한 provenance 미상). 재배포 권리 미확인.
- **WGS-84** — GPS 표준 측지계.

### 항해 모델

- **Sail polar diagram** — 실제 요트 polar curve 데이터를 5단 step으로 단순화. 정밀도보다 체감 우선.
- 5세기 동아시아 항해술은 **별·태양·새·해류** 관찰 의존 (자기 나침반은 11세기 이후 항해 도입). 이 프로젝트의 "배 위의 사람" 컨셉의 역사적 근거.
