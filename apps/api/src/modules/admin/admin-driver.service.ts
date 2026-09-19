import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import {
  type CreatedDriver,
  type CreateDriverDTO,
  DRIVER_SUSPENDED_EVENT,
  type DriverSuspendedEvent,
  type DriverSuspensionReason,
  type FleetQuota,
  type PinDeliveryStatus,
  REQUIRED_DRIVER_DOCUMENT_TYPES,
  type ResendDriverPinResponse,
  type SuspendDriverResponse,
} from '@voyyaa/shared';
import { EnvService } from '../../config/env.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { assertStagedDocumentKey, driverDocumentKey } from '../affiliation/document-key';
import { FILE_STORAGE, type FileStorageProvider } from '../affiliation/ports/file-storage.port';
import { HASHER, type Hasher } from '../auth/hasher.service';
import { generateNumericCode } from '../../shared/numeric-code';
import { SMS_PROVIDER, type SmsProvider } from '../assignment/ports/sms-provider.port';
import {
  AdminDriverRepository,
  type CreatedDriverDocumentRow,
  type CreatedDriverRow,
  type DriverDocumentRowInput,
} from './admin-driver.repository';

@Injectable()
export class AdminDriverService {
  private readonly logger = new Logger(AdminDriverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: AdminDriverRepository,
    private readonly env: EnvService,
    private readonly emitter: EventEmitter2,
    @Inject(HASHER) private readonly hasher: Hasher,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    @Inject(FILE_STORAGE) private readonly storage: FileStorageProvider,
  ) {}

  async create(companyId: number, dto: CreateDriverDTO): Promise<CreatedDriver> {
    const missing = REQUIRED_DRIVER_DOCUMENT_TYPES.filter(
      (type) => !dto.documents.some((d) => d.type === type),
    );
    if (missing.length > 0) {
      throw new UnprocessableEntityException({
        code: 'DRIVER_DOCUMENTS_INCOMPLETE',
        message: 'Faltan documentos obligatorios del conductor',
        missing_documents: missing,
      });
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

    const pin = generateNumericCode(this.env.get('DRIVER_PIN_LENGTH'));
    const pinHash = await this.hasher.hash(pin);

    let created: CreatedDriverRow;
    let documents: CreatedDriverDocumentRow[];
    let movable: Array<{ fromKey: string; toKey: string }>;
    try {
      const result = await this.prisma.runInTenant(companyId, async (tx) => {
        const quota = await this.repo.lockFleetQuota(tx, companyId);
        if (quota.declared !== null && quota.used >= quota.declared) {
          throw new ConflictException({
            code: 'FLEET_LIMIT_REACHED',
            message: 'Ya alcanzaste el cupo de flota declarado. Contacta a VoyYa para ampliarlo.',
          });
        }

        const driver = await this.repo.createDriverWithVehicle(tx, companyId, {
          firstName: dto.first_name,
          lastName: dto.last_name,
          nationalId: dto.national_id,
          phone: dto.phone,
          email: dto.email ?? null,
          license: dto.license ?? null,
          pinHash,
          vehicle: {
            plate: dto.vehicle.plate,
            model: dto.vehicle.model,
            year: dto.vehicle.year ?? null,
          },
        });

        const documentRows: Array<DriverDocumentRowInput & { fromKey: string; toKey: string }> =
          staged.map(({ doc, stat }) => {
            const toKey = driverDocumentKey(companyId, driver.driverId, doc.type, stat.contentType);
            return {
              type: doc.type,
              storageKey: toKey,
              fromKey: doc.storage_key,
              toKey,
              fileName: toKey.slice(toKey.lastIndexOf('/') + 1),
              contentType: stat.contentType,
              sizeBytes: stat.sizeBytes,
              issuedAt: doc.issued_at ? new Date(doc.issued_at) : null,
              expiresAt: new Date(doc.expires_at),
            };
          });

        const documents = await this.repo.createDriverDocuments(
          tx,
          driver.driverId,
          companyId,
          documentRows,
        );

        return { driver, documents, movable: documentRows.map((d) => ({ fromKey: d.fromKey, toKey: d.toKey })) };
      });
      created = result.driver;
      documents = result.documents;
      movable = result.movable;

      for (const move of movable) {
        try {
          await this.storage.move(move.fromKey, move.toKey);
        } catch {
          this.logger.error(`Failed to move driver document for driver=${created.driverId}`);
        }
      }
    } catch (error) {
      throw this.translateUniqueViolation(error);
    }

    const { delivery, deliveredAt } = await this.deliverPin(companyId, created.driverId, created.phone, {
      nationalId: created.nationalId,
      pin,
    });

    return {
      driver_id: created.driverId,
      national_id: created.nationalId,
      first_name: created.firstName,
      last_name: created.lastName,
      phone: created.phone,
      email: created.email,
      status: created.status,
      vehicle: {
        vehicle_id: created.vehicle.vehicleId,
        plate: created.vehicle.plate,
        model: created.vehicle.model,
        year: created.vehicle.year,
      },
      documents: documents.map((d) => ({
        driver_document_id: d.driverDocumentId,
        type: d.type as CreatedDriver['documents'][number]['type'],
        file_name: d.fileName,
        issued_at: d.issuedAt ? isoDate(d.issuedAt) : null,
        expires_at: isoDate(d.expiresAt),
        uploaded_at: d.uploadedAt.toISOString(),
      })),
      pin_delivery: delivery,
      pin_delivered_at: deliveredAt ? deliveredAt.toISOString() : null,
      created_at: created.createdAt.toISOString(),
    };
  }

  async getFleetQuota(companyId: number): Promise<FleetQuota> {
    const quota = await this.prisma.runInTenant(companyId, (tx) =>
      this.repo.readFleetQuota(tx, companyId),
    );
    return {
      declared: quota.declared,
      used: quota.used,
      available: quota.declared === null ? null : Math.max(quota.declared - quota.used, 0),
    };
  }

  async resendPin(companyId: number, driverId: number): Promise<ResendDriverPinResponse> {
    const pin = generateNumericCode(this.env.get('DRIVER_PIN_LENGTH'));
    const pinHash = await this.hasher.hash(pin);

    const rotated = await this.prisma.runInTenant(companyId, (tx) =>
      this.repo.rotatePin(tx, driverId, companyId, pinHash),
    );
    if (!rotated) {
      throw new NotFoundException({ code: 'DRIVER_NOT_FOUND', message: 'El conductor no existe' });
    }

    const { delivery, deliveredAt } = await this.deliverPin(companyId, rotated.driverId, rotated.phone, {
      nationalId: rotated.nationalId,
      pin,
    });

    return {
      driver_id: rotated.driverId,
      pin_delivery: delivery,
      pin_delivered_at: deliveredAt ? deliveredAt.toISOString() : null,
    };
  }

  async suspend(
    companyId: number,
    driverId: number,
    reason: DriverSuspensionReason,
  ): Promise<SuspendDriverResponse> {
    const found = await this.prisma.runInTenant(companyId, (tx) =>
      this.repo.findIdInTenant(tx, driverId, companyId),
    );
    if (found === null) {
      throw new NotFoundException({ code: 'DRIVER_NOT_FOUND', message: 'El conductor no existe' });
    }

    const event: DriverSuspendedEvent = {
      driver_id: driverId,
      company_id: companyId,
      reason,
      occurred_at: new Date().toISOString(),
    };
    this.emitter.emit(DRIVER_SUSPENDED_EVENT, event);

    return { ok: true };
  }

  private async deliverPin(
    companyId: number,
    driverId: number,
    phone: string,
    payload: { nationalId: string; pin: string },
  ): Promise<{ delivery: PinDeliveryStatus; deliveredAt: Date | null }> {
    try {
      await this.sms.send(
        phone,
        `VoyYa · cédula ${payload.nationalId} · PIN ${payload.pin}`,
      );
    } catch {
      this.logger.warn(`PIN delivery failed for driver=${driverId}`);
      return { delivery: 'failed', deliveredAt: null };
    }

    const deliveredAt = await this.prisma.runInTenant(companyId, (tx) =>
      this.repo.markPinDelivered(tx, driverId, companyId),
    );
    return { delivery: 'sent', deliveredAt };
  }

  private translateUniqueViolation(error: unknown): ConflictException {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const { modelName, fields } = uniqueViolationMeta(error.meta);

      if (modelName === 'Driver') {
        return new ConflictException({
          code: 'NATIONAL_ID_TAKEN',
          message: 'Ya existe un conductor con esta cédula.',
        });
      }
      if (modelName === 'Vehicle') {
        return new ConflictException({
          code: 'PLATE_TAKEN',
          message: 'Esta placa ya está registrada.',
        });
      }
      if (modelName === 'User') {
        if (fields.some((f) => f.includes('phone'))) {
          return new ConflictException({
            code: 'PHONE_TAKEN',
            message: 'Ya hay una cuenta con este teléfono.',
          });
        }
        if (fields.some((f) => f.includes('email'))) {
          return new ConflictException({
            code: 'EMAIL_TAKEN',
            message: 'Ya hay una cuenta con este correo.',
          });
        }
      }
    }
    throw error;
  }
}

interface UniqueViolationMeta {
  modelName: string | null;
  fields: string[];
}

function uniqueViolationMeta(meta: unknown): UniqueViolationMeta {
  const record = meta as { modelName?: unknown; target?: unknown } | undefined;
  const modelName = typeof record?.modelName === 'string' ? record.modelName : null;
  const target = record?.target;
  const fields = Array.isArray(target)
    ? target.map(String)
    : typeof target === 'string'
      ? [target]
      : [];
  return { modelName, fields };
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
