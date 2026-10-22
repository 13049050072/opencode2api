# opencode2api

[English](README.md) | [简体中文](README.zh-CN.md) | [Tiếng Việt](README.vi.md) | [Italiano](README.it.md)

Un gateway scritto in Go per **OpenCode Zen e Zen Go**. Espone endpoint Chat Completions, Responses e Anthropic Messages, traduce tra i protocolli nativi e gestisce upstream key e proxy.

L'eseguibile include la WebUI. Per eseguire il servizio non servono runtime Node.js né database.

## Funzionalità

- Risposte JSON e SSE su tutti e tre i protocolli di inferenza.
- Testo, immagini, ragionamento, function tool, tool call e tool result; contenuto di file dove il protocollo di destinazione può rappresentarlo.
- Pool di chiavi Zen e Go separati, preferenza di tier configurabile, retry e session affinity.
- Accesso anonimo a Zen opzionale con la credenziale `public` di OpenCode.
- Connessioni direct, HTTP, HTTPS, SOCKS5 e SOCKS5H, incluso un file di proxy.
- Discovery dinamica dei modelli, metadata del protocollo nativo e cache su disco.
- Porta di gestione dedicata con editing della configurazione, Playground, diagnostica, statistiche token e log in tempo reale.
- Hot reload della configurazione con validazione prima di passare le nuove richieste a un gateway sostitutivo.
- Dashboard quota abbonamento Go con percentuali rimanenti, tempi di reset e modelli disponibili.
- Creazione, denominazione, abilitazione, disabilitazione ed eliminazione di API key locali con effetto immediato.
- Gruppi di modelli `sota` / `sweet` con stickiness, ordine, fallback su errore, protezione dello streaming e stato persistito.

See the [management console guide (Chinese)](docs/management.zh-CN.md) for the new pages and configuration.

Vedi la [guida della console di gestione (cinese)](docs/management.zh-CN.md) per le nuove pagine e la configurazione.

## Avvio rapido

Scarica un binario da [GitHub Releases](https://github.com/jasonxu114514/opencode2api/releases), oppure compila con **Go 1.24 o superiore**:

```bash
git clone https://github.com/jasonxu114514/opencode2api.git
cd opencode2api
cp config.example.json config.json
go build -o opencode2api ./cmd/opencode2api
```

Prima di avviare, modifica `config.json`:

1. Sostituisci `server_keys` con la tua API key locale.
2. Fornisci chiavi Zen o Go. In alternativa, imposta `anonymous: true` e lascia vuoti entrambi gli array di chiavi upstream.
3. Sostituisci `webui.password`. L'esempio abilita la WebUI con l'account `admin`.

```bash
./opencode2api -config config.json
```

Su Windows usa `Copy-Item config.example.json config.json`, compila con `go build -o opencode2api.exe ./cmd/opencode2api`, poi esegui `.\opencode2api.exe -config config.json`.

Il file di esempio ascolta su `127.0.0.1:8080` per le API e `0.0.0.0:8081` per la WebUI. Apri `http://localhost:8081` sulla macchina locale. Limita l'accesso amministrativo e usa un reverse proxy HTTPS quando accedi via rete.

Opzioni da riga di comando:

| `-config`     | `config.json` | Configuration file path.           |
| -------------- | -------------- | -------------------------------------------- |
| `-web-listen` | Unset         | Override the WebUI listen address. |

The configuration directory must be writable for password migration, configuration saves, and model caches.

La directory di configurazione deve essere scrivibile per le modifiche della password, il salvataggio della configurazione e la cache dei modelli.

## Docker

L'immagine rilasciata è `ghcr.io/jasonxu114514/opencode2api`.

```bash
cp config.example.json config.json
# Configura le chiavi e sostituisci la password della WebUI prima di avviare.
docker compose up -d
docker compose logs -f
```

Compose importa la configurazione dall'host nel volume `opencode2api-state` **solo al primo avvio**. Le modifiche successive vanno fatte tramite la WebUI. Per re-importare un file di configurazione modificato sull'host:

```bash
docker compose cp config.json opencode2api:/var/lib/opencode2api/config.json
docker compose restart
```

Il container esegue il servizio con un utente non privilegiato. Compose usa un filesystem root in sola lettura, un volume di stato scrivibile e un filesystem temporaneo `/tmp`.

| `OPENCODE2API_VERSION`      | `latest` | Image tag. Pin a release tag for a fixed version. |
| -------------------------------- | --------- | ----------------------------------------------------------- |
| `OPENCODE2API_WEBUI_PORT`   | `8081`   | Host port mapped to container port 8081.          |
| `OPENCODE2API_LISTEN`       | Unset    | Explicit container API listen override.           |
| `OPENCODE2API_WEBUI_LISTEN` | Unset    | Explicit container WebUI listen override.         |

The last two variables become `LISTEN_ADDRESS` and `WEBUI_LISTEN_ADDRESS` inside the container. Empty values defer to the configuration file. While initializing a configuration, the entrypoint changes the example API address `127.0.0.1:8080` to `0.0.0.0:8080` so published ports can reach it.

Le ultime due variabili diventano `LISTEN_ADDRESS` e `WEBUI_LISTEN_ADDRESS` nel container. Valori vuoti usano il file di configurazione. All'inizializzazione della configurazione, l'entrypoint cambia l'indirizzo API di esempio `127.0.0.1:8080` in `0.0.0.0:8080` affinché le porte pubblicate siano raggiungibili.

Cambiare la porta host non cambia la porta di ascolto nel container. Se cambi la porta API interna, devi aggiornare anche il mapping delle porte e l'health check dell'immagine (usa la porta 8080).

Build dell'immagine in locale:

```bash
docker build -t opencode2api:local .
docker volume create opencode2api-state
docker run -d --name opencode2api \
  -p 8080:8080 -p 8081:8081 \
  -e CONFIG_SEED_PATH=/run/config/opencode2api.json \
  -v "$(pwd)/config.json:/run/config/opencode2api.json:ro" \
  -v opencode2api-state:/var/lib/opencode2api \
  opencode2api:local
```

Anche un `proxyfile` usato in Docker deve esistere nel container al percorso configurato.

## Uso delle API

`server_keys` servono ad autenticare i client con questo gateway. Sono separate da `zen_keys` e `go_keys` e non vengono mai usate come credenziali upstream.

Invia `Authorization: Bearer YOUR_LOCAL_API_KEY` oppure `x-api-key: YOUR_LOCAL_API_KEY`. L'health check non richiede autenticazione.

| GET    | `/v1/models`           | Models that can be routed with the current configuration. |
| ----------- | ----------------------- | ------------------------------------------------------------- |
| GET         | `/v1/models`            | I modelli instradabili con la configurazione attuale.          |
| POST        | `/v1/chat/completions`  | Chat Completions.                                              |
| POST        | `/v1/responses`         | Responses.                                                     |
| POST        | `/v1/messages`          | Anthropic Messages.                                            |

Discover an available model first:

```bash

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer YOUR_LOCAL_API_KEY"
```

**Chat Completions**

**Chat Completions**

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer YOUR_LOCAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL_ID","messages":[{"role":"user","content":"Hello"}]}'
```

**Responses**

```bash
curl http://localhost:8080/v1/responses \
  -H "Authorization: Bearer YOUR_LOCAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL_ID","input":"Hello"}'
```

**Anthropic Messages**

```bash
curl http://localhost:8080/v1/messages \
  -H "x-api-key: YOUR_LOCAL_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL_ID","max_tokens":512,"messages":[{"role":"user","content":"Hello"}]}'
```

**System One**

**System One**

```bash
curl http://localhost:8080/v1/systemone \
  -H "Authorization: Bearer YOUR_LOCAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"MODEL_ID","state":"1 + 1 = 2","questions":{"arithmetic":{"type":"noul","instructions":"Is 1 + 1 equal to 2?"}}}'
```

### Compatibility boundaries

Requests using the upstream's native protocol retain provider-specific fields. Requests crossing protocols pass through a common representation; not every option has an equivalent. For example, Chat JSON output constraints and `seed` are not forwarded to Anthropic Messages. Unsupported content or tool types may be rejected.

The gateway exposes the routes listed above. It does not implement embeddings, file uploads, image generation, or Responses retrieval and cancellation. It does not store conversation history; clients must supply the history or use features supported by the actual upstream.

## Routing and models

### Model discovery

The gateway refreshes Zen/Go `/v1/models` and OpenCode's [capability catalog](https://models.opencode.ai/api.json) on the configured interval. Native protocols and model limits are tracked separately for each tier. OpenCode's Zen/Go documentation is a fallback for protocol discovery.

`models.protocols` overrides discovery:

```json

  "models": {

```json
{
  "models": {
    "refresh_seconds": 300,
    "protocols": {
      "custom-model": "chat"
    }
  }
}
```

Each `/v1/models` entry also carries `cost` (USD per million tokens: `input`, `output`, `cache_read`, `cache_write`, plus OpenClaw's `cacheRead`/`cacheWrite`) when the metadata states a price. Reasoning models list their levels in `reasoning_efforts` and in OpenClaw's `compat.supportedReasoningEfforts`: `minimal` through `max`, capped at the probed ceiling when the model's effort is `auto`. A forced or probed level is reported as `default_reasoning_effort`. Cache prices appear after the next metadata refresh.

### Anonymous access and fallback

With `anonymous: true`, either condition makes a model eligible for the anonymous Zen lane:

- Its ID contains `free`, case-insensitively.




The routing sequence is:

1. For an eligible model, try each available anonymous proxy once.

3. Apply `retry.max_attempts` separately to each authenticated tier.

Anonymous attempts are not cut short by `retry.max_attempts`, but all attempts share the request timeout. Network errors, authentication failures, rate limits, and server errors can rotate keys. Other 4xx responses end the current tier; another available tier may still be tried.

Requests are encoded for each tier's own protocol. With `performance.first_event_timeout_seconds` enabled, a successful SSE response is held until the first complete data event. A timeout or disconnect before that event uses the existing key/proxy retry budget; comments do not satisfy the timeout. Once released downstream, the stream is never replayed. The default is `0` (disabled); try `15` seconds for upstreams that accept requests but send no events. This bounds the first event, not the first text token, and does not apply to System One. Rotation aliases use their separate `rotation.first_output_seconds` timeout. A recognized stale Responses reasoning reference can trigger one repair pass; selected-key diagnostics never use that replay.

When only anonymous access is configured, `/v1/models` exposes only models eligible for that lane.

Free models never need a Zen key: with `anonymous: true` they are served by the public lane, and a configured key is only their fallback. To keep keys but expose free models only, set `models.free_only: true`. Paid models then disappear from `/v1/models`, direct requests for them are rejected, and rotation aliases keep only free members; free models may still fall back to the configured keys.

### Free model availability

The gateway probes models whose IDs contain `free` (case-insensitive), or whose metadata reports zero input/output cost without deprecation, with a short request using its native protocol. It tries the enabled anonymous lane first and then one configured Zen Key. A valid completed response on either lane keeps the model enabled; the model is disabled in discovery and routing only when every attempted lane explicitly reports that the model does not exist or has been retired. Authentication errors, rate limits, timeouts, transport errors, 5xx responses, and malformed replies are inconclusive: they do not create a new disable, and are checked again in one hour. Probe traffic does not alter production key/proxy cooldowns or request statistics. It still reaches the upstream and may consume its free allowance.

System One models use a native `noul` question asking whether 1 + 1 equals 2; they are never sent chat/tool payloads. Model discovery includes `native_protocol` and `supported_endpoints`; rotation aliases are listed only when Go keys and eligible models exist. Legacy v1.3.6 disables are cleared on load and scheduled for immediate recheck because those probes used invalid session IDs.

The intervals are fixed: enabled models are checked every **1 hour**, models confirmed unavailable every **24 hours**. An inconclusive due recheck of a disabled model preserves its original disable reason and schedules another retry in 24 hours. A successful recheck restores the model automatically. The WebUI **Free model availability** page can restore it immediately, which puts the model under manual control: it stays enabled and is excluded from automatic probing, so later probe results cannot overwrite it. Use the per-model **manual/automatic toggle** on the same page to return it to automatic probing; the next scheduler pass then schedules a probe. Records left as `manually_enabled` by older versions migrate to manual control on load. An in-flight probe cannot undo a manual restore. Models without a usable Zen/anonymous lane, or without a supported inference protocol, are skipped.

Manual control also pauses effort discovery for `reasoning.effort=auto`; learned levels stop being forced after two hours without verification. Returning to automatic control allows effort discovery to resume.

State survives restarts in `config.json.<upstream-fingerprint>.availability.json`, separated by the Zen upstream URL. The background scheduler checks for due models once per minute, skips manually controlled models, and probes the rest sequentially, with a 60-second timeout per lane. No channels available means no automatic disable.

Administration endpoints (login required; writes also require CSRF): `GET /api/models/availability`, `POST /api/models/restore` with `{"model":"MODEL_ID"}` (restores and takes manual control), and `POST /api/models/manual` with `{"model":"MODEL_ID","manual":true|false}` to switch between manual and automatic control.

### Sessions and proxies

Keys are initially spread across proxies. Real traffic can trigger proxy checks, key rebinding, and cooldowns. Unhealthy proxies are rechecked every 15 minutes against Cloudflare trace.

### Session và proxy

Without an explicit ID, the first user message is used as a seed. Conversations beginning with the same content can therefore share affinity. Changing pool membership can change the selected node.

Cooldowns grow exponentially up to eight times `performance.failure_cooldown_seconds`, and a longer `Retry-After` is honored. If every authenticated key is cooling down, routing may try the key whose cooldown ends first. Anonymous nodes still in cooldown are skipped.

## Configuration reference

See [config.example.json](config.example.json) for a complete starting configuration. JSON supports `//` and `/* ... */` comments; unknown fields and invalid values are rejected.

### Keys, listeners, and routing

Vedi [config.example.json](config.example.json) per una configurazione di partenza completa. Il JSON supporta i commenti `//` e `/* ... */`; campi sconosciuti e valori non validi vengono rifiutati.

### Chiavi, porta di ascolto e instradamento

| `zen_keys`, `go_keys`       | At least one upstream key is required unless anonymous access is enabled.   |
| -------------------------- | ---------------------------------------------------------------- |
| `listen`                   | `127.0.0.1:8080`.                                                |
| `upstream.zen`              | `https://opencode.ai/inference/openai`.                                                  |
| `upstream.go`               | `https://opencode.ai/zen/go`.                                               |
| `anonymous`                | `false`.                                                         |
| `proxyfile`                 | Optional; relative paths resolve beside the configuration file.             |
| `upstream.zen`             | `https://opencode.ai/inference/openai`.                          |
| `upstream.go`              | `https://opencode.ai/zen/go`.                                    |
| `models.free_only`          | `false`; expose and route only free models, even with Zen or Go keys.       |
| `reasoning.effort`          | Empty (off); `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `none`. |
| `reasoning.effort_by_model` | `{}`; per-model overrides of `reasoning.effort`.                            |

### Forced thinking level

`reasoning.effort` sets the thinking level used upstream when a request does not

### Tier di ragionamento forzato

`thinking.budget_tokens` can only be approximated by the Chat and Responses

```json
{
  "reasoning": {
    "effort": "high",
    "effort_by_model": { "claude-opus-5": "max" }
  }
}
```



nobody asked for: an absent one, or one derived from `thinking.budget_tokens`.



`output_config.effort` survives conversion instead of being shadowed by a

`xhigh`, so the two stay distinguishable), and the Responses target carries the

```text
# Proxy chính
http://user:password@127.0.0.1:7890
the object in `PUT /api/config`; clients that omit the field keep the existing
direct
```



#### Pool proxy rotante

# Primary proxy

```text
http://127.0.0.1:7890#pool
socks5://127.0.0.1:1080#pool
pool+http://127.0.0.1:7891
```

#### Rotating proxy pools

| Hành vi               | Proxy tĩnh                                                     | Mục `#pool`                                                              |
| --------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
```text
http://127.0.0.1:7890#pool
socks5://127.0.0.1:1080#pool
pool+http://127.0.0.1:7891



### Timeout e pool di connessioni

| ------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| ---------------------------------------- | -------- | ----------------------------------------------------------- |
| Failure cooldown          | 15s–120s exponential backoff, inflated by `Retry-After`             | None: the next request simply draws a new exit IP                             |
| Health eviction           | Marked unhealthy, keys rebound, rechecked every 15 minutes          | Never evicted; the health check is skipped entirely                           |
| Anonymous lane retries    | At most one attempt per configured proxy                            | Up to `retry.max_attempts`, cycling the pool entry                            |

Use it when the endpoint behind the URL already performs the rotation and the pool's own exit IPs are individually rate-limited or flaky; the gateway then treats each attempt as a fresh endpoint instead of pinning the conversation to one exit. A single `#pool` entry is enough — you no longer need to list dozens of exits. Static entries keep the pooling behavior described below.

### Timeouts and connection pools

| Field                                   | Default | Meaning                                                |

| `retry.max_attempts`                    | `3`     | Attempts per authenticated tier, including the first.  |

### Log e gestione

| `performance.failure_cooldown_seconds`  | `15`    | Base failure cooldown.                                 |
| ----------------------------- | ------------------------------------------------------- |
| `performance.max_idle_conns_per_host`   | `256`   | Idle connection limit per host and transport.          |
| `logging.ring_size`           | `2000`; khoảng 100–50.000.                              |
| `performance.idle_conn_timeout_seconds` | `120`   | Idle connection lifetime.                              |

| `webui.listen`                | `0.0.0.0:8081`.                                          |

### Logging and management

| `webui.session_ttl_minutes`   | `720`; khoảng 5–10.080.                                 |

| `logging.level`               | `info`; accepts `debug`, `info`, `warn`, `error`.             |

| `logging.dump_request_bodies` | `false`. Requires `debug` logging to emit outbound bodies.    |

| `webui.listen`                | `0.0.0.0:8081`.                                               |

| `webui.password`              | Bootstrap password with a minimum length of 10.               |

| `webui.session_ttl_minutes`   | `720`; range 5–10,080.                                        |
| ---------------------------------------------- | --------------------------------------------------------------- |
On startup, a bootstrap password is hashed and removed from the configuration. The backup containing that bootstrap plaintext is deleted. Keep configuration files and backups private: upstream keys and proxy credentials remain necessary configuration secrets.

Body dumps are opt-in and capped at 64 KiB per prepared body. Configured secrets are redacted, but conversation content may still be sensitive.

## WebUI and diagnostics

The management listener serves the UI and `/api/*` routes. Authentication uses one administrator account, server-side sessions, HttpOnly/SameSite cookies, CSRF checks for writes, and login throttling.

| Management route                                 | Purpose                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------- |

| `GET /api/auth/session`, `POST /api/auth/logout` | Inspect or end the session.                                           |

```json
{
  "protocol": "chat",
  "key": { "mode": "auto" },
  "request": {
    "model": "MODEL_ID",
    "messages": [{ "role": "user", "content": "Hello" }]
  }
}
```

{

  "key": { "mode": "auto" },

    "model": "MODEL_ID",

### Lingua dell'interfaccia

```

The server forces `stream: false`. Use `{"mode":"selected","tier":"zen","id":"KEY_FINGERPRINT"}` to test a specific key from `/api/debug/models`. A selected request makes at most one upstream attempt, without anonymous access, key rotation, tier fallback, or reasoning replay.

**Both automatic and selected diagnostics preserve production key cooldowns, failure counts, proxy health, and bindings.** They still make real upstream requests, can consume provider quota, and appear in monitoring.




### Salvataggio e ricaricamento

Il server valida una configurazione candidata e costruisce un gateway sostitutivo prima di salvare e passare. Validazione o salvataggio falliti lasciano il gateway attivo invariato. Le richieste già in corso continuano sul gateway originale.

Chiavi, proxy, URL upstream, impostazioni di retry, impostazioni modello, log e preferenze di instradamento si applicano subito alle nuove richieste. Le modifiche a `listen`, `webui.listen` o `webui.enabled` richiedono il riavvio del processo. Il JSON salvato è normalizzato; i commenti non vengono conservati.

- Dates and times follow the selected locale as well.

Il risultato della richiesta descrive l'inferenza completata. Una risposta SSE fallita o un flusso troncato viene comunque conteggiata come errore anche se HTTP 200 è già stato inviato; il suo risultato è `stream_error`. L'annullamento del client viene registrato come `client_canceled`. La WebUI mostra questi risultati accanto al codice di stato HTTP.

Il record del **tentativo** upstream misura lo scambio HTTP fino alla ricezione dell'header della risposta. Il suo successo e la latenza sono separati dal completamento dell'intero body JSON o del flusso.

Le statistiche dei token usano solo l'usage riportato. I token di input includono lettura e scrittura della cache; i token cache separati contano le letture della cache. L'usage mancante non viene stimato, e la copertura indica quante richieste di inferenza instradate riportano usage. `usage.server_keys` separa richieste e token per server key locale con cui il caller si è autenticato (il suo fingerprint, come mostrato in `/api/api-keys`); il traffico Playground è conteggiato sotto `playground`.

Keys, proxies, upstream URLs, retry settings, model settings, logging, and routing preferences apply to new requests immediately. Changes to `listen`, `webui.listen`, or `webui.enabled` require a process restart. Saved JSON is normalized; comments are not retained.
| -------------------------------------------------------- | -------------------------------------------------------------- |
## Monitoring and persistence
| Dettagli request e tentativi                                | Ultima ora, al massimo 10.000 request e 20.000 tentativi; l'API restituisce al massimo 500 voci per tipo. |
| Ring log live                                         | Memoria del processo; dimensione definita da `logging.ring_size`. |
| Log strutturati                                            | JSON su stdout; raccogli esternamente per conservazione a lungo termine.          |
Upstream **attempt** records measure the HTTP exchange through receipt of response headers. Their success and latency are separate from completion of the full JSON body or stream.
| Cache catalogo modelli                                      | `config.json.models.catalog.json`.                             |
| Cache prezzi/deprecazione                                         | `config.json.models.dev.json`.                                 |

Il nome del file di cache si basa sul percorso di configurazione effettivo. I contatori di età si basano sull'età del processo corrente. Le istanze non condividono session o stato di monitoraggio.

### Health check

`/healthz` non incrementa i contatori di monitoraggio e non genera richieste di rete. Riporta il conteggio delle risorse senza chiavi o indirizzi proxy.

- HTTP 503: catalogo iniziale ancora in attesa, nessun modello instradabile con la configurazione attuale, oppure nessun proxy sano.
- HTTP 200: pronto, anche se la cache del catalogo utilizzabile è vecchia. In quel caso lo stato del modello è `stale` e lo stato complessivo è `degraded`.

La soglia di vecchiaia è il doppio di `models.refresh_seconds`, minimo 60 secondi. La readiness è un controllo di liveness e risorse; non verifica che la chiave upstream accetterà la prossima inferenza.



Il codice Go è organizzato in package per responsabilità. Il comando coordina il servizio; i package di implementazione stanno sotto `internal/`.

```text
cmd/
- HTTP 200: ready, including when a usable catalog cache is stale. In that case the model status is `stale` and overall status is `degraded`.
internal/
The staleness threshold is twice `models.refresh_seconds`, with a minimum of 60 seconds. Readiness is a discovery and resource check; it does not verify that an upstream key will accept the next inference.
  buildinfo/             Phiên bản dùng chung cho health và endpoint quản trị
## Development

Go source is organized into packages by responsibility. The command wires the service together; implementation packages live under `internal/`.
  identity/              Request ID và session affinity
```text
cmd/
  opencode2api/main.go    CLI flags, startup, and graceful shutdown
internal/
webui/
  buildinfo/             Version shared by health and management endpoints
  config/                Configuration, persistence, passwords, and redaction
  gateway/               HTTP routing, retries, pools, refresh, and runtime
  httpx/                 Shared HTTP responses, body handling, and headers
```

Ordine di lettura consigliato:

1. [Punto di ingresso](cmd/opencode2api/main.go) → [gestione runtime](internal/gateway/runtime.go) → [handler HTTP](internal/gateway/gateway.go).
webui/
  embed.go               Embeds the static assets into the executable
  index.html             Page structure

Esegui formattazione Go, analisi e build:

```bash
gofmt -w cmd internal webui
go vet ./...
go build -o opencode2api ./cmd/opencode2api
```

Per lo sviluppo locale, avvia il servizio con `go run ./cmd/opencode2api -config config.json`. Le build di rilascio iniettano la versione con `-ldflags "-X main.version=vX.Y.Z"`.

Node.js serve solo per il controllo sintattico del JavaScript della WebUI:

```bash
for f in webui/js/*.js webui/js/pages/*.js; do node --input-type=module --check < "$f"; done
```

`.editorconfig`, `.gitattributes` e la formattazione Go standardizzano il codice. La CI esegue `go vet` e build con Go 1.24 e Go stabile su Linux/Windows, controlla la formattazione Go, la sintassi WebUI e la sintassi shell dell'entrypoint. I pacchetti di rilascio includono tutti e tre i README.

For local development, start the service with `go run ./cmd/opencode2api -config config.json`. Release builds still inject the version with `-ldflags "-X main.version=vX.Y.Z"`.

| Sintomo                                 | Da verificare                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| API restituisce 401                                 | Usa un valore `server_keys` locale configurato.                                 |
| Health resta `starting`                   | Vedi i log di aggiornamento catalogo e connessioni in uscita; aggiungi override di protocollo se necessario.            |
| Nessun modello pubblicato          | Verifica il tier configurato, le condizioni di anonimato e il supporto del protocollo nativo.               |
| Request restituisce 502/504                         | Vedi i tentativi upstream, le credenziali, il proxy e i timeout totale/per tentativo.       |
| HTTP 200 ma generazione del contenuto fallita        | Vedi gli eventi di errore SSE e il risultato della request, non solo il codice di stato HTTP.                |
| Modifiche sull'host senza effetto in Docker | Il file attivo è nel volume di stato; re-importa o usa la WebUI.        |
| Impossibile connettersi alla porta del container       | Verifica l'indirizzo di ascolto, le porte pubblicate e la configurazione nel volume in uso.    |
| Le metriche di monitoraggio si perdono dopo il riavvio  | Il monitoraggio è solo in memoria; raccogli i log stdout esternamente.                     |

| ------------------------------------ | ----------------------------------------------------------------------------------------- |

Grazie alla community [LINUX DO](https://linux.do) per il supporto.

### Sforzo di ragionamento adattivo

Imposta `reasoning.effort` (o l'override per modello) su `auto` per usare la forza più alta verificata con successo dal probe dei modelli gratuiti. I livelli specifici conservano il loro significato e la forza specificata dal client ha priorità. Non viene mantenuta alcuna allowlist per nome modello.

Dopo che un livello di base ha successo, i modelli con ragionamento vengono sondati in ordine `max`, `xhigh`, `high`, `medium`, `low`, `minimal`. Si scende di livello solo quando un parametro di ragionamento viene esplicitamente rifiutato. Gli errori transitori fermano la ricerca e non possono essere interpretati come un tetto di capacità inferiore. Se tutti i livelli vengono rifiutati, non viene inserito alcun override di ragionamento.

Le osservazioni vengono memorizzate per URL upstream, modello e protocollo nativo, mostrate nella pagina di disponibilità, e usate per al massimo due ore. Il probe attivo si applica solo ai modelli gratuiti Zen/anonimi; i modelli Go/pagati, le capacità sconosciute e i livelli non verificati non ricevono override automatici. Impostare `auto` non estende il perimetro del probe e non garantisce che l'upstream rispetti ogni campo accettato. Il probe può richiedere alcune piccole request per modello e consuma quota upstream.

Thanks to the [LINUX DO](https://linux.do) community for its support.

SPDX-License-Identifier: GPL-3.0-or-later

Questo progetto è software libero: puoi redistribuirlo e modificarlo secondo la GNU General Public License versione 3 pubblicata dalla Free Software Foundation, o una versione 3 o superiore (a tua scelta). Il software è fornito così com'è, senza garanzie. Vedi [LICENSE](LICENSE) per i termini completi.