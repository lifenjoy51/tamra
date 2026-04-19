// planets.ts — Meeus J2000 평균 궤도요소 + Kepler Newton's method.
// 수금화목토천해 7개. EARTH 는 heliocentric 기준 좌표.

// --- 태양계 행성 (J2000 평균 궤도요소; Meeus-ch31 간이식) ---
// 반장반경 AU, 이심률, 궤도경사·승교점·근일점경도 (deg)
// L0: 평균경도, nd: 일일 평균운동 (deg/day)
// color: 맨눈 관측 색감에 가까운 파스텔 (채도 낮게)
export const PLANETS = [
    { n:'Mercury', L0:252.250906, nd:4.092353837, a:0.387098310, e:0.205634283, i:7.004986, Om: 48.330893, wbar: 77.456119, color:0xFFDEE5EA },
    { n:'Venus',   L0:181.979801, nd:1.602130374, a:0.723329820, e:0.006771882, i:3.394662, Om: 76.679920, wbar:131.563707, color:0xFFEEF4F8 },
    { n:'Mars',    L0:355.433000, nd:0.524033017, a:1.523679342, e:0.093392770, i:1.849726, Om: 49.558093, wbar:336.060234, color:0xFF90B4F0 },
    { n:'Jupiter', L0: 34.351519, nd:0.083091379, a:5.202603191, e:0.048494832, i:1.303270, Om:100.464407, wbar: 14.331207, color:0xFFD2EBFA },
    { n:'Saturn',  L0: 50.077444, nd:0.033459652, a:9.554909596, e:0.055508622, i:2.488878, Om:113.665503, wbar: 93.056787, color:0xFFB0E5F5 },
    { n:'Uranus',  L0:314.055005, nd:0.011731294, a:19.218446062, e:0.046381, i:0.773196, Om: 74.005947, wbar:173.005159, color:0xFFDEE8D8 },
    { n:'Neptune', L0:304.348665, nd:0.005981841, a:30.110386869, e:0.009456, i:1.769952, Om:131.784057, wbar: 48.123691, color:0xFFE0C8B8 },
];
export const EARTH = { L0:100.466449, nd:0.985609101, a:1.000000262, e:0.016708634, Om:0, wbar:102.937348, i:0 };

export const planetState = PLANETS.map(function() { return { altRad: 0, azRad: 0, mag: 0 }; });

export function heliocentric(el, Tdays) {
    var DEG = Math.PI / 180;
    var M = ((el.L0 + el.nd * Tdays - el.wbar) % 360) * DEG;
    // 뉴턴법 Kepler
    var E = M + el.e * Math.sin(M);
    for (var k = 0; k < 4; k++) {
        E = E - (E - el.e * Math.sin(E) - M) / (1 - el.e * Math.cos(E));
    }
    var xOrb = el.a * (Math.cos(E) - el.e);
    var yOrb = el.a * Math.sqrt(1 - el.e * el.e) * Math.sin(E);
    var w  = (el.wbar - el.Om) * DEG;
    var Om = el.Om * DEG;
    var iR = el.i * DEG;
    var cosW = Math.cos(w),  sinW = Math.sin(w);
    var cosO = Math.cos(Om), sinO = Math.sin(Om);
    var cosI = Math.cos(iR), sinI = Math.sin(iR);
    // 근일점 → 궤도평면 xy
    var x1 = cosW * xOrb - sinW * yOrb;
    var y1 = sinW * xOrb + cosW * yOrb;
    // 궤도평면 → 황도 평면 (경사)
    var x2 = x1;
    var y2 = y1 * cosI;
    var z2 = y1 * sinI;
    // 승교점 회전 → 황도 XYZ
    return {
        x: cosO * x2 - sinO * y2,
        y: sinO * x2 + cosO * y2,
        z: z2,
    };
}

export function updatePlanets(Tdays, gmstH, latRad, lonDeg) {
    var DEG = Math.PI / 180;
    var eps = 23.439281 * DEG;
    var eh = heliocentric(EARTH, Tdays);
    var lst = gmstH + lonDeg / 15;
    var sinLat = Math.sin(latRad), cosLat = Math.cos(latRad);
    for (var i = 0; i < PLANETS.length; i++) {
        var ph = heliocentric(PLANETS[i], Tdays);
        var X = ph.x - eh.x;
        var Y = ph.y - eh.y;
        var Z = ph.z - eh.z;
        var dist = Math.sqrt(X*X + Y*Y + Z*Z);
        // 황도 → 적도
        var Xe = X;
        var Ye = Y * Math.cos(eps) - Z * Math.sin(eps);
        var Ze = Y * Math.sin(eps) + Z * Math.cos(eps);
        var raRad = Math.atan2(Ye, Xe);
        if (raRad < 0) raRad += 2 * Math.PI;
        var decRad = Math.asin(Ze / dist);
        var raH = raRad * 12 / Math.PI;
        var H = (lst - raH) * 15 * DEG;
        var sinDec = Math.sin(decRad), cosDec = Math.cos(decRad);
        var sinH = Math.sin(H), cosH = Math.cos(H);
        var sinAlt = sinLat * sinDec + cosLat * cosDec * cosH;
        if (sinAlt > 1) sinAlt = 1; else if (sinAlt < -1) sinAlt = -1;
        planetState[i].altRad = Math.asin(sinAlt);
        var azRad = Math.atan2(-cosDec * sinH, sinDec * cosLat - cosDec * sinLat * cosH);
        if (azRad < 0) azRad += 2 * Math.PI;
        planetState[i].azRad = azRad;
        // 대략적 등급 (거리 기반 근사)
        planetState[i].mag = [
            -0.6, -4.2, -1.0, -2.5, 0.4, 5.7, 7.8,
        ][i];
    }
}
