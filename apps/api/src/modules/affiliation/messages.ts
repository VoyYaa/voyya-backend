import type { EmailMessage } from './ports/email-provider.port';

export const DOCUMENT_STORAGE_UNAVAILABLE_MESSAGE =
  'No pudimos guardar tu documento en este momento. Inténtalo de nuevo en unos minutos.';

export function approvedCompanyEmail(input: {
  legalName: string;
  loginEmail: string;
  temporaryPassword: string;
}): EmailMessage {
  return {
    to: input.loginEmail,
    subject: 'VoyYa · Tu empresa fue aprobada',
    text:
      `Hola,\n\n` +
      `${input.legalName} ya está activa en VoyYa. Puedes ingresar a la consola de administración con:\n\n` +
      `Correo: ${input.loginEmail}\n` +
      `Contraseña temporal: ${input.temporaryPassword}\n\n` +
      `Te recomendamos cambiarla apenas puedas.\n\n` +
      `Equipo VoyYa`,
  };
}

export function documentsRequestedEmail(input: {
  legalName: string;
  contactEmail: string;
  note: string;
  uploadUrl: string;
}): EmailMessage {
  return {
    to: input.contactEmail,
    subject: 'VoyYa · Nos falta un documento de tu solicitud',
    text:
      `Hola,\n\n` +
      `Revisamos la solicitud de afiliación de ${input.legalName} y necesitamos que cargues de nuevo ` +
      `alguno de tus documentos.\n\n` +
      `Nota del revisor: ${input.note}\n\n` +
      `Puedes hacerlo aquí: ${input.uploadUrl}\n\n` +
      `Equipo VoyYa`,
  };
}

export function rejectedCompanyEmail(input: {
  legalName: string;
  contactEmail: string;
  note: string;
}): EmailMessage {
  return {
    to: input.contactEmail,
    subject: 'VoyYa · Tu solicitud de afiliación fue rechazada',
    text:
      `Hola,\n\n` +
      `No pudimos aprobar la solicitud de afiliación de ${input.legalName}.\n\n` +
      `Motivo: ${input.note}\n\n` +
      `Equipo VoyYa`,
  };
}
