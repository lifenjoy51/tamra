// terrain-mesh.ts — lowpoly 지형 청크 매니저.
// altitude 링버퍼를 STRIDE 간격으로 샘플해 CHUNK×CHUNK(world px) 청크 메시를 만든다.
// 배 주변 camera.distance(2D 렌더 거리와 동일) 안의 청크만 유지하고, 매 프레임 가까운 것부터
// BUILD_PER_FRAME 개씩 증분 생성 — 통째 재생성(프레임 끊김 + 재중심 시 원경 팝인)을 피한다.
// 정점 공유(indexed) 격자 + 스무스 셰이딩 + 고도별 색 보간.
import * as THREE from 'three';
import { SEA, MASK, SHIFT, TILE_SIZE, BUF_TILES } from '../config';
import { camera as gcam } from '../state';
import { altitude, slotTiles } from '../tiles';
import { heightMeters } from '../terrain';
import { worldToScene, metersToSceneY, applyCurvature } from './coords';
import { terrainHeightM, coastDistM, SEA_FLOOR_M } from '../coast';

const STRIDE = 4;          // 원경 월드 px 샘플 간격 (1.6km)
// 근경 LOD: 배 근처 청크는 1 px(400m) 간격 — 원경 간격이면 해안선이 km 단위로 어긋나
// 배가 "보이지 않는 해안"에 막히거나 모래 비탈이 코앞에 벽처럼 선다.
const STRIDE_NEAR = 1;
const NEAR_DIST = 40;      // 배 ↔ 청크 최근접점 거리(world px, ~16km) 이내면 근경 LOD
const CHUNK = 64;          // 청크 한 변 (world px). TILE_SIZE(512) 약수 → 청크는 항상 타일 1개 안에 들어간다.
const BUILD_PER_FRAME = 8;
const NEAR_PER_FRAME = 1;

// 바다 정점 높이(m). altitude 는 바다를 SEA 로 평탄화해 수심 정보가 없다.
// 0m 로 두면 물 평면(파고 ±1.25m)과 같은 높이라 지형이 바다를 덮는다 — 물 아래로 내려
// 해안선을 가로지르는 삼각형만 수면과 교차하게 한다.
const SEA_FLOOR_Y = metersToSceneY(SEA_FLOOR_M);

// 팔레트 값은 sRGB 기준 — vertex color 는 linear 로 해석되므로 미리 변환해 둔다.
function srgb(r: number, g: number, b: number): [number, number, number] {
    var c = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
    return [c.r, c.g, c.b];
}
const COL_SAND = srgb(0.86, 0.80, 0.60);
const COL_LOW  = srgb(0.36, 0.58, 0.30);
const COL_HILL = srgb(0.27, 0.47, 0.24);
const COL_ROCK = srgb(0.42, 0.36, 0.28);
const COL_PEAK = srgb(0.55, 0.55, 0.56);
const COL_CLIFF = srgb(0.25, 0.23, 0.22);   // 해식 절벽 (제주 현무암)
// 격자 바다 꼭짓점 색 — 해안 삼각형에서 육지색과 보간된다. 순수 모래면 원경(1.6km 셀) 해안이 두꺼운 모래띠가 돼
// 저지대 초록과 반반 섞는다.
const COL_SHORE: [number, number, number] = [(COL_SAND[0] + COL_LOW[0]) / 2, (COL_SAND[1] + COL_LOW[1]) / 2, (COL_SAND[2] + COL_LOW[2]) / 2];

// 육지 고도(m, 해수면 위)별 양식화 팔레트 — 사진톤 colormap 미사용, 단순 lowpoly 톤.
// (바다 꼭짓점은 COL_SHORE — 포말색을 쓰면 셀 하나(1.6km) 폭으로 번져 눈 덮인 것처럼 보였다)
function paletteFor(hM: number): [number, number, number] {
    if (hM <= 1)    return COL_SAND;   // 모래(물가) — 그 위 저지대는 초록 (4m 까지 모래면 해안 평지 전체가 모래벌판)
    if (hM < 40)    return COL_LOW;    // 저지대 초록
    if (hM < 150)   return COL_HILL;   // 산지 초록(짙게)
    if (hM < 500)   return COL_ROCK;   // 암갈색
    return COL_PEAK;                   // 회색 봉우리
}

const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: false, // 스무스 셰이딩 — 고도 색 밴드만으로 스타일라이즈, 표면은 매끈하게
    roughness: 1.0,
    metalness: 0.0,
});
applyCurvature(material);

interface Chunk {
    mesh: THREE.Mesh | null; // 전부 바다면 null (그릴 삼각형 없음)
    tileKey: string | null;  // 생성 시점의 slotTiles 값 — 바뀌면(타일 늦게 로드/교체) 재생성
    sig: number;             // 생성 LOD·이음 변 (stride*16 + stitch) — 원하는 값과 다르면 재생성
    seen: number;            // 마지막으로 범위 안에 있던 프레임
}
const chunks = new Map<string, Chunk>();
let frameNo = 0;

function slotIdxOf(cx: number, cy: number): number {
    var tx = Math.floor(cx * CHUNK / TILE_SIZE), ty = Math.floor(cy * CHUNK / TILE_SIZE);
    // WORLD_TILES_X/Y 가 BUF_TILES 배수라 wrap 전/후 slot 동일 — 음수만 보정.
    var si = ((tx % BUF_TILES) + BUF_TILES) % BUF_TILES;
    var sj = ((ty % BUF_TILES) + BUF_TILES) % BUF_TILES;
    return sj * BUF_TILES + si;
}

function altAt(gx: number, gy: number): number {
    return altitude[((gy & MASK) << SHIFT) + (gx & MASK)];
}

function hAt(alt: number): number {
    return alt <= SEA ? SEA_FLOOR_Y : metersToSceneY(heightMeters[alt]);
}

// 청크 정점 + 테두리 1칸(법선 중앙차분용) 높이 샘플. 바다 = SEA_FLOOR_Y.
// stitch: 원경(STRIDE) 이웃과 맞닿은 변 비트(1 위, 2 아래, 4 왼, 8 오른). 그 변의 정점은 원경 격자 높이의
// 선형보간으로 맞춘다 — 이웃 원경 청크의 모서리와 정확히 같은 선이 되어 LOD 경계에 틈이 생기지 않는다.
// 근경(STRIDE_NEAR) 청크의 해안 셀(꼭짓점에 육지·바다 섞임)은 coast.ts terrainHeightM 으로 COAST_SUB 분할 —
// 셀 단위 비탈 대신 연속 해안선 + 절벽이 보이고, 배 충돌(coastDistM)과 같은 해안선이 된다.
// 해안 셀 테두리 높이는 인접 순수 육지/바다 셀의 직선 모서리와 일치해 틈이 없다.
function buildChunkMesh(cx: number, cy: number, stride: number, stitch: number): THREE.Mesh | null {
    var CELLS = CHUNK / stride, VERTS = CELLS + 1, H_N = VERTS + 2;
    var hBuf = new Float32Array(H_N * H_N);
    var seaBuf = new Uint8Array(H_N * H_N);
    var gx0 = cx * CHUNK, gy0 = cy * CHUNK;
    var anyLand = false;
    for (var j = 0; j < H_N; j++) {
        var gy = gy0 + (j - 1) * stride;
        for (var i = 0; i < H_N; i++) {
            var alt = altAt(gx0 + (i - 1) * stride, gy);
            var k = j * H_N + i;
            seaBuf[k] = alt <= SEA ? 1 : 0;
            hBuf[k] = hAt(alt);
            if (!seaBuf[k]) anyLand = true;
        }
    }
    if (!anyLand) return null;
    if (stitch) {
        for (var e = 0; e < VERTS; e++) {
            var off = e * stride, a = off - off % STRIDE, t = (off - a) / STRIDE;
            if (t === 0) continue;
            // 네 변: (e, 0) 위 / (e, CELLS) 아래 / (0, e) 왼 / (CELLS, e) 오른
            for (var side = 0; side < 4; side++) {
                if (!(stitch & (1 << side))) continue;
                var horiz = side < 2, fixed = (side & 1) ? CHUNK : 0;
                var ax = horiz ? gx0 + a : gx0 + fixed, ay = horiz ? gy0 + fixed : gy0 + a;
                var bx = horiz ? ax + STRIDE : ax, by = horiz ? ay : ay + STRIDE;
                var altA = altAt(ax, ay), altB = altAt(bx, by);
                var vxi = horiz ? e : (fixed / stride), vzi = horiz ? (fixed / stride) : e;
                var kk = (vzi + 1) * H_N + (vxi + 1);
                hBuf[kk] = hAt(altA) + (hAt(altB) - hAt(altA)) * t;
                seaBuf[kk] = (altA <= SEA && altB <= SEA) ? 1 : 0;
            }
        }
    }

    var positions: number[] = [], normals: number[] = [], colors: number[] = [];
    var p0 = worldToScene(gx0, gy0);
    for (var vz = 0; vz < VERTS; vz++) {
        for (var vx = 0; vx < VERTS; vx++) {
            var hk = (vz + 1) * H_N + (vx + 1);
            positions.push(p0.x + vx * stride, hBuf[hk], p0.z + vz * stride);
            // 높이장 y=f(x,z) 의 위쪽 법선 = (-fx, 1, -fz). 청크 밖 테두리 샘플을 써서 경계 이음매 없음.
            var nx = -(hBuf[hk + 1] - hBuf[hk - 1]) / (2 * stride);
            var nz = -(hBuf[hk + H_N] - hBuf[hk - H_N]) / (2 * stride);
            var inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
            normals.push(nx * inv, inv, nz * inv);
            var col = seaBuf[hk] ? COL_SHORE : paletteFor(heightMeters[altAt(gx0 + vx * stride, gy0 + vz * stride)]);
            colors.push(col[0], col[1], col[2]);
        }
    }

    var refine = stride === STRIDE_NEAR;
    var indices: number[] = [];
    for (var jz = 0; jz < CELLS; jz++) {
        for (var jx = 0; jx < CELLS; jx++) {
            var i00 = jz * VERTS + jx;
            var i10 = i00 + 1;
            var i01 = i00 + VERTS;
            var i11 = i01 + 1;
            // 네 꼭짓점이 모두 바다면 전부 수면 아래 — 그릴 필요 없음(삼각형 수 대폭 감소).
            var s = (jz + 1) * H_N + (jx + 1);
            var nSea = seaBuf[s] + seaBuf[s + 1] + seaBuf[s + H_N] + seaBuf[s + H_N + 1];
            if (nSea === 4) continue;
            var onStitch = (jz === 0 && (stitch & 1)) || (jz === CELLS - 1 && (stitch & 2)) ||
                           (jx === 0 && (stitch & 4)) || (jx === CELLS - 1 && (stitch & 8));
            if (refine && nSea > 0 && !onStitch) {
                addCoastCell(gx0 + jx, gy0 + jz, p0.x + jx, p0.z + jz, positions, normals, colors, indices);
                continue;
            }
            // 감기 순서: 위(+Y)에서 볼 때 CCW — (i00,i10,i01) 이면 (+x)×(+z) = -Y 로 법선이 아래를 향해
            // 앞면 컬링으로 가까운 사면이 빠지고 조명이 뒤집힌다.
            indices.push(i00, i01, i10, i10, i01, i11);
        }
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    return new THREE.Mesh(geo, material);
}

// 해안 셀 1개(월드 (gx, gy) ~ +1)를 COAST_SUB×COAST_SUB 로 분할해 추가. 높이·법선 모두 terrainHeightM.
const COAST_SUB = 16;          // 25m 간격 — 절벽 폭(25m)을 한두 칸에 담는다
const NRM_EPS = 0.01;          // 법선 차분 간격 (셀, 4m)
function sceneH(gx: number, gy: number): number {
    return metersToSceneY(terrainHeightM(gx, gy));
}
function addCoastCell(gx: number, gy: number, sx: number, sz: number,
                      positions: number[], normals: number[], colors: number[], indices: number[]) {
    var base = positions.length / 3, N = COAST_SUB, V = N + 1, d = 1 / N;
    for (var j = 0; j < V; j++) {
        for (var i = 0; i < V; i++) {
            var x = gx + i * d, y = gy + j * d;
            var hM = terrainHeightM(x, y);
            positions.push(sx + i * d, metersToSceneY(hM), sz + j * d);
            var nx = -(sceneH(x + NRM_EPS, y) - sceneH(x - NRM_EPS, y)) / (2 * NRM_EPS);
            var nz = -(sceneH(x, y + NRM_EPS) - sceneH(x, y - NRM_EPS)) / (2 * NRM_EPS);
            var inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
            normals.push(nx * inv, inv, nz * inv);
            // 가파른 면(법선 y < 0.8 ≈ 37° 이상)은 현무암 절벽색, 물가 띠(해안선 60m 이내·2.5m 이하)만 모래,
            // 나머지는 고도 팔레트(모래 구간은 저지대 초록으로) — 셀 폭 모래 비탈 대신 좁은 해변.
            var col = (inv < 0.8 && hM > 0.3) ? COL_CLIFF
                    : hM <= 2.5 && coastDistM(x, y) < 60 ? COL_SAND
                    : hM <= 1 ? COL_LOW : paletteFor(hM);
            colors.push(col[0], col[1], col[2]);
        }
    }
    for (var jz = 0; jz < N; jz++) {
        for (var jx = 0; jx < N; jx++) {
            var i00 = base + jz * V + jx, i10 = i00 + 1, i01 = i00 + V, i11 = i01 + 1;
            indices.push(i00, i01, i10, i10, i01, i11);
        }
    }
}

// 배 ↔ 청크 사각형 최근접점 거리로 LOD 결정
function wantStride(cx: number, cy: number, gx: number, gy: number): number {
    var dx = Math.max(0, Math.abs((cx + 0.5) * CHUNK - gx) - CHUNK / 2);
    var dy = Math.max(0, Math.abs((cy + 0.5) * CHUNK - gy) - CHUNK / 2);
    return dx * dx + dy * dy < NEAR_DIST * NEAR_DIST ? STRIDE_NEAR : STRIDE;
}

function disposeChunk(scene: THREE.Scene, c: Chunk) {
    if (!c.mesh) return;
    scene.remove(c.mesh);
    c.mesh.geometry.dispose();
    c.mesh = null;
}

// 매 프레임 호출. budget = 이번 프레임 최대 생성 청크 수 (init 시 Infinity 로 전부 생성).
export function updateTerrainChunks(scene: THREE.Scene, gx: number, gy: number, budget = BUILD_PER_FRAME) {
    frameNo++;
    var radius = gcam.distance;
    var reach = radius + CHUNK * 0.71; // 청크 중심 기준 반경 (대각 반폭 여유)
    var ccx = Math.floor(gx / CHUNK), ccy = Math.floor(gy / CHUNK);
    var r = Math.ceil(reach / CHUNK);
    var todo: { cx: number; cy: number; d2: number; key: string; slot: string | null; stride: number; stitch: number; sig: number }[] = [];

    for (var cy = ccy - r; cy <= ccy + r; cy++) {
        for (var cx = ccx - r; cx <= ccx + r; cx++) {
            var dx = (cx + 0.5) * CHUNK - gx, dy = (cy + 0.5) * CHUNK - gy;
            var d2 = dx * dx + dy * dy;
            if (d2 > reach * reach) continue;
            var key = cx + '_' + cy;
            var slot = slotTiles[slotIdxOf(cx, cy)];
            var c = chunks.get(key);
            var stride = wantStride(cx, cy, gx, gy);
            var stitch = 0;
            if (stride < STRIDE) {
                if (wantStride(cx, cy - 1, gx, gy) === STRIDE) stitch |= 1;
                if (wantStride(cx, cy + 1, gx, gy) === STRIDE) stitch |= 2;
                if (wantStride(cx - 1, cy, gx, gy) === STRIDE) stitch |= 4;
                if (wantStride(cx + 1, cy, gx, gy) === STRIDE) stitch |= 8;
            }
            var sig = stride * 16 + stitch;
            if (c) {
                c.seen = frameNo;
                if (c.tileKey === slot && c.sig === sig) continue;
            }
            todo.push({ cx, cy, d2, key, slot, stride, stitch, sig });
        }
    }

    // 범위를 벗어난 청크 제거 (범위 안 청크는 위 루프에서 seen 갱신됨 — 재생성 대기 중인 것 포함)
    chunks.forEach(function (c, key) {
        if (c.seen !== frameNo) {
            disposeChunk(scene, c);
            chunks.delete(key);
        }
    });

    todo.sort(function (a, b) { return a.d2 - b.d2; });
    // 근경 청크는 해안 셀 분할로 생성 비용이 수십 ms — 프레임당 1개로 제한해 끊김 방지 (init 은 무제한)
    var built = 0, nearBuilt = 0;
    for (var ti = 0; ti < todo.length && built < budget; ti++) {
        var t = todo[ti];
        if (t.stride === STRIDE_NEAR && budget !== Infinity) {
            if (nearBuilt >= NEAR_PER_FRAME) continue;
            nearBuilt++;
        }
        built++;
        var old = chunks.get(t.key);
        if (old) disposeChunk(scene, old);
        var mesh = buildChunkMesh(t.cx, t.cy, t.stride, t.stitch);
        if (mesh) scene.add(mesh);
        chunks.set(t.key, { mesh: mesh, tileKey: t.slot, sig: t.sig, seen: frameNo });
    }
}
