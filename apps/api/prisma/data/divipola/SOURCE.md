# Fuente del catálogo de municipios (DIVIPOLA)

Archivo versionado: `divipola-2024-12-30.csv`, descarga literal y sin editar de la fuente. Lo lee
`scripts/divipola/build-catalog-migration.ts`, que genera la migración
`20261009100000_municipality_dane_catalog`. Decisión: ADR-031 §3 y §4, D-1.

- **Conjunto:** "DIVIPOLA- Códigos municipios", datos.gov.co, id `gdxc-w37w`.
- **URL:** https://www.datos.gov.co/d/gdxc-w37w
- **Descarga reproducible:** `https://www.datos.gov.co/resource/gdxc-w37w.csv?$limit=5000`. Sin `$limit` la API de Socrata devuelve solo 1.000 filas.
- **Publica y atribución:** Departamento Administrativo Nacional de Estadística (DANE), https://www.dane.gov.co/
- **Fecha de corte:** 2024-12-30 ("Actualización a corte 30 diciembre 2024").
- **Fecha de descarga:** 2026-10-08.
- **Licencia:** Creative Commons Atribución-CompartirIgual 4.0 Internacional (CC BY-SA 4.0), `licenseId: CC_40_BY_SA` en los metadatos.
- **Cita:** "Fuente: Departamento Administrativo Nacional de Estadística: www.dane.gov.co".
- **sha256 del CSV:** `56f42b7cb97049ce52ee86e86b1393df0025aa1b1aec32b2b09f4b6acd5e1221`
- **Conteo total:** 1.122 filas (`SELECT count(*)` contra la API: `[{"count":"1122"}]`).
- **Conteo por tipo:** 1.103 `municipality` · 1 `island` (San Andrés, `88001`) · 18 `non_municipalized_area`.
- **Checksum esperado del catálogo cargado:** `ad5127ec5de21d1ee96031727fd2cca6`

## Contraste con el geoportal del DANE (D-1)

**Por confirmar por el dueño.** La página del geoportal
(https://geoportal.dane.gov.co/servicios/descarga-y-metadatos/datos-geoestadisticos/?cod=112, "Listados completos de
Codificación Divipola", `Listados_DIVIPOLA.xlsx`) se genera con JavaScript y no se pudo leer ni descargar el Excel desde el
entorno de construcción. Antes de liberar, el dueño abre el Excel y anota aquí:

- conteo de filas del Excel: ____
- fecha de corte del Excel: ____
- fecha de la comparación: ____
- resultado: si el geoportal trae un corte posterior con cambios, se detiene la liberación y se vuelve al dueño antes de
  regenerar la migración.

## Regenerar

Desde `voyya-backend/apps/api`:

```
pnpm exec ts-node scripts/divipola/build-catalog-migration.ts \
  --out prisma/migrations/20261009100000_municipality_dane_catalog/migration.sql
```

El generador verifica el sha256 de este archivo, exige 1.122 filas y falla sin escribir nada si algo no cuadra. Una vez
aplicada, la migración no se edita: Prisma guarda su checksum. Un corte nuevo del DANE es otra migración.
