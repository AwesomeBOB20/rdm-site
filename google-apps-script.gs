/**
 * RDM lead capture → ONE spreadsheet, TWO tabs (no special permissions needed).
 *   - router quiz  → "Quiz Leads" tab
 *   - Academy app  → "Academy Applications" tab
 * Both tabs + their headers are created automatically on the first submission.
 *
 * After pasting this in: Deploy → Manage deployments → pencil (edit)
 * → Version: New version → Deploy. (Keeps the SAME url.)
 */
function doPost(e) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var data = JSON.parse(e.postData.contents);
    var type = data.formType || 'quiz';

    if (type === 'academy') {
      var sh = getOrCreateSheet(ss, 'Academy Applications', [
        'Date','First Name','Last Name','Email','Phone','Instagram','Age',
        'Player Level','#1 Goal','Struggles','Hours/Week','Watched Video',
        'Parents On Board','Financial Readiness'
      ]);
      sh.appendRow([
        new Date(), data.firstName||'', data.lastName||'', data.email||'',
        data.phone||'', igLink(data.instagram), data.age||'', data.level||'',
        data.goal||'', data.challenges||'', data.hours||'', data.watchedVideo||'',
        data.parents||'', data.finances||''
      ]);
    } else {
      var ans = data.answers || [];
      var qs = getOrCreateSheet(ss, 'Quiz Leads', [
        'Date','First Name','Email','Recommended Product',
        'Q1','Q2','Q3','Q4','Q5','Q6','Instagram'
      ]);
      qs.appendRow(
        [ new Date(), data.firstName||'', data.email||'', data.product||'' ]
          .concat(ans)
          .concat([ igLink(data.instagram) ])
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

// Turn "@handle" into a clickable link in the sheet so one click opens the profile
// (real account opens, fake shows "page not available"). The handle is already
// format-checked on the form, so it's safe to drop straight into the formula.
function igLink(ig) {
  ig = ig || '';
  if (!ig) return '';
  return '=HYPERLINK("https://instagram.com/' + ig.replace(/^@/, '') + '","' + ig + '")';
}

function getOrCreateSheet(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); }
  if (sh.getLastRow() === 0) { sh.appendRow(headers); }
  return sh;
}
