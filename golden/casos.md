# Golden cases — Me Runtime

Casos de referencia y el veredicto esperado del semáforo.

| Caso                                                    | Mandato                        | Intent                                  | Veredicto esperado |
| -------------------------------------------------------- | ------------------------------- | ---------------------------------------- | ------------------- |
| Pago de 200 EUR con techo `perTxEur: 40`                 | `examples/mandates/personal.json` | `examples/intents/pago-200.json`           | RED                 |
| Lectura a `api.github.com` con host permitido y regla allow | `examples/mandates/personal.json` | `examples/intents/lectura-github.json`     | GREEN                |
| `killSwitch: true`                                        | cualquiera                      | cualquiera                                | RED                 |
| Intent sin `effects`                                       | cualquiera                      | cualquiera                                | RED                 |
| `send` durante `quietHours`                                | mandato con `quietHours`         | intent con `action: "send"`                | YELLOW               |
| Acción en `denyActions` (p.ej. `delete`)                   | mandato con `denyActions`         | intent con esa acción                     | RED                 |
| Host en `denyHosts`                                        | mandato con `denyHosts`           | intent con `target` en ese host           | RED                 |
| Ninguna regla coincide                                     | mandato sin reglas aplicables     | cualquier intent completo                | RED                 |
| borrar-archivo.json                                        | delete                          | RED                                       | denyActions incluye delete |
