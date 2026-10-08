export function companyDisplayName(company: { publicName: string | null; legalName: string }): string {
  return company.publicName ?? company.legalName;
}
