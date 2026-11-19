// Teaching Recipes index: show only recipes with a tag. Works without it: all recipes show.
(function () {
  var chips = document.querySelectorAll('.filters .chip');
  var items = document.querySelectorAll('.recipe-list li');
  function show(tag) {
    chips.forEach(function (c) { c.setAttribute('aria-pressed', String(c.dataset.tag === tag && tag !== '')); });
    items.forEach(function (li) {
      li.hidden = tag !== '' && li.dataset.tags.split(' ').indexOf(tag) < 0;
    });
    document.querySelectorAll('.term').forEach(function (s) {
      s.hidden = !s.querySelector('.recipe-list li:not([hidden])');
    });
  }
  chips.forEach(function (c) { c.addEventListener('click', function () {
    show(c.getAttribute('aria-pressed') === 'true' ? '' : c.dataset.tag);
  }); });
})();
