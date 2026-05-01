# Tamra (탐라)

5세기 후반(476년 전후) 제주도 중심 고대 항해 체험 시뮬레이터. 탐라가 백제에 조공하며 동아시아 해상 네트워크에 공식 편입된 시점이 시대 앵커.

> "지도 위의 점"이 아닌 "배 위의 사람" — 미니맵·좌표·고정 방위 없이 태양·별·바람·해류로만 방향을 판단한다.

Vite + TypeScript (Canvas 2D, Voxel Space 렌더러) + Python 빌드 스크립트로 구성.

## 실행

```bash
cd ~/works/tamra
npm install        # 최초 1회
npm run dev        # 개발 서버 (포트 8089, HMR)
# 브라우저에서 http://localhost:8089
```

프로덕션 빌드:

```bash
npm run build          # dist/index.html + dist/assets/index-[hash].js (~150ms)
npx vite preview       # 번들 미리보기 (포트 8089)
```

배포 번들 만들기:

```bash
npm run release          # release/tamra/ = dist + tiles(WebP) + boat.png (~1초, 증분)
npm run release:zip      # release/tamra.zip (~63KB, tiles 제외) — 평상시 재배포
npm run release:tile:zip # release/tamra-tile.zip (~207MB, tiles 포함) — 초기/타일 변경 시
npm run release:clean    # release/ 비우기
```

- **`release`** 는 `rsync` 증분 복사라 tiles 8,496개는 처음 한 번만 오래 걸리고 이후 재실행은 ~1초. tiles 는 불변이므로 `tile_index.json` + `h_*.webp` 만 동기화 (`c_*.png` 제외).
- **`VITE_BASE=/tamra/`** 로 빌드되어 서브패스 배포(`https://host/tamra/`) 가능. 다른 경로에 배포하려면 `package.json` 의 `release` 스크립트에서 `VITE_BASE` 값 조정.
- 정적 호스팅 쪽엔 `tamra.zip` 만 올리고 압축 해제 후 디렉토리 루트를 웹서버에 연결 (Caddy 예시는 [docs/DEPLOY.md](docs/DEPLOY.md) 참고).

타일 데이터(`tiles/`)는 레포 루트에 실제 디렉토리 — `vite.config.ts` middleware 가 dev/preview 모드에서 asset graph 밖으로 직접 서빙한다. `npm run build` 는 `dist/` 로 tiles 를 복사하지 않으므로 여러 번 빌드해도 빠르다.

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
- **[docs/ROADMAP.md](docs/ROADMAP.md)** — 향후 과제 우선순위 (게임 기획 관점)
- **[docs/UI_PLAN.md](docs/UI_PLAN.md)** — 화면 UI 개선 계획 (디버그 분리 / 펜넌트 / 토스트 등)
- **[docs/PERIOD_NOTES.md](docs/PERIOD_NOTES.md)** — 5세기 후반 동양 항해술 사실 정리 (시스템·시나리오 결정의 역사 근거)
- **[docs/TRADE_NETWORK.md](docs/TRADE_NETWORK.md)** — 5세기 후반 해상 교역망과 항구 노드 (시나리오·`data/ports.json` 근거)
- **[docs/PIPELINE.md](docs/PIPELINE.md)** — DEM → 전세계 타일 빌드 파이프라인
- **[docs/COASTLINE_REFINE.md](docs/COASTLINE_REFINE.md)** — 해상도 증가 없이 해안선을 정교화하는 방법(OSM 벡터·noise·SDF·coverage AA) 비교·우선순위
- **[docs/DEPLOY.md](docs/DEPLOY.md)** — 배포 절차 (Caddy 서브패스, Oracle Cloud 기준)
- **[docs/GLOSSARY.md](docs/GLOSSARY.md)** — 용어 사전 + 참고문헌 (항해·기상·천문·렌더)

## 파일 구조

```
tamra/
├── index.html                ← 얇은 셸 (<script type="module" src="/src/main.ts">)
├── src/                      ← TypeScript 모듈 (Vite 빌드)
│   ├── main.ts               ← 엔트리 (초기화 + Draw RAF 루프)
│   ├── config.ts             ← 상수 (SCR_W, TILE_SIZE, SEA 등)
│   ├── state.ts              ← mutable 싱글톤 (boat, ship, camera, wind, …)
│   ├── canvas.ts             ← canvas / ctx / buf32 / fitCanvas
│   ├── tiles.ts              ← 타일 로더 + altitude/colormap 버퍼
│   ├── terrain.ts            ← colormap 생성 + piecewise height LUT
│   ├── physics/              ← wind, sail, current, waves, weather
│   ├── astronomy/            ← sun, stars, planets, moon
│   ├── sky.ts                ← sky glow + cloud mask
│   ├── render/               ← background, voxel(HOT), camera,
│   │                           effects, minimap, boat-sprite, skymap
│   ├── input.ts              ← 키보드 + 포인터 핸들러
│   ├── audio.ts              ← Web Audio 절차생성 사운드
│   └── debug.ts              ← window.__* DevTools hook 집결
├── vite.config.ts            ← dev 서버 포트 8089 + tiles/boat.png 미들웨어
├── package.json / tsconfig.json
├── README.md / DESIGN.md / CLAUDE.md
├── docs/PIPELINE.md          ← 타일 빌드 파이프라인
├── generate_maps.py          ← legacy: 제주 1024 윈도우 PNG 생성
├── generate_world_tiles.py   ← 전세계 해안선 타일 배치
└── tiles/                    ← 전세계 타일 (심볼릭 링크, gitignore)
```

원본 DEM(`final_heightmap.raw`, 7GB)은 `~/works/heightmap/`에 별도 보관.
