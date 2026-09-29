/**
 * Ready-made HR letter bodies.
 *
 * These exist because a blank textarea is the hardest possible starting point: an
 * admin who has never written an offer letter has to invent the wording *and* the
 * {{placeholders}} before they can produce anything. Every placeholder used here is
 * backed by a real field in `buildEmployeeContext` (routes/hrTemplateRoutes.js), so
 * a starter dropped in unchanged renders a complete letter on the first try.
 *
 * Shared between the web admin (the "start from a ready template" picker) and the
 * backend seeder, so there is one source of truth for the wording.
 *
 * Editing rules that matter:
 *  - Paragraphs are separated by a BLANK line. `generateHrDocumentPdf` splits on
 *    /\n{2,}/, so a single newline does not start a new paragraph.
 *  - Only use variables from the field-map, or the placeholder stays visible in the
 *    generated PDF (which is deliberate, but ugly in a letter).
 */

export const HR_TEMPLATE_STARTERS = [
  {
    key: 'offer-letter',
    documentType: 'Offer Letter',
    templateName: 'Standard Offer Letter',
    summary: 'Initial offer with designation, CTC and joining date.',
    content: `{{today}}

Dear {{employeeName}},

We are pleased to offer you the position of {{designation}} in the {{department}} department at {{companyName}}.

Your annual cost to company will be Rs. {{salary}}, and your gross monthly salary will be Rs. {{grossSalary}}.

Your expected date of joining is {{joiningDate}}. Your place of posting will be {{workLocation}}.

You will report to {{reportingManager}}.

This offer is subject to the satisfactory verification of your documents and references. Please confirm your acceptance by signing and returning a copy of this letter.

We look forward to welcoming you to the team.

Yours sincerely,

{{companyName}}
Human Resources Department`,
  },

  {
    key: 'appointment-letter',
    documentType: 'Appointment Letter',
    templateName: 'Standard Appointment Letter',
    summary: 'Confirmed appointment after the candidate accepts the offer.',
    content: `{{today}}

Dear {{employeeName}},

With reference to your acceptance of our offer, we are pleased to confirm your appointment as {{designation}} in the {{department}} department at {{companyName}}, with effect from {{joiningDate}}.

Your employee code is {{empId}}. Your annual cost to company is Rs. {{salary}} and your gross monthly salary is Rs. {{grossSalary}}.

Your employment is on a {{employmentType}} basis. Your place of posting will be {{workLocation}}.

You will report to {{reportingManager}}.

You will be governed by the rules, policies and code of conduct of the company as amended from time to time. Your appointment is subject to the satisfactory completion of your probation period.

Please sign and return the duplicate copy of this letter as a token of your acceptance.

Yours sincerely,

{{companyName}}
Human Resources Department`,
  },

  {
    key: 'nda',
    documentType: 'NDA',
    templateName: 'Non-Disclosure Agreement',
    summary: 'Confidentiality undertaking for a named employee.',
    content: `{{today}}

NON-DISCLOSURE AGREEMENT

Between: {{companyName}} ("the Company")

And: {{employeeName}}, Employee Code {{empId}}, {{designation}} ("the Employee")

1. The Employee acknowledges that in the course of employment with the Company they will receive access to confidential information, including but not limited to customer and dealer data, pricing, supplier terms, business plans and technical know-how.

2. The Employee agrees to keep all such confidential information strictly private and not to disclose, publish or share it with any third party, during or after the period of employment.

3. The Employee agrees not to use any confidential information for personal gain or for any purpose other than the discharge of their duties to the Company.

4. All records, documents and data relating to the business of the Company remain the sole property of the Company and must be returned upon the termination of employment.

5. This agreement shall remain in force during the employment of the Employee and shall continue to bind the Employee after the termination of employment.

Signed at {{workLocation}} on {{today}}.

For {{companyName}}                                     {{employeeName}}

Authorised Signatory                                    Employee`,
  },

  {
    key: 'relieving-letter',
    documentType: 'Relieving Letter',
    templateName: 'Standard Relieving Letter',
    summary: 'Confirms release on the last working day. Reads from the exit case.',
    content: `{{today}}

Dear {{employeeName}},

This is to certify that {{employeeName}}, Employee Code {{empId}}, has been relieved from the services of {{companyName}} with effect from the close of business on {{lastWorkingDay}}.

You joined the company on {{joiningDate}} and served with us for a period of {{tenure}} as {{designation}} in the {{department}} department.

During your tenure your conduct and performance were found to be satisfactory, and you have handed over all company property and completed the necessary clearance formalities.

We thank you for your contribution to the organisation and wish you success in your future endeavours.

Yours sincerely,

{{companyName}}
Human Resources Department`,
  },

  {
    key: 'experience-certificate',
    documentType: 'Experience Certificate',
    templateName: 'Standard Experience Certificate',
    summary: 'To-whom-it-concerns service certificate for an exiting employee.',
    content: `{{today}}

TO WHOMSOEVER IT MAY CONCERN

This is to certify that {{employeeName}}, Employee Code {{empId}}, was employed with {{companyName}} from {{joiningDate}} to {{lastWorkingDay}}.

During this period they worked as {{designation}} in the {{department}} department, and their total association with the organisation was {{tenure}}.

Their conduct and performance during the period of employment were found to be satisfactory. They were relieved from the services of the company on {{lastWorkingDay}} after completing all clearance formalities.

We wish them continued success in all future endeavours.

For {{companyName}}

Authorised Signatory
Human Resources Department`,
  },
];

export default HR_TEMPLATE_STARTERS;
