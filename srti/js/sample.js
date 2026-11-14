// A made-up course for the "Try it with sample data" button and the tests.
// Every number and comment here is invented; it describes no real course,
// instructor or student.

const item = (item, label, n, dist, mean, sd, dept) => ({
  item, label, n, dist, mean, sd,
  interval: [Math.round((mean - 0.15) * 10) / 10, Math.round((mean + 0.15) * 10) / 10],
  dept: { mean: dept, sd: 0.9 }, school: null, campus: { mean: dept, sd: 0.9 },
});

const header = { course: "SAMPLE 101", section: "01", classNumber: "00000", instructor: "Sample, Instructor", responded: 48, enrolled: 80, term: "Fall 2025" };

export const SAMPLE_SECTION = {
  kind: "section",
  ...header,
  items: {
    1: item(1, "Instructor was well prepared for class.", 47, [0.62, 0.3, 0.06, 0.02, 0], 4.5, 0.66, 4.6),
    2: item(2, "Instructor explained course material clearly.", 47, [0.45, 0.32, 0.17, 0.06, 0], 4.2, 0.9, 4.2),
    3: item(3, "Instructor cleared up points of confusion.", 46, [0.43, 0.33, 0.17, 0.07, 0], 4.1, 0.92, 4.2),
    4: item(4, "Instructor used class time well.", 47, [0.5, 0.3, 0.15, 0.05, 0], 4.3, 0.88, 4.4),
    5: item(5, "Instructor inspired interest in the subject matter of this course.", 46, [0.39, 0.3, 0.2, 0.09, 0.02], 4.0, 1.04, 4.0),
    6: item(6, "Instructor showed an interest in helping students learn.", 47, [0.55, 0.32, 0.1, 0.03, 0], 4.4, 0.78, 4.4),
    7: item(7, "Received useful feedback on performance on tests, papers, etc.", 47, [0.26, 0.24, 0.26, 0.15, 0.09], 3.4, 1.27, 3.8),
    8: item(8, "The methods of evaluating my work were fair.", 47, [0.4, 0.3, 0.18, 0.09, 0.03], 4.0, 1.06, 4.2),
    9: item(9, "Instructor stimulated student participation.", 45, [0.35, 0.31, 0.22, 0.09, 0.03], 3.9, 1.08, 3.9),
    10: item(10, "What is your overall rating of this instructor's teaching?", 47, [0.36, 0.38, 0.19, 0.07, 0], 4.0, 0.91, 4.1),
    11: item(11, "Overall, how much do you feel you have learned in this course?", 47, [0.21, 0.32, 0.34, 0.11, 0.02], 3.6, 1.0, 3.8),
    12: item(12, "What is your overall rating of this course?", 47, [0.17, 0.3, 0.36, 0.13, 0.04], 3.4, 1.04, 3.7),
    17: { item: 17, label: "Physical environment of the classroom was conducive to learning.", n: 45, dist: [0.2, 0.36, 0.27, 0.17] },
  },
  extras: [
    { item: 1, label: "I clearly understood the expectations for assignments and participation in this course.", n: 47, dist: [0.38, 0.32, 0.2, 0.08, 0.02], mean: 4.0, survey: "Sample survey" },
    { item: 5, label: "The supports available to me in this class helped me learn.", n: 46, dist: [0.4, 0.35, 0.18, 0.05, 0.02], mean: 4.1, survey: "Sample survey" },
  ],
  comparison: { dept: { sections: 30, avgResponse: 0.3, name: "SAMPLE" }, campus: { sections: 300, avgResponse: 0.38 }, group: "Undergraduate sections with 60 to 119 enrolled" },
  characteristics: {
    hours: [
      { label: "Less than 1 hour", share: 0.02 }, { label: "1-2 hours", share: 0.06 }, { label: "2-4 hours", share: 0.25 },
      { label: "4-6 hours", share: 0.31 }, { label: "6-8 hours", share: 0.21 }, { label: "8-10 hours", share: 0.1 },
      { label: "More than 10 hours", share: 0.04 }, { label: "Missing", share: 0.01 },
    ],
    expectedGrade: [
      { label: "A", share: 0.25 }, { label: "A-", share: 0.21 }, { label: "B+", share: 0.17 }, { label: "B", share: 0.13 },
      { label: "B-", share: 0.08 }, { label: "C+", share: 0.06 }, { label: "C", share: 0.04 }, { label: "C-", share: 0.02 },
      { label: "D+", share: 0 }, { label: "D", share: 0 }, { label: "F", share: 0 }, { label: "Other", share: 0 }, { label: "Missing", share: 0.04 },
    ],
  },
};

const QUESTIONS = [
  "What do you like most about this course or the instructor's teaching of it?",
  "What about this course or the teaching of it needs change or improvement?",
  "What suggestions can you offer that would have made this course a better learning experience for you?",
  "Any additional comments?",
];

const rows = [
  ["The weekly labs were fun.", "We never got feedback on the problem sets, just a score.", "Post the correct answers after the due date.", ""],
  ["Clear lectures.", "Grades came back with no comments, so I could not tell what I did wrong.", "", "Good class overall."],
  ["The instructor is enthusiastic.", "Feedback on exams was slow.", "Walk-through solutions for each exam.", ""],
  ["Projects felt like real work.", "The exams were too hard for the time we had.", "Practice exams would help.", ""],
  ["", "Exams were way too difficult.", "More time on the exams.", "N/A"],
  ["Interesting topics.", "Honestly the course should be more rigorous.", "", ""],
  ["Office hours.", "Nothing.", "Nothing.", "No"],
  ["The examples in class.", "The 8am time slot is rough.", "", ""],
  ["Labs.", "The lecture hall has no power outlets.", "", ""],
  ["The projects.", "The project instructions were unclear and changed twice.", "Clearer instructions.", ""],
  ["Well organized.", "", "", "Great course."],
  ["The instructor explains things clearly.", "Lectures got boring near the end.", "More interactive components.", ""],
  ["Friendly staff.", "I never knew what I got wrong on the quizzes.", "Show us which questions we missed.", ""],
  ["Good pace.", "", "", "Thanks!"],
  ["The textbook.", "It is a lot of work for the credits.", "", ""],
  ["", "Some quizzes had trick questions.", "", ""],
  ["Engaging lectures.", "N/A", "N/A", "N/A"],
  ["The final project.", "More depth on the later topics.", "", ""],
  ["Interesting material.", "The TAs could be more helpful.", "", ""],
  ["", "Nothing to change.", "", "One of my favorite classes."],
  ["Discussion sections.", "More feedback on the projects, please.", "", ""],
  ["", "", "", "n/a"],
];

export const SAMPLE_OPEN = {
  kind: "open",
  ...header,
  questions: QUESTIONS,
  responses: rows.map((cells) => ({ cells, substantive: cells.some((t) => t && !/^(n\/?a|no|none|nothing\.?|-+)$/i.test(t)) })),
};

export const SAMPLE_COURSE = { key: "sample", course: header.course, term: header.term, section: SAMPLE_SECTION, open: SAMPLE_OPEN, credits: 3, sample: true };
