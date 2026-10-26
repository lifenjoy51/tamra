// skymap.ts — K 토글: 천구 전체 polar azimuthal 뷰 (중심=천정, 위=배 방향).
// 시간 정지(uiFlags.skyMapOn)와 분리되어 있음 — 이 함수는 렌더만 담당.
// 낮엔 태양·하늘색, 밤엔 별·행성·달.
import { SCR_W, SCR_H } from '../config';
import { ctx } from '../canvas';
import { camera, sun, moonState, uiFlags } from '../state';
import { SKY_DAY_Z, SKY_DUSK_Z, SKY_NIGHT_Z } from '../sky';
import { STARS, starState, skyLimitMag, starVisual } from '../astronomy/stars';
import { PLANETS, planetState } from '../astronomy/planets';

export function DrawSkyMap() {
    if (!uiFlags.skyMapOn) return;
    var cx = SCR_W / 2;
    var cy = SCR_H / 2;
    var R = Math.min(SCR_W, SCR_H) / 2 - 14;

    // 하늘 색: 태양 고도 기반으로 낮·황혼·밤 blend (updateSky와 동일 규칙)
    var dayW   = (sun.altDeg - 5) / 10;     if (dayW < 0) dayW = 0;   else if (dayW > 1) dayW = 1;
    var nightW = (-6 - sun.altDeg) / 6;     if (nightW < 0) nightW = 0; else if (nightW > 1) nightW = 1;
    var duskW  = 1 - dayW - nightW;         if (duskW < 0) duskW = 0;
    var bR = SKY_DAY_Z[0]*dayW + SKY_DUSK_Z[0]*duskW + SKY_NIGHT_Z[0]*nightW;
    var bG = SKY_DAY_Z[1]*dayW + SKY_DUSK_Z[1]*duskW + SKY_NIGHT_Z[1]*nightW;
    var bB = SKY_DAY_Z[2]*dayW + SKY_DUSK_Z[2]*duskW + SKY_NIGHT_Z[2]*nightW;
    // 전체 배경 (원 밖 영역은 검정)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.96)';
    ctx.fillRect(0, 0, SCR_W, SCR_H);
    // 원반 (하늘)
    ctx.fillStyle = 'rgb(' + (bR|0) + ',' + (bG|0) + ',' + (bB|0) + ')';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

    // 태양 (altDeg > -2일 때)
    if (sun.altDeg > -2) {
        var sDlt = sun.azRad + camera.angle;
        var sR2 = (Math.PI / 2 - sun.altRad) / (Math.PI / 2) * R;
        var spx = cx + Math.sin(sDlt) * sR2;
        var spy = cy - Math.cos(sDlt) * sR2;
        var sunR, sunG, sunB;
        if (sun.altDeg > 15)      { sunR = 255; sunG = 245; sunB = 220; }
        else if (sun.altDeg > 0)  { sunR = 255; sunG = 190; sunB = 130; }
        else                       { sunR = 240; sunG = 130; sunB =  80; }
        // 후광
        var grad = ctx.createRadialGradient(spx, spy, 2, spx, spy, 24);
        grad.addColorStop(0, 'rgba(' + sunR + ',' + sunG + ',' + sunB + ',1)');
        grad.addColorStop(1, 'rgba(' + sunR + ',' + sunG + ',' + sunB + ',0)');
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(spx, spy, 24, 0, Math.PI * 2); ctx.fill();
        // 디스크
        ctx.fillStyle = 'rgb(' + sunR + ',' + sunG + ',' + sunB + ')';
        ctx.beginPath(); ctx.arc(spx, spy, 5, 0, Math.PI * 2); ctx.fill();
    }

    // 별 (밤 구간에서만, 낮엔 가시성 0)
    if (sun.altDeg < 0) {
        var lim = skyLimitMag();
        for (var si = 0; si < STARS.length; si++) {
            var star = STARS[si];
            var st = starState[si];
            if (st.altRad < 0) continue;
            var dlt = st.azRad + camera.angle;
            var r = (Math.PI / 2 - st.altRad) / (Math.PI / 2) * R;
            var px = cx + Math.sin(dlt) * r;
            var py = cy - Math.cos(dlt) * r;
            var mag = star.mag, size;
            var alpha = starVisual(mag, st.altRad, lim);
            if (alpha < 0.03) continue;
            if (alpha > 1) alpha = 1;
            if (mag < 0)      size = 1.5;
            else if (mag < 1) size = 1.25;
            else if (mag < 2) size = 1;
            else if (mag < 3) size = 0.75;
            else if (mag < 4) size = 0.6;
            else              size = 0.45;
            ctx.fillStyle = 'rgba(250, 250, 255, ' + alpha + ')';
            ctx.beginPath(); ctx.arc(px, py, size, 0, Math.PI * 2); ctx.fill();
        }
    }

    // 행성 (태양이 지평선 아래일 때만 표시 — 낮엔 태양빛에 묻혀 안 보임)
    if (sun.altDeg < 0) {
        for (var pi = 0; pi < PLANETS.length; pi++) {
            var ps = planetState[pi];
            if (ps.altRad < 0) continue;
            if (ps.mag > 6) continue;  // 천왕성/해왕성 맨눈 한계 넘음
            var dltp = ps.azRad + camera.angle;
            var rp = (Math.PI / 2 - ps.altRad) / (Math.PI / 2) * R;
            var ppx = cx + Math.sin(dltp) * rp;
            var ppy = cy - Math.cos(dltp) * rp;
            var col = PLANETS[pi].color;
            var cR = col & 0xFF, cG = (col >> 8) & 0xFF, cB = (col >> 16) & 0xFF;
            var psize = ps.mag < -3 ? 3 : ps.mag < 0 ? 2.5 : ps.mag < 2 ? 2 : 1.5;
            ctx.fillStyle = 'rgba(' + cR + ',' + cG + ',' + cB + ',0.95)';
            ctx.beginPath(); ctx.arc(ppx, ppy, psize, 0, Math.PI * 2); ctx.fill();
        }
    }

    // 달 (태양 지평선 아래일 때만 — 낮엔 태양빛에 묻혀 안 보임)
    if (moonState.altRad > 0 && sun.altDeg < 0) {
        var dlm = moonState.azRad + camera.angle;
        var rm = (Math.PI / 2 - moonState.altRad) / (Math.PI / 2) * R;
        var mmx = cx + Math.sin(dlm) * rm;
        var mmy = cy - Math.cos(dlm) * rm;
        var MR2 = 7;
        var ill2 = moonState.illumination;
        var side2 = Math.sin(moonState.phase) >= 0 ? 1 : -1;
        ctx.save();
        ctx.beginPath();
        ctx.arc(mmx, mmy, MR2, 0, Math.PI * 2);
        ctx.clip();
        // 어두운 면: 낮엔 배경 그대로, 밤엔 어두운 회색 반투명
        if (sun.altDeg < 0) {
            ctx.fillStyle = 'rgba(60, 65, 80, 0.75)';
            ctx.fillRect(mmx - MR2, mmy - MR2, MR2 * 2, MR2 * 2);
        }
        ctx.fillStyle = 'rgb(240, 245, 250)';
        if (ill2 >= 0.97) {
            ctx.fillRect(mmx - MR2, mmy - MR2, MR2 * 2, MR2 * 2);
        } else if (ill2 > 0.03) {
            var t = side2 * (1 - 2 * ill2) * MR2;
            if (side2 > 0) ctx.fillRect(mmx + t, mmy - MR2, MR2 - t, MR2 * 2);
            else           ctx.fillRect(mmx - MR2, mmy - MR2, MR2 + t, MR2 * 2);
        }
        ctx.restore();
    }

    // 배 방향 화살표 (화면 위쪽 = 배가 향한 곳)
    ctx.fillStyle = 'rgba(255, 230, 180, 0.8)';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('▲', cx, cy - R - 10);
}
