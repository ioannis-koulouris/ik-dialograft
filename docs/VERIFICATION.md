# Prüfbericht

Stand: 31.10.2026. Apple M5 Max, 128 GB, macOS; Node 22/26, MySQL 8.4, Docker 29, OrbStack (Kubernetes), Ollama.

## Geprüft

| Prüfung | Ergebnis |
|---|---|
| `npm run typecheck`, `npm run build` | grün |
| `npm test` (Vitest, 7 Dateien, 35 Tests) | 34 grün, MySQL-Test ohne DB explizit übersprungen |
| MySQL-Integrationstest gegen echten `mysql:8.4`-Container | grün (Migration, Seed, Rollback, Serialisierung, Job-Claim/Pause/Requeue). Dabei gefundener Deadlock bei gleichzeitiger Erstnutzung eines Mandanten wurde behoben. |
| Fachlogik | Rundung je Position, Steuer, Teilzahlung, Überzahlungsablehnung, Mehrdeutigkeit, Offene Posten nach Stichtag/Überfälligkeit, Report je Kunde |
| Verträge | OpenAPI und MCP-Katalog aus denselben Zod-Schemas; unbekannte Felder (`tenantId`, `permissions`) → 400 |
| Auth | echte HTTP-Aufrufe: fehlend/falsch → 401, falsche Rolle → 403; API-Token am MCP → 401 |
| MCP | echter Streamable-HTTP-Client → MCP → API: `tools/list`, `tools/call` |
| Exporte | XLSX zurückgelesen (numerische Zellen, `SUM`-Formeln), PDFs beginnen mit `%PDF`, Download nur autorisiert, Traversal/Symlink abgelehnt |
| Idempotenz, Mandantentrennung, Benachrichtigungen (Cursor, Abruf ≠ Quittierung) | grün |
| Scope-/Angebotsworkflow | fehlende Felder, Vorschläge blockieren Bestätigung, veraltete Scope-/Angebotsversionen, Revision macht Angebot ungültig, Ticket wird wiederverwendet, deterministische Preisspanne |
| Worker-Routing (mit injizierten Adaptern) | gültige Belege → auto-implement; ungültige Belege/Blocker → needs-human mit Übergabetext; Policy-Verstoß, fehlschlagende Checks, Runner-Timeout, geänderte Codebasis → pausiert, kein PR |
| Runner-Regeln | Pfadrichtlinie, Symlink-/Löscherkennung, Containerargumente (kein Docker-Socket, `--cap-drop ALL`, Checks mit `--network none`) |
| Docker-Image `dialograft:local` | gebaut; Container-Smoke-Test: Migration, Seed (zweiter Lauf übersprungen), API + MCP gegen MySQL, Report und XLSX-Export über MCP, Token-Trennung |
| Coding-Image `dialograft-coder:local` | gebaut (Qwen Code 0.26.4); `check typecheck/test/build` laufen unter de## Live auf dem Mac geprüft (31.10.2026)

| Prüfung | Ergebnis |
|---|---|
| Kubernetes unter OrbStack | Namespace `dialograft`: MySQL, Mailpit, API, MCP, Worker; Migration/Seed als expliziter Job; MCP-Aufrufe über den Cluster |
| Cluster → Ollama / Runner | `host.internal:11434` bzw. `:8090` erreichbar; Runner lauscht nur auf `127.0.0.1` |
| Modelle | `qwen3-coder:30b` (Digest `06c1097efce0`): bewertete Zahlungserinnerungen als needs-human, ein paraphrasierter Beleg wurde verworfen. `qwen3-coder-next:q8_0` (Digest `3f68e12b44ee`): konsistente auto-implement-Bewertungen, ca. 50–90 s; als Standard gesetzt |
| Qwen Code 0.26.4 im Container | benötigt `--auth-type openai`; fünf Läufe für Zahlungserinnerungen, Läufe im Worker-Ablauf für Mahnstufe 2 |
| Schutzregeln live | Läufe korrekt pausiert bei Änderungen an `src/store/store.ts`, bestehenden Tests und `tests/helpers.ts`; jeweils kein PR |
| Review live | Zwei echte Fehler gefunden, die die Agententests nicht abdeckten (falsche Mail-Konfiguration, Zahlungsziel in der Vergangenheit); Korrektur in einer zweiten Agentenrunde |
| Zahlungserinnerungen (PR #1) | gemergt `0a015f3`, deployt; Prüflauf 30.10.2026 → 4 Testmails in Mailpit, zweiter Lauf 0 |
| Kompletter Chat-Ablauf, Mahnstufe 2 (FR-0001) | über MCP: Lücke festgestellt → Entwurf → Klärung → Umfang v2 bestätigt → GitHub-Issue #2 `auto-implement` → Angebot → Auftrag → Worker-Draft-PR #3 → Review/Merge → `approve-merge` → `deploy-approved.sh` → Status `deployed` → 2 Mahnungen in Mailpit, zweiter Lauf 0 |

| Review-Runden, FR-0002 „Persönliche, einheitliche Mahntexte“ | Bewertung zunächst needs-human (maskierte Zeilenumbrüche in Belegen), nach Prompt-Korrektur auto-implement; drei Review-Runden über `request-changes` (PR #5–#7 abgelehnt: Grammatik, fehlende Zahlungsaufforderung, doppelter Code, fehlende Tests); PR #8 bestanden, gemergt, deployt (`7dc8d8b`); Prüfläufe 20.11./10.12. → 2 + 4 Mails mit neuen Texten, 30.10. → 0 (bereits gemahnt) |
| Video-Lauf, FR-0003 „CSV-Export der offenen Posten“ | Chat über echtes Claude Code (headless, MCP): Lücke → 4 Klärungsfragen (Spalten, Format, BOM) → Umfang bestätigt → Issue #9, Angebot 300–720 € → AU-0004 → Lauf pausiert (Test im Unterordner, Pfadregel) → Operator-Klärung → PR #10 → Review: fehlende CSV-Maskierung → PR #11 bestanden, gemergt, deployt (`af7897a`); Datei mit BOM, `;`, CRLF, `text/csv` |

### Live gefundene und behobene Plattformfehler

| Fehler | Behebung |
|---|---|
| Gleichzeitige Erstnutzung eines Mandanten → MySQL-Deadlock | Mandantenzeile außerhalb der Transaktion, begrenzter Retry |
| Vitest schrieb in read-only `node_modules` des Coding-Images | Konfiguration über CLI statt `vitest.config.ts` |
| Bestehender Test fixierte die Produktlücke; Aggregatarten im geschützten Store | Test prüft Konsistenz Lücke/Katalog; `src/domain/kinds.ts` |
| Runner-Aufruf lief nach 300 s in Nodes Header-Timeout | asynchrones Protokoll: `POST` → 202, Worker pollt `GET /v1/runs/:jobId` |
| Bewertung erzeugte 30 wiederholte, teils falsch zugeordnete Belege | Prompt/Schema: 2–6 einzeilige Belege aus der genannten Datei |
| Agent konnte generierte Verträge nicht aktualisieren → CI rot | Runner erzeugt `contracts/` nach dem Agentenlauf selbst (Container ohne Netzwerk) |
| Altes Angebot blieb nach pausiertem Auftrag „accepted“ | Operator-Neubewertung setzt frühere Angebote auf „superseded“ und löst den Auftrag |
| Belege mit maskierten Zeilenumbrüchen (`\n`) statt einer echten Zeile | Prompt: genau eine physische Zeile zitieren |
| Kein Weg für „Änderungen angefordert“ nach dem Review | Operator-Aktion `request-changes`; neue Runde mit Review-Notizen, neuer PR verweist auf den überholten |
| Runde 2 verlor Anforderungen aus Runde 1 (nur letzte Notiz übergeben) | Alle Review-Runden gehen in die Aufgabe |
| Verwaiste Exportdateien nach Transaktionsfehlern | `npm run sweep-exports` (Trockenlauf, `--delete`) |
| Pausierter Lauf eines angenommenen Auftrags ließ sich nur über neue Bewertung fortsetzen | `request-changes` gilt auch für pausierte Aufträge (Operator-Klärung) |
| Downloads lieferten jede Nicht-PDF-Datei als xlsx aus | Content-Type nach Dateiendung (pdf, xlsx, csv) |

## Bekannte Grenzen

- Egress des Agentencontainers ist nicht eingeschränkt (Bridge-Netz für Ollama-Zugriff); nur für das kontrollierte Demo-Repository.
- Mailversand erfolgt innerhalb der DB-Transaktion; ein Commit-Fehler nach dem Versand könnte eine Mail doppelt auslösen.
- Werkzeugnamen `configure_payment_reminders(_2)` beschreiben Prüfläufe ungenau; eine Umbenennung wäre eine eigene, beauftragte Erweiterung.
- ChatGPT als Client, Push-Channel und automatische Deployment-Orchestrierung sind nicht umgesetzt (PRD: optional).
