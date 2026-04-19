# Tamra (탐라)

9세기 이전 제주도 중심 고대 항해 체험 시뮬레이터.

> "지도 위의 점"이 아닌 "배 위의 사람" — 미니맵·좌표·고정 방위 없이 태양·별·바람·해류로만 방향을 판단한다.

단일 HTML 파일(Canvas 2D, Voxel Space 렌더러) + Python 빌드 스크립트로 구성.

## 실행

```bash
cd ~/works/tamra
python3 -m http.server 8089
# 브라우저에서 http://localhost:8089
```

타일 데이터(`tiles/`)는 심볼릭 링크로 공용 디렉토리를 참조한다.

## 조작법

| 키 | 동작 |
|---|---|
| W / ↑ | 돛 올림 (전진 시작) |
| S / ↓ | 돛 내림 (정지) |
| A / ← | 좌회전 |
| D / → | 우회전 |
| K | 하늘보기 토글 (천구 polar projection, 시간 정지) |
| M | 음소거 토글 (localStorage 영속) |
| T / Y | 시간 속도 ÷2 / ×2 |
| `[` / `]` | 회전 속도 ÷2 / ×2 |
| `,` / `.` | 이동 속도 ÷2 / ×2 (디버그) |
| `-` / `=` | 미니맵 축소 / 확대 |

배는 돛 상태에 따라 자동 추진된다. 풍향과 선체 각도(AoA)에 따른 polar curve로 속도가 결정되고, 해류가 더해져 실제 진행 방향이 정해진다.

## 구현된 시스템

- 전세계 8,496 해안선 타일 스트리밍 (8x8 슬롯 링버퍼)
- 시간/태양 (낮·황혼·밤 그래디언트)
- 별자리 (~70개 카탈로그, J2000)
- 태양계 7행성 (Meeus + Kepler)
- 달 (위상·조도, Meeus 간이식)
- 바람 (Hadley/Ferrel/Polar + 아시아 몬순)
- 해류 (쿠로시오 등)
- 파도 (swell + 풍파)
- 날씨 (cloudiness, 가시성)
- 돛 추진 (sail polar curve)
- 하늘보기 (polar azimuthal projection, K키)

## 디버그 패널

우하단. 위치·각도·태양 위치·바람·해류·돛 상태·지면 속도(m/s, km/h)·구름·FPS 등 표시.

## 문서

- **[DESIGN.md](DESIGN.md)** — 설계 결정의 배경 ("왜 이렇게")
- **[CLAUDE.md](CLAUDE.md)** — 작업용 빠른 참조 (LLM/엔지니어)
- **[docs/PIPELINE.md](docs/PIPELINE.md)** — DEM → 전세계 타일 빌드 파이프라인
- **[docs/GLOSSARY.md](docs/GLOSSARY.md)** — 용어 사전 + 참고문헌 (항해·기상·천문·렌더)

## 파일 구조

```
tamra/
├── index.html                ← 시뮬레이터 (단일 파일, ~1870줄)
├── README.md                 ← 이 문서
├── DESIGN.md                 ← 설계 배경
├── CLAUDE.md                 ← 작업용 인덱스
├── docs/PIPELINE.md          ← 타일 빌드 파이프라인
├── generate_maps.py          ← legacy: 제주 1024 윈도우 PNG 생성
├── generate_world_tiles.py   ← 전세계 해안선 타일 배치
├── jeju_hires_1024.{raw,png} ← legacy 산출물
├── jeju_colormap_1024.png    ← legacy
└── tiles/                    ← 전세계 타일 (심볼릭 링크)
```

원본 DEM(`final_heightmap.raw`, 7GB)은 `~/works/heightmap/`에 별도 보관.
