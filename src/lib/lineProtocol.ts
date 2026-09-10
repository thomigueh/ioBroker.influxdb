import type { ValuesForInflux } from './Database';

/**
 * Line protocol escaping for InfluxDB 3 (https://docs.influxdata.com/influxdb3/core/reference/line-protocol/):
 *
 * - Measurement: escape `,` and space
 * - Tag keys/values: escape `,`, `=` and space
 * - Field keys: escape `,`, `=` and space (same rules as tag keys)
 * - String field values: escape `"` and `\`
 * - Integers need the `i` suffix, floats no suffix, booleans `true`/`false`, strings double-quoted
 */
export function escapeLineProtocolMeasurement(measurement: string): string {
    return measurement.replace(/,/g, '\\,').replace(/ /g, '\\ ');
}

export function escapeLineProtocolTagKey(key: string): string {
    return key.replace(/,/g, '\\,').replace(/=/g, '\\=').replace(/ /g, '\\ ');
}

export function escapeLineProtocolTagValue(value: string): string {
    return escapeLineProtocolTagKey(value);
}

export function escapeLineProtocolFieldKey(key: string): string {
    return escapeLineProtocolTagKey(key);
}

export function escapeLineProtocolString(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Format one field value according to line protocol rules.
 *
 * The caller must have converted the value already so that it is one of number/boolean/string
 * (pushHelper() guarantees that for the state-change path). `null`, `undefined`, NaN and Infinity
 * are rejected: line protocol has no way to express them.
 *
 * @returns the value formatted for the fields section of a line protocol line
 */
export function formatLineProtocolFieldValue(value: string | number | boolean): string {
    switch (typeof value) {
        case 'number':
            if (!isFinite(value)) {
                throw new Error('Line protocol can not store non-finite numbers');
            }
            // Whole numbers are stored as integers (i suffix), everything else as float.
            // This matches the behaviour of the InfluxDB 2.x client.
            return Number.isInteger(value) ? `${value}i` : String(value);
        case 'boolean':
            return value ? 'true' : 'false';
        case 'string':
            return `"${escapeLineProtocolString(value)}"`;
        default:
            throw new Error(`Line protocol can not store value of type ${typeof value}`);
    }
}

/**
 * Convert one buffered point into a line protocol line.
 *
 * The table name is the full ioBroker state id - the same scheme the 1.x/2.x implementations use
 * as measurement, so queries and dashboards keep working. q/ack/from are written as fields.
 *
 * @param seriesId the ioBroker state id, used as table name
 * @param point the buffered values of one state change
 * @returns one line protocol line without the trailing timestamp/precision
 */
export function stateValueToLineProtocol(seriesId: string, point: ValuesForInflux): string {
    const measurement = escapeLineProtocolMeasurement(seriesId);
    const fields = [
        `value=${formatLineProtocolFieldValue(point.value)}`,
        `q=${Math.trunc(Number(point.q)) || 0}i`,
        `ack=${point.ack ? 'true' : 'false'}`,
        `from="${escapeLineProtocolString(point.from || '')}"`,
    ];
    return `${measurement} ${fields.join(',')} ${point.time}`;
}

/**
 * Convert a whole series into one line protocol payload.
 *
 * @param series map of ioBroker state id to its buffered points
 * @returns the line protocol body and the number of points it contains
 */
export function seriesToLineProtocol(series: { [id: string]: ValuesForInflux[] }): { body: string; count: number } {
    const lines: string[] = [];
    let count = 0;
    for (const [seriesId, points] of Object.entries(series)) {
        for (const point of points) {
            lines.push(stateValueToLineProtocol(seriesId, point));
            count++;
        }
    }
    return { body: lines.join('\n'), count };
}

/**
 * Escape an identifier (table name) that is placed inside double quotes in an SQL query
 * for InfluxDB 3, to prevent SQL injection via the ioBroker state id.
 */
export function escapeSqlIdentifier(id: string | undefined): string {
    return String(id).replace(/"/g, '""').replace(/\\/g, '\\\\');
}

/**
 * InfluxDB 3 table name for an ioBroker state id.
 *
 * Decision (documented in docs/influxdb3.md): the 1.x/2.x implementations use the raw ioBroker id
 * as measurement. Table names with dots are valid in InfluxDB 3, but Grafana's SQL table picker
 * and identifier insertion break on them (the quoted name ends up double-quoted in the SQL
 * editor), so for 3.x every character that is not alphanumeric or `_` becomes `_`.
 * The transformation is idempotent and deterministic, so writes and reads always map to the same
 * table. Trade-off: two different ids can map to the same table name (e.g. "a.b" and "a_b") -
 * acceptable for the readability gain in Grafana/SQL.
 */
export function tableNameForId(id: string): string {
    return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Escape a string literal that is placed inside single quotes in an SQL query for InfluxDB 3.
 */
export function escapeSqlString(value: string | undefined): string {
    return String(value).replace(/'/g, "''").replace(/\\/g, '\\\\');
}
