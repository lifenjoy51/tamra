// audio.ts — 절차생성 Web Audio (외부 asset 없음).
// 첫 키/포인터 제스처에서 resumeAudio() 호출 (iOS Safari suspended 대응).
// updateAudio() 는 메인 루프 말미 훅 — wind 기반 gain/cutoff smoothing.
// flapBurst() 는 돛 펼침 + RUN(펄럭) / IRONS(빠른 luff) 에서 랜덤 간격 burst. uiBlip 은 UI 변경 시 짧은 sine AD.
// 원샷: hullSlap(선체에 파도), creak(돛대·가로보 삐걱), oarSplash(노깃 입수 — boat3d 가 catch 시 호출),
// thunder(번개 뒤 지연 우르릉). 루프: waves / wind / rain(강수량 비례).
import { boat, sail, wind, weather } from './state';
import { lightningStrength } from './render/effects';

// 기본 master 레벨. 음소거 해제 시 이 값 × prefs.masterScale 가 인가됨.
const BASE_MASTER_GAIN = 0.3;

export const audio: any = {
    ctx: null, master: null, muted: false,
    waves: null, wavesGain: null, wavesFilter: null,
    wind: null, windGain: null, windFilter: null,
    rain: null, rainGain: null,
    noiseBuffer: null,
    // 사용자 튜닝 노브. 콘솔에서 window.__audioGain({master, wind, waves}) 로 조정.
    prefs: { masterScale: 1.0, windScale: 1.0, wavesScale: 1.0 },
};

try { audio.muted = localStorage.getItem('tamra_muted') === '1'; } catch (e) {}
try {
    var saved = JSON.parse(localStorage.getItem('tamra_audio_prefs') || '{}');
    if (typeof saved.masterScale === 'number') audio.prefs.masterScale = saved.masterScale;
    if (typeof saved.windScale === 'number')   audio.prefs.windScale = saved.windScale;
    if (typeof saved.wavesScale === 'number')  audio.prefs.wavesScale = saved.wavesScale;
} catch (e) {}

export function buildNoiseBuffer(ctx) {
    // ~4s white noise loop (pink-ish by lowpass on filter)
    var len = ctx.sampleRate * 4;
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    // pink noise via Voss-McCartney (간이)
    var b0=0,b1=0,b2=0;
    for (var i = 0; i < len; i++) {
        var w = Math.random() * 2 - 1;
        b0 = 0.997 * b0 + w * 0.029591;
        b1 = 0.985 * b1 + w * 0.032534;
        b2 = 0.950 * b2 + w * 0.048056;
        d[i] = (b0 + b1 + b2) * 0.3;
    }
    return buf;
}

export function initAudio() {
    if (audio.ctx) return;
    var AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    var ctx = new AC();
    var master = ctx.createGain();
    master.gain.value = audio.muted ? 0 : BASE_MASTER_GAIN * audio.prefs.masterScale;
    master.connect(ctx.destination);
    audio.noiseBuffer = buildNoiseBuffer(ctx);
    // Waves loop
    var waves = ctx.createBufferSource();
    waves.buffer = audio.noiseBuffer; waves.loop = true;
    var wf = ctx.createBiquadFilter();
    wf.type = 'lowpass'; wf.frequency.value = 300; wf.Q.value = 0.7;
    var wg = ctx.createGain(); wg.gain.value = 0.0;
    waves.connect(wf); wf.connect(wg); wg.connect(master); waves.start();
    // Wind loop
    var windSrc = ctx.createBufferSource();
    windSrc.buffer = audio.noiseBuffer; windSrc.loop = true;
    var wdf = ctx.createBiquadFilter();
    wdf.type = 'bandpass'; wdf.frequency.value = 600; wdf.Q.value = 3;
    var wdg = ctx.createGain(); wdg.gain.value = 0.0;
    windSrc.connect(wdf); wdf.connect(wdg); wdg.connect(master); windSrc.start();
    // Rain loop: 고역 노이즈 (빗방울 쏴아)
    var rainSrc = ctx.createBufferSource();
    rainSrc.buffer = audio.noiseBuffer; rainSrc.loop = true; rainSrc.playbackRate.value = 1.6;
    var rf = ctx.createBiquadFilter();
    rf.type = 'highpass'; rf.frequency.value = 1800; rf.Q.value = 0.5;
    var rg = ctx.createGain(); rg.gain.value = 0.0;
    rainSrc.connect(rf); rf.connect(rg); rg.connect(master); rainSrc.start();
    audio.rain = rainSrc; audio.rainGain = rg;
    audio.ctx = ctx; audio.master = master;
    audio.waves = waves; audio.wavesFilter = wf; audio.wavesGain = wg;
    audio.wind = windSrc; audio.windFilter = wdf; audio.windGain = wdg;
}

export function resumeAudio() {
    if (!audio.ctx) { initAudio(); return; }
    if (audio.ctx.state === 'suspended') audio.ctx.resume();
}

export function setMuted(m) {
    audio.muted = m;
    try { localStorage.setItem('tamra_muted', m ? '1' : '0'); } catch (e) {}
    if (audio.master) {
        var target = m ? 0 : BASE_MASTER_GAIN * audio.prefs.masterScale;
        audio.master.gain.setTargetAtTime(target, audio.ctx.currentTime, 0.05);
    }
}

// 콘솔에서 노브 조정. 인자 없이 호출하면 현재값 반환.
// ex) __audioGain({master: 0.5, wind: 2, waves: 0.7})
export function setAudioGain(opts) {
    if (opts && typeof opts === 'object') {
        if (typeof opts.master === 'number') audio.prefs.masterScale = opts.master;
        if (typeof opts.wind === 'number')   audio.prefs.windScale = opts.wind;
        if (typeof opts.waves === 'number')  audio.prefs.wavesScale = opts.waves;
        try { localStorage.setItem('tamra_audio_prefs', JSON.stringify(audio.prefs)); } catch (e) {}
        if (audio.master && !audio.muted) {
            audio.master.gain.setTargetAtTime(BASE_MASTER_GAIN * audio.prefs.masterScale, audio.ctx.currentTime, 0.05);
        }
    }
    return audio.prefs;
}

var lastFlapMs = -99999;
var nextSlapMs = 0, nextCreakMs = 0, prevFlash = 0;

export function updateAudio() {
    if (!audio.ctx) return;
    var t = audio.ctx.currentTime;
    // 파도: wind 기반(풍파) + 기본값. gain 0~0.35 × prefs
    var wg = Math.min(0.35, (wind.speedMS / 25) + 0.05) * audio.prefs.wavesScale;
    audio.wavesGain.gain.setTargetAtTime(wg, t, 0.3);
    audio.wavesFilter.frequency.setTargetAtTime(250 + wind.speedMS * 15, t, 0.3);
    // 바람 whistle: 풍속↑ → gain↑, 주파수↑
    var wdg = Math.min(0.18, Math.max(0, (wind.speedMS - 4) / 40)) * audio.prefs.windScale;
    audio.windGain.gain.setTargetAtTime(wdg, t, 0.3);
    audio.windFilter.frequency.setTargetAtTime(400 + wind.speedMS * 30, t, 0.3);
    // 비: 강수량 비례 (눈은 거의 무음)
    var rainG = weather.precipType === 'rain' ? weather.precipitation * 0.22 : weather.precipitation * 0.03;
    audio.rainGain.gain.setTargetAtTime(rainG, t, 0.5);
    // 돛 펄럭임: RUN(180° 근처)은 느린 burst, IRONS(맞바람)는 돛이 빠르게 luff
    var nowMs = performance.now();
    if (boat.sail > 0 && sail) {
        var irons = sail.mode === 'IRONS';
        if ((sail.mode === 'RUN' || irons) &&
            nowMs - lastFlapMs > (irons ? 250 + Math.random() * 450 : 1200 + Math.random() * 1800)) {
            lastFlapMs = nowMs;
            flapBurst(irons ? 0.09 : 0.15);
        }
    }
    // 선체에 부딪히는 파도: 바람 셀수록 자주·크게
    if (nowMs > nextSlapMs) {
        var wf = Math.min(1.5, wind.speedMS / 10);
        nextSlapMs = nowMs + (2600 - 1500 * Math.min(1, wf)) * (0.6 + Math.random() * 0.8);
        hullSlap(0.05 + 0.1 * wf);
    }
    // 삐걱임: 돛을 올렸거나 바람이 셀 때 드문드문
    if (nowMs > nextCreakMs) {
        nextCreakMs = nowMs + 4000 + Math.random() * 7000;
        var load = boat.sail * Math.min(1.5, wind.speedMS / 8) + (wind.speedMS > 10 ? 0.4 : 0);
        if (load > 0.2) creak(Math.min(0.08, 0.03 + 0.03 * load));
    }
    // 천둥: 번개 플래시 시작 순간 → 0.4~3.5s 뒤 우르릉 (거리감)
    var fl = lightningStrength();
    if (fl > 0 && prevFlash <= 0) thunder(0.4 + Math.random() * 3.1);
    prevFlash = fl;
}

function noiseShot(type: BiquadFilterType, freq: number, q: number, rate: number,
                   peak: number, attack: number, decay: number, delay: number) {
    var ctx = audio.ctx;
    var src = ctx.createBufferSource();
    src.buffer = audio.noiseBuffer; src.playbackRate.value = rate;
    var f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    var g = ctx.createGain();
    var t = ctx.currentTime + delay;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.001, t + attack + decay);
    src.connect(f); f.connect(g); g.connect(audio.master);
    src.start(t, Math.random() * 3);
    src.stop(t + attack + decay + 0.05);
    return f;
}

// 파도가 선체를 치는 '철썩' — 저역 노이즈, 짧은 attack
export function hullSlap(gain: number) {
    if (!audio.ctx) return;
    noiseShot('lowpass', 220 + Math.random() * 160, 1.2, 0.6, gain, 0.03, 0.35 + Math.random() * 0.25, 0);
}

// 노깃이 물에 들어가는 '첨벙'
export function oarSplash() {
    if (!audio.ctx) return;
    noiseShot('bandpass', 900 + Math.random() * 400, 0.9, 1.0, 0.07, 0.01, 0.22, 0);
}

// 돛대·가로보 나무 삐걱임 — 톱니파가 아래로 미끄러지며 bandpass
export function creak(gain: number) {
    if (!audio.ctx) return;
    var ctx = audio.ctx;
    var osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    var t = ctx.currentTime, dur = 0.35 + Math.random() * 0.4, f0 = 170 + Math.random() * 90;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.linearRampToValueAtTime(f0 * (0.7 + Math.random() * 0.15), t + dur);
    var bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 6;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.08);
    g.gain.linearRampToValueAtTime(gain * 0.6, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(bp); bp.connect(g); g.connect(audio.master);
    osc.start(t); osc.stop(t + dur + 0.05);
}

// 천둥: 아주 낮은 노이즈의 긴 우르릉. delay 초 뒤 (빛보다 늦게 도착)
export function thunder(delay: number) {
    if (!audio.ctx) return;
    var f = noiseShot('lowpass', 140, 0.8, 0.35, 0.32, 0.15, 2.8 + Math.random() * 1.5, delay);
    f.frequency.setTargetAtTime(70, audio.ctx.currentTime + delay + 0.3, 0.8);
}

export function flapBurst(peak = 0.15) {
    if (!audio.ctx) return;
    var ctx = audio.ctx;
    var src = ctx.createBufferSource();
    src.buffer = audio.noiseBuffer; src.loop = false;
    src.playbackRate.value = 0.7;
    var f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 800; f.Q.value = 1.5;
    var g = ctx.createGain();
    var t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    src.connect(f); f.connect(g); g.connect(audio.master);
    src.start(t, Math.random() * 2);
    src.stop(t + 0.3);
}

export function uiBlip(freq) {
    if (!audio.ctx) return;
    var ctx = audio.ctx;
    var osc = ctx.createOscillator();
    osc.type = 'sine'; osc.frequency.value = freq;
    var g = ctx.createGain();
    var t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    osc.connect(g); g.connect(audio.master);
    osc.start(t); osc.stop(t + 0.1);
}
