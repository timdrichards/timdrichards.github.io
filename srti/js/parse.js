// Parsing UMass SRTI report PDFs (OAPA layout, 2022 onward) into plain objects.
//
// Works in the browser and in Node: the caller passes in a pdf.js module, so
// this file imports nothing. Every function below is pure apart from
// extractPages, which only reads the PDF.
//
// Coordinates: x grows to the right, y grows downward from the top of the page
// (pdf.js gives y from the bottom; extractPages flips it).

export async function extractPages(pdfjs, data) {
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      const str = it.str.replace(/\s+/g, " ").trim();
      if (!str) continue;
      const x = it.transform[4];
      items.push({ str, x, y: vp.height - it.transform[5], w: it.width, h: it.height, cx: x + it.width / 2 });
    }
    pages.push({ width: vp.width, height: vp.height, items });
  }
  await doc.destroy();
  return pages;
}

// ---------- small helpers ----------

function allText(pages) {
  return pages.flatMap((p) => p.items.map((i) => i.str)).join("\n");
}

// Group items into lines by y (within tol), each sorted by x.
function lines(items, tol = 1.5) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const out = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - it.y) <= tol) last.items.push(it);
    else out.push({ y: it.y, items: [it] });
  }
  for (const l of out) l.items.sort((a, b) => a.x - b.x);
  return out;
}

const pct = (s) => {
  const m = /^(\d+(?:\.\d+)?)%$/.exec(s);
  return m ? Number(m[1]) / 100 : null;
};
const num = (s) => (/^-?\d+(?:\.\d+)?$/.test(s) ? Number(s) : null);

function header(text) {
  const course = /Course:\s*([A-Z]+\s*\d+[A-Z]*)/.exec(text);
  const section = /Section:\s*(\S+)\s*\((\d+)\)/.exec(text);
  const instructor = /Instructor:\s*([^\n]+)/.exec(text);
  const responses = /Responses:\s*(\d+)\s*\/\s*(\d+)/.exec(text);
  const term = /(FALL|SPRING|SUMMER|WINTER)\s+(\d{4})/.exec(text);
  return {
    course: course ? course[1].replace(/\s+/, " ") : null,
    section: section ? section[1] : null,
    classNumber: section ? section[2] : null,
    instructor: instructor ? instructor[1].trim() : null,
    responded: responses ? Number(responses[1]) : null,
    enrolled: responses ? Number(responses[2]) : null,
    term: term ? `${term[1][0]}${term[1].slice(1).toLowerCase()} ${term[2]}` : null,
  };
}

export function reportKey(h) {
  return [h.course, h.section, h.classNumber, h.term].join("|");
}

// Item tables: a row starts at a line whose first item is a bare item number
// at the left margin; a long label can wrap, with the numbers on a later line.
// nX is the x of the "(N)" column header; tokens left of it are label text.
function itemRows(pageLines, nX) {
  const rows = [];
  let cur = null;
  for (const l of pageLines) {
    const first = l.items[0];
    // The item number is its own text item, or runs into the label ("10 What is ...").
    const m = first.x < 36 ? /^(\d{1,2})(?:\s+(.*))?$/.exec(first.str) : null;
    if (m) {
      cur = { item: Number(m[1]), label: m[2] ? [m[2]] : [], values: [] };
      rows.push(cur);
      l.items.slice(1).forEach((it) => (it.x < nX - 4 ? cur.label.push(it.str) : cur.values.push(it)));
    } else if (cur && cur.values.length === 0) {
      l.items.forEach((it) => (it.x < nX - 4 ? cur.label.push(it.str) : cur.values.push(it)));
    } else {
      cur = null;
    }
  }
  return rows.map((r) => ({ ...r, label: r.label.join(" ") }));
}

// Label/percentage blocks such as "What grade do you expect...": each column
// starts at its question's x; rows below pair a label with a percentage.
function blocks(page, questions) {
  const heads = questions
    .map((q) => ({ q, it: page.items.find((i) => i.str.startsWith(q.startsWith)) }))
    .filter((h) => h.it)
    .sort((a, b) => a.it.x - b.it.x);
  const out = {};
  heads.forEach((h, k) => {
    const x0 = h.it.x - 2;
    const x1 = k + 1 < heads.length ? heads[k + 1].it.x - 2 : page.width;
    const col = page.items.filter((i) => i.x >= x0 && i.x < x1 && i.y > h.it.y + 1 && i.y < h.it.y + 200);
    const dist = [];
    for (const l of lines(col)) {
      const p = l.items.map((i) => pct(i.str)).find((v) => v !== null) ?? null;
      const label = l.items.filter((i) => pct(i.str) === null).map((i) => i.str).join(" ");
      if (p === null || !label) continue;
      dist.push({ label, share: p });
    }
    out[h.q.key] = dist;
  });
  return out;
}

// ---------- Section Report ----------

export function isSectionReport(pages) {
  return /SECTION REPORT: FREQUENCIES/.test(allText(pages));
}
export function isOpenEnded(pages) {
  return /OPEN-ENDED RESPONSES/.test(allText(pages));
}

export function parseSectionReport(pages) {
  const text = allText(pages);
  const report = { kind: "section", ...header(text), items: {}, extras: [], comparison: {}, characteristics: {} };

  for (const page of pages) {
    const ptext = page.items.map((i) => i.str).join("\n");
    const nHead = page.items.find((i) => i.str === "(N)");
    const pl = lines(page.items);

    if (/SECTION REPORT: FREQUENCIES/.test(ptext) && nHead) {
      for (const r of itemRows(pl, nHead.x)) {
        const toks = r.values.map((v) => v.str);
        const n = num(toks[0]);
        const dist = toks.slice(1).map(pct).filter((v) => v !== null);
        if (n === null || dist.length < 4) continue;
        report.items[r.item] = { ...(report.items[r.item] || {}), item: r.item, label: r.label, n, dist };
      }
      Object.assign(
        report.characteristics,
        blocks(page, [
          { key: "effort", startsWith: "What level of effort" },
          { key: "attendance", startsWith: "What proportion of class" },
          { key: "hours", startsWith: "Hours per week" },
        ]),
      );
    }

    if (/MEAN COMPARISONS/.test(ptext) && nHead) {
      // Column headers sit on one line: Mean SD Credible-Interval Mean AvgSD Mean AvgSD Mean AvgSD.
      const headLine = pl.find((l) => l.items.some((i) => i.str === "Mean") && l.items.some((i) => i.str === "SD"));
      if (headLine) {
        const means = headLine.items.filter((i) => i.str === "Mean");
        const sds = headLine.items.filter((i) => i.str === "Avg. SD" || i.str === "SD");
        const ci = headLine.items.find((i) => /Credible/.test(i.str));
        const groupNames = ["instructor", "dept", "school", "campus"];
        const cols = [{ key: "n", cx: nHead.cx }];
        means.forEach((m, k) => cols.push({ key: `${groupNames[k]}Mean`, cx: m.cx }));
        sds.forEach((s, k) => cols.push({ key: `${groupNames[k]}SD`, cx: s.cx }));
        if (ci) cols.push({ key: "interval", cx: ci.cx });
        const nearest = (it) => {
          let best = null;
          for (const c of cols) {
            const d = Math.abs(c.cx - it.cx);
            if (d < 22 && (!best || d < best.d)) best = { key: c.key, d };
          }
          return best && best.key;
        };
        for (const r of itemRows(pl.filter((l) => l.y > headLine.y + 2), nHead.x)) {
          const row = {};
          for (const v of r.values) {
            const key = nearest(v);
            if (!key) continue;
            if (key === "interval") {
              const m = /^(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)$/.exec(v.str);
              if (m) row.interval = [Number(m[1]), Number(m[2])];
            } else if (num(v.str) !== null) row[key] = num(v.str);
          }
          if (row.instructorMean == null) continue;
          const prev = report.items[r.item] || { item: r.item, label: r.label };
          report.items[r.item] = {
            ...prev,
            mean: row.instructorMean,
            sd: row.instructorSD,
            interval: row.interval,
            dept: row.deptMean != null ? { mean: row.deptMean, sd: row.deptSD } : null,
            school: row.schoolMean != null ? { mean: row.schoolMean, sd: row.schoolSD } : null,
            campus: row.campusMean != null ? { mean: row.campusMean, sd: row.campusSD } : null,
          };
        }
        // Comparison groups: "# Sections:" and "Avg. Resp:" under each group header.
        const groupHeads = page.items
          .filter((i) => /^(Program\/Dept:|School\/College:|CAMPUS)/.test(i.str))
          .sort((a, b) => a.x - b.x);
        const groupKeys = groupHeads.map((g) => (/Program/.test(g.str) ? "dept" : /School/.test(g.str) ? "school" : "campus"));
        const groupOf = (x) => {
          let k = -1;
          groupHeads.forEach((g, j) => { if (x >= g.x - 20) k = j; });
          return k;
        };
        for (const l of pl.filter((l) => l.y < headLine.y)) {
          const label = l.items.find((i) => /# Sections:|Avg\. Resp:/.test(i.str));
          if (!label) continue;
          for (const it of l.items) {
            if (/# Sections:|Avg\. Resp:/.test(it.str)) continue;
            const g = groupOf(it.x);
            if (g < 0) continue;
            const key = groupKeys[g];
            report.comparison[key] = report.comparison[key] || {};
            const lab = l.items.filter((i) => /# Sections:|Avg\. Resp:/.test(i.str) && groupOf(i.x) === g)[0];
            if (!lab) continue;
            if (/Sections/.test(lab.str) && num(it.str) !== null) report.comparison[key].sections = num(it.str);
            if (/Resp/.test(lab.str) && pct(it.str) !== null) report.comparison[key].avgResponse = pct(it.str);
          }
        }
        const deptName = page.items.find((i) => groupHeads[0] && i.y > groupHeads[0].y && i.y < groupHeads[0].y + 12 && Math.abs(i.cx - groupHeads[0].cx) < 30);
        if (deptName && report.comparison.dept) report.comparison.dept.name = deptName.str;
        const group = page.items.find((i) => /sections with/.test(i.str) && i.y < headLine.y);
        if (group) report.comparison.group = group.str;
      }
      Object.assign(
        report.characteristics,
        blocks(page, [
          { key: "courseType", startsWith: "Which best describes" },
          { key: "classLevel", startsWith: "What is your class level" },
          { key: "expectedGrade", startsWith: "What grade do you expect" },
        ]),
      );
    }

    if (/DEPARTMENTAL EXTRA SURVEY ITEMS/.test(ptext) && nHead) {
      const survey = /Survey name:\s*([^\n]+)/.exec(ptext);
      for (const r of itemRows(pl, nHead.x)) {
        const toks = r.values.map((v) => v.str);
        const n = num(toks[0]);
        const dist = toks.slice(1).map(pct).filter((v) => v !== null);
        const mean = num(toks[toks.length - 1]);
        if (n === null || dist.length < 4) continue;
        report.extras.push({ item: r.item, label: r.label, n, dist, mean, survey: survey ? survey[1].trim() : null });
      }
    }
  }
  return report;
}

// ---------- Open-ended responses ----------

const TRIVIAL = /^(n\/?a|na|no|none|nope|nah|nothing|-+|\.|no comment|non|none\.|no\.|n\/a\.|nothing\.)$/i;

export function parseOpenEnded(pages) {
  const report = { kind: "open", ...header(allText(pages)), questions: [], responses: [] };
  for (const page of pages) {
    // Header: the question texts end in "?" near the top of the page.
    const qEnds = page.items.filter((i) => /\?$/.test(i.str) && i.y < 160).sort((a, b) => a.x - b.x);
    if (qEnds.length < 2) continue;
    const starts = qEnds.map((q) => q.x);
    const headBottom = Math.max(...qEnds.map((q) => q.y));
    const headTop = Math.min(...page.items.filter((i) => i.y < headBottom + 1 && i.y > 80 && starts.some((s) => Math.abs(s - i.x) < 3)).map((i) => i.y));
    if (!report.questions.length) {
      report.questions = starts.map((s, k) => {
        const next = starts[k + 1] ?? page.width;
        return page.items
          .filter((i) => i.y >= headTop - 1 && i.y <= headBottom + 1 && i.x >= s - 3 && i.x < next - 3)
          .sort((a, b) => a.y - b.y)
          .map((i) => i.str)
          .join(" ");
      });
    }
    const colOf = (x) => {
      let k = 0;
      starts.forEach((s, j) => { if (x >= s - 3) k = j; });
      return k;
    };
    const body = page.items.filter((i) => i.y > headBottom + 3 && i.y < page.height - 30 && !/OAPA|Office of Academic Planning|For more information/.test(i.str));
    const bl = lines(body);
    if (!bl.length) continue;
    // Line pitch inside a cell, then rows: a new row starts after a gap
    // clearly larger than the pitch below everything seen so far.
    const gaps = [];
    for (let k = 1; k < bl.length; k++) gaps.push(bl[k].y - bl[k - 1].y);
    const pitch = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length * 0.25)] : 9;
    let row = null;
    let maxY = -Infinity;
    for (const l of bl) {
      if (!row || l.y - maxY > pitch * 1.2) {
        row = starts.map(() => []);
        report.responses.push(row);
      }
      for (const it of l.items) row[colOf(it.x)].push(it.str);
      maxY = l.y;
    }
  }
  report.responses = report.responses.map((cells) => {
    const texts = cells.map((c) => c.join(" ").replace(/\s+/g, " ").trim());
    return { cells: texts, substantive: texts.some((t) => t && !TRIVIAL.test(t)) };
  });
  return report;
}

// Read one PDF and say what it is.
export async function readReport(pdfjs, data) {
  const pages = await extractPages(pdfjs, data);
  if (isSectionReport(pages)) return parseSectionReport(pages);
  if (isOpenEnded(pages)) return parseOpenEnded(pages);
  return { kind: "unknown", ...header(allText(pages)) };
}
