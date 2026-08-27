const numberValue = (value) => Number(value) || 0;

export const buildSalarySnapshot = (employee, month, year, generatedBy, branch) => {
  const pf = numberValue(employee.pf);
  const esi = numberValue(employee.esi);
  const professionalTax = numberValue(employee.professionalTax);
  const tds = numberValue(employee.tds);
  const otherDeductions = numberValue(employee.otherDeductions);

  return {
    branch,
    employee: employee._id,
    month,
    year,
    basicSalary: numberValue(employee.basicSalary),
    hra: numberValue(employee.hra),
    conveyance: numberValue(employee.conveyance),
    medicalAllowance: numberValue(employee.medicalAllowance),
    specialAllowance: numberValue(employee.specialAllowance),
    otherAllowance: numberValue(employee.otherAllowance),
    pf,
    esi,
    professionalTax,
    tds,
    otherDeductions,
    grossEarnings: numberValue(employee.grossSalary),
    grossDeductions: pf + esi + professionalTax + tds + otherDeductions,
    netSalary: numberValue(employee.netSalary),
    status: 'Draft',
    generatedBy,
    tallySyncStatus: 'not_synced',
  };
};
