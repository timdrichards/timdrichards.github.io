// Once the page title scrolls out of view, show it in a slim bar under the site header.
(function () {
  var h1 = document.querySelector(".page-head h1");
  var header = document.querySelector(".site-header");
  if (!h1 || !("IntersectionObserver" in window)) return;
  var bar = document.createElement("div");
  bar.className = "pin-title";
  bar.setAttribute("aria-hidden", "true");
  var inner = document.createElement("div");
  inner.className = "wrap";
  inner.textContent = h1.textContent;
  bar.appendChild(inner);
  document.body.appendChild(bar);
  var observer;
  function place() {
    var top = header ? header.getBoundingClientRect().height : 0;
    bar.style.top = top + "px";
    if (observer) observer.disconnect();
    observer = new IntersectionObserver(function (entries) {
      bar.classList.toggle("on", !entries[0].isIntersecting);
    }, { rootMargin: "-" + Math.round(top) + "px 0px 0px 0px" });
    observer.observe(h1);
  }
  place();
  window.addEventListener("resize", place);
})();
