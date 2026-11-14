/* OpenAdmin landing page — small, dependency-free interactions. */
(function () {
  "use strict";

  var header = document.getElementById("site-header");
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function onScroll() {
    if (!header) return;
    header.classList.toggle("is-scrolled", window.scrollY > 8);
  }
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  /* ---------- mobile menu ---------- */
  var toggle = document.querySelector(".menu-toggle");
  var mobileMenu = document.getElementById("mobile-menu");
  var menuOpen = false;

  function setMenu(open) {
    if (!toggle || !mobileMenu) return;
    menuOpen = open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.setAttribute("aria-label", open ? toggle.dataset.closeLabel || "Close menu" : toggle.dataset.openLabel || "Open menu");
    mobileMenu.hidden = !open;
    header.classList.toggle("menu-open", open);
    document.body.style.overflow = open ? "hidden" : "";
  }

  if (toggle) {
    toggle.addEventListener("click", function () { setMenu(!menuOpen); });
  }
  if (mobileMenu) {
    mobileMenu.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () { setMenu(false); });
    });
  }
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && menuOpen) setMenu(false);
  });
  window.addEventListener("resize", function () {
    if (window.innerWidth > 980 && menuOpen) setMenu(false);
  });

  /* ---------- scroll reveal ---------- */
  var reveals = Array.prototype.slice.call(document.querySelectorAll(".reveal"));
  if (reduceMotion || !("IntersectionObserver" in window)) {
    reveals.forEach(function (el) { el.classList.add("in"); });
  } else {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.06 });
    reveals.forEach(function (el) { observer.observe(el); });
    window.setTimeout(function () {
      reveals.forEach(function (el) { el.classList.add("in"); });
    }, 2600);
  }

  /* ---------- tabs (screenshots + install) ---------- */
  function initTabs(tabSelector) {
    var tabs = Array.prototype.slice.call(document.querySelectorAll(tabSelector));
    if (!tabs.length) return;
    var panels = tabs.map(function (tab) { return document.getElementById(tab.getAttribute("aria-controls")); });

    function activate(index, focus) {
      tabs.forEach(function (tab, i) {
        var selected = i === index;
        tab.classList.toggle("is-active", selected);
        tab.setAttribute("aria-selected", selected ? "true" : "false");
        tab.tabIndex = selected ? 0 : -1;
        if (panels[i]) {
          panels[i].hidden = !selected;
          panels[i].classList.toggle("is-active", selected);
        }
      });
      if (focus) tabs[index].focus();
    }

    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () { activate(i, false); });
      tab.addEventListener("keydown", function (event) {
        var next = null;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (i + 1) % tabs.length;
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (i - 1 + tabs.length) % tabs.length;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = tabs.length - 1;
        if (next !== null) {
          event.preventDefault();
          activate(next, true);
        }
      });
    });
  }

  initTabs(".shot-tab");
  initTabs(".install-tab");

  /* ---------- copy buttons ---------- */
  document.querySelectorAll(".copy-btn").forEach(function (button) {
    button.addEventListener("click", function () {
      var target = document.getElementById(button.getAttribute("data-copy"));
      if (!target) return;
      var text = target.textContent || "";
      var label = button.querySelector("span");
      var original = label ? label.textContent : "";
      function done() {
        button.classList.add("copied");
        if (label) label.textContent = button.dataset.copiedLabel || "Copied";
        window.setTimeout(function () {
          button.classList.remove("copied");
          if (label) label.textContent = original;
        }, 1700);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { legacyCopy(text, done); });
      } else {
        legacyCopy(text, done);
      }
    });
  });

  function legacyCopy(text, done) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    document.body.appendChild(area);
    area.select();
    try { document.execCommand("copy"); done(); } catch (error) { /* no-op */ }
    document.body.removeChild(area);
  }

  /* ---------- card spotlight ---------- */
  if (!reduceMotion && window.matchMedia("(pointer: fine)").matches) {
    document.querySelectorAll(".bento-card").forEach(function (card) {
      card.addEventListener("pointermove", function (event) {
        var rect = card.getBoundingClientRect();
        card.style.setProperty("--mx", (event.clientX - rect.left) + "px");
        card.style.setProperty("--my", (event.clientY - rect.top) + "px");
      });
    });
  }

  /* ---------- hero pointer parallax ---------- */
  var hero = document.querySelector(".hero");
  var frame = document.getElementById("hero-frame");
  if (hero && frame && !reduceMotion && window.matchMedia("(pointer: fine)").matches && window.innerWidth > 980) {
    var raf = null;
    hero.addEventListener("pointermove", function (event) {
      if (raf) return;
      raf = requestAnimationFrame(function () {
        var x = event.clientX / window.innerWidth - 0.5;
        var y = event.clientY / window.innerHeight - 0.5;
        frame.style.transform = "perspective(1800px) rotateX(" + (2.2 - y * 1.7).toFixed(2) + "deg) rotateY(" + (x * 2.2).toFixed(2) + "deg) translateY(" + (y * -4).toFixed(2) + "px)";
        raf = null;
      });
    });
    hero.addEventListener("pointerleave", function () {
      frame.style.transform = "";
    });
  }
})();
