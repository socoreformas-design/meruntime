// Página única de la interfaz. Sin recursos externos; todo dato dinámico entra por textContent.

const STYLE = `
:root { color-scheme: dark; --bg:#070a09; --sidebar:#0b100d; --surface:#0f1412; --surface-2:#151c18; --surface-low:#090d0b; --line:#243029; --text:#eaf1ec; --muted:#8a998e; --ok:#3dba6e; --warn:#e2b93b; --bad:#e25b4c; --brand-gradient:linear-gradient(90deg,#3dba6e,#e2b93b,#e25b4c,#e2b93b,#3dba6e); }
* { box-sizing: border-box; }
body { margin:0; min-width:0; font:15px/1.5 "Inter", system-ui, sans-serif; background:var(--bg); color:var(--text); }
button { font:inherit; border-radius:6px; border:1px solid var(--line); background:var(--surface-2); color:var(--text); padding:9px 13px; cursor:pointer; }
button:hover:not(:disabled) { border-color:var(--ok); } button:disabled { opacity:.5; cursor:default; }
button.primary { background:var(--ok); border-color:var(--ok); color:#07110a; font-weight:700; }
button.danger { background:#3a1714; border-color:var(--bad); color:#ffe9e6; font-weight:700; }
.app-shell { min-height:100vh; display:grid; grid-template-rows:60px 1fr; }
.topbar { display:flex; align-items:center; gap:16px; padding:0 22px; background:var(--sidebar); border-bottom:1px solid var(--line); }
.brand { display:flex; align-items:center; gap:10px; font-size:17px; font-weight:700; white-space:nowrap; }
.brand-mark { width:38px; height:38px; flex:none; }
.brand-mark .lamp-green { fill:var(--ok); } .brand-mark .lamp-yellow { fill:var(--warn); } .brand-mark .lamp-red { fill:var(--bad); }
.brand strong { font:600 21px/1 "Space Grotesk", "Inter", system-ui, sans-serif; color:transparent; background:var(--brand-gradient); background-clip:text; -webkit-background-clip:text; }
.beta { padding:4px 8px; color:var(--warn); background:#211f12; border:1px solid #3d3820; border-radius:6px; font-size:11px; text-transform:uppercase; }
.local-address { color:var(--muted); font:12px ui-monospace, Consolas, monospace; }
.top-version { margin-left:auto; color:var(--muted); font:12px ui-monospace, Consolas, monospace; }
.body-grid { display:grid; grid-template-columns:228px minmax(0,1fr); min-height:calc(100vh - 60px); }
.sidebar { display:flex; flex-direction:column; gap:20px; padding:24px 14px; background:var(--sidebar); border-right:1px solid var(--line); }
.side-nav { display:grid; gap:5px; }
.nav-btn { display:flex; align-items:center; justify-content:space-between; width:100%; text-align:left; background:transparent; border-color:transparent; padding:11px 12px; color:var(--muted); }
.nav-btn:hover:not(:disabled) { background:var(--surface); border-color:transparent; }
.nav-btn.active { background:#163522; color:#effff7; border-color:#27583a; }
.nav-count { min-width:22px; padding:0 5px; text-align:center; color:var(--text); background:var(--surface-2); font-size:12px; }
.side-note { margin-top:auto; padding:12px; border-top:1px solid var(--line); color:var(--muted); font-size:13px; }
.content { min-width:0; width:100%; max-width:1600px; padding:30px clamp(20px,4vw,56px) 48px; }
.view { display:none; } .view.active { display:block; }
.page-head { display:flex; align-items:flex-end; justify-content:space-between; gap:18px; margin-bottom:22px; }
h1 { font:600 28px/1.2 "Space Grotesk", "Inter", system-ui, sans-serif; margin:0; }
h2 { font-size:18px; margin:0; }
.page-sub { margin:6px 0 0; color:var(--muted); }
.eyebrow { color:var(--ok); font-size:12px; text-transform:uppercase; }
.status-band { display:flex; align-items:center; gap:14px; padding:17px 18px; margin-bottom:20px; background:var(--surface); border:1px solid var(--line); border-left:4px solid var(--ok); border-radius:8px; }
.status-band.warn { border-color:var(--warn); } .status-band.bad { border-color:var(--bad); }
.status-dot { width:11px; height:11px; flex:none; border-radius:50%; background:var(--ok); }
.status-band.warn .status-dot { background:var(--warn); } .status-band.bad .status-dot { background:var(--bad); }
.status-copy { min-width:0; flex:1; } .status-title { font-size:17px; font-weight:700; } .status-sub { color:var(--muted); font-size:13px; }
.metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:14px; margin-bottom:30px; }
.metric { min-width:0; padding:18px; background:var(--surface); border:1px solid var(--line); border-radius:8px; }
.metric.green { border-left:3px solid var(--ok); } .metric.yellow { border-left:3px solid var(--warn); } .metric.red { border-left:3px solid var(--bad); }
.metric-label { color:var(--muted); font-size:12px; text-transform:uppercase; }
.metric-value { display:flex; align-items:baseline; gap:8px; margin-top:10px; font-size:36px; line-height:1.1; font-weight:700; }
.metric.green .metric-value { color:var(--ok); } .metric.yellow .metric-value { color:var(--warn); } .metric.red .metric-value { color:var(--bad); }
.metric-unit { color:var(--muted); font-size:13px; font-weight:500; }
.overview-grid { display:grid; grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr); gap:30px; }
.section { min-width:0; padding:24px 0; border-top:1px solid var(--line); }
.section-head { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:18px; }
.section-head h2 { font-size:17px; }
.text-link { color:var(--ok); background:none; border:0; padding:4px; }
.pending-card { padding:18px 16px; border:1px solid var(--line); border-left:3px solid var(--warn); border-radius:8px; margin-bottom:12px; background:var(--surface); }
.pending-card:first-child { border-top:0; }
.pending-title { font-size:17px; font-weight:650; overflow-wrap:anywhere; }
.pending-meta { display:flex; flex-wrap:wrap; gap:8px 18px; margin:8px 0; color:var(--muted); font-size:13px; }
.verdict { display:inline-block; padding:2px 7px; font-size:12px; font-weight:700; }
.verdict.GREEN { color:var(--ok); background:#13291b; } .verdict.YELLOW { color:var(--warn); background:#2b2714; } .verdict.RED { color:var(--bad); background:#301714; }
.card { padding:18px; margin-bottom:14px; background:var(--surface); border:1px solid var(--line); border-radius:8px; }
.card.yellow { border-left:3px solid var(--warn); }
.card .what { font-size:18px; font-weight:600; margin-bottom:8px; overflow-wrap:anywhere; }
.card dl { display:grid; grid-template-columns:minmax(115px,auto) minmax(0,1fr); gap:5px 12px; margin:0 0 14px; font-size:14px; }
.card dt { color:var(--muted); } .card dd { margin:0; overflow-wrap:anywhere; }
.actions { display:flex; flex-wrap:wrap; gap:10px; }
.empty { color:var(--muted); padding:18px 2px; }
.table-wrap { overflow-x:auto; }
table { width:100%; border-collapse:collapse; font-size:13px; }
th, td { text-align:left; padding:10px 9px; border-bottom:1px solid var(--line); vertical-align:top; overflow-wrap:anywhere; }
th { color:var(--muted); font-weight:500; }
#audit-preview th:nth-child(5), #audit-preview td:nth-child(5), #audit-preview th:nth-child(6), #audit-preview td:nth-child(6) { display:none; }
#audit-preview th:first-child, #audit-preview td:first-child { width:92px; }
.mono { font-family:ui-monospace, "Cascadia Mono", Consolas, monospace; font-size:12px; }
.security-grid { display:grid; grid-template-columns:minmax(0,1.1fr) minmax(280px,.9fr); gap:30px; }
.security-rows { display:grid; gap:0; }
.security-row { display:grid; grid-template-columns:minmax(150px,.6fr) minmax(0,1fr); gap:12px; padding:14px 0; border-top:1px solid var(--line); }
.security-row dt { color:var(--muted); } .security-row dd { margin:0; overflow-wrap:anywhere; }
.check-list { display:grid; gap:7px; margin-top:14px; }
.check-item { display:flex; justify-content:space-between; gap:12px; color:var(--muted); }
.check-item strong { color:var(--text); font-weight:600; }
details { margin-top:10px; color:var(--muted); font-size:13px; } details li { margin:2px 0; }
#toast { position:fixed; left:50%; bottom:20px; z-index:5; transform:translateX(-50%); background:var(--surface-2); border:1px solid var(--line); border-radius:6px; padding:14px 20px; max-width:90vw; overflow-wrap:anywhere; }
#toast.success { color:var(--ok); border-color:var(--ok); }
#toast.danger { color:var(--bad); border-color:var(--bad); }
.app-footer { display:flex; justify-content:space-between; gap:12px; padding:18px 0; margin-top:24px; border-top:1px solid var(--line); color:var(--muted); font-size:12px; }
.hidden { display:none !important; }
.wtitle { font-size:22px; font-weight:600; margin:4px 0 6px; }
.wsub, .step { color:var(--muted); font-size:13px; margin-bottom:12px; }
.option { display:block; border:1px solid var(--line); border-radius:8px; padding:14px; margin-bottom:12px; cursor:pointer; background:var(--surface); }
.option.sel { border-color:var(--ok); }
.option .ot { font-weight:600; } .option .ot input { margin-right:10px; }
.option .od { color:var(--muted); font-size:13px; margin-left:26px; }
.field { margin:14px 0; } .field label { display:block; color:var(--muted); font-size:13px; margin-bottom:4px; }
input[type=number], textarea { width:100%; background:var(--surface-low); color:var(--text); border:1px solid var(--line); border-radius:4px; padding:8px; font:inherit; }
textarea { min-height:72px; font-family:ui-monospace, Consolas, monospace; font-size:13px; }
pre { background:var(--surface-low); border:1px solid var(--line); border-radius:4px; padding:10px; overflow:auto; font-size:12px; margin:0 0 8px; }
.err { color:var(--bad); min-height:20px; margin:8px 0; }
@media (max-width:900px) { .overview-grid,.security-grid { grid-template-columns:1fr; } .metrics { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media (max-width:640px) { .app-shell { display:block; } .topbar { min-height:58px; padding:10px 14px; gap:8px; flex-wrap:wrap; } .local-address { display:none; } .top-version { font-size:11px; } .body-grid { display:block; min-height:0; } .sidebar { padding:8px; border-right:0; border-bottom:1px solid var(--line); } .side-nav { display:flex; overflow-x:auto; } .nav-btn { width:auto; flex:none; gap:10px; white-space:nowrap; } .side-note { display:none; } .content { padding:22px 16px 36px; } .page-head { align-items:flex-start; flex-direction:column; } h1 { font-size:24px; } .metrics { gap:8px; } .metric { padding:12px; } .metric-value { font-size:26px; } .security-row { grid-template-columns:1fr; gap:3px; } }
.body-grid.offline-mode { grid-template-columns:minmax(0,1fr); }
.body-grid.offline-mode .sidebar { display:none; }
.body-grid.offline-mode .content { max-width:920px; margin-inline:auto; }
.body-grid.offline-mode #banner, .body-grid.offline-mode .view, .body-grid.offline-mode #wizard { display:none; }
`;

const SCRIPT = `
const STRINGS = {
  en: { title:"Me Runtime", protected:"Protected", blocked:"Kill Switch ON: everything is blocked", attention:"Needs attention", agentId:"Agent ID", terminalCommand:"Terminal command", workingDirectory:"Working directory",
    subProtected:"Policy and secrets are in place. Anything not allowed is blocked.", subBlocked:"No action will run until you turn it off.",
    subAttention:"Some checks failed; requests are denied until fixed.", details:"Details", pending:"Pending requests", none:"Nothing is waiting for you.",
    authorize:"Authorize", deny:"Deny", killOn:"Activate Kill Switch", killOff:"Turn off Kill Switch", confirmOff:"Turn the Kill Switch off? Requests will be evaluated again.",
    requestApproved:"Request approved", requestDenied:"Request denied", decisionError:"Could not resolve the request",
    decisionNetwork:"No connection to Me Runtime. Check that it is running and check the request status before trying again.",
    decisionExpired:"The request has expired. Ask the agent to send a new one.", decisionResolved:"The request has already been resolved. Check Activity.",
    decisionMissing:"The request no longer exists. Refresh the list.", decisionAccess:"Access has expired. Open the console again with meruntime ui.",
    decisionPolicy:"The current policy or Kill Switch blocked approval.", decisionFailed:"The action failed. Check Activity before trying again.",
    decisionInvalid:"The server returned an unexpected response. Check Activity before trying again.",
    decisionStorage:"The decision could not be saved. Check Activity before trying again.", decisionUnexpected:"An unexpected error occurred. Check Activity for details.",
    audit:"Audit history", noEvents:"No events yet.", time:"Time", event:"Event", request:"Request", change:"Change", actor:"Actor", reason:"Reason",
    agent:"Agent", rule:"Technical rule", why:"Why you are asked", requested:"Requested", expires:"Expires in", concept:"Concept", expired:"expired", lastActivity:"Last activity", pendingN:"pending",
    result:"Result", mandate:"Mandate", unknownOutcome:"The action may have executed; do not retry automatically.",
    w_welcome:"Welcome to Me Runtime", w_intro:"Choose what your agent is allowed to do. You can change this later.",
    w_p_read_only_t:"Read only", w_p_read_only_d:"The agent can look things up on the sites you allow. Everything else is blocked.",
    w_p_payments_ask_t:"Payments, I approve each one", w_p_payments_ask_d:"Reading is allowed. Every payment asks for your approval, and payments above your limit are blocked.",
    w_p_payments_known_t:"Payments to my usual suppliers", w_p_payments_known_d:"Payments to your trusted IBANs go through up to your limit. A new IBAN asks you. Above the limit is blocked.",
    w_p_blocked_t:"Block everything", w_p_blocked_d:"Nothing is allowed, even if an agent is connected.",
    w_limit:"Limit per payment (EUR)", w_sites:"Sites the agent may read, one per line (empty = GitHub)", w_ibans:"Trusted IBANs, one per line",
    w_continue:"Continue", w_step:"Step", w_of:"of", w_error:"Could not save:",
    w_connect:"Connect your agent", w_connect_d:"Pick the app your agent runs in. Me Runtime adds itself to that app's settings, after making a backup of the file. Nothing else in the file is changed.",
    w_c_claude:"Claude Desktop / Cursor", w_c_vscode:"VS Code", w_c_local:"Without publishing (local path): replace the meruntime entry with this", w_copy:"Copy", w_copied:"Copied",
    w_c_win:"On Windows, if the client cannot launch meruntime, use command cmd with args /c meruntime mcp.",
    w_ready:"You are protected", w_ready_d:"When your agent asks for something that needs your approval, a card like this appears here, and the window title shows how many are waiting.",
    w_example:"Example, not a real request", w_ex_headline:"my-agent wants to pay €35.00 to ES00 DEMO 0000 0000 0000 0999", w_ex_why:"It is an IBAN that is not in your trusted list.", w_open:"Open Me Runtime",
    w_connected:"Connected", w_connect_btn:"Connect", w_not_detected:"Not detected on this computer", w_will_edit:"Will edit", w_backup:"A backup of the file is made first.",
    w_restart:"Restart the app to finish.", w_manual:"Set it up by hand instead" },
  es: { title:"Me Runtime", protected:"Protegido", navSummary:"Resumen", navPending:"Solicitudes", navActivity:"Actividad", navSecurity:"Seguridad", agentId:"Agent ID", terminalCommand:"Comando de terminal", workingDirectory:"Directorio de trabajo",
    summaryTitle:"Resumen del runtime", summarySub:"Estado local y decisiones registradas por Me Runtime.",
    events:"Eventos de auditoría", allowed:"Permitido", review:"Requiere aprobación", blockedCount:"Bloqueado", audited:"entradas",
    latestActivity:"Actividad reciente", viewRequests:"Ver solicitudes", viewActivity:"Ver actividad", noPending:"No hay solicitudes pendientes.",
    eventType:"Evento", agentAction:"Agente / acción", verdictState:"Veredicto / estado", localSecurity:"Protección local",
    killTitle:"Kill Switch", killActive:"Activado: todas las solicitudes se bloquean.", killInactive:"Desactivado.",
    defaultPolicy:"Política predeterminada", defaultDeny:"Denegar lo no permitido", dataDirectory:"Directorio de datos",
    runtimeVersion:"Versión instalada", localFiles:"Archivos locales", configChecks:"Comprobaciones de configuración",
    checkOk:"Correctas", checkWarn:"Avisos", checkFail:"Fallidas", checkOther:"Sin estado",
    blocked:"Kill Switch ACTIVADO: todo está bloqueado", attention:"Requiere atención",
    subProtected:"La política y los secretos están en orden. Lo que no está permitido se bloquea.", subBlocked:"Nada se ejecutará hasta que lo desactives.",
    subAttention:"Alguna comprobación falla; se deniega todo hasta que se arregle.", details:"Detalles", pending:"Solicitudes pendientes", none:"No hay solicitudes pendientes",
    authorize:"Autorizar", deny:"Denegar", killOn:"Activar Kill Switch", killOff:"Desactivar Kill Switch", confirmOff:"¿Desactivar el Kill Switch? Las solicitudes volverán a evaluarse.",
    requestApproved:"Solicitud aprobada", requestDenied:"Solicitud denegada", decisionError:"No se pudo resolver la solicitud",
    decisionNetwork:"Sin conexión con Me Runtime. Comprueba que sigue abierto y revisa el estado de la solicitud antes de reintentar.",
    decisionExpired:"La solicitud ha caducado. Pide al agente que envíe una nueva.", decisionResolved:"La solicitud ya se había resuelto. Consulta Actividad.",
    decisionMissing:"La solicitud ya no existe. Actualiza la lista.", decisionAccess:"El acceso ha caducado. Abre de nuevo la consola con meruntime ui.",
    decisionPolicy:"El mandato actual o el Kill Switch han bloqueado la aprobación.", decisionFailed:"La acción ha fallado. Consulta Actividad antes de reintentar.",
    decisionInvalid:"El servidor ha devuelto una respuesta inesperada. Consulta Actividad antes de reintentar.",
    decisionStorage:"No se pudo guardar la decisión. Consulta Actividad antes de reintentar.", decisionUnexpected:"Ha ocurrido un error inesperado. Consulta Actividad para ver los detalles.",
    audit:"Historial de auditoría", noEvents:"Aún no hay actividad. Prueba la demo del IBAN", time:"Hora", event:"Evento", request:"Solicitud", change:"Cambio", actor:"Actor", reason:"Motivo",
    agent:"Agente", rule:"Regla técnica", why:"Por qué te lo preguntamos", requested:"Solicitada", expires:"Caduca en", concept:"Concepto", expired:"caducada", lastActivity:"Última actividad", pendingN:"pendientes",
    result:"Resultado", mandate:"Mandato", unknownOutcome:"La acción pudo ejecutarse, pero no se guardó el resultado. No la repitas automáticamente.",
    w_welcome:"Te damos la bienvenida a Me Runtime", w_intro:"Elige qué puede hacer tu agente. Podrás cambiarlo después.",
    w_p_read_only_t:"Solo lectura", w_p_read_only_d:"El agente puede consultar los sitios que permitas. Todo lo demás se bloquea.",
    w_p_payments_ask_t:"Pagos, apruebo cada uno", w_p_payments_ask_d:"Se permite leer. Todo pago te pide aprobación, y los pagos por encima de tu límite se bloquean.",
    w_p_payments_known_t:"Pagos a mis proveedores habituales", w_p_payments_known_d:"Los pagos a tus IBAN de confianza pasan hasta tu límite. Un IBAN nuevo te pregunta. Por encima del límite se bloquea.",
    w_p_blocked_t:"Bloquear todo", w_p_blocked_d:"No se permite nada, aunque haya un agente conectado.",
    w_limit:"Límite por pago (EUR)", w_sites:"Sitios que el agente puede consultar, uno por línea (vacío = GitHub)", w_ibans:"IBAN de confianza, uno por línea",
    w_continue:"Continuar", w_step:"Paso", w_of:"de", w_error:"No se pudo guardar:",
    w_connect:"Conecta tu agente", w_connect_d:"Elige la aplicación donde corre tu agente. Me Runtime se añade a su configuración, tras hacer una copia de seguridad del archivo. No se cambia nada más del archivo.",
    w_c_claude:"Claude Desktop / Cursor", w_c_vscode:"VS Code", w_c_local:"Sin publicar (ruta local): sustituye la entrada meruntime por esta", w_copy:"Copiar", w_copied:"Copiado",
    w_c_win:"En Windows, si el cliente no puede lanzar meruntime, usa el comando cmd con los argumentos /c meruntime mcp.",
    w_ready:"Ya estás protegido", w_ready_d:"Cuando tu agente pida algo que necesite tu aprobación, aparecerá aquí una tarjeta como esta, y el título de la ventana mostrará cuántas esperan.",
    w_example:"Ejemplo, no es una solicitud real", w_ex_headline:"my-agent quiere pagar 35,00 € a ES00 DEMO 0000 0000 0000 0999", w_ex_why:"Es un IBAN que no está en tu lista de confianza.", w_open:"Abrir Me Runtime",
    w_connected:"Conectado", w_connect_btn:"Conectar", w_not_detected:"No se ha detectado en este ordenador", w_will_edit:"Se editará", w_backup:"Antes se hace una copia de seguridad del archivo.",
    w_restart:"Reinicia la aplicación para terminar.", w_manual:"Configurarlo a mano" }
};
const LANG = "es";
const T = STRINGS[LANG];
document.documentElement.lang = LANG;

const SESSION_KEY = "meruntime.ui.token";
const fragmentToken = new URLSearchParams(location.hash.slice(1)).get("t");
let token = fragmentToken || "";
let storageUnavailable = false;
let sessionExpired = false;
try {
  if (token) sessionStorage.setItem(SESSION_KEY, token);
  else token = sessionStorage.getItem(SESSION_KEY) || "";
} catch {
  storageUnavailable = true;
}
history.replaceState(null, "", location.pathname);

function expireSession() {
  sessionExpired = true;
  token = "";
  try { sessionStorage.removeItem(SESSION_KEY); } catch { storageUnavailable = true; }
}

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (value !== undefined) node.setAttribute(key, value);
  }
  for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}

async function api(path, body, signal) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    mode: "same-origin", redirect: "error", signal,
    headers: { "x-meruntime-token": token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => { throw Object.assign(new Error(T.decisionNetwork), { code: "NETWORK_ERROR" }); });
  if (response.status === 401) {
    expireSession();
    throw Object.assign(new Error(T.decisionAccess), { code: "UNAUTHORIZED", status: 401 });
  }
  const data = await response.json().catch(() => { throw Object.assign(new Error(T.decisionInvalid), { code: "INVALID_RESPONSE" }); });
  if (!data || typeof data !== "object") throw Object.assign(new Error(T.decisionInvalid), { code: "INVALID_RESPONSE" });
  if (!response.ok) throw Object.assign(new Error(data.message || response.statusText), { code: data.code, status: response.status });
  return data;
}

let toastTimer;
function toast(message, tone = "") {
  const box = document.getElementById("toast");
  box.textContent = message;
  box.className = tone;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.classList.add("hidden"); }, 6000);
}

function renderOffline(kind = "reconnecting") {
  const box = document.getElementById("offline");
  if (kind === "session") {
    box.replaceChildren(
      document.createTextNode("No se puede recuperar esta sesión. Ejecuta "),
      el("code", {}, "meruntime ui"),
      document.createTextNode(" y usa la ventana nueva o su enlace completo con acceso."));
  } else if (kind === "unavailable") {
    box.replaceChildren(
      document.createTextNode("Reconectando… El servidor local no responde. Comprueba que "),
      el("code", {}, "meruntime ui"),
      document.createTextNode(" sigue abierto. Si lo cerraste, ejecútalo de nuevo y usa la ventana nueva. Seguiremos reintentando cada 2 segundos."));
  } else {
    box.textContent = kind === "server"
      ? "Reconectando… No se pudieron actualizar los datos del servidor local. Reintentaremos cada 2 segundos."
      : "Reconectando… Se ha perdido la conexión con el servidor local. Reintentaremos cada 2 segundos.";
  }
}

const fmtTime = (iso) => new Date(iso).toLocaleString("es-ES");
function countdown(iso) {
  const left = Math.floor((Date.parse(iso) - Date.now()) / 1000);
  if (left <= 0) return T.expired;
  return Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0");
}
function describe(p) {
  return p.headline ? p.headline[LANG] : p.method + " " + p.url;
}

let state = { status: null, summary: null, pending: [], audit: [] };
const busy = new Set();
let pendingRevision = 0;

function decisionError(error) {
  return ({
    NETWORK_ERROR: T.decisionNetwork, APPROVAL_TIMEOUT: T.decisionExpired, ALREADY_DECIDED: T.decisionResolved,
    REQUEST_NOT_FOUND: T.decisionMissing, UNAUTHORIZED: T.decisionAccess, POLICY_DENY: T.decisionPolicy,
    EXECUTION_UNKNOWN: T.unknownOutcome, ADAPTER_ERROR: T.decisionFailed, EXECUTION_TIMEOUT: T.decisionFailed,
    STORAGE_ERROR: T.decisionStorage, STORAGE_BUSY: T.decisionStorage, INVALID_RESPONSE: T.decisionInvalid,
  })[error.code] || (error.status === 401 || error.status === 403 ? T.decisionAccess : T.decisionUnexpected);
}

function syncPendingButtons() {
  for (const button of document.querySelectorAll("[data-request-id]")) {
    button.disabled = busy.has(button.getAttribute("data-request-id"));
  }
}

function renderStatus() {
  const s = state.status;
  const banner = document.getElementById("banner");
  banner.replaceChildren();
  if (!s) { banner.classList.add("hidden"); return; }
  const cls = s.state === "protected" ? "ok" : s.state === "blocked" ? "bad" : "warn";
  banner.className = "status-band " + cls;
  const title = s.state === "protected" ? T.protected : s.state === "blocked" ? T.blocked : T.attention;
  const sub = s.state === "protected" ? T.subProtected : s.state === "blocked" ? T.subBlocked : T.subAttention;
  const last = s.lastEvent ? " · " + T.lastActivity + ": " + fmtTime(s.lastEvent) : "";
  document.getElementById("top-version").textContent = "v" + s.version;
  document.getElementById("footer-version").textContent = "Versión " + s.version;
  document.getElementById("local-address").textContent = location.origin;
  document.getElementById("audit-file-label").textContent = s.files.audit;
  banner.append(el("div", { class: "status-dot" }), el("div", { class: "status-copy" }, el("div", { class: "status-title" }, title), el("div", { class: "status-sub" }, sub + last)));
}

function renderPendingInto(box, requests) {
  box.replaceChildren();
  if (requests.length === 0) { box.append(el("div", { class: "empty" }, T.none)); return; }
  for (const p of requests) {
    const rows = [[T.why, p.why ? p.why[LANG] : "-"], [T.agent, p.agent], [T.rule, p.rule || "-"], [T.requested, fmtTime(p.createdAt)]];
    if (p.command !== undefined) {
      rows.push([T.agentId, p.agentId], [T.terminalCommand, JSON.stringify(p.command)], [T.workingDirectory, p.cwd]);
    }
    if (p.params && p.params.concept) rows.push([T.concept, p.params.concept]);
    const timer = el("dd", { "data-expires": p.expiresAt }, countdown(p.expiresAt));
    const approve = el("button", { class: "primary", "data-request-id": p.requestId }, T.authorize);
    const deny = el("button", { "data-request-id": p.requestId }, T.deny);
    const act = async (kind) => {
      if (busy.has(p.requestId)) return;
      busy.add(p.requestId);
      pendingRevision++;
      syncPendingButtons();
      try {
        const view = await api("/api/" + kind, { requestId: p.requestId });
        const succeeded = kind === "deny" ? view.status === "DENIED" : ["AUTHORIZED", "EXECUTED"].includes(view.status);
        if (!succeeded) {
          const code = view.status === "UNKNOWN" ? "EXECUTION_UNKNOWN" : view.status === "DENIED" ? "POLICY_DENY"
            : view.status === "EXPIRED" ? "APPROVAL_TIMEOUT" : view.status === "FAILED" ? "ADAPTER_ERROR" : "INVALID_RESPONSE";
          throw Object.assign(new Error(), { code });
        }
        toast((kind === "approve" ? T.requestApproved : T.requestDenied) + " · " + p.requestId, kind === "approve" ? "success" : "danger");
        state.pending = state.pending.filter((request) => request.requestId !== p.requestId);
      } catch (e) {
        toast(T.decisionError + " · " + p.requestId + ": " + decisionError(e), "danger");
      } finally {
        busy.delete(p.requestId);
        pendingRevision++;
        syncPendingButtons();
        renderPending();
      }
    };
    approve.addEventListener("click", () => act("approve"));
    deny.addEventListener("click", () => act("deny"));
    const dl = el("dl", {});
    for (const [k, v] of rows) dl.append(el("dt", {}, k), el("dd", {}, v));
    dl.append(el("dt", {}, T.expires), timer);
    box.append(el("div", { class: "card yellow" }, el("div", { class: "what" }, describe(p)), dl, el("div", { class: "actions" }, approve, deny)));
  }
}

function renderPending() {
  document.title = (state.pending.length ? "(" + state.pending.length + ") " : "") + T.title;
  document.getElementById("pending-count").textContent = String(state.pending.length);
  renderPendingInto(document.getElementById("pending"), state.pending);
  renderPendingInto(document.getElementById("pending-preview"), state.pending.slice(0, 1));
  syncPendingButtons();
}

function auditEventLabel(event) {
  return ({ request:"Solicitud evaluada", transition:"Cambio de estado", approve:"Aprobación", deny:"Denegación", invalidate:"Invalidación", expire:"Caducidad", "kill-on":"Kill Switch activado", "kill-off":"Kill Switch desactivado", execute:"Ejecución" })[event] || "Evento";
}

function statusLabel(status) {
  return ({ RECEIVED:"Recibida", EVALUATING:"Evaluando", PENDING:"Pendiente", APPROVED:"Aprobada", DENIED:"Denegada", EXPIRED:"Caducada", EXECUTING:"En ejecución", EXECUTED:"Ejecutada", FAILED:"Fallida", UNKNOWN:"Desconocida" })[status] || status;
}

function verdictLabel(value) {
  return ({ GREEN:"Permitido · GREEN", YELLOW:"Requiere aprobación · YELLOW", RED:"Bloqueado · RED", approved:"Aprobada", denied:"Denegada", blocked:"Bloqueada", invalidated:"Invalidada", expired:"Caducada", "kill-on":"Kill Switch activado", "kill-off":"Kill Switch desactivado" })[value] || statusLabel(value);
}

function actionLabel(action) {
  return ({ read:"lectura", write:"escritura", send:"envío", pay:"pago", delete:"borrado", exec:"ejecución", grant:"concesión" })[action] || action || "-";
}

function renderAuditInto(box, entries) {
  box.replaceChildren();
  if (entries.length === 0) { box.append(el("div", { class: "empty" }, T.noEvents)); return; }
  const head = el("tr", {}, ...[T.time, T.eventType, T.agentAction, T.verdictState, T.rule, T.request].map((h) => el("th", {}, h)));
  const rows = entries.map((e) => {
    const result = e.from && e.to ? statusLabel(e.from) + " → " + statusLabel(e.to) : verdictLabel(e.decision);
    const badge = e.decision === "GREEN" || e.decision === "YELLOW" || e.decision === "RED"
      ? el("span", { class: "verdict " + e.decision }, verdictLabel(e.decision))
      : el("span", {}, result);
    return el("tr", {}, el("td", { class: "mono" }, fmtTime(e.at)), el("td", {}, auditEventLabel(e.event)),
      el("td", {}, (e.agent || "-") + " · " + actionLabel(e.action)), el("td", {}, badge),
      el("td", { class: "mono" }, e.rule || "-"), el("td", { class: "mono" }, e.request_id || "-"));
  });
  box.append(el("div", { class: "table-wrap" }, el("table", {}, el("thead", {}, head), el("tbody", {}, ...rows))));
}

function renderAudit() {
  renderAuditInto(document.getElementById("audit"), state.audit);
  renderAuditInto(document.getElementById("audit-preview"), state.audit.slice(0, 5));
}

function renderSummary() {
  const summary = state.summary;
  const verdicts = summary?.verdicts || { GREEN:0, YELLOW:0, RED:0 };
  document.getElementById("event-metric").textContent = String(summary?.eventCount ?? 0);
  document.getElementById("green-total").textContent = String(verdicts.GREEN);
  document.getElementById("yellow-total").textContent = String(verdicts.YELLOW);
  document.getElementById("red-total").textContent = String(verdicts.RED);
}

function checkMessage(check) {
  const message = check.message;
  if (message.startsWith("Node ")) return "Node.js " + message.slice(5).split(" ")[0];
  if (message.startsWith("MERUNTIME_MANDATE override")) return "Se está usando la ruta de mandato configurada en MERUNTIME_MANDATE.";
  if (message.includes("mandate.json is valid")) return "Mandato válido.";
  if (message.includes("mandate.json not found")) return "No se encontró mandate.json; las solicitudes se deniegan.";
  if (message.includes("mandate.json is not valid JSON")) return "mandate.json no contiene JSON válido.";
  if (message.includes("mandate.json schema:")) return "mandate.json no cumple el esquema.";
  if (message.includes("secrets.json not found")) return "No se encontró secrets.json.";
  if (message.includes("secrets.json must contain")) return "secrets.json no contiene un objeto JSON válido.";
  if (message.includes("secrets.json is valid and has an HMAC key")) return "secrets.json contiene una clave de firma válida.";
  if (message.includes("secrets.json has no pendingHmacKey")) return "La clave de firma se generará al primer uso.";
  if (message.includes("invalid pendingHmacKey")) return "La clave de firma de secrets.json no es válida.";
  if (message.startsWith("empty tokens")) return "Hay credenciales opcionales sin configurar.";
  if (message.includes("readable by other users")) return "Otros usuarios pueden leer secrets.json.";
  if (message.includes("kill.json not found")) return "No se encontró kill.json; se bloquea por seguridad.";
  if (message.includes("kill.json must be")) return "kill.json no contiene un estado válido.";
  if (message.includes("kill switch is ON")) return "El Kill Switch está activado.";
  if (message.includes("kill.json is valid")) return "kill.json es válido; el Kill Switch está desactivado.";
  return T.checkOther;
}

function renderSecurity() {
  const s = state.status;
  if (!s) return;
  const killBox = document.getElementById("security-kill");
  killBox.replaceChildren(
    el("div", { class: "status-title" }, T.killTitle + ": " + (s.killOn ? T.killActive : T.killInactive)),
  );
  const kill = el("button", { class: s.killOn ? "" : "danger" }, s.killOn ? T.killOff : T.killOn);
  kill.addEventListener("click", async () => {
    if (s.killOn && !confirm(T.confirmOff)) return;
    kill.disabled = true;
    try { await api("/api/kill", { on: !s.killOn }); } catch (e) { toast(e.message); }
    refresh();
  });
  killBox.append(kill);

  const policy = s.policy;
  const rows = [
    [T.defaultPolicy, s.defaultDeny ? T.defaultDeny : "Permitir según el mandato"],
    ["Reglas", String(policy.ruleCount)],
    ["Límite por operación", policy.perTxEur === null ? "Sin límite configurado" : policy.perTxEur + " €"],
    ["Plazo de aprobación", policy.approvalTimeoutMinutes + " min"],
    ["Solicitudes nuevas", policy.rateLimitPerSecond + " / s"],
    ["Máximo de pendientes YELLOW", String(policy.maxPendingRequests)],
    [T.runtimeVersion, "v" + s.version],
    [T.dataDirectory, s.dataDirectory],
    ["audit.jsonl", s.files.audit], ["requests.json", s.files.requests], ["kill.json", s.files.kill],
  ];
  const securityRows = document.getElementById("security-rows");
  securityRows.replaceChildren(...rows.map(([label, value]) => el("div", { class: "security-row" }, el("dt", {}, label), el("dd", { class: label.endsWith(".json") || label === T.dataDirectory ? "mono" : "" }, value))));

  const checks = document.getElementById("security-checks");
  checks.replaceChildren(...s.checks.map((check) => {
    const label = check.level === "ok" ? T.checkOk : check.level === "warn" ? T.checkWarn : check.level === "fail" ? T.checkFail : T.checkOther;
    return el("div", { class: "check-item" }, el("span", {}, checkMessage(check)), el("strong", {}, label));
  }));
}

const PROFILES = ["read-only", "payments-ask", "payments-known", "blocked"];
let wizardActive = false;
let wiz = { step: 1, profile: "payments-ask", limit: "50", hosts: "", ibans: "", error: "", config: null, clients: [] };

const lines = (text) => text.split(String.fromCharCode(10)).map((l) => l.trim()).filter(Boolean);
function profileText(id) {
  const key = id.replace(/-/g, "_");
  return [T["w_p_" + key + "_t"], T["w_p_" + key + "_d"]];
}
function applyMode() {
  document.getElementById("app").classList.toggle("hidden", wizardActive);
  document.getElementById("wizard").classList.toggle("hidden", !wizardActive);
}
function field(label, control) {
  return el("div", { class: "field" }, el("label", {}, label), control);
}

function renderFields(box) {
  const id = wiz.profile;
  if (id === "payments-ask" || id === "payments-known") {
    box.append(field(T.w_limit, el("input", { type: "number", min: "1", step: "1", value: wiz.limit, oninput: (e) => { wiz.limit = e.target.value; } })));
  }
  if (id !== "blocked") {
    box.append(field(T.w_sites, el("textarea", { placeholder: "api.github.com", oninput: (e) => { wiz.hosts = e.target.value; } }, wiz.hosts)));
  }
  if (id === "payments-known") {
    box.append(field(T.w_ibans, el("textarea", { placeholder: "ES00 0000 0000 0000 0000 0001", oninput: (e) => { wiz.ibans = e.target.value; } }, wiz.ibans)));
  }
}

function wizardStep1(box) {
  box.append(el("div", { class: "wtitle" }, T.w_welcome), el("div", { class: "wsub" }, T.w_intro));
  for (const id of PROFILES) {
    const [title, desc] = profileText(id);
    const radio = el("input", { type: "radio", name: "profile", value: id });
    if (wiz.profile === id) radio.setAttribute("checked", "");
    radio.addEventListener("change", () => { wiz.profile = id; renderWizard(); });
    box.append(el("label", { class: "option" + (wiz.profile === id ? " sel" : "") }, el("div", { class: "ot" }, radio, title), el("div", { class: "od" }, desc)));
  }
  const fields = el("div", {});
  renderFields(fields);
  const next = el("button", { class: "primary" }, T.w_continue);
  next.addEventListener("click", async () => {
    const payments = wiz.profile === "payments-ask" || wiz.profile === "payments-known";
    const body = { profile: wiz.profile };
    if (payments) body.limit = Number(wiz.limit);
    if (wiz.profile !== "blocked" && lines(wiz.hosts).length > 0) body.hosts = lines(wiz.hosts);
    if (wiz.profile === "payments-known") body.ibans = lines(wiz.ibans);
    next.disabled = true;
    wiz.error = "";
    try {
      await api("/api/setup", body);
      wiz.config = await api("/api/mcp-config");
      wiz.clients = await api("/api/clients");
      wiz.step = 2;
    } catch (e) {
      wiz.error = T.w_error + " " + e.message;
    }
    renderWizard();
  });
  box.append(fields, el("div", { class: "err" }, wiz.error), el("div", { class: "actions" }, next));
}

function configBlock(label, value) {
  const text = JSON.stringify(value, null, 2);
  const copy = el("button", {}, T.w_copy);
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(text); copy.textContent = T.w_copied; } catch (e) { toast(text); }
  });
  return el("div", { class: "field" }, el("label", {}, label), el("pre", {}, text), copy);
}

function clientRow(c) {
  const canConnect = c.detected && !c.connected && !c.problem;
  const note = !c.detected ? T.w_not_detected : c.problem ? c.problem : c.connected ? T.w_connected + ". " + T.w_restart : T.w_will_edit + " " + c.path + ". " + T.w_backup;
  const button = el("button", canConnect ? { class: "primary" } : { disabled: "" }, c.connected ? T.w_connected : T.w_connect_btn);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try { await api("/api/clients/connect", { id: c.id }); } catch (e) { toast(e.message); }
    try { wiz.clients = await api("/api/clients"); } catch (e) { /* se conserva la lista anterior */ }
    renderWizard();
  });
  return el("div", { class: "card" }, el("div", { class: "what" }, c.name), el("div", { class: "wsub" }, note), el("div", { class: "actions" }, button));
}

function wizardStep2(box) {
  const next = el("button", { class: "primary" }, T.w_continue);
  next.addEventListener("click", () => { wiz.step = 3; renderWizard(); });
  const manual = el("details", {}, el("summary", {}, T.w_manual),
    configBlock(T.w_c_claude, wiz.config.claudeAndCursor), configBlock(T.w_c_vscode, wiz.config.vscode), configBlock(T.w_c_local, wiz.config.local),
    el("div", { class: "wsub" }, T.w_c_win));
  box.append(el("div", { class: "wtitle" }, T.w_connect), el("div", { class: "wsub" }, T.w_connect_d),
    ...wiz.clients.map(clientRow), manual, el("div", { class: "actions" }, next));
}

function wizardStep3(box) {
  const dl = el("dl", {});
  for (const [k, v] of [[T.why, T.w_ex_why], [T.agent, "my-agent"], [T.expires, "5:00"]]) dl.append(el("dt", {}, k), el("dd", {}, v));
  const open = el("button", { class: "primary" }, T.w_open);
  open.addEventListener("click", () => { wizardActive = false; applyMode(); refresh(); });
  box.append(
    el("div", { class: "wtitle" }, T.w_ready), el("div", { class: "wsub" }, T.w_ready_d), el("div", { class: "wsub" }, T.w_example),
    el("div", { class: "card" }, el("div", { class: "what" }, T.w_ex_headline), dl,
      el("div", { class: "actions" }, el("button", { class: "primary", disabled: "" }, T.authorize), el("button", { disabled: "" }, T.deny))),
    el("div", { class: "actions" }, open));
}

function renderWizard() {
  const box = document.getElementById("wizard");
  box.replaceChildren(el("div", { class: "step" }, T.w_step + " " + wiz.step + " " + T.w_of + " 3"));
  if (wiz.step === 1) wizardStep1(box);
  else if (wiz.step === 2) wizardStep2(box);
  else wizardStep3(box);
}

let refreshing = false;
let connectionFailures = 0;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const revision = pendingRevision;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    if (!token || sessionExpired) throw Object.assign(new Error(T.decisionAccess), { code: "UNAUTHORIZED" });
    const status = await api("/api/status", undefined, controller.signal);
    document.getElementById("top-version").textContent = "v" + status.version;
    document.getElementById("footer-version").textContent = "Versión " + status.version;
    const bodyGrid = document.getElementById("body-grid");
    if (status.needsSetup && !wizardActive) {
      bodyGrid.classList.remove("offline-mode");
      wizardActive = true; renderWizard(); applyMode();
    }
    if (!wizardActive) {
      const [summary, pending, audit] = await Promise.all([
        api("/api/summary", undefined, controller.signal),
        api("/api/pending", undefined, controller.signal),
        api("/api/audit", undefined, controller.signal),
      ]);
      state = { status, summary, pending: revision === pendingRevision ? pending : state.pending, audit };
      renderStatus(); renderSummary(); renderSecurity(); renderAudit();
      renderPending();
    }
    connectionFailures = 0;
    document.getElementById("offline").classList.add("hidden");
    bodyGrid.classList.remove("offline-mode");
  } catch (e) {
    document.getElementById("body-grid").classList.add("offline-mode");
    document.getElementById("banner").classList.add("hidden");
    connectionFailures++;
    renderOffline(e.code === "UNAUTHORIZED" || sessionExpired ? "session"
      : connectionFailures >= 5 ? "unavailable" : e.code === "NETWORK_ERROR" ? "reconnecting" : "server");
    document.getElementById("offline").classList.remove("hidden");
  } finally {
    controller.abort();
    clearTimeout(timeout);
    refreshing = false;
  }
}

function showView(id) {
  for (const view of document.querySelectorAll(".view")) view.classList.toggle("active", view.id === "view-" + id);
  for (const button of document.querySelectorAll(".nav-btn")) {
    const active = button.getAttribute("data-view") === id;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  }
}
for (const button of document.querySelectorAll(".nav-btn")) button.addEventListener("click", () => showView(button.getAttribute("data-view")));
document.getElementById("open-pending").addEventListener("click", () => showView("pending"));
document.getElementById("open-activity").addEventListener("click", () => showView("activity"));
renderOffline();
if (storageUnavailable) toast("El navegador no permite guardar la sesión de esta pestaña. Al recargar tendrás que abrir el enlace completo de meruntime ui.", "danger");
refresh();
setInterval(refresh, 2000);
setInterval(() => {
  for (const node of document.querySelectorAll("[data-expires]")) node.textContent = countdown(node.getAttribute("data-expires"));
}, 1000);
`;

export function renderPage(nonce: string, version: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Me Runtime</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<div class="app-shell">
  <header class="topbar">
    <div class="brand" aria-label="Me Runtime">
      <svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true">
        <rect width="64" height="64" rx="16" fill="#1a211c"></rect>
        <rect x="20" y="10" width="24" height="44" rx="12" fill="#0d100e" stroke="#2a322c"></rect>
        <circle class="lamp-green" cx="32" cy="21" r="6"></circle>
        <circle class="lamp-yellow" cx="32" cy="32" r="6"></circle>
        <circle class="lamp-red" cx="32" cy="43" r="6"></circle>
      </svg>
      <strong>Me Runtime</strong>
    </div>
    <div class="beta">Beta · licencia FSL-1.1-MIT</div>
    <div id="local-address" class="local-address"></div>
    <div id="top-version" class="top-version">v${version}</div>
  </header>
  <div id="body-grid" class="body-grid offline-mode">
    <aside class="sidebar">
      <nav class="side-nav" aria-label="Navegación principal">
        <button class="nav-btn active" data-view="summary" aria-current="page">Resumen</button>
        <button class="nav-btn" data-view="pending" aria-current="false">Solicitudes <span id="pending-count" class="nav-count">0</span></button>
        <button class="nav-btn" data-view="activity" aria-current="false">Actividad</button>
        <button class="nav-btn" data-view="security" aria-current="false">Seguridad</button>
      </nav>
      <div class="side-note">Denegar por defecto.<br>Solo se ejecuta lo permitido por el mandato.</div>
    </aside>
    <main class="content">
      <section id="wizard" class="hidden"></section>
      <div id="app">
        <div id="offline" class="status-band bad hidden" role="status"></div>
        <section id="banner" class="status-band hidden"></section>

        <section id="view-summary" class="view active" aria-labelledby="summary-title">
          <div class="page-head">
            <div><div class="eyebrow">Me Runtime · supervisión local</div><h1 id="summary-title">Resumen</h1><p class="page-sub">Estado y decisiones registradas por el runtime.</p></div>
          </div>
          <div class="metrics">
            <div class="metric"><div class="metric-label">Eventos de auditoría</div><div class="metric-value"><span id="event-metric">0</span><span class="metric-unit">registrados</span></div></div>
            <div class="metric green"><div class="metric-label">Permitido</div><div class="metric-value"><span id="green-total">0</span><span class="metric-unit">GREEN</span></div></div>
            <div class="metric yellow"><div class="metric-label">Requiere aprobación</div><div class="metric-value"><span id="yellow-total">0</span><span class="metric-unit">YELLOW</span></div></div>
            <div class="metric red"><div class="metric-label">Bloqueado</div><div class="metric-value"><span id="red-total">0</span><span class="metric-unit">RED</span></div></div>
          </div>
          <div class="overview-grid">
            <section class="section">
              <div class="section-head"><h2>Solicitudes pendientes</h2><button id="open-pending" class="text-link">Ver solicitudes</button></div>
              <div id="pending-preview"></div>
            </section>
            <section class="section">
              <div class="section-head"><h2>Actividad reciente</h2><button id="open-activity" class="text-link">Ver actividad</button></div>
              <div id="audit-preview"></div>
            </section>
          </div>
        </section>

        <section id="view-pending" class="view" aria-labelledby="pending-title">
          <div class="page-head"><div><div class="eyebrow">Decisiones humanas</div><h1 id="pending-title">Solicitudes</h1><p class="page-sub">Solicitudes YELLOW que esperan una decisión.</p></div></div>
          <div id="pending"></div>
        </section>

        <section id="view-activity" class="view" aria-labelledby="activity-title">
          <div class="page-head"><div><div class="eyebrow">Registro local</div><h1 id="activity-title">Actividad</h1><p class="page-sub">Eventos leídos de <span id="audit-file-label" class="mono"></span></p></div></div>
          <div id="audit"></div>
        </section>

        <section id="view-security" class="view" aria-labelledby="security-title">
          <div class="page-head"><div><div class="eyebrow">Política local</div><h1 id="security-title">Seguridad</h1><p class="page-sub">Estado del Kill Switch, mandato y archivos locales.</p></div></div>
          <div class="security-grid">
            <div>
              <section class="section"><div class="section-head"><h2>Kill Switch</h2></div><div id="security-kill" class="actions"></div></section>
              <section class="section"><div class="section-head"><h2>Mandato y archivos</h2></div><dl id="security-rows" class="security-rows"></dl></section>
            </div>
            <section class="section"><div class="section-head"><h2>Comprobaciones locales</h2></div><div id="security-checks" class="check-list"></div></section>
          </div>
        </section>
      </div>
      <footer class="app-footer"><span>Me Runtime</span><span id="footer-version">Versión ${version}</span></footer>
    </main>
  </div>
</div>
<div id="toast" class="hidden" role="status" aria-live="polite" aria-atomic="true"></div>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}
