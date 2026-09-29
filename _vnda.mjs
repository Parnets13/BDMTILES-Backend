import { HR_TEMPLATE_STARTERS } from './data/hrTemplateStarters.js';
import { renderTemplate } from './services/hrDocumentService.js';

const ctx = { employeeName:'Ravi Kumar', empId:'EMP0042', designation:'Sales Executive', department:'Sales',
  companyName:'BDM GRANIMARMO PRIVATE LIMITED', today:'28 September 2026', workLocation:'Jaipur',
  joiningDate:'01 October 2026', lastWorkingDay:'30 September 2026', tenure:'3 years 2 months' };

const nda = HR_TEMPLATE_STARTERS.find(s => s.key === 'nda');
const rendered = renderTemplate(nda.content, ctx);
console.log('=== NDA as rendered, paragraphs shown as [..] ===');
rendered.trim().split(/\n{2,}/).forEach((p, i) => console.log('[' + (i+1) + '] ' + p.trim().replace(/\n/g, ' ~ ')));
