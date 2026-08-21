/**
 * RDM lead capture -> ONE spreadsheet ("RDM Numbers"), five tabs.
 *   - router quiz  -> "Quiz Leads" tab
 *   - Academy app  -> "Academy Applications" tab
 *   - Daily Log / Totals / Weekly are hand-kept and this script never touches them.
 *
 * After pasting this in: Deploy -> Manage deployments -> pencil (edit)
 * -> Version: New version -> Deploy. (Keeps the SAME url.)
 *
 * LAYOUT CONTRACT (changed 2026-08-21): every tab in this workbook reserves
 * rows 1-4 for a title and a "how to use it" block, headers live on row 5, and
 * data starts on row 6. Anything written to row 1 by this script would sit on
 * top of the instructions, which is why HEADER_ROW exists instead of a literal 1.
 */
var HEADER_ROW = 5;

function doPost(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var data = JSON.parse(e.postData.contents);
    var type = data.formType || 'quiz';

    if (type === 'academy') {
      var sh = getOrCreateSheet(ss, 'Academy Applications', ACADEMY_HEADERS(), ACADEMY_INTRO());
      sh.appendRow([
        new Date(), data.firstName||'', data.lastName||'', data.email||'',
        data.phone||'', igLink(data.instagram), data.age||'', data.level||'',
        data.goal||'', data.challenges||'', data.hours||'', data.watchedVideo||'',
        data.parents||'', data.finances||''
      ]);
    } else {
      var ans = data.answers || [];
      var qs = getOrCreateSheet(ss, 'Quiz Leads', QUIZ_HEADERS(), QUIZ_INTRO());
      qs.appendRow(
        [ new Date(), data.firstName||'', data.email||'', data.product||'' ]
          .concat(ans)
          .concat([ igLink(data.instagram), data.age||'', data.payer||'', data.story||'' ])
      );
    }

    return ContentService
      .createTextOutput(JSON.stringify({ result: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ result: 'error', message: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function QUIZ_HEADERS() {
  return ['Date','First Name','Email','Recommended Product',
          'Q1','Q2','Q3','Q4','Q5','Q6','Instagram','Age','Who Pays','In Their Words'];
}
function ACADEMY_HEADERS() {
  return ['Date','First Name','Last Name','Email','Phone','Instagram','Age',
          'Player Level','#1 Goal','Struggles','Hours/Week','Watched Video',
          'Parents On Board','Financial Readiness'];
}

function QUIZ_INTRO() {
  return [
    'QUIZ LEADS',
    'HOW TO USE IT: this tab fills itself in from the quiz on your website. You never type in it. Open it every morning and DM every new row within 24 hours. The Instagram cell is a live link, so just click it.',
    'READ THE LAST COLUMN FIRST. "In Their Words" is whatever they typed about their own goals and struggles, and it is the only answer they were not handed a multiple choice for, so it is the one to quote back to them. A lead is HOT if any of these appear: chasing a specific competitive line, freezes at auditions, an audition coming up, wants intensive 1-on-1, or practised 6 to 7 days last week. Age and Who Pays tell you who you are really selling to: under 18 with parents paying means the parent must be on the sales call, so say so when you book it.'
  ];
}
function ACADEMY_INTRO() {
  return [
    'ACADEMY APPLICATIONS',
    'HOW TO USE IT: this tab fills itself in from the application form. You never type in it. It stays empty until somebody applies, and every row that appears is the highest-intent lead you can get, because a person filled in a long form to reach you. Reply the same day.',
    'Before you book the call, read Parents On Board and Financial Readiness. If they are under 18 a parent has to be on the call, which is already the rule in your pre-call video, so tell them that when you book rather than discovering it live.'
  ];
}

// Turn "@handle" into a clickable link in the sheet so one click opens the profile
// (real account opens, fake shows "page not available"). The handle is already
// format-checked on the form, so it's safe to drop straight into the formula.
function igLink(ig) {
  ig = ig || '';
  if (!ig) return '';
  return '=HYPERLINK("https://instagram.com/' + ig.replace(/^@/, '') + '","' + ig + '")';
}

/**
 * Returns the tab, creating it (intro block + headers) if it does not exist, and
 * repairing the header row in place if it has drifted. The script is the single
 * source of truth for what the columns are called: add one to the HEADERS list
 * above and the sheet catches up on the next submission, with no hand-editing.
 */
function getOrCreateSheet(ss, name, headers, intro) {
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1).setValue(intro[0]);
    sh.getRange(2, 1).setValue(intro[1]);
    sh.getRange(3, 1).setValue(intro[2]);
    sh.getRange(HEADER_ROW, 1, 1, headers.length).setValues([headers]);
    return sh;
  }
  var need = sh.getRange(HEADER_ROW, 1, 1, headers.length).getValues()[0];
  for (var i = 0; i < headers.length; i++) {
    if (need[i] !== headers[i]) {
      sh.getRange(HEADER_ROW, 1, 1, headers.length).setValues([headers]);
      break;
    }
  }
  return sh;
}

/* ============================================================================
 * ONE-OFF: formatWorkbook()
 * Run this by hand from the editor (Run -> formatWorkbook) to lay the brand
 * styling over every tab. It is idempotent, so running it twice is harmless and
 * it is the thing to re-run if the workbook ever looks wrong again. doPost never
 * calls it, so it costs nothing to leave here.
 * ==========================================================================*/
var BRAND = {
  purple: '#96318d',
  blue:   '#058890',   // the deep blue. Never the light #06aeb9 under white text.
  orange: '#d35400',
  tan:    '#fff0d3',
  ink:    '#1f343b',
  soft:   '#f7f2e4',   // a paler tan, for the how-to-use rows
  zebra:  '#f4f4f4'
};

function formatWorkbook() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  prepAutoTab_(ss, 'Quiz Leads', QUIZ_HEADERS(), QUIZ_INTRO());
  prepAutoTab_(ss, 'Academy Applications', ACADEMY_HEADERS(), ACADEMY_INTRO());

  styleTab_(ss, 'Daily Log',            BRAND.purple, 9,  5, 6);
  styleTab_(ss, 'Totals',               BRAND.orange, 3,  5, 0);
  styleTab_(ss, 'Weekly',               BRAND.blue,   8,  5, 0);
  styleTab_(ss, 'Quiz Leads',           BRAND.blue,   14, HEADER_ROW, 0);
  styleTab_(ss, 'Academy Applications', BRAND.purple, 14, HEADER_ROW, 0);

  extras_(ss);
  SpreadsheetApp.flush();
}

/**
 * Moves an auto-filled tab onto the shared layout: four reserved rows at the top,
 * headers on row 5. Detects whether it has already been done by looking for the
 * title in A1, so a second run does not push everything down again.
 */
function prepAutoTab_(ss, name, headers, intro) {
  var sh = ss.getSheetByName(name);
  if (!sh) return;
  // Only INSERT the reserved rows if they are not there yet, or a second run pushes
  // everything down again. The text itself is rewritten every time, so editing the
  // intro in this file is enough to update the sheet.
  if (sh.getRange(1, 1).getValue() !== intro[0]) {
    sh.insertRowsBefore(1, 4);
  }
  sh.getRange(1, 1).setValue(intro[0]);
  sh.getRange(2, 1).setValue(intro[1]);
  sh.getRange(3, 1).setValue(intro[2]);
  // The old instruction cell that used to sit off to the right of the headers.
  sh.getRange(HEADER_ROW, headers.length + 2, 1, 4).clearContent();
  sh.getRange(HEADER_ROW, 1, 1, headers.length).setValues([headers]);
}

function styleTab_(ss, name, accent, cols, headerRow, subRow) {
  var sh = ss.getSheetByName(name);
  if (!sh) return;
  var maxRows = sh.getMaxRows();

  sh.setTabColor(accent);

  // --- rows 1-3: the title bar and the how-to-use block ---
  mergeRow_(sh, 1, cols);
  mergeRow_(sh, 2, cols);
  mergeRow_(sh, 3, cols);

  sh.getRange(1, 1, 1, cols)
    .setBackground(accent).setFontColor('#ffffff')
    .setFontSize(14).setFontWeight('bold')
    .setVerticalAlignment('middle');
  sh.setRowHeight(1, 34);

  sh.getRange(2, 1, 2, cols)
    .setBackground(BRAND.soft).setFontColor(BRAND.ink)
    .setFontSize(10).setFontWeight('normal').setWrap(true)
    .setVerticalAlignment('middle');
  // Merged cells do not auto-fit their height in Sheets, so wrapped instruction
  // text clips unless the height is set explicitly. Generous on purpose: extra
  // whitespace in a callout block reads fine, a half-cut sentence does not.
  sh.setRowHeight(2, 46);
  sh.setRowHeight(3, 60);

  sh.getRange(4, 1, 1, cols).setBackground(null);
  sh.setRowHeight(4, 8);

  // --- the header row ---
  sh.getRange(headerRow, 1, 1, cols)
    .setBackground(accent).setFontColor('#ffffff')
    .setFontWeight('bold').setFontSize(11)
    .setVerticalAlignment('middle').setWrap(true);
  sh.setRowHeight(headerRow, 30);

  // --- the small grey definition row, where a tab has one ---
  if (subRow) {
    sh.getRange(subRow, 1, 1, cols)
      .setBackground(BRAND.tan).setFontColor('#6b6b6b')
      .setFontSize(9).setFontStyle('italic').setWrap(true);
    sh.setRowHeight(subRow, 30);
  }

  sh.setFrozenRows(subRow ? subRow : headerRow);

  var firstData = (subRow ? subRow : headerRow) + 1;
  if (maxRows >= firstData) {
    sh.getRange(firstData, 1, maxRows - firstData + 1, cols)
      .setBackground('#ffffff').setFontColor(BRAND.ink)
      .setFontSize(10).setFontWeight('normal').setFontStyle('normal');
  }
}

function mergeRow_(sh, row, cols) {
  var r = sh.getRange(row, 1, 1, cols);
  // Break first, then merge. A narrower merge left over from a previous run makes
  // isPartOfMerge() true for the wider range, so a plain "merge if not merged" check
  // silently leaves the new last column outside the block. Adding a column to a tab is
  // exactly when that happens, which is exactly when this runs.
  r.breakApart();
  r.merge();
  return r;
}

function extras_(ss) {
  var log = ss.getSheetByName('Daily Log');
  if (log) {
    [['A',110],['B',60],['C',80],['D',105],['E',95],['F',90],['G',60],['H',95],['I',260]]
      .forEach(function (w, i) { log.setColumnWidth(i + 1, w[1]); });
    log.getRange(7, 1, log.getMaxRows() - 6, 1).setNumberFormat('ddd  mm/dd/yyyy');
    log.getRange(7, 8, log.getMaxRows() - 6, 1).setNumberFormat('$#,##0');
    log.getRange(7, 2, log.getMaxRows() - 6, 7).setHorizontalAlignment('center');
    // Weekends greyed, so a week reads as a block instead of a wall of rows.
    var dates = log.getRange(7, 1, 63, 1).getValues();
    for (var i = 0; i < dates.length; i++) {
      var d = dates[i][0];
      if (d instanceof Date && (d.getDay() === 0 || d.getDay() === 6)) {
        log.getRange(7 + i, 1, 1, 9).setBackground(BRAND.zebra);
      }
    }
  }

  var tot = ss.getSheetByName('Totals');
  if (tot) {
    tot.setColumnWidth(1, 230); tot.setColumnWidth(2, 110); tot.setColumnWidth(3, 620);
    [5, 15, 23].forEach(function (r) {
      tot.getRange(r, 1, 1, 3).setBackground(BRAND.tan).setFontWeight('bold')
        .setFontColor(BRAND.ink).setFontSize(11);
    });
    tot.getRange(6, 2, 23, 1).setHorizontalAlignment('center').setFontWeight('bold').setFontSize(12);
    tot.getRange(6, 3, 23, 1).setWrap(true).setFontSize(9).setFontColor('#6b6b6b');
    // The one input cell on the tab, marked so it cannot be mistaken for a result.
    tot.getRange(24, 2).setBackground(BRAND.tan).setFontColor(BRAND.orange)
      .setBorder(true, true, true, true, false, false, BRAND.orange, SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
    tot.getRange(25, 1, 2, 1).setFontWeight('bold').setFontColor(BRAND.blue);
    tot.getRange(25, 2, 2, 1).setFontColor(BRAND.blue);
  }

  var wk = ss.getSheetByName('Weekly');
  if (wk) {
    wk.setColumnWidth(1, 110);
    for (var c = 2; c <= 8; c++) wk.setColumnWidth(c, 95);
    wk.getRange(6, 1, 12, 1).setNumberFormat('mm/dd/yyyy').setFontWeight('bold');
    wk.getRange(6, 8, 12, 1).setNumberFormat('$#,##0');
    wk.getRange(6, 2, 12, 7).setHorizontalAlignment('center');
    for (var r = 6; r <= 17; r += 2) wk.getRange(r, 1, 1, 8).setBackground(BRAND.zebra);
  }

  var quiz = ss.getSheetByName('Quiz Leads');
  if (quiz) {
    quiz.setColumnWidth(1, 145); quiz.setColumnWidth(2, 110); quiz.setColumnWidth(3, 210);
    quiz.setColumnWidth(4, 150); quiz.setColumnWidth(11, 150);
    quiz.setColumnWidth(12, 90); quiz.setColumnWidth(13, 100);
    for (var q = 5; q <= 10; q++) quiz.setColumnWidth(q, 220);
    quiz.getRange(6, 12, quiz.getMaxRows() - 5, 2).setHorizontalAlignment('center');
    // "In Their Words" is free text, so it is the one column that has to wrap and the
    // one worth giving real width to. Top-aligned, or a long answer pushes its own row
    // taller and leaves the rest of the row floating in the middle.
    quiz.setColumnWidth(14, 460);
    quiz.getRange(HEADER_ROW, 14, quiz.getMaxRows() - HEADER_ROW + 1, 1)
        .setWrap(true).setVerticalAlignment('top');
  }

  var app = ss.getSheetByName('Academy Applications');
  if (app) {
    app.setColumnWidth(1, 145);
    for (var a = 2; a <= 14; a++) app.setColumnWidth(a, 130);
  }
}
