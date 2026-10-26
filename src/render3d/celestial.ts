// celestial.ts — 태양광(DirectionalLight)+AmbientLight, 별/행성(Points), 달(빌보드 스프라이트).
// altRad/azRad → 방향벡터: 기존 2D 규약과 동일하게 (x,z) = (sin(az)*cos(alt), -cos(az)*cos(alt)),
// y = sin(alt). (az: 0=북, 시계방향 증가 — boat.angle/wind 와 동일 좌표계)
import * as THREE from 'three';
import { sun, moonState, weather } from '../state';
import { STARS, starState, skyLimitMag, starVisual, starTint } from '../astronomy/stars';
import { PLANETS, planetState } from '../astronomy/planets';

const SKY_R = 1800;
const SUN_HIGH = new THREE.Color(0xfff2d8), SUN_LOW = new THREE.Color(0xff9a50);
const MOON_LIGHT = new THREE.Color(0xa8bcd8);
const AMB_CLEAR = new THREE.Color(0x8899aa), AMB_CLOUD = new THREE.Color(0x9a9ea4);

export function dirFromAltAz(altRad: number, azRad: number): THREE.Vector3 {
    var ca = Math.cos(altRad);
    return new THREE.Vector3(
        Math.sin(azRad) * ca,
        Math.sin(altRad),
        -Math.cos(azRad) * ca,
    );
}

// 등급별 점 크기 버킷 (PointsMaterial 은 크기 하나) — 밝은 별 4px, 중간 3px, 희미한 별 2px
interface StarBucket { points: THREE.Points; idx: Int32Array; }
const STAR_BUCKETS = [{ maxMag: 1.5, size: 4 }, { maxMag: 3.5, size: 3 }, { maxMag: 99, size: 2 }];
const tint = [1, 1, 1];

export interface CelestialRig {
    sunLight: THREE.DirectionalLight;
    ambient: THREE.AmbientLight;
    sunSprite: THREE.Sprite;
    moonSprite: THREE.Sprite;
    starBuckets: StarBucket[];
    planetPoints: THREE.Points;
}

function circleTexture(color: string): THREE.Texture {
    var c = document.createElement('canvas');
    c.width = c.height = 32;
    var ctx = c.getContext('2d')!;
    var grad = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, color);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 32, 32);
    var tex = new THREE.CanvasTexture(c);
    return tex;
}

export function buildCelestialRig(scene: THREE.Scene): CelestialRig {
    var sunLight = new THREE.DirectionalLight(0xfff2d8, 1.2);
    scene.add(sunLight);
    scene.add(sunLight.target);

    var ambient = new THREE.AmbientLight(0x8899aa, 0.5);
    scene.add(ambient);

    var sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: circleTexture('rgba(255,245,220,1)'), transparent: true, depthWrite: false, fog: false,
    }));
    sunSprite.scale.set(120, 120, 1);
    scene.add(sunSprite);

    var moonSprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: circleTexture('rgba(232,240,244,1)'), transparent: true, depthWrite: false, fog: false,
    }));
    moonSprite.scale.set(60, 60, 1);
    scene.add(moonSprite);

    var starBuckets: StarBucket[] = [];
    var lo = -99;
    for (var bi = 0; bi < STAR_BUCKETS.length; bi++) {
        var bk = STAR_BUCKETS[bi], ids: number[] = [];
        for (var si = 0; si < STARS.length; si++) if (STARS[si].mag > lo && STARS[si].mag <= bk.maxMag) ids.push(si);
        lo = bk.maxMag;
        var starGeo = new THREE.BufferGeometry();
        starGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(ids.length * 3), 3));
        starGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(ids.length * 3), 3));
        // fog: false — 천구 반경(SKY_R=1800)이 Fog far(1900) 근처라 fog 적용 시 수평선색에 묻혀 안 보인다.
        var starMat = new THREE.PointsMaterial({ size: bk.size, vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: false, fog: false });
        var pts = new THREE.Points(starGeo, starMat);
        pts.frustumCulled = false;
        scene.add(pts);
        starBuckets.push({ points: pts, idx: Int32Array.from(ids) });
    }

    var planetGeo = new THREE.BufferGeometry();
    planetGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(PLANETS.length * 3), 3));
    planetGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(PLANETS.length * 3), 3));
    var planetMat = new THREE.PointsMaterial({ size: 6, vertexColors: true, transparent: true, depthWrite: false, sizeAttenuation: false, fog: false });
    var planetPoints = new THREE.Points(planetGeo, planetMat);
    scene.add(planetPoints);

    return { sunLight, ambient, sunSprite, moonSprite, starBuckets, planetPoints };
}

export function updateCelestialRig(rig: CelestialRig, camPos: THREE.Vector3) {
    var sunAlt = sun.altRad, sunAz = sun.azRad;
    var sunDir = dirFromAltAz(sunAlt, sunAz);
    var night = sun.altDeg < 0;

    // 태양광: 고도<0 이면 거의 소등(달빛 수준 ambient 만)
    // three r155+ 는 물리 단위 조명(Lambert 1/π 포함) — legacy 강도값에 π 를 곱해야 같은 밝기.
    // 흐림: 직사광 감쇠 + 하늘 산란(ambient) 증가·회색화. 저고도 태양은 주황빛.
    var dayT = (sun.altDeg + 6) / 20; if (dayT < 0) dayT = 0; else if (dayT > 1) dayT = 1;
    var cloud = weather.cloudiness;
    var lightDir = sunDir;
    if (sun.altDeg > -2) {
        var warm = 1 - sun.altDeg / 25; if (warm < 0) warm = 0; else if (warm > 1) warm = 1;
        rig.sunLight.color.copy(SUN_HIGH).lerp(SUN_LOW, warm);
        rig.sunLight.intensity = (0.15 + 1.05 * dayT) * (1 - 0.75 * cloud) * Math.PI;
    } else if (moonState.altRad > 0) {
        // 밤: 직사광 = 달빛 (위상 비례, 푸른 기). 태양이 지평선 아래에서 수면을 밑에서 비추지 않게.
        lightDir = dirFromAltAz(moonState.altRad, moonState.azRad);
        rig.sunLight.color.copy(MOON_LIGHT);
        rig.sunLight.intensity = 0.35 * moonState.illumination * (1 - 0.8 * cloud) * Math.PI;
    } else {
        rig.sunLight.intensity = 0;
    }
    rig.sunLight.position.copy(camPos).addScaledVector(lightDir, 500);
    rig.sunLight.target.position.copy(camPos);
    // 밤 ambient 는 낮게 — 달빛(직사광)·등불이 드러나고 바다가 하늘보다 밝게 뜨지 않게. 낮(dayT=1)은 0.6 그대로.
    rig.ambient.intensity = (0.12 + 0.48 * dayT) * (1 + 0.45 * cloud) * Math.PI;
    rig.ambient.color.copy(AMB_CLEAR).lerp(AMB_CLOUD, cloud);

    rig.sunSprite.visible = sun.altDeg > -3;
    rig.sunSprite.position.copy(camPos).addScaledVector(sunDir, SKY_R);

    if (moonState.altRad > 0 && night) {
        rig.moonSprite.visible = true;
        var moonDir = dirFromAltAz(moonState.altRad, moonState.azRad);
        rig.moonSprite.position.copy(camPos).addScaledVector(moonDir, SKY_R);
    } else {
        rig.moonSprite.visible = false;
    }

    var lim = skyLimitMag();
    var starVis = night && lim > -1;
    for (var bi = 0; bi < rig.starBuckets.length; bi++) {
        var bk = rig.starBuckets[bi];
        bk.points.visible = starVis;
        if (!starVis) continue;
        var starPos = bk.points.geometry.attributes.position as THREE.BufferAttribute;
        var starCol = bk.points.geometry.attributes.color as THREE.BufferAttribute;
        for (var k = 0; k < bk.idx.length; k++) {
            var i = bk.idx[k], st = starState[i];
            var ca = Math.cos(st.altRad);
            starPos.setXYZ(k, camPos.x + Math.sin(st.azRad) * ca * SKY_R, camPos.y + Math.sin(st.altRad) * SKY_R, camPos.z - Math.cos(st.azRad) * ca * SKY_R);
            var vis = starVisual(STARS[i].mag, st.altRad, lim);
            starTint(STARS[i].bv, tint);
            starCol.setXYZ(k, vis * tint[0], vis * tint[1], vis * tint[2]);
        }
        starPos.needsUpdate = true;
        starCol.needsUpdate = true;
    }

    var planetPos = rig.planetPoints.geometry.attributes.position as THREE.BufferAttribute;
    var planetCol = rig.planetPoints.geometry.attributes.color as THREE.BufferAttribute;
    rig.planetPoints.visible = night;
    if (night) {
        for (var pi = 0; pi < PLANETS.length; pi++) {
            var ps = planetState[pi];
            var dp = dirFromAltAz(ps.altRad, ps.azRad);
            planetPos.setXYZ(pi, camPos.x + dp.x * SKY_R, camPos.y + dp.y * SKY_R, camPos.z + dp.z * SKY_R);
            var pc = PLANETS[pi].color;
            var pr = (pc & 0xFF) / 255, pg = ((pc >> 8) & 0xFF) / 255, pb = ((pc >> 16) & 0xFF) / 255;
            var pvis = ps.altRad > 0 && ps.mag < 6 ? 1 : 0;
            planetCol.setXYZ(pi, pr * pvis, pg * pvis, pb * pvis);
        }
        planetPos.needsUpdate = true;
        planetCol.needsUpdate = true;
    }
}
