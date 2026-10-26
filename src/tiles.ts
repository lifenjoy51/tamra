// tiles.ts — 타일 시스템 (글로벌 좌표 + 8x8 링 버퍼).
// tile (tx, ty) → slot (tx%8, ty%8). 글로벌 좌표 & MASK = 버퍼 위치.
// tile_index.json 이 source of truth: 없는 타일은 순수 바다로 flat fill.

import {
    SEA, TILE_SIZE, WORLD_TILES_X, WORLD_TILES_Y, BUF_TILES, SIZE,
} from './config';
import { boat } from './state';
import { generateColormap } from './terrain';

// 4096x4096 링 버퍼. 기본값 바다로 초기화.
export const altitude = new Uint8Array(SIZE * SIZE);
export const colormap = new Uint32Array(SIZE * SIZE);
// 수심: 원본 고도 바이트(≤ SEA, 육지는 SEA). altitude 는 바다를 SEA 로 평탄화하므로 따로 보관 — 조류 세기·측심용.
// 파일 없는 순수 바다 타일은 DEEP_U8(≈ -4400m).
export const depthU8 = new Uint8Array(SIZE * SIZE);
const DEEP_U8 = 12;
altitude.fill(SEA);

// 슬롯별 현재 로드된 tile key (tx_ty) — 중복 로드 방지
export const slotTiles: (string | null)[] = new Array(BUF_TILES * BUF_TILES).fill(null);
const loadingTiles: { [key: string]: Promise<void> } = {};
let tileIndex: any = null;

// PNG 디코딩용 임시 캔버스
let tmpC: HTMLCanvasElement;
let tmpCtx: CanvasRenderingContext2D;

export function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise(function(resolve, reject) {
        var img = new Image();
        img.onload = function() { resolve(img); };
        img.onerror = reject;
        img.src = src;
    });
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

// 타일 하나를 슬롯에 로드 (async). 이미 로드 중/완료면 스킵.
export async function loadTile(tx: number, ty: number): Promise<void> {
    // 경도 wrap, 위도 clamp
    tx = ((tx % WORLD_TILES_X) + WORLD_TILES_X) % WORLD_TILES_X;
    if (ty < 0 || ty >= WORLD_TILES_Y) return;

    var key = tx + '_' + ty;
    var slotI = tx % BUF_TILES;
    var slotJ = ty % BUF_TILES;
    var slotIdx = slotJ * BUF_TILES + slotI;

    if (slotTiles[slotIdx] === key) return;       // 이미 로드됨
    if (loadingTiles[key]) return loadingTiles[key]; // 로딩 중

    var promise = (async function() {
        // slot 을 먼저 flat sea 로 비움 (sync 구간) — WebP 로드 대기 중 이전 tile 데이터가
        // 렌더에 노출되는 것을 차단. antimeridian 크로스 시 slot 주인이 바뀌는 순간
        // 엉뚱한 지형이 스쳐 보이던 현상(전환 이상)을 방지.
        var preBx0 = slotI * TILE_SIZE;
        var preBy0 = slotJ * TILE_SIZE;
        for (var pry = 0; pry < TILE_SIZE; pry++) {
            var rowStart = (preBy0 + pry) * SIZE + preBx0;
            altitude.fill(SEA, rowStart, rowStart + TILE_SIZE);
        }
        slotTiles[slotIdx] = null;

        var heightRaw = new Uint8Array(TILE_SIZE * TILE_SIZE);
        var hasFile = tileIndex && tileIndex.tiles && tileIndex.tiles[key];

        if (hasFile) {
            try {
                var img = await loadImage('tiles/h_' + pad2(tx) + '_' + pad2(ty) + '.webp');
                tmpCtx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
                tmpCtx.drawImage(img, 0, 0);
                var data = tmpCtx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
                for (var i = 0; i < TILE_SIZE * TILE_SIZE; i++) heightRaw[i] = data[i * 4];
            } catch (e) {
                heightRaw.fill(SEA); // 로드 실패 시 바다
            }
        } else {
            heightRaw.fill(SEA); // 인덱스에 없음 = 순수 바다
        }

        // 슬롯에 쓰기 (altitude + colormap)
        var tileCmap = generateColormap(heightRaw, TILE_SIZE, TILE_SIZE, tx, ty);
        var bx0 = slotI * TILE_SIZE;
        var by0 = slotJ * TILE_SIZE;
        for (var ly = 0; ly < TILE_SIZE; ly++) {
            var src = ly * TILE_SIZE;
            var dst = (by0 + ly) * SIZE + bx0;
            for (var lx = 0; lx < TILE_SIZE; lx++) {
                var h = heightRaw[src + lx];
                altitude[dst + lx] = h <= SEA ? SEA : h;
                depthU8[dst + lx] = h <= SEA ? (hasFile ? h : DEEP_U8) : SEA;
                colormap[dst + lx] = tileCmap[src + lx];
            }
        }
        slotTiles[slotIdx] = key;
        delete loadingTiles[key];
    })();

    loadingTiles[key] = promise;
    return promise;
}

// 현재 보트 위치 기준 5x5 타일 로드 (렌더 거리 800 커버).
// WORLD_TILES_X/Y 가 BUF_TILES 배수(176/88) 이므로 slot 충돌 없음 — 단순 5x5 로드 충분.
// (이전 169×85 체제에서는 169%8=1 로 antimeridian 근처 slot col 공유 경쟁 → collision resolver 필요했음.
//  업스케일 후 이슈 구조적으로 소멸.)
export function ensureTilesLoaded() {
    var ctx = Math.floor(boat.gx / TILE_SIZE);
    var cty = Math.floor(boat.gy / TILE_SIZE);
    for (var dy = -2; dy <= 2; dy++) {
        for (var dx = -2; dx <= 2; dx++) {
            loadTile(ctx + dx, cty + dy);
        }
    }
}

// 초기화: tile_index.json + 임시 캔버스 준비 + 시작 위치 주변 5x5 동기 로드.
// 반환: { startGx, startGy, startAngle } (main.ts 에서 boat/camera 초기 위치/방위로 사용)
export async function initTiles(): Promise<{ startGx: number; startGy: number; startAngle: number }> {
    var idxRes = await fetch('tiles/tile_index.json');
    tileIndex = await idxRes.json();

    tmpC = document.createElement('canvas');
    tmpC.width = TILE_SIZE;
    tmpC.height = TILE_SIZE;
    tmpCtx = tmpC.getContext('2d')!;

    // 기본 시작지점: 제주도 남쪽 바다, 북쪽(제주) 바라보기 고정.
    // (tx=149, ty=27 부근 — lat≈32.8°N, lon≈126.55°E, ORIGIN_LON/LAT+DEG_PER_PIXEL 역산.)
    // URL 파라미터 ?tile=tx,ty 로 다른 타일 강제 지정 가능(디버그/재현용).
    var startTx = 149, startTy = 27; // 폴백
    var startGx = 149 * TILE_SIZE + 256, startGy = 27 * TILE_SIZE + 256;
    var startAngle = 0; // 0 = 북쪽 — moveBoat 전진 시 gy 감소(북상) 방향과 일치
    var tileParam = new URLSearchParams(location.search).get('tile');
    var forced: [number, number] | null = null;
    if (tileParam) {
        var m = tileParam.match(/^(\d+),(\d+)$/);
        if (m) forced = [+m[1], +m[2]];
    }
    // 후보 타일: forced 지정 시 그것만, 아니면 제주 남쪽 바다 우선 순으로 순차 시도(랜덤 없음).
    var candidates: [number, number][] = forced
        ? [forced]
        : [[149, 27], [149, 28], [150, 27], [148, 27], [149, 26], [143, 30]];

    for (var attempt = 0; attempt < candidates.length; attempt++) {
        var tx = candidates[attempt][0], ty = candidates[attempt][1];
        await loadTile(tx, ty);
        var slotI = tx % BUF_TILES, slotJ = ty % BUF_TILES;
        var bx0 = slotI * TILE_SIZE, by0 = slotJ * TILE_SIZE;
        // 시작 셀 후보 수집:
        //   (1) 자신은 바다, (2) 3x3 이웃 모두 바다 (moveBoat shore buffer 와 정합 → 첫 프레임에 갇히지 않음),
        //   (3) 9x9 이웃에 육지 존재 (해안에서 네 칸 이내 = "해안 근방 바다"),
        //   (4) 육지가 북쪽(작은 y)에 있어야 함 — "남쪽 바다에서 북쪽을 바라본다" 요구사항.
        // 9x9 범위 → offset -4 ~ +4. ly/lx 시작/끝 버퍼 4 로 맞춤.
        var coastLx: number[] = [], coastLy: number[] = [];
        for (var ly = 4; ly < TILE_SIZE - 4; ly += 2) {
            for (var lx = 4; lx < TILE_SIZE - 4; lx += 2) {
                var idx = (by0 + ly) * SIZE + (bx0 + lx);
                if (altitude[idx] > SEA) continue;
                var safe3 = true;
                for (var nj = -1; nj <= 1 && safe3; nj++) {
                    for (var ni = -1; ni <= 1; ni++) {
                        if (altitude[(by0 + ly + nj) * SIZE + (bx0 + lx + ni)] > SEA) {
                            safe3 = false; break;
                        }
                    }
                }
                if (!safe3) continue;
                var sySum = 0, landCnt = 0;
                for (var nj2 = -4; nj2 <= 4; nj2++) {
                    for (var ni2 = -4; ni2 <= 4; ni2++) {
                        if (altitude[(by0 + ly + nj2) * SIZE + (bx0 + lx + ni2)] > SEA) {
                            sySum += nj2; landCnt++;
                        }
                    }
                }
                if (landCnt === 0) continue; // 해안 아님(깊은 바다) → 제외
                if (sySum >= 0) continue;    // 육지가 북쪽(음수 offset)에 있는 지점만 채택
                coastLx.push(lx); coastLy.push(ly);
            }
        }
        if (coastLx.length > 0) {
            // 가장 남쪽(ly 최대) 후보 선택 — 이 지점은 "해안에서 4칸 이내"라 배가 북쪽으로
            // 돛을 올리자마자 3x3 shore buffer 에 바로 걸려 멈춰버린다(moveBoat 첫 서브스텝에서 blocked).
            // 항해할 공간을 확보하기 위해 이 앵커에서 남쪽으로 더 밀어낸 지점을 실제 시작점으로 쓴다.
            var bestI = 0;
            for (var ci = 1; ci < coastLy.length; ci++) {
                if (coastLy[ci] > coastLy[bestI]) bestI = ci;
            }
            var anchorLx = coastLx[bestI], anchorLy = coastLy[bestI];
            var pickedLy = anchorLy;
            var southOffsets = [60, 45, 30, 15, 0]; // world px (60 ≈ 24km 여유)
            for (var oi = 0; oi < southOffsets.length; oi++) {
                var candLy = anchorLy + southOffsets[oi];
                if (candLy > TILE_SIZE - 8) candLy = TILE_SIZE - 8; // 로드된 타일 범위 안에 고정
                var safeOff = true;
                for (var noj = -1; noj <= 1 && safeOff; noj++) {
                    for (var noi = -1; noi <= 1; noi++) {
                        if (altitude[(by0 + candLy + noj) * SIZE + (bx0 + anchorLx + noi)] > SEA) {
                            safeOff = false; break;
                        }
                    }
                }
                if (safeOff) { pickedLy = candLy; break; }
            }
            startTx = tx; startTy = ty;
            startGx = tx * TILE_SIZE + anchorLx;
            startGy = ty * TILE_SIZE + pickedLy;
            startAngle = 0; // 북쪽 고정
            break;
        }
        if (forced) {
            // 해안 셀 없어도 지정 타일 중심 사용
            startTx = tx; startTy = ty;
            startGx = tx * TILE_SIZE + TILE_SIZE / 2;
            startGy = ty * TILE_SIZE + TILE_SIZE / 2;
            startAngle = 0;
        }
    }
    var initPromises: Promise<void>[] = [];
    for (var dy = -2; dy <= 2; dy++) {
        for (var dx = -2; dx <= 2; dx++) {
            initPromises.push(loadTile(startTx + dx, startTy + dy) as Promise<void>);
        }
    }
    await Promise.all(initPromises);

    return { startGx, startGy, startAngle };
}
