(function () {
  var prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var revealEls = document.querySelectorAll(".reveal");

  if (prefersReducedMotion || !("IntersectionObserver" in window)) {
    revealEls.forEach(function (el) { el.classList.add("is-visible"); });
    return;
  }

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: "0px 0px -40px 0px" }
  );

  revealEls.forEach(function (el) { observer.observe(el); });
})();

/* ---------- Click any image to see it larger ----------
   Applies to every <img> on the site automatically. Images inside a link are
   left alone so the link still works; add data-no-zoom to opt an image out. */
(function () {
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var DURATION = reduce ? 0 : 320;
  var EASE = "cubic-bezier(0.4, 0, 0.2, 1)";
  var active = null;

  function eligible(img) {
    return img && img.tagName === "IMG" &&
           !img.closest("a") &&
           !img.hasAttribute("data-no-zoom") &&
           !img.classList.contains("zoom-img");
  }

  /* mark images so they look and behave like controls */
  function mark(root) {
    var imgs = (root || document).querySelectorAll ? (root || document).querySelectorAll("img") : [];
    Array.prototype.forEach.call(imgs, function (img) {
      if (!eligible(img) || img.dataset.zoomable) return;
      img.dataset.zoomable = "true";
      img.tabIndex = 0;
      img.setAttribute("role", "button");
      img.setAttribute("aria-label", (img.alt ? img.alt + " — " : "") + "view larger");
    });
  }

  /* Pick the highest-resolution source, and report how wide it really is.
     Note: we cannot use the thumbnail's naturalWidth as the ceiling. For an
     <img> with srcset + sizes the browser reports naturalWidth *density
     corrected* (a 760px file shown in a 336px slot reports 336), which would
     collapse the enlarged view back to thumbnail size. The w descriptor, or
     the width attribute, gives the true pixel width. */
  function bestSource(img) {
    if (img.dataset.full) {
      return { url: img.dataset.full, width: parseInt(img.dataset.fullWidth, 10) || 0 };
    }
    var best = img.currentSrc || img.src;
    var bestW = 0;
    if (img.srcset) {
      img.srcset.split(",").forEach(function (part) {
        var bits = part.trim().split(/\s+/);
        var w = parseInt(bits[1], 10) || 0;
        if (w > bestW) { bestW = w; best = bits[0]; }
      });
    }
    if (!bestW) bestW = parseInt(img.getAttribute("width"), 10) || 0;
    return { url: best, width: bestW };
  }

  function targetRect(img, sourceWidth) {
    var r = img.getBoundingClientRect();
    var ratio = (img.naturalWidth && img.naturalHeight)
      ? img.naturalWidth / img.naturalHeight
      : r.width / r.height;
    var maxW = window.innerWidth * 0.92;
    var maxH = window.innerHeight * 0.92;
    var w = maxW, h = w / ratio;
    if (h > maxH) { h = maxH; w = h * ratio; }
    /* never upscale past the real pixels of the file we are loading */
    if (sourceWidth && w > sourceWidth) { w = sourceWidth; h = w / ratio; }
    /* but always end up meaningfully bigger than the thumbnail */
    if (w < r.width * 1.15) { w = Math.min(maxW, r.width * 1.15); h = w / ratio; }
    return {
      width: w, height: h,
      left: (window.innerWidth - w) / 2,
      top: (window.innerHeight - h) / 2
    };
  }

  function place(el, r) {
    el.style.left = r.left + "px";
    el.style.top = r.top + "px";
    el.style.width = r.width + "px";
    el.style.height = r.height + "px";
  }

  function open(img) {
    if (active) return;

    var source = bestSource(img);
    var from = img.getBoundingClientRect();
    var to = targetRect(img, source.width);

    var overlay = document.createElement("div");
    overlay.className = "zoom-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", img.alt || "Enlarged image");

    var big = document.createElement("img");
    big.className = "zoom-img";
    big.src = source.url;
    big.alt = img.alt || "";
    place(big, to);

    var close = document.createElement("button");
    close.type = "button";
    close.className = "zoom-close";
    close.setAttribute("aria-label", "Close enlarged image");
    close.innerHTML = "&#215;";

    overlay.appendChild(big);
    overlay.appendChild(close);
    document.body.appendChild(overlay);

    var scrollbar = window.innerWidth - document.documentElement.clientWidth;
    document.documentElement.style.overflow = "hidden";
    if (scrollbar > 0) document.body.style.paddingRight = scrollbar + "px";

    active = {
      overlay: overlay, big: big, source: img,
      sourceWidth: source.width,
      restoreFocus: document.activeElement
    };

    /* FLIP: start at the thumbnail's position, animate to centre */
    var dx = from.left - to.left;
    var dy = from.top - to.top;
    var sx = from.width / to.width;
    var sy = from.height / to.height;

    overlay.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DURATION, easing: EASE });
    big.animate(
      [{ transform: "translate(" + dx + "px," + dy + "px) scale(" + sx + "," + sy + ")" },
       { transform: "none" }],
      { duration: DURATION, easing: EASE }
    );

    close.focus();
  }

  function shut() {
    if (!active) return;
    var a = active;
    active = null;

    var from = a.source.getBoundingClientRect();
    var to = a.big.getBoundingClientRect();
    var dx = from.left - to.left;
    var dy = from.top - to.top;
    var sx = from.width / to.width;
    var sy = from.height / to.height;
    var visible = to.width > 0 && from.width > 0;

    var done = false;
    function cleanup() {
      if (done) return;
      done = true;
      a.overlay.remove();
      document.documentElement.style.overflow = "";
      document.body.style.paddingRight = "";
      if (a.restoreFocus && a.restoreFocus.focus) a.restoreFocus.focus();
    }

    if (!DURATION || !visible) { cleanup(); return; }

    a.overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DURATION, easing: EASE });
    var anim = a.big.animate(
      [{ transform: "none" },
       { transform: "translate(" + dx + "px," + dy + "px) scale(" + sx + "," + sy + ")" }],
      { duration: DURATION, easing: EASE }
    );
    anim.onfinish = cleanup;
    anim.oncancel = cleanup;
    /* Animations are throttled in a backgrounded tab, so onfinish may never
       arrive. Without this the overlay would stay stuck on screen with the
       page scroll still locked. */
    setTimeout(cleanup, DURATION + 80);
  }

  document.addEventListener("click", function (e) {
    if (active) { shut(); return; }
    var img = e.target.closest ? e.target.closest("img") : null;
    if (img && eligible(img)) { e.preventDefault(); open(img); }
  });

  document.addEventListener("keydown", function (e) {
    if (active) {
      if (e.key === "Escape") { e.preventDefault(); shut(); }
      if (e.key === "Tab") e.preventDefault(); /* only the close button is reachable */
      return;
    }
    if (e.key !== "Enter" && e.key !== " ") return;
    var img = document.activeElement;
    if (img && eligible(img) && img.dataset.zoomable) { e.preventDefault(); open(img); }
  });

  window.addEventListener("resize", function () {
    if (active) place(active.big, targetRect(active.source, active.sourceWidth));
  });

  mark(document);

  /* keep working for images added to the page later */
  if ("MutationObserver" in window) {
    new MutationObserver(function (records) {
      records.forEach(function (r) {
        Array.prototype.forEach.call(r.addedNodes, function (n) {
          if (n.nodeType === 1) mark(n.matches && n.matches("img") ? n.parentNode : n);
        });
      });
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
})();
