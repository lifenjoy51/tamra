# 탐라 렌더러 lowpoly 3D 전환 계획 (PoC)

> 작성: 2026-06-28 · 상태: 계획(미착수) · 레퍼런스 톤: **My Oasis** 풍 스타일라이즈드 lowpoly

---

## 1. 배경 (Context)

현재 탐라는 [s-macke/VoxelSpace](https://github.com/s-macke/VoxelSpace) 기반 **Canvas-2D 소프트웨어
voxel 레이캐스터**(`src/render/voxel.ts`의 `Render()`)로 지형을 그린다.

- 타일 colormap에 **Sobel 힐셰이드 + 디더링이 구워진 "사진같은" 톤**.
- CPU 렌더링이라 프레임당 ~2.3ms 부담, **20fps cap**(`FRAME_INTERVAL=50ms`)이 걸려 있다.

**목표**: My Oasis 풍의 **깔끔하고 따뜻한 스타일라이즈드 lowpoly 3D**로 비주얼을 교체한다.
단, 현재의 **640×360 저해상도 + 정수배 `pixelated` 업스케일(레트로 픽셀 도트) 질감은 유지**한다.
즉 "**lowpoly 지오메트리 + 저해상도 픽셀 렌더 타겟**"의 조합 — 단순 매끈한 모바일 룩이 아니라 픽셀 질감이 섞인 lowpoly.

### 코드 분리 현황 (탐색 결과)

코드가 깔끔하게 분리돼 있어 **시뮬레이션 ~65%는 손대지 않는다**. 교체 대상은 렌더 플러밍뿐.

| 구분 | 모듈 | 재사용성 |
|---|---|---|
| 물리 | `src/physics/{wind,sail,current,waves,weather}.ts` | **100%** 순수 데이터 계산, state.* 갱신만 |
| 천문 | `src/astronomy/{sun,stars,planets,moon}.ts` | **100%** 순수 위치 수학 (`altRad`/`azRad`) |
| 지형 데이터 | `src/tiles.ts`, `src/terrain.ts` | **100%** altitude(Uint8 링버퍼)+`heightMeters[256]` LUT |
| 입력/오디오/디버그 | `src/input.ts`, `src/audio.ts`, `src/debug.ts` | **100%** 렌더 무관 |
| 상태/상수 | `src/state.ts`, `src/config.ts` | **100%** |
| 카메라/이동 | `src/render/camera.ts`의 `UpdateCamera`/`moveBoat`/`ensureTilesLoaded` | 로직 재사용(렌더 출력만 분리) |
| 하늘 색 | `src/sky.ts` | **90%** 로직 재사용, 출력 포맷만 변경(Uint32 패킹→RGB) |
| **렌더 레이어** | `src/render/voxel.ts`, `background.ts`, `effects.ts`, `minimap.ts`, `boat-sprite.ts`, `skymap.ts`, `src/canvas.ts` | **교체 대상** |

---

## 2. 확정된 결정

| 항목 | 결정 | 근거 |
|---|---|---|
| **기술** | Three.js (WebGL) | 부드러운 조명/물/하늘/구름을 합리적 작업량으로. 새 의존성 ~150KB 감수 OK |
| **해상도/질감** | 내부 렌더 타겟 640×360, `antialias:false`, CSS `image-rendering:pixelated` 정수배 업스케일 유지 | lowpoly + 레트로 픽셀 도트 질감 유지 |
| **지형 스타일** | 양식화 고도 팔레트(깊은 청→청록→모래→초록→회색 봉우리) + `flatShading:true` 패싯 | "깔끔/단순 lowpoly". 기존 사진 colormap 미사용 |
| **범위** | 제주 시작 구역만 **정적 메시 PoC** | 룩/성능 먼저 검증, 이후 5×5 타일 스트리밍 확장 |
| **컨셉** | 미니맵/좌표 없는 1인칭 항해 + 모든 물리/천문/오디오 그대로 | 비주얼만 교체로 범위 고정 |

---

## 3. 좌표/스케일 매핑 (핵심 난제)

현재 월드 좌표계:
- `camera.x/y`: 월드 픽셀 단위 (타일 512px, 8×8 슬롯 링버퍼, `WORLD_W/H`)
- `camera.heightMeters`: 미터 (기본 50m)
- `camera.angle`: 라디안 (0=북)
- 수평 1 world-unit(px) = `UNIT_M` = **400m**, 지형 높이는 미터 (`heightMeters[256]`)

→ 수평 1px=400m, 수직 1m로 **비율 불일치**. 기존 voxel은 `projScale=0.0044`로 수직을 압축해 처리.
3D에선 메시 정점 높이에 **수직 과장 상수 `V_EXAG`** 를 곱해 튜닝한다(실제 미터를 그대로 쓰면 산이 너무 납작).

`src/render3d/coords.ts`가 이 변환을 전담:
- 씬 XZ평면 = 월드 픽셀(또는 그 스케일 다운), Y = `heightMeters[alt] * V_EXAG`
- `camera.x/y/angle/heightMeters` → three `PerspectiveCamera` 위치·회전
- antimeridian 래핑은 PoC 범위 밖(정적 제주 구역이라 무시)

---

## 4. 작업 항목

### 4.1 의존성
```bash
npm i three @types/three
```

### 4.2 신규 디렉토리 `src/render3d/`

| 파일 | 책임 |
|---|---|
| `renderer.ts` | `WebGLRenderer({antialias:false})` + `setSize(640,360)`, `Scene`, `PerspectiveCamera`. 리사이즈 시 CSS만 정수배(`PX_SCALE` 로직 재사용), 픽셀 도트 유지 |
| `coords.ts` | §3의 월드↔씬 좌표/카메라 변환. 튜닝 상수 `V_EXAG`, 거리 스케일 |
| `terrain-mesh.ts` | 제주 주변 altitude 링버퍼를 stride(예 4px) 샘플 → 격자 `BufferGeometry`. 정점 height=`heightMeters[alt]*V_EXAG`, 정점 색=양식화 고도 팔레트, `MeshStandardMaterial({flatShading:true, vertexColors:true})`. 바다 셀 평탄화 |
| `water.ts` | 청록 평면 + 정점 sin 흔들림(`state.wave` swell/mid/ripple 재사용) 또는 노멀 흔들림. 단순 lowpoly 물 |
| `sky3d.ts` | 그라데이션 스카이돔 + `THREE.Fog`. 색은 `sky.ts`의 day/dusk/night 팔레트 로직 재사용(RGB 추출). 뭉게구름 빌보드는 후순위 |
| `celestial.ts` | 태양/달/별/행성을 `altRad`/`azRad`→방향벡터로 빌보드·포인트 배치. `DirectionalLight`=태양 방향 + `AmbientLight` 보조. 별/행성/달은 `sun.altDeg<0`일 때만 |
| `boat3d.ts` | 간단 lowpoly 보트(박스+삼각 조합) 또는 기존 boat 스프라이트 빌보드. 카메라가 보트에 snap |

### 4.3 `src/main.ts` 통합
- `Draw()`의 시뮬레이션 업데이트(`UpdateCamera` 내부 physics/astro/이동/`ensureTilesLoaded`)는 **그대로 호출**
- 렌더 부분(`DrawBackground`/`Render`/effects/minimap/boat-sprite)을 3D 경로로 분기
- **기존 voxel 렌더러는 삭제하지 말고 토글**(`window.__render3d` 또는 `uiFlags`) → PoC 비교/롤백 안전
- 20fps cap은 일단 유지, 성능 여유 확인 후 해제 검토

### 4.4 후처리/효과
- 근거리 안개 → `THREE.Fog`로 대체
- 비/눈/뇌전(`effects.ts`): 강도 곡선·바람 드리프트 로직은 순수하므로 재사용, 출력만 3D(파티클/오버레이)로 — **PoC 1차에서는 후순위**

---

## 5. 단계 (제주 PoC 순서)

1. three 설치 + `render3d/renderer.ts`로 빈 씬 640×360 픽셀 도트 표시
2. `coords.ts` + `terrain-mesh.ts`: 제주 주변 altitude → 양식화 팔레트 패싯 메시, 카메라 보트에 snap
3. `water.ts`: 바다 평면 + 흔들림
4. `sky3d.ts` + `celestial.ts`: 하늘 그라데이션 + 태양 조명 + (밤)별/달
5. `boat3d.ts`: 보트 + 카메라 snap, A/D 회전·W/S 돛 동작 확인
6. `V_EXAG`·팔레트·포그·조명 튜닝으로 My Oasis 톤 맞추기

---

## 6. 검증

- `npm run dev` → http://localhost:8089
- 제주 시작 화면에서 **lowpoly 섬 + 청록 바다 + 그라데이션 하늘** 확인, A/D/W/S로 항해되는지
- `window.__render3d` 토글로 기존 voxel과 비교
- `state.frameStats` / 프레임타임 EMA로 성능(20fps 유지/초과) 확인
- 시간가속(T/Y)·하늘보기(K)로 주야 전환 시 조명/별 정상 동작 확인

---

## 7. 미해결 (PoC 후 결정)

- 5×5 타일 스트리밍 시 메시 청크 재생성 + 거리별 LOD + antimeridian 래핑
- 뭉게구름 / 비·눈·뇌전 3D 이식 수준
- 미니맵 / HUD / 스카이맵(K)의 3D 환경 내 처리
- 기존 voxel 렌더러 최종 제거 시점
- 픽셀 도트와 lowpoly 패싯이 충돌하는지(들쭉날쭉한 에지) — 튜닝으로 조정

---

## 8. 리스크

| 리스크 | 대응 |
|---|---|
| 수직 스케일/투영 톤이 voxel과 달라 이질감 | `V_EXAG`·FOV·카메라 높이를 voxel 기준값으로 초기 세팅 후 튜닝 |
| 저해상도 픽셀 도트 + 폴리곤 에일리어싱 | `antialias:false` + 픽셀 스냅, 필요 시 약한 디더 |
| 번들 크기 증가(~63KB→수백 KB) | 배포 zip 영향만, 기능 무관. three 트리셰이킹 활용 |
| 타일 스트리밍 메시화 복잡도 | PoC 단계에선 정적 제주만 — 스트리밍은 검증 후 별도 |
