// audio.ts — 절차생성 Web Audio (외부 asset 없음).
// 첫 키/포인터 제스처에서 resumeAudio() 호출 (iOS Safari suspended 대응).
// updateAudio() 는 메인 루프 말미 훅 — wind 기반 gain/cutoff smoothing.
// flapBurst() 는 돛 펼침 + RUN mode 에서 랜덤 간격 burst. uiBlip 은 UI 변경 시 짧은 sine AD.
import { boat, sail, wind } from './state';

// 기본 master 레벨. 음소거 해제 시 이 값 × prefs.masterScale 가 인가됨.
const BASE_MASTER_GAIN = 0.3;

export const audio: any = {
    ctx: null, master: null, muted: false,
    waves: null, wavesGain: null, wavesFilter: null,
    wind: null, windGain: null, windFilter: null,
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
    // 돛 펄럭임: 돛 올리고 + AoA가 RUN(180° 근처)일 때 burst
    var sailActive = boat.sail > 0 && sail && sail.mode === 'RUN';
    var nowMs = performance.now();
    if (sailActive && nowMs - lastFlapMs > 1200 + Math.random() * 1800) {
        lastFlapMs = nowMs;
        flapBurst();
    }
}

export function flapBurst() {
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
    g.gain.linearRampToValueAtTime(0.15, t + 0.02);
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
