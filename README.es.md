# Me Runtime

> Beta gratuita 0.0.5 · código fuente disponible con licencia [FSL-1.1-MIT](LICENSE.md) (no es open source según la OSI). Consulta [Licencia](#licencia).

> English: [README.md](./README.md)

Me Runtime es un portero local que se interpone entre un agente de IA y lo que puede hacer, y decide GREEN (ejecutar), YELLOW (preguntar a una persona) o RED (bloquear) con código determinista, no con un LLM.

## Versión 0.0.5

- Aplica el límite de solicitudes configurado y el máximo de solicitudes YELLOW pendientes.
- Limita el tiempo de espera al adquirir el lock del libro de solicitudes. Si falla el guardado del resultado después de ejecutar, la solicitud queda en `UNKNOWN` y no se reintenta automáticamente.
- Compacta solicitudes terminales antiguas y conserva sus registros de idempotencia.
- Incluye un test de carga multiproceso para solicitudes concurrentes.
- Añade una API HTTP local con `meruntime serve` y `meruntime token rotate`.

Me Runtime solo protege las acciones que pasan por él; no controla acciones realizadas mediante otras herramientas o rutas.

## Qué hace hoy

- **Motor de políticas**: un *mandato* (`mandate.json`) con reglas, listas de hosts y acciones denegadas, techos por transacción y lista de IBAN conocidos. Denegar por defecto.
- **Servidor MCP** (`meruntime mcp`) con dos herramientas: `http_request` y `payment_transfer`.
- **API HTTP local** (`meruntime serve`) para esas mismas dos herramientas, con el runtime de Node como único evaluador.
- **Hook de terminal de Claude Code** (`meruntime hook claude`), que envía los comandos a la ruta de autorización `POST /api/authorize` antes de que Claude los ejecute. El hook no ejecuta comandos; consulta [el mandato de ejemplo](./docs/claude-hooks.mandate.example.json).
- **Aprobación humana**: una llamada YELLOW se *bloquea* hasta que ejecutas `meruntime approve <id>`, `meruntime deny <id>` o vence el plazo (5 minutos por defecto). Al aprobar se reevalúan el mandato y el kill switch antes de ejecutar nada.
- **Máquina de estados** con claves de idempotencia: cada solicitud se ejecuta como máximo una vez; un adaptador que no responde termina en `UNKNOWN` y nunca se reintenta.
- **Registro de auditoría** (`meruntime audit`) con cada transición de estado, y un **kill switch** (`meruntime kill on`).

## Qué NO hace todavía

- El núcleo tiene tres adaptadores de ejecución: **GitHub `GET /user`**, el **banco de prueba local** (`fakebank`) y HTTP genérico; este último solo ejecuta peticiones a hosts incluidos en `allowHosts` del mandato. No hay banco real, correo, ejecución de shell ni adaptador de archivos. El hook de terminal de Claude Code autoriza un comando, pero nunca lo ejecuta ni lo aísla.
- `http_request` genérico lo ejecuta el núcleo: no se siguen redirecciones y solo se admiten URL `http(s)`. El cuerpo de la respuesta (primeros 2.000 caracteres) solo se devuelve a la llamada que lo ejecutó y nunca se guarda, así que repetir con la misma `idempotency_key` devuelve el estado pero no el cuerpo. En una solicitud YELLOW aprobada, el cuerpo no llega a nadie, porque lo ejecuta el proceso de quien aprueba.
- Los `GET` no se deduplican salvo que pases una `idempotency_key`; las escrituras se deduplican por su contenido.
- `ceilings.dailySpendEur` limita el gasto acumulado por día en `timezone` (UTC por defecto). Se cuentan pagos ejecutados y operaciones en curso o con resultado incierto; los importes se suman en céntimos y admiten como máximo dos decimales. Al iniciar el primer pago del periodo, el bucket queda anclado a esa zona hasta su medianoche; cambiar `timezone` no reinicia el límite vigente.
- No hay app móvil ni acceso remoto: la interfaz de escritorio (`meruntime ui`) funciona solo en tu ordenador. También puedes aprobar desde la CLI.
- Me Runtime solo protege las acciones que pasan por su servidor MCP, su CLI, su API HTTP local o el hook de terminal de Claude Code configurado. No puede impedir que un agente use otras herramientas, clientes de red, acceso directo a la shell o rutas que tenga; el usuario puede desactivar o cambiar hooks.
- `MERUNTIME_MANDATE` permite seleccionar otro archivo de mandato; `meruntime doctor` muestra una advertencia mientras ese override está activo.
- Sin roles de equipo/RBAC, certificaciones ni SLA.

## Beta

Beta gratuita **0.0.5** para Windows, macOS y Linux. Descargas: https://meruntime.com/es/developers.html. El instalador de Windows aún no está firmado.

## Instalación

Hay dos opciones de instalación:

### Instalador de Windows

El instalador incluye su propio runtime de Node.js; no necesitas instalar Node.js antes. Ejecuta `MeRuntime-Setup-<version>-win-x64.exe` para tu cuenta de Windows. Se instala en `%LOCALAPPDATA%\Programs\MeRuntime`, crea accesos en el menú Inicio y el escritorio, y abre la interfaz local. En el primer arranque, la interfaz te guía para crear una política y conectar un cliente MCP. El instalador no añade la CLI al `PATH`; usa la opción `.tgz` de abajo si necesitas comandos de CLI.

El instalador de esta beta no está firmado digitalmente, por lo que Windows puede mostrar una advertencia antes de ejecutarlo. Comprueba su SHA-256 frente al valor que acompaña a la descarga. Al actualizar con un instalador nuevo se reemplazan los archivos de la aplicación; la política y la auditoría de `%USERPROFILE%\.meruntime` están aparte y no se sobrescriben.

### Paquete `.tgz`

Requiere Node.js 20 o superior y funciona en Windows, macOS y Linux. Instala el archivo que recibiste y configura tu política local y el cliente MCP:

```sh
npm i -g <archivo>.tgz
meruntime init
meruntime doctor
meruntime connect vscode
```

Para esos clientes, usa `meruntime connect claude` o `meruntime connect cursor`. Reinicia el cliente después de conectarlo. En PowerShell, usa `meruntime.cmd` en cada comando (por ejemplo, `meruntime.cmd init` y `meruntime.cmd connect vscode`).

`init` crea una política local, `doctor` comprueba la configuración y `connect` configura el cliente MCP elegido. La política decide qué acciones se ejecutan, requieren aprobación humana o se bloquean. Ejecuta `meruntime ui` para abrir la interfaz local de aprobación.

## Demo del IBAN

La demo usa un correo simulado con una inyección de prompt y un IBAN deliberadamente ficticio (`ES00 EVIL 0000 0000 0000 0666`) para una factura de 35 EUR. Muestra que un IBAN desconocido requiere aprobación, que una solicitud sin respuesta vence y que un pago de 500 EUR se bloquea. Comprueba que no llega ninguna transferencia al banco local de prueba; nunca mueve dinero real.

Inicia el banco de prueba en una terminal y luego ejecuta la demo en otra:

```sh
meruntime fakebank
meruntime demo iban
```

Usa `meruntime demo iban --manual` para denegar tú mismo la solicitud pendiente desde una tercera terminal con `meruntime deny <requestId>`. La demo no lee ni procesa correos reales y no se conecta a bancos reales. Me Runtime solo protege las acciones que pasan por su servidor MCP, su CLI o su API HTTP local; no puede impedir que un agente use otras herramientas que tenga.

## Interfaz de escritorio

```
meruntime ui
```

Abre una ventana (Edge o Chrome en modo aplicación, o tu navegador por defecto) con cinco cosas y nada más: el estado de protección, las solicitudes pendientes, los botones Autorizar y Denegar, el historial de auditoría y el Kill Switch. Habla con el mismo núcleo que la CLI, así que autorizar ahí reevalúa el mandato y el kill switch igual que `meruntime approve`. Con `--no-open` imprime la URL en lugar de abrir la ventana, y `--port N` elige el puerto. En una instalación nueva (sin `mandate.json`) empieza con un asistente de 3 pasos en lugar de la terminal: elegir un perfil, copiar la configuración MCP de tu agente y ver cómo es una tarjeta de aprobación. Nunca sobrescribe archivos existentes.

Al autorizar o denegar una solicitud, ambos botones quedan desactivados en Resumen y Solicitudes mientras se procesa. Un aviso de seis segundos confirma «Solicitud aprobada» en verde o «Solicitud denegada» en rojo, con su id; la tarjeta desaparece y el contador se actualiza. Si falla, el aviso explica el motivo y los botones se reactivan. Si se pierde la conexión o el resultado es incierto, consulta Actividad antes de reintentar.

La sesión sobrevive a F5: el token recibido en `#t=…` se guarda en `sessionStorage`, limitado al origen local y a la sesión de la pestaña, y se retira de la URL. No se usa `localStorage` ni cookies. Si el navegador bloquea ese almacenamiento, la consola avisa de que necesitarás el enlace completo al recargar. Ante un corte muestra «Reconectando…» y reintenta las consultas de lectura cada dos segundos, sin solaparlas y con un plazo máximo de cinco segundos por refresco. Nunca reenvía aprobaciones ni denegaciones automáticamente. Si el acceso caduca o reinicias `meruntime ui`, usa la ventana nueva o su enlace completo; una pestaña antigua no descubre el puerto ni el token del nuevo proceso.

La interfaz es un servidor local en `127.0.0.1` protegido con un token de sesión aleatorio (va en el fragmento de la URL, así que no se envía al servidor ni se registra), una Content-Security-Policy estricta y comprobaciones de Host y Origin. Protege frente a páginas web y atacantes remotos; no protege frente a un proceso que corra como tu usuario y pueda leer tus archivos o ver la lista de procesos, como un agente con shell.

## API HTTP local

`meruntime serve` inicia una API local separada en `127.0.0.1:4319` por defecto. Puedes elegir otro puerto con `meruntime serve --port N`. Solo puede haber una instancia `serve` activa. `POST /api/check` no cambia y acepta únicamente `http_request` y `payment_transfer`; `POST /api/authorize` es una ruta separada, solo para autorizar comandos de terminal, y nunca ejecuta adaptadores ni comandos. `GET /api/requests/<request_id>` devuelve el estado de `/api/check`; `GET /api/authorizations/<request_id>` devuelve el estado de la autorización de terminal. Ambas entradas aplican el kill switch y comparten los límites de frecuencia y solicitudes pendientes.

Todas las peticiones exigen `x-meruntime-token`. En el primer arranque, el servicio crea un token estable en `~/.meruntime/api-token` (o `%USERPROFILE%\.meruntime\api-token`; `MERUNTIME_HOME` permite cambiar la carpeta). En macOS/Linux usa modo `0600`; en Windows, una DACL del usuario actual. Rótalo con `meruntime token rotate`; el nuevo token se activa inmediatamente. Los scripts deben leer el archivo directamente, no incluir el token en el código ni en argumentos de línea de comandos. Un proceso que se ejecute con tu cuenta de Windows aún puede leerlo.

`POST /api/check` exige `idempotency_key` en todas las solicitudes, también para GET. Si se pierde la conexión y el resultado no está claro, reutiliza la misma clave. Una respuesta YELLOW es `202` e incluye `request_id`; consulta `GET /api/requests/<request_id>` mediante polling. Las decisiones RED se devuelven como decisiones, no como errores de transporte. Una ejecución `FAILED` o `UNKNOWN` se informa como `UNKNOWN`, nunca como GREEN. Los errores de autenticación y de formato son respuestas HTTP 4xx sin veredicto y deben tratarse como fallos.

`POST /api/authorize` acepta `{ "agent_id", "tool_name", "command", "cwd", "idempotency_key" }` para llamadas `Bash` o `PowerShell` de Claude Code. GREEN devuelve `AUTHORIZED`; YELLOW devuelve `202` y el hook mantiene la llamada bloqueada mientras consulta cada segundo hasta que se apruebe o venza `approvalTimeoutMs`; RED y la expiración deniegan. Los errores HTTP 4xx no incluyen veredicto y deben tratarse como fallos. La aprobación humana reevalúa el mandato vigente y solo autoriza el comando descrito; el flujo de aprobación de CLI/UI nunca lo ejecuta. Las autorizaciones tienen un almacén separado con lock, comparten los límites de frecuencia y pendientes con `/api/check`, y conservan tombstones terminales de idempotencia durante 30 días.

Me Runtime solo protege las acciones que pasan por su servidor MCP, su CLI, su API HTTP local o el hook configurado. No intercepta otras herramientas, llamadas de red directas ni acciones que ocurran fuera de esas rutas.

## Hook de terminal de Claude Code

La primera integración cubre únicamente `PreToolUse` de Claude Code para herramientas de terminal. Requiere `meruntime serve`, el token local de la API y Claude Code `v2.1.295` o superior para `onFailure: "block"`. Configura un timeout del hook mayor que `approvalTimeoutMs`; estos ejemplos usan 330 segundos para el plazo predeterminado de 5 minutos. En Windows se ejecuta `meruntime.cmd` mediante `cmd.exe` para que funcione con el shim de npm.

`.claude/settings.json` en POSIX:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "meruntime",
            "args": ["hook", "claude"],
            "timeout": 330,
            "onFailure": "block"
          }
        ]
      }
    ]
  }
}
```

`.claude/settings.json` en Windows:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "command": "cmd.exe",
            "args": ["/d", "/s", "/c", "meruntime.cmd hook claude"],
            "timeout": 330,
            "onFailure": "block"
          }
        ]
      }
    ]
  }
}
```

Inicia `meruntime serve` antes de usar el hook. El hook reserva stdout para el JSON que consume Claude y envía los diagnósticos a stderr.

El mandato de ejemplo está en [docs/claude-hooks.mandate.example.json](./docs/claude-hooks.mandate.example.json). Sin un mandato válido, la evaluación es RED por denegación predeterminada. El clasificador es conservador, pero incompleto: los comandos desconocidos son `exec`; los comandos compuestos heredan el segmento más peligroso; las redirecciones son `write`; la sustitución de comandos, backticks, evaluación de expresiones y ejecución de scripts nunca son `read`. Permitir `exec` permite cualquier comando clasificado como `exec`, no un comando concreto.

Cursor, Copilot, herramientas de archivos y herramientas fuera del hook de terminal configurado en Claude Code no están cubiertos. En Copilot, un timeout impuesto por el host del hook previo a la herramienta puede dejar continuar aunque el comando esté configurado para denegar errores; una integración futura no puede prometer fail-closed ante ese timeout del host. El usuario puede desactivar o editar hooks, y el clasificador no puede comprender todas las construcciones de una shell. Me Runtime registra la decisión de autorización; no ejecuta ni aísla el comando.

## Editar tu mandato

`meruntime init` copia un mandato inicial seguro a `~/.meruntime/mandate.json`. Edítalo y ejecuta `meruntime doctor` para validarlo. JSON no admite comentarios, así que la versión anotada de abajo es solo para leer:

```jsonc
{
  "version": "1",
  "userId": "me",
  "default": "deny",              // lo que ninguna regla permita se bloquea
  "allowHosts": ["api.github.com"], // hosts a los que puede llegar un http_request GREEN (una persona aún puede aprobar otros)
  "denyActions": ["delete", "exec", "grant"], // siempre RED
  "ceilings": { "perTxEur": 50 },   // un pago por encima de esto es RED
  "rules": [
    // los GET a GitHub se ejecutan sin preguntar
    { "effect": "allow", "action": "read", "tool": "http.request", "host": "api.github.com" },
    // se permiten pagos, pero mira knownIbans
    { "effect": "allow", "action": "pay", "tool": "payment.transfer" }
  ],
  "knownIbans": ["ES00 DEMO 0000 0000 0000 0001"], // otros IBAN son YELLOW (aprobación humana)
  "approvalTimeoutMs": 300000,    // cuánto espera una llamada YELLOW (5 min)
  "rateLimitPerSecond": 20,       // nuevas solicitudes por segundo; el exceso es RED
  "maxPendingRequests": 50,       // solicitudes YELLOW simultáneas; el exceso es RED
  "killSwitch": false             // usa `meruntime kill on` en vez de editarlo
}
```

Los efectos de regla son `allow` (GREEN), `confirm` (YELLOW) y `deny` (RED). Gana la primera regla coincidente de cada efecto; `deny` se comprueba antes que `confirm`, y `confirm` antes que `allow`.

## Seguridad: dónde viven los secretos

- Todo vive en `~/.meruntime/` (`%USERPROFILE%\.meruntime` en Windows; usa `MERUNTIME_HOME` para moverlo): `mandate.json`, `secrets.json`, `kill.json`, `api-token`, además del libro de solicitudes y el log de auditoría.
- `secrets.json` guarda los tokens de API (`githubToken`, `protectedToken`, `fakeBankToken`) y la clave HMAC que firma las aprobaciones pendientes. Los archivos se escriben de forma atómica; en Linux y macOS tienen modo `600` y la carpeta `700`. En Windows la protección es la ACL de tu perfil de usuario.
- **La interfaz MCP no devuelve credenciales.** El proceso del núcleo lee los tokens y los añade a la petición saliente. Sin embargo, un agente con terminal bajo la misma cuenta del sistema operativo puede leer `secrets.json`, incluida la clave HMAC.
- **Limitación conocida:** un agente con terminal bajo la misma cuenta puede ejecutar `meruntime approve`, cambiar `mandate.json` o leer la clave HMAC. No concedas terminal al agente; para una separación más fuerte, ejecuta el agente y Me Runtime bajo cuentas distintas. El broker de aprobación con otra identidad aún no forma parte de esta versión.
- Límites: cualquier proceso que corra como tu usuario puede leer estos archivos, y un agente que además tenga shell o acceso a archivos también podría leerlos. Me Runtime protege las herramientas que pasan por él, no toda la máquina.
- Mientras un `http_request` YELLOW espera aprobación, su URL y cuerpo originales (que pueden llevar credenciales puestas por el agente) se guardan en `requests.json`, firmados con la clave HMAC, y se borran en cuanto termina la solicitud. Todo lo demás que se guarda o registra va redactado.

## Licencia

Me Runtime es **código fuente disponible** (source-available) con la [Functional Source License, Version 1.1, MIT Future License (FSL-1.1-MIT)](LICENSE.md).

- ✅ Úsalo gratis, también en tu empresa; estúdialo, modifícalo y propón mejoras.
- ❌ No lo uses para ofrecer un producto o servicio comercial que compita con Me Runtime.
- ⏳ Cada versión pasa a licencia **MIT** dos años después de publicarse.

No es una licencia open source aprobada por la OSI. La licencia no da derechos sobre el nombre ni el logo "Me Runtime". Vulnerabilidades: [SECURITY.md](SECURITY.md). Contribuciones: [CONTRIBUTING.md](CONTRIBUTING.md).
