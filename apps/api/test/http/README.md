# Flujos HTTP de punta a punta (multiempresa)

Scripts de verificacion contra una API real y un Postgres desechable. No sustituyen a Jest: ejercitan la integracion que Jest
simula (API real, rol `app_voyya`, dos o tres empresas, consola y app del pasajero).

Limites de la API (en memoria, por IP): 3 solicitudes de afiliacion por hora y 3 OTP por minuto. 02-affiliation usa 2 de las 3 solicitudes
horarias y la prueba de la consola usa la tercera; reinicia la API antes de repetir una corrida. `RESTART_API_CMD` hace ese reinicio antes de la consola.

Requisitos:

- Postgres `postgis/postgis:16-3.4` en un puerto libre (no el 5459). `reset-verification-db.sh` lo deja migrado, con
  `app_voyya` y el seed.
- API de `feat/multiempresa` compilada, arrancada con el cwd fuera de `apps/api` y `EMAIL_PROVIDER=noop PUSH_PROVIDER=noop
  SMS_PROVIDER=console` por variable de shell. El OTP del pasajero se lee del log de la API (`API_LOG`).
- Variables: `STATE_FILE`, `API_LOG`, `RESULTS_DIR`; opcionales `ADMIN_DIR` (+ `ADMIN_URL`) y `PASSENGER_WEB_URL`.
- Cada script sale con codigo distinto de cero si algun `check` falla. `run-all.sh` los encadena.

Limites conocidos del entorno: el PIN temporal y la contrasena temporal salen redactados o solo por correo, asi que los
scripts los reemplazan por SQL como superusuario; los limites de frecuencia de la API (3 OTP por minuto, 3 solicitudes de
afiliacion por hora) se absorben con reintentos y reiniciando la API entre corridas.
