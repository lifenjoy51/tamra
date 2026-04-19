// moon.ts — 달 위치·위상 (Meeus 간이식).
// λ/β 6-term + 4-term → RA/Dec → alt/az, phase = D % 2π.
import { moonState } from '../state';

export function updateMoon(Tdays, gmstH, latRad, lonDeg) {
    var DEG = Math.PI / 180;
    var T = Tdays / 36525;
    var Lp = (218.3164477 + 481267.88123421 * T) * DEG;
    var D  = (297.8501921 + 445267.1114034 * T) * DEG;
    var M  = (357.5291092 +  35999.0502909 * T) * DEG;
    var Mp = (134.9633964 + 477198.8675055 * T) * DEG;
    var F  = ( 93.2720950 + 483202.0175233 * T) * DEG;
    var lambda = Lp
        + 6.289 * DEG * Math.sin(Mp)
        - 1.274 * DEG * Math.sin(Mp - 2 * D)
        + 0.658 * DEG * Math.sin(2 * D)
        + 0.214 * DEG * Math.sin(2 * Mp)
        - 0.186 * DEG * Math.sin(M)
        - 0.114 * DEG * Math.sin(2 * F);
    var beta = 5.128 * DEG * Math.sin(F)
        + 0.281 * DEG * Math.sin(Mp + F)
        - 0.278 * DEG * Math.sin(F - Mp)
        - 0.173 * DEG * Math.sin(F - 2 * D);
    var eps = 23.439281 * DEG;
    var cosL = Math.cos(lambda), sinL = Math.sin(lambda);
    var cosB = Math.cos(beta), sinB = Math.sin(beta);
    var x = cosL * cosB;
    var y = sinL * cosB * Math.cos(eps) - sinB * Math.sin(eps);
    var z = sinL * cosB * Math.sin(eps) + sinB * Math.cos(eps);
    var raRad = Math.atan2(y, x);
    if (raRad < 0) raRad += 2 * Math.PI;
    var decRad = Math.asin(z);
    var raH = raRad * 12 / Math.PI;
    var lst = gmstH + lonDeg / 15;
    var H = (lst - raH) * 15 * DEG;
    var sinLat = Math.sin(latRad), cosLat = Math.cos(latRad);
    var sinDec = Math.sin(decRad), cosDec = Math.cos(decRad);
    var sinH = Math.sin(H), cosH = Math.cos(H);
    var sinAlt = sinLat * sinDec + cosLat * cosDec * cosH;
    if (sinAlt > 1) sinAlt = 1; else if (sinAlt < -1) sinAlt = -1;
    moonState.altRad = Math.asin(sinAlt);
    var azRad = Math.atan2(-cosDec * sinH, sinDec * cosLat - cosDec * sinLat * cosH);
    if (azRad < 0) azRad += 2 * Math.PI;
    moonState.azRad = azRad;
    var phaseRad = (D) % (2 * Math.PI);
    if (phaseRad < 0) phaseRad += 2 * Math.PI;
    moonState.phase = phaseRad;
    moonState.illumination = (1 - Math.cos(phaseRad)) / 2;
}
