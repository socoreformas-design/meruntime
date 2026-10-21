# CHARTER — Me Runtime

## Estado actual

Me Runtime es un runtime local que evalúa acciones propuestas como `Intent` y
produce `GREEN`, `YELLOW` o `RED`. La política es código determinista (`evaluate`),
no un modelo de lenguaje. La evaluación pura no hace red ni lee archivos; el
CORE carga el mandato vigente y el kill switch antes de autorizar ejecución.

Los hosts actuales son CLI y MCP por stdio. Traducen solicitudes HTTP a intents,
presentan estados y ejecutan solicitudes permitidas. Las solicitudes que el CORE
administra pasan por `executeAuthorized(intent)`; una aprobación pendiente pasa
por `approvePending(id)`. Son las únicas entradas del CORE que ejecutan acciones.

## Política y aprobación

El mandato de runtime está en `~/.meruntime/mandate.json` (o en
`MERUNTIME_MANDATE`; `meruntime init` lo crea desde `examples/mandates/starter.json`);
el kill switch persistente está en `~/.meruntime/kill.json`. Todo el estado
(`.meruntime/` en las rutas de abajo) vive en `~/.meruntime`, o en `MERUNTIME_HOME`
si está definida. `executeAuthorized` vuelve a leer ambos, llama a
`evaluate` y solo ejecuta con veredicto `GREEN`. `YELLOW` y `RED` se auditan y
rechazan con un error tipado.

`approvePending` verifica la integridad del intent, carga otra vez el mandato y
el kill switch y reevalúa antes de ejecutar. En esa reevaluación las reglas
`confirm` se consideran aprobadas por la persona y se omiten `quietHours`; las
denegaciones, `denyHosts` y los techos configurados siguen aplicándose. Un
pending alterado, una política que lo deniega o un kill switch activo queda
`invalidated` y genera un evento de auditoría.

### Espera de aprobación y expiración

Con veredicto `YELLOW`, el runtime guarda la solicitud y sus transiciones en
`.meruntime/requests.json`. Las modificaciones son atómicas y usan el lock
`.meruntime/requests.json.lock`. Por defecto, `executeAuthorized(intent)` espera
la decisión; `waitForRequest` consulta el estado cada 500 ms hasta que sea
terminal. `{ wait: false }` devuelve `{ pending: true, id, expiresAt }` sin
esperar. `approveRequest` y `denyRequest` registran la decisión en
`requests.json`; al aprobar, se reevalúan el mandato y el kill switch antes de
ejecutar.

Cada solicitud pendiente lleva `expiresAt` (ISO), incluido en el `intentMac`.
El plazo se configura en el mandato con `approvalTimeoutMs` (ms; por defecto
300000 = 5 min; `examples/mandates/personal.json` lo declara). Al vencer, la
solicitud pasa a `EXPIRED` bajo el lock de `requests.json` y se audita
(`event: transition`). Una solicitud vencida nunca se ejecuta.

`.meruntime/pending.json` queda reservado a la API heredada `createPending` /
`approvePending`, conservada por compatibilidad; el runtime actual no la usa
para las solicitudes MCP/CLI.

### Solicitudes, estados e idempotencia

Cada solicitud vive en `.meruntime/requests.json` (junto a `pending.json`) y
avanza solo por `transition()` (`stateMachine.ts`): RECEIVED→EVALUATING;
EVALUATING→EXECUTING|PENDING|DENIED; PENDING→APPROVED|DENIED|EXPIRED;
APPROVED→EXECUTING|DENIED; EXECUTING→EXECUTED|FAILED|UNKNOWN. EXECUTED, DENIED,
EXPIRED, FAILED y UNKNOWN son terminales y nunca se reejecutan. Cada transición
se escribe de forma atómica y bajo lock antes de llamar a un adaptador, y se
audita (`event: transition`, con `params_hash`). La clave de idempotencia es la
del agente o, si falta, el `payloadHash`; misma clave y payload devuelve el
estado o resultado almacenado, y otro payload da `IDEMPOTENCY_KEY_REUSED`.
`executionTimeoutMs` (60 s por defecto) sin respuesta del adaptador deja la
solicitud en UNKNOWN, sin reintento. `pending.json` y `approvePending` son la
API heredada y ya no los usa el runtime.

Durante una mutación de `requests.json` bajo lock, los registros terminales con
`updatedAt` de más de 30 días se compactan en tombstones con ID, clave de
idempotencia, hash del payload y estado. `audit.jsonl` permanece append-only y
no se compacta ni se reescribe.

## Ejecución HTTP

- El CORE administra `POST protected.local/mark` y `GET https://api.github.com/user`.
- Las credenciales no se pasan al agente, CLI ni tool MCP. El CORE las lee de
  `~/.meruntime/secrets.json` (`%USERPROFILE%\\.meruntime\\secrets.json` en
  Windows). Los campos actuales son `protectedToken`, `githubToken` y
  `pendingHmacKey`.
- Si falta `pendingHmacKey`, se genera con 32 bytes aleatorios y se guarda en
  ese archivo, fuera del repositorio. Las pruebas configuran `MERUNTIME_SECRETS`
  con un archivo temporal.
- Los pending viven en `.meruntime/pending.json`. Cada intent se sanea y se
  protege con `intentMac`, HMAC-SHA-256 de su forma canónica más el id, agente y
  acción. Los pending antiguos que solo contienen `intentHash` no son válidos.
- Las solicitudes HTTP genéricas (`http.request`) también las ejecuta el CORE:
  un GREEN debe pasar el guard de `allowHosts`, no se siguen redirecciones y el
  cuerpo de la respuesta solo se devuelve en vivo, sin guardarse. Un YELLOW
  guarda la petición original, firmada con HMAC (`replayMac`), hasta que la
  solicitud termina; si la firma no coincide al aprobar, se deniega.

La auditoría append-only se escribe en `.meruntime/audit.jsonl`. El executor
mantiene una caché de idempotencia en memoria, cuya clave incluye el intent
serializado y, por tanto, `agentId`. Un hit devuelve `{ success: true, status:
200 }` sin cuerpo de respuesta; la caché no sobrevive al reinicio del proceso.

## Límites conocidos

- `dailySpendEur` compara el total diario ejecutado, en curso o de resultado
  incierto más el importe nuevo contra el techo, usando el libro de solicitudes.
- La persistencia es local en JSON/JSONL, sin base de datos ni coordinación
  distribuida; solo `pending.json` se protege con un lock file local.
- No hay interfaz gráfica ni cliente móvil. El runtime no controla las tools
  externas o nativas que un agente pueda tener fuera de CLI/MCP.

## Modelo de datos

`Mandate` contiene reglas, hosts y acciones denegadas, techos de gasto,
`quietHours` y `killSwitch`. `Intent` describe agente, acción, herramienta,
objetivo y efectos propuestos. `evaluate` no autentica la identidad del agente:
la identidad la aporta el host que construye el intent.

## v0 histórico

El v0 fue un esqueleto TypeScript centrado en especificar el semáforo. En aquella
etapa no había ejecución HTTP real ni almacenamiento de secretos, y cada
evaluación era independiente. Esas restricciones describen el estado histórico,
no el runtime actual: hoy hay ejecución HTTP mediante hosts/CORE, credenciales
locales, pending, auditoría y kill switch.

Siguen siendo objetivos de diseño que la política sea explícita y determinista,
que la interfaz no decida el veredicto y que el CORE mantenga las credenciales
fuera de los argumentos del agente.
