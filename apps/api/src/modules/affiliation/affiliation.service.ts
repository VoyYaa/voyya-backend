import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  AffiliationApplicationCreated,
  AffiliationDocument,
  AffiliationMunicipalityListResponse,
  CompanyDocumentType,
  CreateAffiliationApplicationDTO,
  ReplaceAffiliationDocumentDTO,
} from '@voyyaa/shared';
import { REQUIRED_COMPANY_DOCUMENT_TYPES } from '@voyyaa/shared';
import { AffiliationLinkService } from './affiliation-link.service';
import {
  AffiliationRepository,
  type DocumentRowInput,
} from './affiliation.repository';
import { assertStagedDocumentKey, companyDocumentKey } from './document-key';
import { FILE_STORAGE, type FileStorageProvider } from './ports/file-storage.port';

@Injectable()
export class AffiliationService {
  private readonly logger = new Logger(AffiliationService.name);

  constructor(
    private readonly repo: AffiliationRepository,
    private readonly links: AffiliationLinkService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorageProvider,
  ) {}

  async listMunicipalities(): Promise<AffiliationMunicipalityListResponse> {
    const rows = await this.repo.listMunicipalityCatalog();
    return {
      rows: rows.map((r) => ({
        municipality_id: r.municipalityId,
        name: r.name,
        department: r.department,
        already_covered: r.alreadyCovered,
      })),
    };
  }

  async submitApplication(
    dto: CreateAffiliationApplicationDTO,
  ): Promise<AffiliationApplicationCreated> {
    const missing = REQUIRED_COMPANY_DOCUMENT_TYPES.filter(
      (type) => !dto.documents.some((d) => d.type === type),
    );
    if (missing.length > 0) {
      throw new UnprocessableEntityException({
        code: 'DOCUMENTS_INCOMPLETE',
        message: 'Faltan documentos obligatorios',
        missing_documents: missing,
      });
    }

    const municipality = await this.repo.getMunicipality(dto.municipality_id);
    if (!municipality || municipality.status !== 'active') {
      throw new NotFoundException({
        code: 'MUNICIPALITY_NOT_FOUND',
        message: 'El municipio no existe o no está disponible',
      });
    }

    const [phoneTaken, emailTaken] = await Promise.all([
      this.repo.findUserByPhone(dto.contact_phone),
      this.repo.findUserByEmail(dto.contact_email),
    ]);
    if (phoneTaken) {
      throw new ConflictException({
        code: 'CONTACT_PHONE_TAKEN',
        message: 'Ya existe una cuenta con ese teléfono de contacto',
        field: 'contact_phone',
      });
    }
    if (emailTaken) {
      throw new ConflictException({
        code: 'CONTACT_EMAIL_TAKEN',
        message: 'Ya existe una cuenta con ese correo de contacto',
        field: 'contact_email',
      });
    }

    const existing = await this.repo.findCompanyByTaxId(dto.tax_id);
    let existingCompanyId: number | null = null;
    if (existing) {
      if (existing.status === 'rejected') {
        existingCompanyId = existing.companyId;
      } else if (existing.status === 'pending') {
        throw new ConflictException({
          code: 'APPLICATION_IN_REVIEW',
          message: 'Ya existe una solicitud en revisión con este NIT',
        });
      } else {
        throw new ConflictException({
          code: 'TAX_ID_TAKEN',
          message: 'Ya existe una empresa con este NIT',
        });
      }
    }

    const staged = await Promise.all(
      dto.documents.map(async (doc) => {
        assertStagedDocumentKey(doc.storage_key, doc.type);
        const stat = await this.storage.stat(doc.storage_key);
        if (!stat) {
          throw new ConflictException({
            code: 'DOCUMENT_NOT_FOUND',
            message: 'Uno de los documentos cargados ya no está disponible, vuelve a cargarlo',
            field: doc.type,
          });
        }
        return { doc, stat };
      }),
    );

    const pending = await this.repo.runTransaction(async (tx) => {
      const row = await this.repo.upsertPendingCompany(tx, {
        existingCompanyId,
        legalName: dto.legal_name,
        taxId: dto.tax_id,
        legalForm: dto.legal_form,
        municipalityId: dto.municipality_id,
        vehicleCount: dto.vehicle_count,
        contactEmail: dto.contact_email,
        contactFirstName: dto.contact_first_name,
        contactLastName: dto.contact_last_name,
        contactPhone: dto.contact_phone,
      });

      await this.repo.setTenantSession(tx, row.companyId);

      const documentRows: Array<DocumentRowInput & { fromKey: string; toKey: string }> = staged.map(
        ({ doc, stat }) => {
          const toKey = companyDocumentKey(row.companyId, doc.type, stat.contentType);
          return {
            type: doc.type,
            storageKey: toKey,
            fromKey: doc.storage_key,
            toKey,
            fileName: toKey.slice(toKey.lastIndexOf('/') + 1),
            contentType: stat.contentType,
            sizeBytes: stat.sizeBytes,
            issuedAt: doc.issued_at ? new Date(doc.issued_at) : null,
            expiresAt: doc.expires_at ? new Date(doc.expires_at) : null,
          };
        },
      );

      await this.repo.replaceCompanyDocuments(tx, row.companyId, documentRows);

      return { row, documentRows };
    });

    for (const doc of pending.documentRows) {
      try {
        await this.storage.move(doc.fromKey, doc.toKey);
      } catch {
        this.logger.error(
          `Failed to move document from staging for company=${pending.row.companyId} type=${doc.type}`,
        );
      }
    }

    return {
      company_id: pending.row.companyId,
      legal_name: pending.row.legalName,
      tax_id: pending.row.taxId,
      status: pending.row.status as AffiliationApplicationCreated['status'],
      municipality_name: municipality.name,
      contact_email: pending.row.contactEmail ?? dto.contact_email,
      submitted_at: pending.row.registeredAt.toISOString(),
    };
  }

  async replaceDocument(
    token: string,
    companyId: number,
    dto: ReplaceAffiliationDocumentDTO,
  ): Promise<AffiliationDocument> {
    const verification = this.links.verify(token);
    if (!verification.ok) {
      throw new UnauthorizedException({
        code: verification.reason === 'expired' ? 'AFFILIATION_LINK_EXPIRED' : 'AFFILIATION_LINK_INVALID',
        message:
          verification.reason === 'expired'
            ? 'El enlace para cargar documentos venció'
            : 'El enlace para cargar documentos no es válido',
      });
    }
    if (verification.payload.companyId !== companyId) {
      throw new UnauthorizedException({
        code: 'AFFILIATION_LINK_INVALID',
        message: 'El enlace para cargar documentos no es válido',
      });
    }

    assertStagedDocumentKey(dto.storage_key, dto.type);
    const stat = await this.storage.stat(dto.storage_key);
    if (!stat) {
      throw new ConflictException({
        code: 'DOCUMENT_NOT_FOUND',
        message: 'El documento cargado ya no está disponible, vuelve a cargarlo',
      });
    }

    const result = await this.repo.runTransaction(async (tx) => {
      const company = await this.repo.findPendingCompany(tx, companyId);
      if (!company || company.status !== 'pending') {
        throw new ConflictException({
          code: 'APPLICATION_NOT_PENDING',
          message: 'Esta solicitud ya no está en revisión',
        });
      }

      await this.repo.setTenantSession(tx, companyId);

      const toKey = companyDocumentKey(companyId, dto.type, stat.contentType);
      const row: DocumentRowInput = {
        type: dto.type,
        storageKey: toKey,
        fileName: toKey.slice(toKey.lastIndexOf('/') + 1),
        contentType: stat.contentType,
        sizeBytes: stat.sizeBytes,
        issuedAt: dto.issued_at ? new Date(dto.issued_at) : null,
        expiresAt: dto.expires_at ? new Date(dto.expires_at) : null,
      };
      const saved = await this.repo.replaceSingleCompanyDocument(tx, companyId, row);
      return { fromKey: dto.storage_key, toKey, row, saved };
    });

    try {
      await this.storage.move(result.fromKey, result.toKey);
    } catch {
      this.logger.error(`Failed to move replaced document for company=${companyId}`);
    }

    return {
      company_document_id: result.saved.companyDocumentId,
      type: result.row.type as CompanyDocumentType,
      file_name: result.row.fileName,
      content_type: result.row.contentType,
      size_bytes: result.row.sizeBytes,
      verification: 'pending',
      review_note: null,
      issued_at: dto.issued_at ?? null,
      expires_at: dto.expires_at ?? null,
      uploaded_at: result.saved.uploadedAt.toISOString(),
      verified_at: null,
    };
  }
}
