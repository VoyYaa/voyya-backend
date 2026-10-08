import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  ApproveCompanyDTO,
  CompanyDecisionResponse,
  CompanyDocumentType,
  PlatformCompanyDetail,
  PlatformCompanyListResponse,
  PlatformCompanyQuery,
  RejectCompanyDTO,
  RequestCompanyDocumentsDTO,
  ResendCompanyNotificationResponse,
} from '@voyyaa/shared';
import { EnvService } from '../../config/env.service';
import { isDeadlock, retryOnDeadlock } from '../../shared/deadlock';
import { generateTemporaryPassword } from '../../shared/temporary-password';
import { HASHER, type Hasher } from '../auth/hasher.service';
import { CompanyCommissionReader } from '../service-config/company-commission.reader';
import { MunicipalityFareReader } from '../service-config/municipality-fare.reader';
import { ServiceCatalog } from '../service-config/service-catalog';
import { settingsConflict } from '../service-config/service-config.errors';
import { toCommissionDto, toNullableFareDto } from '../service-config/service-config.mappers';
import { ServiceConfigProvisioner } from '../service-config/service-config-provisioner';
import { CompanyProvisioningService } from '../tenancy/company-provisioning.service';
import { DocumentDownloadTokenService } from './document-download-token.service';
import { EMAIL_PROVIDER, type EmailProvider } from './ports/email-provider.port';
import {
  approvedCompanyEmail,
  documentsRequestedEmail,
  rejectedCompanyEmail,
} from './messages';
import { AffiliationLinkService } from './affiliation-link.service';
import { PlatformCompanyRepository } from './platform-company.repository';

@Injectable()
export class PlatformCompanyService {
  constructor(
    private readonly repo: PlatformCompanyRepository,
    private readonly provisioning: CompanyProvisioningService,
    private readonly serviceConfig: ServiceConfigProvisioner,
    private readonly catalog: ServiceCatalog,
    private readonly fares: MunicipalityFareReader,
    private readonly commissions: CompanyCommissionReader,
    private readonly links: AffiliationLinkService,
    private readonly downloadTokens: DocumentDownloadTokenService,
    private readonly env: EnvService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    @Inject(HASHER) private readonly hasher: Hasher,
  ) {}

  async list(query: PlatformCompanyQuery): Promise<PlatformCompanyListResponse> {
    const [rows, pendingCount] = await Promise.all([
      this.repo.listCompanies(query.status, query.municipality_id ?? null, query.limit),
      this.repo.countPending(),
    ]);
    const awaitingCoverage = rows
      .filter((r) => r.status === 'active' && !r.municipalityCoverageActive)
      .map((r) => r.companyId);
    const approvalDates = await this.repo.findApprovalDates(awaitingCoverage);
    return {
      server_time: new Date().toISOString(),
      pending_count: pendingCount,
      rows: rows.map((r) => ({
        company_id: r.companyId,
        legal_name: r.legalName,
        tax_id: r.taxId,
        status: r.status as PlatformCompanyListResponse['rows'][number]['status'],
        municipality_id: r.municipalityId,
        municipality_name: r.municipalityName,
        municipality_already_covered: r.municipalityAlreadyCovered,
        municipality_dane_code: r.municipalityDaneCode,
        municipality_coverage_active: r.municipalityCoverageActive,
        display_name: r.publicName ?? r.legalName,
        service_types: r.serviceTypes,
        coverage_pending_since: approvalDates.get(r.companyId)?.toISOString() ?? null,
        vehicle_count: r.vehicleCount,
        contact_email: r.contactEmail,
        submitted_at: r.submittedAt.toISOString(),
      })),
    };
  }

  async detail(companyId: number, platformAdminUserId: number): Promise<PlatformCompanyDetail> {
    const row = await this.repo.getDetail(companyId);
    if (!row) {
      throw new NotFoundException({ code: 'COMPANY_NOT_FOUND', message: 'La empresa no existe' });
    }

    const ttlSeconds = this.env.get('DOCUMENT_SIGNED_URL_TTL_SEC');
    const [documents, reviews, fares, commission] = await this.repo.runAsPlatform(async (tx) => {
      await this.repo.setTenantSession(tx, companyId);
      return Promise.all([
        this.repo.listDocuments(tx, companyId),
        this.repo.listReviews(tx, companyId),
        Promise.all(
          row.serviceTypes.map(async (serviceType) => ({
            service_type: serviceType,
            fare: toNullableFareDto(await this.fares.getCurrent(row.municipalityId, serviceType, tx)),
          })),
        ),
        this.commissions.getCurrent(tx, companyId),
      ]);
    });

    const documentsWithDownload = documents.map((d) => ({
      company_document_id: d.companyDocumentId,
      type: d.type as CompanyDocumentType,
      file_name: d.fileName,
      content_type: d.contentType,
      size_bytes: d.sizeBytes,
      verification: d.verification as PlatformCompanyDetail['documents'][number]['verification'],
      review_note: d.reviewNote,
      issued_at: d.issuedAt ? isoDate(d.issuedAt) : null,
      expires_at: d.expiresAt ? isoDate(d.expiresAt) : null,
      uploaded_at: d.uploadedAt.toISOString(),
      verified_at: d.verifiedAt ? d.verifiedAt.toISOString() : null,
      download_url: this.downloadTokens.buildUrl(d.companyDocumentId, companyId, platformAdminUserId),
      download_url_expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    }));

    const approvalDate =
      row.status === 'active' && !row.municipalityCoverageActive
        ? ((await this.repo.findApprovalDates([companyId])).get(companyId) ?? null)
        : null;

    return {
      company_id: row.companyId,
      legal_name: row.legalName,
      tax_id: row.taxId,
      status: row.status as PlatformCompanyDetail['status'],
      municipality_id: row.municipalityId,
      municipality_name: row.municipalityName,
      municipality_already_covered: row.municipalityAlreadyCovered,
      municipality_dane_code: row.municipalityDaneCode,
      municipality_coverage_active: row.municipalityCoverageActive,
      display_name: row.publicName ?? row.legalName,
      service_types: row.serviceTypes,
      coverage_pending_since: approvalDate ? approvalDate.toISOString() : null,
      vehicle_count: row.vehicleCount,
      contact_email: row.contactEmail,
      submitted_at: row.submittedAt.toISOString(),
      server_time: new Date().toISOString(),
      legal_form: row.legalForm,
      municipality_department: row.municipalityDepartment,
      municipality_active_company_name: row.otherActiveCompanies[0]?.legalName ?? null,
      public_name: row.publicName,
      municipality_active_companies: row.otherActiveCompanies.map((c) => ({
        company_id: c.companyId,
        legal_name: c.legalName,
      })),
      municipality_fares: fares,
      commission: commission ? toCommissionDto(commission) : null,
      contact_first_name: row.contactFirstName,
      contact_last_name: row.contactLastName,
      contact_phone: row.contactPhone,
      documents: documentsWithDownload,
      reviews: reviews.map((r) => ({
        company_review_id: r.companyReviewId,
        decision: r.decision as PlatformCompanyDetail['reviews'][number]['decision'],
        note: r.note,
        acknowledged_routing_limitation: r.acknowledgedRoutingLimitation,
        municipality_active_company_name: r.municipalityActiveCompanyName,
        requested_document_types: r.requestedDocumentTypes as CompanyDocumentType[],
        reviewer_name: r.reviewerName,
        decided_at: r.createdAt.toISOString(),
      })),
    };
  }

  async approve(
    companyId: number,
    dto: ApproveCompanyDTO,
    platformAdminUserId: number,
  ): Promise<CompanyDecisionResponse> {
    const temporaryPassword = generateTemporaryPassword();

    const outcome = await this.runApproval(() =>
      this.repo.runAsPlatform(async (tx) => {
        const activated = await this.repo.activateCompany(tx, companyId);
        if (!activated) {
          throw new ConflictException({
            code: 'COMPANY_NOT_PENDING',
            message: 'Esta solicitud ya fue resuelta',
          });
        }
        this.catalog.assertAllActive(activated.serviceTypes);

        await this.repo.setTenantSession(tx, activated.companyId);
        await this.repo.markAllDocumentsVerified(tx, activated.companyId, platformAdminUserId);

        const serviceConfig = await this.serviceConfig.ensureForApproval(tx, {
          companyId: activated.companyId,
          municipalityId: activated.municipalityId,
          serviceTypes: activated.serviceTypes,
          initialFare: dto.initial_fare
            ? {
                baseFare: dto.initial_fare.base_fare,
                nightSurchargePct: dto.initial_fare.night_surcharge_pct,
                holidaySurchargePct: dto.initial_fare.holiday_surcharge_pct,
              }
            : null,
          commissionPct: dto.commission_pct,
          createdBy: platformAdminUserId,
        });

        let finished;
        try {
          finished = await this.provisioning.finishProvisioning(tx, activated.companyId, {
            firstName: activated.contactFirstName ?? activated.legalName,
            lastName: activated.contactLastName ?? '',
            email: activated.contactEmail ?? '',
            phone: activated.contactPhone ?? '',
            password: temporaryPassword,
          });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new ConflictException({
              code: 'CONTACT_ACCOUNT_CONFLICT',
              message: 'El contacto de esta empresa ya tiene una cuenta en VoyYa',
            });
          }
          throw error;
        }

        const review = await this.repo.createReview(tx, {
          companyId: activated.companyId,
          decision: 'approved',
          note: dto.note ?? null,
          acknowledgedRoutingLimitation: false,
          municipalityActiveCompanyId: null,
          municipalityActiveCompanyName: null,
          requestedDocumentTypes: [],
          reviewedBy: platformAdminUserId,
        });

        return { activated, finished, review, serviceConfig };
      }),
    );

    const delivery = await this.sendSafely(() =>
      approvedCompanyEmail({
        legalName: outcome.activated.legalName,
        loginEmail: outcome.finished.adminEmail,
        temporaryPassword,
      }),
    );

    return {
      company_id: outcome.activated.companyId,
      status: 'active',
      decision: 'approved',
      decided_at: outcome.review.createdAt.toISOString(),
      acknowledged_routing_limitation: false,
      municipality_coverage_active: await this.repo.isCoverageActiveForCompany(outcome.activated.companyId),
      notification: { channel: 'email', to: outcome.finished.adminEmail, delivery },
      provisioning: {
        fare_config_id: null,
        municipality_fares: outcome.serviceConfig.municipalityFares.map((fare) => ({
          service_type: fare.serviceType,
          municipality_fare_id: fare.municipalityFareId,
          created: fare.created,
        })),
        company_commission_id: outcome.serviceConfig.companyCommissionId,
        admin_user_id: outcome.finished.adminUserId,
        admin_email: outcome.finished.adminEmail,
      },
    };
  }

  private async runApproval<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await retryOnDeadlock(operation);
    } catch (error) {
      if (isDeadlock(error)) throw settingsConflict();
      throw error;
    }
  }

  async requestDocuments(
    companyId: number,
    dto: RequestCompanyDocumentsDTO,
    platformAdminUserId: number,
  ): Promise<CompanyDecisionResponse> {
    const outcome = await this.repo.runTransaction(async (tx) => {
      const company = await this.repo.findPendingCompany(tx, companyId);
      if (!company) {
        throw new ConflictException({
          code: 'COMPANY_NOT_PENDING',
          message: 'Esta solicitud ya fue resuelta',
        });
      }
      await this.repo.setTenantSession(tx, companyId);
      await this.repo.markDocumentsRejected(tx, companyId, dto.document_types, dto.note);
      const review = await this.repo.createReview(tx, {
        companyId,
        decision: 'documents_requested',
        note: dto.note,
        acknowledgedRoutingLimitation: false,
        municipalityActiveCompanyId: null,
        municipalityActiveCompanyName: null,
        requestedDocumentTypes: dto.document_types,
        reviewedBy: platformAdminUserId,
      });
      return { company, review };
    });

    const delivery = outcome.company.contactEmail
      ? await this.sendSafely(() =>
          documentsRequestedEmail({
            legalName: outcome.company.legalName,
            contactEmail: outcome.company.contactEmail as string,
            note: dto.note,
            uploadUrl: this.links.buildUrl(companyId),
          }),
        )
      : ('failed' as const);

    return {
      company_id: companyId,
      status: 'pending',
      decision: 'documents_requested',
      decided_at: outcome.review.createdAt.toISOString(),
      acknowledged_routing_limitation: false,
      municipality_coverage_active: await this.repo.isCoverageActiveForCompany(companyId),
      notification: { channel: 'email', to: outcome.company.contactEmail ?? '', delivery },
      provisioning: null,
    };
  }

  async reject(
    companyId: number,
    dto: RejectCompanyDTO,
    platformAdminUserId: number,
  ): Promise<CompanyDecisionResponse> {
    const outcome = await this.repo.runTransaction(async (tx) => {
      const rejected = await this.repo.rejectCompany(tx, companyId);
      if (!rejected) {
        throw new ConflictException({
          code: 'COMPANY_NOT_PENDING',
          message: 'Esta solicitud ya fue resuelta',
        });
      }
      await this.repo.setTenantSession(tx, companyId);
      const review = await this.repo.createReview(tx, {
        companyId,
        decision: 'rejected',
        note: dto.note,
        acknowledgedRoutingLimitation: false,
        municipalityActiveCompanyId: null,
        municipalityActiveCompanyName: null,
        requestedDocumentTypes: [],
        reviewedBy: platformAdminUserId,
      });
      return { rejected, review };
    });

    const delivery = outcome.rejected.contactEmail
      ? await this.sendSafely(() =>
          rejectedCompanyEmail({
            legalName: outcome.rejected.legalName,
            contactEmail: outcome.rejected.contactEmail as string,
            note: dto.note,
          }),
        )
      : ('failed' as const);

    return {
      company_id: companyId,
      status: 'rejected',
      decision: 'rejected',
      decided_at: outcome.review.createdAt.toISOString(),
      acknowledged_routing_limitation: false,
      municipality_coverage_active: await this.repo.isCoverageActiveForCompany(companyId),
      notification: { channel: 'email', to: outcome.rejected.contactEmail ?? '', delivery },
      provisioning: null,
    };
  }

  async resendNotification(
    companyId: number,
    platformAdminUserId: number,
  ): Promise<ResendCompanyNotificationResponse> {
    const last = await this.repo.getLastReview(companyId);
    if (!last) {
      throw new ConflictException({
        code: 'NO_DECISION_TO_RESEND',
        message: 'Esta empresa no tiene ninguna decisión que reenviar',
      });
    }
    const detail = await this.repo.getDetail(companyId);
    if (!detail) {
      throw new NotFoundException({ code: 'COMPANY_NOT_FOUND', message: 'La empresa no existe' });
    }

    if (last.decision === 'documents_requested') {
      const delivery = await this.sendSafely(() =>
        documentsRequestedEmail({
          legalName: detail.legalName,
          contactEmail: detail.contactEmail ?? '',
          note: last.note ?? '',
          uploadUrl: this.links.buildUrl(companyId),
        }),
      );
      return {
        company_id: companyId,
        decision: 'documents_requested',
        notification: { channel: 'email', to: detail.contactEmail ?? '', delivery },
      };
    }

    if (last.decision === 'rejected') {
      const delivery = await this.sendSafely(() =>
        rejectedCompanyEmail({
          legalName: detail.legalName,
          contactEmail: detail.contactEmail ?? '',
          note: last.note ?? '',
        }),
      );
      return {
        company_id: companyId,
        decision: 'rejected',
        notification: { channel: 'email', to: detail.contactEmail ?? '', delivery },
      };
    }

    return this.reissueCredentials(companyId, detail.legalName, platformAdminUserId);
  }

  private async reissueCredentials(
    companyId: number,
    legalName: string,
    platformAdminUserId: number,
  ): Promise<ResendCompanyNotificationResponse> {
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await this.hasher.hash(temporaryPassword);

    const rotated = await this.repo.runTransaction(async (tx) => {
      const admin = await this.repo.findContactAdmin(tx, companyId);
      if (!admin) {
        throw new ConflictException({
          code: 'NO_DECISION_TO_RESEND',
          message: 'Esta empresa no tiene un administrador con el que iniciar sesión',
        });
      }
      await this.repo.updatePasswordHash(tx, admin.userId, passwordHash);
      await this.repo.setTenantSession(tx, companyId);
      await this.repo.createReview(tx, {
        companyId,
        decision: 'credentials_reissued',
        note: null,
        acknowledgedRoutingLimitation: false,
        municipalityActiveCompanyId: null,
        municipalityActiveCompanyName: null,
        requestedDocumentTypes: [],
        reviewedBy: platformAdminUserId,
      });
      return admin;
    });

    const delivery = await this.sendSafely(() =>
      approvedCompanyEmail({
        legalName,
        loginEmail: rotated.email,
        temporaryPassword,
      }),
    );
    return {
      company_id: companyId,
      decision: 'credentials_reissued',
      notification: { channel: 'email', to: rotated.email, delivery },
    };
  }

  private async sendSafely(build: () => { to: string; subject: string; text: string }): Promise<
    'sent' | 'failed'
  > {
    try {
      await this.email.send(build());
      return 'sent';
    } catch {
      return 'failed';
    }
  }
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
