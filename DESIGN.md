# DESIGN.md — 설계 배경

이 문서는 "어떻게 동작하는가"가 아니라 **"왜 이렇게 결정했는가"** 를 기록한다.
구현·줄번호·상수값은 [CLAUDE.md](CLAUDE.md) 참조.

## 핵심 컨셉: "배 위의 사람"

대항해시대 류 게임은 보통 탑다운 미니맵·고정 컴퍼스·좌표 표시로 플레이어를 "지도 위의 점"으로 만든다. Tamra는 그 반대를 의도한다.

- 미니맵·좌표·고정 방위 라벨 없음 (디버그 HUD는 개발용으로만 존재)
- 방향 단서는 **태양·별·바람·해류·해안선 형태** 뿐
- 화면 중심에 배가 고정되고 세계가 돈다 (1인칭에 가까운 외부 시점)

이 컨셉이 모든 시스템의 우선순위를 정한다. **방향 판단에 기여하지 않는 시각 효과는 우선도가 낮다.**

## 왜 Voxel Space인가

3D 모델·WebGL·셰이더 없이 Canvas 2D 단일 파일로 전세계 지형을 렌더하기 위함.

- s-macke/VoxelSpace 알고리즘은 30년 된 raymarch 기법이지만 **heightmap+colormap 두 장의 PNG로 전세계가 재현됨** — 데이터 무게가 가볍다 (~1.3GB로 8,496 해안선 타일)
- WebGL을 쓰지 않으므로 **단일 HTML 파일 배포**가 가능하다 (서빙 외 빌드 단계 0)
- Bilinear 보간 + 곡률 보정만 추가하면 1992년 Comanche 화질을 넘어선다
- 트레이드오프: GPU 가속 없으니 20fps cap. 픽셀 단위 raymarch라 Worker 분산 이점도 적다.

## 왜 단일 HTML 파일에서 Vite+TS 로 갔는가

프로젝트 초기에는 단일 HTML 이었다. 장점:

1. **빌드 시스템 0** — `python3 -m http.server` 한 줄로 실행.
2. **이식성** — Google Drive·USB·SD카드에 올려도 동작.
3. **LLM 친화** — 한 파일에 모든 컨텍스트가 있어 부분 수정이 쉽다.

몰입도 로드맵(태양/바람/해류/별자리/구름/비·눈/뇌전/오디오)까지 끝난 시점에 2456줄에 도달했고, 단점이 뚜렷해졌다:

- 섹션별 독립 수정이 어렵다 (12개 이상 mutable 싱글톤이 IIFE 한 스코프에 엉킴)
- 네비게이션이 CLAUDE.md 줄번호 표에 의존 → 약간의 수정만 가해도 stale
- 테스트·기능 플래그 등 **확장 전에 경계를 그어두는 편이 싸다**

Vite + TypeScript 로 이관 (커밋 `[JONES-89]` 시리즈, 13단계). **런타임 동작·프레임 예산·디버그 인터페이스 동일 유지**. 선택 근거:

- Vite 는 dev HMR + 단일 번들(`inlineDynamicImports: true`) production 둘 다 지원. dist/ 는 `index.html` + `index-[hash].js` 두 파일 → "단일 HTML 정신" 충분히 가까움.
- TS 는 *loose 모드* 로 출발 (`strict: false`, `allowJs: true`). 구조 분리가 목적이지 타입 안전이 아님. 파일별 strict 승격은 별도 과제.
- Python 타일 파이프라인 미변경.

### 모듈 경계 — 왜 이렇게 갈랐는가

분할 기준 두 가지:

1. **코드가 매 프레임 접근하는 상태를 이웃에 둔다** — hot loop (`render/voxel.ts` `Render()`) 는 진입 시 state 프로퍼티를 local 변수로 캐싱한다. 이 패턴이 유지되려면 state.ts 가 zero-import 이어야 한다 (순환 방지).
2. **물리 vs 천문 vs 렌더** — 시뮬레이션 모델(위도·대기·궤도)은 렌더 디테일과 코드베이스 상 독립적이다. `physics/` / `astronomy/` 폴더 분리로 "몰입도 모델을 교체하고 싶을 때 렌더는 건드릴 필요 없다" 는 계약 명시.

**Mutable 싱글톤 유지**: 객체 참조 기반 ESM export (`export const boat = {...}`) 는 live binding 이므로 어느 모듈에서 mutate 해도 전 import 에 즉시 반영. 기존 `var boat = {...}` 의미론과 동일. 상태관리 라이브러리는 도입하지 않음 — 게임 루프 기준 매 프레임 수 십 개 필드를 동시에 갱신하는 구조에는 event sourcing/reducer 가 오히려 overhead.

**재할당되는 스칼라**: `gameTime`, `TIME_SPEED` 등은 `export let` 으로 내보내면 import 측에서 reassign 불가. → `timeRef = { gameTime, TIME_SPEED }`, `inputState = { rotStep, moveStep }`, `mmState = { stride }` 같은 wrapper 객체로 통일. callsite 는 `timeRef.gameTime += ...` 기계적 치환.

**Hot loop 분리 안 함**: `render/voxel.ts` Render() 는 inline 가능한 가장 작은 덩어리로 유지. 모듈 간 함수 호출 indirection 이 프레임 budget 에 누적되지 않도록 DrawVerticalLine 도 동일 파일에 둠.

## 시간 가속의 트레이드오프

기본 `TIME_SPEED = 120` (실시간 1초 = 게임 2분, 하루 12분).

- **너무 느리면**: 태양 이동·별 회전·바람 변화를 체감하지 못한다 → 항해술 없는 단순 운전 게임이 됨
- **너무 빠르면**: 항해 거리감이 비현실적이 된다 (1초에 30km 이동)
- 120배가 "낮·밤·황혼을 한 번씩 보는 데 5분"이라는 체감과 잘 맞음

T/Y로 1~7200 조절 가능 — 빠르게 별 회전을 보거나 느리게 정밀 항해할 수 있게.

## 높이 매핑: 왜 piecewise linear인가

8-bit (256 단계)에 -8000m~+5000m를 담아야 한다.

- **선형 매핑**: 1 unit = 51m → 해안선 디테일(±10m) 완전 소실
- **감마/log 매핑**: 해수면(0)에서 미분값 무한대 → Uint8 양자화 시 절벽 발생
- **piecewise linear**: 7개 구간으로 나눠 해수면 부근 0.42m/unit, 심해/고산은 거칠게 압축. 구간 내 선형이라 양자화 절벽 없음.

렌더 시 `heightMeters[256]` LUT로 미터 역변환하므로 구간 무관하게 정확한 비율로 투영된다.

## 왜 8x8 슬롯 링버퍼인가

전세계 8,496 타일을 모두 메모리에 못 담는다 (1.3GB).

- **링버퍼 슬롯**: `(tx, ty) → (tx%8, ty%8)`. 글로벌 좌표를 `& MASK` 하면 버퍼 위치가 바로 나옴 — 좌표 변환 비용 0
- **5x5 로드 (1280px) > 렌더 거리 (800px)**: 가장자리에서 다음 타일이 미리 로드됨, 시야 안에 빈 영역 안 보임
- 8x8 = 4096px = 4096²/4 = 4MB Uint8. 두 배열(altitude+colormap)이라 ~32MB. 메모리 안전 영역.

## 항해 모델: sail-based propulsion

처음엔 "1키=1스텝" 이산 이동이었다 (디버그 편의성). 5개 환경 시스템 추가 후 **돛 토글 + 자동 추진**으로 전환.

이유:
- 바람·해류가 의미를 가지려면 "바람 방향과 배 방향의 관계"가 추진력에 직접 반영돼야 한다
- 1키=1스텝은 풍향 무관 — 시뮬레이터가 아니라 텔레포터가 됨
- polar curve(IRONS/CLOSE/BEAM/BROAD/RUN) 5단계는 실제 범선의 거친 근사. 정확도보다 "역풍은 못 가고 측풍이 빠르다"는 체감이 목적

회전(A/D)은 여전히 이산 1키=1스텝. 실제 키나 조타륜 시뮬은 과한 디테일.

## 천체역학 정확도 기준

별·행성·달 모두 **육안 정확도** 기준. 정밀 천문학 라이브러리(astropy 등) 수준은 불필요.

- **별**: J2000 + GMST → LST → hour angle. 70개 카탈로그는 1등급 이하 + 주요 별자리 멤버 수동 큐레이션. 별자리 선은 의도적으로 그리지 않음 — 사용자가 별 패턴을 직접 인지하도록.
- **행성**: Meeus *Astronomical Algorithms* Ch.31의 J2000 평균 궤도요소. Kepler 방정식 Newton's method 4회 반복이면 시지름·등급 근사에 충분.
- **달**: Meeus 간이식 (L', D, M, M', F → λ/β). 정밀도 ~수 분각이지만 위상 표시·하늘보기에 충분.
- **낮에는 별/행성/달 숨김**: 실제 태양빛에 묻혀 안 보이는 게 맞음. `sun.altDeg < 0` 게이트.

## 바람·해류 모델: 위도대 일반순환

실제 대기 대순환(Hadley·Ferrel·Polar)을 위도별 함수로 근사.

- 정밀한 GFS/ECMWF 데이터를 끌어올 수 없고, 끌어와도 5세기 데이터는 아님
- "북동무역풍대로 가면 서로 떠밀린다", "편서풍대에서 동진이 빠르다" 같은 체감이 목적
- 아시아 몬순은 한국·일본 영역에서 여름 SW / 겨울 NE 의 큰 차이를 줘 계절감 강화
- **결정적 noise** (위치 0.2° grid + 주 단위): 같은 위치에서 시간 흐름에 따라 부드럽게 변화. random()을 매 프레임 호출하면 깜박임 발생.

해류도 동일 철학. 쿠로시오는 110~150°E, 20~45°N 영역에서 NE 방향 1.2 m/s — 한국 근해에서 "남쪽으로 가려는데 북쪽으로 떠밀리는" 체감을 위한 수동 패치.

## 파도가 깜박였던 버그

증상: 항해 중 바다 픽셀이 미세하게 깜박임.

원인: `wave.sin(plx * dx + plt * speed)` 의 `plx`가 절대 월드좌표(73000+). 카메라가 1 unit 움직이면 dx가 작아도 위상이 73000 × dx 만큼 점프 → 인접 프레임에서 sin 값이 무작위로 바뀜.

수정: `wx = plx - camera.x` 로 카메라 상대 좌표 사용. 위상이 0 근방에서 변화하므로 부드럽다.

이 버그는 **부동소수점 정밀도와 큰 좌표값의 곱셈** 패턴 — 다른 곳에서도 재발 가능. 새 sin/cos 추가 시 좌표 스케일 확인 필요.

## Render() 최적화 결정 (3.72ms → 2.33ms)

원래 frame time 3.72ms는 20fps cap(50ms) 대비 충분한 여유. 그럼에도 최적화한 이유:

- 향후 해상도/거리 상향 여유 확보
- 추가 효과(돛 물리·구름 그림자 등) 예산 마련
- 모바일/저사양 환경 고려

적용한 최적화는 **화질 무손실** 항목만 (allSea fast path, hiddeny 재사용, early termination, waveStage). 화질 영향 있는 항목(컬럼 서브샘플링, deltaz 증가율 변경 등)은 보류.

## 왜 20fps cap인가

- Voxel Space 특성상 60fps는 비현실적 (raymarch가 무겁다)
- **20fps = 50ms** 는 rAF 16.67ms의 정수배 근처가 아님 → `FRAME_EPSILON = 8ms` 허용으로 지터 흡수
- 항해 시뮬에서 60fps의 부드러움은 큰 가치 아님. 바다는 어차피 천천히 움직임.

## 몰입도 강화: C→A→B 순서

"배 위의 사람" 컨셉상 방향 판단에 기여하는 **시각 단서**가 우선. 그 중 천체·대기광이 가장 직접적(별 magnitude→항해성 인지, 대기광 비대칭→해가 뜨고 지는 방위 감각).

- **Phase 1 (천체/수평선)**: 태양 halo·지평 대기광·별 twinkle·달 halo — 렌더 레이어 기존 경로(`updateSky`·`DrawBackground`) 확장, 리스크 낮음
- **Phase 2 (기상 시각)**: 구름·비/눈·근거리 안개·뇌전 — Phase 1 위에 합성. 구름이 Phase 1의 별 차폐로 연결
- **Phase 3 (사운드)**: Web Audio 독립 스레드. 시각과 격리되어 맨 뒤

## 대기광 분리(separable) 모델

지평 부근 붉은 띠는 2D이지만 `skyGlowX[x] × skyGlowY[y]` 외적으로 근사. 완전히 정확하진 않지만:
- x 방향은 cos²(방위 − 태양방위)로 자연스러운 광원 감쇠
- y 방향은 horizon 주변 60px에서 fade
- 계산 복잡도 O(W+H) (외적이 per-pixel O(1)). 추가 frame 비용 <1ms
- 태양 고도 -8~15° 구간에서만 활성화 — 한낮/깊은 밤에는 0

## Phase 2 — 구름 마스크의 업샘플 비용 분리

구름은 `64×18` value noise + smoothstep으로 마스크 생성 후 `CLOUD_FULL_H=200`×`SCR_W` 풀해상도 버퍼에 bilinear 업샘플. 업샘플은 `gameTime/30000` 단위(=30초 게임시간)로만 재계산. 매 프레임 full upsample을 하면 2~3ms 추가되지만, **결정적 키** 기반 캐싱으로 상시 비용 0.

이점:
- 별·행성·달 차폐는 `cloudAlphaAt(x,y)` O(1)로 즉답 — per-object overhead 무시 가능
- 구름 pan(경도·시간 기반)은 키 바뀔 때만 반영 → 부드럽게 drift
- `cloudiness < 0.15` 면 sky row 전체 `buf32.fill(c)` 빠른 경로로 fallback (맑은 날 부담 0)

결과: 맑은 날 ~3ms, 흐린 날 ~11-15ms — 50ms cap 대비 안전.

## Phase 2 — 비/눈 파티클: 월드 좌표 포기

이론상 파티클은 월드 좌표계에서 내리고 카메라로 투영해야 "배가 움직이는 중에도 빗방울이 제자리에 떨어진다". 하지만:
- Voxel Space는 스크린 투영 함수가 정확하지 않음(raymarch 기반)
- 빗방울 한 개당 depth·bilinear 비용 크다 → 300개 × 20fps 부담
- 실제 체감은 "화면 전체에 비가 내린다" 수준이면 충분

→ **스크린 공간 파티클**로 결정. 300개 고정 Float32Array 풀, 매 프레임 (풍향 driftX, 중력 fallY) 이동. `buf32` 직접 write(alpha blend 없음). 눈은 점, 비는 3px 사선. 재생성은 화면 밖 → 상단 랜덤.

## Phase 3 — 사운드: 절차 생성만

외부 오디오 asset 없음 — 단일 HTML 제약 유지. PCM 버퍼(pink-ish noise 4s)는 기동 시 1회 생성. 모든 소리는 Web Audio 내부 스레드에서 동작하므로 **메인 루프 frame time 영향 0**.

- **파도**: noise → lowpass(cutoff=250+wind*15Hz) → gain(0.05~0.35, wind.speedMS 기반). 무풍이어도 잔잔한 low hum
- **바람 whistle**: noise → bandpass(center=400+wind*30Hz, Q=3) → gain(wind>4m/s부터). 고속에선 고주파 whistle 느낌
- **돛 펄럭임**: boat.sailUp + sail.mode==='RUN' 일 때 1.2~3s 랜덤 간격 burst. RUN(정후풍)만 골라낸 이유는 실제 범선에서 후풍일 때 돛이 가장 많이 펄럭이기 때문
- **UI blip**: 돛 토글(520/340Hz)·시간 가속(440/660Hz) 시 100ms sine. 외부 SFX 없이 상태 변화를 청각화
- **음소거(M)**: master gain smoothstep 50ms. localStorage 영속 — 유저가 꺼두면 리로드 후에도 유지

iOS Safari는 `ctx.state === 'suspended'`로 시작 → 첫 키/포인터에서 `resume()`. 이 게이트가 없으면 "소리가 안 나요" 제보의 가장 흔한 원인이 됨.

기본 master gain 0.3 — 시뮬 게임에서 음향은 환경 단서지 주목 대상이 아니다. 너무 크면 피로.

## Phase 2 — 뇌전 플래시의 결정적 트리거

rng 기반이면 재현성·예측성이 낮다. 대신 `gameTime / 30000` bucket에 대해 hash 값이 `prob = (cloudiness-0.85)*1.3 + 0.05` 미만이면 그 bucket의 처음 진입 시 플래시 발동. `lightningLastRealMs` 쿨다운 1.5초로 한 bucket에 여러 번 발동 방지.

플래시 자체는 real time 0~50ms 강, 50~120ms 감쇠. 하늘(horizon 위)을 주로 밝히고 지표는 35% 세기 — 구름 내부 발광이 지면까지 반사된 느낌.

## 의도적으로 안 한 것

- **WebGL/GPU 이식**: 단일 HTML 제약 위반. 별도 fork로 가능하지만 본 프로젝트 범위 외
- **별자리 연결선**: 사용자가 별 패턴을 인지하는 학습 과정을 빼앗음
- **나침반/방위 표시**: "배 위의 사람" 컨셉 위반. 디버그 HUD에만 존재
- **자동 항해 / waypoint**: 같은 이유. 시뮬은 길찾기가 아니라 길찾기를 *경험*하는 것
- **3D 배 모델**: Canvas 2D 스프라이트로 충분. 시점이 1인칭에 가까워 배 외형 디테일 가치 낮음
