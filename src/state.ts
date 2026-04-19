// state.ts — mutable 싱글톤 집결. zero-import 지향(순환 방지).
// 게임 전역 상태는 모두 여기서 출발. ESM 객체 export 는 참조 바인딩이므로
// 어떤 모듈에서 mutate 해도 모든 import 에 즉시 반영된다 (기존 var = {...} 의미론 동일).
//
// starState / planetState 는 STARS/PLANETS 테이블 크기 의존 → astronomy 모듈에서 초기화.

// --- Boat / Ship ---
// gx, gy 는 글로벌 월드 좌표 (0~WORLD_W). 시작 위치는 tile init 후 main.ts 에서 주입.
export const boat = { gx: 0, gy: 0, angle: Math.PI, sailUp: true };
// ship 속도 상태: sail 추진, ground(해류 합성), heading
export const ship = { sailMS: 0, groundMS: 0, groundDirRad: 0 };

// --- Camera (3인칭: 배 뒤에서 추적) ---
// camera.x, camera.y 는 글로벌 월드 좌표 (렌더 루프에서 & MASK 로 버퍼 위치 매핑)
export const camera = {
    x: 0, y: 0,
    heightMeters: 50,       // = BASE_CAM_METERS
    angle: 0.0,
    horizon: 180,
    distance: 800,
};

// --- Input ---
export const input = {
    forwardbackward: 0,
    leftright: 0,
};

// --- Wind (풍향) ---
// 0 = 북, π/2 = 동. 북동풍 = 45° 방향에서 오는 바람
// computeWind() 가 매 프레임 갱신
export const wind = { angleRad: Math.PI / 4, speedMS: 8 };

// --- Sail (돛 효율) ---
// boat.angle 과 wind.angleRad 의 상대각(AoA) → polar 계수
export const sail = { polar: 1.0, mode: 'BEAM', windFactor: 1.0 };

// --- Current (해류) ---
export const current = { angleRad: 0, speedMS: 0 };

// --- Wave ---
export const wave = {
    time: 0,
    // 큰 너울
    swell:  { dx: 0.10, dy: 0.08, speed: 1.0, amp: 2.5 },
    // 중간 파도
    mid:    { dx: 0.25, dy:-0.18, speed: 1.5, amp: 1.2 },
    // 잔물결
    ripple: { dx: 0.60, dy: 0.45, speed: 2.3, amp: 0.4 },
};

// --- Weather ---
export const weather = {
    cloudiness: 0.3,
    visibilityCoef: 1.0,
    precipitation: 0,
    precipType: 'rain' as 'rain' | 'snow',
};

// --- Sun ---
export const sun = {
    lat: 0, lon: 0,
    altDeg: 45, azDeg: 180,
    altRad: 0, azRad: 0,
    dayOfYear: 0, hourLocal: 12, month: 1, date: 1, year: 2000,
};

// --- Moon state ---
export const moonState = { altRad: 0, azRad: 0, phase: 0, illumination: 0 };

// --- 재할당 가능한 스칼라 wrapper ---
// ES 모듈은 `export let`을 외부에서 reassign 할 수 없으므로 객체 필드로 감싼다.
export const timeRef = {
    // 하지(6/21) 로컬 solar 정오 기준 (utcH = 12 - lon/15 ≈ 3.56 ⇒ 03:34 UTC)
    gameTime: Date.UTC(new Date().getUTCFullYear(), 5, 21, 3, 34, 0),
    // 시간 가속: 1초 실시간 = TIME_SPEED 초 게임시간. T/Y 키로 조절.
    TIME_SPEED: 120,
};

export const frameStats = {
    lastDrawTime: 0,
    fpsFrames: 0,
    fpsStart: 0,
    fpsCurrent: 0,
    // Frame time (EMA): Draw 한 번의 전체 소요 시간 (ms). 20fps cap 대기는 미포함.
    frameTimeEma: 0,
    // 이전 move/camera 물리 계산 시점 (Date.now() ms) — dtMs 계산용.
    // 0 이면 첫 프레임 거대한 dtMs → gameTime 폭주. 로드 시점으로 초기화.
    lastMoveTime: Date.now(),
};

// --- 물리/루프 상수 ---
export const BASE_SAIL_SPEED = 4;     // polar=1 · windFactor=1 기준 (풍속 8 m/s 빔리치) 4 m/s
export const BASE_CAM_METERS = 50;    // 기본 카메라 높이 (meters)
export const CAM_HEIGHT_MARGIN = 20;  // 카메라 아래 지형 있을 때 띄울 여유 (m)
export const FRAME_INTERVAL = 50;     // 1000/20 = 50ms (20fps cap)
export const FRAME_EPSILON = 8;       // rAF 지터 허용 (half-period)
