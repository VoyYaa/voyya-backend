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
import { generateTemporaryPassword } from '../../shared/temporary-password';
import { HASHER, type Hasher } from '../auth/hasher.service';
import { ActiveCompanyResolver } from '../tenancy/active-company.resolver';
import { CompanyProvisioningService } from '../tenancy/company-provisioning.service';
import { EMAIL_PROVIDER, type EmailProvider } from './ports/email-provider.port';
import { FILE_STORAGE, type FileStorageProvider } from './ports/file-storage.port';
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
    private readonly activeCompanies: ActiveCompanyResolver,
    private readonly provisioning: CompanyProvisioningService,
    private readonly links: AffiliationLinkService,
    private readonly env: EnvService,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    @Inject(FILE_STORAGE) private readonly storage: FileStorageProvider,
    @Inject(HASHER) private readonly hasher: Hasher,
  ) {}

  async list(query: PlatformCompanyQuery): Promise<PlatformCompanyListResponse> {
    const [rows, pendingCount] = await Promise.all([
      this.repo.listCompanies(query.status, query.limit),
      this.repo.countPending(),
    ]);
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
        vehicle_count: r.vehicleCount,
        contact_email: r.contactEmail,
        submitted_at: r.submittedAt.toISOString(),
      })),
    };
  }

  async detail(companyId: number): Promise<PlatformCompanyDetail> {
    const row = await this.repo.getDetail(companyId);
    if (!row) {
      throw new NotFoundException({ code: 'COMPANY_NOT_FOUND', message: 'La empresa no existe' });
    }

    const ttlSeconds = this.env.get('DOCUMENT_SIGNED_URL_TTL_SEC');
    const [documents, reviews, conflictCompanyId] = await this.repo.runTransaction(async (tx) => {
      await this.repo.setTenantSession(tx, companyId);
      return Promise.all([
        this.repo.listDocuments(tx, companyId),
        this.repo.listReviews(tx, companyId),
        this.activeCompanies.resolve(row.municipalityId, { tx, excludeCompanyId: companyId }),
      ]);
    });
    const conflictName =
      conflictCompanyId !== null
        ? (await this.repo.getDetail(conflictCompanyId))?.legalName ?? null
        : null;

    const signedDocuments = await Promise.all(
      documents.map(async (d) => ({
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
        download_url: await this.storage.signedUrl(d.storageKey, ttlSeconds),
        download_url_expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      })),
    );

    return {
      company_id: row.companyId,
      legal_name: row.legalName,
      tax_id: row.taxId,
      status: row.status as PlatformCompanyDetail['status'],
      municipality_id: row.municipalityId,
      municipality_name: row.municipalityName,
      municipality_already_covered: row.municipalityAlreadyCovered,
      vehicle_count: row.vehicleCount,
      contact_email: row.contactEmail,
      submitted_at: row.submittedAt.toISOString(),
      server_time: new Date().toISOString(),
      legal_form: row.legalForm,
      municipality_department: row.municipalityDepartment,
      municipality_active_company_name: conflictName,
      contact_first_name: row.contactFirstName,
      contact_last_name: row.contactLastName,
      contact_phone: row.contactPhone,
      documents: signedDocuments,
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
    const defaultParams = {
      searchRadiusKm: this.env.get('SEARCH_RADIUS_KM'),
      expansionRadiusKm: this.env.get('EXPANSION_RADIUS_KM'),
      acceptanceTimeoutSec: this.env.get('ACCEPTANCE_TIMEOUT_SEC'),
    };
    const temporaryPassword = generateTemporaryPassword();

    const outcome = await this.repo.runTransaction(async (tx) => {
      const activated = await this.repo.activateCompany(tx, companyId);
      if (!activated) {
        throw new ConflictException({
          code: 'COMPANY_NOT_PENDING',
          message: 'Esta solicitud ya fue resuelta',
        });
      }

      const conflictCompanyId = await this.activeCompanies.resolve(activated.municipalityId, {
        tx,
        excludeCompanyId: activated.companyId,
      });

      let conflictName: string | null = null;
      if (conflictCompanyId !== null) {
        const conflict = await tx.company.findUnique({
          where: { companyId: conflictCompanyId },
          select: { legalName: true },
        });
        conflictName = conflict?.legalName ?? null;
        if (!dto.acknowledge_routing_limitation) {
          throw new ConflictException({
            code: 'MUNICIPALITY_ALREADY_COVERED',
            message: `Este municipio ya tiene una empresa activa (${conflictName ?? 'otra empresa'})`,
            municipality_active_company_name: conflictName ?? undefined,
          });
        }
      }

      await this.repo.setTenantSession(tx, activated.companyId);
      await this.repo.markAllDocumentsVerified(tx, activated.companyId, platformAdminUserId);

      let finished;
      try {
        finished = await this.provisioning.finishProvisioning(
          tx,
          activated.companyId,
          {
            baseFare: dto.initial_fare.base_fare,
            nightSurchargePct: dto.initial_fare.night_surcharge_pct,
            holidaySurchargePct: dto.initial_fare.holiday_surcharge_pct,
            commissionPct: dto.initial_fare.commission_pct,
          },
          defaultParams,
          {
            firstName: activated.contactFirstName ?? activated.legalName,
            lastName: activated.contactLastName ?? '',
            email: activated.contactEmail ?? '',
            phone: activated.contactPhone ?? '',
            password: temporaryPassword,
          },
          platformAdminUserId,
        );
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ConflictException({
            code: 'CONTACT_ACCOUNT_CONFLICT',
            message: 'El contacto de esta empresa ya tiene una cuenta en VoyYa',
          });
        }
        throw error;
      }

      const acknowledged = conflictCompanyId !== null && dto.acknowledge_routing_limitation === true;
      const review = await this.repo.createReview(tx, {
        companyId: activated.companyId,
        decision: 'approved',
        note: dto.note ?? null,
        acknowledgedRoutingLimitation: acknowledged,
        municipalityActiveCompanyId: conflictCompanyId,
        municipalityActiveCompanyName: conflictName,
        requestedDocumentTypes: [],
        reviewedBy: platformAdminUserId,
      });

      return { activated, finished, review, acknowledged };
    });

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
      acknowledged_routing_limitation: outcome.acknowledged,
      notification: { channel: 'email', to: outcome.finished.adminEmail, delivery },
      provisioning: {
        fare_config_id: outcome.finished.fareConfigId,
        admin_user_id: outcome.finished.adminUserId,
        admin_email: outcome.finished.adminEmail,
      },
    };
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
