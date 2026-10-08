import { createHash } from 'node:crypto';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  canonicalLocationNoticeText,
  type ConsentPurpose,
  hasLegalPlaceholders,
  LOCATION_NOTICE_VERSION,
  NoticeAudience,
} from '@voyyaa/shared';
import { EnvService } from '../../config/env.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

const LOCATION_PURPOSE: ConsentPurpose = 'location';
const PLACEHOLDER_PATTERN = /\[[A-ZÁÉÍÓÚÑ ]{3,}\]/g;

export function noticeFingerprint(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function placeholderMarkers(bodies: string[]): string[] {
  const markers = new Set<string>();
  for (const body of bodies) {
    if (hasLegalPlaceholders(body)) {
      for (const marker of body.match(PLACEHOLDER_PATTERN) ?? []) markers.add(marker);
    }
  }
  return [...markers];
}

@Injectable()
export class ConsentNoticeRegistry implements OnModuleInit {
  private readonly logger = new Logger(ConsentNoticeRegistry.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.register();
  }

  async register(): Promise<void> {
    const bodies = NoticeAudience.options.map((audience) => ({
      audience,
      body: canonicalLocationNoticeText(audience),
    }));
    this.reportPlaceholders(placeholderMarkers(bodies.map((b) => b.body)));
    for (const { audience, body } of bodies) await this.registerNotice(audience, body);
  }

  private reportPlaceholders(markers: string[]): void {
    if (markers.length === 0) return;
    const message =
      `El aviso ${LOCATION_NOTICE_VERSION} aún contiene marcadores legales sin completar ` +
      `(${markers.join(', ')}): no es apto para producción`;
    if (this.env.get('NODE_ENV') === 'production') throw new Error(message);
    this.logger.warn(message);
  }

  async isKnown(
    purpose: ConsentPurpose,
    noticeVersion: string,
    audience: NoticeAudience,
  ): Promise<boolean> {
    const notice = await this.prisma.consentNotice.findUnique({
      where: { purpose_noticeVersion_audience: { purpose, noticeVersion, audience } },
      select: { noticeVersion: true },
    });
    return notice !== null;
  }

  private async registerNotice(audience: NoticeAudience, body: string): Promise<void> {
    const sha256 = noticeFingerprint(body);
    await this.prisma.consentNotice.createMany({
      data: [{ purpose: LOCATION_PURPOSE, noticeVersion: LOCATION_NOTICE_VERSION, audience, sha256, body }],
      skipDuplicates: true,
    });
    const stored = await this.prisma.consentNotice.findUniqueOrThrow({
      where: {
        purpose_noticeVersion_audience: {
          purpose: LOCATION_PURPOSE,
          noticeVersion: LOCATION_NOTICE_VERSION,
          audience,
        },
      },
      select: { sha256: true, body: true },
    });
    if (stored.sha256 !== sha256) {
      throw new Error(
        `El texto de ${LOCATION_NOTICE_VERSION} (${audience}) cambió sin subir la versión del aviso`,
      );
    }
    if (noticeFingerprint(stored.body) !== stored.sha256) {
      throw new Error(
        `El cuerpo guardado de ${LOCATION_NOTICE_VERSION} (${audience}) no coincide con su huella`,
      );
    }
  }
}
