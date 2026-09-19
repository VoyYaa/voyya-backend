import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { setTenantSession } from '../../shared/tenant-session';

export interface MunicipalityCatalogRow {
  municipalityId: number;
  name: string;
  department: string;
  alreadyCovered: boolean;
}

export interface ExistingCompanyByTaxId {
  companyId: number;
  status: string;
  municipalityId: number;
}

export interface UpsertPendingCompanyInput {
  existingCompanyId: number | null;
  legalName: string;
  taxId: string;
  legalForm: string;
  municipalityId: number;
  vehicleCount: number;
  contactEmail: string;
  contactFirstName: string;
  contactLastName: string;
  contactPhone: string;
}

export interface PendingCompanyRow {
  companyId: number;
  legalName: string;
  taxId: string;
  status: string;
  municipalityId: number;
  contactEmail: string | null;
  registeredAt: Date;
}

export interface DocumentRowInput {
  type: string;
  storageKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  issuedAt: Date | null;
  expiresAt: Date | null;
}

@Injectable()
export class AffiliationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listMunicipalityCatalog(): Promise<MunicipalityCatalogRow[]> {
    const rows = await this.prisma.municipality.findMany({
      where: { status: 'active' },
      orderBy: { name: 'asc' },
      select: {
        municipalityId: true,
        name: true,
        department: true,
        companies: { where: { status: 'active' }, select: { companyId: true }, take: 1 },
      },
    });
    return rows.map((r) => ({
      municipalityId: r.municipalityId,
      name: r.name,
      department: r.department,
      alreadyCovered: r.companies.length > 0,
    }));
  }

  async getMunicipality(
    municipalityId: number,
  ): Promise<{ municipalityId: number; name: string; status: string } | null> {
    return this.prisma.municipality.findUnique({
      where: { municipalityId },
      select: { municipalityId: true, name: true, status: true },
    });
  }

  async findUserByPhone(phone: string): Promise<{ userId: number } | null> {
    return this.prisma.user.findUnique({ where: { phone }, select: { userId: true } });
  }

  async findUserByEmail(email: string): Promise<{ userId: number } | null> {
    return this.prisma.user.findUnique({ where: { email }, select: { userId: true } });
  }

  async findCompanyByTaxId(taxId: string): Promise<ExistingCompanyByTaxId | null> {
    return this.prisma.company.findUnique({
      where: { taxId },
      select: { companyId: true, status: true, municipalityId: true },
    });
  }

  async runTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn);
  }

  async setTenantSession(tx: Prisma.TransactionClient, companyId: number): Promise<void> {
    await setTenantSession(tx, companyId);
  }

  async upsertPendingCompany(
    tx: Prisma.TransactionClient,
    input: UpsertPendingCompanyInput,
  ): Promise<PendingCompanyRow> {
    const data = {
      legalName: input.legalName,
      type: input.legalForm,
      municipalityId: input.municipalityId,
      vehicleCount: input.vehicleCount,
      contactEmail: input.contactEmail,
      contactFirstName: input.contactFirstName,
      contactLastName: input.contactLastName,
      contactPhone: input.contactPhone,
      status: 'pending' as const,
    };

    const row = input.existingCompanyId
      ? await tx.company.update({
          where: { companyId: input.existingCompanyId },
          data: { ...data, registeredAt: new Date() },
        })
      : await tx.company.create({ data: { ...data, taxId: input.taxId } });

    return {
      companyId: row.companyId,
      legalName: row.legalName,
      taxId: row.taxId,
      status: row.status,
      municipalityId: row.municipalityId,
      contactEmail: row.contactEmail,
      registeredAt: row.registeredAt,
    };
  }

  async replaceCompanyDocuments(
    tx: Prisma.TransactionClient,
    companyId: number,
    documents: readonly DocumentRowInput[],
  ): Promise<void> {
    await tx.companyDocument.deleteMany({ where: { companyId } });
    for (const doc of documents) {
      await tx.companyDocument.create({
        data: {
          companyId,
          type: doc.type as never,
          storageKey: doc.storageKey,
          fileName: doc.fileName,
          contentType: doc.contentType,
          sizeBytes: doc.sizeBytes,
          issuedAt: doc.issuedAt,
          expiresAt: doc.expiresAt,
        },
      });
    }
  }

  async replaceSingleCompanyDocument(
    tx: Prisma.TransactionClient,
    companyId: number,
    doc: DocumentRowInput,
  ): Promise<{ companyDocumentId: number; uploadedAt: Date }> {
    const row = await tx.companyDocument.upsert({
      where: { companyId_type: { companyId, type: doc.type as never } },
      create: {
        companyId,
        type: doc.type as never,
        storageKey: doc.storageKey,
        fileName: doc.fileName,
        contentType: doc.contentType,
        sizeBytes: doc.sizeBytes,
        issuedAt: doc.issuedAt,
        expiresAt: doc.expiresAt,
        verification: 'pending',
      },
      update: {
        storageKey: doc.storageKey,
        fileName: doc.fileName,
        contentType: doc.contentType,
        sizeBytes: doc.sizeBytes,
        issuedAt: doc.issuedAt,
        expiresAt: doc.expiresAt,
        uploadedAt: new Date(),
        verification: 'pending',
        reviewNote: null,
        verifiedBy: null,
        verifiedAt: null,
      },
    });
    return { companyDocumentId: row.companyDocumentId, uploadedAt: row.uploadedAt };
  }

  async findPendingCompany(
    tx: Prisma.TransactionClient,
    companyId: number,
  ): Promise<{ companyId: number; status: string } | null> {
    return tx.company.findUnique({ where: { companyId }, select: { companyId: true, status: true } });
  }
}
