// =============================================================================
// VoyYa — Contrato compartido · Dominio AUTH (autenticación e identidad)
// -----------------------------------------------------------------------------
// Fase Diseñar (ASDD) · Agente `arquitectura` · skill `arquitectura-contrato-api`
// Fuente ÚNICA de verdad para backend (NestJS) y clientes (Expo pasajero/conductor,
// PWA admin). Validación con Zod en ambos lados. Sin `any`. Los valores de enum y
// nombres COINCIDEN 1:1 con prisma/schema.prisma. Estrategia y racional: ADR-005.
//
// Cubre las 6 HU de autenticación (requisitos-autenticacion.md):
//   HU-AUTH-01  pasajero  · teléfono + OTP por SMS
//   HU-AUTH-02  conductor · cédula + PIN (bloqueo temporal por intentos)
//   HU-AUTH-03  admin/op  · correo + contraseña
//   HU-AUTH-04  refresh (con ROTACIÓN) + logout (revocación)
//   HU-AUTH-05  revocación al suspender un conductor (evento)
//   HU-AUTH-06  protección de endpoints + RBAC + tenant desde el JWT
//
// MODELO DE TOKENS (ADR-005):
//   - access_token  = JWT HS256 SIN ESTADO, 15 min. Se verifica por firma (rápido).
//   - refresh_token = cadena OPACA de alta entropía (NO es JWT), 7–30 d. Se valida
//     contra la tabla auth.refresh_token (por su hash) → REVOCABLE. Rota en cada uso.
//   Todos los endpoints de este archivo son PÚBLICOS (no exigen access token),
//   salvo que se indique lo contrario. El resto de la API exige `Authorization:
//   Bearer <access_token>` (AuthGuard global) + rol (RolesGuard) — ver ADR-005.
// =============================================================================

import { z } from 'zod';

// -----------------------------------------------------------------------------
// Roles (RBAC) — espejo de Usuario.rol en prisma/schema.prisma. Fuente de verdad
// compartida (antes vivía solo como comentario en el schema).
// -----------------------------------------------------------------------------

export const Rol = z.enum(['pasajero', 'conductor', 'empresa', 'admin', 'operador']);
export type Rol = z.infer<typeof Rol>;

/// Roles que operan dentro de un tenant (su JWT lleva `id_empresa`). El pasajero es
/// global; admin/operador son cross-tenant (ver 06-architecture §Aislamiento).
export const ROLES_CON_TENANT = ['conductor', 'empresa'] as const;

// -----------------------------------------------------------------------------
// Tipos base reutilizables (validación de credenciales)
// -----------------------------------------------------------------------------

/// Teléfono Colombia. Acepta prefijo internacional opcional (+57) + 10 dígitos.
/// Se normaliza a solo dígitos en el backend antes de tocar Usuario.telefono.
export const Telefono = z
  .string()
  .trim()
  .regex(/^(?:\+?57)?3\d{9}$/, 'Teléfono colombiano inválido (celular de 10 dígitos)');
export type Telefono = z.infer<typeof Telefono>;

/// Cédula: 5–15 dígitos (login del conductor).
export const Cedula = z.string().trim().regex(/^\d{5,15}$/, 'Cédula inválida');

/// PIN numérico del conductor (lo genera el admin y llega por SMS). Longitud 4–6.
export const Pin = z.string().regex(/^\d{4,6}$/, 'PIN inválido (4 a 6 dígitos)');

/// Código OTP (por defecto 4 dígitos — D-A02; la longitud efectiva la fija OTP_LENGTH).
export const CodigoOtp = z.string().regex(/^\d{4,8}$/, 'Código OTP inválido');

// -----------------------------------------------------------------------------
// Payload del JWT de ACCESO (lo que se firma y viaja en el access_token)
// -----------------------------------------------------------------------------
// El AuthGuard verifica la firma y coloca estos campos en `req.user`
// (id_usuario=sub, rol, id_empresa) — compatibles con UsuarioAutenticado del
// módulo tenancy. El refresh_token NO es un JWT (es opaco): no tiene payload.

export const JwtAccessPayload = z.object({
  /// id_usuario (Usuario.id_usuario). Numérico por coherencia con el resto del código.
  sub: z.number().int().positive(),
  rol: Rol,
  /// Presente SOLO para conductor/empresa; ausente en pasajero/admin/operador.
  /// El TenantGuard lo lee de aquí (ya NO de la cabecera x-empresa-id).
  id_empresa: z.number().int().positive().optional(),
  /// Discrimina el tipo de token (defensa ante confusión access/refresh).
  type: z.literal('access'),
  /// epoch (segundos). Los agrega @nestjs/jwt al firmar; opcionales al construir.
  iat: z.number().int().optional(),
  exp: z.number().int().optional(),
});
export type JwtAccessPayload = z.infer<typeof JwtAccessPayload>;

// -----------------------------------------------------------------------------
// Forma de la sesión emitida (común a OTP-verificar y a los dos logins)
// -----------------------------------------------------------------------------

export const SesionTokens = z.object({
  access_token: z.string().min(1), // JWT HS256, vida = expires_in
  refresh_token: z.string().min(1), // OPACO, revocable (tabla)
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive(), // segundos de vida del access_token
});
export type SesionTokens = z.infer<typeof SesionTokens>;

/// Datos mínimos del usuario para que el cliente pinte la sesión sin otra llamada.
export const UsuarioSesion = z.object({
  id_usuario: z.number().int().positive(),
  nombre: z.string(),
  apellido: z.string(),
  rol: Rol,
  /// conductor/empresa → número; pasajero/admin/operador → null.
  id_empresa: z.number().int().positive().nullable(),
  /// Enruta al pasajero nuevo a "completar perfil". Siempre true para conductor/admin.
  perfil_completo: z.boolean(),
});
export type UsuarioSesion = z.infer<typeof UsuarioSesion>;

/// Respuesta uniforme de todo login/verificación exitosa.
export const RespuestaSesion = z.object({
  tokens: SesionTokens,
  usuario: UsuarioSesion,
});
export type RespuestaSesion = z.infer<typeof RespuestaSesion>;

// -----------------------------------------------------------------------------
// Endpoint 1 — SOLICITAR OTP · HU-AUTH-01
// -----------------------------------------------------------------------------
// POST /auth/otp/solicitar
//   público (sin JWT) · rate-limit: throttler por IP + tabla codigo_otp por teléfono
//   200 SolicitarOtpRespuesta — SIEMPRE la misma forma exista o no la cuenta
//        (anti-enumeración: no se revela si el número está registrado)
//   400 datos inválidos (teléfono mal formado)
//   429 OTP_RATE_LIMIT (superó códigos por teléfono/ventana o reenvío < cooldown)
// Efecto: genera un OTP (OTP_LENGTH dígitos), guarda SOLO su hash (bcrypt) con TTL
// (OTP_TTL_SECONDS) en auth.codigo_otp y lo envía por el puerto SmsProvider.

export const SolicitarOtpDTO = z.object({
  telefono: Telefono,
});
export type SolicitarOtpDTO = z.infer<typeof SolicitarOtpDTO>;

export const SolicitarOtpRespuesta = z.object({
  enviado: z.literal(true),
  /// Cooldown antes de permitir reenvío (OTP_REENVIO_COOLDOWN_SECONDS, p.ej. 30).
  reenviar_en_seg: z.number().int().positive(),
  /// TTL del código para el countdown de la UI (OTP_TTL_SECONDS, p.ej. 300).
  expira_en_seg: z.number().int().positive(),
});
export type SolicitarOtpRespuesta = z.infer<typeof SolicitarOtpRespuesta>;

// -----------------------------------------------------------------------------
// Endpoint 2 — VERIFICAR OTP (login del pasajero) · HU-AUTH-01
// -----------------------------------------------------------------------------
// POST /auth/otp/verificar
//   público · 200 RespuestaSesion (rol=pasajero, id_empresa=null)
//   401 OTP_INVALIDO (código incorrecto)   ·   410 OTP_EXPIRADO
//   429 OTP_MAX_INTENTOS (superó OTP_MAX_INTENTOS verificaciones sobre ese código)
//   403 CUENTA_SUSPENDIDA (Usuario.estado_cuenta = 'suspendida')
// Efecto: valida el código contra el hash del OTP vigente del teléfono; lo marca
// `consumido`; emite la sesión. AUTO-REGISTRO del pasajero: ver nota abajo.
// NOTA (decisión de producto PENDIENTE): si el teléfono no tiene Usuario, el MVP
// crea uno mínimo (rol=pasajero, perfil_completo=false) → el cliente enruta a
// "completar perfil". Alternativa: exigir registro previo → 401. Marcado abierto.

export const VerificarOtpDTO = z.object({
  telefono: Telefono,
  codigo: CodigoOtp,
});
export type VerificarOtpDTO = z.infer<typeof VerificarOtpDTO>;

// -----------------------------------------------------------------------------
// Endpoint 3 — LOGIN CONDUCTOR (cédula + PIN) · HU-AUTH-02
// -----------------------------------------------------------------------------
// POST /auth/conductor/login
//   público · 200 RespuestaSesion (rol=conductor, id_empresa presente)
//   401 CREDENCIALES_INVALIDAS (cédula o PIN incorrectos — mensaje genérico)
//   403 CUENTA_SUSPENDIDA (Conductor.estado ∈ {suspendido, bloqueado_documentos})
//   429 CUENTA_BLOQUEADA_TEMPORAL (superó LOGIN_MAX_INTENTOS → bloqueado_hasta)
// Efecto: compara PIN contra hash bcrypt; al fallar incrementa intentos_fallidos;
// al éxito lo resetea. El PIN lo crea el admin y llega por SMS (fuera de este flujo).

export const LoginConductorDTO = z.object({
  cedula: Cedula,
  pin: Pin,
});
export type LoginConductorDTO = z.infer<typeof LoginConductorDTO>;

// -----------------------------------------------------------------------------
// Endpoint 4 — LOGIN ADMIN/OPERADOR (correo + contraseña) · HU-AUTH-03
// -----------------------------------------------------------------------------
// POST /auth/admin/login
//   público · 200 RespuestaSesion (rol=admin|operador, id_empresa=null · cross-tenant)
//   401 CREDENCIALES_INVALIDAS   ·   403 CUENTA_SUSPENDIDA
// Efecto: compara contraseña contra hash bcrypt de Usuario.contrasena. El rol del
// token sale de Usuario.rol (admin u operador) → distinto menú/permresos en la PWA.

export const LoginAdminDTO = z.object({
  correo: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
});
export type LoginAdminDTO = z.infer<typeof LoginAdminDTO>;

// -----------------------------------------------------------------------------
// Endpoint 5 — REFRESH (renueva access + ROTA refresh) · HU-AUTH-04
// -----------------------------------------------------------------------------
// POST /auth/refresh
//   público (autoriza el propio refresh_token, no el access) · 200 SesionTokens
//   401 REFRESH_INVALIDO (no existe / hash no coincide)
//   401 REFRESH_EXPIRADO   ·   401 REFRESH_REVOCADO (logout, rotado o suspensión)
// ROTACIÓN: valida el refresh por su hash; marca la fila `revocado=true` y crea una
// fila nueva → devuelve access nuevo + refresh NUEVO. DETECCIÓN DE REÚSO: si el
// refresh presentado ya estaba `revocado`, se revocan TODAS las sesiones del usuario
// (posible robo de token) y se responde 401 (ver ADR-005).

export const RefreshDTO = z.object({
  refresh_token: z.string().min(1),
});
export type RefreshDTO = z.infer<typeof RefreshDTO>;

/// Renovar devuelve un juego de tokens nuevo (access + refresh rotado). Misma forma
/// que SesionTokens (DRY): el cliente reemplaza AMBOS en expo-secure-store.
export const RespuestaRefresh = SesionTokens;
export type RespuestaRefresh = SesionTokens;

// -----------------------------------------------------------------------------
// Endpoint 6 — LOGOUT (revoca el refresh) · HU-AUTH-04
// -----------------------------------------------------------------------------
// POST /auth/logout
//   público (basta el refresh_token) · 200 { ok:true } (IDEMPOTENTE: 200 aunque
//   el token ya no exista o ya estuviera revocado — no filtra información)
// Efecto: marca `revocado=true` la fila del refresh. El access token vivo expira
// solo por su cuenta (≤15 min); no hay blacklist de access (KISS — ADR-005).

export const LogoutDTO = z.object({
  refresh_token: z.string().min(1),
});
export type LogoutDTO = z.infer<typeof LogoutDTO>;

export const RespuestaLogout = z.object({ ok: z.literal(true) });
export type RespuestaLogout = z.infer<typeof RespuestaLogout>;

// -----------------------------------------------------------------------------
// Errores tipados del dominio (consistentes back↔front, forma { codigo, mensaje })
// -----------------------------------------------------------------------------

export const CodigoErrorAuth = z.enum([
  'OTP_INVALIDO', // 401 — código incorrecto
  'OTP_EXPIRADO', // 410 — venció el TTL
  'OTP_MAX_INTENTOS', // 429 — demasiadas verificaciones sobre el mismo código
  'OTP_RATE_LIMIT', // 429 — demasiadas solicitudes por teléfono/ventana o < cooldown
  'CREDENCIALES_INVALIDAS', // 401 — cédula/PIN o correo/contraseña (genérico, anti-enumeración)
  'CUENTA_SUSPENDIDA', // 403 — estado_cuenta o estado del conductor no habilita
  'CUENTA_BLOQUEADA_TEMPORAL', // 429 — lockout por intentos fallidos (reintentar_en_seg)
  'REFRESH_INVALIDO', // 401 — refresh no encontrado / hash no coincide
  'REFRESH_EXPIRADO', // 401 — refresh vencido
  'REFRESH_REVOCADO', // 401 — refresh revocado (logout, rotación o suspensión)
  'SESION_REQUERIDA', // 401 — falta o es inválido el access token (AuthGuard)
  'PROHIBIDO', // 403 — rol no autorizado para el recurso (RolesGuard)
]);
export type CodigoErrorAuth = z.infer<typeof CodigoErrorAuth>;

export const ErrorAuth = z.object({
  codigo: CodigoErrorAuth,
  mensaje: z.string(),
  /// Presente en CUENTA_BLOQUEADA_TEMPORAL / OTP_RATE_LIMIT: segundos hasta reintentar.
  reintentar_en_seg: z.number().int().positive().optional(),
});
export type ErrorAuth = z.infer<typeof ErrorAuth>;

// -----------------------------------------------------------------------------
// EVENTOS in-process del dominio auth (NestJS EventEmitter — sin broker)
// -----------------------------------------------------------------------------

export const EVENTOS_AUTH = {
  /// emisor: auth · consumidores: (auditoría / PostHog) — login exitoso.
  SESION_INICIADA: 'auth.sesion_iniciada',
  /// emisor: auth · consumidores: (auditoría) — logout o revocación.
  SESION_CERRADA: 'auth.sesion_cerrada',
} as const;
export type NombreEventoAuth = (typeof EVENTOS_AUTH)[keyof typeof EVENTOS_AUTH];

export const SesionIniciadaEvent = z.object({
  id_usuario: z.number().int().positive(),
  rol: Rol,
  ocurrido_en: z.string().datetime(),
});
export type SesionIniciadaEvent = z.infer<typeof SesionIniciadaEvent>;

// -----------------------------------------------------------------------------
// Evento CONSUMIDO por auth · PRODUCIDO por el dominio fleet/admin (HU-AUTH-05)
// -----------------------------------------------------------------------------
// Al suspender/bloquear un conductor, el módulo que lo hace emite este evento; el
// AuthService lo escucha y REVOCA todos los refresh tokens del usuario (corte de
// sesión inmediato — el access vivo caduca en ≤15 min). Se declara el contrato aquí
// (el dominio fleet aún no tiene su archivo de contratos); el emisor lo importará.

export const EVENTO_CONDUCTOR_SUSPENDIDO = 'fleet.conductor_suspendido';

export const ConductorSuspendidoEvent = z.object({
  /// = Usuario.id_usuario (Conductor.id_conductor comparte PK con Usuario).
  id_conductor: z.number().int().positive(),
  id_empresa: z.number().int().positive(),
  /// Estado destino que motiva el corte de acceso.
  motivo: z.enum(['suspendido', 'bloqueado_documentos', 'inactivo']),
  ocurrido_en: z.string().datetime(),
});
export type ConductorSuspendidoEvent = z.infer<typeof ConductorSuspendidoEvent>;
