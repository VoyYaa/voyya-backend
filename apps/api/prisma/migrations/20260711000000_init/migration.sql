-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "admin";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "assignment";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "auth";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "fleet";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "tenancy";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "trips";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "users";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "postgis";

-- CreateEnum
CREATE TYPE "tenancy"."EstadoEmpresa" AS ENUM ('pendiente', 'activa', 'suspendida', 'rechazada');

-- CreateEnum
CREATE TYPE "fleet"."EstadoConductor" AS ENUM ('disponible', 'en_servicio', 'fuera_de_turno', 'inactivo', 'suspendido', 'bloqueado_documentos');

-- CreateEnum
CREATE TYPE "trips"."EstadoSolicitud" AS ENUM ('pendiente_de_asignacion', 'asignada', 'conductor_en_camino', 'en_curso', 'completada', 'cancelada_cliente', 'cancelada_conductor', 'sin_conductor', 'no_show', 'expirada');

-- CreateEnum
CREATE TYPE "assignment"."EstadoAsignacion" AS ENUM ('creada', 'notificada', 'aceptada', 'rechazada', 'timeout', 'cancelada', 'finalizada');

-- CreateEnum
CREATE TYPE "trips"."TipoServicio" AS ENUM ('taxi', 'moto', 'confort', 'envio');

-- CreateEnum
CREATE TYPE "trips"."MetodoPago" AS ENUM ('efectivo', 'nequi', 'daviplata', 'tarjeta');

-- CreateTable
CREATE TABLE "tenancy"."empresa" (
    "id_empresa" SERIAL NOT NULL,
    "razon_social" TEXT NOT NULL,
    "nit" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "id_municipio" INTEGER NOT NULL,
    "n_vehiculos" INTEGER,
    "correo_contacto" TEXT,
    "estado" "tenancy"."EstadoEmpresa" NOT NULL DEFAULT 'activa',
    "cuota_afiliacion" DECIMAL(12,2),
    "fecha_registro" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "empresa_pkey" PRIMARY KEY ("id_empresa")
);

-- CreateTable
CREATE TABLE "tenancy"."municipio" (
    "id_municipio" SERIAL NOT NULL,
    "nombre" TEXT NOT NULL,
    "departamento" TEXT NOT NULL,
    "poligono_cobertura" JSONB NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'activo',

    CONSTRAINT "municipio_pkey" PRIMARY KEY ("id_municipio")
);

-- CreateTable
CREATE TABLE "auth"."usuario" (
    "id_usuario" SERIAL NOT NULL,
    "nombre" TEXT NOT NULL,
    "apellido" TEXT NOT NULL,
    "correo" TEXT,
    "telefono" TEXT NOT NULL,
    "contrasena" TEXT,
    "rol" TEXT NOT NULL,
    "estado_cuenta" TEXT NOT NULL DEFAULT 'activa',
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usuario_pkey" PRIMARY KEY ("id_usuario")
);

-- CreateTable
CREATE TABLE "auth"."refresh_token" (
    "id" SERIAL NOT NULL,
    "id_usuario" INTEGER NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expira_en" TIMESTAMP(3) NOT NULL,
    "revocado" BOOLEAN NOT NULL DEFAULT false,
    "user_agent" TEXT,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth"."codigo_otp" (
    "id" SERIAL NOT NULL,
    "telefono" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expira_en" TIMESTAMP(3) NOT NULL,
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "consumido" BOOLEAN NOT NULL DEFAULT false,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "codigo_otp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users"."pasajero" (
    "id_cliente" INTEGER NOT NULL,
    "metodo_pago_pref" "trips"."MetodoPago" NOT NULL DEFAULT 'efectivo',
    "direccion_principal" TEXT,
    "contacto_confianza" TEXT,

    CONSTRAINT "pasajero_pkey" PRIMARY KEY ("id_cliente")
);

-- CreateTable
CREATE TABLE "fleet"."conductor" (
    "id_conductor" INTEGER NOT NULL,
    "id_empresa" INTEGER NOT NULL,
    "cedula" TEXT NOT NULL,
    "pin" TEXT NOT NULL,
    "licencia" TEXT,
    "calificacion_promedio" DOUBLE PRECISION,
    "estado" "fleet"."EstadoConductor" NOT NULL DEFAULT 'fuera_de_turno',
    "intentos_fallidos" INTEGER NOT NULL DEFAULT 0,
    "bloqueado_hasta" TIMESTAMP(3),
    "lat_actual" DOUBLE PRECISION,
    "lng_actual" DOUBLE PRECISION,
    "ubicacion_actualizada_en" TIMESTAMP(3),
    "id_taxi_actual" INTEGER,
    "actualizado_en" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conductor_pkey" PRIMARY KEY ("id_conductor")
);

-- CreateTable
CREATE TABLE "fleet"."taxi" (
    "id_taxi" SERIAL NOT NULL,
    "id_empresa" INTEGER NOT NULL,
    "placa" TEXT NOT NULL,
    "modelo" TEXT,
    "anio" INTEGER,
    "tarjeta_operacion" TEXT,
    "estado" TEXT NOT NULL DEFAULT 'activo',

    CONSTRAINT "taxi_pkey" PRIMARY KEY ("id_taxi")
);

-- CreateTable
CREATE TABLE "trips"."solicitud_viaje" (
    "id_solicitud" SERIAL NOT NULL,
    "id_cliente" INTEGER NOT NULL,
    "id_municipio" INTEGER NOT NULL,
    "tipo_servicio" "trips"."TipoServicio" NOT NULL DEFAULT 'taxi',
    "metodo_pago" "trips"."MetodoPago" NOT NULL DEFAULT 'efectivo',
    "direccion_recogida" TEXT NOT NULL,
    "direccion_destino" TEXT NOT NULL,
    "lat_recogida" DOUBLE PRECISION NOT NULL,
    "lng_recogida" DOUBLE PRECISION NOT NULL,
    "lat_destino" DOUBLE PRECISION NOT NULL,
    "lng_destino" DOUBLE PRECISION NOT NULL,
    "fecha_hora_solicitud" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "estado" "trips"."EstadoSolicitud" NOT NULL DEFAULT 'pendiente_de_asignacion',
    "asignada_en" TIMESTAMP(3),
    "tipo" TEXT NOT NULL DEFAULT 'inmediato',
    "fecha_hora_recogida" TIMESTAMP(3),
    "finalizacion" TIMESTAMP(3),
    "distancia" DOUBLE PRECISION,
    "tarifa" DECIMAL(12,2) NOT NULL,
    "comision" DECIMAL(12,2) NOT NULL,
    "ingresos_generados" DECIMAL(12,2),
    "actualizado_en" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "solicitud_viaje_pkey" PRIMARY KEY ("id_solicitud")
);

-- CreateTable
CREATE TABLE "trips"."configuracion_tarifa" (
    "id_tarifa" SERIAL NOT NULL,
    "id_municipio" INTEGER NOT NULL,
    "tipo_servicio" "trips"."TipoServicio" NOT NULL DEFAULT 'taxi',
    "tarifa_base" DECIMAL(12,2) NOT NULL,
    "recargo_nocturno_pct" DECIMAL(5,2) NOT NULL DEFAULT 20,
    "recargo_festivo_pct" DECIMAL(5,2) NOT NULL DEFAULT 15,
    "comision_pct" DECIMAL(5,2) NOT NULL DEFAULT 8,
    "fecha_desde" DATE,
    "fecha_hasta" DATE,

    CONSTRAINT "configuracion_tarifa_pkey" PRIMARY KEY ("id_tarifa")
);

-- CreateTable
CREATE TABLE "assignment"."asignacion" (
    "id_asignacion" SERIAL NOT NULL,
    "id_solicitud" INTEGER NOT NULL,
    "id_conductor" INTEGER NOT NULL,
    "id_taxi" INTEGER NOT NULL,
    "id_empresa" INTEGER NOT NULL,
    "estado" "assignment"."EstadoAsignacion" NOT NULL DEFAULT 'creada',
    "asignado_por" TEXT NOT NULL DEFAULT 'sistema',
    "orden_intento" INTEGER NOT NULL DEFAULT 1,
    "fecha_asignacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notificada_en" TIMESTAMP(3),
    "respondida_en" TIMESTAMP(3),
    "expira_en" TIMESTAMP(3),
    "motivo_cancelacion" TEXT,

    CONSTRAINT "asignacion_pkey" PRIMARY KEY ("id_asignacion")
);

-- CreateTable
CREATE TABLE "admin"."parametros_sistema" (
    "id" SERIAL NOT NULL,
    "clave" TEXT NOT NULL,
    "valor" TEXT NOT NULL,
    "id_municipio" INTEGER,

    CONSTRAINT "parametros_sistema_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "empresa_nit_key" ON "tenancy"."empresa"("nit");

-- CreateIndex
CREATE INDEX "empresa_id_municipio_idx" ON "tenancy"."empresa"("id_municipio");

-- CreateIndex
CREATE UNIQUE INDEX "usuario_correo_key" ON "auth"."usuario"("correo");

-- CreateIndex
CREATE UNIQUE INDEX "usuario_telefono_key" ON "auth"."usuario"("telefono");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_token_hash_key" ON "auth"."refresh_token"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_token_id_usuario_revocado_idx" ON "auth"."refresh_token"("id_usuario", "revocado");

-- CreateIndex
CREATE INDEX "refresh_token_expira_en_idx" ON "auth"."refresh_token"("expira_en");

-- CreateIndex
CREATE INDEX "codigo_otp_telefono_creado_en_idx" ON "auth"."codigo_otp"("telefono", "creado_en");

-- CreateIndex
CREATE UNIQUE INDEX "conductor_cedula_key" ON "fleet"."conductor"("cedula");

-- CreateIndex
CREATE INDEX "conductor_id_empresa_estado_idx" ON "fleet"."conductor"("id_empresa", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "taxi_placa_key" ON "fleet"."taxi"("placa");

-- CreateIndex
CREATE INDEX "taxi_id_empresa_estado_idx" ON "fleet"."taxi"("id_empresa", "estado");

-- CreateIndex
CREATE INDEX "solicitud_viaje_id_municipio_estado_fecha_hora_solicitud_idx" ON "trips"."solicitud_viaje"("id_municipio", "estado", "fecha_hora_solicitud");

-- CreateIndex
CREATE INDEX "solicitud_viaje_tipo_servicio_estado_idx" ON "trips"."solicitud_viaje"("tipo_servicio", "estado");

-- CreateIndex
CREATE INDEX "configuracion_tarifa_id_municipio_tipo_servicio_idx" ON "trips"."configuracion_tarifa"("id_municipio", "tipo_servicio");

-- CreateIndex
CREATE INDEX "asignacion_id_conductor_estado_fecha_asignacion_idx" ON "assignment"."asignacion"("id_conductor", "estado", "fecha_asignacion");

-- CreateIndex
CREATE INDEX "asignacion_id_solicitud_estado_idx" ON "assignment"."asignacion"("id_solicitud", "estado");

-- CreateIndex
CREATE INDEX "asignacion_id_empresa_estado_idx" ON "assignment"."asignacion"("id_empresa", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "parametros_sistema_clave_id_municipio_key" ON "admin"."parametros_sistema"("clave", "id_municipio");

-- AddForeignKey
ALTER TABLE "tenancy"."empresa" ADD CONSTRAINT "empresa_id_municipio_fkey" FOREIGN KEY ("id_municipio") REFERENCES "tenancy"."municipio"("id_municipio") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth"."refresh_token" ADD CONSTRAINT "refresh_token_id_usuario_fkey" FOREIGN KEY ("id_usuario") REFERENCES "auth"."usuario"("id_usuario") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users"."pasajero" ADD CONSTRAINT "pasajero_id_cliente_fkey" FOREIGN KEY ("id_cliente") REFERENCES "auth"."usuario"("id_usuario") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet"."conductor" ADD CONSTRAINT "conductor_id_conductor_fkey" FOREIGN KEY ("id_conductor") REFERENCES "auth"."usuario"("id_usuario") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet"."conductor" ADD CONSTRAINT "conductor_id_empresa_fkey" FOREIGN KEY ("id_empresa") REFERENCES "tenancy"."empresa"("id_empresa") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet"."conductor" ADD CONSTRAINT "conductor_id_taxi_actual_fkey" FOREIGN KEY ("id_taxi_actual") REFERENCES "fleet"."taxi"("id_taxi") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fleet"."taxi" ADD CONSTRAINT "taxi_id_empresa_fkey" FOREIGN KEY ("id_empresa") REFERENCES "tenancy"."empresa"("id_empresa") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips"."solicitud_viaje" ADD CONSTRAINT "solicitud_viaje_id_cliente_fkey" FOREIGN KEY ("id_cliente") REFERENCES "users"."pasajero"("id_cliente") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips"."solicitud_viaje" ADD CONSTRAINT "solicitud_viaje_id_municipio_fkey" FOREIGN KEY ("id_municipio") REFERENCES "tenancy"."municipio"("id_municipio") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trips"."configuracion_tarifa" ADD CONSTRAINT "configuracion_tarifa_id_municipio_fkey" FOREIGN KEY ("id_municipio") REFERENCES "tenancy"."municipio"("id_municipio") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment"."asignacion" ADD CONSTRAINT "asignacion_id_solicitud_fkey" FOREIGN KEY ("id_solicitud") REFERENCES "trips"."solicitud_viaje"("id_solicitud") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment"."asignacion" ADD CONSTRAINT "asignacion_id_conductor_fkey" FOREIGN KEY ("id_conductor") REFERENCES "fleet"."conductor"("id_conductor") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment"."asignacion" ADD CONSTRAINT "asignacion_id_taxi_fkey" FOREIGN KEY ("id_taxi") REFERENCES "fleet"."taxi"("id_taxi") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment"."asignacion" ADD CONSTRAINT "asignacion_id_empresa_fkey" FOREIGN KEY ("id_empresa") REFERENCES "tenancy"."empresa"("id_empresa") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin"."parametros_sistema" ADD CONSTRAINT "parametros_sistema_id_municipio_fkey" FOREIGN KEY ("id_municipio") REFERENCES "tenancy"."municipio"("id_municipio") ON DELETE SET NULL ON UPDATE CASCADE;

