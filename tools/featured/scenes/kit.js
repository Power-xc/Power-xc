// 결정적 타임라인: 화면 상태는 전부 render(t)의 t(ms)로만 정한다.
(function () {
  const q = new URLSearchParams(location.search);
  document.documentElement.dataset.theme = q.get("theme") === "dark" ? "dark" : "light";

  const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
  const progress = (t, start, dur) => clamp((t - start) / dur);
  const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);
  const easeInCubic = (p) => p * p * p;
  const easeInOutCubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const lerp = (a, b, p) => a + (b - a) * p;
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const blink = (t) => Math.floor(t / 500) % 2 === 0;

  // 등장 240ms easeOutCubic(아래에서 6px), 퇴장 180ms easeInCubic
  function fade(el, t, start, dur = 240, outStart = Infinity, outDur = 180, dy = 6) {
    const pIn = easeOutCubic(progress(t, start, dur));
    const pOut = easeInCubic(progress(t, outStart, outDur));
    const o = pIn * (1 - pOut);
    el.style.opacity = o;
    el.style.transform = `translateY(${(1 - pIn) * dy}px)`;
    el.style.visibility = o === 0 ? "hidden" : "visible";
    return o;
  }
  // 타이핑: 보이는 글자 + 자리만 차지하는 나머지 + 캐럿
  function typeInto(el, full, t, start, cps = 24, caretUntil = Infinity) {
    const n = Math.floor(clamp((t - start) / 1000 * cps, 0, full.length));
    const typing = t >= start && n < full.length;
    const showCaret = t >= start && (typing || (t < caretUntil && blink(t)));
    el.innerHTML = esc(full.slice(0, n)) +
      `<span class="caret" style="visibility:${showCaret ? "visible" : "hidden"}"></span>` +
      `<span class="hide">${esc(full.slice(n))}</span>`;
    return n;
  }
  // 숫자가 차오르는 정도
  const count = (t, start, dur, from, to) => lerp(from, to, easeOutCubic(progress(t, start, dur)));

  // 마지막 상태를 HOLD 동안 유지한 뒤 첫 상태로 교차 페이드해 반복 이음새를 만든다.
  const HOLD = 2400, SEAM = 400, SEAM_FADE = 300;
  function defineCard({ end, draw, width = 400, height = 250 }) {
    const stage = document.getElementById("stage");
    stage.style.width = width + "px";
    stage.style.height = height + "px";
    const mark = document.createElement("div");
    mark.className = "mark";
    mark.textContent = "Power-xc";
    stage.appendChild(mark);
    let snap = null;
    const prepare = () => {
      draw(0);
      snap = stage.cloneNode(true);
      snap.removeAttribute("id");
      snap.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
      snap.classList.add("snap");
      snap.style.opacity = 0;
      stage.parentNode.insertBefore(snap, stage.nextSibling);
    };
    return {
      width, height, duration: end + HOLD + SEAM,
      render(t) {
        if (!snap) prepare();
        draw(Math.min(t, end));
        snap.style.opacity = easeInCubic(progress(t, end + HOLD, SEAM_FADE));
      },
    };
  }

  Object.assign(window, { clamp, progress, easeOutCubic, easeInCubic, easeInOutCubic, lerp, esc, blink, fade, typeInto, count, defineCard });
  window.$ = (id) => document.getElementById(id);
})();
