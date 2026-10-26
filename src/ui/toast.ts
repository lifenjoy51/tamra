// toast.ts — 화면 위 가운데 한두 줄 관찰 알림 (예: 납추 측심 결과). 몇 초 뒤 사라진다.
let el: HTMLElement | null = null;
let timer = 0;

export function showToast(text: string, ms = 5000) {
    if (!el) el = document.getElementById('toast');
    if (!el) return;
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(timer);
    timer = window.setTimeout(function () { el!.classList.remove('on'); }, ms);
}
