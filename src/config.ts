// --- Config ---
// 불변 상수만 포함. PX_SCALE(fitCanvas 재할당)와 TIME_SPEED(T/Y 재할당)는 main.ts/state.ts 에 유지.

export const SCR_W = 640;
export const SCR_H = 360;   // 16:9 internal
export const SEA = 64;      // 해수면 (0m = 출력값 64)

// 타일 시스템
export const TILE_SIZE = 512;
export const TILE_SHIFT = 9;                     // 2^9 = 512
export const WORLD_TILES_X = 176;                // tile_index.json grid.cols (176 % 8 == 0)
export const WORLD_TILES_Y = 88;                 //                  grid.rows ( 88 % 8 == 0)
export const WORLD_W = WORLD_TILES_X * TILE_SIZE; // 90112
export const WORLD_H = WORLD_TILES_Y * TILE_SIZE; // 45056

// 8x8 슬롯 버퍼 (4096x4096). 각 타일 (tx, ty) → 슬롯 (tx%8, ty%8)
// WORLD_TILES_X/Y 가 BUF_TILES 의 배수 → wrap 경계에서도 slot 충돌 없음 (antimeridian 자연 정합).
// 5x5 로드 범위(2.5 타일 = 1280)가 렌더 거리(800)보다 커야 뒤쪽 오래된 타일이 안 보임.
export const BUF_TILES = 8;
export const SHIFT = 12;                         // 2^12 = 4096
export const SIZE = 1 << SHIFT;
export const MASK = SIZE - 1;

// Geo 메타 (tile_index.json 일치) — 월드 픽셀 → 위/경도 변환용
export const ORIGIN_LON = -180;
export const ORIGIN_LAT = 90;
export const DEG_PER_PIXEL = 360 / WORLD_W;      // = 360/90112 ≈ 3.995e-3 deg/px

// 시간 가속 한계
export const TIME_SPEED_MIN = 1;
export const TIME_SPEED_MAX = 7200;

// --- 렌더 (voxel.ts) ---
// 한국 위도 기준 1 world unit = 400m → 곡률 계산
export const RENDER_UNIT_M = 400;
export const EARTH_RADIUS_M = 6371000;
// drop_m(z) = z² * RENDER_CURVATURE_COEFF
export const RENDER_CURVATURE_COEFF = (RENDER_UNIT_M * RENDER_UNIT_M) / (2 * EARTH_RADIUS_M);
// projScale = (SCR_H * RENDER_PROJ_SCALE) / z — 세로 해상도 비례 수직 FOV
export const RENDER_PROJ_SCALE = 0.0044;
// z 루프 초기값 및 step당 증분
export const RENDER_DELTAZ_INIT = 0.5;
export const RENDER_DELTAZ_STEP = 0.005;
// 파도 RGB 변조 배수 (sin 합 amp → 색 변조량)
export const RENDER_WAVE_COLOR_GAIN = 7;

// --- 효과 (effects.ts) ---
// 강수 파티클 바람 드리프트 계수 (px/frame per m/s)
export const PRECIP_DRIFT_COEFF = 0.18;
// 강수 낙하 속도 (px/frame)
export const PRECIP_FALL_SNOW = 1.2;
export const PRECIP_FALL_RAIN = 5.5;
// 안개 veil 시작 임계 (visibilityCoef 가 이 값 미만일 때 적용)
export const FOG_VIS_THRESHOLD = 0.7;
// 뇌전 트리거 cloudiness 임계
export const LIGHTNING_CLOUD_THRESHOLD = 0.85;
// 뇌전 확률: prob = (cloudiness - LIGHTNING_CLOUD_THRESHOLD) * SLOPE + BASE
export const LIGHTNING_PROB_SLOPE = 1.3;
export const LIGHTNING_PROB_BASE = 0.05;

// --- 날씨 (weather.ts) ---
// 일변화 (낮 대류) sine 위상 오프셋(시간) / 진폭
export const WEATHER_DIURNAL_PHASE_HOURS = 6;
export const WEATHER_DIURNAL_AMP = 0.08;
