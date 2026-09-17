# Changelog — voyya-backend

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.0.0/). Fechas en AAAA-MM-DD.

## [Sin publicar] — 2026-09-16 · Ciclo "Viaje en curso y cobro en efectivo"

Referencia de diseño: [ADR-009](../docs/architecture/decisions/ADR-009-cierre-atomico-del-viaje-y-transiciones-idempotentes.md) ·
[ADR-010](../docs/architecture/decisions/ADR-010-marca-de-llegada-y-cierre-en-trip-request.md) ·
[ADR-011](../docs/architecture/decisions/ADR-011-turno-y-ubicacion-del-conductor-sin-tracking-continuo.md).
Reporte de seguridad del ciclo: [docs/security/reporte-ciclo-viaje.md](../docs/security/reporte-ciclo-viaje.md).
API detallada en [docs/api/trips.md](../docs/api/trips.md), [docs/api/driver.md](../docs/api/driver.md).

### Agregado

- Seis transiciones nuevas del conductor sobre el viaje, todas `POST /trips/:id/*`: `en-route`, `arrived`,
  `start`, `complete`, `no-show`, `cash-collected` (`trip-lifecycle.controller.ts` +
  `trip-lifecycle.service.ts`). El viaje ahora recorre su ciclo completo:
  `pending_assignment → assigned → driver_en_route → in_progress → completed`.
- Módulo `/driver/*` (dentro de `assignment`): `PUT /driver/shift` (activar/terminar turno, ubicación
  obligatoria para activarlo), `POST /driver/location` (reporte de posición fuera de turno/transición),
  `GET /driver/me` (estado de turno + viaje activo), `GET /driver/trips/cash-pending` (cobros pendientes de
  confirmar).
- `TripClosingService.closeTrip()`: primitivo único y transaccional que cierra el viaje, cierra la
  asignación y libera al conductor en una sola transacción, para los cuatro finales
  (`completed`/`no_show`/ambas cancelaciones).
- Columnas nuevas en `trips.trip_request`: `arrived_at`, `cash_collected_at`, `penalty_recorded`.
  `finished_at` pasa a escribirse para los seis finales del viaje (antes no se escribía nunca).
- Parámetros operativos nuevos: `no_show_grace_min` (default 5 min), `location_stale_min` (default 15 min).
- `net_earnings` calculado en SQL (`fare - commission`) dentro de la misma transacción de cierre.

### Cambiado

- `AssignmentService.cancelByDriver`: el destino del viaje ahora depende del estado de origen. Si el viaje
  ya estaba `driver_en_route`, cancelar **termina** el viaje (`cancelled_by_driver`) en vez de reabrir la
  búsqueda con otro conductor. `CancelAssignmentByDriverResult.searching_again` deja de ser `true` fijo.
- `GET /trips/:id`: `STATUSES_WITH_DRIVER` ahora incluye `completed` (antes el conductor desaparecía de la
  respuesta justo en el cierre); `contact_phone` y `eta` se restringen a `assigned`/`driver_en_route`.
- Todas las marcas de tiempo del SQL crudo de `trips`/`assignment` (asignación, cierre, cortesía de
  `no_show`) se escriben y comparan con `AT TIME ZONE 'UTC'` explícito.
- `AssignmentRepository.getAssignmentForDriver`: el filtro de estados de la asignación que valida propiedad
  ya no acepta `cancelled`. Solo `accepted` habilita las cinco transiciones vivas; `completed` habilita
  únicamente `cash-collected`.
- `AssignmentRepository.closeAssignmentsForTrip` filtra además por `driver_id` cuando se le pasa uno.
- `voyya-shared`: `DriverStatus` se mueve de `contracts/assignment.ts` a `contracts/driver.ts` (nuevo
  archivo). Orden de dependencias resultante: `trips ← driver ← assignment`.

### Corregido

- **Critical** — un conductor que aceptaba y cancelaba un viaje podía, tras eso, cerrar el viaje de otro
  conductor que sí lo había tomado (asignación `cancelled` seguía autorizando las transiciones). Cerrado
  restringiendo el filtro de propiedad y añadiendo `AND driver_id` al cierre de asignaciones.
- **High** — desfase de zona horaria de 5 horas entre PostgreSQL (sesión en `America/Bogota`) y la lectura
  de Prisma (asume UTC) hacía que `assigned_at` llegara al cálculo de penalidad ~300 minutos "en el pasado":
  toda cancelación posterior a la asignación se marcaba `penalty_recorded = true`, sin importar cuán rápido
  cancelara el pasajero.
- **High** — `GET /trips/:id` sobre un viaje `completed` exponía indefinidamente el teléfono real del
  conductor y permitía recalcular su distancia al destino en cada sondeo (oráculo de ubicación). Corregido
  restringiendo `contact_phone`/`eta` a los estados activos del viaje.
- La cancelación del pasajero mientras el conductor iba en camino (`driver_en_route`) dejaba el viaje
  clavado en ese estado para siempre (la API respondía éxito, pero la transición no existía en el enum de
  destino). Corregido: `cancel()` delega en `TripClosingService.closeTrip`, que sí conoce el estado de
  origen.
- `penalty_recorded` pasa a escribirse de forma monótona (`penalty_recorded OR $nuevo`) para que un cierre
  futuro sobre `closeTrip` no pueda borrar un registro de penalidad ya escrito.

### Seguridad

- Ver [docs/security/reporte-ciclo-viaje.md](../docs/security/reporte-ciclo-viaje.md) para el detalle
  completo: veredicto inicial **FAIL** por el hallazgo Critical (V-01); tras la corrección, el ciclo queda en
  revisión de las condiciones High (V-02/V-03, ambas corregidas) y Medium/Low pendientes para pre-piloto
  (V-04…V-14).

### Pendiente / EV1+

- Verificación de la llegada real del conductor y de la plausibilidad de la posición reportada (V-05).
- Actor y evento en la confirmación de cobro en efectivo (V-04).
- Borrado por vencimiento de la ubicación cuando el conductor no cierra turno explícitamente (V-07).
- Consentimiento y aviso de privacidad para la geolocalización laboral (V-08, Ley 1581).
- Pruebas e2e de propiedad/cross-tenant para los diez endpoints nuevos (V-06).

### Pruebas

- La suite pasa de 107 a 175 pruebas en este ciclo (unitarias + integración de los módulos `trips` y
  `assignment`, incluidas concurrencia de la toma única y del cierre atómico).
