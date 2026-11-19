// Coming soon pages: "Show another" idea from the research, drawn from the other recipes.
(function () {
  var btn = document.getElementById('wait-next');
  if (!btn) return;
  fetch('recipes.json').then(function (r) { return r.json(); }).then(function (data) {
    var pool = data.recipes.filter(function (r) { return r.n !== window.RECIPE_HERE; });
    function pick() {
      var r = pool[Math.floor(Math.random() * pool.length)];
      document.getElementById('wait-idea').innerHTML = r.ideaHtml;
      var n = String(r.n).padStart(2, '0');
      document.getElementById('wait-from').innerHTML = 'From <a href="' + n + '.html">' + r.n + '. ' +
        r.title.replace(/[&<>]/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]; }) + '</a>' +
        (r.out ? '' : ' <span class="soon">' + r.term + '</span>');
    }
    pick();
    btn.addEventListener('click', pick);
  }).catch(function () { btn.hidden = true; });
})();
