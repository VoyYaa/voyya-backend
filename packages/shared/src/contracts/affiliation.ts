import { z } from 'zod';
import {
  BaseFareCop,
  CommissionPct,
  IsoDate,
  OPS_LIST_DEFAULT_LIMIT,
  OPS_LIST_MAX_LIMIT,
  SurchargePct,
} from './admin';
import { Phone } from './auth';
import { DocumentStorageKey, DocumentVerificationStatus, NotificationDelivery } from './documents';
import { CompanyCommission, MunicipalityFare } from './service-config';
import {
  ActivatableServiceType,
  ActiveServiceTypes,
  CompanyPublicName,
  ServiceType,
} from './trips';

export const TaxId = z
  .string()
  .trim()
  .regex(/^\d{9,10}(-\d)?$/, 'NIT inválido (9 o 10 dígitos, con dígito de verificación opcional)');
export type TaxId = z.infer<typeof TaxId>;

export const CompanyStatus = z.enum(['pending', 'active', 'suspended', 'rejected']);
export type CompanyStatus = z.infer<typeof CompanyStatus>;

export const CompanyProfile = z.object({
  company_id: z.number().int().positive(),
  tax_id: z.string(),
  status: CompanyStatus,
  municipality_coverage_active: z.boolean(),
  display_name: z.string(),
  service_types: z.array(ServiceType),
});
export type CompanyProfile = z.infer<typeof CompanyProfile>;

export const CompanyLegalForm = z.enum([
  'cooperative',
  'corporation',
  'sole_proprietorship',
  'other',
]);
export type CompanyLegalForm = z.infer<typeof CompanyLegalForm>;

export const CompanyDocumentType = z.enum([
  'chamber_of_commerce',
  'tax_registry',
  'transport_authorization',
  'liability_insurance',
]);
export type CompanyDocumentType = z.infer<typeof CompanyDocumentType>;

export const REQUIRED_COMPANY_DOCUMENT_TYPES = [
  'chamber_of_commerce',
  'tax_registry',
  'transport_authorization',
  'liability_insurance',
] as const satisfies readonly CompanyDocumentType[];

export const CompanyDecision = z.enum([
  'approved',
  'documents_requested',
  'rejected',
  'credentials_reissued',
]);
export type CompanyDecision = z.infer<typeof CompanyDecision>;

export const DaneCode = z.string().regex(/^\d{5}$/, 'Código DIVIPOLA inválido (5 dígitos)');
export type DaneCode = z.infer<typeof DaneCode>;

export const AffiliationMunicipality = z.object({
  municipality_id: z.number().int().positive(),
  dane_code: DaneCode,
  department_code: z.string().regex(/^\d{2}$/),
  name: z.string(),
  department: z.string(),
  already_covered: z.boolean(),
  has_active_companies: z.boolean(),
  coverage_active: z.boolean(),
});
export type AffiliationMunicipality = z.infer<typeof AffiliationMunicipality>;

export const MunicipalityCatalogSource = z.object({
  name: z.string(),
  cut_date: IsoDate,
  attribution: z.string(),
  license: z.string(),
});
export type MunicipalityCatalogSource = z.infer<typeof MunicipalityCatalogSource>;

export const AffiliationMunicipalityListResponse = z.object({
  rows: z.array(AffiliationMunicipality),
  source: MunicipalityCatalogSource,
  active_service_types: ActiveServiceTypes,
});
export type AffiliationMunicipalityListResponse = z.infer<
  typeof AffiliationMunicipalityListResponse
>;

export const AffiliationDocumentInput = z.object({
  type: CompanyDocumentType,
  storage_key: DocumentStorageKey,
  issued_at: IsoDate.optional(),
  expires_at: IsoDate.optional(),
});
export type AffiliationDocumentInput = z.infer<typeof AffiliationDocumentInput>;

export const CreateAffiliationApplicationDTO = z
  .object({
    legal_name: z.string().trim().min(3).max(150),
    public_name: CompanyPublicName.optional(),
    tax_id: TaxId,
    legal_form: CompanyLegalForm,
    municipality_id: z.number().int().positive(),
    vehicle_count: z.number().int().min(1).max(1000),
    contact_first_name: z.string().trim().min(1).max(80),
    contact_last_name: z.string().trim().min(1).max(80),
    contact_email: z.string().trim().toLowerCase().email().max(254),
    contact_phone: Phone,
    service_types: z.array(ActivatableServiceType).min(1).max(3).default(['taxi']),
    documents: z.array(AffiliationDocumentInput).min(1).max(4),
  })
  .refine((d) => new Set(d.service_types).size === d.service_types.length, {
    message: 'Los servicios no pueden repetirse',
    path: ['service_types'],
  });
export type CreateAffiliationApplicationDTO = z.infer<typeof CreateAffiliationApplicationDTO>;

export const AffiliationApplicationCreated = z.object({
  company_id: z.number().int().positive(),
  legal_name: z.string(),
  tax_id: z.string(),
  status: CompanyStatus,
  municipality_name: z.string(),
  contact_email: z.string(),
  submitted_at: z.string().datetime(),
});
export type AffiliationApplicationCreated = z.infer<typeof AffiliationApplicationCreated>;

export const AffiliationDocument = z.object({
  company_document_id: z.number().int().positive(),
  type: CompanyDocumentType,
  file_name: z.string(),
  content_type: z.string(),
  size_bytes: z.number().int().nonnegative(),
  verification: DocumentVerificationStatus,
  review_note: z.string().nullable(),
  issued_at: IsoDate.nullable(),
  expires_at: IsoDate.nullable(),
  uploaded_at: z.string().datetime(),
  verified_at: z.string().datetime().nullable(),
});
export type AffiliationDocument = z.infer<typeof AffiliationDocument>;

export const ReplaceAffiliationDocumentDTO = AffiliationDocumentInput;
export type ReplaceAffiliationDocumentDTO = z.infer<typeof ReplaceAffiliationDocumentDTO>;

export const PlatformCompanyStatusFilter = z.enum(['pending', 'active', 'rejected', 'all']);
export type PlatformCompanyStatusFilter = z.infer<typeof PlatformCompanyStatusFilter>;

export const PlatformCompanyQuery = z.object({
  status: PlatformCompanyStatusFilter.default('pending'),
  municipality_id: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(OPS_LIST_MAX_LIMIT).default(OPS_LIST_DEFAULT_LIMIT),
});
export type PlatformCompanyQuery = z.infer<typeof PlatformCompanyQuery>;

export const PlatformCompanyRow = z.object({
  company_id: z.number().int().positive(),
  legal_name: z.string(),
  tax_id: z.string(),
  status: CompanyStatus,
  municipality_id: z.number().int().positive(),
  municipality_name: z.string(),
  municipality_already_covered: z.boolean(),
  municipality_dane_code: DaneCode.nullable(),
  municipality_coverage_active: z.boolean(),
  display_name: z.string(),
  service_types: z.array(ServiceType),
  coverage_pending_since: z.string().datetime().nullable(),
  vehicle_count: z.number().int().nullable(),
  contact_email: z.string().nullable(),
  submitted_at: z.string().datetime(),
});
export type PlatformCompanyRow = z.infer<typeof PlatformCompanyRow>;

export const PlatformCompanyListResponse = z.object({
  server_time: z.string().datetime(),
  pending_count: z.number().int().nonnegative(),
  rows: z.array(PlatformCompanyRow),
});
export type PlatformCompanyListResponse = z.infer<typeof PlatformCompanyListResponse>;

export const PlatformCompanyDocument = AffiliationDocument.extend({
  download_url: z.string().url(),
  download_url_expires_at: z.string().datetime(),
});
export type PlatformCompanyDocument = z.infer<typeof PlatformCompanyDocument>;

export const PlatformCompanyReview = z.object({
  company_review_id: z.number().int().positive(),
  decision: CompanyDecision,
  note: z.string().nullable(),
  acknowledged_routing_limitation: z.boolean(),
  municipality_active_company_name: z.string().nullable(),
  requested_document_types: z.array(CompanyDocumentType),
  reviewer_name: z.string(),
  decided_at: z.string().datetime(),
});
export type PlatformCompanyReview = z.infer<typeof PlatformCompanyReview>;

export const PlatformCompanyDetail = PlatformCompanyRow.extend({
  server_time: z.string().datetime(),
  legal_form: z.string(),
  municipality_department: z.string(),
  municipality_active_company_name: z.string().nullable(),
  public_name: z.string().nullable(),
  municipality_active_companies: z.array(
    z.object({ company_id: z.number().int().positive(), legal_name: z.string() }),
  ),
  municipality_fares: z.array(
    z.object({ service_type: ServiceType, fare: MunicipalityFare.nullable() }),
  ),
  commission: CompanyCommission.nullable(),
  contact_first_name: z.string().nullable(),
  contact_last_name: z.string().nullable(),
  contact_phone: z.string().nullable(),
  documents: z.array(PlatformCompanyDocument),
  reviews: z.array(PlatformCompanyReview),
});
export type PlatformCompanyDetail = z.infer<typeof PlatformCompanyDetail>;

export const ApproveCompanyInitialFare = z.object({
  base_fare: BaseFareCop,
  night_surcharge_pct: SurchargePct.optional(),
  holiday_surcharge_pct: SurchargePct.optional(),
});
export type ApproveCompanyInitialFare = z.infer<typeof ApproveCompanyInitialFare>;

export const ApproveCompanyDTO = z.object({
  initial_fare: ApproveCompanyInitialFare.optional(),
  commission_pct: CommissionPct,
  note: z.string().trim().max(500).optional(),
});
export type ApproveCompanyDTO = z.infer<typeof ApproveCompanyDTO>;

export const RequestCompanyDocumentsDTO = z.object({
  document_types: z.array(CompanyDocumentType).min(1).max(4),
  note: z.string().trim().min(10).max(500),
});
export type RequestCompanyDocumentsDTO = z.infer<typeof RequestCompanyDocumentsDTO>;

export const RejectCompanyDTO = z.object({
  note: z.string().trim().min(10).max(500),
});
export type RejectCompanyDTO = z.infer<typeof RejectCompanyDTO>;

export const CompanyNotificationResult = z.object({
  channel: z.literal('email'),
  to: z.string(),
  delivery: NotificationDelivery,
});
export type CompanyNotificationResult = z.infer<typeof CompanyNotificationResult>;

export const CompanyProvisioningResult = z.object({
  fare_config_id: z.number().int().positive().nullable(),
  municipality_fares: z.array(
    z.object({
      service_type: ServiceType,
      municipality_fare_id: z.number().int().positive(),
      created: z.boolean(),
    }),
  ),
  company_commission_id: z.number().int().positive(),
  admin_user_id: z.number().int().positive(),
  admin_email: z.string(),
});
export type CompanyProvisioningResult = z.infer<typeof CompanyProvisioningResult>;

export const CompanyDecisionResponse = z.object({
  company_id: z.number().int().positive(),
  status: CompanyStatus,
  decision: CompanyDecision,
  decided_at: z.string().datetime(),
  acknowledged_routing_limitation: z.boolean(),
  municipality_coverage_active: z.boolean(),
  notification: CompanyNotificationResult,
  provisioning: CompanyProvisioningResult.nullable(),
});
export type CompanyDecisionResponse = z.infer<typeof CompanyDecisionResponse>;

export const ResendCompanyNotificationResponse = z.object({
  company_id: z.number().int().positive(),
  decision: CompanyDecision,
  notification: CompanyNotificationResult,
});
export type ResendCompanyNotificationResponse = z.infer<typeof ResendCompanyNotificationResponse>;

export const AffiliationErrorCode = z.enum([
  'TAX_ID_TAKEN',
  'APPLICATION_IN_REVIEW',
  'APPLICATION_NOT_PENDING',
  'CONTACT_PHONE_TAKEN',
  'CONTACT_EMAIL_TAKEN',
  'MUNICIPALITY_NOT_FOUND',
  'DOCUMENTS_INCOMPLETE',
  'DOCUMENT_TOO_LARGE',
  'DOCUMENT_TYPE_NOT_ALLOWED',
  'DOCUMENT_NOT_FOUND',
  'AFFILIATION_LINK_INVALID',
  'AFFILIATION_LINK_EXPIRED',
  'DOCUMENT_STORAGE_UNAVAILABLE',
  'SERVICE_NOT_AVAILABLE',
]);
export type AffiliationErrorCode = z.infer<typeof AffiliationErrorCode>;

export const AffiliationError = z.object({
  code: AffiliationErrorCode,
  message: z.string(),
  field: z.string().optional(),
  missing_documents: z.array(CompanyDocumentType).optional(),
});
export type AffiliationError = z.infer<typeof AffiliationError>;

export const PlatformErrorCode = z.enum([
  'COMPANY_NOT_FOUND',
  'COMPANY_NOT_PENDING',
  'MUNICIPALITY_ALREADY_COVERED',
  'CONTACT_ACCOUNT_CONFLICT',
  'NO_DECISION_TO_RESEND',
  'MUNICIPALITY_FARE_REQUIRED',
  'SERVICE_NOT_AVAILABLE',
  'SETTINGS_CONFLICT',
]);
export type PlatformErrorCode = z.infer<typeof PlatformErrorCode>;

export const PlatformError = z.object({
  code: PlatformErrorCode,
  message: z.string(),
  field: z.string().optional(),
  municipality_active_company_name: z.string().optional(),
});
export type PlatformError = z.infer<typeof PlatformError>;
