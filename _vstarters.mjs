import { HR_TEMPLATE_STARTERS } from './data/hrTemplateStarters.js';
import { extractVariables } from './services/hrDocumentService.js';

// The authoritative list, mirroring buildEmployeeContext() keys.
const VALID = ['employeeName','empId','designation','department','joiningDate','salary',
  'grossSalary','basicSalary','employeeMobile','employeeEmail','employeeAddress',
  'reportingManager','workLocation','employmentType','companyName','today',
  'lastWorkingDay','exitDate','exitReason','exitType','resignationDate','tenure','settlementNetPayable'];

let bad = 0;
console.log('starters: ' + HR_TEMPLATE_STARTERS.length + '\n');
for (const s of HR_TEMPLATE_STARTERS) {
  const vars = extractVariables(s.content);
  const unknown = vars.filter(v => !VALID.includes(v));
  const paragraphs = s.content.trim().split(/\n{2,}/).length;
  console.log(s.key.padEnd(24) + s.documentType.padEnd(24) + 'vars=' + vars.length + ' paras=' + paragraphs);
  if (unknown.length) { console.log('   !! UNKNOWN VARS: ' + JSON.stringify(unknown)); bad++; }
  if (!['Offer Letter','Appointment Letter','NDA','Relieving Letter','Experience Certificate','Other'].includes(s.documentType)) {
    console.log('   !! BAD documentType: ' + s.documentType); bad++;
  }
  if (!s.templateName || !s.content.trim()) { console.log('   !! empty name/content'); bad++; }
}
// all five document types except 'Other' should be covered
const types = HR_TEMPLATE_STARTERS.map(s => s.documentType);
console.log('\ncovered types: ' + JSON.stringify(types));
const keys = HR_TEMPLATE_STARTERS.map(s => s.key);
console.log('unique keys: ' + (new Set(keys).size === keys.length ? 'yes' : 'NO - DUPLICATE'));
console.log('\n' + (bad ? bad + ' PROBLEM(S)' : 'ALL STARTERS VALID'));
