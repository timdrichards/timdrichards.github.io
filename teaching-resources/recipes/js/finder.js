// Teaching Recipes finder. Scores every recipe against the answers, in the browser.
// Nothing is sent anywhere.
(function () {
  var form = document.getElementById('finder');
  var results = document.getElementById('results');
  var data;
  fetch('recipes.json').then(function (r) { return r.json(); }).then(function (d) { data = d; });

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) {
    return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]; }); }
  function answers() {
    var f = new FormData(form);
    return { size: f.get('size'), tas: f.get('tas') === 'yes',
             needs: f.getAll('needs'), fits: f.getAll('fits'), goals: f.getAll('goals') };
  }
  function score(r, a) {
    // A recipe that assumes TAs, teams, exams or code the course does not have is left out.
    for (var i = 0; i < r.needs.length; i++) {
      var need = r.needs[i];
      if (need === 'tas' ? !a.tas : a.needs.indexOf(need) < 0) return -1;
    }
    var s = 0, why = [];
    r.fits.forEach(function (k) { if (a.fits.indexOf(k) >= 0) { s += 3; why.push(data.problems[k]); } });
    r.tags.forEach(function (t) { if (a.goals.indexOf(t) >= 0) { s += 1; why.push(data.goals[t]); } });
    if (a.size === 'large' && r.tags.indexOf('saves-time') >= 0) s += 0.5;
    if (r.out) s += 0.25;           // prefer what is out now, all else equal
    s -= r.n / 1000;                // then earlier recipes, which later ones build on
    return { s: s, why: why };
  }
  function card(r, why) {
    var n = String(r.n).padStart(2, '0');
    return '<li><a href="' + n + '.html"><span class="num">' + r.n + '</span> ' + esc(r.title) + '</a> ' +
      (r.out ? '<span class="out">Out now</span>' : '<span class="soon">' + esc(r.term) + '</span>') +
      '<span class="summary">' + esc(r.ai) + '</span>' +
      (why.length ? '<span class="why">For: ' + esc(why.join('; ')) + '</span>' : '') + '</li>';
  }
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!data) return;
    var a = answers();
    var ranked = data.recipes.map(function (r) { var x = score(r, a); return { r: r, s: x.s, why: x.why }; })
      .filter(function (x) { return x.s > 0.3; })
      .sort(function (p, q) { return q.s - p.s; });
    var html;
    if (!a.fits.length && !a.goals.length) {
      html = '<p>Pick at least one thing that gets in the way, or one thing you want, and try again.</p>';
    } else if (!ranked.length) {
      html = '<p>No recipe matches those answers yet. Start with <a href="01.html">Recipe 1</a>, which most others build on.</p>';
    } else {
      html = '<h2>Start here</h2><ol class="recipe-list picks">' +
        ranked.slice(0, 3).map(function (x) { return card(x.r, x.why); }).join('') + '</ol>';
      if (ranked.length > 3) html += '<h2>Then</h2><ol class="recipe-list">' +
        ranked.slice(3, 8).map(function (x) { return card(x.r, x.why); }).join('') + '</ol>';
      html += '<p class="small">Try one recipe at a time, for one assignment. Each takes less time than what it replaces once it is set up.</p>';
    }
    results.innerHTML = html;
    results.hidden = false;
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  var out = document.getElementById('prompt-out');
  var copyBtn = document.getElementById('copy-prompt');
  document.getElementById('make-prompt').addEventListener('click', function () {
    if (!data) return;
    var a = answers();
    var desc = document.getElementById('course-desc').value.trim() || '[describe your course here]';
    var list = data.recipes.map(function (r) {
      return r.n + '. ' + r.title + ' (' + (r.out ? 'out now' : 'coming ' + r.term) + '). AI: ' + r.ai + '. Idea: ' + r.idea;
    }).join('\n');
    out.textContent =
      'I teach a university computing course and want to improve it without adding to my workload.\n\n' +
      'My course: ' + desc + '\n' +
      'Size: ' + form.size.options[form.size.selectedIndex].text + '. Staff: ' + (a.tas ? 'TAs or course assistants' : 'just me') + '.\n' +
      'What gets in the way: ' + (a.fits.map(function (k) { return data.problems[k]; }).join('; ') || 'not given') + '.\n' +
      'What I want most: ' + (a.goals.map(function (k) { return data.goals[k]; }).join('; ') || 'not given') + '.\n\n' +
      'Below is a list of "Teaching Recipes", one-page practices with the research behind each. ' +
      'Pick the three that would help my course most, in the order I should try them. For each, say what I would do ' +
      'in my course specifically in the first week, how much time it takes to set up, and what time or feedback it gains. ' +
      'Prefer changes that save me time or replace something I already do. Then name one thing I could stop doing.\n\n' +
      'Teaching Recipes (details at https://timdrichards.github.io/teaching-resources/recipes/):\n' + list;
    out.hidden = false; copyBtn.hidden = false;
  });
  copyBtn.addEventListener('click', function () {
    navigator.clipboard.writeText(out.textContent).then(function () {
      document.getElementById('copied').textContent = 'Copied.';
    }, function () { document.getElementById('copied').textContent = 'Select the text below and copy it.'; });
  });
})();
