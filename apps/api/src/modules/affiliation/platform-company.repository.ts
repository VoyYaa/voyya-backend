import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { setTenantSession } from '../../shared/tenant-session';

export interface PlatformCompanyListRow {
  companyId: number;
  legalName: string;
  taxId: string;
  status: string;
  municipalityId: number;
  municipalityName: string;
  municipalityAlreadyCovered: boolean;
  vehicleCount: number | null;
  contactEmail: string | null;
  submittedAt: Date;
}

export interface PlatformCompanyDetailRow extends PlatformCompanyListRow {
  legalForm: string;
  municipalityDepartment: string;
  contactFirstName: string | null;
  contactLastName: string | null;
  contactPhone: string | null;
}

export interface CompanyDocumentRow {
  companyDocumentId: number;
  type: string;
  storageKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  verification: string;
  reviewNote: string | null;
  issuedAt: Date | null;
  expiresAt: Date | null;
  uploadedAt: Date;
  verifiedAt: Date | null;
}

export interface CompanyReviewRow {
  companyReviewId: number;
  decision: string;
  note: string | null;
  acknowledgedRoutingLimitation: boolean;
  municipalityActiveCompanyName: string | null;
  requestedDocumentTypes: string[];
  reviewerName: string;
  createdAt: Date;
}

export interface ActivatedCompanyRow {
  companyId: number;
  municipalityId: number;
  legalName: string;
  taxId: string;
  contactEmail: string | null;
  contactFirstName: string | null;
  contactLastName: string | null;
  contactPhone: string | null;
  vehicleCount: number | null;
}

@Injectable()
export class PlatformCompanyRepository {
  constructor(private readonly prisma: PrismaService) {}

  async runTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn);
  }

  async setTenantSession(tx: Prisma.TransactionClient, companyId: number): Promise<void> {
    await setTenantSession(tx, companyId);
  }

  async listCompanies(
    status: 'pending' | 'active' | 'rejected' | 'all',
    limit: number,
  ): Promise<PlatformCompanyListRow[]> {
    const rows = await this.prisma.company.findMany({
      where: status === 'all' ? {} : { status },
      orderBy: { registeredAt: 'desc' },
      take: limit,
      select: this.listSelect(),
    });
    return rows.map((r) => this.mapListRow(r));
  }

  async countPending(): Promise<number> {
    return this.prisma.company.count({ where: { status: 'pending' } });
  }

  async getDetail(companyId: number): Promise<PlatformCompanyDetailRow | null> {
    const row = await this.prisma.company.findUnique({
      where: { companyId },
      select: {
        ...this.listSelect(),
        type: true,
        contactFirstName: true,
        contactLastName: true,
        contactPhone: true,
        municipality: {
          select: {
            name: true,
            department: true,
            companies: { where: { status: 'active' }, select: { companyId: true }, take: 2 },
          },
        },
      },
    });
    if (!row) return null;
    return {
      ...this.mapListRow(row),
      legalForm: row.type,
      municipalityDepartment: row.municipality.department,
      contactFirstName: row.contactFirstName,
      contactLastName: row.contactLastName,
      contactPhone: row.contactPhone,
    };
  }

  async listDocuments(tx: Prisma.TransactionClient, companyId: number): Promise<CompanyDocumentRow[]> {
    const rows = await tx.companyDocument.findMany({
      where: { companyId },
      orderBy: { type: 'asc' },
    });
    return rows.map((r) => ({
      companyDocumentId: r.companyDocumentId,
      type: r.type,
      storageKey: r.storageKey,
      fileName: r.fileName,
      contentType: r.contentType,
      sizeBytes: r.sizeBytes,
      verification: r.verification,
      reviewNote: r.reviewNote,
      issuedAt: r.issuedAt,
      expiresAt: r.expiresAt,
      uploadedAt: r.uploadedAt,
      verifiedAt: r.verifiedAt,
    }));
  }

  async listReviews(tx: Prisma.TransactionClient, companyId: number): Promise<CompanyReviewRow[]> {
    const rows = await tx.companyReview.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      include: { reviewedByUser: { select: { firstName: true, lastName: true } } },
    });
    return rows.map((r) => ({
      companyReviewId: r.companyReviewId,
      decision: r.decision,
      note: r.note,
      acknowledgedRoutingLimitation: r.acknowledgedRoutingLimitation,
      municipalityActiveCompanyName: r.municipalityActiveCompanyName,
      requestedDocumentTypes: r.requestedDocumentTypes,
      reviewerName: `${r.reviewedByUser.firstName} ${r.reviewedByUser.lastName}`.trim(),
      createdAt: r.createdAt,
    }));
  }

  async activateCompany(
    tx: Prisma.TransactionClient,
    companyId: number,
  ): Promise<ActivatedCompanyRow | null> {
    const rows = await tx.$queryRaw<
      Array<{
        company_id: number;
        municipality_id: number;
        legal_name: string;
        tax_id: string;
        contact_email: string | null;
        contact_first_name: string | null;
        contact_last_name: string | null;
        contact_phone: string | null;
        vehicle_count: number | null;
      }>
    >`
      UPDATE tenancy.company
         SET status = 'active'
       WHERE company_id = ${companyId} AND status = 'pending'
      RETURNING company_id, municipality_id, legal_name, tax_id, contact_email,
                contact_first_name, contact_last_name, contact_phone, vehicle_count
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      companyId: row.company_id,
      municipalityId: row.municipality_id,
      legalName: row.legal_name,
      taxId: row.tax_id,
      contactEmail: row.contact_email,
      contactFirstName: row.contact_first_name,
      contactLastName: row.contact_last_name,
      contactPhone: row.contact_phone,
      vehicleCount: row.vehicle_count,
    };
  }

  async findPendingCompany(
    tx: Prisma.TransactionClient,
    companyId: number,
  ): Promise<{ companyId: number; legalName: string; contactEmail: string | null } | null> {
    return tx.company.findFirst({
      where: { companyId, status: 'pending' },
      select: { companyId: true, legalName: true, contactEmail: true },
    });
  }

  async rejectCompany(
    tx: Prisma.TransactionClient,
    companyId: number,
  ): Promise<{ companyId: number; legalName: string; contactEmail: string | null } | null> {
    const rows = await tx.$queryRaw<
      Array<{ company_id: number; legal_name: string; contact_email: string | null }>
    >`
      UPDATE tenancy.company
         SET status = 'rejected'
       WHERE company_id = ${companyId} AND status = 'pending'
      RETURNING company_id, legal_name, contact_email
    `;
    const row = rows[0];
    if (!row) return null;
    return { companyId: row.company_id, legalName: row.legal_name, contactEmail: row.contact_email };
  }

  async markAllDocumentsVerified(
    tx: Prisma.TransactionClient,
    companyId: number,
    verifiedBy: number,
  ): Promise<void> {
    await tx.companyDocument.updateMany({
      where: { companyId },
      data: { verification: 'verified', verifiedBy, verifiedAt: new Date() },
    });
  }

  async markDocumentsRejected(
    tx: Prisma.TransactionClient,
    companyId: number,
    types: readonly string[],
    note: string,
  ): Promise<void> {
    await tx.companyDocument.updateMany({
      where: { companyId, type: { in: types as never[] } },
      data: { verification: 'rejected', reviewNote: note },
    });
  }

  async findContactAdmin(
    tx: Prisma.TransactionClient,
    companyId: number,
  ): Promise<{ userId: number; email: string } | null> {
    const admin = await tx.user.findFirst({
      where: { companyId, role: 'admin' },
      orderBy: { createdAt: 'asc' },
      select: { userId: true, email: true },
    });
    if (!admin || !admin.email) return null;
    return { userId: admin.userId, email: admin.email };
  }

  async updatePasswordHash(
    tx: Prisma.TransactionClient,
    userId: number,
    passwordHash: string,
  ): Promise<void> {
    await tx.user.update({ where: { userId }, data: { passwordHash } });
  }

  async createReview(
    tx: Prisma.TransactionClient,
    input: {
      companyId: number;
      decision: 'approved' | 'documents_requested' | 'rejected' | 'credentials_reissued';
      note: string | null;
      acknowledgedRoutingLimitation: boolean;
      municipalityActiveCompanyId: number | null;
      municipalityActiveCompanyName: string | null;
      requestedDocumentTypes: readonly string[];
      reviewedBy: number;
    },
  ): Promise<{ companyReviewId: number; createdAt: Date }> {
    const row = await tx.companyReview.create({
      data: {
        companyId: input.companyId,
        decision: input.decision,
        note: input.note,
        acknowledgedRoutingLimitation: input.acknowledgedRoutingLimitation,
        municipalityActiveCompanyId: input.municipalityActiveCompanyId,
        municipalityActiveCompanyName: input.municipalityActiveCompanyName,
        requestedDocumentTypes: input.requestedDocumentTypes as never[],
        reviewedBy: input.reviewedBy,
      },
    });
    return { companyReviewId: row.companyReviewId, createdAt: row.createdAt };
  }

  async getLastReview(companyId: number): Promise<{
    decision: string;
    note: string | null;
    requestedDocumentTypes: string[];
  } | null> {
    const row = await this.prisma.runInTenant(companyId, (tx) =>
      tx.companyReview.findFirst({
        where: { companyId },
        orderBy: { createdAt: 'desc' },
      }),
    );
    if (!row) return null;
    return { decision: row.decision, note: row.note, requestedDocumentTypes: row.requestedDocumentTypes };
  }

  async findUserByPhoneOrEmail(
    phone: string | null,
    email: string | null,
  ): Promise<{ userId: number } | null> {
    return this.prisma.user.findFirst({
      where: {
        OR: [
          ...(phone ? [{ phone }] : []),
          ...(email ? [{ email }] : []),
        ],
      },
      select: { userId: true },
    });
  }

  private listSelect() {
    return {
      companyId: true,
      legalName: true,
      taxId: true,
      status: true,
      municipalityId: true,
      vehicleCount: true,
      contactEmail: true,
      registeredAt: true,
      municipality: { select: { name: true, companies: { where: { status: 'active' }, select: { companyId: true }, take: 2 } } },
    } as const;
  }

  private mapListRow(row: {
    companyId: number;
    legalName: string;
    taxId: string;
    status: string;
    municipalityId: number;
    vehicleCount: number | null;
    contactEmail: string | null;
    registeredAt: Date;
    municipality: { name: string; companies: Array<{ companyId: number }> };
  }): PlatformCompanyListRow {
    const otherActive = row.municipality.companies.filter((c) => c.companyId !== row.companyId);
    return {
      companyId: row.companyId,
      legalName: row.legalName,
      taxId: row.taxId,
      status: row.status,
      municipalityId: row.municipalityId,
      municipalityName: row.municipality.name,
      municipalityAlreadyCovered: otherActive.length > 0,
      vehicleCount: row.vehicleCount,
      contactEmail: row.contactEmail,
      submittedAt: row.registeredAt,
    };
  }
}
