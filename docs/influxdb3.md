# InfluxDB 3 Unterstützung (Adapter-Fork)

Dieses Dokument beschreibt die InfluxDB-3-Integration (InfluxDB 3 Core / Enterprise) und die
dahinterstehenden Entscheidungen.

## Datenmodell

Das bestehende Schema der 1.x-/2.x-Implementierungen wird 1:1 übernommen:

```
ioBroker State
      ↓
Tabelle (Measurement) = die komplette ioBroker-ID, z. B. "0_userdata.0.Wetterstation.Temperatur"
Fields                = value (number|boolean|string), q (int), ack (boolean), from (string)
Timestamp             = state.ts in Millisekunden (Write mit precision=ms)
Tags                  = keine (q/ack/from sind Spalten/Fields, wie beim 2.x-Default)
```

Begründung:

- Die Aufzeichnungs-Auswahl über den ioBroker-Objektbaum (`common.custom["influxdb.0"]`) und der
  gesamte Write-Pfad (Debounce, BlockTime, changesOnly, Aliase, Buffer, type conflicts) sind
  versionsunabhängig und bleiben unverändert.
- `getHistory`, `getRawEntries`, der Data Browser und bestehende Dashboards funktionieren mit dem
  gleichen Namensschema weiter.
- Grafana/SQL: `SELECT time, "value" FROM "0_userdata.0.Wetterstation.Temperatur" WHERE time >= now() - INTERVAL '24 hours'`.
- Tabellen- und Spaltennamen werden in SQL immer doppelt-gequotet (case-sensitive, Sonderzeichen,
  Punkte in ioBroker-IDs).

## Write API

- `POST /api/v3/write_lp?db=<database>&precision=ms` (native v3 API), Body = Line Protocol,
  `Authorization: Bearer <token>`.
- **HTTP 204 (No Content) = erfolgreicher Write.**
- Fehlercodes: 400 (ungültiges Line Protocol), 401/403 (Authentifizierung), 404 (Datenbank/Route),
  422 (ungültige Daten), 429 (Rate Limit), 5xx (Serverfehler) - gemappt auf lesbare Meldungen.
- Batching: wie bisher puffert der Adapter mehrere Punkte und schreibt sie als ein Line-Protocol-
  Payload (15.000-Punkte-Batches, konfigurierbarer Flush-Intervall).
- Escaping nach Line-Protocol-Regeln: Measurement `,`/Space; Tag-/Field-Keys zusätzlich `=`;
  String-Fields `"`/`\`; Integer mit `i`-Suffix. Siehe `src/lib/lineProtocol.ts`.

## Query API

- `POST /api/v3/query_sql` mit `{"db": ..., "q": ..., "format": "json"}`.
- Aggregationen (`AVG`, `MAX`, `MIN`, `SUM`, `COUNT`) werden über `DATE_BIN` in die DB verlagert;
  `percentile`/`quantile`/linear-`integral` und nicht-numerische Werte aggregiert `@iobroker/aggregate`
  clientseitig (wie bei 1.x/2.x).
- Tabellenliste: `SHOW TABLES` (interne `system.*`-Tabellen werden gefiltert).

## Authentication

- Nur Token-Auth (`Bearer`), kein User/Passwort. Das Token wird nie geloggt (nur im
  Authorization-Header; Debug-Logs geben URL und Statuscode aus, nicht Header).

## Retention

InfluxDB 3 Core kennt Retention datenbankweit (beim Anlegen: `influxdb3 create database --retention <duration>`)
und nicht pro Measurement (Shard Groups wie 1.x/2.x). Der Adapter setzt die Retention daher nicht
selbst, sondern dokumentiert den Soll-Wert im Log. `getRetention` antwortet mit "unbekannt", der
Data Browser funktioniert davon unabhängig.

## Admin-UI

- `DB-Version` → `3.x (Core/Enterprise)`; Standard-Port von InfluxDB 3 Core ist **8181**.
- Token wird benötigt; `Organization` und `Path` sind für 3.x ausgeblendet.
- Die Einstellungen pro Datenpunkt (Objektbaum → Zahnrad → InfluxDB) sind identisch zu 1.x/2.x.

## Kompatibilität

- InfluxDB 1.x und 2.x sind unverändert unterstützt (`dbversion`-Auswahl).
- Der Docker-Modus (`dockerInflux.enabled`) bleibt auf InfluxDB 2 beschränkt.
